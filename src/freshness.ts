// Freshness: a retrieval result should tell you when NOT to trust it, so an
// agent doesn't have to spend a re-read to double-check. The index records each
// file's mtime at parse time. If the file on disk is newer, its recorded symbol
// LINE NUMBERS may be off — the body we return is read live from disk (always
// current), but the line we located it at came from a stale index. So the honest
// signal is: "this file changed since indexing — line numbers may be off, run
// index_repo." Silent when fresh, so default output is unchanged.

import { promises as fs } from "node:fs";
import path from "node:path";

/** True when the file on disk is newer than when the index parsed it. */
export async function isStale(root: string, relPath: string, indexedMtimeMs: number): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(root, relPath));
    return st.mtimeMs > indexedMtimeMs + 1; // 1ms epsilon for fs timestamp granularity
  } catch {
    return false; // can't stat (deleted/unreadable) — don't cry stale
  }
}

/** A one-line warning to append to a retrieval, or "" when the file is fresh. */
export async function stalenessNote(root: string, relPath: string, indexedMtimeMs: number): Promise<string> {
  return (await isStale(root, relPath, indexedMtimeMs))
    ? `\n⚠ ${relPath} changed since last index — line numbers may be off; run index_repo.`
    : "";
}
