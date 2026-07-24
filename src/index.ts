#!/usr/bin/env node
// slimdex-mcp — a local MCP server for narrow code retrieval.
//
// Instead of reading whole files into context, an agent asks slimdex for exactly
// what it needs: an outline, a compact search, a ranged read, a surgical symbol
// snippet, a file skeleton, a one-shot context brief, a symbol index for
// jump-to-definition, a dependency graph, a git change summary, and a persistent
// memory store. Everything is cached under <root>/.slimdex/.
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
import { buildGraph, dependents, toMermaid, nameRefEdges, mergeEdges } from "./graph.js";
import { fileSkeleton, getSymbolContext, buildContext, enclosingSymbol } from "./intel.js";
import { changedFiles, formatChanged, isGitRepo } from "./git.js";
import { loadStats, formatStats, record, resetStats } from "./stats.js";
import { loadIndex, loadMemory, saveMemory, loadDigest, saveDigest, type MemoryFact, type DigestStore } from "./store.js";
import { readFileCached } from "./fscache.js";
import { journalRecord, formatRecap, recentHints } from "./journal.js";
import { takeSnapshot, newestSnapshotAgeMs } from "./snapshot.js";
import { isTestFile } from "./testlink.js";
import { spliceSymbol } from "./edit.js";
import { composeBrief } from "./brief.js";
import { rankIntent } from "./intent.js";
import { isStale, stalenessNote } from "./freshness.js";
import { buildPack } from "./pack.js";
import { staleCovered, formatDigest } from "./digest.js";
import { TERSE, t, fileHeader, countNotice, truncNotice } from "./terse.js";

const ROOT = path.resolve(process.env.SLIMDEX_ROOT || process.argv[2] || process.cwd());

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
const INSTRUCTIONS = `slimdex replaces "read the whole file" with narrow retrieval. To actually save tokens:

1. Start with repo_map, not a file open. On a big repo, orient at the directory level before drilling in.
   To understand an unfamiliar AREA ('how does auth work'), use context_pack("<question>") — it runs the
   whole exploration server-side (rank + connect + bodies) and returns ONE bounded bundle, instead of ~10
   separate calls that each linger in the transcript and re-cost every later turn.
2. Run index_repo liberally — it only reparses files whose mtime changed, so treat it like \`git fetch\`,
   not a one-time setup step. Re-run it before trusting a search if anything else may have touched the repo.
3. get_file_skeleton before any full read of a file over ~300 lines — then FOLLOW THROUGH: pull the
   bodies you need with get_symbol_context (names:[...] takes several in one call) or read_lines.
   Falling back to a whole-file read after a skeleton throws the saving away at the exact moment it
   was about to pay; the skeleton told you where everything is, so read only that.
4. For anything symbol-shaped use find_definition / find_references / get_symbol_context, not search_code.
   Plain text search on a large codebase returns same-named identifiers from unrelated files.
   Reserve search_code for real string/text searches. When you know WHAT the code does but not its
   name, use search_intent (BM25 over symbol names — 'validate email' → validateEmail) instead of
   guessing search_code patterns.
5. Prefer one get_context(name, include:[...]) over chaining find_definition + find_references + dep_graph.
6. Scope search_code and find_references with pathPrefix when you already know the rough area.
7. Before refactoring a shared module, run dep_graph mode:"mermaid" root:"<file>" to see the blast radius.
8. changed_files is the cheap way to start a session on a dirty repo — it reports which symbols the diff
   lands in, without pulling the patch into context.
9. batch several lookups into one call when they're independent.

MEMORY — this is what makes a new chat start informed instead of blank:

10. FIRST action in a new session, before exploring: call brief. It is the one-shot opener —
    repo summary + where recent sessions were digging (from the automatic journal) + every saved
    conclusion CHECKED against the current index, so stale notes are flagged (✓ live / ⚠ maybe stale)
    instead of trusted blindly. It folds memory_list + recap together; drop to those two (in one
    batch call) only when you want the raw, unsynthesized lists.
11. memory_save anything durable the moment you learn it — an architectural decision and WHY, a
    non-obvious constraint, a gotcha that cost you time, where a surprising thing lives, a convention
    the code implies but never states. Tag it so memory_search finds it later.
    Work-in-progress COUNTS: confirmed bugs, findings, half-done fixes, agreed next steps. Save each
    one when it is confirmed, not "at the end" — sessions never announce their end; the user simply
    opens a new chat, and anything unsaved is gone. A findings list that dies with the tab was the
    single most expensive loss observed in real use.
12. Do NOT save what the code already says. A symbol's location is what the index is for; re-run
    index_repo instead. Memory is for the things reading the code cannot tell you.
13. Correct rather than duplicate: memory_search before saving, and memory_delete facts that turn out
    to be wrong. A store full of stale or repeated notes is worse than an empty one.
13b. Once you understand the repo's shape, digest_save a compact architecture cheat-sheet (modules, key
    flows, entry points, conventions) with \`covers\` set to the areas it describes. digest_get reads it
    back with a freshness verdict, so the NEXT session reads a page instead of re-exploring the code —
    and is told if a covered file changed since. This is the single biggest cross-session saving.

EDITING — the output side, where tokens actually cost the most (≈4-5x input):

14. Before you change a symbol, run find_tests on it. It tells you which tests exercise it — run
    exactly those instead of the whole suite, or SEE that nothing covers it and treat that as risk
    before editing, not after.
15. To rewrite a whole function/class/method, use replace_symbol name:"X" body:"..." — do NOT re-send
    the old code just so an edit tool can locate the change. slimdex already knows where X is; you emit
    only the new body. The file is snapshotted first and re-indexed after, and the response reports the
    new line span so you don't re-read to verify. Patch the symbols you pulled; never re-emit a whole
    file to change a few lines.`;

// ---------------------------------------------------------------------------
// Handler registry. Each handler returns a plain string. Registering through
// `tool()` wraps it with terse error handling (no stack traces leak to the
// model), records response size for the `stats` tool, and registers it so the
// `batch` tool can dispatch to it too.
// ---------------------------------------------------------------------------
type Handler = (args: any) => Promise<string>;
const handlers: Record<string, Handler> = {};
const server = new McpServer({ name: "slimdex", version: "0.9.0" }, { instructions: INSTRUCTIONS });

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
    void journalRecord(ROOT, name, args); // automatic continuity breadcrumb; never throws
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
      "<root>/.slimdex.json (ignoreDirs/extensions/exclude/maxFileBytes) and reports config problems instead of " +
      "silently ignoring them.",
    inputSchema: { force: z.boolean().optional().describe("Ignore cache and reparse everything.") },
  },
  async ({ force }) => {
    const r = await buildOrRefresh(ROOT, force ?? false);
    const symbols = Object.values(r.index.files).reduce((n, f) => n + f.symbols.length, 0);
    const warn = r.warnings.length ? `\n  config warnings:\n${r.warnings.map((w) => "    ! " + w).join("\n")}` : "";

    // Automatic safety snapshot, riding on the call agents already make
    // constantly. At most hourly, only when the tree is dirty, best-effort:
    // uncommitted edits are the only state here with zero copies, and this
    // gives them one without anyone having to remember anything.
    let snapNote = "";
    try {
      const age = await newestSnapshotAgeMs(ROOT);
      if ((age === null || age > 60 * 60 * 1000) && (await isGitRepo(ROOT))) {
        const dirty = await changedFiles(ROOT, r.index);
        if (dirty.length) {
          const snap = await takeSnapshot(ROOT, dirty.map((f) => f.file));
          snapNote = `\n  safety snapshot: ${snap.files} uncommitted file(s) → ${snap.dir} (auto, hourly; a pushed commit is still the real protection)`;
        }
      }
    } catch {
      /* never let a snapshot problem break indexing */
    }

    return (
      `Indexed ${r.totalFiles} files under ${ROOT}\n` +
      `  parsed: ${r.parsed}  reused(cache): ${r.reused}  removed: ${r.removed}` +
      (r.skipped ? `  skipped(too large): ${r.skipped}` : "") +
      `\n  symbols indexed: ${symbols}  parser: ${r.parser}\n` +
      `  config: ${r.config}${warn}\n` +
      `Cache: ${path.join(ROOT, ".slimdex", "index.json")}` +
      snapNote
    );
  }
);

tool(
  "snapshot",
  {
    title: "Snapshot uncommitted work",
    description:
      "Copy every uncommitted (changed or untracked) file into .slimdex/snapshots/<timestamp>/ as insurance against " +
      "accidental resets. Also runs automatically (at most hourly) whenever index_repo sees a dirty tree. Newest 10 " +
      "snapshots are kept. This defeats a stray `git checkout .` — it does NOT replace committing, which is the only " +
      "protection that survives the disk.",
    inputSchema: {},
  },
  async () => {
    if (!(await isGitRepo(ROOT))) return "Not a git repository — snapshot needs git to identify uncommitted files.";
    const index = await loadIndex(ROOT);
    const dirty = await changedFiles(ROOT, index);
    if (dirty.length === 0) return "Working tree clean — nothing to snapshot.";
    const snap = await takeSnapshot(ROOT, dirty.map((f) => f.file));
    return `Snapshot: ${snap.files} uncommitted file(s) → ${snap.dir}\n(newest 10 snapshots kept; a pushed commit is still the real protection)`;
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
    const src = await readFileCached(abs);
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
    const lines = (await readFileCached(abs)).split(/\r?\n/);
    const s = Math.max(1, start);
    const e = Math.min(lines.length, Math.max(s, end));
    const body = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}  ${l}`).join("\n");
    return `${fileHeader(toPosix(path.relative(ROOT, abs)), s, e, lines.length)}\n${body}`;
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
    return `${t(`${matches.length} of ${totalStr} match(es)`, `${matches.length}/${totalStr}`)}${staleNote}\n${formatMatches(matches)}${next}`;
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
      ? `${t(`${hits.length} definition candidate(s) for "${name}":`, `${hits.length} def(s) "${name}":`)}\n${hits.join("\n")}`
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
    const rows = shown.map((h) =>
      TERSE ? `  ${h.file}:${h.line}:${h.col} ${h.kind} ${h.name}` : `  ${h.file}:${h.line}:${h.col}  ${h.kind.padEnd(9)} ${h.name}`
    );
    const more = hits.length > shown.length ? `\n  … ${hits.length - shown.length} more; raise limit or narrow with kind/pathPrefix` : "";
    return `${t(`${shown.length} of ${hits.length} symbol(s) matching "${query}":`, `${shown.length}/${hits.length} "${query}":`)}\n${rows.join("\n")}${more}`;
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
      literalHint: name, // skip files that can't possibly contain the symbol
    });
    // attribute each hit to its enclosing symbol
    const rows = matches.map((m) => {
      const enc = enclosingSymbol(index.files[m.file], m.line);
      return `  ${m.file}:${m.line}:${m.col}${enc ? `  in ${enc.kind} ${enc.name}` : ""}`;
    });
    const totalStr = exact ? `${total}` : `${total}+ (scan cap reached)`;
    const more = total > off + matches.length ? `\n  … raise offset to ${off + lim} for more` : "";
    return `${t(`${matches.length} of ${totalStr} reference(s) to "${name}":`, `${matches.length}/${totalStr} refs "${name}":`)}\n${rows.join("\n") || "  (none)"}${more}`;
  }
);

tool(
  "find_tests",
  {
    title: "Which tests exercise a symbol",
    description:
      "The regression-coverage question dep_graph can't answer: of everything that references a symbol, which references " +
      "live in TEST files. Answers 'if I change calculateTax, which tests will catch a break' — run exactly those instead " +
      "of the whole suite. If NOTHING tests it, that's surfaced as a risk before you edit, not discovered after. A file " +
      "counts as a test by path convention (*.test.*, *.spec.*, __tests__/, test_*.py, *_test.go …) or by containing an " +
      "indexed describe/it/test title. Textual like find_references, so same honest caveat: same-named identifiers can slip in.",
    inputSchema: {
      name: z.string(),
      pathPrefix: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
  },
  async ({ name, pathPrefix, limit }) => {
    const index = await loadIndex(ROOT);
    let files = Object.keys(index.files);
    if (pathPrefix) files = files.filter((f) => f.startsWith(toPosix(pathPrefix)));
    // Scan ONLY test files (by path convention or by containing an indexed
    // describe/it/test title). A symbol used heavily in non-test code could
    // otherwise fill the match window before any test reference is reached,
    // yielding a false "no tests" — so we narrow the corpus, not just the result.
    const testFiles = files.filter((f) => isTestFile(f) || (index.files[f]?.symbols ?? []).some((s) => s.kind === "test"));
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lim = limit ?? 50;
    const { matches } = await searchFiles(ROOT, testFiles, `\\b${escaped}\\b`, {
      regex: true,
      maxMatches: 500,
      literalHint: name,
    });
    const hits = matches
      .map((m) => ({ m, enc: enclosingSymbol(index.files[m.file], m.line) }))
      .filter(({ m, enc }) => isTestFile(m.file) || enc?.kind === "test")
      .slice(0, lim);
    if (hits.length === 0) {
      return (
        `⚠ No tests reference "${name}". Changing it has no regression coverage in this repo — ` +
        `add a test, or proceed knowing nothing will catch a break.`
      );
    }
    const rows = hits.map(({ m, enc }) => `  ${m.file}:${m.line}${enc ? `  in ${enc.kind} ${enc.name}` : ""}`);
    return `${hits.length} test reference(s) to "${name}" — run these before changing it:\n${rows.join("\n")}`;
  }
);

tool(
  "search_intent",
  {
    title: "Find code by intent (BM25, no embeddings)",
    description:
      "When you know WHAT the code does but not its name: a natural-language query ranked against every indexed symbol " +
      "by BM25 over tokenized names (camelCase/snake_case split), kinds and filenames — so 'validate user email' surfaces " +
      "validateEmail / emailValidator / checkUserAddress. The featherweight answer to semantic search: no embeddings, no " +
      "model, no extra index to keep fresh — instant and offline, and the scores are explainable, not an opaque cosine. " +
      "For an exact/partial name use search_symbols; for a literal string use search_code; this is for 'the thing that…'.",
    inputSchema: {
      query: z.string().describe("What the code does, in words — 'parse the config file', 'retry a failed request'."),
      limit: z.number().int().min(1).max(50).optional().describe("Top matches to return (default 10)."),
    },
  },
  async ({ query, limit }) => {
    const index = await loadIndex(ROOT);
    const hits = rankIntent(index, query, limit ?? 10);
    if (!hits.length) return `No symbol matched the intent "${query}". Try different words, or search_code for a literal string.`;
    const rows = hits.map((h) => `  ${h.file}:${h.line}  ${h.kind} ${h.name}  (${h.score.toFixed(2)})`);
    return `Ranked by intent for "${query}" (BM25 score):\n${rows.join("\n")}`;
  }
);

tool(
  "context_pack",
  {
    title: "One-call task context bundle",
    description:
      "Understand a whole topic in ONE call instead of ~10. Give a natural-language query ('how does auth work') and " +
      "slimdex runs the exploration itself — BM25-ranks the relevant symbols, shows how their files connect (import " +
      "graph, one hop), and includes the top few bodies — assembled into a single bundle under a char budget. Saves " +
      "the round-trips AND keeps the transcript from bloating with ten separate results (the cost that compounds every " +
      "later turn). Use it to orient on an unfamiliar area; drop to get_symbol_context / read_lines for exact source.",
    inputSchema: {
      query: z.string().describe("The topic to understand, in words — 'how does login work', 'the indexing pipeline'."),
      budget: z.number().int().min(1000).max(20000).optional().describe("Soft char cap on the whole pack (default 6000)."),
      symbols: z.number().int().min(1).max(20).optional().describe("How many ranked symbols to list (default 8)."),
      bodies: z.number().int().min(0).max(8).optional().describe("How many top symbols to include full bodies for (default 3)."),
    },
  },
  async ({ query, budget, symbols, bodies }) => {
    const index = await loadIndex(ROOT);
    const getBody = async (file: string, line: number, kind: string, maxLines: number): Promise<string> => {
      const siblings = (index.files[file]?.symbols ?? []).map((s) => s.line).filter((l) => l > line).sort((a, b) => a - b);
      const ctx = await getSymbolContext(ROOT, file, line, kind, 0, 0, maxLines, siblings[0]);
      return ctx.text;
    };
    return buildPack(index, query, getBody, { budget, symbols, bodies });
  }
);

tool(
  "get_symbol_context",
  {
    title: "Surgical symbol snippet(s)",
    description:
      "Return ONLY the body of a symbol (function/class/method) plus a few context lines — not the whole file. Give a " +
      "name (resolved via the index), several `names` at once, or an explicit path+line. This is the biggest " +
      "per-lookup token saver. When a skeleton showed you WHERE the functions are, pull their bodies with " +
      "names:[...] here — do NOT fall back to reading the whole file for a handful of bodies.",
    inputSchema: {
      name: z.string().optional().describe("Symbol name to resolve via the index."),
      names: z
        .array(z.string())
        .min(1)
        .max(10)
        .optional()
        .describe("Several symbol names in one call — one bounded body each. The narrow alternative to a whole-file read."),
      path: z.string().optional().describe("File path (use with line instead of name)."),
      line: z.number().int().min(1).optional().describe("Definition line (use with path)."),
      before: z.number().int().min(0).max(20).optional(),
      after: z.number().int().min(0).max(20).optional(),
      maxLines: z.number().int().min(1).max(2000).optional().describe("Cap each returned span (default 200); tail elided with a notice."),
    },
  },
  async ({ name, names, path: p, line, before, after, maxLines }) => {
    const index = await loadIndex(ROOT);

    const one = async (sym: string | undefined, fp: string | undefined, ln: number | undefined): Promise<string> => {
      let file: string, defLine: number, kind = "symbol";
      if (fp && ln) {
        file = toPosix(path.relative(ROOT, safeResolve(fp)));
        defLine = ln;
      } else if (sym) {
        const found: { file: string; line: number; kind: string }[] = [];
        for (const [f, entry] of Object.entries(index.files))
          for (const s of entry.symbols) if (s.name === sym) found.push({ file: f, line: s.line, kind: s.kind });
        if (found.length === 0) return `No definition indexed for "${sym}". Run index_repo, or pass path + line explicitly.`;
        if (found.length > 1)
          return (
            `"${sym}" has ${found.length} definitions — pass path + line to pick one:\n` +
            found.map((d) => `  ${d.file}:${d.line}  ${d.kind}`).join("\n")
          );
        file = found[0].file;
        defLine = found[0].line;
        kind = found[0].kind;
      } else {
        return "Provide either name, names, or path + line.";
      }
      // The next declaration in the same file bounds the trailing padding, so a
      // "just this symbol" response can't spill into the following function.
      const siblings = (index.files[file]?.symbols ?? [])
        .map((sym2) => sym2.line)
        .filter((l) => l > defLine)
        .sort((a, b) => a - b);
      const ctx = await getSymbolContext(
        ROOT, file, defLine, kind, before ?? 2, after ?? 2, maxLines ?? 200, siblings[0]
      );
      // Self-verifying: warn (only) when this file changed since indexing, so
      // the agent knows the located line may be off without re-reading to check.
      const fresh = await stalenessNote(ROOT, file, index.files[file]?.mtimeMs ?? Infinity);
      return `${ctx.file}:${ctx.line}  ${ctx.kind}  (${ctx.loc} LOC)\n${ctx.text}${fresh}`;
    };

    // Several bodies in one round-trip. A miss or an ambiguity reports inline
    // as that symbol's section instead of failing the whole batch.
    if (names && names.length) {
      const parts: string[] = [];
      for (const n of names) parts.push(await one(n, undefined, undefined));
      return parts.join("\n\n");
    }
    return one(name, p, line);
  }
);

// ---- the write side: attack OUTPUT tokens, not just input ----
tool(
  "replace_symbol",
  {
    title: "Replace a symbol's body by name (write)",
    description:
      "Overwrite the full definition of a symbol (function/class/method) with new code, addressed by NAME — you never " +
      "re-send the old body just to locate the edit, which is where output tokens (≈4-5x input) leak on every change. " +
      "The symbol's line range comes from the index; the file is SNAPSHOTTED first (rollback under .slimdex/snapshots), " +
      "then re-indexed, and the response reports the new line span so you don't re-read to verify. Ambiguous or unknown " +
      "names are refused, never guessed. `body` must be the complete replacement definition, indented to sit in the file.",
    inputSchema: {
      name: z.string().optional().describe("Symbol to replace, resolved via the index."),
      path: z.string().optional().describe("File path (use with line instead of name)."),
      line: z.number().int().min(1).optional().describe("Definition line (use with path)."),
      body: z.string().describe("The complete new definition, replacing the old one verbatim."),
    },
  },
  async ({ name, path: p, line, body }) => {
    if (typeof body !== "string" || !body.length) return "body (the complete replacement definition) is required.";
    const index = await loadIndex(ROOT);

    let file: string, defLine: number;
    if (p && line) {
      // safeResolve blocks `..` traversal, but a symlink INSIDE the repo can
      // still point outside it — and this tool writes to disk. Resolve real
      // paths and confirm the target is genuinely under ROOT before writing.
      const abs = safeResolve(p);
      try {
        const rootReal = await fs.realpath(ROOT);
        const targetReal = await fs.realpath(abs);
        const rel = path.relative(rootReal, targetReal);
        if (rel.startsWith("..") || path.isAbsolute(rel)) return `path escapes project root: ${p}`;
      } catch {
        return `Cannot resolve ${p} (does it exist?).`;
      }
      file = toPosix(path.relative(ROOT, abs));
      defLine = line;
    } else if (name) {
      const found: { file: string; line: number }[] = [];
      for (const [f, entry] of Object.entries(index.files))
        for (const s of entry.symbols) if (s.name === name) found.push({ file: f, line: s.line });
      if (found.length === 0) return `No definition indexed for "${name}". Run index_repo, or pass path + line.`;
      if (found.length > 1)
        return (
          `"${name}" has ${found.length} definitions — pass path + line to pick one, I won't guess which to overwrite:\n` +
          found.map((d) => `  ${d.file}:${d.line}`).join("\n")
        );
      file = found[0].file;
      defLine = found[0].line;
    } else {
      return "Provide either name, or path + line, plus body.";
    }

    const abs = path.join(ROOT, file);
    let source: string;
    try {
      source = await readFileCached(abs);
    } catch {
      return `Cannot read ${file}.`;
    }
    // Snapshot BEFORE writing — the whole safety story. If this edit is wrong,
    // the pre-edit file is under .slimdex/snapshots/<stamp>/.
    const snap = await takeSnapshot(ROOT, [file]);
    const res = spliceSymbol(source, defLine, body);
    await fs.writeFile(abs, res.text, "utf8");
    // Re-index (mtime changed -> only this file re-parses) so the new span is
    // queryable immediately and the reported line numbers are the real ones.
    await buildOrRefresh(ROOT, false);
    const fresh = await loadIndex(ROOT);
    const stillThere = (fresh.files[file]?.symbols ?? []).some((s) => s.line >= res.oldStart && s.line <= res.newEnd);
    const snapNote = snap.files > 0 ? `snapshot saved (${snap.dir})` : "snapshot skipped (file too large or unreadable)";
    const parseNote = stillThere
      ? "re-indexed, a symbol is present in the new range"
      : "⚠ re-indexed but no symbol parsed in the new range — check the body is a valid declaration";
    return (
      `Replaced ${name ?? `${file}:${defLine}`}: lines ${res.oldStart}-${res.oldEnd} → ${res.oldStart}-${res.newEnd} ` +
      `(${res.newEnd - res.oldStart + 1} line(s)). ${snapNote}; ${parseNote}.`
    );
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
    const src = await readFileCached(abs);
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
      "definition,signature,callers,imports). Add 'body' for full source or 'dependents' for reverse deps. Bounded by " +
      "callerLimit and maxChars with explicit truncation — so it stays a token-saver, not a token-hog.",
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
        .map(([f, e]) =>
          TERSE
            ? `  ${f} ${e.lines}L ${e.symbols.length}sym`
            : `  ${f.padEnd(52)} ${String(e.lines).padStart(6)} lines ${String(e.symbols.length).padStart(5)} symbols`
        )
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
      .map(([k, v]) =>
        TERSE
          ? `  ${k} ${v.files}f ${v.lines}L ${v.symbols}sym`
          : `  ${k.padEnd(40)} ${String(v.files).padStart(5)} files ${String(v.lines).padStart(7)} lines ${String(v.symbols).padStart(6)} symbols`
      );
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
    // Import edges, plus name-reference edges for import-less languages (Apex)
    // — without the second set, Salesforce repos graphed to nothing.
    const graph = mergeEdges(buildGraph(index), await nameRefEdges(ROOT, index));
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
      "Per-tool call counts and response sizes recorded to <root>/.slimdex/stats.json. Reported in characters, not " +
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
    description: "Save a durable note (decision, gotcha, TODO, location) to <root>/.slimdex/memory.json.",
    inputSchema: { text: z.string(), tags: z.array(z.string()).optional() },
  },
  async ({ text: t, tags }) => {
    const mem = await loadMemory(ROOT);
    // Decision provenance: what the agent was looking at when it concluded this.
    // Best-effort — a memory must save even if the journal is empty/unreadable.
    const context = await recentHints(ROOT, 8);
    const fact: MemoryFact = {
      id: randomUUID().slice(0, 8),
      text: t,
      tags: tags ?? [],
      created: new Date().toISOString(),
      ...(context ? { context } : {}),
    };
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
  "recap",
  {
    title: "What previous sessions did (automatic)",
    description:
      "Reconstructs prior activity from the server's own tool-call journal — most-examined files, most-looked-up " +
      "symbols, recent searches. Needs NO prior memory_save: it is recorded automatically, so it works even when the " +
      "last session saved nothing. Call it with memory_list at the START of a session: recap = where past sessions " +
      "looked, memory = what they concluded.",
    inputSchema: {
      limit: z.number().int().min(1).max(400).optional().describe("How many recent journaled calls to summarize (default 200)."),
    },
  },
  async ({ limit }) => formatRecap(ROOT, limit ?? 200)
);

tool(
  "brief",
  {
    title: "One-shot session onboarding brief",
    description:
      "The whole point of the persistence layer in one call: instead of stitching memory_list + recap yourself at the " +
      "start of a session, get a synthesized opener — what the repo is, where recent sessions were digging (from the " +
      "automatic journal), and each saved conclusion CHECKED against the current index so stale ones are flagged (✓ still " +
      "references live code, ⚠ may be stale). Call this first in a fresh chat; it starts you informed instead of blank.",
    inputSchema: {
      limit: z.number().int().min(1).max(400).optional().describe("Journaled calls to summarize for the focus section (default 200)."),
    },
  },
  async ({ limit }) => {
    const index = await loadIndex(ROOT);
    if (Object.keys(index.files).length === 0) return "Index is empty — run index_repo first, then brief.";
    const mem = await loadMemory(ROOT);
    const recap = await formatRecap(ROOT, limit ?? 200);
    // Repo-level freshness: how many files drifted from the index since it was
    // built, so the brief itself says whether to re-index before trusting it.
    let staleCount = 0;
    for (const [f, e] of Object.entries(index.files)) if (await isStale(ROOT, f, e.mtimeMs)) staleCount++;
    const freshLine = staleCount
      ? `\n⚠ ${staleCount} file(s) changed since the index was built — run index_repo before trusting line numbers.`
      : "";
    return composeBrief({ index, facts: mem.facts, recap, root: ROOT }) + freshLine;
  }
);

tool(
  "digest_save",
  {
    title: "Save the repo architecture digest",
    description:
      "Store a compact 'how this repo works' cheat-sheet you author once — modules, key flows, entry points, " +
      "conventions — so future sessions read a page instead of re-exploring the code to relearn the system. Pass " +
      "`covers` (the paths/dirs it summarizes) so slimdex can tell later sessions when a covered file changed and the " +
      "digest may be stale. Overwrites the previous digest. Save what reading the code CAN'T quickly tell you: the why " +
      "and the shape, not a symbol list (the index already has that).",
    inputSchema: {
      text: z.string().describe("The digest prose — compact, the architecture and flows, not a file dump."),
      covers: z.array(z.string()).optional().describe("Repo-relative paths/dirs this digest summarizes (omit = whole repo)."),
    },
  },
  async ({ text: t, covers }) => {
    const digest: DigestStore = { version: 1, text: t, covers: covers ?? [], savedAt: new Date().toISOString() };
    await saveDigest(ROOT, digest);
    const scope = digest.covers.length ? digest.covers.join(", ") : "whole repo";
    return `Saved architecture digest (${t.length} chars, covers: ${scope}). digest_get reads it back with a freshness check.`;
  }
);

tool(
  "digest_get",
  {
    title: "Read the repo architecture digest",
    description:
      "Return the stored architecture cheat-sheet, plus a freshness verdict: each covered file is checked against when " +
      "the digest was written, and any that changed since are flagged as reasons it may be out of date. Read this early " +
      "in a session to understand the system without re-exploring; if it's flagged stale, re-read the changed areas and " +
      "digest_save an update.",
    inputSchema: {},
  },
  async () => {
    const digest = await loadDigest(ROOT);
    if (!digest) return "No architecture digest saved yet — write one with digest_save so future sessions skip re-exploring.";
    const index = await loadIndex(ROOT);
    const stale = await staleCovered(ROOT, digest, Object.keys(index.files));
    return formatDigest(digest, stale);
  }
);

tool(
  "memory_list",
  {
    title: "List memory",
    description: "List saved memory facts, newest first (default 50). Use memory_search to filter a large store.",
    inputSchema: { limit: z.number().int().min(1).max(1000).optional().describe("Max facts to return (default 50).") },
  },
  async ({ limit }) => {
    const mem = await loadMemory(ROOT);
    if (!mem.facts.length) return "No memory saved yet.";
    const lim = limit ?? 50;
    // Newest first: recent decisions supersede old ones, so they should be the
    // first thing a fresh session reads — and the part that survives a cap.
    const shown = [...mem.facts].reverse().slice(0, lim);
    const rows = shown.map((f) => `[${f.id}] ${f.tags.length ? "(" + f.tags.join(",") + ") " : ""}${f.text}`);
    const more = mem.facts.length > lim ? `\n… ${mem.facts.length - lim} older fact(s); raise limit or memory_search.` : "";
    return rows.join("\n") + more;
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
      "Execute multiple slimdex calls in one request to avoid per-call protocol overhead. Pass calls: " +
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
        void journalRecord(ROOT, c.tool, c.args); // sub-calls leave breadcrumbs too
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
  console.error(`slimdex-mcp v0.9.0 ready. root=${ROOT}  tools=${Object.keys(handlers).length}`);
  // Opt-in auto-reindex on file change. Off unless SLIMDEX_WATCH is truthy.
  if (["1", "true", "yes"].includes((process.env.SLIMDEX_WATCH || "").toLowerCase())) {
    const { startWatcher } = await import("./watch.js");
    startWatcher(ROOT);
  }
}
main().catch((e) => {
  console.error("slimdex-mcp fatal:", e);
  process.exit(1);
});
