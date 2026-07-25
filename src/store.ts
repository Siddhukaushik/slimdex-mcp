// On-disk persistence. Everything lives under <root>/.slimdex/ so it travels
// with the repo and survives restarts. Two files:
//   index.json   - the code symbol/import index, invalidated per-file by mtime
//   memory.json  - freeform memory facts the agent chooses to remember
//
// Reads are defensive where the file is a CACHE and strict where it is DATA.
// A corrupt index.json just gets rebuilt, so it yields a fresh empty structure
// rather than bricking the server. memory.json cannot be rebuilt from anything,
// so a corrupt one throws instead of quietly reading as empty — see loadMemory.
//
// Writes go through writeFileAtomic (temp + rename), so an interrupted write
// can never truncate the last good copy of state nobody else holds.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { SymbolDef, ImportRef } from "./symbols.js";

export interface FileEntry {
  mtimeMs: number;
  contentHash: string;
  lines: number;
  symbols: SymbolDef[];
  symbolsTruncated?: boolean;
  imports: ImportRef[];
}

// Bumped 1 -> 2 when extraction became string/comment-aware, then 2 -> 3 when
// per-file symbol-cap truncation became explicit. Old caches cannot say whether
// a 2,000-symbol file was complete, so they must be rebuilt rather than reused.
export const INDEX_VERSION = 3;

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

/**
 * Write via a temp file and a rename, so a reader never sees a half-written
 * file and an interrupted write cannot truncate the previous good one.
 *
 * A plain writeFile truncates the target and then streams into it: a crash,
 * a full disk or a killed process in that window leaves invalid JSON where
 * durable state used to be. rename() is atomic on POSIX, and Node's rename
 * replaces an existing destination on Windows too.
 *
 * The temp name carries the pid so two processes writing the same store cannot
 * collide on the scratch file, and the temp file is cleaned up on failure so a
 * bad write does not litter .slimdex/.
 */
async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
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
  await writeFileAtomic(indexPath(root), JSON.stringify(index));
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

function memoryPath(root: string): string {
  return path.join(dir(root), "memory.json");
}

/**
 * Load saved facts.
 *
 * The distinction that matters: a MISSING file is a fresh repo and yields an
 * empty store, but a file that EXISTS and cannot be parsed is a corrupt store
 * and throws. Returning empty for both is what made corruption unrecoverable —
 * loadMemory swallowed the parse error, handed back zero facts, and the next
 * memory_save happily wrote that empty store over the top. One badly-timed
 * write destroyed everything ever learned, and every tool reported success
 * throughout. Failing loudly keeps the bytes on disk, where they can be
 * repaired by hand; JSON that is merely truncated usually still holds every
 * fact but the last.
 */
export async function loadMemory(root: string): Promise<MemoryStore> {
  let raw: string;
  try {
    raw = await fs.readFile(memoryPath(root), "utf8");
  } catch {
    return { version: 1, facts: [] }; // genuinely absent — a new repo
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${memoryPath(root)} exists but is not valid JSON (${(e as Error).message}). ` +
        `Refusing to treat it as empty — that would overwrite your saved facts on the next save. ` +
        `The file is untouched: repair it, or move it aside to start fresh.`
    );
  }
  const store = parsed as MemoryStore;
  if (!store || store.version !== 1 || !Array.isArray(store.facts))
    throw new Error(
      `${memoryPath(root)} is not a slimdex memory store (expected {version:1, facts:[…]}). ` +
        `Refusing to overwrite it. Move it aside to start fresh.`
    );
  return store;
}

export async function saveMemory(root: string, mem: MemoryStore): Promise<void> {
  await ensureDir(root);
  await writeFileAtomic(memoryPath(root), JSON.stringify(mem, null, 2));
}

/**
 * Serialize read-modify-write cycles on one root's memory store.
 *
 * memory_save was load → push → save, with awaits either side. Two calls
 * overlapping meant both read the same array and the second write erased the
 * first fact — a silent lost update in the one file the whole design promises
 * is durable. Chaining per root makes the cycle atomic within this process.
 *
 * Honest limit: this is an in-process lock. Two slimdex servers pointed at the
 * same repo can still interleave; the atomic write below keeps the file valid
 * in that case, but a fact can still be lost. One server per root is the
 * normal deployment and the assumption here.
 */
const memoryLocks = new Map<string, Promise<unknown>>();

export async function updateMemory<T>(root: string, mutate: (mem: MemoryStore) => T | Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const prev = memoryLocks.get(key) ?? Promise.resolve();
  const run = prev.then(async () => {
    const mem = await loadMemory(root);
    const result = await mutate(mem);
    await saveMemory(root, mem);
    return result;
  });
  // Swallow failures on the CHAIN only, so one bad save can't reject every
  // later one; `run` itself still rejects for this caller.
  memoryLocks.set(key, run.catch(() => undefined));
  return run;
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
  await writeFileAtomic(path.join(dir(root), "digest.json"), JSON.stringify(digest, null, 2));
}
