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
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { outline, formatOutline } from "./outline.js";
import { buildOrRefresh, toPosix, underPrefix, escapesBase } from "./indexer.js";
import { searchFiles, formatMatches, encodeCursor, decodeCursor } from "./search.js";
import { buildGraph, dependents, toMermaid, nameRefEdges, mergeEdges } from "./graph.js";
import { fileSkeleton, getSymbolContext, buildContext, enclosingSymbol } from "./intel.js";
import { changedFiles, formatChanged, isGitRepo } from "./git.js";
import { loadStats, loadSessionStats, formatStats, record, resetStats, flushStatsSync } from "./stats.js";
import { loadIndex, loadMemory, updateMemory, loadDigest, saveDigest, type MemoryFact, type DigestStore, type CodeIndex } from "./store.js";
import { invalidateFileCache, readFileCached } from "./fscache.js";
import { journalRecord, formatRecap, recentHints, flushJournalSync } from "./journal.js";
import { takeSnapshot, newestSnapshotAgeMs } from "./snapshot.js";
import { isTestFile } from "./testlink.js";
import { spliceSymbol, spliceSymbols, type PlannedEdit } from "./edit.js";
import { composeBrief } from "./brief.js";
import { rankIntent } from "./intent.js";
import { isStale, stalenessNote } from "./freshness.js";
import { buildPack } from "./pack.js";
import { staleCovered, formatDigest } from "./digest.js";
import { terse, t, fileHeader, countNotice, truncNotice } from "./terse.js";
import { factFull, formatFactList, PREVIEW_CHARS, SEARCH_PREVIEW_CHARS, SOFT_MAX_FACT_CHARS, HARD_MAX_FACT_CHARS } from "./memfmt.js";
import { checkRepeat } from "./dedupe.js";
import { advertised, profile, leanNote, LEAN_TOOLS } from "./profile.js";

const ROOT = path.resolve(process.env.SLIMDEX_ROOT || process.argv[2] || process.cwd());

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

// Resolve a user-supplied path (relative or absolute) and refuse to escape ROOT.
async function safeResolve(p: string): Promise<string> {
  const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
  // escapesBase, not startsWith(".."), so a real in-root file named `..cache`
  // is not mistaken for traversal.
  if (escapesBase(path.relative(ROOT, abs))) throw new Error(`path escapes project root: ${p}`);
  const [rootReal, targetReal] = await Promise.all([fs.realpath(ROOT), fs.realpath(abs)]);
  if (escapesBase(path.relative(rootReal, targetReal)))
    throw new Error(`path escapes project root via symlink: ${p}`);
  return abs;
}

async function changedSinceIndex(file: string, entry: CodeIndex["files"][string]): Promise<boolean> {
  if (await isStale(ROOT, file, entry.mtimeMs)) return true;
  try {
    const source = await fs.readFile(path.join(ROOT, file), "utf8");
    return createHash("sha256").update(source).digest("hex") !== entry.contentHash;
  } catch {
    return true;
  }
}

// The retrieval discipline that actually produces the savings. It lived only in
// the README, where no agent ever reads it; MCP clients inject `instructions`
// into the model's context, so shipping it here means every client gets it.
const INSTRUCTIONS = `slimdex replaces "read the whole file" with narrow retrieval. To actually save tokens:

1. Start with repo_map, not a file open — orient at the directory level before drilling in. To
   understand an unfamiliar AREA ('how does auth work'), use context_pack("<question>"): it runs the
   whole exploration server-side (rank + connect + bodies) and returns ONE bounded bundle, instead of
   ~10 separate calls that each linger in the transcript and re-cost every later turn.
2. Run index_repo liberally — it only reparses files whose mtime changed, so treat it like \`git fetch\`,
   not one-time setup. Re-run before trusting a search if anything else may have touched the repo.
3. get_file_skeleton before any full read of a file over ~300 lines — then FOLLOW THROUGH: pull the
   bodies you need with get_symbol_context (names:[...] takes several in one call) or read_lines.
   A whole-file read after a skeleton throws the saving away at the moment it was about to pay —
   the skeleton told you where everything is, so read only that.
4. For anything symbol-shaped use find_definition / find_references / get_symbol_context, not
   search_code — plain text search returns same-named identifiers from unrelated files. Reserve
   search_code for real string searches. Know WHAT the code does but not its name? search_intent
   (BM25 over symbol names — 'validate email' → validateEmail), not guessed search_code patterns.
5. Prefer one get_context(name, include:[...]) over chaining find_definition + find_references + dep_graph.
6. Scope search_code and find_references with pathPrefix when you already know the rough area.
7. Before refactoring a shared module, run dep_graph mode:"mermaid" root:"<file>" to see the blast radius.
8. changed_files is the cheap way to start a session on a dirty repo — it reports which symbols the diff
   lands in, without pulling the patch into context.
9. batch several lookups into one call when they're independent — but a batch costs the SUM of its
   sub-calls, so batch NARROW calls. Several wide reads in one batch is still one huge response, and
   it lands in the transcript as a single unskippable block. Same for read_lines: ask for the span you
   will actually use, and prefer get_symbol_context when you want a whole symbol — it ends at the
   symbol, so it can't over-read the way a guessed line range does.

MEMORY — this is what makes a new chat start informed instead of blank:

10. FIRST action in a new session, before exploring: call brief. It is the one-shot opener —
    repo summary + where recent sessions were digging (from the automatic journal) + every saved
    conclusion CHECKED against the current index, so stale notes are flagged (✓ live / ⚠ maybe stale)
    instead of trusted blindly. It folds memory_list + recap together; drop to those two (in one
    batch call) only when you want the raw, unsynthesized lists. Facts come back as previews; expand
    only what matters with memory_get ids:[...]. Never open a session with full:true.
11. memory_save anything durable the moment you learn it — a decision and WHY, a non-obvious
    constraint, a gotcha that cost time, where a surprising thing lives, a convention the code implies
    but never states. Tag it. Work-in-progress COUNTS: confirmed bugs, findings, half-done fixes, next
    steps — saved when confirmed, NOT "at the end". Sessions never announce their end; the user just
    opens a new chat and anything unsaved is gone (a findings list dying with the tab was the most
    expensive loss seen in real use). Lead with the conclusion — later sessions see the first ~150
    chars — and keep one fact to one thing.
12. Do NOT save what the code already says — a symbol's location is what the index is for. Memory is
    for what reading the code cannot tell you.
13. Correct rather than duplicate: memory_search before saving, memory_delete what turns out wrong. A
    store full of stale notes is worse than an empty one.
13b. Once you know the repo's shape, digest_save a compact architecture cheat-sheet (modules, flows,
    entry points, conventions) with \`covers\` set to the areas it describes — the NEXT session reads a
    page instead of re-exploring, and is told if a covered file changed. Biggest cross-session saving.

EDITING — the output side, where tokens actually cost the most (≈4-5x input):

14. Before changing a symbol, find_tests on it: run exactly the tests that cover it instead of the
    whole suite, or SEE that nothing covers it and treat that as risk before editing, not after.
15. To rewrite a whole function/class/method, use replace_symbol name:"X" body:"..." — do NOT re-send
    the old code just so an edit tool can locate the change. slimdex knows where X is; you emit only
    the new body. The file is snapshotted first, re-indexed after, and the response reports the new
    line span so you don't re-read to verify. Never re-emit a whole file to change a few lines.
16. Changing several symbols? Send them as replace_symbol edits:[{name,body},…] — one snapshot, one
    re-index, one response, instead of N calls that each re-state the plan and re-pay the per-turn
    overhead. Refused before any write if a target is ambiguous, two edits overlap, or a file is not
    writable; a mid-batch write failure rolls the earlier files back and reports the exact state.`;

// ---------------------------------------------------------------------------
// Handler registry. Each handler returns a plain string. Registering through
// `tool()` wraps it with terse error handling (no stack traces leak to the
// model), records response size for the `stats` tool, and registers it so the
// `batch` tool can dispatch to it too.
// ---------------------------------------------------------------------------
type Handler = (args: any) => Promise<string>;
const handlers: Record<string, Handler> = {};
const schemas: Record<string, z.ZodTypeAny> = {};
// Under a reduced surface the instructions must also say what is missing and
// how to reach it — most of the guidance above names tools lean does not
// advertise, and unreachable-in-practice is worse than a few hundred chars.
const server = new McpServer(
  { name: "slimdex", version: "0.9.0" },
  { instructions: profile() === "lean" ? INSTRUCTIONS + leanNote() : INSTRUCTIONS }
);

function tool(name: string, meta: { title: string; description: string; inputSchema: any }, fn: Handler) {
  // Always registered as a handler, even when the profile hides it from
  // tools/list: `batch` dispatches through this registry, so a lean surface
  // costs schema chars without costing capability.
  handlers[name] = fn;
  schemas[name] = z.object(meta.inputSchema);
  if (!advertised(name)) return;
  server.registerTool(name, meta, async (args: any) => {
    const argObj = (args ?? {}) as Record<string, unknown>;
    // Identical call, unchanged file and index? The body is already in the
    // transcript; point at it rather than paying for it twice. Fails open.
    const repeat = await checkRepeat(ROOT, name, argObj);
    if (repeat.notice) {
      void record(ROOT, name, repeat.notice.length, false);
      void journalRecord(ROOT, name, args);
      return text(repeat.notice);
    }

    let out: string;
    let failed = false;
    try {
      out = await fn(argObj);
    } catch (e) {
      out = `Err: ${(e as Error).message}`; // terse: model doesn't debug our server
      failed = true;
    }
    if (!failed) repeat.remember?.(out);
    // `batch` accounts for itself: it records each sub-call under that tool's own
    // name plus its own envelope, so stats can answer "which tool produced my
    // context". Recording here too would double-count the same chars.
    if (name !== "batch") void record(ROOT, name, out.length, failed);
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
      "Build or refresh the persistent code index (symbols + imports). Only files whose mtime changed are re-parsed, so " +
      "re-run it liberally, like `git fetch`, before trusting a search. Honors <root>/.slimdex.json " +
      "(ignoreDirs/extensions/exclude/maxFileBytes) and reports config problems instead of ignoring them.",
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
      (r.truncated ? `  truncated(symbol cap): ${r.truncated}` : "") +
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
      "Copy every uncommitted file into .slimdex/snapshots/<timestamp>/ as insurance against accidental resets. Also " +
      "runs automatically (at most hourly) when index_repo sees a dirty tree; newest 10 kept. Defeats a stray " +
      "`git checkout .`; does NOT replace committing.",
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
    const abs = await safeResolve(p);
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
    const abs = await safeResolve(p);
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
    if (pathPrefix) files = files.filter((f) => underPrefix(f, pathPrefix));

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

    const { matches, total, exact, timedOut } = await searchFiles(ROOT, files, pattern, {
      regex,
      ignoreCase,
      highlight,
      maxMatches: lim,
      offset: start,
    });
    // A pattern that backtracks catastrophically shows up here, not as a hang.
    const slowNote = timedOut
      ? `\n⚠ Scan stopped at the time budget; results are partial. A regex with nested quantifiers ` +
        `(e.g. "(a+)+") can backtrack exponentially — simplify the pattern, or scope it with pathPrefix.`
      : "";
    const hasMore = total > start + matches.length;
    const next = hasMore ? `\nnext cursor: ${encodeCursor(start + lim, index.builtAt)}` : "";
    const totalStr = exact ? `${total}` : `${total}+ (scan cap reached)`;
    // A silent 0 is the recurring trap: a regex pattern used in the (default)
    // literal mode matches nothing, which reads like an indexing gap and sends
    // the agent off to grep with the wrong lesson. Name the two real causes.
    let zeroHint = "";
    if (matches.length === 0 && !cursor) {
      zeroHint = !regex && /[|()\[\]{}.*+?^$\\]/.test(pattern)
        ? `\n  Note: "${pattern}" contains regex characters but regex mode is OFF (search_code is literal by default). Retry with regex:true for alternation/wildcards, or use find_definition/find_references for a symbol name.`
        : `\n  Note: searched ${files.length} indexed file(s). If the file is new or just changed, run index_repo; for a symbol name, find_definition/find_references is sharper than text search.`;
    }
    return `${t(`${matches.length} of ${totalStr} match(es)`, `${matches.length}/${totalStr}`)}${staleNote}\n${formatMatches(matches)}${next}${zeroHint}${slowNote}`;
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
    if (!query.trim()) return "query must contain at least one non-whitespace character.";
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
      if (pathPrefix && !underPrefix(file, pathPrefix)) continue;
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
      terse() ? `  ${h.file}:${h.line}:${h.col} ${h.kind} ${h.name}` : `  ${h.file}:${h.line}:${h.col}  ${h.kind.padEnd(9)} ${h.name}`
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
    if (pathPrefix) files = files.filter((f) => underPrefix(f, pathPrefix));
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
      "Which references to a symbol live in TEST files: 'if I change calculateTax, which tests catch a break' — run " +
      "exactly those, not the whole suite. Nothing covering it is surfaced as risk BEFORE you edit. Detected by path " +
      "convention (*.test.*, *.spec.*, __tests__/, test_*.py …) or an indexed describe/it title. Textual, so same caveat " +
      "as find_references.",
    inputSchema: {
      name: z.string(),
      pathPrefix: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
  },
  async ({ name, pathPrefix, limit }) => {
    const index = await loadIndex(ROOT);
    let files = Object.keys(index.files);
    if (pathPrefix) files = files.filter((f) => underPrefix(f, pathPrefix));
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
      "Know WHAT the code does but not its name: a words query ranked over every indexed symbol by BM25 on tokenized " +
      "names (camelCase/snake_case), kinds and filenames — 'validate user email' surfaces validateEmail / emailValidator. " +
      "Matches WORDING, not meaning. Exact/partial name → search_symbols; literal string → search_code.",
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
      "Understand a whole topic in ONE call instead of ~10: give a natural-language query ('how does auth work') and " +
      "slimdex runs the exploration itself — BM25-ranks the symbols, shows how their files connect (import graph, one " +
      "hop), includes the top few bodies, all under a char budget. Saves the round-trips AND keeps ten separate results " +
      "out of the transcript. Orient with this; drop to get_symbol_context / read_lines for exact source.",
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
      pathPrefix: z
        .string()
        .optional()
        .describe("Restrict name resolution to files under this prefix — disambiguates a duplicated name in ONE call."),
      before: z.number().int().min(0).max(20).optional(),
      after: z.number().int().min(0).max(20).optional(),
      maxLines: z.number().int().min(1).max(2000).optional().describe("Cap each returned span (default 200); tail elided with a notice."),
    },
  },
  async ({ name, names, path: p, line, pathPrefix, before, after, maxLines }) => {
    const index = await loadIndex(ROOT);

    const one = async (sym: string | undefined, fp: string | undefined, ln: number | undefined): Promise<string> => {
      let file: string, defLine: number, kind = "symbol";
      if (fp && ln) {
        file = toPosix(path.relative(ROOT, await safeResolve(fp)));
        defLine = ln;
      } else if (sym) {
        let found: { file: string; line: number; kind: string }[] = [];
        for (const [f, entry] of Object.entries(index.files))
          for (const s of entry.symbols) if (s.name === sym) found.push({ file: f, line: s.line, kind: s.kind });
        if (found.length === 0) return `No definition indexed for "${sym}". Run index_repo, or pass path + line explicitly.`;
        // Narrowing here rather than making the caller round-trip: an ambiguous
        // name used to cost a rejection plus a second, line-addressed call.
        if (pathPrefix) {
          const scoped = found.filter((d) => underPrefix(d.file, pathPrefix));
          if (scoped.length === 0)
            return (
              `"${sym}" is indexed, but not under "${pathPrefix}". Found in:\n` +
              found.map((d) => `  ${d.file}:${d.line}  ${d.kind}`).join("\n")
            );
          found = scoped;
        }
        if (found.length > 1)
          return (
            `"${sym}" has ${found.length} definitions — narrow with pathPrefix, or pass path + line to pick one:\n` +
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
      "Overwrite a symbol's full definition, addressed by NAME — you never re-send the old body to locate the edit. The " +
      "range comes from the index; the file is SNAPSHOTTED first (.slimdex/snapshots), re-indexed after, and the new line " +
      "span is reported so you don't re-read to verify. Ambiguous/unknown names are refused, never guessed. `body` = the " +
      "complete replacement definition, indented for the file. `edits:[…]` applies several at once (one snapshot, one " +
      "re-index); the batch is refused before any write if a target is ambiguous, two edits overlap, or a file isn't " +
      "writable, and a write that fails mid-batch rolls the earlier files back and says so.",
    inputSchema: {
      name: z.string().optional().describe("Symbol to replace, resolved via the index."),
      path: z.string().optional().describe("File path (use with line instead of name)."),
      line: z.number().int().min(1).optional().describe("Definition line (use with path)."),
      body: z.string().optional().describe("The complete new definition, replacing the old one verbatim."),
      edits: z
        .array(
          z.object({
            name: z.string().optional(),
            path: z.string().optional(),
            line: z.number().int().min(1).optional(),
            body: z.string(),
          })
        )
        .min(1)
        .max(20)
        .optional()
        .describe("Several replacements, applied atomically. Each entry takes name, or path+line, plus body."),
    },
  },
  async ({ name, path: p, line, body, edits }) => {
    // Resolve one edit target to a repo-relative file + definition line, or a
    // refusal string. Shared by both paths so a batch cannot resolve targets by
    // looser rules than a single edit does.
    type Target = { file: string; defLine: number; label: string };
    const resolve = async (
      index: CodeIndex,
      spec: { name?: string; path?: string; line?: number }
    ): Promise<Target | string> => {
      if (spec.path && spec.line) {
        let abs: string;
        try {
          abs = await safeResolve(spec.path);
        } catch {
          return `Cannot resolve ${spec.path} (does it exist?).`;
        }
        const file = toPosix(path.relative(ROOT, abs));
        const entry = index.files[file];
        if (entry && (await changedSinceIndex(file, entry)))
          return `${file} changed since index_repo — re-index before replacing it.`;
        return { file, defLine: spec.line, label: `${file}:${spec.line}` };
      }
      if (spec.name) {
        const found: { file: string; line: number }[] = [];
        for (const [f, entry] of Object.entries(index.files))
          for (const s of entry.symbols) if (s.name === spec.name) found.push({ file: f, line: s.line });
        if (found.length === 0) return `No definition indexed for "${spec.name}". Run index_repo, or pass path + line.`;
        if (found.length > 1)
          return (
            `"${spec.name}" has ${found.length} definitions — pass path + line to pick one, I won't guess which to overwrite:\n` +
            found.map((d) => `  ${d.file}:${d.line}`).join("\n")
          );
        const target = found[0];
        if (await changedSinceIndex(target.file, index.files[target.file]))
          return `${target.file} changed since index_repo — re-index before replacing "${spec.name}".`;
        return { file: target.file, defLine: target.line, label: spec.name };
      }
      return "Provide either name, or path + line, plus body.";
    };

    if (edits?.length) return replaceMany(edits, resolve);

    if (typeof body !== "string" || !body.length) return "body (the complete replacement definition) is required.";
    const index = await loadIndex(ROOT);
    const target = await resolve(index, { name, path: p, line });
    if (typeof target === "string") return target;
    const { file, defLine } = target;

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
    invalidateFileCache(abs);
    // Re-index (mtime changed -> only this file re-parses) so the new span is
    // queryable immediately and the reported line numbers are the real ones.
    //
    // The write already happened. If re-indexing throws, letting that propagate
    // would surface a bare "Err: …" and the agent would reasonably conclude the
    // edit did not land — then redo it, on top of an edit that IS on disk. So
    // report the write as the fact it is, and the index as the part that failed.
    let indexErr: string | null = null;
    try {
      await buildOrRefresh(ROOT, false);
    } catch (e) {
      indexErr = (e as Error).message;
    }
    const fresh = await loadIndex(ROOT);
    const stillThere = (fresh.files[file]?.symbols ?? []).some((s) => s.line >= res.oldStart && s.line <= res.newEnd);
    const snapNote = snap.files > 0 ? `snapshot saved (${snap.dir})` : "snapshot skipped (file too large or unreadable)";
    const parseNote = indexErr
      ? `⚠ THE FILE WAS WRITTEN, but re-indexing failed (${indexErr}) — do NOT re-apply this edit; run index_repo`
      : stillThere
        ? "re-indexed, a symbol is present in the new range"
        : "⚠ re-indexed but no symbol parsed in the new range — check the body is a valid declaration";
    return (
      `Replaced ${name ?? `${file}:${defLine}`}: lines ${res.oldStart}-${res.oldEnd} → ${res.oldStart}-${res.newEnd} ` +
      `(${res.newEnd - res.oldStart + 1} line(s)). ${snapNote}; ${parseNote}.`
    );
  }
);

/**
 * The batched write path. Resolves every target BEFORE touching disk, refuses
 * the whole batch on any unresolvable name or overlapping pair, then performs
 * exactly one write per file and one re-index for the lot.
 *
 * On atomicity, precisely: a half-applied refactor is the worst state to hand
 * back to an agent, because it has to re-read everything to learn what landed.
 * Within one file the write is atomic — the new text is composed in memory and
 * written once. ACROSS files it cannot be, since there is no cross-file commit
 * on a filesystem. Three things narrow that window instead of pretending it
 * isn't there:
 *
 *   1. Pre-flight: every target is checked writable before the first byte is
 *      written, so the common failure (a read-only or locked file) refuses the
 *      batch while the tree is still untouched.
 *   2. Rollback: the original bytes of every file are already in memory, so a
 *      mid-batch failure restores the files that were written.
 *   3. Honest reporting: if a rollback itself fails, the response names exactly
 *      which files are in which state and points at the snapshot. It never
 *      claims "nothing was written" unless nothing was.
 */
async function replaceMany(
  edits: { name?: string; path?: string; line?: number; body: string }[],
  resolve: (index: CodeIndex, spec: { name?: string; path?: string; line?: number }) => Promise<{ file: string; defLine: number; label: string } | string>
): Promise<string> {
  const index = await loadIndex(ROOT);

  const byFile = new Map<string, PlannedEdit[]>();
  const refusals: string[] = [];
  for (const [i, e] of edits.entries()) {
    if (typeof e.body !== "string" || !e.body.length) {
      refusals.push(`edit ${i + 1}: body is required.`);
      continue;
    }
    const target = await resolve(index, e);
    if (typeof target === "string") {
      refusals.push(`edit ${i + 1}: ${target}`);
      continue;
    }
    const list = byFile.get(target.file) ?? [];
    list.push({ defLine: target.defLine, body: e.body, label: target.label });
    byFile.set(target.file, list);
  }
  if (refusals.length)
    return `Refused ${refusals.length} of ${edits.length} edit(s) — nothing was written:\n${refusals.map((r) => "  " + r).join("\n")}`;

  // Compute every new file text first. An overlap or out-of-range line throws
  // here, before any write, so the batch is still all-or-nothing.
  const pending: {
    file: string;
    abs: string;
    text: string;
    source: string; // original bytes, kept for rollback
    applied: ReturnType<typeof spliceSymbols>["applied"];
  }[] = [];
  for (const [file, list] of byFile) {
    const abs = path.join(ROOT, file);
    let source: string;
    try {
      source = await readFileCached(abs);
    } catch {
      return `Cannot read ${file} — nothing was written.`;
    }
    try {
      const res = spliceSymbols(source, list);
      pending.push({ file, abs, text: res.text, source, applied: res.applied });
    } catch (e) {
      return `${file}: ${(e as Error).message} — nothing was written.`;
    }
  }

  // Pre-flight every target for writability. A read-only file, a lock held by
  // another process, a vanished directory — catching those here means the
  // common causes of a partial batch refuse it while the tree is untouched.
  const unwritable: string[] = [];
  for (const p of pending) {
    try {
      await fs.access(p.abs, fsConstants.W_OK);
    } catch {
      unwritable.push(p.file);
    }
  }
  if (unwritable.length)
    return `Not writable: ${unwritable.join(", ")} — nothing was written. Check permissions or another process holding the file.`;

  // One snapshot covering every file the batch touches, then the writes.
  const snap = await takeSnapshot(ROOT, pending.map((p) => p.file));
  const written: typeof pending = [];
  for (const p of pending) {
    try {
      await fs.writeFile(p.abs, p.text, "utf8");
      invalidateFileCache(p.abs);
      written.push(p);
    } catch (e) {
      // Mid-batch failure. Restore what we already wrote from the originals in
      // memory, then report precisely — including any file we could NOT put
      // back, which is the only state where the snapshot is the real recourse.
      const restoreFailed: string[] = [];
      for (const done of written) {
        try {
          await fs.writeFile(done.abs, done.source, "utf8");
          invalidateFileCache(done.abs);
        } catch {
          restoreFailed.push(done.file);
        }
      }
      await buildOrRefresh(ROOT, false);
      const base = `Write failed on ${p.file}: ${(e as Error).message}.`;
      if (restoreFailed.length)
        return (
          `${base} Rolled back ${written.length - restoreFailed.length} file(s), but COULD NOT restore: ` +
          `${restoreFailed.join(", ")} — those hold the new content. Pre-edit copies are in ${snap.dir}.`
        );
      return `${base} Rolled back ${written.length} already-written file(s); the tree is as it was.`;
    }
  }
  // Every write landed. A re-index failure from here on must NOT read as "the
  // batch failed" — the edits are on disk, and an agent that retries them would
  // be editing already-edited files.
  let indexErr: string | null = null;
  try {
    await buildOrRefresh(ROOT, false);
  } catch (e) {
    indexErr = (e as Error).message;
  }
  const fresh = await loadIndex(ROOT);

  const lines: string[] = [];
  let warnings = 0;
  for (const p of pending) {
    for (const a of p.applied) {
      const parsed = (fresh.files[p.file]?.symbols ?? []).some((s) => s.line >= a.newStart && s.line <= a.newEnd);
      if (!parsed) warnings++;
      lines.push(
        `  ${p.file}: ${a.label} lines ${a.oldStart}-${a.oldEnd} → ${a.newStart}-${a.newEnd}` +
          (parsed ? "" : " ⚠ no symbol parsed in the new range — check the body is a valid declaration")
      );
    }
  }
  const snapNote = snap.files > 0 ? `snapshot saved (${snap.dir})` : "snapshot skipped (files too large or unreadable)";
  const total = pending.reduce((n, p) => n + p.applied.length, 0);
  return (
    `Applied ${total} edit(s) across ${pending.length} file(s)` +
    (indexErr ? `. ⚠ ALL WRITES LANDED, but re-indexing failed (${indexErr}) — do NOT re-apply; run index_repo` : ", re-indexed once") +
    `. ${snapNote}.` +
    (warnings ? ` ⚠ ${warnings} edit(s) parsed no symbol.` : "") +
    `\n${lines.join("\n")}`
  );
}

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
    const abs = await safeResolve(p);
    const rel = toPosix(path.relative(ROOT, abs));
    const index = await loadIndex(ROOT);
    const entry = index.files[rel];
    if (!entry) return `${rel} is not indexed — run index_repo (or check the path).`;
    const src = await readFileCached(abs);
    const skel = fileSkeleton(src, entry);
    const truncation = entry.symbolsTruncated
      ? "\n⚠ Symbol index truncated at 2000 declarations; this skeleton is partial."
      : "";
    return `${rel} skeleton (${entry.lines} lines, ${entry.symbols.length} symbols):${truncation}\n${skel || "  (no declarations detected)"}`;
  }
);

tool(
  "get_context",
  {
    title: "One-shot context brief for a symbol",
    description:
      "ONE call for what would take several: definition, signature, callers/references (attributed to their enclosing " +
      "symbol — heuristic), imports, dependents. Sections are OPT-IN via `include` (default definition,signature," +
      "callers,imports); add 'body' for full source, 'dependents' for reverse deps. Bounded by callerLimit and maxChars " +
      "with explicit truncation.",
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
          terse()
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
        terse()
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
      "Query the internal import graph. mode=imports: what a file imports. mode=dependents: what imports it. " +
      "mode=mermaid: a diagram — pass root (+depth, default 2) to walk outward from one file instead of dumping the " +
      "whole graph, or scope to a path prefix. Run before refactoring a shared module.",
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
      "Use it to see which tool is actually producing your context, and to tune limits. Counters are CUMULATIVE " +
      "across every session on this repo until reset; pass session:true for what the current run alone cost.",
    inputSchema: {
      reset: z.boolean().optional().describe("Clear the counters instead of reporting them."),
      session: z
        .boolean()
        .optional()
        .describe("Report only what this server process has recorded, not the repo's all-time totals."),
    },
  },
  async ({ reset, session }) => {
    if (reset) {
      await resetStats(ROOT);
      return "Stats reset.";
    }
    if (session) {
      const s = await loadSessionStats(ROOT);
      if (!Object.keys(s.tools).length) return "No tool calls recorded yet in this session.";
      return `THIS SESSION only (since ${s.since}):\n${formatStats(s)}`;
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
    // A fact is read back in preview form in every session opener, so an
    // unbounded body becomes a permanent tax. Refuse a runaway paste outright;
    // warn (never truncate) on a merely long one — silently dropping half of a
    // conclusion the agent just confirmed would be far worse than a long fact.
    if (typeof t !== "string" || !t.trim()) return "text (the conclusion to remember) is required.";
    if (t.length > HARD_MAX_FACT_CHARS)
      return (
        `Refused: ${t.length} chars is not a fact, it's a document (limit ${HARD_MAX_FACT_CHARS}). ` +
        `Save the conclusion, not the evidence — or use digest_save for an architecture write-up.`
      );
    // Decision provenance: what the agent was looking at when it concluded this.
    // Best-effort — a memory must save even if the journal is empty/unreadable.
    // Gathered BEFORE taking the lock so it can't lengthen the critical section.
    const context = await recentHints(ROOT, 8);
    const fact: MemoryFact = {
      id: randomUUID().slice(0, 8),
      text: t,
      tags: tags ?? [],
      created: new Date().toISOString(),
      ...(context ? { context } : {}),
    };
    // load → mutate → save as one serialized cycle: two overlapping saves used
    // to read the same array, and the second write erased the first fact.
    await updateMemory(ROOT, (mem) => {
      mem.facts.push(fact);
    });
    const long =
      t.length > SOFT_MAX_FACT_CHARS
        ? ` (${t.length} chars — long for one fact; future sessions see the first ${PREVIEW_CHARS}, so lead with the conclusion, and prefer several focused facts over one omnibus)`
        : "";
    return `Saved memory ${fact.id}${fact.tags.length ? " [" + fact.tags.join(", ") + "]" : ""}.${long}`;
  }
);

tool(
  "memory_search",
  {
    title: "Search saved memory",
    description: "Find saved memory facts by substring and/or tag. Previews by default; memory_get expands one by id.",
    inputSchema: {
      query: z.string().optional(),
      tag: z.string().optional(),
      full: z.boolean().optional().describe("Whole bodies instead of previews."),
    },
  },
  async ({ query, tag, full }) => {
    const mem = await loadMemory(ROOT);
    const q = (query ?? "").toLowerCase();
    const hits = mem.facts.filter((f) => (!q || f.text.toLowerCase().includes(q)) && (!tag || f.tags.includes(tag)));
    if (!hits.length) return "No matching memory.";
    return formatFactList([...hits].reverse(), {
      full,
      previewChars: SEARCH_PREVIEW_CHARS,
      expandHint: "… previews; memory_get ids:[…] for full text.",
    });
  }
);

tool(
  "recap",
  {
    title: "What previous sessions did (automatic)",
    description:
      "Prior activity from the server's own tool-call journal — most-examined files, most-looked-up symbols, recent " +
      "searches. Needs NO prior memory_save; works even when the last session saved nothing. recap = where sessions " +
      "looked, memory = what they concluded. Normally use brief (folds both in); reach here for the raw journal.",
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
      "CALL THIS FIRST in a fresh chat. One synthesized opener instead of stitching memory_list + recap yourself: what " +
      "the repo is, where recent sessions were digging (automatic journal), and each saved conclusion CHECKED against the " +
      "current index so stale ones are flagged (✓ live, ⚠ may be stale).",
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
    //
    // Batched rather than one `await` per file: these are thousands of
    // independent stat() calls, and brief is the FIRST call of every session,
    // so the serial version put its latency directly in front of the user.
    const entries = Object.entries(index.files);
    let staleCount = 0;
    const STAT_BATCH = 64;
    for (let i = 0; i < entries.length; i += STAT_BATCH) {
      const flags = await Promise.all(entries.slice(i, i + STAT_BATCH).map(([f, e]) => isStale(ROOT, f, e.mtimeMs)));
      staleCount += flags.filter(Boolean).length;
    }
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
      "Store a compact 'how this repo works' cheat-sheet — modules, flows, entry points, conventions — so future " +
      "sessions read a page instead of re-exploring. `covers` (the paths it summarizes) lets later sessions be told when " +
      "a covered file changed. Overwrites the previous one. Save the why and the shape, not a symbol list.",
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
      "Return the stored architecture cheat-sheet plus a freshness verdict: covered files that changed since it was " +
      "written are flagged as reasons it may be out of date. Read it early to understand the system without re-exploring; " +
      "if flagged stale, re-read the changed areas and digest_save an update.",
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
    description:
      "Saved facts newest-first as PREVIEWS (id, date, tags, opening clause); memory_get ids:[…] expands the ones that " +
      "matter, full:true dumps everything. Prefer brief as the opener — same previews, staleness-checked.",
    inputSchema: {
      limit: z.number().int().min(1).max(1000).optional().describe("Max facts (default 50)."),
      full: z.boolean().optional().describe("Whole bodies instead of previews — costly on a large store."),
    },
  },
  async ({ limit, full }) => {
    const mem = await loadMemory(ROOT);
    if (!mem.facts.length) return "No memory saved yet.";
    const lim = limit ?? 50;
    // Newest first: recent decisions supersede old ones, so they should be the
    // first thing a fresh session reads — and the part that survives a cap.
    const shown = [...mem.facts].reverse().slice(0, lim);
    const body = formatFactList(shown, { full, expandHint: "… previews; memory_get ids:[…] for full text." });
    const more = mem.facts.length > lim ? `\n… ${mem.facts.length - lim} older fact(s); raise limit or memory_search.` : "";
    return body + more;
  }
);

tool(
  "memory_get",
  {
    title: "Read saved facts in full",
    description:
      "Full text of specific facts by id, with the provenance note of what was being examined when each was saved. The " +
      "expansion half of the preview model: triage cheaply with brief/memory_list, expand only what you need.",
    inputSchema: { ids: z.array(z.string()).min(1).max(20).describe("Fact ids from memory_list/brief/memory_search.") },
  },
  async ({ ids }) => {
    const mem = await loadMemory(ROOT);
    const out: string[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const f = mem.facts.find((x) => x.id === id);
      if (f) out.push(factFull(f));
      else missing.push(id);
    }
    if (!out.length) return `No memory with id ${missing.join(", ")}. memory_list shows current ids.`;
    const miss = missing.length ? `\n(no such id: ${missing.join(", ")})` : "";
    return out.join("\n\n") + miss;
  }
);

tool(
  "memory_delete",
  { title: "Delete a memory fact", description: "Remove one saved memory fact by its id.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    // Same serialized cycle as memory_save: a delete racing a save would
    // otherwise write back a fact list that never existed.
    const removed = await updateMemory(ROOT, (mem) => {
      const before = mem.facts.length;
      mem.facts = mem.facts.filter((f) => f.id !== id);
      return before !== mem.facts.length;
    });
    return removed ? `Deleted memory ${id}.` : `No memory with id ${id}.`;
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
    // Per-sub-tool accounting. Without this, every char a batch returns is filed
    // under "batch", so a session where batch is the biggest output source says
    // nothing about WHICH tool to rein in — and the follow-through line
    // (skeletons vs narrow reads) misses anything routed through batch entirely.
    let subChars = 0;
    for (const c of calls as { tool: string; args?: any }[]) {
      if (c.tool === "batch" || !handlers[c.tool]) {
        parts.push(`### ${c.tool}\nErr: unknown or non-batchable tool`);
        continue;
      }
      try {
        // Sub-calls get repeat suppression too. Without this, the same read
        // routed through batch pays in full while the direct call does not —
        // and batch is the documented way to reach a hidden tool under a lean
        // surface, so the bypass would land exactly where it hurts most.
        const parsed = schemas[c.tool].safeParse(c.args ?? {});
        if (!parsed.success) {
          const issue = parsed.error.issues.map((x) => `${x.path.join(".") || "args"}: ${x.message}`).join("; ");
          throw new Error(`invalid arguments: ${issue}`);
        }
        const args = parsed.data;
        const repeat = await checkRepeat(ROOT, c.tool, args);
        const body = repeat.notice ?? (await handlers[c.tool](args));
        if (!repeat.notice) repeat.remember?.(body);
        parts.push(`### ${c.tool} ${JSON.stringify(args)}\n${body}`);
        subChars += body.length;
        void record(ROOT, c.tool, body.length, false);
        void journalRecord(ROOT, c.tool, c.args); // sub-calls leave breadcrumbs too
      } catch (e) {
        const err = `Err: ${(e as Error).message}`;
        parts.push(`### ${c.tool}\n${err}`);
        subChars += err.length;
        void record(ROOT, c.tool, err.length, true);
      }
    }
    const out = parts.join("\n\n");
    // The batch row is now just the envelope (the `### tool {args}` headers and
    // separators), so TOTAL still adds up and no chars are counted twice.
    void record(ROOT, "batch", Math.max(0, out.length - subChars), false);
    return out;
  }
);

// ---------------------------------------------------------------------------
/**
 * Durable shutdown.
 *
 * The journal and the stats counters are both written on a DEBOUNCED, UNREF'd
 * timer (300ms and 1.5s). Unref'd means Node is explicitly told not to stay
 * alive for them, so when the stdio transport closed — the normal way a session
 * ends — whatever happened in that last window was silently dropped. The last
 * thing a session records is the part it most wants to keep, and it was exactly
 * the part being lost.
 *
 * Flushes are synchronous because an exit handler cannot await a promise, and
 * idempotent because several of these paths can fire for one shutdown.
 */
let alreadyFlushed = false;
function flushAllSync(): void {
  if (alreadyFlushed) return;
  alreadyFlushed = true;
  flushJournalSync(ROOT);
  flushStatsSync(ROOT);
}

function installShutdownHooks(transport: StdioServerTransport): void {
  process.on("exit", flushAllSync);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    // Adding a listener replaces Node's default terminate-immediately handling,
    // so the explicit exit below is what still ends the process.
    process.on(sig, () => {
      flushAllSync();
      process.exit(0);
    });
  }
  // The transport closing is the case actually reported in the field. Chain
  // rather than assign: `server.connect` installs its own onclose, and dropping
  // that would break the SDK's cleanup.
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    flushAllSync();
    sdkOnClose?.();
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  installShutdownHooks(transport);
  const advertisedCount = profile() === "lean" ? LEAN_TOOLS.size : Object.keys(handlers).length;
  const surface =
    profile() === "lean"
      ? `tools=${advertisedCount} advertised (lean profile; ${Object.keys(handlers).length} total, all reachable via batch)`
      : `tools=${Object.keys(handlers).length}`;
  console.error(`slimdex-mcp v0.9.0 ready. root=${ROOT}  ${surface}`);
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
