// Higher-level "code intelligence" built on the index + raw files:
//   - extractBlock:   the source span of a definition (brace- or indent-scoped)
//   - fileSkeleton:   signatures only, bodies elided, nesting preserved
//   - enclosingSymbol: which def encloses a given line (for caller attribution)
//   - getSymbolContext / buildContext: the token-saving surgical retrievals
//
// All of it is heuristic (same honesty caveat as symbols.ts): block detection
// uses brace balancing for C-family and indentation for Python/Ruby. Good
// enough to return "just this function" instead of a whole file.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { CodeIndex, FileEntry } from "./store.js";
import { buildGraph, dependents } from "./graph.js";

function leadingWS(line: string): number {
  return line.length - line.trimStart().length;
}

// Carry-over lexer state for brace counting across lines. Only block comments
// and template literals legitimately span lines; ' and " strings reset at EOL
// so one unbalanced quote can't poison the rest of the file.
interface ScanState {
  inBlockComment: boolean;
  stringChar: string | null; // "'", '"', or "`"
}

// Count braces on one line, skipping those inside strings and comments.
// Known gap (documented): inline `#` comments (Python) are not stripped,
// because `#` is also the JS private-field sigil; full-line `#` comments are
// handled by the caller.
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
  // ' and " don't span lines; only ` (template literal) carries over.
  if (st.stringChar === "'" || st.stringChar === '"') st.stringChar = null;
  return { open, close };
}

// Given a 1-indexed definition line, return the inclusive [start,end] span of
// its body. Braces win when present (counted string/comment-aware); otherwise
// fall back to indentation.
export function extractBlock(lines: string[], startLine: number): { start: number; end: number } {
  const i0 = startLine - 1;
  if (i0 < 0 || i0 >= lines.length) return { start: startLine, end: startLine };
  const defIndent = leadingWS(lines[i0]);
  const st: ScanState = { inBlockComment: false, stringChar: null };
  let sawBrace = false;
  let depth = 0;
  const limit = Math.min(lines.length, i0 + 2001); // safety valve
  for (let i = i0; i < limit; i++) {
    const t = lines[i].trim();
    // Full-line comments can't affect code structure (covers Python `#` too).
    const fullLineComment = !st.inBlockComment && !st.stringChar && (t.startsWith("#") || t.startsWith("//"));
    if (!fullLineComment) {
      const d = braceDelta(lines[i], st);
      if (d.open > 0) sawBrace = true;
      depth += d.open - d.close;
      if (sawBrace && depth <= 0 && d.close > 0) return { start: startLine, end: i + 1 };
    }
    if (sawBrace) continue;
    // No brace yet. If the next non-empty line is not more-indented, this is a
    // one-liner (e.g. `const x = 1`) — stop here.
    if (i > i0 && t && leadingWS(lines[i]) <= defIndent) break;
  }

  if (!sawBrace) {
    // Indentation-scoped (Python/Ruby/YAML-ish).
    let end = i0;
    for (let i = i0 + 1; i < lines.length; i++) {
      if (!lines[i].trim()) {
        end = i;
        continue;
      }
      if (leadingWS(lines[i]) > defIndent) end = i;
      else break;
    }
    while (end > i0 && !lines[end].trim()) end--; // trim trailing blanks
    return { start: startLine, end: end + 1 };
  }
  return { start: startLine, end: startLine };
}

// The symbol whose definition most immediately encloses `line`.
export function enclosingSymbol(entry: FileEntry, line: number): { name: string; kind: string; line: number } | null {
  let best: { name: string; kind: string; line: number } | null = null;
  for (const s of entry.symbols) {
    if (s.line <= line && (!best || s.line > best.line)) best = { name: s.name, kind: s.kind, line: s.line };
  }
  return best;
}

// A structural skeleton: every indexed declaration's signature line, with its
// original indentation preserved so methods nest under classes. Bodies elided.
export function fileSkeleton(source: string, entry: FileEntry): string {
  const lines = source.split(/\r?\n/);
  const rows: string[] = [];
  for (const s of entry.symbols) {
    const raw = lines[s.line - 1] ?? "";
    const indent = raw.slice(0, leadingWS(raw));
    // strip a trailing opening brace / colon, append an elision marker
    const sig = raw.trim().replace(/[{:]\s*$/, "").trimEnd();
    rows.push(`${indent}${sig} … {${s.line}}`);
  }
  return rows.join("\n");
}

export interface SymbolContext {
  file: string;
  line: number;
  kind: string;
  loc: number;
  text: string;
}

// Read only the body of one symbol (+/- context lines) rather than the file.
// `maxLines` caps the returned span so a 900-line "god function" can't blow the
// budget — when it trips, the tail is elided with an explicit truncation note
// (never a silent drop, per the response-budgeting guidance).
export async function getSymbolContext(
  root: string,
  file: string,
  defLine: number,
  kind: string,
  before = 2,
  after = 2,
  maxLines = 200
): Promise<SymbolContext> {
  const source = await fs.readFile(path.join(root, file), "utf8");
  const lines = source.split(/\r?\n/);
  const block = extractBlock(lines, defLine);
  const s = Math.max(1, block.start - before);
  const eFull = Math.min(lines.length, block.end + after);
  const loc = block.end - block.start + 1;
  const e = Math.min(eFull, s + maxLines - 1);
  const shown = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}  ${l}`).join("\n");
  const body = e < eFull ? `${shown}\n  … truncated ${eFull - e} more line(s); raise maxLines or use read_lines ${e + 1}-${eFull}` : shown;
  return { file, line: defLine, kind, loc, text: body };
}

export type ContextSection = "definition" | "signature" | "body" | "callers" | "imports" | "dependents";
const ALL_SECTIONS: ContextSection[] = ["definition", "signature", "callers", "imports", "dependents"];

// The "Intelligent Context Builder": one call that assembles what an agent
// would otherwise gather with find_definition + read + find_references +
// dep_graph. Per peer-review guidance, sections are OPT-IN (default: everything
// except full body) and the whole response is bounded by `maxChars` with an
// explicit truncation notice — so the aggregator can never silently become the
// biggest token producer in the transcript.
export async function buildContext(
  root: string,
  index: CodeIndex,
  name: string,
  opts: { include?: ContextSection[]; callerLimit?: number; maxChars?: number } = {}
): Promise<string> {
  const include = new Set<ContextSection>(opts.include ?? ALL_SECTIONS);
  const callerLimit = opts.callerLimit ?? 12;
  const maxChars = opts.maxChars ?? 12000;

  // 1. Definitions from the index.
  const defs: { file: string; line: number; col: number; kind: string }[] = [];
  for (const [file, entry] of Object.entries(index.files))
    for (const sym of entry.symbols)
      if (sym.name === name) defs.push({ file, line: sym.line, col: sym.col, kind: sym.kind });
  if (defs.length === 0) return `No definition indexed for "${name}". (Run index_repo, or the syntax may be unsupported.)`;

  const primary = defs[0];
  const out: string[] = [`# Context for "${name}"  (sections: ${[...include].join(", ")})`, ``];

  if (include.has("definition")) {
    out.push(`## Definition${defs.length > 1 ? "s" : ""}`);
    for (const d of defs) out.push(`  ${d.file}:${d.line}:${d.col}  ${d.kind}`);
    out.push("");
  }

  const src = await fs.readFile(path.join(root, primary.file), "utf8");
  const lines = src.split(/\r?\n/);
  const block = extractBlock(lines, primary.line);

  if (include.has("signature") || include.has("body")) {
    out.push(`## Signature  (${block.end - block.start + 1} LOC at ${primary.file}:${primary.line})`);
    out.push("  " + (lines[primary.line - 1] ?? "").trim());
    if (include.has("body")) {
      out.push("```");
      out.push(lines.slice(block.start - 1, block.end).join("\n"));
      out.push("```");
    }
    out.push("");
  }

  if (include.has("callers")) {
    // Textual references, attributed to their enclosing symbol (HEURISTIC — a
    // whole-word text match, not scope-resolved), excluding the def sites.
    // Files are read in parallel batches rather than one-at-a-time: on large
    // repos the serial version was the dominant cost of this whole call.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const defSet = new Set(defs.map((d) => `${d.file}:${d.line}`));
    const files = Object.keys(index.files);
    const hits: { file: string; line: number; enc: ReturnType<typeof enclosingSymbol> }[] = [];
    const BATCH = 24;
    for (let b = 0; b < files.length; b += BATCH) {
      const slice = files.slice(b, b + BATCH);
      const sources = await Promise.all(
        slice.map((f) => (f === primary.file ? Promise.resolve(src) : fs.readFile(path.join(root, f), "utf8").catch(() => "")))
      );
      slice.forEach((file, k) => {
        const fsrc = sources[k];
        if (!fsrc) return;
        const entry = index.files[file];
        const re = new RegExp(`\\b${escaped}\\b`); // fresh per file: no lastIndex carry
        const flines = fsrc.split(/\r?\n/);
        for (let i = 0; i < flines.length; i++) {
          if (defSet.has(`${file}:${i + 1}`)) continue;
          if (re.test(flines[i])) hits.push({ file, line: i + 1, enc: enclosingSymbol(entry, i + 1) });
        }
      });
    }
    const shown = hits.slice(0, callerLimit).map((h) => `  ${h.file}:${h.line}${h.enc ? `  in ${h.enc.kind} ${h.enc.name}` : ""}`);
    out.push(`## Callers / references — heuristic (showing ${shown.length} of ${hits.length})`);
    out.push(shown.length ? shown.join("\n") : "  (none found)");
    out.push("");
  }

  if (include.has("imports") || include.has("dependents")) {
    const graph = buildGraph(index);
    if (include.has("imports")) {
      const internal = graph.imports[primary.file] ?? [];
      const external = graph.external[primary.file] ?? [];
      out.push(`## ${primary.file} imports`);
      out.push(`  internal: ${internal.length ? internal.join(", ") : "(none)"}`);
      out.push(`  external: ${external.length ? external.join(", ") : "(none)"}`);
    }
    if (include.has("dependents")) {
      const deps = dependents(graph, primary.file);
      out.push(`## Files importing ${primary.file} (${deps.length})`);
      out.push(deps.length ? deps.map((d) => "  " + d).join("\n") : "  (none)");
    }
  }

  // Budget the whole response — truncate with an explicit notice, never silent.
  let result = out.join("\n");
  if (result.length > maxChars) {
    result = result.slice(0, maxChars) + `\n\n… response truncated at maxChars=${maxChars}; narrow with include:[...] or lower callerLimit.`;
  }
  return result;
}
