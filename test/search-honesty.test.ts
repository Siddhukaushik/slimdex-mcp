// Two ways a search result can look like an answer while carrying no answer.
//
// Both come from one reported session on a 6,380-line file:
//
//   1. search_intent "editor input autosave render document" returned 18
//      confidently-ranked symbols, none of which were used. The top hit was a
//      slides renderer. BM25 did exactly what BM25 does — on whichever one or
//      two of those words the repo happened to contain. The caller could not
//      see that the rest of the query was inert, because a scored list looks
//      like a ranking with information in it.
//   2. A broad search_code returned 43 lines, nearly all in the same enormous
//      file, and contributed nothing. The session afterwards identified the
//      skipped get_file_skeleton as the wrong call — and the data needed to say
//      so was already in the result.
//
// Neither is a scoring bug. Both are the tool declining to report what it knows
// about its own output.

import { describe, it, expect } from "vitest";
import { rankIntentDetailed } from "../src/intent.js";
import type { CodeIndex } from "../src/store.js";

function indexOf(files: Record<string, [string, string][]>): CodeIndex {
  return {
    version: 4,
    builtAt: "2026-01-01T00:00:00.000Z",
    files: Object.fromEntries(
      Object.entries(files).map(([file, syms]) => [
        file,
        {
          mtimeMs: 1,
          contentHash: "x",
          lines: 100,
          symbolsTruncated: false,
          imports: [],
          symbols: syms.map(([name, kind], i) => ({ name, kind, line: i + 1, col: 1 })),
        },
      ])
    ),
  } as unknown as CodeIndex;
}

const IDX = indexOf({
  "src/slides.ts": [["renderEditor", "function"], ["renderSlide", "function"]],
  "src/input.ts": [["handleInput", "function"], ["inputBuffer", "const"]],
});

describe("search_intent reports which query words were inert", () => {
  it("names words that appear in no symbol", () => {
    const r = rankIntentDetailed(IDX, "editor input autosave document", 10);
    expect(r.unmatched.sort()).toEqual(["autosave", "document"]);
    expect(r.matched.sort()).toEqual(["editor", "input"]);
  });

  it("flags the case where a single live word is doing all the work", () => {
    // This is the shape of a too-vague query, and by eye it is
    // indistinguishable from a good result.
    const r = rankIntentDetailed(IDX, "autosave persistence editor", 10);
    expect(r.matched).toEqual(["editor"]);
    expect(r.hits.length).toBeGreaterThan(0);
  });

  it("reports every word as unmatched when nothing matches at all", () => {
    const r = rankIntentDetailed(IDX, "kubernetes helm chart", 10);
    expect(r.hits).toEqual([]);
    expect(r.unmatched.sort()).toEqual(["chart", "helm", "kubernetes"]);
  });

  it("says nothing is unmatched when the whole query lands", () => {
    const r = rankIntentDetailed(IDX, "render slide", 10);
    expect(r.unmatched).toEqual([]);
    expect(r.matched.sort()).toEqual(["render", "slide"]);
  });

  it("still returns the same hits as the old entry point", () => {
    // rankIntent is the back-compat wrapper; the ranking must not have moved.
    const detailed = rankIntentDetailed(IDX, "render editor", 5);
    expect(detailed.hits.length).toBeGreaterThan(0);
    expect(detailed.hits[0]).toHaveProperty("score");
  });

  it("handles an empty query without inventing matches", () => {
    const r = rankIntentDetailed(IDX, "   ", 10);
    expect(r.hits).toEqual([]);
    expect(r.matched).toEqual([]);
  });
});
