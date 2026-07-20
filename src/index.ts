#!/usr/bin/env node
// leanctx-mcp — a local MCP server that helps coding agents spend fewer tokens.
//
// Instead of reading whole files, an agent can ask for: an outline (signatures
// only), a compact search (path:line:col + the one matching line), a ranged
// read, a persistent symbol index for jump-to-definition, a dependency graph,
// and a persistent memory store. Everything is cached under <root>/.leanctx/.
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
import { searchFiles, formatMatches } from "./search.js";
import { buildGraph, dependents, toMermaid } from "./graph.js";
import { loadIndex, loadMemory, saveMemory, type MemoryFact } from "./store.js";

const ROOT = path.resolve(process.env.LEANCTX_ROOT || process.argv[2] || process.cwd());

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// Resolve a user-supplied path (relative or absolute) and refuse to escape ROOT.
function safeResolve(p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes project root: ${p}`);
  }
  return abs;
}

const server = new McpServer({ name: "leanctx", version: "0.1.0" });

// ---------------------------------------------------------------------------
// index_repo
// ---------------------------------------------------------------------------
server.registerTool(
  "index_repo",
  {
    title: "Index / refresh the repository",
    description:
      "Build or incrementally refresh the persistent code index (symbols + imports) for the project root. " +
      "Only files whose modification time changed are re-parsed. Run this first, or after large edits.",
    inputSchema: { force: z.boolean().optional().describe("Ignore the cache and reparse everything.") },
  },
  async ({ force }) => {
    const r = await buildOrRefresh(ROOT, force ?? false);
    const symbols = Object.values(r.index.files).reduce((n, f) => n + f.symbols.length, 0);
    return text(
      `Indexed ${r.totalFiles} files under ${ROOT}\n` +
        `  parsed: ${r.parsed}  reused(cache): ${r.reused}  removed: ${r.removed}\n` +
        `  symbols indexed: ${symbols}\n` +
        `Cache: ${path.join(ROOT, ".leanctx", "index.json")}`
    );
  }
);

// ---------------------------------------------------------------------------
// outline_file
// ---------------------------------------------------------------------------
server.registerTool(
  "outline_file",
  {
    title: "Outline a file (signatures only)",
    description:
      "Return a compact outline of one file — declarations with line numbers, not the full body. " +
      "Use this to understand a file's shape before deciding which line ranges to read.",
    inputSchema: { path: z.string().describe("File path, relative to project root or absolute.") },
  },
  async ({ path: p }) => {
    const abs = safeResolve(p);
    const src = await fs.readFile(abs, "utf8");
    const entries = outline(src);
    const total = src.split(/\r?\n/).length;
    return text(formatOutline(toPosix(path.relative(ROOT, abs)), entries, total));
  }
);

// ---------------------------------------------------------------------------
// read_lines
// ---------------------------------------------------------------------------
server.registerTool(
  "read_lines",
  {
    title: "Read a line range",
    description: "Read only lines [start..end] (1-indexed, inclusive) of a file. Cheaper than reading the whole file.",
    inputSchema: {
      path: z.string(),
      start: z.number().int().min(1),
      end: z.number().int().min(1),
    },
  },
  async ({ path: p, start, end }) => {
    const abs = safeResolve(p);
    const src = await fs.readFile(abs, "utf8");
    const lines = src.split(/\r?\n/);
    const s = Math.max(1, start);
    const e = Math.min(lines.length, Math.max(s, end));
    const body = lines
      .slice(s - 1, e)
      .map((l, i) => `${String(s + i).padStart(5)}  ${l}`)
      .join("\n");
    return text(`${toPosix(path.relative(ROOT, abs))} [${s}-${e} of ${lines.length}]\n${body}`);
  }
);

// ---------------------------------------------------------------------------
// search_code
// ---------------------------------------------------------------------------
server.registerTool(
  "search_code",
  {
    title: "Compact code search",
    description:
      "Search indexed files and return matches as path:line:col plus the matching line (optionally with a caret " +
      "underline). Reads no more than it must. Run index_repo first for the file list.",
    inputSchema: {
      pattern: z.string(),
      regex: z.boolean().optional().describe("Treat pattern as a regular expression (default: literal)."),
      ignoreCase: z.boolean().optional(),
      pathPrefix: z.string().optional().describe("Limit to files under this repo-relative prefix."),
      highlight: z.boolean().optional().describe("Include a caret underline pointing at the match."),
      maxMatches: z.number().int().min(1).max(1000).optional(),
    },
  },
  async ({ pattern, regex, ignoreCase, pathPrefix, highlight, maxMatches }) => {
    const index = await loadIndex(ROOT);
    let files = Object.keys(index.files);
    if (files.length === 0) return text("Index is empty — run index_repo first.");
    if (pathPrefix) files = files.filter((f) => f.startsWith(toPosix(pathPrefix)));
    const matches = await searchFiles(ROOT, files, pattern, {
      regex,
      ignoreCase,
      highlight,
      maxMatches: maxMatches ?? 200,
    });
    return text(`${matches.length} match(es)\n${formatMatches(matches)}`);
  }
);

// ---------------------------------------------------------------------------
// find_definition
// ---------------------------------------------------------------------------
server.registerTool(
  "find_definition",
  {
    title: "Find where a symbol is defined",
    description:
      "Look up a symbol name in the persistent index and return its definition site(s) as path:line:col with kind. " +
      "Heuristic (regex-based), so it may return more than one candidate.",
    inputSchema: {
      name: z.string(),
      kind: z.string().optional().describe("Filter by kind, e.g. class, function, type."),
    },
  },
  async ({ name, kind }) => {
    const index = await loadIndex(ROOT);
    const hits: string[] = [];
    for (const [file, entry] of Object.entries(index.files)) {
      for (const s of entry.symbols) {
        if (s.name === name && (!kind || s.kind === kind)) {
          hits.push(`${file}:${s.line}:${s.col}  ${s.kind} ${s.name}`);
        }
      }
    }
    if (hits.length === 0) return text(`No definition indexed for "${name}". (Run index_repo, or it may be defined with unsupported syntax.)`);
    return text(`${hits.length} definition candidate(s) for "${name}":\n` + hits.join("\n"));
  }
);

// ---------------------------------------------------------------------------
// find_references
// ---------------------------------------------------------------------------
server.registerTool(
  "find_references",
  {
    title: "Find references to a symbol (textual)",
    description:
      "Whole-word textual search for a symbol across indexed files, returned as path:line:col. This is a text match, " +
      "not scope-aware resolution, so it may include same-named but unrelated identifiers.",
    inputSchema: {
      name: z.string(),
      pathPrefix: z.string().optional(),
      maxMatches: z.number().int().min(1).max(1000).optional(),
    },
  },
  async ({ name, pathPrefix, maxMatches }) => {
    const index = await loadIndex(ROOT);
    let files = Object.keys(index.files);
    if (pathPrefix) files = files.filter((f) => f.startsWith(toPosix(pathPrefix)));
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = await searchFiles(ROOT, files, `\\b${escaped}\\b`, {
      regex: true,
      highlight: true,
      maxMatches: maxMatches ?? 200,
    });
    return text(`${matches.length} reference(s) to "${name}":\n${formatMatches(matches)}`);
  }
);

// ---------------------------------------------------------------------------
// repo_map
// ---------------------------------------------------------------------------
server.registerTool(
  "repo_map",
  {
    title: "High-level repo map",
    description:
      "A cheap birds-eye overview: top directories with file counts, total lines, and symbol counts. " +
      "Use it to orient before drilling in.",
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
    if (buckets.size === 0) return text("Index is empty — run index_repo first.");
    const rows = [...buckets.entries()]
      .sort((a, b) => b[1].lines - a[1].lines)
      .map(([k, v]) => `  ${k.padEnd(40)} ${String(v.files).padStart(5)} files ${String(v.lines).padStart(7)} lines ${String(v.symbols).padStart(6)} symbols`);
    return text(`Repo map for ${ROOT} (grouped at depth ${d}):\n` + rows.join("\n"));
  }
);

// ---------------------------------------------------------------------------
// dep_graph
// ---------------------------------------------------------------------------
server.registerTool(
  "dep_graph",
  {
    title: "Dependency graph query",
    description:
      "Query the internal import graph. mode=imports: what a file imports. mode=dependents: what imports a file. " +
      "mode=mermaid: a Mermaid diagram of internal edges (optionally scoped to a path prefix).",
    inputSchema: {
      mode: z.enum(["imports", "dependents", "mermaid"]),
      target: z.string().optional().describe("File path for imports/dependents modes."),
      scope: z.string().optional().describe("Path prefix for mermaid mode."),
    },
  },
  async ({ mode, target, scope }) => {
    const index = await loadIndex(ROOT);
    const graph = buildGraph(index);
    if (mode === "mermaid") {
      return text("```mermaid\n" + toMermaid(graph, scope ? toPosix(scope) : undefined) + "\n```");
    }
    if (!target) return text("target is required for imports/dependents modes.");
    const t = toPosix(target);
    if (mode === "imports") {
      const deps = graph.imports[t] ?? [];
      const ext = graph.external[t] ?? [];
      return text(
        `${t} imports:\n` +
          (deps.length ? "  internal:\n" + deps.map((d) => "    " + d).join("\n") : "  (no internal deps)") +
          (ext.length ? "\n  external:\n" + ext.map((d) => "    " + d).join("\n") : "")
      );
    }
    const deps = dependents(graph, t);
    return text(deps.length ? `Files importing ${t}:\n` + deps.map((d) => "  " + d).join("\n") : `Nothing internal imports ${t}.`);
  }
);

// ---------------------------------------------------------------------------
// memory: save / search / list / delete
// ---------------------------------------------------------------------------
server.registerTool(
  "memory_save",
  {
    title: "Persist a memory fact",
    description: "Save a durable note (decision, gotcha, TODO, location) to <root>/.leanctx/memory.json. Survives restarts.",
    inputSchema: { text: z.string(), tags: z.array(z.string()).optional() },
  },
  async ({ text: t, tags }) => {
    const mem = await loadMemory(ROOT);
    const fact: MemoryFact = { id: randomUUID().slice(0, 8), text: t, tags: tags ?? [], created: new Date().toISOString() };
    mem.facts.push(fact);
    await saveMemory(ROOT, mem);
    return text(`Saved memory ${fact.id}${fact.tags.length ? " [" + fact.tags.join(", ") + "]" : ""}.`);
  }
);

server.registerTool(
  "memory_search",
  {
    title: "Search saved memory",
    description: "Find saved memory facts by substring and/or tag.",
    inputSchema: { query: z.string().optional(), tag: z.string().optional() },
  },
  async ({ query, tag }) => {
    const mem = await loadMemory(ROOT);
    const q = (query ?? "").toLowerCase();
    const hits = mem.facts.filter(
      (f) => (!q || f.text.toLowerCase().includes(q)) && (!tag || f.tags.includes(tag))
    );
    if (hits.length === 0) return text("No matching memory.");
    return text(hits.map((f) => `[${f.id}] ${f.tags.length ? "(" + f.tags.join(",") + ") " : ""}${f.text}`).join("\n"));
  }
);

server.registerTool(
  "memory_list",
  { title: "List all memory", description: "List every saved memory fact.", inputSchema: {} },
  async () => {
    const mem = await loadMemory(ROOT);
    if (mem.facts.length === 0) return text("No memory saved yet.");
    return text(mem.facts.map((f) => `[${f.id}] ${f.tags.length ? "(" + f.tags.join(",") + ") " : ""}${f.text}`).join("\n"));
  }
);

server.registerTool(
  "memory_delete",
  {
    title: "Delete a memory fact",
    description: "Remove one saved memory fact by its id.",
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    const mem = await loadMemory(ROOT);
    const before = mem.facts.length;
    mem.facts = mem.facts.filter((f) => f.id !== id);
    await saveMemory(ROOT, mem);
    return text(before === mem.facts.length ? `No memory with id ${id}.` : `Deleted memory ${id}.`);
  }
);

// ---------------------------------------------------------------------------
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the MCP channel.
  console.error(`leanctx-mcp ready. root=${ROOT}`);
}

main().catch((e) => {
  console.error("leanctx-mcp fatal:", e);
  process.exit(1);
});
