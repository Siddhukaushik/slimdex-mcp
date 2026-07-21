import { describe, it, expect } from "vitest";
import { maskLine, scanLines, newScanState } from "../src/lexer.js";

describe("maskLine", () => {
  it("preserves line length so columns stay valid", () => {
    const st = newScanState();
    const line = `const a = "hello world"; // trailing`;
    const masked = maskLine(line, st);
    expect(masked.length).toBe(line.length);
  });

  it("blanks string contents but keeps the delimiters", () => {
    const st = newScanState();
    expect(maskLine(`const a = "class Foo";`, st)).toBe(`const a = "         ";`);
  });

  it("blanks line comments to end of line", () => {
    const st = newScanState();
    expect(maskLine(`let x = 1; // function nope()`, st)).toBe(`let x = 1;                   `);
  });

  it("carries a block comment across lines", () => {
    const st = newScanState();
    expect(maskLine(`/* function a() {`, st).trim()).toBe("");
    expect(st.inBlockComment).toBe(true);
    expect(maskLine(`   class B {`, st).trim()).toBe("");
    expect(maskLine(`*/ const real = 1;`, st)).toContain("const real");
  });

  it("carries a template literal across lines", () => {
    const st = newScanState();
    maskLine("const T = `line one", st);
    expect(st.stringChar).toBe("`");
    // Prose inside the template must not survive masking.
    expect(maskLine("  the functions you need", st).trim()).toBe("");
    expect(maskLine("`; function real() {", st)).toContain("function real");
  });

  it("does not let an unbalanced quote poison the next line", () => {
    const st = newScanState();
    maskLine(`const s = "unterminated`, st);
    expect(st.stringChar).toBeNull();
    expect(maskLine(`function real() {`, st)).toContain("function real");
  });

  it("handles an escaped quote without losing sync", () => {
    const st = newScanState();
    const line = `const a = "he said \\"hi\\"";`;
    const masked = maskLine(line, st);
    expect(masked.length).toBe(line.length);
    expect(st.stringChar).toBeNull();
  });

  it("handles a trailing backslash at end of line", () => {
    const st = newScanState();
    const line = `const a = "abc\\`;
    expect(maskLine(line, st).length).toBe(line.length);
  });
});

describe("scanLines depth", () => {
  it("reports the depth before the line's own braces", () => {
    const src = ["function a() {", "  const b = 1;", "}", "const c = 2;"].join("\n");
    const rows = scanLines(src);
    expect(rows[0].depth).toBe(0); // the `function a() {` line itself is top level
    expect(rows[1].depth).toBe(1); // inside the body
    expect(rows[3].depth).toBe(0); // back out
  });

  it("ignores braces inside strings when computing depth", () => {
    const src = [`const a = "{{{";`, `function real() {`].join("\n");
    const rows = scanLines(src);
    expect(rows[1].depth).toBe(0);
  });

  it("never goes negative on unbalanced input", () => {
    const rows = scanLines(["}", "}", "function a() {"].join("\n"));
    expect(rows[2].depth).toBe(0);
  });
});
