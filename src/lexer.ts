// Shared line lexer: tracks string and comment state across lines so callers
// can tell real code from code-shaped *text*.
//
// This lives in its own module because both the symbol extractor and the
// outliner need it and neither may import the other (store.ts imports
// symbols.ts, so symbols.ts importing intel.ts would close a cycle).
//
// Known gap, unchanged from before: an inline `#` comment is not stripped,
// because `#` is also the JS private-field sigil. Full-line `#` comments are
// handled by callers.

export interface ScanState {
  inBlockComment: boolean;
  stringChar: string | null; // "'", '"', or "`"
}

export function newScanState(): ScanState {
  return { inBlockComment: false, stringChar: null };
}

// ' and " never span lines, so an unbalanced quote can't poison the rest of the
// file; only a template literal carries over.
function settleEol(st: ScanState): void {
  if (st.stringChar === "'" || st.stringChar === '"') st.stringChar = null;
}

// Count braces on one line, skipping those inside strings and comments.
export function braceDelta(line: string, st: ScanState): { open: number; close: number } {
  let open = 0;
  let close = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (st.inBlockComment) {
      if (ch === "*" && next === "/") {
        st.inBlockComment = false;
        i++;
      }
      continue;
    }
    if (st.stringChar) {
      if (ch === "\\") {
        i++; // skip escaped char
      } else if (ch === st.stringChar) {
        st.stringChar = null;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      st.inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") break; // line comment: ignore the rest
    if (ch === "'" || ch === '"' || ch === "`") {
      st.stringChar = ch;
      continue;
    }
    if (ch === "{") open++;
    else if (ch === "}") close++;
  }
  settleEol(st);
  return { open, close };
}

// Blank out the *contents* of strings and comments, replacing them with spaces
// while preserving the line's length. Preserving length matters: a column
// computed against the masked line still points at the right character in the
// original, so callers get correct jump targets for free.
//
// The quote/delimiter characters themselves are kept, so `"abc"` becomes `"   "`
// — enough for a regex to see a string was there without seeing what's in it.
export function maskLine(line: string, st: ScanState): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (st.inBlockComment) {
      if (ch === "*" && next === "/") {
        st.inBlockComment = false;
        out += "  ";
        i++;
      } else {
        out += " ";
      }
      continue;
    }
    if (st.stringChar) {
      if (ch === "\\") {
        out += next === undefined ? " " : "  ";
        i++;
      } else if (ch === st.stringChar) {
        st.stringChar = null;
        out += ch;
      } else {
        out += " ";
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      st.inBlockComment = true;
      out += "  ";
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      out += " ".repeat(line.length - i); // blank the rest of the line
      break;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      st.stringChar = ch;
      out += ch;
      continue;
    }
    out += ch;
  }
  settleEol(st);
  return out;
}

// Brace depth on an already-masked line. Safe to count naively because strings
// and comments are gone.
export function maskedBraceDelta(masked: string): number {
  let d = 0;
  for (const ch of masked) {
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}

// Walk a source file, yielding each line already masked plus the brace depth
// *before* that line's own braces are applied. Depth 0 means top level.
export function scanLines(source: string): { line: string; masked: string; depth: number }[] {
  const lines = source.split(/\r?\n/);
  const st = newScanState();
  const out: { line: string; masked: string; depth: number }[] = [];
  let depth = 0;
  for (const line of lines) {
    const masked = maskLine(line, st);
    out.push({ line, masked, depth });
    depth = Math.max(0, depth + maskedBraceDelta(masked));
  }
  return out;
}
