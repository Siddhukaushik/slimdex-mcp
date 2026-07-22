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
}

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

  return { matches: out.slice(offset, offset + max), total: out.length, exact: out.length < scanCap };
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
