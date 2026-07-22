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

// Test hook; also useful if a future tool needs to force re-reads.
export function clearFileCache(): void {
  cache.clear();
  totalBytes = 0;
}
