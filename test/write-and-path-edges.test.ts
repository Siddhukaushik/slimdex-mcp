// Edge cases in atomic writes and path containment, all four reported after
// the durability work landed. Each test asserts the PRE-FIX failure mode, so
// reverting the fix fails the test rather than quietly passing.

import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveMemory, loadMemory, updateMemory, type MemoryFact } from "../src/store.js";
import { escapesBase } from "../src/indexer.js";
import { checkRepeat, resetDedupe } from "../src/dedupe.js";

const roots: string[] = [];
afterEach(async () => {
  resetDedupe();
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-edge-"));
  roots.push(root);
  return root;
}

const fact = (id: string): MemoryFact => ({ id, text: "f" + id, tags: [], created: new Date().toISOString() });

describe("atomic write under concurrency", () => {
  it("survives many simultaneous writes to the same store", async () => {
    const root = await repo();
    // pid+millisecond temp names collided here: 100 concurrent saves gave
    // 5 successes and 95 ENOENT, because one writer renamed the shared temp
    // file out from under the others.
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) => saveMemory(root, { version: 1, facts: [fact(String(i))] }))
    );
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed).toHaveLength(0);

    // Whatever landed last, the file must be valid and readable.
    const loaded = await loadMemory(root);
    expect(loaded.facts).toHaveLength(1);
  }, 30_000);

  it("leaves no temp files behind", async () => {
    const root = await repo();
    await Promise.all(Array.from({ length: 25 }, () => updateMemory(root, (m) => m.facts.push(fact("x")))));
    const left = (await fs.readdir(path.join(root, ".slimdex"))).filter((f) => f.endsWith(".tmp"));
    expect(left).toEqual([]);
  }, 30_000);
});

describe("loadMemory distinguishes absent from unreadable", () => {
  it("returns empty only for a genuinely missing file", async () => {
    const root = await repo();
    expect((await loadMemory(root)).facts).toEqual([]);
  });

  it("throws rather than reporting empty when the path is unreadable", async () => {
    const root = await repo();
    // A directory where the file should be: readFile fails with EISDIR, which
    // is NOT "absent". Returning empty here would let the next save overwrite
    // real facts — the same trap as swallowing a parse error.
    await fs.mkdir(path.join(root, ".slimdex", "memory.json"), { recursive: true });
    await expect(loadMemory(root)).rejects.toThrow(/Refusing to treat it as empty/);
  });
});

describe("escapesBase", () => {
  it("rejects real traversal", () => {
    expect(escapesBase("..")).toBe(true);
    expect(escapesBase(".." + path.sep + "etc")).toBe(true);
    expect(escapesBase("../etc")).toBe(true);
    expect(escapesBase(path.resolve("/elsewhere"))).toBe(true);
  });

  it("accepts in-root names that merely start with dots", () => {
    // The reported false positive: startsWith("..") rejected these.
    expect(escapesBase("..cache/file.ts")).toBe(false);
    expect(escapesBase("..foo")).toBe(false);
    expect(escapesBase("...bar/baz.ts")).toBe(false);
    expect(escapesBase("src/index.ts")).toBe(false);
    expect(escapesBase("")).toBe(false);
  });
});

describe("dedupe does not touch files outside the root", () => {
  it("declines to hash a traversal path", async () => {
    const root = await repo();
    const outside = path.join(path.dirname(root), "outside-secret.txt");
    await fs.writeFile(outside, "x".repeat(2000), "utf8");
    try {
      const rel = path.join("..", path.basename(outside));
      // No signature -> no suppression bookkeeping at all. Before the fix this
      // opened and hashed the file before any handler validated the path.
      const first = await checkRepeat(root, "read_lines", { path: rel });
      expect(first.notice).toBeUndefined();
      expect(first.remember).toBeUndefined();
    } finally {
      await fs.rm(outside, { force: true });
    }
  });

  it("still works for a normal in-root path", async () => {
    const root = await repo();
    await fs.writeFile(path.join(root, "a.ts"), "y".repeat(2000), "utf8");
    const d = await checkRepeat(root, "read_lines", { path: "a.ts" });
    expect(d.remember).toBeTypeOf("function");
  });
});
