import { describe, it, expect } from "vitest";
import { checkStaleness, composeBrief } from "../src/brief.js";
import type { CodeIndex, MemoryFact } from "../src/store.js";

const index: CodeIndex = {
  version: 2,
  builtAt: new Date().toISOString(),
  files: {
    "src/graph.ts": {
      mtimeMs: 1,
      lines: 200,
      symbols: [{ name: "nameRefEdges", kind: "function", line: 130, col: 1 }],
      imports: [],
    },
  },
};

const liveFiles = new Set(Object.keys(index.files));
const liveSymbols = new Set(["nameRefEdges"]);

function fact(text: string): MemoryFact {
  return { id: "abc123", text, tags: [], created: new Date().toISOString() };
}

describe("checkStaleness", () => {
  it("marks a fact ok when it references a live symbol", () => {
    const r = checkStaleness(fact("the fix lives in `nameRefEdges`"), liveFiles, liveSymbols);
    expect(r.flag).toBe("ok");
  });

  it("marks a fact ok when it references a live file", () => {
    const r = checkStaleness(fact("see src/graph.ts:130 for details"), liveFiles, liveSymbols);
    expect(r.flag).toBe("ok");
  });

  it("flags a fact stale when every code mention is gone", () => {
    const r = checkStaleness(fact("the logic in `oldRemovedFn()` handles it"), liveFiles, liveSymbols);
    expect(r.flag).toBe("stale");
    expect(r.note).toContain("oldRemovedFn");
  });

  it("does not flag prose that names nothing code-shaped", () => {
    const r = checkStaleness(fact("we decided to keep the design honest and simple"), liveFiles, liveSymbols);
    expect(r.flag).toBe("");
  });

  it("does not cry wolf when a fact mixes live and dead mentions", () => {
    const r = checkStaleness(fact("`nameRefEdges` replaced the old `deadHelper()`"), liveFiles, liveSymbols);
    expect(r.flag).toBe("ok");
  });
});

describe("composeBrief", () => {
  it("includes the repo summary, recap and checked memory", () => {
    const out = composeBrief({
      index,
      facts: [fact("the fix lives in `nameRefEdges`"), fact("`ghostFn()` was the culprit")],
      recap: "Recap — 3 calls: files examined: src/graph.ts",
      root: "/tmp/repo",
    });
    expect(out).toContain("Onboarding brief");
    expect(out).toContain("1 indexed file");
    expect(out).toContain("Recap");
    expect(out).toContain("nameRefEdges");
    expect(out).toContain("✓"); // the live-referencing fact
    expect(out).toContain("⚠"); // the stale one
  });

    it("handles an empty memory store", () => {
    const out = composeBrief({ index, facts: [], recap: "no activity", root: "/tmp/repo" });
    expect(out).toContain("none yet");
    });
    it("keeps the default brief compact and offers full detail", () => {
      const facts = Array.from({ length: 8 }, (_, i) => ({ ...fact(`finding ${i} in src/graph.ts`), id: `fact${i}` }));
      const input = { index, facts, recap: "Recap — 10 calls:\n  files examined: src/graph.ts (3), test/a.ts (2), test/b.ts (1), test/c.ts (1), test/d.ts (1)\n  searches: a, b, c", root: "/tmp/repo" };
      const compact = composeBrief(input);
      const full = composeBrief({ ...input, detail: "full" });
      expect(compact).not.toContain("searches: a, b, c");
      expect(compact).not.toContain("fact0");
      expect(full).toContain("searches: a, b, c");
      expect(full).toContain("fact0");
      expect(compact.length).toBeLessThan(full.length);
    });
  });
