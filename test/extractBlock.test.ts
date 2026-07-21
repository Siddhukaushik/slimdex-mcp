import { describe, it, expect } from "vitest";
import { extractBlock, braceDelta } from "../src/intel.js";

const L = (s: string) => s.split("\n");

describe("braceDelta (string/comment awareness)", () => {
  it("ignores braces inside double-quoted strings", () => {
    const st = { inBlockComment: false, stringChar: null };
    expect(braceDelta('const x = "}";', st)).toEqual({ open: 0, close: 0 });
  });

  it("ignores braces after // line comments", () => {
    const st = { inBlockComment: false, stringChar: null };
    expect(braceDelta("foo(); // } } }", st)).toEqual({ open: 0, close: 0 });
  });

  it("ignores braces inside /* */ and carries state across lines", () => {
    const st = { inBlockComment: false, stringChar: null };
    expect(braceDelta("/* {", st)).toEqual({ open: 0, close: 0 });
    expect(st.inBlockComment).toBe(true);
    expect(braceDelta("} */ {", st)).toEqual({ open: 1, close: 0 });
    expect(st.inBlockComment).toBe(false);
  });

  it("carries template literals across lines but resets ' and \" at EOL", () => {
    const st = { inBlockComment: false, stringChar: null as string | null };
    braceDelta("const t = `{", st);
    expect(st.stringChar).toBe("`");
    expect(braceDelta("}`;", st)).toEqual({ open: 0, close: 0 });
    // unterminated single quote must not poison the next line
    braceDelta("const s = 'oops", st);
    expect(st.stringChar).toBe(null);
  });

  it("handles escaped quotes", () => {
    const st = { inBlockComment: false, stringChar: null };
    expect(braceDelta('const s = "a\\"}b"; {', st)).toEqual({ open: 1, close: 0 });
  });
});

describe("extractBlock — brace-scoped", () => {
  it("spans a simple function", () => {
    const lines = L(`function f() {\n  return 1;\n}`);
    expect(extractBlock(lines, 1)).toEqual({ start: 1, end: 3 });
  });

  it("is not fooled by '}' inside a string", () => {
    const lines = L(`function f() {\n  const s = "}";\n  return s;\n}`);
    expect(extractBlock(lines, 1)).toEqual({ start: 1, end: 4 });
  });

  it("is not fooled by braces in comments", () => {
    const lines = L(`function f() {\n  // } early\n  /* } also } */\n  return 1;\n}`);
    expect(extractBlock(lines, 1)).toEqual({ start: 1, end: 5 });
  });

  it("handles a one-liner body", () => {
    const lines = L(`export function all(sql) { return db.all(sql); }\nnext();`);
    expect(extractBlock(lines, 1)).toEqual({ start: 1, end: 1 });
  });

  it("handles K&R brace on the following line", () => {
    const lines = L(`int main(void)\n{\n  return 0;\n}`);
    expect(extractBlock(lines, 1)).toEqual({ start: 1, end: 4 });
  });

  it("handles nested blocks", () => {
    const lines = L(`function f() {\n  if (x) {\n    y();\n  }\n}\nfunction g() {}`);
    expect(extractBlock(lines, 1)).toEqual({ start: 1, end: 5 });
  });
});

describe("extractBlock — indentation-scoped (Python)", () => {
  it("spans an indented body including blank lines", () => {
    const lines = L(`def f():\n    a = 1\n\n    return a\nprint(f())`);
    expect(extractBlock(lines, 1)).toEqual({ start: 1, end: 4 });
  });

  it("a '{' inside a full-line # comment does not hijack brace mode", () => {
    const lines = L(`def f():\n    # returns a {dict}\n    return {}\nprint(1)`);
    const b = extractBlock(lines, 1);
    expect(b.start).toBe(1);
    expect(b.end).toBeGreaterThanOrEqual(3); // must include the body
    expect(b.end).toBeLessThan(4); // must not swallow print(1)
  });

  it("nested defs stay inside the outer block", () => {
    const lines = L(`def outer():\n    def inner():\n        return 1\n    return inner\ntop = 1`);
    expect(extractBlock(lines, 1)).toEqual({ start: 1, end: 4 });
  });
});
