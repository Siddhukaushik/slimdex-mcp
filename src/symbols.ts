// Multi-language symbol extraction (definitions).
//
// Heuristic and regex-based on purpose: no native deps, works on any language
// we have a rule for, and costs microseconds per file. It captures the *name*
// of each declaration plus its line/column so the index can answer
// "where is X defined?" with a jump target. It is NOT a full parser — it can
// miss unusual syntax and will not resolve overloads or scoping. Treat results
// as strong hints, not ground truth.

export interface SymbolDef {
  name: string;
  kind: string;
  line: number; // 1-indexed
  col: number; // 1-indexed (column where the name starts)
}

interface Rule {
  kind: string;
  re: RegExp; // must contain one capture group for the symbol name
}

const RULES: Rule[] = [
  // ---- JS / TS ----
  { kind: "class", re: /\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/ },
  { kind: "interface", re: /\b(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/ },
  { kind: "type", re: /\b(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*[=<]/ },
  { kind: "enum", re: /\b(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z0-9_$]+)/ },
  { kind: "function", re: /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/ },
  { kind: "function", re: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*[:=][^=]*=>/ },
  // ---- Python ----
  { kind: "class", re: /^\s*class\s+([A-Za-z0-9_]+)/ },
  { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/ },
  // ---- Go ----
  { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)\s*\(/ },
  { kind: "type", re: /^\s*type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)\b/ },
  // ---- Rust ----
  { kind: "function", re: /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/ },
  { kind: "struct", re: /\b(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/ },
  { kind: "enum", re: /\b(?:pub\s+)?enum\s+([A-Za-z0-9_]+)/ },
  { kind: "trait", re: /\b(?:pub\s+)?trait\s+([A-Za-z0-9_]+)/ },
  // ---- Java / C# / C++ (methods & types) ----
  { kind: "class", re: /\b(?:public|private|protected|internal|static|final|sealed|abstract|\s)*class\s+([A-Za-z0-9_]+)/ },
  { kind: "type", re: /\b(?:public|private|protected|internal|\s)*(?:struct|enum|interface)\s+([A-Za-z0-9_]+)/ },
  // ---- Ruby ----
  { kind: "method", re: /^\s*def\s+([A-Za-z0-9_?!]+)/ },
  { kind: "class", re: /^\s*(?:class|module)\s+([A-Za-z0-9_:]+)/ },
];

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--");
}

export function extractSymbols(source: string, maxSymbols = 2000): SymbolDef[] {
  const lines = source.split(/\r?\n/);
  const out: SymbolDef[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || isComment(line)) continue;

    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m && m[1]) {
        const name = m[1];
        const col = line.indexOf(name, m.index) + 1;
        const key = `${i + 1}:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ name, kind: rule.kind, line: i + 1, col: col > 0 ? col : 1 });
        }
        break; // one symbol per line
      }
    }
    if (out.length >= maxSymbols) break;
  }
  return out;
}

// ---- Imports (for the dependency graph) ----

export interface ImportRef {
  module: string; // raw module string as written
  line: number;
}

const IMPORT_RULES: RegExp[] = [
  /\bimport\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/, // JS/TS: import x from 'y' / import 'y'
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/, // JS: require('y')
  /\bexport\s+(?:[^'"]*\s+)?from\s+['"]([^'"]+)['"]/, // JS: export ... from 'y'
  /^\s*from\s+([A-Za-z0-9_.]+)\s+import\b/, // Python: from x import y
  /^\s*import\s+([A-Za-z0-9_.]+)/, // Python/Go/Java: import x
  /^\s*use\s+([A-Za-z0-9_:]+)/, // Rust: use x::y
];

export function extractImports(source: string): ImportRef[] {
  const lines = source.split(/\r?\n/);
  const out: ImportRef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || isComment(line)) continue;
    for (const re of IMPORT_RULES) {
      const m = re.exec(line);
      if (m && m[1]) {
        out.push({ module: m[1], line: i + 1 });
        break;
      }
    }
  }
  return out;
}
