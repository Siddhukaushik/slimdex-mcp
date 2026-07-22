// Safety snapshots: uncommitted files copied into .slimdex/snapshots/,
// bounded, prunable, and recoverable byte-for-byte.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { takeSnapshot, newestSnapshotAgeMs } from "../src/snapshot.js";

let root = "";
const roots: string[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-snap-"));
  roots.push(root);
});

afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});

describe("takeSnapshot", () => {
  it("copies the listed files byte-for-byte, preserving directory structure", async () => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "edited content", "utf8");
    await fs.writeFile(path.join(root, "b.ts"), "more edits", "utf8");

    const snap = await takeSnapshot(root, ["src/a.ts", "b.ts"]);
    expect(snap.files).toBe(2);
    const snapDir = path.join(root, snap.dir);
    expect(await fs.readFile(path.join(snapDir, "src", "a.ts"), "utf8")).toBe("edited content");
    expect(await fs.readFile(path.join(snapDir, "b.ts"), "utf8")).toBe("more edits");
  });

  it("skips missing files instead of failing the snapshot", async () => {
    await fs.writeFile(path.join(root, "real.ts"), "x", "utf8");
    const snap = await takeSnapshot(root, ["real.ts", "deleted.ts"]);
    expect(snap.files).toBe(1);
  });

  it("prunes to the newest 10 snapshots", async () => {
    await fs.writeFile(path.join(root, "f.ts"), "x", "utf8");
    for (let i = 0; i < 12; i++) {
      // distinct stamps: the ISO stamp has ms resolution; nudge the clock
      await takeSnapshot(root, ["f.ts"]);
      await new Promise((r) => setTimeout(r, 5));
    }
    const dirs = await fs.readdir(path.join(root, ".slimdex", "snapshots"));
    expect(dirs.length).toBeLessThanOrEqual(10);
  });

  it("newestSnapshotAgeMs is null before any snapshot and small right after one", async () => {
    expect(await newestSnapshotAgeMs(root)).toBeNull();
    await fs.writeFile(path.join(root, "f.ts"), "x", "utf8");
    await takeSnapshot(root, ["f.ts"]);
    const age = await newestSnapshotAgeMs(root);
    expect(age).not.toBeNull();
    expect(age!).toBeLessThan(10_000);
  });
});
