// Lightweight, regex-based code outlining.
//
// This is deliberately NOT a full parser. It scans line-by-line for the
// declaration patterns that matter most when an agent is orienting in a file
// (functions, classes, methods, exports). It will miss exotic syntax and can
// occasionally match a declaration inside a string/comment. That trade-off is
// intentional: the goal is a cheap, language-agnostic map that costs a few
// hundred tokens instead of dumping a multi-thousand-token file.

export interface OutlineEntry {
  line: number; // 1-indexed
  kind: string;
  text: string;
}

interface Rule {
  kind: string;
  re: RegExp;
  reject?: Set<string>; // captured names that are keywords, not declarations
}

// Mirrors symbols.ts: a bare `name(args) {` looks exactly like `if (cond) {`,
// so the method rules capture the name and discard control-flow keywords.
const NOT_A_METHOD = new Set([
  "if", "for", "while", "switch", "catch", "do", "else", "return", "function",
  "typeof", "delete", "new", "await", "yield", "case", "throw", "with", "in",
  "of", "try", "finally", "import", "export", "default",
]);

const COMMON: Rule[] = [
  // JS / TS
  { kind: "class", re: /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+([A-Za-z0-9_]+)/ },
  { kind: "interface", re: /^\s*(export\s+)?interface\s+([A-Za-z0-9_]+)/ },
  { kind: "type", re: /^\s*(export\s+)?type\s+([A-Za-z0-9_]+)\s*=/ },
  { kind: "enum", re: /^\s*(export\s+)?(const\s+)?enum\s+([A-Za-z0-9_]+)/ },
  {
    kind: "function",
    re: /^\s*(export\s+)?(default\s+)?(async\s+)?function\s*\*?\s*([A-Za-z0-9_]+)/,
  },
  // const foo = (...) => / const foo = async (...) =>
  {
    kind: "function",
    re: /^\s*(export\s+)?(const|let|var)\s+([A-Za-z0-9_]+)\s*[:=].*=>\s*\{?\s*$/,
  },
  // JS/TS class & object-literal methods (see NOT_A_METHOD above)
  {
    kind: "method",
    re: /^[ \t]+(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*(?:\*\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(.*\)\s*(?::\s*[^{;]+)?\{\s*\}?\s*$/,
    reject: NOT_A_METHOD,
  },
  // Python
  { kind: "class", re: /^\s*class\s+([A-Za-z0-9_]+)/ },
  { kind: "function", re: /^\s*(async\s+)?def\s+([A-Za-z0-9_]+)/ },
  // Go
  { kind: "function", re: /^\s*func\s+(\([^)]*\)\s*)?[A-Za-z0-9_]+\s*\(/ },
  { kind: "type", re: /^\s*type\s+[A-Za-z0-9_]+\s+(struct|interface)\b/ },
  // Rust
  { kind: "function", re: /^\s*(pub\s+)?(async\s+)?fn\s+[A-Za-z0-9_]+/ },
  { kind: "struct", re: /^\s*(pub\s+)?struct\s+[A-Za-z0-9_]+/ },
  { kind: "impl", re: /^\s*impl(\s|<)/ },
  // Java / C#. The modifier group must match at least one *real* modifier: the
  // previous version allowed a bare `\s` alternative, which made this rule match
  // every `if (cond) {` and `for (…) {` in any C-family file and report it as a
  // method. Return type and name are now separate so `reject` can see the name.
  {
    kind: "method",
    re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|sealed|synchronized|async)\s+)+[A-Za-z0-9_<>\[\],.]+\s+([A-Za-z0-9_]+)\s*\([^;{]*\)\s*\{?\s*$/,
    reject: NOT_A_METHOD,
  },
];

// Cheap heuristic to skip lines that are clearly comments.
function isComment(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("#") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("--")
  );
}

export function outline(source: string, maxEntries = 400): OutlineEntry[] {
  const lines = source.split(/\r?\n/);
  const entries: OutlineEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || isComment(line)) continue;

    for (const rule of COMMON) {
      const m = rule.re.exec(line);
      if (m) {
        if (rule.reject && m[1] && rule.reject.has(m[1])) continue;
        entries.push({
          line: i + 1,
          kind: rule.kind,
          text: line.trim().slice(0, 200),
        });
        break; // one kind per line
      }
    }
    if (entries.length >= maxEntries) break;
  }

  return entries;
}

export function formatOutline(path: string, entries: OutlineEntry[], totalLines: number): string {
  if (entries.length === 0) {
    return `${path} (${totalLines} lines)\n  (no declarations detected — this outliner is regex-based; use read_lines to inspect directly)`;
  }
  const body = entries.map((e) => `  ${String(e.line).padStart(5)}  ${e.kind.padEnd(9)} ${e.text}`).join("\n");
  return `${path} (${totalLines} lines, ${entries.length} declarations)\n${body}`;
}
