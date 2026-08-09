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
import { promises as fs, constants as fsConstants, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { outline, formatOutline } from "./outline.js";
import { buildOrRefresh, toPosix, underPrefix, containmentError } from "./indexer.js";
import { searchFiles, formatMatches, encodeCursor, decodeCursor } from "./search.js";
import { buildGraph, dependents, toMermaid, nameRefEdges, mergeEdges } from "./graph.js";
import { fileSkeleton, getSymbolContext, buildContext, enclosingSymbol } from "./intel.js";
import { changedFiles, formatChanged, isGitRepo } from "./git.js";
import {
  loadStats,
  loadSessionStats,
  checkpointStats,
  formatStats,
  loadBypass,
  record,
  resetStats,
  flushStatsSync,
  recordSlimdexWrite,
  recordExternalEdits,
} from "./stats.js";
import { loadIndex, loadMemory, updateMemory, loadDigest, saveDigest, type MemoryFact, type DigestStore, type CodeIndex } from "./store.js";
import { invalidateFileCache, readFileCached } from "./fscache.js";
import { journalRecord, formatRecap, recentHints, flushJournalSync } from "./journal.js";
import { takeSnapshot, newestSnapshotAgeMs } from "./snapshot.js";
import { isTestFile } from "./testlink.js";
import { spliceSymbol, spliceSymbols, insertAtSymbol, type PlannedEdit } from "./edit.js";
import { composeBrief } from "./brief.js";
import { rankIntentDetailed } from "./intent.js";
import { isStale, stalenessNote } from "./freshness.js";
import { buildPack } from "./pack.js";
import { staleCovered, formatDigest } from "./digest.js";
import { hookState, hookNote, runInstaller, type Scope } from "./hookstate.js";
import { terse, t, fileHeader, countNotice, truncNotice } from "./terse.js";
import { factFull, formatFactList, PREVIEW_CHARS, SEARCH_PREVIEW_CHARS, SOFT_MAX_FACT_CHARS, HARD_MAX_FACT_CHARS } from "./memfmt.js";
import { checkRepeat } from "./dedupe.js";
import { advertised, profile, leanNote, LEAN_TOOLS } from "./profile.js";

const ROOT = path.resolve(process.env.SLIMDEX_ROOT || process.argv[2] || process.cwd());

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

export const SERVER_VERSION = "1.0.0";

/**
 * Which build is actually answering you.
 *
 * An MCP server is long-lived: it is started once and then serves every chat
 * until something restarts it. So a fix can be written, compiled and committed
 * while the process in front of you is still running yesterday's code — and
 * from inside a session there was NO way to tell "the fix is broken" from
 * "you're talking to an old process". That cost a real re-verification: three
 * servers were live, all started before the build they were being tested
 * against, and a fixed lookup looked broken.
 *
 * Reporting the running file's mtime alongside the version makes the
 * difference visible without leaving the session — compare it against when you
 * built, and a mismatch means restart, not debug.
 */
function buildStamp(): string {
  try {
    const self = fileURLToPath(import.meta.url);
    const built = statSync(self).mtime.toISOString().replace("T", " ").slice(0, 19);
    return `v${SERVER_VERSION}, build ${built}Z`;
  } catch {
    return `v${SERVER_VERSION}, build unknown`;
  }
}

// Resolve a user-supplied path (relative or absolute) and refuse to escape ROOT.
async function safeResolve(p: string): Promise<string> {
  const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
  // One shared guard (lexical + realpath), so this check and dedupe's cannot
  // drift into different halves of the same rule.
  const bad = await containmentError(ROOT, abs);
  if (bad) throw new Error(`${bad}: ${p}`);
  return abs;
}

/**
 * Print at most `max` candidate sites, then say how many were withheld.
 *
 * An "ambiguous name" refusal is meant to cost less than the work it prevents.
 * These listings were unbounded, so on a large repo the refusal was the most
 * expensive thing in the session: on Elasticsearch (31k files, 316k symbols) one
 * get_symbol_context answered with 96,835 characters of candidates — a wall the
 * caller cannot act on, re-paid on every later turn. Ten sites are enough to
 * pick from or to prove the name is hopeless; the exact total still gets stated.
 */
function candidateList(sites: string[], max = 10): string {
  const head = sites.slice(0, max).join("\n");
  return sites.length > max ? `${head}\n  … ${sites.length - max} more (scope with pathPrefix)` : head;
}

/**
 * Definitions that existed inside the replaced span and do not exist inside the
 * span that replaced it.
 *
 * This is the one safety property a generic edit tool has that replace_symbol
 * did not. Handing over `old_string` is proof you know what you are
 * overwriting; addressing a symbol by name means the old body is never in front
 * of you, so a `body` that quietly omits a nested helper writes a silent
 * deletion — the single failure mode that costs more than the output tokens
 * this tool saves. Reporting it costs one line and removes the last honest
 * reason to prefer re-sending the old code.
 *
 * A rename lands here too (old name gone, new name present). That is worth
 * saying rather than suppressing, so the wording asks rather than accuses.
 */
function droppedSymbols(
  before: readonly { name: string; line: number }[],
  after: readonly { name: string; line: number }[],
  old: { start: number; end: number },
  fresh: { start: number; end: number }
): string[] {
  const lost = new Set<string>();
  for (const s of before) if (s.line >= old.start && s.line <= old.end) lost.add(s.name);
  for (const s of after) if (s.line >= fresh.start && s.line <= fresh.end) lost.delete(s.name);
  return [...lost];
}

/** `; also …` clause for a replace report, or "" when nothing was lost. */
function droppedNote(dropped: string[], max = 8): string {
  if (dropped.length === 0) return "";
  const head = dropped.slice(0, max).join(", ");
  const more = dropped.length > max ? `, … ${dropped.length - max} more` : "";
  return `; ⚠ defined in the old range but not the new one: ${head}${more} (renamed, or dropped from the body?)`;
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
//
// KEEP THIS UNDER INSTRUCTIONS_BUDGET. This block was 5,401 chars and a real
// client delivered 2,072 of them, cutting mid-sentence at rule 9. Everything
// after — all of MEMORY, all of EDITING — silently never arrived. The observed
// effect was an agent that used slimdex as a read-only tool for an entire
// session: dozens of whole-function rewrites sent through a generic edit tool
// (re-sending the old body just to locate it), three hand-rolled line-splices,
// and a build broken by a change find_tests would have flagged in one call.
// None of that was a tool gap. The rules existed; they were off the end of the
// buffer.
//
// So this is written to a budget instead of to completeness, worst case first:
// under the lean profile leanNote() is appended, and the SUM has to fit. Length
// is asserted in test/instructions-budget.test.ts. Adding guidance here means
// removing guidance here — if it doesn't fit, it doesn't ship, because the
// alternative is not "a longer block", it is "a truncated one".
export const INSTRUCTIONS_BUDGET = 2000;
const INSTRUCTIONS = `slimdex answers questions without reading whole files. The discipline IS the saving.

OPEN: call brief FIRST — repo summary, where recent sessions dug, saved conclusions checked against the live index.
FIND: symbol-shaped -> find_definition / find_references / get_context. Behaviour but not the name -> search_intent. Literal strings -> search_code. A whole AREA ("how does auth work") -> context_pack: ONE bounded bundle, not ~10 calls re-costing every turn. Scope with pathPrefix.
READ: get_file_skeleton before opening anything over ~300 lines, then FOLLOW THROUGH — get_symbol_context names:[…] or read_lines for just those spans, never the whole file after.
WRITE — output tokens cost ~4-5x input, so this is where the money is:
 * replace_symbol name:"X" body:"…" rewrites a whole function/class/method WITHOUT re-sending the old code to locate it. Snapshots, re-indexes, reports the new span. Many at once: edits:[{name,body},…]. Never re-emit a file to change a few lines; never splice by line number.
 * find_tests on a symbol BEFORE changing it — run only the covering tests, or SEE that none cover it and treat that as risk.
 * dep_graph root:"<file>" before touching a shared module; changed_files for which symbols a dirty tree lands in.
SAVE: memory_save a conclusion the moment it is confirmed, never "at the end" — unsaved findings die with the tab. Lead with the conclusion; only ~150 chars preview. digest_save an architecture cheat-sheet once you know the shape.
index_repo is incremental — re-run like \`git fetch\` before trusting a search.`;

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
  { name: "slimdex", version: SERVER_VERSION },
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

    // Files whose content moved since the last index, that slimdex did not
    // write, are edits made through some other tool — the only signal available
    // for the write half of `stats`.
    await recordExternalEdits(ROOT, r.changedPaths.length);

    // Symlinks are skipped to keep the walk inside the root, but skipping them
    // SILENTLY turns a pnpm workspace or a linked monorepo package into an
    // empty answer that looks like a complete one. Name them.
    const links = r.skippedLinks ?? [];
    const linkNote = links.length
      ? `\n⚠ ${links.length} symlink(s) not followed, so nothing under them is indexed — ` +
        `${links.slice(0, 5).join(", ")}${links.length > 5 ? `, +${links.length - 5} more` : ""}. ` +
        `Common in pnpm/monorepo layouts: index those packages at their real path, or point SLIMDEX_ROOT at the workspace root.`
      : "";

    return (
      `Indexed ${r.totalFiles} files under ${ROOT}  (slimdex ${buildStamp()})\n` +
      `  parsed: ${r.parsed}  reused(cache): ${r.reused}  removed: ${r.removed}` +
      (r.skipped ? `  skipped(too large): ${r.skipped}` : "") +
      (r.generated ? `  skipped(generated/minified): ${r.generated}` : "") +
      (r.truncated ? `  truncated(symbol cap): ${r.truncated}` : "") +
      `\n  symbols indexed: ${symbols}  parser: ${r.parser}\n` +
      `  config: ${r.config}${warn}\n` +
      `Cache: ${path.join(ROOT, ".slimdex", "index.json")}` +
      linkNote +
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
    // The path is passed so the outliner can pick the right extractor — without
    // it, a stylesheet reported "(no declarations detected)" from this tool
    // while get_file_skeleton mapped the same file in full.
    const rel = toPosix(path.relative(ROOT, abs));
    return formatOutline(rel, outline(src, 400, rel), src.split(/\r?\n/).length);
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

    const opts = { regex, ignoreCase, highlight, maxMatches: lim, offset: start };
    let { matches, total, exact, timedOut } = await searchFiles(ROOT, files, pattern, opts);

    // A zero here is the one result that gets believed and acted on, and it is
    // the one most easily wrong: the file list comes from the INDEX, so a file
    // created or renamed since the last index_repo is never scanned at all. The
    // caller then reads "no matches" as absence, goes looking elsewhere, and
    // pays for the detour — observed in a real session.
    //
    // Refreshing is incremental (mtime-gated), so the cost of being wrong about
    // absence is far higher than the cost of this check. Only on a true zero,
    // never on a paged call, and a failure leaves the original answer standing.
    let refreshNote = "";
    if (total === 0 && !cursor) {
      try {
        await buildOrRefresh(ROOT, false);
        const re = await loadIndex(ROOT);
        if (re.builtAt !== index.builtAt) {
          let reFiles = Object.keys(re.files);
          if (pathPrefix) reFiles = reFiles.filter((f) => underPrefix(f, pathPrefix));
          const again = await searchFiles(ROOT, reFiles, pattern, opts);
          const added = reFiles.length - files.length;
          files = reFiles;
          if (again.total > 0) {
            ({ matches, total, exact, timedOut } = again);
            refreshNote =
              `\n⚠ The first pass found nothing because the index was stale` +
              (added > 0 ? ` (${added} file(s) were missing from it)` : "") +
              `; it was refreshed and re-run. These results are from the fresh index.`;
          } else {
            refreshNote = `\n(index refreshed and re-searched to confirm — still no matches.)`;
          }
        }
      } catch {
        /* keep the original result; a refresh failure must not lose the answer */
      }
    }
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
      const parts: string[] = [`searched ${files.length} indexed file(s)`];
      // A call-shaped pattern ("foo(") is a symbol question wearing text-search
      // clothes, and the symbol tools answer it without the caller guessing at
      // whitespace or argument lists.
      const callShaped = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\($/.exec(pattern)?.[1];
      if (callShaped)
        parts.push(`"${callShaped}" looks like a symbol — find_definition/find_references "${callShaped}" is sharper, and does not depend on the exact spacing before "("`);
      if (!regex && /[|()\[\]{}.*+?^$\\]/.test(pattern)) {
        // The old hint told everyone with a metacharacter to "retry with
        // regex:true". For a pattern like `foo(` that advice does not just miss
        // — it ERRORS ("Unterminated group"), costing a second wasted round trip
        // to learn that literal mode had been right all along. So only suggest
        // regex mode when the pattern would actually compile as one.
        let compiles = true;
        try {
          new RegExp(pattern);
        } catch {
          compiles = false;
        }
        parts.push(
          compiles
            ? `the pattern was matched LITERALLY (regex is off by default) — pass regex:true if you meant it as a pattern`
            : `note "${pattern}" is not a valid regex, so regex:true would fail to compile — literal mode (used here) is the right one for it, and the metacharacters were matched as plain text`
        );
      }
      // Staleness is no longer in this list: a zero now triggers a refresh and a
      // re-search above, so "run index_repo" would be advice for something
      // already done — and telling a caller to redo work it just watched happen
      // is how a hint list stops being read.
      zeroHint = `\n  Note: ${parts.join("; ")}.`;
    }
    // Many hits piled into one big file is the signature of "I am hunting for
    // where a feature lives", and a text search answers that badly — it returns
    // every mention, ranked by nothing, and you read them all. The skeleton
    // answers it in one call. Reported from a session that ran two broad
    // searches on a 6,380-line file, used neither, and afterwards identified the
    // skipped skeleton as the wrong call — the information to say so was right
    // here in the result, unsaid.
    let concentrationHint = "";
    if (matches.length >= 8) {
      const perFile = new Map<string, number>();
      for (const m of matches) perFile.set(m.file, (perFile.get(m.file) ?? 0) + 1);
      const [topFile, topCount] = [...perFile.entries()].sort((a, b2) => b2[1] - a[1])[0];
      const lines = index.files[topFile]?.lines ?? 0;
      if (topCount >= Math.ceil(matches.length * 0.6) && lines >= 300) {
        concentrationHint =
          `\n  Note: ${topCount} of these ${matches.length} hits are in ${topFile} (${lines} lines).` +
          ` If you are looking for WHERE something lives rather than every mention,` +
          ` get_file_skeleton path:"${topFile}" maps it in one call.`;
      }
    }
    return `${t(`${matches.length} of ${totalStr} match(es)`, `${matches.length}/${totalStr}`)}${staleNote}\n${formatMatches(matches)}${next}${refreshNote}${zeroHint}${concentrationHint}${slowNote}`;
  }
);

tool(
  "find_definition",
  {
    title: "Find where a symbol is defined",
    description:
      "Look up a symbol name in the index; return definition site(s) as path:line:col + kind. Heuristic. " +
      "Paged: the total is always exact, `limit`/`offset` control how many are printed, `pathPrefix` scopes them.",
    inputSchema: {
      name: z.string(),
      kind: z.string().optional(),
      pathPrefix: z.string().optional().describe("Only definitions under this path."),
      limit: z.number().int().min(1).max(500).optional().describe("Max sites to print (default 50)."),
      offset: z.number().int().min(0).optional(),
    },
  },
  async ({ name, kind, pathPrefix, limit, offset }) => {
    const index = await loadIndex(ROOT);
    // A CSS rule is indexed under its selector — ".hub-allow-overflow" — but the
    // name you have in hand came from JSX: className="hub-section
    // hub-allow-overflow", with no dots anywhere. So the copy-paste path was the
    // one that failed, into a message telling you to spend a second call on
    // search_symbols. Try the selector forms before declaring a miss.
    const candidates = /^[.#]/.test(name) ? [name] : [name, `.${name}`, `#${name}`];
    const lookup = (idx: CodeIndex): { all: string[]; matchedAs: string } => {
      for (const candidate of candidates) {
        const hits: string[] = [];
        for (const [file, entry] of Object.entries(idx.files)) {
          if (pathPrefix && !underPrefix(file, pathPrefix)) continue;
          for (const s of entry.symbols)
            if (s.name === candidate && (!kind || s.kind === kind)) hits.push(`${file}:${s.line}:${s.col}  ${s.kind} ${s.name}`);
        }
        if (hits.length) return { all: hits, matchedAs: candidate };
      }
      return { all: [], matchedAs: name };
    };

    let { all, matchedAs } = lookup(index);
    // "Not indexed" and "does not exist" are different claims, and this tool
    // answers purely from the index — so a symbol defined since the last
    // index_repo reads as absent. That zero gets believed: the caller stops
    // looking, or re-derives something that already exists. Refresh once and
    // ask again before reporting absence.
    let healedNote = "";
    if (!all.length) {
      try {
        await buildOrRefresh(ROOT, false);
        const re = await loadIndex(ROOT);
        if (re.builtAt !== index.builtAt) {
          const retry = lookup(re);
          if (retry.all.length) {
            all = retry.all;
            matchedAs = retry.matchedAs;
            healedNote = `\n⚠ Not in the index on the first look — it was stale. Refreshed automatically; the result below is current.`;
          }
        }
      } catch {
        /* fall through to the honest miss */
      }
    }
    if (!all.length)
      return `No definition indexed for "${name}" (the index was refreshed and re-checked). Try search_symbols for a fuzzy match.`;
    // Say so when the bare name was resolved as a selector, so the caller learns
    // the indexed form rather than wondering why it worked.
    const resolvedNote = matchedAs === name ? "" : `  (matched as "${matchedAs}")`;
    // This tool had NO limit. Every sibling (search_code, find_references,
    // search_symbols) pages; find_definition returned every hit because "a
    // definition" sounds singular. On Elasticsearch — 31k files, 316k symbols —
    // one lookup answered with 103,102 characters, which then re-costs on every
    // later turn of that session. A cap could not be added by feel either: the
    // failure only exists at a scale where nobody was testing.
    const lim = limit ?? 50;
    const start = offset ?? 0;
    const page = all.slice(start, start + lim);
    const shown = start + page.length;
    const more =
      shown < all.length
        ? `\n… ${all.length - shown} more. Narrow with pathPrefix${kind ? "" : ' or kind:"class"'}, or page with offset:${shown}.`
        : "";
    return (
      `${t(`${all.length} definition candidate(s) for "${name}"`, `${all.length} def(s) "${name}"`)}${resolvedNote}` +
      `${all.length > page.length ? `, showing ${start + 1}-${shown}` : ""}:\n${page.join("\n")}${more}${healedNote}`
    );
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
    const { hits, matched, unmatched } = rankIntentDetailed(index, query, limit ?? 10);
    // Say which words were inert BEFORE the rows, whether or not anything
    // matched: a ranked list reads as an answer, and by the time the reader
    // reaches a footnote they have already started trusting row 1.
    const dead = unmatched.length
      ? `${unmatched.length} of ${matched.length + unmatched.length} query word(s) appear in no symbol here and scored nothing: ${unmatched.join(", ")}.\n`
      : "";
    if (!hits.length)
      return `${dead}No symbol matched the intent "${query}". Try different words, or search_code for a literal string.`;
    const rows = hits.map((h) => `  ${h.file}:${h.line}  ${h.kind} ${h.name}  (${h.score.toFixed(2)})`);
    // One live word means the "ranking" is a single-word name search wearing a
    // score column. Worth saying plainly — that is the shape a too-vague query
    // takes, and it is indistinguishable from a good result by eye.
    const thin =
      matched.length === 1
        ? `\nRanked on "${matched[0]}" alone — this is effectively a one-word name search, not a match on meaning.` +
          ` If you are hunting inside one big file, get_file_skeleton maps it in one call.`
        : "";
    return `${dead}Ranked by intent for "${query}" (BM25 score):\n${rows.join("\n")}${thin}`;
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
    let index = await loadIndex(ROOT);
    // One self-heal per call, shared across a names:[…] batch: a file that is
    // STILL stale after a fresh parse is being written concurrently, and
    // re-parsing in a loop against a moving target returns torn code.
    let staleRetried = false;

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
              candidateList(found.map((d) => `  ${d.file}:${d.line}  ${d.kind}`))
            );
          found = scoped;
        }
        if (found.length > 1)
          return (
            // Only offer pathPrefix when it can actually narrow anything. A CSS
        // selector repeats inside ONE file as a matter of course (base rule
        // plus media overrides), and telling someone to scope by path there is
        // advice with no exit.
        `"${sym}" has ${found.length} definitions — ${
          new Set(found.map((d) => d.file)).size === 1
            ? "all in the same file, so pathPrefix cannot help; pass path + line to pick one"
            : "narrow with pathPrefix, or pass path + line to pick one"
        }:\n` +
            candidateList(found.map((d) => `  ${d.file}:${d.line}  ${d.kind}`))
          );
        file = found[0].file;
        defLine = found[0].line;
        kind = found[0].kind;
      } else {
        return "Provide either name, names, or path + line.";
      }
      // Heal a stale file before reading from it, not after.
      //
      // Warning and then returning the wrong lines anyway is the worst of both:
      // reported from a session that edited a file all turn, asked for a symbol
      // in it, and got a body from an unrelated text block plus a ⚠ — then fell
      // back to grep and concluded that symbol lookups are untrustworthy once
      // you start editing. That conclusion was correct about the behaviour and
      // wrong about the cost of fixing it: re-parsing one file is ~10ms and one
      // file (measured on this repo: parsed 1, reused 70).
      //
      // Only a NAME is re-resolved. An explicit path+line is the caller's own
      // coordinate, computed against state that has since moved, so it keeps the
      // warning and is left alone — the same rule replace_symbol uses.
      if (sym && !fp && !staleRetried && (await changedSinceIndex(file, index.files[file]))) {
        staleRetried = true;
        const stale = index.files[file];
        // Staleness is detected by content hash, which catches an edit that left
        // mtime alone; the incremental build skips on mtime, so without this the
        // re-parse would decline to look at the one file we know is wrong.
        if (stale) stale.mtimeMs = -1;
        invalidateFileCache(path.join(ROOT, file));
        await buildOrRefresh(ROOT, false);
        index = await loadIndex(ROOT);
        return one(sym, fp, ln);
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
      "Write a symbol by NAME — you never re-send the old body to locate the edit. Two modes: REPLACE (name/path+line " +
      "plus body) overwrites an existing definition; INSERT (after:\"X\" or before:\"X\" plus body) adds a NEW symbol " +
      "next to an existing one, which is what you want for 'add a method beside the related ones' — the anchor's own " +
      "span comes from the index, so `after` means after its closing brace, not its signature line. Insert puts `body` " +
      "in verbatim: indent it for the file, and include a leading/trailing newline if you want a blank line. " +
      "range comes from the index; the file is SNAPSHOTTED first (.slimdex/snapshots), re-indexed after, and the new line " +
      "span is reported so you don't re-read to verify. Safe to mix with ordinary edit tools: if the file moved under the " +
      "index, a NAME is re-resolved against a fresh parse automatically (an explicit path+line still refuses, since that " +
      "coordinate is yours). Ambiguous/unknown names are refused, never guessed. `body` = the " +
      "complete replacement definition, indented for the file. `edits:[…]` applies several at once (one snapshot, one " +
      "re-index); the batch is refused before any write if a target is ambiguous, two edits overlap, or a file isn't " +
      "writable, and a write that fails mid-batch rolls the earlier files back and says so.",
    inputSchema: {
      name: z.string().optional().describe("Symbol to replace, resolved via the index."),
      path: z.string().optional().describe("File path (use with line instead of name)."),
      line: z.number().int().min(1).optional().describe("Definition line (use with path)."),
      body: z.string().optional().describe("The complete new definition, replacing the old one verbatim."),
      after: z
        .string()
        .optional()
        .describe("INSERT mode: add `body` as a NEW symbol immediately after this existing symbol's closing brace. Pin which occurrence with path + line when the name repeats inside one file (normal for CSS)."),
      before: z
        .string()
        .optional()
        .describe("INSERT mode: add `body` as a NEW symbol immediately before this existing symbol."),
      pathPrefix: z
        .string()
        .optional()
        .describe("Disambiguate the after/before anchor when the name exists in several files."),
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
  async ({ name, path: p, line, body, after, before, pathPrefix, edits }) => {
    // Resolve one edit target to a repo-relative file + definition line, or a
    // refusal string. Shared by both paths so a batch cannot resolve targets by
    // looser rules than a single edit does.
    type Target = { file: string; defLine: number; label: string };
    // One self-heal per call. A file that is STILL stale after a fresh parse is
    // being written by something else concurrently, and retrying in a loop
    // against a moving target is how you write into a half-saved file.
    let staleRetried = false;
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
            candidateList(found.map((d) => `  ${d.file}:${d.line}`))
          );
        const target = found[0];
        if (await changedSinceIndex(target.file, index.files[target.file])) {
          // The file moved under the index — almost always because the same
          // agent edited it with an ordinary edit tool a moment ago. Refusing
          // here cost a full round-trip (index_repo, then retry) for a problem
          // slimdex can just fix: re-parse that file and look the name up
          // again. Addressing by NAME is what makes this safe — the new range
          // comes from the fresh parse, so a shifted definition is found where
          // it now is, not where it used to be.
          //
          // Explicit path+line still refuses (above): there the caller supplied
          // the coordinate, computed against state that has since changed, and
          // silently retargeting someone else's line number is how you
          // overwrite the wrong function.
          if (staleRetried) return `${target.file} is still changing under the index — re-run index_repo and retry.`;
          staleRetried = true;
          invalidateFileCache(path.join(ROOT, target.file)); // (mtime,size) can miss a same-size edit
          // Staleness was detected by CONTENT HASH, which catches an edit that
          // left mtime alone — but the incremental build skips on mtime, so a
          // plain refresh would decline to re-parse the very file we know is
          // wrong, and the retry would fail identically. Poison the timestamp so
          // this one file re-parses. The entry object stays in place, so the
          // external-edit counter still sees the old hash and records the edit.
          const stale = index.files[target.file];
          if (stale) stale.mtimeMs = -1;
          await buildOrRefresh(ROOT, false);
          return resolve(await loadIndex(ROOT), spec);
        }
        return { file: target.file, defLine: target.line, label: spec.name };
      }
      return "Provide either name, or path + line, plus body.";
    };

    if (edits?.length) return replaceMany(edits, resolve);

    // ---- INSERT mode: a NEW symbol next to an existing anchor ----
    if (after || before) {
      if (after && before) return "Give either after or before, not both.";
      if (name)
        return "after/before is INSERT mode — drop `name` (that replaces an existing symbol) and give only the anchor plus body.";
      if ((p && !line) || (line && !p)) return "path and line go together when pinning an insert anchor.";
      if (typeof body !== "string" || !body.length) return "body (the new definition to insert) is required.";
      return insertBesideSymbol((after ?? before)!, after ? "after" : "before", body, pathPrefix, p, line);
    }

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
    // Captured before the write, while the index still describes the old file:
    // this is what makes "did your body drop a nested definition" answerable.
    const beforeSymbols = index.files[file]?.symbols ?? [];
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
    const freshSymbols = fresh.files[file]?.symbols ?? [];
    const stillThere = freshSymbols.some((s) => s.line >= res.oldStart && s.line <= res.newEnd);
    const dropped = droppedSymbols(
      beforeSymbols,
      freshSymbols,
      { start: res.oldStart, end: res.oldEnd },
      { start: res.oldStart, end: res.newEnd }
    );
    await recordSlimdexWrite(ROOT, 1);
    const snapNote = snap.files > 0 ? `snapshot saved (${snap.dir})` : "snapshot skipped (file too large or unreadable)";
    const parseNote = indexErr
      ? `⚠ THE FILE WAS WRITTEN, but re-indexing failed (${indexErr}) — do NOT re-apply this edit; run index_repo`
      : stillThere
        ? "re-indexed, a symbol is present in the new range"
        : "⚠ re-indexed but no symbol parsed in the new range — check the body is a valid declaration";
    return (
      `Replaced ${name ?? `${file}:${defLine}`}: lines ${res.oldStart}-${res.oldEnd} → ${res.oldStart}-${res.newEnd} ` +
      `(${res.oldEnd - res.oldStart + 1} line(s) removed, ${res.newEnd - res.oldStart + 1} written). ` +
      `${snapNote}; ${parseNote}${droppedNote(dropped)}.`
    );
  }
);

/**
 * INSERT a new symbol beside an existing one.
 *
 * The gap this closes: replace_symbol could only overwrite something that
 * already existed, so "add a method next to the related ones" — one of the
 * most common writes there is — fell back to a generic edit tool and re-sent
 * surrounding code to anchor itself. That is the exact cost this module exists
 * to avoid, and the flagship write tool had no answer for it.
 *
 * Everything else is deliberately identical to the replace path: same anchor
 * resolution, same staleness refusal, same snapshot before writing, same
 * re-index after, same honest reporting when the re-index is what failed.
 */
async function insertBesideSymbol(
  anchor: string,
  position: "before" | "after",
  body: string,
  pathPrefix?: string,
  anchorPath?: string,
  anchorLine?: number
): Promise<string> {
  const index = await loadIndex(ROOT);

  // An explicit path+line pins WHICH occurrence, which pathPrefix cannot do
  // when the duplicates share a file. For a stylesheet that is the normal
  // shape, not an edge case: a base rule plus two media-query overrides means
  // `.swarm-arrow` legitimately appears three times in one file, and the
  // name-only anchor was therefore unusable exactly where CSS support was
  // supposed to help.
  if (anchorPath && anchorLine) {
    let abs: string;
    try {
      abs = await safeResolve(anchorPath);
    } catch {
      return `Cannot resolve ${anchorPath} (does it exist?).`;
    }
    const file = toPosix(path.relative(ROOT, abs));
    const entry = index.files[file];
    if (entry && (await changedSinceIndex(file, entry)))
      return `${file} changed since index_repo — re-index before inserting into it.`;
    return writeInsert(file, anchorLine, `${file}:${anchorLine}`, position, body);
  }

  let found: { file: string; line: number; kind: string }[] = [];
  for (const [f, entry] of Object.entries(index.files))
    for (const s of entry.symbols) if (s.name === anchor) found.push({ file: f, line: s.line, kind: s.kind });
  if (found.length === 0)
    return `No symbol "${anchor}" indexed to anchor against. Run index_repo, or check the name.`;
  if (pathPrefix) {
    const scoped = found.filter((d) => underPrefix(d.file, pathPrefix));
    if (scoped.length === 0)
      return `"${anchor}" is indexed, but not under "${pathPrefix}". Found in:\n` +
        found.map((d) => `  ${d.file}:${d.line}  ${d.kind}`).join("\n");
    found = scoped;
  }
  if (found.length > 1) {
    // Only suggest pathPrefix when it can actually help. Every duplicate in one
    // file — the normal shape of a stylesheet, where a base rule plus media
    // overrides repeat a selector — makes pathPrefix useless, and saying it
    // anyway sends the caller down a road with no exit.
    const sameFile = new Set(found.map((d) => d.file)).size === 1;
    const how = sameFile
      ? `all ${found.length} are in the same file, so pathPrefix cannot help — pin one with path + line`
      : `narrow with pathPrefix, or pin one with path + line`;
    return (
      `"${anchor}" has ${found.length} definitions — ${how}. I won't guess which one to insert beside:\n` +
      found.map((d) => `  ${d.file}:${d.line}  ${d.kind}`).join("\n")
    );
  }

  const { file, line: resolvedLine } = found[0];
  const entry = index.files[file];
  // An anchor whose file has drifted means the line number is a guess, and a
  // guessed insertion point puts a method inside someone else's function body.
  if (entry && (await changedSinceIndex(file, entry)))
    return `${file} changed since index_repo — re-index before inserting into it.`;
  return writeInsert(file, resolvedLine, anchor, position, body);
}

/** The write half, shared by the name-resolved and path+line-pinned anchors. */
async function writeInsert(
  file: string,
  anchorLine: number,
  label: string,
  position: "before" | "after",
  body: string
): Promise<string> {
  const abs = path.join(ROOT, file);
  let source: string;
  try {
    source = await readFileCached(abs);
  } catch {
    return `Cannot read ${file}.`;
  }

  const snap = await takeSnapshot(ROOT, [file]);
  let res: ReturnType<typeof insertAtSymbol>;
  try {
    res = insertAtSymbol(source, anchorLine, body, position);
  } catch (e) {
    return `${file}: ${(e as Error).message} — nothing was written.`;
  }
  await fs.writeFile(abs, res.text, "utf8");
  invalidateFileCache(abs);

  let indexErr: string | null = null;
  try {
    await buildOrRefresh(ROOT, false);
  } catch (e) {
    indexErr = (e as Error).message;
  }
  const fresh = await loadIndex(ROOT);
  const parsed = (fresh.files[file]?.symbols ?? []).some((s) => s.line >= res.start && s.line <= res.end);
  const snapNote = snap.files > 0 ? `snapshot saved (${snap.dir})` : "snapshot skipped (file too large or unreadable)";
  const parseNote = indexErr
    ? `⚠ THE FILE WAS WRITTEN, but re-indexing failed (${indexErr}) — do NOT re-apply; run index_repo`
    : parsed
      ? "re-indexed, a symbol is present in the inserted range"
      : "⚠ re-indexed but no symbol parsed in the inserted range — check the body is a valid declaration";
  return (
    `Inserted ${position} ${label} in ${file}: new lines ${res.start}-${res.end} ` +
    `(${res.end - res.start + 1} line(s)). ${snapNote}; ${parseNote}.`
  );
}

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
  const byFile = new Map<string, PlannedEdit[]>();
  const refusals: string[] = [];
  for (const [i, e] of edits.entries()) {
    if (typeof e.body !== "string" || !e.body.length) {
      refusals.push(`edit ${i + 1}: body is required.`);
      continue;
    }
    // Re-read per edit rather than hoisting one snapshot out of the loop:
    // resolving a stale target now re-indexes in place, and a hoisted index
    // object would leave every later edit in the batch comparing against
    // entries that were just replaced — refusing the whole batch for a
    // staleness that had already been repaired. loadIndex returns the shared
    // cached object, so this is a map lookup, not a re-read.
    const target = await resolve(await loadIndex(ROOT), e);
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
    before: readonly { name: string; line: number }[]; // pre-write symbols, for drop detection
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
    const before = (await loadIndex(ROOT)).files[file]?.symbols ?? [];
    try {
      const res = spliceSymbols(source, list);
      pending.push({ file, abs, text: res.text, source, before, applied: res.applied });
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
    const freshSymbols = fresh.files[p.file]?.symbols ?? [];
    for (const a of p.applied) {
      const parsed = freshSymbols.some((s) => s.line >= a.newStart && s.line <= a.newEnd);
      if (!parsed) warnings++;
      const dropped = droppedSymbols(
        p.before,
        freshSymbols,
        { start: a.oldStart, end: a.oldEnd },
        { start: a.newStart, end: a.newEnd }
      );
      lines.push(
        `  ${p.file}: ${a.label} lines ${a.oldStart}-${a.oldEnd} → ${a.newStart}-${a.newEnd}` +
          ` (${a.oldEnd - a.oldStart + 1} removed, ${a.newEnd - a.newStart + 1} written)` +
          (parsed ? "" : " ⚠ no symbol parsed in the new range — check the body is a valid declaration") +
          droppedNote(dropped)
      );
    }
  }
  const snapNote = snap.files > 0 ? `snapshot saved (${snap.dir})` : "snapshot skipped (files too large or unreadable)";
  const total = pending.reduce((n, p) => n + p.applied.length, 0);
  // One call, N symbols — counted as N, since the point of the metric is how
  // much rewriting went through the by-name path, not how many calls it took.
  await recordSlimdexWrite(ROOT, total);
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
      "across every session on this repo until reset. To measure ONE task: call checkpoint:true when you start, " +
      "then session:true when you finish — the server is long-lived, so session:true alone means 'since the server " +
      "booted', which can span several chats.",
    inputSchema: {
      reset: z.boolean().optional().describe("Clear ALL counters, including the repo's all-time history."),
      checkpoint: z
        .boolean()
        .optional()
        .describe("Zero the session tally only (all-time history untouched). Call at the start of a task."),
      session: z
        .boolean()
        .optional()
        .describe("Report what this process recorded since it started, or since the last checkpoint."),
    },
  },
  async ({ reset, checkpoint, session }) => {
    if (reset) {
      await resetStats(ROOT);
      return "Stats reset — all-time counters cleared.";
    }
    if (checkpoint) {
      await checkpointStats(ROOT);
      return "Session counters zeroed; all-time history kept. Do the work, then call stats session:true to see what it cost.";
    }
    if (session) {
      const s = await loadSessionStats(ROOT);
      if (!Object.keys(s.tools).length) return "No tool calls recorded since the last checkpoint (or since this server started).";
      return `slimdex ${buildStamp()}\nSINCE ${s.since} (this process / last checkpoint — not the repo's all-time totals):\n${formatStats(s, await loadBypass(ROOT, s.since))}`;
    }
    // The build stamp rides on stats because that is where you look when a
    // result surprises you — and "the process predates the fix" is the answer
    // you cannot otherwise get from inside a session.
    const all = await loadStats(ROOT);
    return `slimdex ${buildStamp()}\n${formatStats(all, await loadBypass(ROOT, all.writeSince ?? all.since))}`;
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
      "CALL THIS FIRST in a fresh chat — including on a repo slimdex has never seen, where it builds the index itself " +
      "rather than sending you to index_repo. One synthesized opener instead of stitching memory_list + recap yourself: what " +
      "the repo is, where recent sessions were digging (automatic journal), and each saved conclusion CHECKED against the " +
      "current index so stale ones are flagged (✓ live, ⚠ may be stale).",
    inputSchema: {
      limit: z.number().int().min(1).max(400).optional().describe("Journaled calls to summarize for the focus section (default 200)."),
    },
  },
  async ({ limit }) => {
    let index = await loadIndex(ROOT);
    // brief is documented as the FIRST call of every session, so "run
    // index_repo first, then brief" made the documented opening move a
    // guaranteed wasted round-trip on any repo slimdex hadn't seen — and a cold
    // index is exactly the state a first-ever session is in. It also fires after
    // an INDEX_VERSION bump, when the cache is discarded by design.
    //
    // Building it here is the same work the agent was being told to do, minus
    // the turn. Reported rather than silent: the caller should know the opener
    // cost a full parse, and that nothing was wrong.
    let coldStart = "";
    if (Object.keys(index.files).length === 0) {
      const r = await buildOrRefresh(ROOT, false);
      index = r.index;
      coldStart =
        Object.keys(index.files).length === 0
          ? ""
          : `(index was empty — built it first: ${r.totalFiles} files, ${r.parsed} parsed)\n\n`;
      if (Object.keys(index.files).length === 0)
        return "Index is empty and indexing found no supported files — check the root, or .slimdex.json's extensions/ignoreDirs.";
    }
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
    // The enforcement half of this server lives in the client's config, where
    // the server cannot put it — so the one thing it CAN do is notice it is
    // missing, at the one moment the whole session is being oriented.
    const hooks = hookNote(await hookState(ROOT));
    return coldStart + composeBrief({ index, facts: mem.facts, recap, root: ROOT, build: buildStamp() }) + freshLine + hooks;
  }
);

tool(
  "install_hook",
  {
    title: "Install the PreToolUse hook",
    description:
      "Wire slimdex's write discipline into the CLIENT, which registering the MCP server cannot do — the protocol has " +
      "no mechanism for a server to add a hook, so this is the one call that closes the gap. Writes a PreToolUse hook " +
      "that speaks up ONLY when an edit re-sends 25+ lines that an indexed symbol actually covers, or a whole file over " +
      "12KB is read. Merges rather than clobbers, is idempotent, and prints exactly what changed. scope: claude-global " +
      "(default, all your repos) | claude-local | claude-project | copilot-global (VS Code, all your repos) | " +
      "copilot-project (.github/hooks, COMMITTED). Use uninstall:true to remove it.",
    inputSchema: {
      scope: z
        .enum(["claude-global", "claude-local", "claude-project", "copilot-global", "copilot-project"])
        .optional()
        .describe("Which config to write. Default claude-global; use copilot-global for a VS Code-only setup."),
      uninstall: z.boolean().optional().describe("Remove the hook instead of adding it."),
    },
  },
  async ({ scope, uninstall }) => {
    const target: Scope = scope ?? "claude-global";
    const before = await hookState(ROOT);
    const output = await runInstaller(ROOT, target, uninstall === true);
    const after = await hookState(ROOT);
    const changed =
      before.installed === after.installed
        ? "(no change in detected state)"
        : after.installed
          ? "Hook is now detected."
          : "Hook is no longer detected.";
    return (
      `${output}\n\n${changed}\n` +
      `Hooks are read at SESSION START — restart this chat session for it to take effect.` +
      (after.installed ? `\nDetected in: ${after.where.join(", ")}` : "")
    );
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
  console.error(`slimdex-mcp ${buildStamp()} ready. root=${ROOT}  ${surface}`);
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
