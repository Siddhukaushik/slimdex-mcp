import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../src/search.js";
import { getParser } from "../src/parser.js";

describe("cursor pagination", () => {
  it("round-trips offset and version", () => {
    const c = encodeCursor(40, "2026-07-21T00:00:00.000Z");
    expect(decodeCursor(c)).toEqual({ offset: 40, version: "2026-07-21T00:00:00.000Z" });
  });

  it("produces an opaque (non-numeric) token", () => {
    const c = encodeCursor(20, "v1");
    expect(c).not.toContain("20");
    expect(c).not.toContain("offset");
  });

  it("rejects malformed cursors instead of throwing", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

describe("parser abstraction", () => {
  it("defaults to the regex parser", () => {
    const p = getParser();
    expect(p.name).toBe("regex");
    expect(p.extractSymbols("function f() {}").map((s) => s.name)).toEqual(["f"]);
  });

  it("falls back to regex for an unknown backend", () => {
    const prev = process.env.CODEGLANCE_PARSER;
    process.env.CODEGLANCE_PARSER = "treesitter";
    try {
      expect(getParser().name).toBe("regex");
    } finally {
      if (prev === undefined) delete process.env.CODEGLANCE_PARSER;
      else process.env.CODEGLANCE_PARSER = prev;
    }
  });
});

describe("index cache", () => {
  it("returns cached data but reloads after the index is rewritten", async () => {
    const { loadIndex, saveIndex, INDEX_VERSION } = await import("../src/store.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const pathMod = await import("node:path");

    const root = await mkdtemp(pathMod.join(tmpdir(), "cg-cache-"));
    try {
      await saveIndex(root, {
        version: INDEX_VERSION,
        builtAt: "",
        files: { "a.ts": { mtimeMs: 1, lines: 1, symbols: [], imports: [] } },
      });
      const first = await loadIndex(root);
      expect(Object.keys(first.files)).toEqual(["a.ts"]);

      // Same object back on a second read — proof it did not re-parse.
      expect(await loadIndex(root)).toBe(first);

      // A rewrite must be picked up, not served stale from cache.
      await saveIndex(root, {
        version: INDEX_VERSION,
        builtAt: "",
        files: { "b.ts": { mtimeMs: 2, lines: 2, symbols: [], imports: [] } },
      });
      expect(Object.keys((await loadIndex(root)).files)).toEqual(["b.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
