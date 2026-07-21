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
