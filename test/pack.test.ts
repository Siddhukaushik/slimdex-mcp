import { describe, it, expect } from "vitest";
import { buildPack, type BodyFetcher } from "../src/pack.js";
import type { CodeIndex } from "../src/store.js";

function idx(names: string[]): CodeIndex {
  return {
    version: 2,
    builtAt: new Date().toISOString(),
    files: {
      "src/auth.ts": {
        mtimeMs: 1,
        lines: 200,
        symbols: names.map((name, i) => ({ name, kind: "function", line: (i + 1) * 10, col: 1 })),
        imports: [],
      },
    },
  };
}

// Stub body fetcher — returns a marker so we can see which bodies were pulled
// and can make a body arbitrarily long to test budget gating.
const stubBody =
  (long = false): BodyFetcher =>
  async (file, line) =>
    long ? `BODY(${file}:${line})` + "x".repeat(4000) : `BODY(${file}:${line})`;

describe("buildPack", () => {
  const index = idx(["validateEmail", "emailValidator", "loginUser", "renderButton"]);

  it("returns a single bundle with header, ranked symbols and bodies", async () => {
    const out = await buildPack(index, "validate email login", stubBody());
    expect(out).toContain("Context pack for");
    expect(out).toContain("Relevant symbols (ranked by intent)");
    expect(out).toContain("validateEmail");
    expect(out).toContain("Key bodies:");
    expect(out).toContain("BODY(src/auth.ts:"); // at least one body pulled
  });

  it("tells the agent when nothing matched", async () => {
    const out = await buildPack(index, "quantum teleportation reactor", stubBody());
    expect(out).toContain("No symbols matched");
  });

  it("respects the char budget and notes what it omitted", async () => {
    // Each body is ~4KB; a tiny budget must stop after the first and say so.
    const out = await buildPack(index, "validate email login button", stubBody(true), { budget: 1500, bodies: 3 });
    expect(out).toContain("body(ies) omitted to fit budget");
    // exactly one large body should have been included (first always shows)
    expect(out.match(/BODY\(/g)?.length).toBe(1);
  });

  it("still includes the first body even if it alone exceeds budget", async () => {
    const out = await buildPack(index, "validate email", stubBody(true), { budget: 1000, bodies: 3 });
    expect(out).toContain("BODY(");
  });

  it("honours the symbols limit in the ranked list", async () => {
    const out = await buildPack(index, "validate email login button", stubBody(), { symbols: 2, bodies: 0 });
    const listed = out.match(/src\/auth\.ts:\d+/g) ?? [];
    expect(listed.length).toBeLessThanOrEqual(2);
  });
});
