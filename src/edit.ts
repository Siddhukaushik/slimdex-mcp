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
  return spliceOne(source, defLine, newBody);
}

function spliceOne(source: string, defLine: number, newBody: string): SpliceResult {
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

export interface PlannedEdit {
  defLine: number;
  body: string;
  label: string; // what to call this edit in the report (symbol name or file:line)
}

export interface AppliedEdit extends PlannedEdit {
  oldStart: number; // where the block was in the file before any edit
  oldEnd: number;
  newStart: number; // where the replacement sits in the file after ALL edits
  newEnd: number;
}

export interface MultiSpliceResult {
  text: string;
  applied: AppliedEdit[]; // in original file order (ascending oldStart)
  eol: "\n" | "\r\n";
}

/**
 * Apply several symbol replacements to ONE file in a single pass.
 *
 * Two things make this safe rather than just convenient:
 *
 *  - Overlap detection. Two edits whose blocks intersect (a method and the class
 *    that contains it, or the same symbol twice) cannot both be applied
 *    meaningfully — the second would be splicing into text the first rewrote.
 *    That throws, and the caller writes nothing.
 *  - Bottom-up application. Edits are applied in descending start order, so a
 *    body that changes line count can never invalidate the line numbers of an
 *    edit not yet applied. This is why the resolved defLines stay correct
 *    without a re-index between edits.
 *
 * All-or-nothing by construction: the new text is computed in memory and the
 * caller performs exactly one write, so a rejected batch leaves the file as it
 * was.
 */
export function spliceSymbols(source: string, edits: PlannedEdit[]): MultiSpliceResult {
  const eol: "\n" | "\r\n" = /\r\n/.test(source) ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);

  // Resolve every block against the ORIGINAL text first — that is what makes
  // overlap detectable before any mutation happens.
  const planned = edits.map((e) => {
    if (e.defLine < 1 || e.defLine > lines.length)
      throw new Error(`defLine ${e.defLine} is out of range for this file (${lines.length} line(s)) — re-run index_repo`);
    const block = extractBlock(lines, e.defLine);
    return { edit: e, start: block.start, end: block.end };
  });

  const byStart = [...planned].sort((a, b) => a.start - b.start);
  for (let i = 1; i < byStart.length; i++) {
    const prev = byStart[i - 1];
    const cur = byStart[i];
    if (cur.start <= prev.end)
      throw new Error(
        `edits overlap: "${prev.edit.label}" spans lines ${prev.start}-${prev.end} and "${cur.edit.label}" starts at ` +
          `line ${cur.start} inside it — split them into separate calls, or replace the enclosing symbol once`
      );
  }

  // Descending, so earlier line numbers are still valid when we reach them.
  let out = [...lines];
  for (const p of [...byStart].reverse()) {
    const newLines = p.edit.body.split(/\r?\n/);
    out = [...out.slice(0, p.start - 1), ...newLines, ...out.slice(p.end)];
  }

  // Report where each replacement ended up in the FINAL text. Walking ascending
  // and carrying the line-count delta of every preceding edit is the only way
  // these spans are true: an edit that grows by 3 lines moves everything below
  // it, so spans computed during the bottom-up pass go stale as it continues.
  const applied: AppliedEdit[] = [];
  let delta = 0;
  for (const p of byStart) {
    const newLen = p.edit.body.split(/\r?\n/).length;
    const newStart = p.start + delta;
    applied.push({ ...p.edit, oldStart: p.start, oldEnd: p.end, newStart, newEnd: newStart + newLen - 1 });
    delta += newLen - (p.end - p.start + 1);
  }

  return { text: out.join(eol), applied, eol };
}
