import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { staleCovered, formatDigest } from "../src/digest.js";
import type { DigestStore } from "../src/store.js";

let root = "";
const files = ["src/a.ts", "src/b.ts"];

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-digest-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  for (const f of files) await fs.writeFile(path.join(root, f), "export const x = 1;\n", "utf8");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

function digest(covers: string[], savedAt: string): DigestStore {
  return { version: 1, text: "the app does things", covers, savedAt };
}

describe("staleCovered", () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();

  it("flags covered files modified after the digest was written", async () => {
    const stale = await staleCovered(root, digest([], past), files);
    expect(stale.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("reports nothing stale when the digest is newer than the files", async () => {
    const stale = await staleCovered(root, digest([], future), files);
    expect(stale).toEqual([]);
  });

  it("only considers files within the coverage scope", async () => {
    const stale = await staleCovered(root, digest(["src/a.ts"], past), files);
    expect(stale).toEqual(["src/a.ts"]);
  });

  it("supports a directory prefix in covers", async () => {
    const stale = await staleCovered(root, digest(["src"], past), files);
    expect(stale.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("formatDigest", () => {
  it("renders a clean verdict when fresh", () => {
    const out = formatDigest(digest([], new Date().toISOString()), []);
    expect(out).toContain("Architecture digest");
    expect(out).toContain("✓");
    expect(out).toContain("the app does things");
  });

  it("warns and lists changed files when stale", () => {
    const out = formatDigest(digest(["src"], new Date().toISOString()), ["src/a.ts"]);
    expect(out).toContain("⚠");
    expect(out).toContain("src/a.ts");
    expect(out).toContain("may be out of date");
  });
});
