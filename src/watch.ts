// Optional auto-reindex on file change. Off by default; enable with
// CODEGLANCE_WATCH=1. Uses Node's built-in recursive fs.watch (no dependency) and
// debounces bursts of events (editors emit several per save) into one refresh.
//
// This is a convenience layer on top of the mtime-incremental indexer: it just
// calls buildOrRefresh, which re-parses only the files that actually changed.
// If watching isn't supported on the platform, it logs and stays silent rather
// than crashing the server.

import { watch } from "node:fs";
import { buildOrRefresh } from "./indexer.js";

export function startWatcher(root: string): () => void {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let dirty = false;

  const refresh = async () => {
    if (running) {
      dirty = true; // a change landed mid-refresh; run once more after
      return;
    }
    running = true;
    try {
      const r = await buildOrRefresh(root, false);
      if (r.parsed || r.removed) console.error(`codeglance watch: reindexed (parsed ${r.parsed}, removed ${r.removed})`);
    } catch (e) {
      console.error("codeglance watch: refresh failed:", (e as Error).message);
    } finally {
      running = false;
      if (dirty) {
        dirty = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refresh, 400); // debounce editor save bursts
  };

  try {
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const f = filename.toString();
      // ignore our own cache and obvious noise so we don't loop on ourselves
      if (f.includes(".codeglance") || f.includes("node_modules") || f.includes(".git")) return;
      schedule();
    });
    console.error(`codeglance watch: watching ${root} for changes`);
    return () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  } catch (e) {
    console.error(`codeglance watch: not available on this platform (${(e as Error).message}); use index_repo manually`);
    return () => {};
  }
}
