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
import { randomUUID } from "node:crypto";
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
// 4: minified build output is now detected by line shape and excluded. A v3
// index was built before that check existed, and its entries survive on mtime
// alone — so the bundles it already holds would never be re-examined. Bumping
// forces one full reparse, after which they are gone.
//
// 5: the parser now finds symbols it used to miss — Java/C# records, Apex
// methods whose annotation shares the signature's line (`@isTest static void
// t() {}`), and any single-line body (`int main(...) { return 0; }`, `void
// Engine::stop() {}`) — plus generated documentation is excluded and Salesforce
// `-meta.xml` sidecars are included.
//
// Every one of those changes WHAT a correct index contains, and none of them
// would have reached an existing user: entries are reused on mtime, so a file
// nobody edits keeps whatever the old rules extracted from it. Without this
// bump, `record Decision` stays missing on exactly the repos that reported it.
// The cost is one full reparse — 24s on a 39,000-file checkout, once.
export const INDEX_VERSION = 5;

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
 * The scratch name must be unique per WRITE, not per process. pid + millisecond
 * was neither: two writes in the same millisecond of the same process produced
 * the same temp path, so one renamed the file away and the other failed on a
 * path that no longer existed. Measured at 100 concurrent saves: 5 succeeded,
 * 95 died with ENOENT. A uuid makes the name unique, and `wx` (exclusive
 * create) turns any residual collision into a loud failure rather than two
 * writers streaming into one file.
 *
 * The temp file is cleaned up on failure so a bad write does not litter
 * .slimdex/.
 */
async function writeFileAtomic(file: string, data: string): Promise<void> {
  // Serialize per destination. A unique temp name stops two writers sharing a
  // scratch file, but it does NOT make the rename safe: Windows fails a
  // concurrent atomic replace of the same destination with EPERM (measured, 27
  // of 100). Queueing per file removes self-inflicted contention outright,
  // which is the only kind this process can actually control.
  const key = path.resolve(file);
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const run = prev.then(() => atomicWriteOnce(file, data));
  // Failures must not poison the queue for later writers; `run` still rejects
  // for this caller.
  writeQueues.set(key, run.catch(() => undefined));
  return run;
}

const writeQueues = new Map<string, Promise<unknown>>();

async function atomicWriteOnce(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data, { encoding: "utf8", flag: "wx" });
    await renameWithRetry(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Rename, retrying the transient Windows failures.
 *
 * The queue above handles contention from THIS process. A second slimdex on
 * the same repo, an antivirus scanner, or an editor holding a handle can still
 * make the replace fail momentarily — and those clear in milliseconds, so a
 * short backoff turns a spurious hard failure into a normal write.
 */
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

async function renameWithRetry(tmp: string, file: string, attempts = 5): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (attempt >= attempts || !TRANSIENT_RENAME_ERRORS.has(code)) throw e;
      await new Promise((r) => setTimeout(r, 5 * 2 ** attempt)); // 5,10,20,40,80ms
    }
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
  } catch (e) {
    // ONLY a genuinely absent file means "new repo". A permission error, a
    // sharing violation, or a transient I/O failure means the facts are still
    // there and we merely could not read them — returning empty for those was
    // the same silent-overwrite trap as swallowing a parse error, just via a
    // different door: empty store in, next save writes it back out.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { version: 1, facts: [] };
    throw new Error(
      `Cannot read ${memoryPath(root)} (${code ?? (e as Error).message}). Refusing to treat it as empty — ` +
        `that would overwrite your saved facts on the next save. Fix access to the file and retry.`
    );
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
