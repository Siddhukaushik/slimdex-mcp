// replace_symbol INSERT mode, the honest zero-match hint, and brief's
// declared blind spots. All three come from a real session where slimdex's
// flagship write tool could not do the write, and its search hint sent the
// caller somewhere that errors.

import { describe, it, expect } from "vitest";
import { insertAtSymbol } from "../src/edit.js";
import { blindSpots } from "../src/brief.js";

const JAVA = [
  "class Screener {",
  "  private List<X> candidateInstruments(String id) {",
  "    return fetch(id);",
  "  }",
  "",
  "  private void other() {",
  "    noop();",
  "  }",
  "}",
].join("\n");

describe("insertAtSymbol", () => {
  it("inserts AFTER the anchor's closing brace, not after its signature", () => {
    const body = ["", "  private List<X> screenedStockCandidates() {", "    return List.of();", "  }"].join("\n");
    const res = insertAtSymbol(JAVA, 2, body, "after");
    const lines = res.text.split("\n");

    // The anchor's own body must be intact and come first.
    expect(lines[2]).toContain("return fetch(id);");
    expect(lines[3].trim()).toBe("}");
    // The new method lands after that closing brace.
    expect(res.text).toContain("screenedStockCandidates");
    expect(lines[res.start - 1]).toBe(""); // caller-supplied blank line, verbatim
    expect(lines[res.start]).toContain("screenedStockCandidates");
    // And the following method is still there, untouched.
    expect(res.text).toContain("private void other()");
  });

  it("inserts BEFORE the anchor", () => {
    const res = insertAtSymbol(JAVA, 6, "  private void first() {}\n", "before");
    const idxNew = res.text.split("\n").findIndex((l) => l.includes("first()"));
    const idxAnchor = res.text.split("\n").findIndex((l) => l.includes("private void other()"));
    expect(idxNew).toBeLessThan(idxAnchor);
  });

  it("does not reindent or reformat the body", () => {
    const res = insertAtSymbol(JAVA, 2, "NOINDENT", "after");
    expect(res.text.split("\n")[res.start - 1]).toBe("NOINDENT");
  });

  it("preserves CRLF line endings", () => {
    const crlf = JAVA.split("\n").join("\r\n");
    const res = insertAtSymbol(crlf, 2, "  // added", "after");
    expect(res.eol).toBe("\r\n");
    expect(res.text).toContain("\r\n");
    expect(res.text).not.toMatch(/[^\r]\n/);
  });

  it("refuses an out-of-range anchor", () => {
    expect(() => insertAtSymbol(JAVA, 999, "x", "after")).toThrow(/out of range/);
  });

  it("reports the span the new body actually occupies", () => {
    const res = insertAtSymbol(JAVA, 2, "a\nb\nc", "after");
    expect(res.end - res.start + 1).toBe(3);
    const lines = res.text.split("\n");
    expect(lines.slice(res.start - 1, res.end)).toEqual(["a", "b", "c"]);
  });
});

describe("brief blind spots", () => {
  it("calls out layout/cascade explicitly on a markup-heavy repo", () => {
    const byExt = new Map([[".jsx", 60], [".css", 32], [".java", 8]]);
    const s = blindSpots(byExt, 100);
    expect(s).toMatch(/browser/i);
    expect(s).toMatch(/cascade|layout/i);
    expect(s).toContain("92/100");
  });

  it("still states the boundary on a code-only repo, briefly", () => {
    const byExt = new Map([[".ts", 27], [".java", 3]]);
    const s = blindSpots(byExt, 30);
    expect(s).toMatch(/logs/i);
    expect(s.length).toBeLessThan(240); // the opener is re-read every turn
  });
});
