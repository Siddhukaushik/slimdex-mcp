// Multi-language symbol extraction (definitions).
//
// Heuristic and regex-based on purpose: no native deps, works on any language
// we have a rule for, and costs microseconds per file. It captures the *name*
// of each declaration plus its line/column so the index can answer
// "where is X defined?" with a jump target. It is NOT a full parser — it can
// miss unusual syntax and will not resolve overloads or scoping. Treat results
// as strong hints, not ground truth.

import { scanLines } from "./lexer.js";

export interface SymbolDef {
  name: string;
  kind: string;
  line: number; // 1-indexed
  col: number; // 1-indexed (column where the name starts)
  depth?: number; // brace nesting at the declaration; 0 = top level
}

interface Rule {
  kind: string;
  re: RegExp; // must contain one capture group for the symbol name
  reject?: Set<string>; // names that are never symbols (control-flow keywords)
  // `const x = () => …` and `type X = …` are declarations at top level and
  // *locals* anywhere else. Indexing every local closure inside a function body
  // buries the real declarations in noise, which is the opposite of this
  // server's job — so these rules only fire at depth 0.
  topLevelOnly?: boolean;
}

// A bare `name(args) {` line is indistinguishable from `if (cond) {` by shape
// alone, so the method rules below capture the name and then reject anything
// that is actually a control-flow keyword. Without this, every `if`/`for`/
// `catch` in the repo would be indexed as a method.
const NOT_A_METHOD = new Set([
  "if", "for", "while", "switch", "catch", "do", "else", "return", "function",
  "typeof", "delete", "new", "await", "yield", "case", "throw", "with", "in",
  "of", "try", "finally", "import", "export", "default",
]);

// A type reference with optional generics (one level of nesting, spaces allowed
// inside them) and optional array suffix: `Decimal`, `List<SK_ACH_Investor__c>`,
// `Map<String, Decimal>`, `Map<String, List<Foo>>`, `String[]`.
const RETURN_TYPE = "[A-Za-z_$][A-Za-z0-9_$.]*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?(?:\\[\\])*";

const RULES: Rule[] = [
  // ---- JS / TS ----
  { kind: "class", re: /\b(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/ },
  { kind: "interface", re: /\b(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/ },
  { kind: "type", re: /\b(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*[=<]/, topLevelOnly: true },
  { kind: "enum", re: /\b(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z0-9_$]+)/ },
  // The `\b` after `function` is load-bearing: without it the word "functions"
  // in prose matched, with `\s*` matching empty and `s` captured as the name.
  { kind: "function", re: /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b\s*\*?\s*([A-Za-z0-9_$]+)/ },
  { kind: "function", re: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*[:=][^=]*=>/, topLevelOnly: true },
  // Class / object-literal methods: `async getUser(id): Promise<T> {`, `get name() {`,
  // `constructor(x) {`. Requires leading indentation (methods are always nested)
  // and a trailing `{`, which together with NOT_A_METHOD keeps `if (…) {` out.
  {
    kind: "method",
    re: /^[ \t]+(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*(?:\*\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(.*\)\s*(?::\s*[^{;]+)?\{\s*\}?\s*$/,
    reject: NOT_A_METHOD,
  },
  // Java / C# / Apex methods, where a return type sits between the modifiers and
  // the name: `public async Task<int> GetUser(string id) {`. At least one
  // modifier is required so this can't swallow arbitrary expressions.
  //
  // The return type must tolerate spaces inside generics: the old character
  // class `[A-Za-z0-9_$<>\[\],.]*` had no space, so `Map<String, Decimal>` —
  // idiomatic in Apex and common in Java/C# — silently failed to match and the
  // method was never indexed. RETURN_TYPE below allows one level of nesting,
  // covering `Map<String, List<Foo>>`, plus array suffixes.
  {
    kind: "method",
    re: new RegExp(
      "^[ \\t]+(?:(?:public|private|protected|internal|global|static|final|virtual|override|abstract|sealed|synchronized|async|unsafe|transient|webservice)\\s+)+" +
        // Optional generic type parameter, as in `static <T> Optional<T> firstOf(…)`.
        "(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>\\s+)?" +
        RETURN_TYPE +
        "\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(.*\\)\\s*(?:\\{|$)"
    ),
    reject: NOT_A_METHOD,
  },
  // ---- Python ----
  { kind: "class", re: /^\s*class\s+([A-Za-z0-9_]+)/ },
  // The `self.` prefix is Ruby's class-method syntax, not Python's — but this
  // rule is earlier in the list, so it must skip the prefix too or it captures
  // `self` from `def self.build` and the Ruby rule never gets a turn.
  { kind: "function", re: /^\s*(?:async\s+)?def\s+(?:self\.)?([A-Za-z0-9_]+)/ },
  // ---- Go ----
  { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)\s*\(/ },
  { kind: "type", re: /^\s*type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)\b/ },
  // ---- Rust ----
  // Container rules come BEFORE `fn`, because only one symbol is taken per line
  // and `pub trait Handler { fn serve(&self); }` would otherwise report `serve`
  // and lose the trait entirely.
  { kind: "struct", re: /\b(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/ },
  { kind: "enum", re: /\b(?:pub\s+)?enum\s+([A-Za-z0-9_]+)/ },
  { kind: "trait", re: /\b(?:pub\s+)?trait\s+([A-Za-z0-9_]+)/ },
  { kind: "function", re: /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/ },
  // ---- Kotlin ----
  { kind: "object", re: /^\s*(?:companion\s+)?object\s+([A-Za-z0-9_]+)/ },
  {
    kind: "function",
    re: /^\s*(?:(?:public|private|protected|internal|open|override|suspend|inline|operator|abstract|final|tailrec)\s+)*fun\s+(?:<[^>]*>\s*)?([A-Za-z0-9_]+)/,
  },
  // ---- Swift ----
  { kind: "protocol", re: /^\s*(?:(?:public|private|fileprivate|internal|open)\s+)?protocol\s+([A-Za-z0-9_]+)/ },
  {
    kind: "function",
    re: /^\s*(?:(?:public|private|fileprivate|internal|open|static|class|final|override|mutating|convenience)\s+)*func\s+([A-Za-z0-9_]+)/,
  },
  // ---- Java / C# / C++ (methods & types) ----
  { kind: "class", re: /\b(?:public|private|protected|internal|static|final|sealed|abstract|\s)*class\s+([A-Za-z0-9_]+)/ },
  { kind: "type", re: /\b(?:public|private|protected|internal|\s)*(?:struct|enum|interface)\s+([A-Za-z0-9_]+)/ },
  // ---- Apex trigger ----
  { kind: "trigger", re: /^\s*trigger\s+([A-Za-z0-9_]+)\s+on\b/ },
  // ---- Ruby / Scala ----
  // Modifiers may precede `def` in Scala (`private def helper`), and Ruby class
  // methods are written `def self.build` — capturing `self` there is useless.
  {
    kind: "method",
    re: /^\s*(?:(?:private|protected|public|override|final|implicit|lazy)\s+)*def\s+(?:self\.)?([A-Za-z0-9_?!]+)/,
  },
  { kind: "class", re: /^\s*(?:class|module)\s+([A-Za-z0-9_:]+)/ },
  // ---- Objective-C ----
  { kind: "method", re: /^\s*[-+]\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)/ },
];

function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--");
}

export function extractSymbols(source: string, maxSymbols = 2000): SymbolDef[] {
  const out: SymbolDef[] = [];
  const seen = new Set<string>();

  // Rules are matched against the *masked* line, where string and comment
  // contents have been blanked to spaces. Prose that happens to look like a
  // declaration ("…the functions you need…") no longer registers as one, and
  // because masking preserves length, columns still point into the real line.
  for (const [i, { line, masked, depth }] of scanLines(source).entries()) {
    if (!masked.trim() || isComment(line)) continue;

    for (const rule of RULES) {
      const m = rule.re.exec(masked);
      if (m && m[1]) {
        const name = m[1];
        if (rule.reject?.has(name)) continue; // keyword, not a declaration — try the next rule
        if (rule.topLevelOnly && depth > 0) continue; // a local, not a declaration
        const col = masked.indexOf(name, m.index) + 1;
        const key = `${i + 1}:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ name, kind: rule.kind, line: i + 1, col: col > 0 ? col : 1, depth });
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
  const out: ImportRef[] = [];
  // Imports are matched on the real line, not the masked one: the module
  // specifier *is* a string, so masking would blank the very thing we capture.
  // The masked line is still used to reject lines that are entirely inside a
  // comment or a template literal — an `import` written in prose isn't an edge.
  for (const [i, { line, masked }] of scanLines(source).entries()) {
    if (!line.trim() || isComment(line) || !masked.trim()) continue;
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
