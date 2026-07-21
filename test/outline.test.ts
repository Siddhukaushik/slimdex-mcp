import { describe, it, expect } from "vitest";
import { outline } from "../src/outline.js";

const kinds = (src: string) => outline(src).map((e) => `${e.kind}:${e.text}`);

describe("outline", () => {
  it("lists class methods alongside the class", () => {
    const src = ["export class Svc {", "  async getUser(id: string) {", "    return id;", "  }", "}"].join("\n");
    const out = outline(src);
    expect(out.map((e) => e.kind)).toEqual(expect.arrayContaining(["class", "method"]));
    expect(out.some((e) => e.text.includes("getUser"))).toBe(true);
  });

  it("does not report control flow as a declaration", () => {
    // Regression: the Java/C# rule allowed a bare `\s` alternative in its
    // modifier group, so every `if (…) {` and `for (…) {` in a C-family file
    // was reported as a method.
    const src = [
      "function outer() {",
      "  if (this.cache.has(id)) {",
      "  }",
      "  for (const k of keys) {",
      "  }",
      "}",
    ].join("\n");
    expect(kinds(src)).toEqual(["function:function outer() {"]);
  });

  it("still recognises a genuine Java/C# method", () => {
    const src = ["class Foo {", "  public void handle(int a) {", "  }", "}"].join("\n");
    expect(outline(src).some((e) => e.kind === "method" && e.text.includes("handle"))).toBe(true);
  });
});

// ---- Same regressions as symbols.ts: outline.ts had its own copy of both bugs ----

describe("outline — string/comment awareness", () => {
  it("does not report prose containing the word 'functions'", () => {
    const entries = outline("const s = `read only the functions you need`;\nfunction real() {}");
    expect(entries.map((e) => e.kind + ":" + e.line)).toEqual(["function:2"]);
  });

  it("ignores declarations inside a block comment", () => {
    const entries = outline(["/*", " function ghost() {}", "*/", "function real() {}"].join("\n"));
    expect(entries.length).toBe(1);
    expect(entries[0].line).toBe(4);
  });

  it("excludes locals nested in a function body", () => {
    const src = ["function outer() {", "  const inner = (x) => x;", "}"].join("\n");
    expect(outline(src).map((e) => e.line)).toEqual([1]);
  });

  it("keeps a top-level arrow function", () => {
    expect(outline("export const handler = (req) => {").length).toBe(1);
  });
});
