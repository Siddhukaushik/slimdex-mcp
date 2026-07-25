// In-memory file-content cache, keyed by absolute path and validated by
// (mtime, size) on every hit — a stat() instead of a read+decode. During an
// agent session the same files are read over and over: a get_file_skeleton is
// followed by read_lines on the same file, every find_references scan re-reads
// the whole candidate set, and get_context re-reads what the last call just
// read. None of that changes the bytes on disk, so none of it should re-read
// them.
//
// Byte-bounded LRU rather than entry-bounded: a reference scan touches every
// file in the repo, and an entry cap smaller than the repo would thrash to a
// 0% hit rate on exactly the workload that needs the cache most.

import { promises as fs } from "node:fs";

const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024; // don't let one generated monster evict everything else

interface Entry {
  mtimeMs: number;
  size: number;
  source: string;
}

const cache = new Map<string, Entry>(); // Map iteration order doubles as LRU order
let totalBytes = 0;

export async function readFileCached(absPath: string): Promise<string> {
  const st = await fs.stat(absPath);
  const hit = cache.get(absPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    cache.delete(absPath); // re-insert to mark most-recently-used
    cache.set(absPath, hit);
    return hit.source;
  }
  const source = await fs.readFile(absPath, "utf8");
  if (hit) {
    totalBytes -= hit.size;
    cache.delete(absPath);
  }
  if (st.size <= MAX_ENTRY_BYTES) {
    cache.set(absPath, { mtimeMs: st.mtimeMs, size: st.size, source });
    totalBytes += st.size;
    while (totalBytes > MAX_TOTAL_BYTES) {
      const oldest = cache.keys().next().value!;
      totalBytes -= cache.get(oldest)!.size;
      cache.delete(oldest);
    }
  }
  return source;
}

/**
 * Drop one file's entry, so the next read goes to disk.
 *
 * Needed because (mtime, size) is an assumption, not a proof: a same-size edit
 * that restores the timestamp is indistinguishable by stat, and on NTFS ctime
 * doesn't help either (it tracks creation, not change). Anything that learns a
 * file's real content changed — by hashing it, say — can say so here instead of
 * letting a validated-but-wrong entry be served.
 */
export function invalidateFileCache(absPath: string): void {
  const hit = cache.get(absPath);
  if (!hit) return;
  totalBytes -= hit.size;
  cache.delete(absPath);
}

/**
 * Replace one file's entry with content the caller has already read, together
 * with the stat it observed. Same motivation as invalidateFileCache, but no
 * wasted work: a caller that hashed the bytes for its own reasons can hand them
 * over instead of forcing the next reader to go to disk again.
 *
 * Always evicts first, so an entry that survived on a stale (mtime, size) match
 * cannot outlive this call — even when the new content is too large to cache.
 */
export function seedFileCache(absPath: string, source: string, mtimeMs: number, size: number): void {
  invalidateFileCache(absPath);
  if (size > MAX_ENTRY_BYTES) return;
  cache.set(absPath, { mtimeMs, size, source });
  totalBytes += size;
  while (totalBytes > MAX_TOTAL_BYTES) {
    const oldest = cache.keys().next().value!;
    totalBytes -= cache.get(oldest)!.size;
    cache.delete(oldest);
  }
}

// Test hook; also useful if a future tool needs to force re-reads.
export function clearFileCache(): void {
  cache.clear();
  totalBytes = 0;
}
