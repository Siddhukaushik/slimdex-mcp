// Architecture digest logic: which of the files a digest covers have changed
// since it was written, and how to render the digest with that verdict. The
// digest itself is prose the agent authored (the server has no LLM to write it);
// what the server adds is the thing it's good at — telling you, cheaply, whether
// that prose can still be trusted, reusing the same mtime signal as freshness.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { DigestStore } from "./store.js";

/** Does this repo-relative file fall under the digest's coverage? Empty covers = whole repo. */
function isCovered(file: string, covers: string[]): boolean {
  if (covers.length === 0) return true;
  return covers.some((c) => {
    const p = c.replace(/\\/g, "/").replace(/\/+$/, "");
    return file === p || file.startsWith(p + "/");
  });
}

/**
 * The covered files that were modified after the digest was saved — i.e. the
 * reasons it might now be out of date. `candidateFiles` is the indexed file
 * list (repo-relative POSIX paths); we stat each covered one against savedAt.
 */
export async function staleCovered(root: string, digest: DigestStore, candidateFiles: string[]): Promise<string[]> {
  const cutoff = Date.parse(digest.savedAt);
  if (Number.isNaN(cutoff)) return [];
  const stale: string[] = [];
  for (const f of candidateFiles) {
    if (!isCovered(f, digest.covers)) continue;
    try {
      const st = await fs.stat(path.join(root, f));
      if (st.mtimeMs > cutoff + 1) stale.push(f);
    } catch {
      /* deleted/unreadable — not a staleness signal */
    }
  }
  return stale;
}

/** Render the digest with its freshness verdict for the reader. */
export function formatDigest(digest: DigestStore, stale: string[]): string {
  const scope = digest.covers.length ? digest.covers.join(", ") : "whole repo";
  const head = `Architecture digest (saved ${digest.savedAt.slice(0, 10)}, covers: ${scope})`;
  const verdict = stale.length
    ? `⚠ ${stale.length} covered file(s) changed since this was written — may be out of date:\n` +
      stale.slice(0, 10).map((f) => `    ${f}`).join("\n") +
      (stale.length > 10 ? `\n    … +${stale.length - 10} more` : "") +
      `\n  Re-read the changed areas and digest_save an updated version.`
    : "✓ all covered files unchanged since it was written — safe to rely on.";
  return `${head}\n${verdict}\n\n${digest.text}`;
}
