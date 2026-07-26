// Parser abstraction — the seam where a more accurate backend plugs in.
//
// Today there is exactly one implementation: the regex parser in symbols.ts.
// It is fast, dependency-free, and multi-language, at the cost of accuracy on
// exotic syntax. A future tree-sitter backend would implement this same
// interface and be selected via SLIMDEX_PARSER, WITHOUT changing any tool or
// the index format — symbols and imports carry the same shape either way.
//
// Why tree-sitter is deliberately deferred rather than shipped here: it needs
// per-language grammars (native builds or bundled WASM), which trades away the
// "installs instantly, runs offline, zero config" property that is the whole
// point of this server. The abstraction below keeps that upgrade a drop-in when
// the tradeoff is worth it, per the project's own design notes.

import { extractSymbols, extractImports, type SymbolDef, type ImportRef } from "./symbols.js";

export interface Parser {
  readonly name: string;
  extractSymbols(source: string, maxSymbols?: number, file?: string): SymbolDef[];
  extractImports(source: string): ImportRef[];
}

const regexParser: Parser = {
  name: "regex",
  extractSymbols,
  extractImports,
};

// Resolve the active parser. Env-gated so a future backend can be opted into
// without a code change; unknown values fall back to regex with a warning.
export function getParser(): Parser {
  const want = (process.env.SLIMDEX_PARSER || "regex").toLowerCase();
  if (want === "regex") return regexParser;
  // Placeholder for the tree-sitter backend. Until it exists, don't fail —
  // degrade to the parser we have and say so on stderr.
  console.error(`slimdex: parser "${want}" not available, using regex`);
  return regexParser;
}
