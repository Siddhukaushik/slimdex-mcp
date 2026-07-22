// The in-memory file cache must be invisible except in speed: a change on
// disk (new mtime/size) must always be served fresh.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileCached, clearFileCache } from "../src/fscache.js";

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-fsc-"));
});

afterAll(async () => {
  clearFileCache();
  await fs.rm(root, { recursive: true, force: true });
});

describe("readFileCached", () => {
  it("returns file content and serves the identical string on a repeat read", async () => {
    const p = path.join(root, "a.txt");
    await fs.writeFile(p, "one", "utf8");
    const first = await readFileCached(p);
    expect(first).toBe("one");
    expect(await readFileCached(p)).toBe(first);
  });

  it("serves fresh content after the file changes on disk", async () => {
    const p = path.join(root, "b.txt");
    await fs.writeFile(p, "before", "utf8");
    expect(await readFileCached(p)).toBe("before");

    // Guarantee the change is observable even on coarse-mtime filesystems:
    // bump the timestamp explicitly alongside the content.
    await fs.writeFile(p, "after!", "utf8");
    const future = new Date(Date.now() + 5000);
    await fs.utimes(p, future, future);
    expect(await readFileCached(p)).toBe("after!");
  });

  it("propagates missing-file errors instead of serving a stale entry", async () => {
    const p = path.join(root, "c.txt");
    await fs.writeFile(p, "here", "utf8");
    await readFileCached(p);
    await fs.rm(p);
    await expect(readFileCached(p)).rejects.toThrow();
  });
});
