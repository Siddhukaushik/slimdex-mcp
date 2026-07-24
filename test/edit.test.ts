import { describe, it, expect } from "vitest";
import { spliceSymbol } from "../src/edit.js";

const src = ["export function add(a, b) {", "  return a + b;", "}", "", "export const K = 1;"].join("\n");

describe("spliceSymbol", () => {
  it("replaces a brace-scoped block and reports the line delta", () => {
    const body = ["export function add(a, b) {", "  // rewritten", "  return a + b + 0;", "}"].join("\n");
    const r = spliceSymbol(src, 1, body);
    expect(r.oldStart).toBe(1);
    expect(r.oldEnd).toBe(3);
    expect(r.newEnd).toBe(4); // body grew from 3 to 4 lines
    expect(r.text).toContain("// rewritten");
    expect(r.text).toContain("export const K = 1;"); // trailing code preserved
    expect(r.text).not.toContain("return a + b;\n}"); // old two-line tail gone
  });

  it("preserves the trailing code after the replaced symbol", () => {
    const r = spliceSymbol(src, 1, "export function add() {}");
    const lines = r.text.split("\n");
    expect(lines[lines.length - 1]).toBe("export const K = 1;");
  });

  it("preserves CRLF line endings so a diff isn't the whole file", () => {
    const crlf = src.replace(/\n/g, "\r\n");
    const r = spliceSymbol(crlf, 1, "export function add() {}");
    expect(r.eol).toBe("\r\n");
    expect(r.text).toContain("\r\n");
    expect(r.text).toContain("export const K = 1;");
  });

  it("uses LF for an LF file", () => {
    const r = spliceSymbol(src, 1, "export function add() {}");
    expect(r.eol).toBe("\n");
    expect(r.text).not.toContain("\r\n");
  });
});
