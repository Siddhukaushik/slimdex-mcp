// Durable memory writes, and pathPrefix respecting directory boundaries.

import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMemory, saveMemory, updateMemory, type MemoryFact } from "../src/store.js";
import { underPrefix } from "../src/indexer.js";
import { rankIntent, isDocFile } from "../src/intent.js";
import type { CodeIndex } from "../src/store.js";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-dur-"));
  roots.push(root);
  return root;
}

const fact = (id: string): MemoryFact => ({ id, text: "fact " + id, tags: [], created: new Date().toISOString() });

describe("memory durability", () => {
  it("treats a MISSING store as empty but a CORRUPT one as an error", async () => {
    const root = await repo();
    // Missing: a fresh repo, not a failure.
    expect((await loadMemory(root)).facts).toEqual([]);

    await fs.mkdir(path.join(root, ".slimdex"), { recursive: true });
    await fs.writeFile(path.join(root, ".slimdex", "memory.json"), '{"version":1,"facts":[{"id":"a"', "utf8");

    // Corrupt: must NOT read as empty, or the next save overwrites everything.
    await expect(loadMemory(root)).rejects.toThrow(/not valid JSON/);
  });

  it("never lets a corrupt store be silently overwritten", async () => {
    const root = await repo();
    await fs.mkdir(path.join(root, ".slimdex"), { recursive: true });
    const file = path.join(root, ".slimdex", "memory.json");
    const truncated = '{"version":1,"facts":[{"id":"keepme"';
    await fs.writeFile(file, truncated, "utf8");

    await expect(updateMemory(root, (m) => m.facts.push(fact("new")))).rejects.toThrow();
    // The damaged bytes are still there to repair by hand.
    expect(await fs.readFile(file, "utf8")).toBe(truncated);
  });

  it("rejects a well-formed file that is not a memory store", async () => {
    const root = await repo();
    await fs.mkdir(path.join(root, ".slimdex"), { recursive: true });
    await fs.writeFile(path.join(root, ".slimdex", "memory.json"), '{"hello":"world"}', "utf8");
    await expect(loadMemory(root)).rejects.toThrow(/not a slimdex memory store/);
  });

  it("does not lose facts when saves overlap", async () => {
    const root = await repo();
    await saveMemory(root, { version: 1, facts: [] });

    // Fired together: the old load -> push -> save let the last write win.
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => updateMemory(root, (m) => m.facts.push(fact("f" + i))))
    );

    const ids = (await loadMemory(root)).facts.map((f) => f.id).sort();
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it("leaves no .tmp litter behind after writes", async () => {
    const root = await repo();
    await updateMemory(root, (m) => m.facts.push(fact("x")));
    const entries = await fs.readdir(path.join(root, ".slimdex"));
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });
});

describe("pathPrefix respects directory boundaries", () => {
  it("does not let a prefix widen the scope", () => {
    // The reported case: prefix "s" swept up everything starting with s.
    expect(underPrefix("src/index.ts", "s")).toBe(false);
    expect(underPrefix("scripts/x.mjs", "s")).toBe(false);
    expect(underPrefix("smoke-test.mjs", "s")).toBe(false);
    // ...and a sibling directory sharing a prefix.
    expect(underPrefix("src-old/index.ts", "src")).toBe(false);
  });

  it("still matches real containment", () => {
    expect(underPrefix("src/index.ts", "src")).toBe(true);
    expect(underPrefix("src/a/b.ts", "src/a")).toBe(true);
    expect(underPrefix("src/index.ts", "src/")).toBe(true); // trailing slash
    expect(underPrefix("smoke-test.mjs", "smoke-test.mjs")).toBe(true); // exact file
    expect(underPrefix("anything.ts", "")).toBe(true); // empty = no filter
  });
});

describe("context_pack ranks implementation over documentation", () => {
  const index: CodeIndex = {
    version: 3,
    builtAt: new Date().toISOString(),
    files: {
      "src/search.ts": {
        mtimeMs: 0, contentHash: "x", lines: 10, imports: [],
        symbols: [{ name: "searchFiles", kind: "function", line: 1, col: 1 }],
      },
      "docs/tool-guide.html": {
        mtimeMs: 0, contentHash: "x", lines: 10, imports: [],
        symbols: [{ name: "search files across the repo", kind: "function", line: 1, col: 1 }],
      },
    },
  };

  it("identifies documentation files", () => {
    expect(isDocFile("docs/tool-guide.html")).toBe(true);
    expect(isDocFile("README.md")).toBe(true);
    expect(isDocFile("src/search.ts")).toBe(false);
  });

  it("ranks the doc first without the flag, and the code first with it", () => {
    const plain = rankIntent(index, "search files across the repo", 5);
    expect(plain[0].file).toBe("docs/tool-guide.html");

    const packed = rankIntent(index, "search files across the repo", 5, { deprioritizeDocs: true });
    expect(packed[0].file).toBe("src/search.ts");
    expect(packed.some((h) => h.file === "docs/tool-guide.html")).toBe(true); // demoted, not dropped
  });
});
