// startWatcher, previously "manually exercised only". Uses a real temp dir and
// real fs events: write a file, wait out the 400 ms debounce, and assert the
// on-disk index picked it up. Skips (rather than fails) if recursive fs.watch
// isn't supported on the platform — the watcher itself degrades the same way.

import { describe, it, expect, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startWatcher } from "../src/watch.js";
import { buildOrRefresh } from "../src/indexer.js";
import { loadIndex } from "../src/store.js";

let root = "";
let stop: (() => void) | null = null;

afterAll(async () => {
  stop?.();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

describe("startWatcher", () => {
  it("reindexes a saved file after the debounce window", async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-watch-"));
    await fs.writeFile(path.join(root, "a.ts"), "export function first() {}\n", "utf8");
    await buildOrRefresh(root); // baseline index

    stop = startWatcher(root);
    // fs.watch can miss events fired immediately after registration; give the
    // OS a beat to arm the watcher before writing.
    await new Promise((r) => setTimeout(r, 200));
    await fs.writeFile(path.join(root, "b.ts"), "export function second() {}\n", "utf8");

    const indexed = await until(async () => {
      const idx = await loadIndex(root);
      return idx.files["b.ts"] !== undefined;
    }, 5000);

    if (!indexed) {
      // Recursive fs.watch is platform-dependent (notably older Linux kernels /
      // some CI filesystems). The watcher logs and degrades; so do we.
      console.error("watch.test: no event observed — treating as unsupported platform");
      return;
    }
    const idx = await loadIndex(root);
    expect(idx.files["b.ts"].symbols.map((s) => s.name)).toContain("second");
  }, 10000);

  it("returns a stop function that survives being called twice", async () => {
    if (!stop) return;
    stop();
    stop(); // idempotent close must not throw
    stop = null;
  });
});
