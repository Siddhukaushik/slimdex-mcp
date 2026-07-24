import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isStale, stalenessNote } from "../src/freshness.js";

let root = "";
const rel = "src/a.ts";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-fresh-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, rel), "export const x = 1;\n", "utf8");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("isStale", () => {
  it("is fresh when the index mtime matches the file", async () => {
    const st = await fs.stat(path.join(root, rel));
    expect(await isStale(root, rel, st.mtimeMs)).toBe(false);
  });

  it("is stale when the file is newer than the index mtime", async () => {
    const st = await fs.stat(path.join(root, rel));
    expect(await isStale(root, rel, st.mtimeMs - 5000)).toBe(true);
  });

  it("does not cry stale for a missing file", async () => {
    expect(await isStale(root, "src/gone.ts", 0)).toBe(false);
  });
});

describe("stalenessNote", () => {
  it("is empty when fresh", async () => {
    const st = await fs.stat(path.join(root, rel));
    expect(await stalenessNote(root, rel, st.mtimeMs)).toBe("");
  });

  it("warns and names the file when stale", async () => {
    const note = await stalenessNote(root, rel, 0);
    expect(note).toContain("changed since last index");
    expect(note).toContain(rel);
  });
});
