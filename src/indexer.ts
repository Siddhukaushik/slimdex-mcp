// Repo walking + incremental indexing. Walks the tree once, skipping the usual
// noise dirs and binary/large files, and (re)parses only files whose mtime
// changed since the last build. The result is cached to disk by store.ts.

import { promises as fs } from "node:fs";
import path from "node:path";
import { extractSymbols, extractImports } from "./symbols.js";
import { loadIndex, saveIndex, type CodeIndex, type FileEntry } from "./store.js";

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", "target",
  "__pycache__", ".venv", "venv", "env", ".idea", ".vscode", "coverage",
  ".leanctx", ".cache", "vendor", "bin", "obj", ".gradle", ".mvn",
]);

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
  ".java", ".cs", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cc",
  ".kt", ".swift", ".scala", ".m", ".mm", ".vue", ".svelte",
]);

const MAX_FILE_BYTES = 1_500_000; // skip anything larger; almost certainly generated

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

async function walk(root: string, dir: string, acc: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".env.example") {
      if (IGNORE_DIRS.has(e.name)) continue;
    }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      await walk(root, full, acc);
    } else if (e.isFile()) {
      if (CODE_EXT.has(path.extname(e.name).toLowerCase())) acc.push(full);
    }
  }
}

export interface IndexResult {
  index: CodeIndex;
  parsed: number;
  reused: number;
  removed: number;
  totalFiles: number;
}

export async function buildOrRefresh(root: string, force = false): Promise<IndexResult> {
  const index = force ? { version: 1 as const, builtAt: "", files: {} } : await loadIndex(root);

  const files: string[] = [];
  await walk(root, root, files);

  const present = new Set<string>();
  let parsed = 0;
  let reused = 0;

  for (const full of files) {
    const rel = toPosix(path.relative(root, full));
    present.add(rel);
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;

    const existing = index.files[rel];
    if (existing && existing.mtimeMs === stat.mtimeMs) {
      reused++;
      continue;
    }
    let source: string;
    try {
      source = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const entry: FileEntry = {
      mtimeMs: stat.mtimeMs,
      lines: source.split(/\r?\n/).length,
      symbols: extractSymbols(source),
      imports: extractImports(source),
    };
    index.files[rel] = entry;
    parsed++;
  }

  // drop deleted files
  let removed = 0;
  for (const rel of Object.keys(index.files)) {
    if (!present.has(rel)) {
      delete index.files[rel];
      removed++;
    }
  }

  await saveIndex(root, index);
  return { index, parsed, reused, removed, totalFiles: present.size };
}
