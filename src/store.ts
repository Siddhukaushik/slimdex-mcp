// On-disk persistence. Everything lives under <root>/.slimdex/ so it travels
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
  // Decision provenance: a compact note of what the agent was looking at when
  // this conclusion was saved, pulled from the journal. Optional so older facts
  // (and any client that doesn't populate it) round-trip unchanged.
  context?: string;
}

export interface MemoryStore {
  version: 1;
  facts: MemoryFact[];
}

function dir(root: string): string {
  return path.join(root, ".slimdex");
}

async function ensureDir(root: string): Promise<void> {
  await fs.mkdir(dir(root), { recursive: true });
  // Self-ignoring cache, the node_modules/.cache trick: a `*` gitignore inside
  // the directory keeps it out of the repo's status without requiring the user
  // to edit their own .gitignore. Written once; never overwrites an edit.
  const ignore = path.join(dir(root), ".gitignore");
  try {
    await fs.writeFile(ignore, "*\n", { flag: "wx" });
  } catch {
    /* already exists */
  }
}

// Every tool call needs the index, and re-reading + re-parsing it from disk each
// time is pure overhead that grows with the repo: on a 5,000-file project the
// index is ~3.8 MB, which costs roughly 20 ms per call before any actual work.
// So keep the parsed object in memory, keyed on the file's mtime — a stat() is
// cheap, and any writer (this process or another) bumps the mtime, so a stale
// cache can't survive.
let indexCache: { root: string; mtimeMs: number; index: CodeIndex } | null = null;

function indexPath(root: string): string {
  return path.join(dir(root), "index.json");
}

export async function loadIndex(root: string): Promise<CodeIndex> {
  const file = indexPath(root);
  try {
    const st = await fs.stat(file);
    if (indexCache && indexCache.root === root && indexCache.mtimeMs === st.mtimeMs) {
      return indexCache.index;
    }
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === INDEX_VERSION && parsed.files) {
      indexCache = { root, mtimeMs: st.mtimeMs, index: parsed as CodeIndex };
      return parsed as CodeIndex;
    }
  } catch {
    /* fall through to fresh */
  }
  return { version: INDEX_VERSION, builtAt: new Date().toISOString(), files: {} };
}

export async function saveIndex(root: string, index: CodeIndex): Promise<void> {
  await ensureDir(root);
  index.builtAt = new Date().toISOString();
  await fs.writeFile(indexPath(root), JSON.stringify(index), "utf8");
  // Seed the cache from what we just wrote rather than waiting for the next
  // read to re-parse it. Set explicitly instead of relying on mtime comparison,
  // so this is correct even where the filesystem's timestamp resolution is coarse.
  try {
    const st = await fs.stat(indexPath(root));
    indexCache = { root, mtimeMs: st.mtimeMs, index };
  } catch {
    indexCache = null;
  }
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

// The architecture digest: one compact, agent-authored "how this repo works"
// note, so a future session reads a page instead of re-exploring the code. Kept
// separate from memory (which is many small facts) because it's a single living
// document with its own freshness lifecycle.
export interface DigestStore {
  version: 1;
  text: string;
  covers: string[]; // repo-relative paths/prefixes this digest summarizes (empty = whole repo)
  savedAt: string; // ISO; freshness is measured against this
}

export async function loadDigest(root: string): Promise<DigestStore | null> {
  try {
    const raw = await fs.readFile(path.join(dir(root), "digest.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && typeof parsed.text === "string") return parsed as DigestStore;
  } catch {
    /* none yet */
  }
  return null;
}

export async function saveDigest(root: string, digest: DigestStore): Promise<void> {
  await ensureDir(root);
  await fs.writeFile(path.join(dir(root), "digest.json"), JSON.stringify(digest, null, 2), "utf8");
}
