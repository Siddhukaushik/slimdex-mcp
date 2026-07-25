// Higher-level "code intelligence" built on the index + raw files:
//   - extractBlock:   the source span of a definition (brace- or indent-scoped)
//   - fileSkeleton:   signatures only, bodies elided, nesting preserved
//   - enclosingSymbol: which def encloses a given line (for caller attribution)
//   - getSymbolContext / buildContext: the token-saving surgical retrievals
//
// All of it is heuristic (same honesty caveat as symbols.ts): block detection
// uses brace balancing for C-family and indentation for Python/Ruby. Good
// enough to return "just this function" instead of a whole file.

import path from "node:path";
import { readFileCached } from "./fscache.js";
import type { CodeIndex, FileEntry } from "./store.js";
import { buildGraph, dependents, nameRefEdges, mergeEdges } from "./graph.js";
import { braceDelta, type ScanState } from "./lexer.js";

function leadingWS(line: string): number {
  return line.length - line.trimStart().length;
}

// The line lexer moved to lexer.ts so symbols.ts and outline.ts can share it
// without importing this module (which would close a cycle through store.ts).
// Re-exported here because it has always been part of this module's surface.
export { braceDelta, type ScanState } from "./lexer.js";

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
  throw new Error(
    `Refusing to treat ${startLine} as a one-line block: an opening brace did not close within ${limit - i0} lines`
  );
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
  maxLines = 200,
  // Line of the next declaration in this file, if known. The ±N padding is
  // meant to catch a decorator or a trailing comment, not to spill the whole of
  // the following function into a response whose entire purpose is "just this
  // symbol" — so padding stops short of the next declaration.
  nextDefLine?: number
): Promise<SymbolContext> {
  const source = await readFileCached(path.join(root, file));
  const lines = source.split(/\r?\n/);
  const block = extractBlock(lines, defLine);
  const ceiling = nextDefLine && nextDefLine > block.end ? nextDefLine - 1 : lines.length;
  const s = Math.max(1, block.start - before);
  const eFull = Math.min(lines.length, block.end + after, ceiling);
  const loc = block.end - block.start + 1;
  const e = Math.min(eFull, s + maxLines - 1);
  const shown = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}  ${l}`).join("\n");
  const body = e < eFull ? `${shown}\n  … truncated ${eFull - e} more line(s); raise maxLines or use read_lines ${e + 1}-${eFull}` : shown;
  return { file, line: defLine, kind, loc, text: body };
}

export type ContextSection = "definition" | "signature" | "body" | "callers" | "imports" | "dependents";
// `body` was already opt-in; `dependents` joined it after looking at real
// transcripts: for a popular symbol the section is a long file list the agent
// rarely acts on, and it forces an import-graph build on every call. Ask for
// it (or use dep_graph) when reverse deps are actually the question.
const DEFAULT_SECTIONS: ContextSection[] = ["definition", "signature", "callers", "imports"];

/**
 * Ceiling on files read while collecting callers. Reading is the real cost and
 * there is no way to know a file lacks the name without reading it, so the only
 * honest bound is on how many we are willing to open. Chosen to cover ordinary
 * repos whole while keeping a monorepo from turning one get_context into a
 * full-tree read.
 */
const MAX_CALLER_SCAN_FILES = 2000;

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
  const include = new Set<ContextSection>(opts.include ?? DEFAULT_SECTIONS);
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

  const src = await readFileCached(path.join(root, primary.file));
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
    const allFiles = Object.keys(index.files);
    // Bounded, like every other scan here. This section used to read EVERY
    // indexed file on every call — and `callers` is in the default section set,
    // so a single get_context on a large repo meant a full-repo read. The cap is
    // on files SCANNED (the actual cost is reading them), and tripping it is
    // reported rather than silently returning a short caller list.
    const files = allFiles.slice(0, MAX_CALLER_SCAN_FILES);
    const scanCapped = allFiles.length > files.length;
    const hits: { file: string; line: number; enc: ReturnType<typeof enclosingSymbol> }[] = [];
    const BATCH = 24;
    for (let b = 0; b < files.length; b += BATCH) {
      const slice = files.slice(b, b + BATCH);
      const sources = await Promise.all(
        slice.map((f) => (f === primary.file ? Promise.resolve(src) : readFileCached(path.join(root, f)).catch(() => "")))
      );
      slice.forEach((file, k) => {
        const fsrc = sources[k];
        if (!fsrc) return;
        // \b<name>\b can't match a file that doesn't contain the raw name:
        // skip the line-split + per-line regex, the dominant cost at scale.
        if (!fsrc.includes(name)) return;
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
    const capNote = scanCapped
      ? ` — scanned the first ${files.length} of ${allFiles.length} indexed files; use find_references with pathPrefix for the rest`
      : "";
    out.push(`## Callers / references — heuristic (showing ${shown.length} of ${hits.length}${capNote})`);
    out.push(shown.length ? shown.join("\n") : "  (none found)");
    out.push("");
  }

  if (include.has("imports") || include.has("dependents")) {
    const graph = mergeEdges(buildGraph(index), await nameRefEdges(root, index));
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
