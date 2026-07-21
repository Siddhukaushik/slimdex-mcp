#!/usr/bin/env node
// leanctx-mcp — a local MCP server that helps coding agents spend fewer tokens.
//
// Instead of reading whole files into context, an agent asks leanctx for exactly
// what it needs: an outline, a compact search, a ranged read, a surgical symbol
// snippet, a file skeleton, a one-shot context brief, a symbol index for
// jump-to-definition, a dependency graph, and a persistent memory store.
// Everything is cached under <root>/.leanctx/.
//
// Transport is stdio, so it works with ANY MCP client (Claude Desktop, Claude
// Code, Cursor, Windsurf, VS Code/Copilot, Cline, Zed, ...). See README.

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
import { loadIndex, loadMemory, saveMemory, type MemoryFact } from "./store.js";

const ROOT = path.resolve(process.env.LEANCTX_ROOT || process.argv[2] || process.cwd());

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

// ---------------------------------------------------------------------------
// Handler registry. Each handler returns a plain string. Registering through
// `tool()` wraps it with terse error handling (no stack traces leak to the
// model) and records it so the `batch` tool can dispatch to it too.
// ---------------------------------------------------------------------------
type Handler = (args: any) => Promise<string>;
const handlers: Record<string, Handler> = {};
const server = new McpServer({ name: "leanctx", version: "0.4.0" });

function tool(name: string, meta: { title: string; description: string; inputSchema: any }, fn: Handler) {
  handlers[name] = fn;
  server.registerTool(name, meta, async (args: any) => {
    try {
      return text(await fn(args ?? {}));
    } catch (e) {
      return text(`Err: ${(e as Error).message}`); // terse: model doesn't debug our server
    }
  });
}

// ---------------------------------------------------------------------------
tool(
  "index_repo",
  {
    title: "Index / refresh the repository",
    description:
      "Build or incrementally refresh the persistent code index (symbols + imports). Only files whose mtime changed " +
      "are re-parsed. Run first, or after large edits. Honors <root>/.leanctx.json (ignoreDirs/extensions/exclude).",
    inputSchema: { force: z.boolean().optional().describe("Ignore cache and reparse everything.") },
  },
  async ({ force }) => {
    const r = await buildOrRefresh(ROOT, force ?? false);
    const symbols = Object.values(r.index.files).reduce((n, f) => n + f.symbols.length, 0);
    return (
      `Indexed ${r.totalFiles} files under ${ROOT}\n` +
      `  parsed: ${r.parsed}  reused(cache): ${r.reused}  removed: ${r.removed}\n` +
      `  symbols indexed: ${symbols}\nCache: ${path.join(ROOT, ".leanctx", "index.json")}`
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
      "Search indexed files; return path:line:col + the matching line (+ optional caret highlight). Page with limit " +
      "and either offset or the opaque cursor from a previous call. Vendor/build dirs are already excluded.",
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
      if (c.version && c.version !== index.builtAt) staleNote = " (note: index changed since the cursor was issued; results may have shifted)";
    }

    const { matches, total } = await searchFiles(ROOT, files, pattern, {
      regex,
      ignoreCase,
      highlight,
      maxMatches: lim,
      offset: start,
    });
    const hasMore = total >= start + lim;
    const next = hasMore ? `\nnext cursor: ${encodeCursor(start + lim, index.builtAt)}` : "";
    return `${matches.length} match(es)${hasMore ? " (more available)" : ""}${staleNote}\n${formatMatches(matches)}${next}`;
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
      : `No definition indexed for "${name}".`;
  }
);

tool(
  "find_references",
  {
    title: "Find references to a symbol (textual)",
    description:
      "Whole-word textual search for a symbol, returned as path:line:col with the enclosing function/class. Not " +
      "scope-aware, so may include unrelated same-named identifiers. Supports limit/offset.",
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
    const { matches } = await searchFiles(ROOT, files, `\\b${escaped}\\b`, {
      regex: true,
      maxMatches: limit ?? 20,
      offset: offset ?? 0,
    });
    // attribute each hit to its enclosing symbol
    const rows = matches.map((m) => {
      const enc = enclosingSymbol(index.files[m.file], m.line);
      return `  ${m.file}:${m.line}:${m.col}${enc ? `  in ${enc.kind} ${enc.name}` : ""}`;
    });
    return `${matches.length} reference(s) to "${name}":\n${rows.join("\n") || "  (none)"}`;
  }
);

tool(
  "get_symbol_context",
  {
    title: "Surgical symbol snippet",
    description:
      "Return ONLY the body of a symbol (function/class) plus a few context lines — not the whole file. Give a name " +
      "(resolved via the index) or an explicit path+line. This is the biggest per-lookup token saver.",
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
      "replaced by ' … {line}'. Turns a 2,000-line file into a readable map for a fraction of the tokens.",
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
    description: "Birds-eye overview: top directories with file counts, total lines, and symbol counts.",
    inputSchema: { depth: z.number().int().min(1).max(4).optional() },
  },
  async ({ depth }) => {
    const index = await loadIndex(ROOT);
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
    if (buckets.size === 0) return "Index is empty — run index_repo first.";
    const rows = [...buckets.entries()]
      .sort((a, b) => b[1].lines - a[1].lines)
      .map(([k, v]) => `  ${k.padEnd(40)} ${String(v.files).padStart(5)} files ${String(v.lines).padStart(7)} lines ${String(v.symbols).padStart(6)} symbols`);
    return `Repo map for ${ROOT} (depth ${d}):\n${rows.join("\n")}`;
  }
);

tool(
  "dep_graph",
  {
    title: "Dependency graph query",
    description:
      "Query the internal import graph. mode=imports: what a file imports. mode=dependents: what imports a file. " +
      "mode=mermaid: a Mermaid diagram — pass root (+depth, default 2) to walk outward from one file instead of " +
      "dumping the whole graph, or scope to a path prefix.",
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

// ---- persistent memory ----
tool(
  "memory_save",
  {
    title: "Persist a memory fact",
    description: "Save a durable note (decision, gotcha, TODO, location) to <root>/.leanctx/memory.json.",
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
      "Execute multiple leanctx calls in one request to avoid per-call protocol overhead. Pass calls: " +
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
  console.error(`leanctx-mcp v0.4.0 ready. root=${ROOT}  tools=${Object.keys(handlers).length}`);
  // Opt-in auto-reindex on file change. Off unless LEANCTX_WATCH is truthy.
  if (["1", "true", "yes"].includes((process.env.LEANCTX_WATCH || "").toLowerCase())) {
    const { startWatcher } = await import("./watch.js");
    startWatcher(ROOT);
  }
}
main().catch((e) => {
  console.error("leanctx-mcp fatal:", e);
  process.exit(1);
});
