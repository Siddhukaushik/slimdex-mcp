import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { searchFiles, formatMatches } from "../src/search.js";
import { getSymbolContext } from "../src/intel.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "slimdex-test-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "a.ts"),
    ["export function alpha() {", "  return beta();", "}", "export function beta() {", "  return 1;", "}"].join("\n"),
    "utf8"
  );
  await writeFile(
    path.join(root, "src", "b.ts"),
    Array.from({ length: 30 }, (_, i) => `const item${i} = beta();`).join("\n"),
    "utf8"
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("searchFiles", () => {
  it("returns path:line:col matches with caret highlight", async () => {
    const { matches } = await searchFiles(root, ["src/a.ts"], "beta", { highlight: true });
    expect(matches.length).toBe(2); // "beta" occurs once on each of two lines
    expect(matches[0]).toMatchObject({ file: "src/a.ts", line: 2, col: 10 });
    expect(matches[0].highlight).toContain("^^^^");
    const text = formatMatches(matches);
    expect(text).toContain("src/a.ts:2:10");
  });

  it("paginates with limit and offset without overlap", async () => {
    const files = ["src/a.ts", "src/b.ts"];
    const page1 = await searchFiles(root, files, "beta", { maxMatches: 5, offset: 0 });
    const page2 = await searchFiles(root, files, "beta", { maxMatches: 5, offset: 5 });
    expect(page1.matches.length).toBe(5);
    expect(page2.matches.length).toBe(5);
    const key = (m: { file: string; line: number }) => `${m.file}:${m.line}`;
    const overlap = page1.matches.map(key).filter((k) => page2.matches.map(key).includes(k));
    expect(overlap).toEqual([]);
    expect(page1.total).toBeGreaterThanOrEqual(5);
  });

  it("counts every occurrence on a line, not just the first", async () => {
    // Regression: one exec per line silently undercounted `foo(foo(x))`, which
    // made `total` — and therefore find_references — wrong.
    await writeFile(path.join(root, "src", "rep.ts"), "aa aa aa\nbb\naa\n", "utf8");
    const r = await searchFiles(root, ["src/rep.ts"], "aa", { maxMatches: 50 });
    expect(r.total).toBe(4); // 3 on line 1 + 1 on line 3
    expect(r.exact).toBe(true);
    expect(r.matches.map((m) => m.col).slice(0, 3)).toEqual([1, 4, 7]);
  });

  it("reports an exact total rather than a lower bound", async () => {
    const r = await searchFiles(root, ["src/b.ts"], "beta", { maxMatches: 3 });
    expect(r.matches.length).toBe(3);
    expect(r.total).toBe(30);
    expect(r.exact).toBe(true);
  });

  it("literal pre-filter never drops matches (regression guard)", async () => {
    // The candidate skip must be invisible in results: same totals with and
    // without literalHint, across regex, ignoreCase, and CRLF files.
    await writeFile(path.join(root, "src", "crlf.ts"), "const Beta = 1;\r\nBeta();\r\n", "utf8");
    const files = ["src/a.ts", "src/b.ts", "src/crlf.ts"];

    const plain = await searchFiles(root, files, "\\bbeta\\b", { regex: true, maxMatches: 100 });
    const hinted = await searchFiles(root, files, "\\bbeta\\b", { regex: true, maxMatches: 100, literalHint: "beta" });
    expect(hinted.total).toBe(plain.total);
    expect(hinted.matches).toEqual(plain.matches);

    const ci = await searchFiles(root, files, "beta", { ignoreCase: true, maxMatches: 100 });
    expect(ci.matches.some((m) => m.file === "src/crlf.ts")).toBe(true); // case-folded hint still admits Beta
  });

  it("escapes literal patterns and rejects bad regex tersely", async () => {
    const { matches } = await searchFiles(root, ["src/a.ts"], "beta()", {});
    expect(matches.length).toBeGreaterThan(0); // literal parens, not a regex group
    await expect(searchFiles(root, ["src/a.ts"], "([", { regex: true })).rejects.toThrow(/Invalid pattern/);
  });
});

describe("getSymbolContext budgeting", () => {
  it("caps the span at maxLines with an explicit truncation notice", async () => {
    const big = ["function huge() {", ...Array.from({ length: 50 }, (_, i) => `  line${i}();`), "}"].join("\n");
    await writeFile(path.join(root, "src", "big.ts"), big, "utf8");
    const ctx = await getSymbolContext(root, "src/big.ts", 1, "function", 0, 0, 10);
    expect(ctx.loc).toBe(52); // real size still reported
    expect(ctx.text).toContain("truncated");
    expect(ctx.text).toContain("read_lines 11-52");
  });

  it("returns the full block when under the cap", async () => {
    const ctx = await getSymbolContext(root, "src/a.ts", 1, "function", 0, 0, 200);
    expect(ctx.loc).toBe(3);
    expect(ctx.text).not.toContain("truncated");
  });
});
