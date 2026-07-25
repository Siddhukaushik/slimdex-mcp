// Compact code search. Returns matches as `path:line:col` plus the trimmed
// line and an optional caret "highlight" underline pointing at the match —
// enough for an agent to jump to the exact spot without the server streaming
// whole files back.

import path from "node:path";
import { readFileCached } from "./fscache.js";

export interface Match {
  file: string;
  line: number;
  col: number;
  text: string;
  highlight?: string;
}

export interface SearchResult {
  matches: Match[]; // just the requested window
  total: number; // matches counted across the whole scan
  exact: boolean; // false when the scan cap tripped, i.e. total is a lower bound
  timedOut: boolean; // true when the time budget stopped the scan early
}

/**
 * Wall-clock ceiling for one scan.
 *
 * `pattern` reaches us straight from the caller and is compiled with the
 * platform RegExp, so a pattern with nested quantifiers (`(a+)+$`) against the
 * right input backtracks catastrophically and pins the event loop. This server
 * is single-threaded and stdio-bound: one such call stops answering everything.
 *
 * HONEST LIMIT, stated where it is implemented: a JavaScript regex match is not
 * interruptible. This budget is checked BETWEEN lines, so it bounds a scan that
 * is slow across many lines — the overwhelmingly common shape — but it cannot
 * stop a single pathological line from blocking inside one exec() call. Killing
 * that case needs a worker thread or a backtracking-free engine (RE2), which is
 * a dependency this project deliberately does not take. Capping input length
 * would be the cheap alternative, but it silently changes results, and silently
 * wrong is the one thing this codebase refuses.
 */
const DEFAULT_TIME_BUDGET_MS = 5000;

/**
 * Check the clock every N lines. Small, because the interval is also the
 * overshoot: with a slow pattern, the scan runs this many more lines past the
 * deadline before noticing. A Date.now() costs tens of nanoseconds against a
 * per-line regex exec, so a tight interval is close to free.
 */
const DEADLINE_CHECK_INTERVAL = 64;

function caret(text: string, col: number, len: number): string {
  const trimmedLead = text.length - text.trimStart().length;
  const pad = Math.max(0, col - 1 - trimmedLead);
  return " ".repeat(pad) + "^".repeat(Math.max(1, len));
}

// Every occurrence on a line is a match, not just the first. The old
// one-exec-per-line version silently undercounted lines like
// `foo(foo(x))`, which made `total` — and find_references — wrong.
// `perLineCap` stops a pathological minified line from flooding the window.
const PER_LINE_CAP = 10;

export async function searchFiles(
  root: string,
  files: string[], // repo-relative posix paths
  pattern: string,
  opts: {
    regex?: boolean;
    ignoreCase?: boolean;
    maxMatches?: number;
    offset?: number;
    highlight?: boolean;
    scanCap?: number;
    // A literal substring the pattern cannot match without. Files whose raw
    // source doesn't contain it are skipped before the line-split + per-line
    // regex, which is where nearly all of a big scan's time goes. Non-regex
    // searches get this automatically (the pattern IS the literal); regex
    // callers like find_references (\bname\b) pass the name explicitly.
    literalHint?: string;
    /** Wall-clock ceiling for the whole scan; see DEFAULT_TIME_BUDGET_MS. */
    timeBudgetMs?: number;
  } = {}
): Promise<SearchResult> {
  const max = opts.maxMatches ?? 200;
  const offset = Math.max(0, opts.offset ?? 0);
  // Scan past the requested window so `total` is a real count rather than
  // "however many we happened to need". Bounded so a huge repo can't turn one
  // search into an unbounded read of every file.
  const scanCap = Math.max(opts.scanCap ?? 1000, offset + max);

  let re: RegExp;
  try {
    re = opts.regex
      ? new RegExp(pattern, opts.ignoreCase ? "gi" : "g")
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.ignoreCase ? "gi" : "g");
  } catch (e) {
    throw new Error(`Invalid pattern: ${(e as Error).message}`);
  }

  const rawHint = opts.literalHint ?? (opts.regex ? undefined : pattern);
  const hint = rawHint && rawHint.length > 0 ? (opts.ignoreCase ? rawHint.toLowerCase() : rawHint) : undefined;

  const deadline = Date.now() + (opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  let sinceCheck = 0;
  let timedOut = false;

  const out: Match[] = [];
  outer: for (const rel of files) {
    let source: string;
    try {
      source = await readFileCached(path.join(root, rel));
    } catch {
      continue;
    }
    if (hint && !(opts.ignoreCase ? source.toLowerCase() : source).includes(hint)) continue;
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (++sinceCheck >= DEADLINE_CHECK_INTERVAL) {
        sinceCheck = 0;
        if (Date.now() > deadline) {
          timedOut = true;
          break outer;
        }
      }
      const line = lines[i];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let onThisLine = 0;
      while ((m = re.exec(line)) !== null) {
        const col = m.index + 1;
        const match: Match = { file: rel, line: i + 1, col, text: line.trim().slice(0, 240) };
        if (opts.highlight) match.highlight = caret(line, col, m[0].length).slice(0, 240);
        out.push(match);
        if (++onThisLine >= PER_LINE_CAP) break;
        if (out.length >= scanCap) break outer;
        if (m.index === re.lastIndex) re.lastIndex++; // zero-width match: don't spin
      }
    }
  }

  return {
    matches: out.slice(offset, offset + max),
    total: out.length,
    // A timed-out scan never saw the whole corpus, so `total` is a lower bound
    // for the same reason a tripped scan cap makes it one.
    exact: out.length < scanCap && !timedOut,
    timedOut,
  };
}

// Opaque cursor for stable pagination. It encodes the next offset plus the
// index build time, so if the repo was re-indexed between pages we can warn
// that results may have shifted rather than silently skip/dupe rows. Callers
// pass the token back as-is; its internals are not a contract.
export function encodeCursor(nextOffset: number, indexVersion: string): string {
  return Buffer.from(JSON.stringify({ o: nextOffset, v: indexVersion })).toString("base64url");
}

export function decodeCursor(cursor: string): { offset: number; version: string } | null {
  try {
    const d = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof d.o === "number") return { offset: d.o, version: String(d.v ?? "") };
  } catch {
    /* malformed cursor */
  }
  return null;
}

export function formatMatches(matches: Match[]): string {
  if (matches.length === 0) return "No matches.";
  return matches
    .map((m) => {
      const loc = `${m.file}:${m.line}:${m.col}`;
      if (m.highlight) return `${loc}\n    ${m.text}\n    ${m.highlight}`;
      return `${loc}  ${m.text}`;
    })
    .join("\n");
}
