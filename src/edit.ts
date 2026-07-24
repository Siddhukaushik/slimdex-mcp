// The write side. Every other retrieval server optimizes the READ; this is the
// one operation that attacks OUTPUT tokens, which cost ~4-5x input: replacing a
// symbol's body addressed by NAME, so the agent never re-sends the old code
// just to locate the edit. The symbol's line range comes from the same
// extractBlock the read tools use, so "where does this symbol start and end" is
// answered identically whether we're reading it or rewriting it.

import { extractBlock } from "./intel.js";

export interface SpliceResult {
  text: string; // full new file content
  oldStart: number; // 1-indexed first line of the replaced block
  oldEnd: number; // 1-indexed last line of the replaced block
  newEnd: number; // 1-indexed last line of the block after replacement
  eol: "\n" | "\r\n";
}

/**
 * Replace the whole definition block that starts at `defLine` with `newBody`.
 * Pure: computes the new file text, does not touch disk. The dominant line
 * ending of the source is preserved so a CRLF file isn't silently reflowed to
 * LF (which would blow up a diff into every line of the file).
 */
export function spliceSymbol(source: string, defLine: number, newBody: string): SpliceResult {
  const eol: "\n" | "\r\n" = /\r\n/.test(source) ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  // Fail fast on a defLine past EOF (e.g. a stale index): otherwise extractBlock
  // returns an empty {start:defLine,end:defLine} and we'd silently append the
  // body at the wrong place. A wrong write is worse than a refused one.
  if (defLine < 1 || defLine > lines.length)
    throw new Error(`defLine ${defLine} is out of range for this file (${lines.length} line(s)) — re-run index_repo`);
  const block = extractBlock(lines, defLine);
  const newLines = newBody.split(/\r?\n/);
  const before = lines.slice(0, block.start - 1);
  const after = lines.slice(block.end);
  const merged = [...before, ...newLines, ...after];
  return {
    text: merged.join(eol),
    oldStart: block.start,
    oldEnd: block.end,
    newEnd: block.start + newLines.length - 1,
    eol,
  };
}
