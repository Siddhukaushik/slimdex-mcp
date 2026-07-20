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

// Given a 1-indexed definition line, return the inclusive [start,end] span of
// its body. Braces win when present; otherwise fall back to indentation.
export function extractBlock(lines: string[], startLine: number): { start: number; end: number } {
  const i0 = startLine - 1;
  if (i0 < 0 || i0 >= lines.length) return { start: startLine, end: startLine };
  const defIndent = leadingWS(lines[i0]);

  let sawBrace = false;
  let depth = 0;
  for (let i = i0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        sawBrace = true;
      } else if (ch === "}") {
        depth--;
        if (sawBrace && depth <= 0) return { start: startLine, end: i + 1 };
      }
    }
    if (i - i0 > 2000) break; // safety valve
    if (sawBrace) continue;
    // No brace yet. If the next non-empty line is not more-indented, this is a
    // one-liner (e.g. `const x = 1`) — stop here.
    if (i > i0 && lines[i].trim() && leadingWS(lines[i]) <= defIndent) break;
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
export async function getSymbolContext(
  root: string,
  file: string,
  defLine: number,
  kind: string,
  before = 2,
  after = 2
): Promise<SymbolContext> {
  const source = await fs.readFile(path.join(root, file), "utf8");
  const lines = source.split(/\r?\n/);
  const block = extractBlock(lines, defLine);
  const s = Math.max(1, block.start - before);
  const e = Math.min(lines.length, block.end + after);
  const body = lines
    .slice(s - 1, e)
    .map((l, i) => `${String(s + i).padStart(5)}  ${l}`)
    .join("\n");
  return { file, line: defLine, kind, loc: block.end - block.start + 1, text: body };
}

// The "Intelligent Context Builder": one call that assembles what an agent
// would otherwise gather with find_definition + read + find_references +
// dep_graph. Returns a compact brief, not full source, unless withBody=true.
export async function buildContext(
  root: string,
  index: CodeIndex,
  name: string,
  opts: { withBody?: boolean; maxCallers?: number } = {}
): Promise<string> {
  const maxCallers = opts.maxCallers ?? 12;

  // 1. Definitions from the index.
  const defs: { file: string; line: number; col: number; kind: string }[] = [];
  for (const [file, entry] of Object.entries(index.files)) {
    for (const sym of entry.symbols) {
      if (sym.name === name) defs.push({ file, line: sym.line, col: sym.col, kind: sym.kind });
    }
  }
  if (defs.length === 0) return `No definition indexed for "${name}". (Run index_repo, or the syntax may be unsupported.)`;

  const primary = defs[0];
  const out: string[] = [`# Context for "${name}"`, ``];

  // 2. Definition(s).
  out.push(`## Definition${defs.length > 1 ? "s" : ""}`);
  for (const d of defs) out.push(`  ${d.file}:${d.line}:${d.col}  ${d.kind}`);
  out.push("");

  // 3. Signature (+ optional body) of the primary definition.
  const src = await fs.readFile(path.join(root, primary.file), "utf8");
  const lines = src.split(/\r?\n/);
  const block = extractBlock(lines, primary.line);
  out.push(`## Signature  (${block.end - block.start + 1} LOC at ${primary.file}:${primary.line})`);
  out.push("  " + (lines[primary.line - 1] ?? "").trim());
  if (opts.withBody) {
    out.push("```");
    out.push(lines.slice(block.start - 1, block.end).join("\n"));
    out.push("```");
  }
  out.push("");

  // 4. Callers: textual references to the name, attributed to their enclosing
  //    symbol, excluding the definition sites themselves.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`);
  const callers: string[] = [];
  const defSet = new Set(defs.map((d) => `${d.file}:${d.line}`));
  outer: for (const [file, entry] of Object.entries(index.files)) {
    const fsrc = file === primary.file ? src : await fs.readFile(path.join(root, file), "utf8").catch(() => "");
    if (!fsrc) continue;
    const flines = fsrc.split(/\r?\n/);
    for (let i = 0; i < flines.length; i++) {
      if (defSet.has(`${file}:${i + 1}`)) continue;
      if (re.test(flines[i])) {
        const enc = enclosingSymbol(entry, i + 1);
        callers.push(`  ${file}:${i + 1}${enc ? `  in ${enc.kind} ${enc.name}` : ""}`);
        if (callers.length >= maxCallers) break outer;
      }
    }
  }
  out.push(`## Callers / references (${callers.length}${callers.length >= maxCallers ? "+" : ""})`);
  out.push(callers.length ? callers.join("\n") : "  (none found)");
  out.push("");

  // 5. Imports of the defining file + who depends on it.
  const graph = buildGraph(index);
  const internal = graph.imports[primary.file] ?? [];
  const external = graph.external[primary.file] ?? [];
  const deps = dependents(graph, primary.file);
  out.push(`## ${primary.file} imports`);
  out.push(`  internal: ${internal.length ? internal.join(", ") : "(none)"}`);
  out.push(`  external: ${external.length ? external.join(", ") : "(none)"}`);
  out.push(`## Files importing ${primary.file} (${deps.length})`);
  out.push(deps.length ? deps.map((d) => "  " + d).join("\n") : "  (none)");

  return out.join("\n");
}
