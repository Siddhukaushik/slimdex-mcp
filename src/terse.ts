// Opt-in terse output mode. Set SLIMDEX_TERSE=1 to shave the connective
// prose off tool responses — headers, "N of M" notices, truncation banners —
// for clients where every response char is context the model pays for twice
// (once now, once in every later turn).
//
// Default is OFF: the verbose strings are part of what the integration suite
// asserts on, and the wordier form is genuinely clearer for humans reading a
// transcript. Handlers adopt these helpers instead of inline literals so the
// two modes can never drift apart.

export const TERSE = process.env.SLIMDEX_TERSE === "1";

// Pick between a verbose and a terse rendering of the same information.
export function t(verbose: string, terse: string): string {
  return TERSE ? terse : verbose;
}

// "src/app.ts [12-40 of 655]" — the standard header for ranged file output.
export function fileHeader(path: string, start: number, end: number, totalLines: number): string {
  return TERSE ? `${path}:${start}-${end}/${totalLines}` : `${path} [${start}-${end} of ${totalLines}]`;
}

// "showing 3 of 68 reference(s)" / terse "3/68".
export function countNotice(shown: number, total: number, noun: string): string {
  return TERSE ? `${shown}/${total}` : `showing ${shown} of ${total} ${noun}`;
}

// Explicit truncation banner — never silent in either mode.
export function truncNotice(reason: string): string {
  return TERSE ? `…cut: ${reason}` : `… response truncated: ${reason}`;
}
