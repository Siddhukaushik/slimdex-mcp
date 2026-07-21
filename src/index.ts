#!/usr/bin/env node
// codeglance-mcp — a local MCP server for narrow code retrieval.
//
// Instead of reading whole files into context, an agent asks codeglance for exactly
// what it needs: an outline, a compact search, a ranged read, a surgical symbol
// snippet, a file skeleton, a one-shot context brief, a symbol index for
// jump-to-definition, a dependency graph, a git change summary, and a persistent
// memory store. Everything is cached under <root>/.codeglance/.
//
// Transport is stdio, so it should work with any MCP client. Only Claude Code
// and Claude Desktop have been run against it; see README for config shapes.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { outline, formatOutline } from "./outline.js";
import { buildOrRefresh, toPosix } from "./indexer.js";
import { searchFiles, formatMatches, encodeCursor, decodeCursor } from "./search.js";
import { buildGraph, dependents, toMermaid } from "./graph.js";
import { fileSkeleton, getSymbolContext, buildContext, enclosingSymbol } from "./intel.js";
import { changedFiles, formatChanged, isGitRepo } from "./git.js";
import { loadStats, formatStats, record, resetStats } from "./stats.js";
import { loadIndex, loadMemory, saveMemory, type MemoryFact } from "./store.js";

const ROOT = path.resolve(process.env.CODEGLANCE_ROOT || process.argv[2] || process.cwd());

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// Resolve a user-supplied path (relative or absolute) and refuse to escape ROOT.
function safeResolve(p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path escapes project root: ${p}`);
  return abs;
}

// The retrieval discipline that actually produces the savings. It lived only in
// the README, where no agent ever reads it; MCP clients inject `instructions`
// into the model's context, so shipping it here means every client gets it.
const INSTRUCTIONS = `codeglance replaces "read the whole file" with narrow retrieval. To actually save tokens:

1. Start with repo_map, not a file open. On a big repo, orient at the directory level before drilling in.
2. Run index_repo liberally — it only reparses files whose mtime changed, so treat it like \`git fetch\`,
   not a one-time setup step. Re-run it before trusting a search if anything else may have touched the repo.
3. get_file_skeleton before any full read of a file over ~300 lines, then read_lines only the 2-3
   functions you actually need.
4. For anything symbol-shaped use find_definition / find_references / get_symbol_context, not search_code.
   Plain text search on a large codebase returns same-named identifiers from unrelated files.
   Reserve search_code for real string/text searches.
5. Prefer one get_context(name, include:[...]) over chaining find_definition + find_references + dep_graph.
6. Scope search_code and find_references with pathPrefix when you already know the rough area.
7. Before refactoring a shared module, run dep_graph mode:"mermaid" root:"<file>" to see the blast radius.
8. changed_files is the cheap way to start a session on a dirty repo — it reports which symbols the diff
   lands in, without pulling the patch into context.
9. batch several lookups into one call when they're independent.`;

// ---------------------------------------------------------------------------
// Handler registry. Each handler returns a plain string. Registering through
// `tool()` wraps it with terse error handling (no stack traces leak to the
// model), records response size for the `stats` tool, and registers it so the
// `batch` tool can dispatch to it too.
// ---------------------------------------------------------------------------
type Handler = (args: any) => Promise<string>;
const handlers: Record<string, Handler> = {};
const server = new McpServer({ name: "codeglance", version: "0.5.0" }, { instructions: INSTRUCTIONS });

function tool(name: string, meta: { title: string; description: string; inputSchema: any }, fn: Handler) {
  handlers[name] = fn;
  server.registerTool(name, meta, async (args: any) => {
    let out: string;
    let failed = false;
    try {
      out = await fn(args ?? {});
    } catch (e) {
      out = `Err: ${(e as Error).message}`; // terse: model doesn't debug our server
      failed = true;
    }
    void record(ROOT, name, out.length, failed);
    return text(out);
  });
}

// ---------------------------------------------------------------------------
tool(
  "index_repo",
  {
    title: "Index / refresh the repository",
    description:
      "Build or incrementally refresh the persistent code index (symbols + imports). Only files whose mtime changed " +
      "are re-parsed, so this is cheap — re-run it liberally, like `git fetch`, before trusting a search. Honors " +
      "<root>/.codeglance.json (ignoreDirs/extensions/exclude/maxFileBytes) and reports config problems instead of " +
      "silently ignoring them.",
    inputSchema: { force: z.boolean().optional().describe("Ignore cache and reparse everything.") },
  },
  async ({ force }) => {
    const r = await buildOrRefresh(ROOT, force ?? false);
    const symbols = Object.values(r.index.files).reduce((n, f) => n + f.symbols.length, 0);
    const warn = r.warnings.length ? `\n  config warnings:\n${r.warnings.map((w) => "    ! " + w).join("\n")}` : "";
    return (
      `Indexed ${r.totalFiles} files under ${ROOT}\n` +
      `  parsed: ${r.parsed}  reused(cache): ${r.reused}  removed: ${r.removed}` +
      (r.skipped ? `  skipped(too large): ${r.skipped}` : "") +
      `\n  symbols indexed: ${symbols}  parser: ${r.parser}\n` +
      `  config: ${r.config}${warn}\n` +
      `Cache: ${path.join(ROOT, ".codeglance", "index.json")}`
    );
  }
);

tool(
  "outline_file",
  {
    title: "Outline a file (signatures only)",
    description: "Compact outline of one file — declarations with line numbers, not the body. Orient before reading.",
    inputSchema: { path: z.string() },
  },
  async ({ path: p }) => {
    const abs = safeResolve(p);
    const src = await fs.readFile(abs, "utf8");
    return formatOutline(toPosix(path.relative(ROOT, abs)), outline(src), src.split(/\r?\n/).length);
  }
);

tool(
  "read_lines",
  {
    title: "Read a line range",
    description: "Read only lines [start..end] (1-indexed, inclusive) of a file. Cheaper than the whole file.",
    inputSchema: { path: z.string(), start: z.number().int().min(1), end: z.number().int().min(1) },
  },
  async ({ path: p, start, end }) => {
    const abs = safeResolve(p);
    const lines = (await fs.readFile(abs, "utf8")).split(/\r?\n/);
    const s = Math.max(1, start);
    const e = Math.min(lines.length, Math.max(s, end));
    const body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}  ${l}`).join("\n");
    return `${toPosix(path.relative(ROOT, abs))} [${s}-${e} of ${lines.length}]\n${body}`;
  }
);

tool(
  "search_code",
  {
    title: "Compact code search",
    description:
      "Search indexed files; return path:line:col + the matching line (+ optional caret highlight). Every occurrence " +
      "on a line counts, and the reported total is exact unless the scan cap trips (then it says so). Page with limit " +
      "and either offset or the opaque cursor from a previous call. Vendor/build dirs are already excluded. Use " +
      "pathPrefix to scope; for symbols prefer find_definition/find_references.",
    inputSchema: {
      pattern: z.string(),
      regex: z.boolean().optional(),
      ignoreCase: z.boolean().optional(),
      pathPrefix: z.string().optional(),
      highlight: z.boolean().optional(),
      limit: z.number().int().min(1).max(1000).optional().describe("Max matches to return (default 20)."),
      offset: z.number().int().min(0).optional().describe("Skip this many matches. Ignored if cursor is given."),
      cursor: z.string().optional().describe("Opaque token from a previous call's 'next cursor' to fetch the next page."),
    },
  },
  async ({ pattern, regex, ignoreCase, pathPrefix, highlight, limit, offset, cursor }) => {
    const index = await loadIndex(ROOT);
    let files = Object.keys(index.files);
    if (files.length === 0) return "Index is empty — run index_repo first.";
    if (pathPrefix) files = files.filter((f) => f.startsWith(toPosix(pathPrefix)));

    const lim = limit ?? 20;
    let start = offset ?? 0;
    let staleNote = "";
    if (cursor) {
      const c = decodeCursor(cursor);
      if (!c) return "Err: invalid cursor. Omit it to start from the beginning.";
      start = c.offset;
      if (c.version && c.version !== index.builtAt)
        staleNote = " (note: index changed since the cursor was issued; results may have shifted)";
    }

    const { matches, total, exact } = await searchFiles(ROOT, files, pattern, {
      regex,
      ignoreCase,
      highlight,
      maxMatches: lim,
      offset: start,
    });
    const hasMore = total > start + matches.length;
    const next = hasMore ? `\nnext cursor: ${encodeCursor(start + lim, index.builtAt)}` : "";
    const totalStr = exact ? `${total}` : `${total}+ (scan cap reached)`;
    return `${matches.length} of ${totalStr} match(es)${staleNote}\n${formatMatches(matches)}${next}`;
  }
);

tool(
  "find_definition",
  {
    title: "Find where a symbol is defined",
    description: "Look up a symbol name in the index; return definition site(s) as path:line:col + kind. Heuristic.",
    inputSchema: { name: z.string(), kind: z.string().optional() },
  },
  async ({ name, kind }) => {
    const index = await loadIndex(ROOT);
    const hits: string[] = [];
    for (const [file, entry] of Object.entries(index.files))
      for (const s of entry.symbols)
        if (s.name === name && (!kind || s.kind === kind)) hits.push(`${file}:${s.line}:${s.col}  ${s.kind} ${s.name}`);
    return hits.length
      ? `${hits.length} definition candidate(s) for "${name}":\n${hits.join("\n")}`
      : `No definition indexed for "${name}". Try search_symbols for a fuzzy match.`;
  }
);

tool(
  "search_symbols",
  {
    title: "Fuzzy symbol name search",
    description:
      "Find indexed symbols whose name matches a query, ranked exact > prefix > substring > subsequence. Use this " +
      "when you half-remember a name (\"something like handleAuth\") — it reads only the index, never the files, so " +
      "it is far cheaper and far less noisy than search_code for finding a declaration.",
    inputSchema: {
      query: z.string(),
      kind: z.string().optional().describe("Filter by kind: function, class, method, interface, type, …"),
      pathPrefix: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().describe("Default 25."),
    },
  },
  async ({ query, kind, pathPrefix, limit }) => {
    const index = await loadIndex(ROOT);
    if (Object.keys(index.files).length === 0) return "Index is empty — run index_repo first.";
    const q = query.toLowerCase();

    // Subsequence match: every char of the query appears in order. Catches
    // "hAuth" -> "handleAuth" without pulling in a fuzzy-match dependency.
    const subseq = (name: string): boolean => {
      let i = 0;
      for (const ch of name) if (ch === q[i] && ++i === q.length) return true;
      return i === q.length;
    };

    type Hit = { file: string; line: number; col: number; kind: string; name: string; rank: number };
    const hits: Hit[] = [];
    for (const [file, entry] of Object.entries(index.files)) {
      if (pathPrefix && !file.startsWith(toPosix(pathPrefix))) continue;
      for (const s of entry.symbols) {
        if (kind && s.kind !== kind) continue;
        const lower = s.name.toLowerCase();
        let rank = -1;
        if (lower === q) rank = 0;
        else if (lower.startsWith(q)) rank = 1;
        else if (lower.includes(q)) rank = 2;
        else if (subseq(lower)) rank = 3;
        if (rank >= 0) hits.push({ file, line: s.line, col: s.col, kind: s.kind, name: s.name, rank });
      }
    }
    if (hits.length === 0) return `No indexed symbol matches "${query}".`;

    const lim = limit ?? 25;
    hits.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name));
    const shown = hits.slice(0, lim);
    const rows = shown.map((h) => `  ${h.file}:${h.line}:${h.col}  ${h.kind.padEnd(9)} ${h.name}`);
    const more = hits.length > shown.length ? `\n  … ${hits.length - shown.length} more; raise limit or narrow with kind/pathPrefix` : "";
    return `${shown.length} of ${hits.length} symbol(s) matching "${query}":\n${rows.join("\n")}${more}`;
  }
);

tool(
  "find_references",
  {
    title: "Find references to a symbol (textual)",
    description:
      "Whole-word textual search for a symbol, returned as path:line:col with the enclosing function/class. Counts " +
      "every occurrence, including repeats on one line. Not scope-aware, so may include unrelated same-named " +
      "identifiers. Supports pathPrefix, limit and offset.",
    inputSchema: {
      name: z.string(),
      pathPrefix: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).optional(),
    },
  },
  async ({ name, pathPrefix, limit, offset }) => {
    const index = await loadIndex(ROOT);
    let files = Object.keys(index.files);
    if (pathPrefix) files = files.filter((f) => f.startsWith(toPosix(pathPrefix)));
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lim = limit ?? 20;
    const off = offset ?? 0;
    const { matches, total, exact } = await searchFiles(ROOT, files, `\\b${escaped}\\b`, {
      regex: true,
      maxMatches: lim,
      offset: off,
    });
    // attribute each hit to its enclosing symbol
    const rows = matches.map((m) => {
      const enc = enclosingSymbol(index.files[m.file], m.line);
      return `  ${m.file}:${m.line}:${m.col}${enc ? `  in ${enc.kind} ${enc.name}` : ""}`;
    });
    const totalStr = exact ? `${total}` : `${total}+ (scan cap reached)`;
    const more = total > off + matches.length ? `\n  … raise offset to ${off + lim} for more` : "";
    return `${matches.length} of ${totalStr} reference(s) to "${name}":\n${rows.join("\n") || "  (none)"}${more}`;
  }
);

tool(
  "get_symbol_context",
  {
    title: "Surgical symbol snippet",
    description:
      "Return ONLY the body of a symbol (function/class/method) plus a few context lines — not the whole file. Give a " +
      "name (resolved via the index) or an explicit path+line. This is the biggest per-lookup token saver.",
    inputSchema: {
      name: z.string().optional().describe("Symbol name to resolve via the index."),
      path: z.string().optional().describe("File path (use with line instead of name)."),
      line: z.number().int().min(1).optional().describe("Definition line (use with path)."),
      before: z.number().int().min(0).max(20).optional(),
      after: z.number().int().min(0).max(20).optional(),
      maxLines: z.number().int().min(1).max(2000).optional().describe("Cap the returned span (default 200); tail elided with a notice."),
    },
  },
  async ({ name, path: p, line, before, after, maxLines }) => {
    const index = await loadIndex(ROOT);
    let file: string, defLine: number, kind = "symbol";
    if (p && line) {
      file = toPosix(path.relative(ROOT, safeResolve(p)));
      defLine = line;
    } else if (name) {
      const found: { file: string; line: number; kind: string }[] = [];
      for (const [f, entry] of Object.entries(index.files))
        for (const s of entry.symbols) if (s.name === name) found.push({ file: f, line: s.line, kind: s.kind });
      if (found.length === 0) return `No definition indexed for "${name}". Run index_repo, or pass path + line explicitly.`;
      if (found.length > 1)
        return (
          `"${name}" has ${found.length} definitions — pass path + line to pick one:\n` +
          found.map((d) => `  ${d.file}:${d.line}  ${d.kind}`).join("\n")
        );
      file = found[0].file;
      defLine = found[0].line;
      kind = found[0].kind;
    } else {
      return "Provide either name, or path + line.";
    }
    const ctx = await getSymbolContext(ROOT, file, defLine, kind, before ?? 2, after ?? 2, maxLines ?? 200);
    return `${ctx.file}:${ctx.line}  ${ctx.kind}  (${ctx.loc} LOC)\n${ctx.text}`;
  }
);

tool(
  "get_file_skeleton",
  {
    title: "File skeleton (bodies elided)",
    description:
      "Structural skeleton of a file: every declaration's signature with its indentation preserved and bodies " +
      "replaced by ' … {line}'. Turns a 2,000-line file into a readable map for a fraction of the tokens. Use this " +
      "before any full read of a file over ~300 lines.",
    inputSchema: { path: z.string() },
  },
  async ({ path: p }) => {
    const abs = safeResolve(p);
    const rel = toPosix(path.relative(ROOT, abs));
    const index = await loadIndex(ROOT);
    const entry = index.files[rel];
    if (!entry) return `${rel} is not indexed — run index_repo (or check the path).`;
    const src = await fs.readFile(abs, "utf8");
    const skel = fileSkeleton(src, entry);
    return `${rel} skeleton (${entry.lines} lines, ${entry.symbols.length} symbols):\n${skel || "  (no declarations detected)"}`;
  }
);

tool(
  "get_context",
  {
    title: "One-shot context brief for a symbol",
    description:
      "Assembles in ONE call what would otherwise take several: definition, signature, callers/references (attributed " +
      "to their enclosing symbol — heuristic), imports, and dependents. Sections are OPT-IN via `include` (default: " +
      "definition,signature,callers,imports,dependents). Add 'body' for full source. Bounded by callerLimit and " +
      "maxChars with explicit truncation — so it stays a token-saver, not a token-hog.",
    inputSchema: {
      name: z.string(),
      include: z
        .array(z.enum(["definition", "signature", "body", "callers", "imports", "dependents"]))
        .optional()
        .describe("Which sections to return. Omit for the default set."),
      callerLimit: z.number().int().min(1).max(200).optional().describe("Max callers to list (default 12)."),
      maxChars: z.number().int().min(500).max(50000).optional().describe("Hard cap on response size (default 12000)."),
    },
  },
  async ({ name, include, callerLimit, maxChars }) => {
    const index = await loadIndex(ROOT);
    if (Object.keys(index.files).length === 0) return "Index is empty — run index_repo first.";
    return buildContext(ROOT, index, name, { include, callerLimit, maxChars });
  }
);

tool(
  "repo_map",
  {
    title: "High-level repo map",
    description:
      "Birds-eye overview: top directories with file counts, total lines, and symbol counts. Pass `path` to drill " +
      "into one directory and list its largest files (with `top` to cap the list) — the bridge between orienting at " +
      "the directory level and picking a file to skeleton. Start every session here.",
    inputSchema: {
      depth: z.number().int().min(1).max(4).optional(),
      path: z.string().optional().describe("Drill into this directory and list files instead of directories."),
      top: z.number().int().min(1).max(200).optional().describe("With `path`: how many files to list (default 20)."),
    },
  },
  async ({ depth, path: p, top }) => {
    const index = await loadIndex(ROOT);
    if (Object.keys(index.files).length === 0) return "Index is empty — run index_repo first.";

    // Drill-down: biggest files under a directory, so the agent can go
    // repo_map -> repo_map(path) -> get_file_skeleton without guessing a path.
    if (p) {
      const prefix = toPosix(p).replace(/\/+$/, "");
      const rows = Object.entries(index.files)
        .filter(([f]) => f === prefix || f.startsWith(prefix + "/"))
        .sort((a, b) => b[1].lines - a[1].lines);
      if (rows.length === 0) return `No indexed files under "${prefix}".`;
      const lim = top ?? 20;
      const shown = rows.slice(0, lim);
      const totalLines = rows.reduce((n, [, e]) => n + e.lines, 0);
      const body = shown
        .map(([f, e]) => `  ${f.padEnd(52)} ${String(e.lines).padStart(6)} lines ${String(e.symbols.length).padStart(5)} symbols`)
        .join("\n");
      const more = rows.length > shown.length ? `\n  … ${rows.length - shown.length} more file(s); raise top` : "";
      return `${prefix}: ${rows.length} files, ${totalLines} lines (largest first)\n${body}${more}`;
    }

    const d = depth ?? 2;
    const buckets = new Map<string, { files: number; lines: number; symbols: number }>();
    for (const [file, entry] of Object.entries(index.files)) {
      const parts = file.split("/");
      const key = parts.slice(0, Math.max(1, Math.min(d, parts.length - 1))).join("/") || ".";
      const b = buckets.get(key) ?? { files: 0, lines: 0, symbols: 0 };
      b.files++;
      b.lines += entry.lines;
      b.symbols += entry.symbols.length;
      buckets.set(key, b);
    }
    const rows = [...buckets.entries()]
      .sort((a, b) => b[1].lines - a[1].lines)
      .map(([k, v]) => `  ${k.padEnd(40)} ${String(v.files).padStart(5)} files ${String(v.lines).padStart(7)} lines ${String(v.symbols).padStart(6)} symbols`);
    return `Repo map for ${ROOT} (depth ${d}):\n${rows.join("\n")}\n(drill in with repo_map path:"<dir>")`;
  }
);

tool(
  "changed_files",
  {
    title: "What changed, and which symbols it touched",
    description:
      "Summarize the working-tree diff (or a diff against `base`) as changed files with +added/-deleted counts AND " +
      "the enclosing functions/classes each hunk lands in — the blast radius, without pulling the patch into " +
      "context. The cheap way to start a session on a dirty repo. Requires a git checkout.",
    inputSchema: {
      base: z.string().optional().describe("Ref to diff against (e.g. 'main', 'HEAD~3'). Omit for working tree vs HEAD."),
      limit: z.number().int().min(1).max(500).optional().describe("Max files to list (default 30)."),
    },
  },
  async ({ base, limit }) => {
    if (!(await isGitRepo(ROOT))) return `${ROOT} is not a git repository (or git is not installed).`;
    const index = await loadIndex(ROOT);
    const files = await changedFiles(ROOT, index, base);
    return formatChanged(files, base, limit ?? 30);
  }
);

tool(
  "dep_graph",
  {
    title: "Dependency graph query",
    description:
      "Query the internal import graph. mode=imports: what a file imports. mode=dependents: what imports a file. " +
      "mode=mermaid: a Mermaid diagram — pass root (+depth, default 2) to walk outward from one file instead of " +
      "dumping the whole graph, or scope to a path prefix. Run this before refactoring a shared module.",
    inputSchema: {
      mode: z.enum(["imports", "dependents", "mermaid"]),
      target: z.string().optional(),
      scope: z.string().optional(),
      root: z.string().optional().describe("mermaid: start file to walk out from (BFS)."),
      depth: z.number().int().min(1).max(6).optional().describe("mermaid: import hops to follow from root (default 2)."),
    },
  },
  async ({ mode, target, scope, root, depth }) => {
    const index = await loadIndex(ROOT);
    const graph = buildGraph(index);
    if (mode === "mermaid")
      return (
        "```mermaid\n" +
        toMermaid(graph, scope ? toPosix(scope) : undefined, { root: root ? toPosix(root) : undefined, depth }) +
        "\n```"
      );
    if (!target) return "target is required for imports/dependents modes.";
    const t = toPosix(target);
    if (mode === "imports") {
      const deps = graph.imports[t] ?? [];
      const ext = graph.external[t] ?? [];
      return (
        `${t} imports:\n` +
        (deps.length ? "  internal:\n" + deps.map((d) => "    " + d).join("\n") : "  (no internal deps)") +
        (ext.length ? "\n  external:\n" + ext.map((d) => "    " + d).join("\n") : "")
      );
    }
    const deps = dependents(graph, t);
    return deps.length ? `Files importing ${t}:\n${deps.map((d) => "  " + d).join("\n")}` : `Nothing internal imports ${t}.`;
  }
);

tool(
  "stats",
  {
    title: "Tool usage and response-size accounting",
    description:
      "Per-tool call counts and response sizes recorded to <root>/.codeglance/stats.json. Reported in characters, not " +
      "tokens — char/4 estimates are unreliable across tokenizers, so this measures what it can measure honestly. " +
      "Use it to see which tool is actually producing your context, and to tune limits.",
    inputSchema: { reset: z.boolean().optional().describe("Clear the counters instead of reporting them.") },
  },
  async ({ reset }) => {
    if (reset) {
      await resetStats(ROOT);
      return "Stats reset.";
    }
    return formatStats(await loadStats(ROOT));
  }
);

// ---- persistent memory ----
tool(
  "memory_save",
  {
    title: "Persist a memory fact",
    description: "Save a durable note (decision, gotcha, TODO, location) to <root>/.codeglance/memory.json.",
    inputSchema: { text: z.string(), tags: z.array(z.string()).optional() },
  },
  async ({ text: t, tags }) => {
    const mem = await loadMemory(ROOT);
    const fact: MemoryFact = { id: randomUUID().slice(0, 8), text: t, tags: tags ?? [], created: new Date().toISOString() };
    mem.facts.push(fact);
    await saveMemory(ROOT, mem);
    return `Saved memory ${fact.id}${fact.tags.length ? " [" + fact.tags.join(", ") + "]" : ""}.`;
  }
);

tool(
  "memory_search",
  {
    title: "Search saved memory",
    description: "Find saved memory facts by substring and/or tag.",
    inputSchema: { query: z.string().optional(), tag: z.string().optional() },
  },
  async ({ query, tag }) => {
    const mem = await loadMemory(ROOT);
    const q = (query ?? "").toLowerCase();
    const hits = mem.facts.filter((f) => (!q || f.text.toLowerCase().includes(q)) && (!tag || f.tags.includes(tag)));
    return hits.length ? hits.map((f) => `[${f.id}] ${f.tags.length ? "(" + f.tags.join(",") + ") " : ""}${f.text}`).join("\n") : "No matching memory.";
  }
);

tool(
  "memory_list",
  { title: "List all memory", description: "List every saved memory fact.", inputSchema: {} },
  async () => {
    const mem = await loadMemory(ROOT);
    return mem.facts.length ? mem.facts.map((f) => `[${f.id}] ${f.tags.length ? "(" + f.tags.join(",") + ") " : ""}${f.text}`).join("\n") : "No memory saved yet.";
  }
);

tool(
  "memory_delete",
  { title: "Delete a memory fact", description: "Remove one saved memory fact by its id.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const mem = await loadMemory(ROOT);
    const before = mem.facts.length;
    mem.facts = mem.facts.filter((f) => f.id !== id);
    await saveMemory(ROOT, mem);
    return before === mem.facts.length ? `No memory with id ${id}.` : `Deleted memory ${id}.`;
  }
);

// ---- batch: run several lookups in one call to cut protocol overhead ----
tool(
  "batch",
  {
    title: "Run several tool calls at once",
    description:
      "Execute multiple codeglance calls in one request to avoid per-call protocol overhead. Pass calls: " +
      '[{ "tool": "find_definition", "args": { "name": "login" } }, ...]. Cannot nest batch inside itself.',
    inputSchema: {
      calls: z
        .array(z.object({ tool: z.string(), args: z.record(z.any()).optional() }))
        .min(1)
        .max(20),
    },
  },
  async ({ calls }) => {
    const parts: string[] = [];
    for (const c of calls as { tool: string; args?: any }[]) {
      if (c.tool === "batch" || !handlers[c.tool]) {
        parts.push(`### ${c.tool}\nErr: unknown or non-batchable tool`);
        continue;
      }
      try {
        parts.push(`### ${c.tool} ${JSON.stringify(c.args ?? {})}\n${await handlers[c.tool](c.args ?? {})}`);
      } catch (e) {
        parts.push(`### ${c.tool}\nErr: ${(e as Error).message}`);
      }
    }
    return parts.join("\n\n");
  }
);

// ---------------------------------------------------------------------------
async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`codeglance-mcp v0.5.0 ready. root=${ROOT}  tools=${Object.keys(handlers).length}`);
  // Opt-in auto-reindex on file change. Off unless CODEGLANCE_WATCH is truthy.
  if (["1", "true", "yes"].includes((process.env.CODEGLANCE_WATCH || "").toLowerCase())) {
    const { startWatcher } = await import("./watch.js");
    startWatcher(ROOT);
  }
}
main().catch((e) => {
  console.error("codeglance-mcp fatal:", e);
  process.exit(1);
});
