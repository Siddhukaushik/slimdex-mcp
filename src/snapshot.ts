// Safety snapshots of uncommitted work.
//
// Uncommitted edits are the only state in the whole system with zero copies:
// memory, journal, stats and the index all live in files nobody edits by
// hand, but the working tree is one stray `git checkout .` away from losing
// days of changes. The server already knows exactly which files are dirty
// (changed_files), so it copies just those into .slimdex/snapshots/<stamp>/.
//
// Bounded (newest KEEP snapshots survive, oversized files skipped) and
// best-effort by design: a snapshot failure must never break indexing.
//
// Honest limit, stated where it's implemented: snapshots live on the same
// disk as the repo. They defeat accidental resets and overzealous cleanups —
// not disk failure. A pushed commit remains the only real forever layer.

import { promises as fs } from "node:fs";
import path from "node:path";

const KEEP = 10;
const MAX_FILE_BYTES = 2_000_000;

function base(root: string): string {
  return path.join(root, ".slimdex", "snapshots");
}

export interface SnapshotResult {
  dir: string; // repo-relative snapshot directory
  files: number;
}

export async function takeSnapshot(root: string, relFiles: string[]): Promise<SnapshotResult> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(base(root), stamp);
  let copied = 0;
  for (const rel of relFiles) {
    const src = path.join(root, rel);
    try {
      const st = await fs.stat(src);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const dest = path.join(dir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      copied++;
    } catch {
      continue; // deleted mid-flight, unreadable — skip, never fail the snapshot
    }
  }
  await prune(root);
  return { dir: path.relative(root, dir).split(path.sep).join("/"), files: copied };
}

// Age of the newest snapshot in ms, or null if none exist. Drives the hourly
// auto-snapshot debounce without needing any state beyond the directory names.
export async function newestSnapshotAgeMs(root: string): Promise<number | null> {
  try {
    const entries = (await fs.readdir(base(root), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(); // ISO-derived names sort chronologically
    if (entries.length === 0) return null;
    const st = await fs.stat(path.join(base(root), entries[entries.length - 1]));
    return Date.now() - st.mtimeMs;
  } catch {
    return null;
  }
}

async function prune(root: string): Promise<void> {
  try {
    const entries = (await fs.readdir(base(root), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const stale of entries.slice(0, Math.max(0, entries.length - KEEP))) {
      await fs.rm(path.join(base(root), stale), { recursive: true, force: true });
    }
  } catch {
    /* pruning is best-effort */
  }
}
