// Compact code search. Returns matches as `path:line:col` plus the trimmed
// line and an optional caret "highlight" underline pointing at the match —
// enough for an agent to jump to the exact spot without the server streaming
// whole files back.

import { promises as fs } from "node:fs";
import path from "node:path";

export interface Match {
  file: string;
  line: number;
  col: number;
  text: string;
  highlight?: string;
}

function caret(text: string, col: number, len: number): string {
  const trimmedLead = text.length - text.trimStart().length;
  const pad = Math.max(0, col - 1 - trimmedLead);
  return " ".repeat(pad) + "^".repeat(Math.max(1, len));
}

export async function searchFiles(
  root: string,
  files: string[], // repo-relative posix paths
  pattern: string,
  opts: { regex?: boolean; ignoreCase?: boolean; maxMatches?: number; highlight?: boolean } = {}
): Promise<Match[]> {
  const max = opts.maxMatches ?? 200;
  let re: RegExp;
  try {
    re = opts.regex
      ? new RegExp(pattern, opts.ignoreCase ? "gi" : "g")
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), opts.ignoreCase ? "gi" : "g");
  } catch (e) {
    throw new Error(`Invalid pattern: ${(e as Error).message}`);
  }

  const out: Match[] = [];
  for (const rel of files) {
    if (out.length >= max) break;
    let source: string;
    try {
      source = await fs.readFile(path.join(root, rel), "utf8");
    } catch {
      continue;
    }
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < max; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) {
        const col = m.index + 1;
        const match: Match = { file: rel, line: i + 1, col, text: line.trim().slice(0, 240) };
        if (opts.highlight) match.highlight = caret(line, col, m[0].length).slice(0, 240);
        out.push(match);
      }
    }
  }
  return out;
}

export function formatMatches(matches: Match[]): string {
  if (matches.length === 0) return "No matches.";
  return matches
    .map((m) => {
      const loc = `${m.file}:${m.line}:${m.col}`;
      if (m.highlight) return `${loc}\n    ${m.text}\n    ${m.highlight}`;
      return `${loc}  ${m.text}`;
    })
    .join("\n");
}
