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
