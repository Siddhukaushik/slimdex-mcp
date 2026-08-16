import { describe, expect, it } from "vitest";
import { widestSymbols } from "../src/index.js";
import type { SymbolDef } from "../src/symbols.js";

// The hint's whole value is naming the bodies a full read would cost the most
// to reach. If it names the trivial one-liners instead, the line is noise that
// still costs bytes on every skeleton.

const sym = (name: string, line: number, depth = 0): SymbolDef => ({ name, kind: "function", line, col: 1, depth });

describe("widestSymbols", () => {
  it("ranks by span to the next declaration, not by declaration order", () => {
    const entry = {
      lines: 200,
      symbols: [sym("tiny", 1), sym("huge", 10), sym("small", 150), sym("medium", 160)],
    };
    // huge spans 10..150 (140), medium 160..200 (40), small 150..160 (10), tiny 1..10 (9)
    expect(widestSymbols(entry, 2)).toEqual(["huge", "medium"]);
  });

  it("uses the file's line count as the last symbol's end", () => {
    const entry = { lines: 500, symbols: [sym("first", 1), sym("last", 20)] };
    expect(widestSymbols(entry, 1)).toEqual(["last"]);
  });

  it("ignores nested declarations so the hint names callable top-level targets", () => {
    const entry = {
      lines: 100,
      symbols: [sym("outer", 1), sym("innerHelper", 5, 2), sym("other", 90)],
    };
    expect(widestSymbols(entry, 5)).toEqual(["outer", "other"]);
  });

  it("returns nothing when a file has no top-level declarations, so no hint is appended", () => {
    expect(widestSymbols({ lines: 40, symbols: [sym("nested", 3, 1)] }, 2)).toEqual([]);
    expect(widestSymbols({ lines: 40, symbols: [] }, 2)).toEqual([]);
  });

  it("caps at the requested count", () => {
    const entry = { lines: 400, symbols: [sym("a", 1), sym("b", 100), sym("c", 200), sym("d", 300)] };
    expect(widestSymbols(entry, 2)).toHaveLength(2);
  });
});
