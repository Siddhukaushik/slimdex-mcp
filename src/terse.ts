// Output density. Every response char is context the model pays for twice —
// once now, and again in every later turn that re-reads the transcript — so the
// connective prose around a result ("showing 3 of 68 reference(s)", column
// padding for human eyeball alignment) is pure cost to the only reader that
// matters here.
//
// Default is TERSE. Set SLIMDEX_PRETTY=1 (or SLIMDEX_TERSE=0) for the verbose,
// human-aligned rendering when a person is reading the transcript directly.
// Handlers go through these helpers instead of inline literals so the two modes
// can never drift apart.

function compute(): boolean {
  if (process.env.SLIMDEX_PRETTY === "1") return false;
  if (process.env.SLIMDEX_TERSE === "0") return false;
  return true;
}

// Memoized because the row builders in repo_map/find_references call this once
// per output line, and process.env access is not free. resetTerseCache() exists
// so a test can flip the env and observe both renderings in one process.
let cached: boolean | null = null;

export function terse(): boolean {
  if (cached === null) cached = compute();
  return cached;
}

export function resetTerseCache(): void {
  cached = null;
}

// Pick between a verbose and a terse rendering of the same information.
export function t(verbose: string, terseText: string): string {
  return terse() ? terseText : verbose;
}

// "src/app.ts [12-40 of 655]" — the standard header for ranged file output.
export function fileHeader(path: string, start: number, end: number, totalLines: number): string {
  return terse() ? `${path}:${start}-${end}/${totalLines}` : `${path} [${start}-${end} of ${totalLines}]`;
}

// "showing 3 of 68 reference(s)" / terse "3/68".
export function countNotice(shown: number, total: number, noun: string): string {
  return terse() ? `${shown}/${total}` : `showing ${shown} of ${total} ${noun}`;
}

// Explicit truncation banner — never silent in either mode.
export function truncNotice(reason: string): string {
  return terse() ? `…cut: ${reason}` : `… response truncated: ${reason}`;
}

/**
 * Right-pad for column alignment — but only when a human is reading. In terse
 * mode the padding collapses to a single space, which is the whole point: a
 * 40-row repo_map spends hundreds of chars on whitespace no model needs.
 */
export function pad(s: string, width: number): string {
  return terse() ? s : s.padEnd(width);
}

/** Left-pad (line numbers). Same reasoning as pad(). */
export function padNum(n: number | string, width: number): string {
  return terse() ? String(n) : String(n).padStart(width);
}
