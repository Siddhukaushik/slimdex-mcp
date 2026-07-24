import { describe, it, expect } from "vitest";
import { tokenize, rankIntent } from "../src/intent.js";
import type { CodeIndex } from "../src/store.js";

describe("tokenize", () => {
  it("splits camelCase into words", () => {
    expect(tokenize("validateEmail")).toEqual(["validate", "email"]);
  });
  it("splits snake_case and paths", () => {
    expect(tokenize("check_user_address")).toEqual(["check", "user", "address"]);
  });
  it("drops short tokens and stopwords", () => {
    expect(tokenize("the a of parser")).toEqual(["parser"]);
  });
  it("keeps code-meaningful short words like is/get", () => {
    expect(tokenize("isValid")).toEqual(["is", "valid"]);
  });
});

function idx(names: string[]): CodeIndex {
  return {
    version: 2,
    builtAt: new Date().toISOString(),
    files: {
      "src/user.ts": {
        mtimeMs: 1,
        lines: 100,
        symbols: names.map((name, i) => ({ name, kind: "function", line: i + 1, col: 1 })),
        imports: [],
      },
    },
  };
}

describe("rankIntent (BM25)", () => {
  const index = idx(["validateEmail", "emailValidator", "checkUserAddress", "renderButton", "parseConfigFile"]);

  it("ranks the best name match first", () => {
    const hits = rankIntent(index, "validate email");
    expect(hits[0].name).toMatch(/validateEmail|emailValidator/);
  });

  it("surfaces synonymic-by-token matches, not just exact", () => {
    const names = rankIntent(index, "email").map((h) => h.name);
    expect(names).toContain("validateEmail");
    expect(names).toContain("emailValidator");
  });

  it("finds a differently-named symbol by intent words", () => {
    const hits = rankIntent(index, "read the config file");
    expect(hits[0].name).toBe("parseConfigFile");
  });

  it("returns nothing for a query that shares no tokens", () => {
    expect(rankIntent(index, "quantum teleportation")).toEqual([]);
  });

  it("respects the limit", () => {
    expect(rankIntent(index, "email user config button", 2).length).toBeLessThanOrEqual(2);
  });
});
