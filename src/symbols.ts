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
  // Match against the original line rather than the masked one. Only for rules
  // whose captured name is deliberately *inside* a string literal — a test
  // title — where masking would blank the very thing being captured. The line
  // is still skipped if masking shows it is entirely comment or string, so a
  // commented-out test doesn't get indexed.
  rawCapture?: boolean;
}

// A bare `name(args) {` line is indistinguishable from `if (cond) {` by shape
// alone, so the method rules below capture the name and then reject anything
// that is actually a control-flow keyword. Without this, every `if`/`for`/
// `catch` in the repo would be indexed as a method.
const NOT_A_METHOD = new Set([
  "if", "for", "while", "switch", "catch", "do", "else", "return", "function",
  "typeof", "delete", "new", "await", "yield", "case", "throw", "with", "in",
  "of", "try", "finally", "import", "export", "default",
  // C-family and Ruby block keywords that also take the shape `name (expr) {`.
  "synchronized", "lock", "using", "fixed", "unless", "until", "elsif", "foreach",
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
  // `var slc = function (v, s, e) {` — the function *expression*. Auditing
  // ~12,000 real framework files showed this as the single most-missed shape:
  // arrows were handled, this wasn't, and library and transpiled code is full
  // of it.
  {
    kind: "function",
    re: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?function\b/,
    topLevelOnly: true,
  },
  // `Foo.prototype.bar = function () {}`, `exports.render = function () {}`,
  // `obj.method = async function () {}` — assignment to a property. Ubiquitous
  // in pre-class JS, CommonJS modules and prototype-based libraries.
  {
    kind: "function",
    re: /^\s*(?:[A-Za-z0-9_$]+\.)+([A-Za-z0-9_$]+)\s*=\s*(?:async\s+)?function\b/,
  },
  // `render: function (props) {` — a function-valued property in an object
  // literal, which is how options objects, Vue components and older React
  // mixins declare their methods.
  { kind: "method", re: /^\s+([A-Za-z0-9_$]+)\s*:\s*(?:async\s+)?function\b/ },
  // `syncPortfolio: async () => {` — a property whose value is an ARROW
  // function. The sibling rules covered `: function` and bare `method() {}` but
  // not this, which is how most modern service objects, Pinia/Vuex stores, API
  // client maps and route handler tables declare their methods. A real field
  // report: get_symbol_context("syncPortfolio") found nothing because of it.
  //
  // The trailing `{` is what keeps a TypeScript type annotation out — in
  // `onClick: (e: Event) => void` the arrow describes a signature, not a
  // definition, and indexing those would send lookups to interface members
  // instead of implementations.
  //
  // NOT_A_METHOD still applies: iterator-protocol objects legitimately define
  // `return: () => {}` and `throw: () => {}`, which are real properties but
  // useless index entries — a lookup for "return" helps nobody.
  {
    kind: "method",
    re: /^\s+([A-Za-z0-9_$]+)\s*:\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>\s*\{\s*\}?\s*$/,
    reject: NOT_A_METHOD,
  },
  // Java 16+ / C# records. Must sit ABOVE the method rules: a record's component
  // list looks exactly like a parameter list, so `record Decision(String a) {}`
  // was being indexed as a METHOD called Decision — and a record whose
  // components wrap across lines (the usual shape once there are three of them)
  // matched nothing at all, because the method rule needs `(…)` closed on one
  // line. The reported symptom was get_symbol_context name:"Decision" answering
  // "No definition indexed" for a record that was plainly there.
  //
  // Deliberately NOT anchored to nesting depth: records are declared both at top
  // level and inside a class, and the earlier diagnosis that "the parser doesn't
  // index inner types" was wrong — nested classes index fine. The gap was the
  // keyword, at every depth.
  //
  // Requires `(` or `{` after the name so this cannot fire on an identifier that
  // merely happens to be called `record` in another language.
  {
    kind: "type",
    re: /^\s*(?:(?:public|private|protected|internal|static|final|sealed|abstract)\s+)*record\s+([A-Za-z0-9_$]+)\s*(?:<[^>]*>)?\s*[({]/,
  },
  // Class / object-literal methods: `async getUser(id): Promise<T> {`, `get name() {`,
  // `constructor(x) {`. Requires leading indentation (methods are always nested)
  // and a trailing `{`, which together with NOT_A_METHOD keeps `if (…) {` out.
  {
    kind: "method",
    // The tail used to be `\{\s*\}?\s*$` — the brace had to be the LAST thing on
    // the line. That silently excluded every single-line body:
    // `async fetchUser(id): Promise<T> { return this.opts; }` indexed as nothing,
    // while the identical method written across three lines indexed fine. Real
    // code writes one-liners constantly (getters, delegating methods, guards),
    // so this was not an edge case — it was a rule written against the shape
    // someone pictured rather than the shapes people type. `\{.*$` accepts the
    // body; NOT_A_METHOD and the two-token shape are what keep control flow out,
    // and neither depends on the tail.
    re: /^[ \t]+(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*(?:\*\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(.*\)\s*(?::\s*[^{;]+)?\{.*$/,
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
      // Modifiers are OPTIONAL: package-private Java methods (`void run() {`)
      // have none, and requiring one made them invisible. What keeps this from
      // matching control flow is the shape it demands — two identifiers (return
      // type then name) before the parenthesis, where `if (cond) {` has one —
      // plus the statement-keyword guard.
      "^[ \\t]+(?!(?:return|throw|new|else|case|await|yield|delete|typeof)\\b)" +
        // Annotations on the SAME line as the signature. Apex writes these
        // inline constantly — `@isTest static void t() {}`, `@AuraEnabled public
        // static List<Account> get() {}`, `@future(callout=true) …` — and every
        // one of them was invisible, because the rule expected a modifier or a
        // return type first and found an `@`. An annotation on its own line
        // always worked, which is why this hid: the same method indexes or not
        // depending purely on where the author put a newline. Salesforce test
        // classes and LWC controllers are ~entirely these two forms.
        "(?:@[A-Za-z_][A-Za-z0-9_.]*\\s*(?:\\([^)]*\\))?\\s+)*" +
        // `testMethod` is legacy Apex's own test marker and behaves as a
        // modifier: `static testMethod void legacyTest() {`.
        "(?:(?:public|private|protected|internal|global|static|final|virtual|override|abstract|sealed|synchronized|async|unsafe|transient|webservice|testMethod)\\s+)*" +
        // Optional generic type parameter, as in `static <T> Optional<T> firstOf(…)`.
        "(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>\\s+)?" +
        RETURN_TYPE +
        "\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(.*\\)\\s*(?:\\{|$)"
    ),
    reject: NOT_A_METHOD,
  },
  // Interface / abstract method declarations: a signature with no body, ending
  // in `;` and often with no access modifier at all — `void save(Order o);`,
  // `Map<Id, Account> byId(Set<Id> ids);`. Interface-heavy frameworks (fflib,
  // Spring, any DI container) are mostly made of these, and they're exactly the
  // names you navigate to, so the modifier-required rules above miss the point.
  //
  // The lookahead is what keeps this safe: without it, an ordinary statement
  // like `return foo(x);` parses as return-type `return`, name `foo`, and gets
  // indexed as a declaration.
  {
    kind: "method",
    re: new RegExp(
      "^[ \\t]+(?!(?:return|throw|new|else|case|await|yield|delete|typeof)\\b)" +
        "(?:(?:public|private|protected|internal|global|abstract|static|default)\\s+)*" +
        "(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>\\s+)?" +
        RETURN_TYPE +
        "\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\([^;{]*\\)\\s*;\\s*$"
    ),
    reject: NOT_A_METHOD,
  },
  // ---- Test DSLs ----
  // A test file's navigable units are its test names, not its functions — a
  // vitest/jest/mocha/RSpec suite frequently has zero top-level declarations and
  // so indexed to nothing at all, which made whole test directories invisible.
  // `describe`/`it`/`test` are close to universal across JS, TS and Ruby test
  // frameworks, and the quoted title is the thing a developer searches for.
  {
    kind: "test",
    re: /^\s*(?:export\s+)?(?:describe|it|test|context|suite|bench|scenario|feature)(?:\.\w+)?\s*\(\s*['"`]([^'"`]{1,80})['"`]/,
    rawCapture: true,
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
  // ---- C / C++ ----
  { kind: "namespace", re: /^\s*namespace\s+([A-Za-z_][\w:]*)/ },
  // Out-of-class definitions: `void Foo::bar(int) {`, `Foo::Foo()`,
  // `Foo::~Foo()`. These are where C++ method *bodies* live, and no other rule
  // saw them. Rejecting a trailing `;` keeps qualified *calls* out.
  {
    kind: "method",
    // Tail is `(?:\{.*)?$`: either the line ends (brace on the next line) or a
    // brace opens an inline body. `void Engine::stop() {}` is the commonest way
    // to write a trivial out-of-class definition and the old `\{?\s*$` missed
    // every one. It must NOT relax to `.*$` — that admits a trailing `;`, and
    // `Widget::render(ctx);` is a qualified CALL, not a definition.
    re: /^[\w:<>,*&~\s]*?\b[A-Za-z_]\w*::(~?[A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\b\s*)?(?:noexcept\b\s*)?(?:\{.*)?$/,
    reject: NOT_A_METHOD,
  },
  // Free functions at column 0: `static void helper(void) {`, `char *dup(...)`.
  // The indented-method rules above all require leading whitespace, so plain C
  // functions were completely invisible. Demands two identifiers before the
  // paren (return type then name) so a call like `foo(x)` can't match, plus a
  // statement-keyword guard for the scripting languages where top-level calls
  // are legal (`assert validate(x)`, `puts render(x)`).
  {
    kind: "function",
    re: new RegExp(
      "^(?!(?:if|for|while|switch|return|else|do|goto|typedef|using|namespace|template|case|new|delete|throw|await|yield|" +
        "assert|print|puts|raise|require|require_relative|include|extend|del|not|and|or|elif|elsif|unless|until|import|export|declare|package|" +
        // words that open a declaration some LATER, better-typed rule owns
        "trigger|def|fun|func|fn)\\b)" +
        // Same one-line-body fix: `static void helper(void) {}` and
        // `int main(int argc, char** argv) { return 0; }` both ended in content
        // after the brace, so both were invisible. The declaration shape — two
        // identifiers before the paren — is what excludes calls, not the tail.
        "(?:[A-Za-z_]\\w*(?:\\s*\\*+\\s*|\\s+))+\\**([A-Za-z_]\\w*)\\s*\\([^;]*\\)\\s*(?:\\{.*)?$"
    ),
    reject: NOT_A_METHOD,
  },
  // Function-like macros: `#define MAX(a, b) …`. Requires the `(` to touch the
  // name — exactly the C preprocessor's own rule — which is also what keeps a
  // Python comment like `# define the schema (see docs)` from matching.
  { kind: "macro", re: /^\s*#\s*define\s+([A-Za-z_]\w*)\(/ },
  // `typedef struct { … } Name;` — the name lives on the closing line.
  { kind: "type", re: /^\}\s*([A-Za-z_]\w*)\s*;\s*$/ },
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
  // Ruby attribute declarations: `attr_accessor :name, :age`. These generate
  // the reader/writer a caller navigates to, so they ARE the declaration site.
  // (Only the first name on the line is captured — one symbol per line.)
  { kind: "attribute", re: /^\s*attr_(?:accessor|reader|writer)\s+:([A-Za-z_]\w*[?!]?)/ },
  // ---- Objective-C ----
  { kind: "class", re: /^\s*@(?:interface|implementation|protocol)\s+([A-Za-z_]\w*)/ },
  { kind: "method", re: /^\s*[-+]\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)/ },
];

function isComment(line: string): boolean {
  const t = line.trim();
  // `#` is a Python/Ruby comment — except a C function-like macro, which the
  // macro rule needs to see. `#define NAME(` can't occur in a prose comment
  // because the paren must touch the name (the preprocessor's own rule).
  if (t.startsWith("#")) return !/^#\s*define\s+[A-Za-z_]\w*\(/.test(t);
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("--");
}

// ---- CSS / SCSS / LESS ----
//
// These extensions were indexed for TEXT SEARCH but emitted no symbols at all,
// so a stylesheet skeletoned to "(no declarations detected)", `.swarm-flow` was
// invisible to find_definition, and replace_symbol could not address a rule.
// On a frontend repo (one real case: 60 .jsx + 32 .css) that is most of the
// file tree missing from every symbol-shaped tool.
//
// A rule is addressed by the class/id names in its selector list, not by the
// raw selector text: `.hub-card.hub-allow-overflow` should be findable under
// EITHER name, which is what you actually reach for. Several names can share
// one line, capped so a deeply compound selector cannot flood the index.
export const CSS_FILE = /\.(css|scss|less)$/i;
const MAX_SELECTOR_NAMES = 4;

function extractCssSymbols(source: string, maxSymbols: number): SymbolDef[] {
  const out: SymbolDef[] = [];
  for (const [i, { line, masked }] of scanLines(source).entries()) {
    if (!masked.trim()) continue;
    const openIdx = masked.indexOf("{");
    if (openIdx < 0) continue; // a declaration, not a rule opening
    const head = masked.slice(0, openIdx).trim();
    if (!head) continue;

    // At-rules first, so `@media (max-width: 700px) {` is not read as a selector.
    const at = /^@([A-Za-z-]+)\s*(.*)$/.exec(head);
    if (at) {
      const cond = at[2].trim().replace(/\s+/g, " ").slice(0, 60);
      const name = at[1] === "keyframes" || at[1] === "font-face" ? `@${at[1]} ${cond}`.trim() : `@${at[1]}${cond ? " " + cond : ""}`;
      out.push({ name, kind: "at-rule", line: i + 1, col: line.indexOf("@") + 1 || 1, depth: 0 });
      if (out.length >= maxSymbols) break;
      continue;
    }

    // Every distinct class/id mentioned in the selector list.
    const names: string[] = [];
    for (const m of head.matchAll(/[.#][A-Za-z_-][A-Za-z0-9_-]*/g)) {
      if (!names.includes(m[0])) names.push(m[0]);
      if (names.length >= MAX_SELECTOR_NAMES) break;
    }
    for (const n of names) {
      out.push({ name: n, kind: "rule", line: i + 1, col: (line.indexOf(n) + 1) || 1, depth: 0 });
      if (out.length >= maxSymbols) return out;
    }
  }
  return out;
}

export function extractSymbols(source: string, maxSymbols = 2000, file?: string): SymbolDef[] {
  // Stylesheets get their own extractor rather than sharing the rule list: the
  // JS/Java rules would match nothing useful in CSS, and a selector regex let
  // loose on JavaScript would happily read `.filter(x => {` as a class rule.
  if (file && CSS_FILE.test(file)) return extractCssSymbols(source, maxSymbols);
  return extractCodeSymbols(source, maxSymbols);
}

function extractCodeSymbols(source: string, maxSymbols = 2000): SymbolDef[] {
  const out: SymbolDef[] = [];
  const seen = new Set<string>();

  // Rules are matched against the *masked* line, where string and comment
  // contents have been blanked to spaces. Prose that happens to look like a
  // declaration ("…the functions you need…") no longer registers as one, and
  // because masking preserves length, columns still point into the real line.
  for (const [i, { line, masked, depth }] of scanLines(source).entries()) {
    if (!masked.trim() || isComment(line)) continue;

    for (const rule of RULES) {
      const subject = rule.rawCapture ? line : masked;
      const m = rule.re.exec(subject);
      if (m && m[1]) {
        const name = m[1];
        if (rule.reject?.has(name)) continue; // keyword, not a declaration — try the next rule
        if (rule.topLevelOnly && depth > 0) continue; // a local, not a declaration
        const col = subject.indexOf(name, m.index) + 1;
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
