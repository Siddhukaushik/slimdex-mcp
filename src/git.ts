// Git awareness.
//
// The biggest remaining token sink at session start is a dirty repo: the agent
// shells out to `git diff` and the whole patch lands in context. This module
// answers the question the agent actually has — "what changed, and which
// functions did it land in?" — in a few hundred tokens, by intersecting the
// diff's changed line ranges with the symbol index.
//
// It shells out to the real git binary (no dependency) and degrades politely
// when the repo isn't a git checkout or git isn't installed.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toPosix } from "./indexer.js";
import { enclosingSymbol } from "./intel.js";
import type { CodeIndex } from "./store.js";

const run = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const msg = (e as { stderr?: string; message: string }).stderr || (e as Error).message;
    throw new Error(`git ${args[0]} failed: ${msg.trim().split("\n")[0]}`);
  }
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    const out = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export interface ChangedFile {
  file: string;
  status: string; // porcelain-ish: M, A, D, R, ?
  added: number;
  deleted: number;
  symbols: string[]; // enclosing symbols touched by the changed hunks
}

// `git diff --unified=0` gives hunk headers like `@@ -12,3 +14,6 @@`. The `+`
// side tells us which lines in the *current* file changed, which is exactly
// what we can map onto indexed symbol positions.
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function parseHunks(patch: string): Map<string, number[]> {
  const byFile = new Map<string, number[]>();
  let current: string | null = null;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim();
      current = p === "/dev/null" ? null : toPosix(p.replace(/^b\//, ""));
      if (current && !byFile.has(current)) byFile.set(current, []);
      continue;
    }
    const m = HUNK.exec(line);
    if (m && current) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      const lines = byFile.get(current)!;
      for (let i = 0; i < count; i++) lines.push(start + i);
    }
  }
  return byFile;
}

// base:
//   undefined -> working tree vs HEAD (plus untracked files)
//   "main", "HEAD~3", a sha -> that ref vs the working tree
export async function changedFiles(root: string, index: CodeIndex, base?: string): Promise<ChangedFile[]> {
  const diffArgs = base ? ["diff", "--unified=0", base] : ["diff", "--unified=0", "HEAD"];
  const statArgs = base ? ["diff", "--numstat", base] : ["diff", "--numstat", "HEAD"];

  const [patch, numstat] = await Promise.all([git(root, diffArgs), git(root, statArgs)]);
  const hunks = parseHunks(patch);

  const out: ChangedFile[] = [];
  for (const line of numstat.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [a, d, file] = line.split("\t");
    if (!file) continue;
    const rel = toPosix(file);
    const entry = index.files[rel];
    const touched = hunks.get(rel) ?? [];
    const names = new Set<string>();
    if (entry) {
      for (const ln of touched) {
        const enc = enclosingSymbol(entry, ln);
        if (enc) names.add(`${enc.kind} ${enc.name}`);
      }
    }
    out.push({
      file: rel,
      status: "M",
      added: a === "-" ? 0 : Number(a),
      deleted: d === "-" ? 0 : Number(d),
      // Cap the list: a file whose diff touches 40 functions should say so, not
      // print all 40 and undo the point of the tool.
      symbols: [...names].slice(0, 12),
    });
  }

  // Untracked files only make sense for the working-tree view.
  if (!base) {
    const untracked = await git(root, ["ls-files", "--others", "--exclude-standard"]);
    for (const f of untracked.split(/\r?\n/)) {
      if (!f.trim()) continue;
      const rel = toPosix(f.trim());
      const entry = index.files[rel];
      out.push({
        file: rel,
        status: "?",
        added: entry?.lines ?? 0,
        deleted: 0,
        symbols: entry ? entry.symbols.map((s) => `${s.kind} ${s.name}`).slice(0, 12) : [],
      });
    }
  }

  return out.sort((x, y) => y.added + y.deleted - (x.added + x.deleted));
}

export function formatChanged(files: ChangedFile[], base: string | undefined, limit: number): string {
  if (files.length === 0) return `No changes vs ${base ?? "HEAD"}.`;
  const shown = files.slice(0, limit);
  const rows = shown.map((f) => {
    const head = `  ${f.status} ${f.file}  +${f.added}/-${f.deleted}`;
    return f.symbols.length ? `${head}\n      touches: ${f.symbols.join(", ")}` : head;
  });
  const more = files.length > shown.length ? `\n  … ${files.length - shown.length} more file(s); raise limit` : "";
  return `${files.length} changed file(s) vs ${base ?? "HEAD (working tree)"}:\n${rows.join("\n")}${more}`;
}
