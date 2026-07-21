// On-disk persistence. Everything lives under <root>/.codeglance/ so it travels
// with the repo and survives restarts. Two files:
//   index.json   - the code symbol/import index, invalidated per-file by mtime
//   memory.json  - freeform memory facts the agent chooses to remember
//
// All reads are defensive: a corrupt or missing file yields a fresh empty
// structure rather than throwing, so a bad cache never bricks the server.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { SymbolDef, ImportRef } from "./symbols.js";

export interface FileEntry {
  mtimeMs: number;
  lines: number;
  symbols: SymbolDef[];
  imports: ImportRef[];
}

// Bumped 1 -> 2 when symbol extraction became string/comment-aware and gained
// depth. A v1 index on disk was built by the old extractor and is full of
// declarations that don't exist (prose captured from inside template literals,
// locals reported as top-level), so it must be discarded rather than reused —
// mtime invalidation alone would keep serving the bad entries indefinitely.
export const INDEX_VERSION = 2;

export interface CodeIndex {
  version: number;
  builtAt: string;
  files: Record<string, FileEntry>; // key: repo-relative posix path
}

export interface MemoryFact {
  id: string;
  text: string;
  tags: string[];
  created: string;
}

export interface MemoryStore {
  version: 1;
  facts: MemoryFact[];
}

function dir(root: string): string {
  return path.join(root, ".codeglance");
}

async function ensureDir(root: string): Promise<void> {
  await fs.mkdir(dir(root), { recursive: true });
}

export async function loadIndex(root: string): Promise<CodeIndex> {
  try {
    const raw = await fs.readFile(path.join(dir(root), "index.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === INDEX_VERSION && parsed.files) return parsed as CodeIndex;
  } catch {
    /* fall through to fresh */
  }
  return { version: INDEX_VERSION, builtAt: new Date().toISOString(), files: {} };
}

export async function saveIndex(root: string, index: CodeIndex): Promise<void> {
  await ensureDir(root);
  index.builtAt = new Date().toISOString();
  await fs.writeFile(path.join(dir(root), "index.json"), JSON.stringify(index), "utf8");
}

export async function loadMemory(root: string): Promise<MemoryStore> {
  try {
    const raw = await fs.readFile(path.join(dir(root), "memory.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.facts)) return parsed as MemoryStore;
  } catch {
    /* fall through */
  }
  return { version: 1, facts: [] };
}

export async function saveMemory(root: string, mem: MemoryStore): Promise<void> {
  await ensureDir(root);
  await fs.writeFile(path.join(dir(root), "memory.json"), JSON.stringify(mem, null, 2), "utf8");
}
