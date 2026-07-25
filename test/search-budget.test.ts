import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { searchFiles } from "../src/search.js";
import { clearFileCache } from "../src/fscache.js";

const roots: string[] = [];

afterEach(async () => {
  clearFileCache();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function repoWith(contents: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-budget-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(contents)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body, "utf8");
  }
  return root;
}

describe("search time budget", () => {
  it("stops a slow backtracking scan at the budget instead of running to the end", async () => {
    // Classic ReDoS shape — nested quantifiers with a non-matching tail, so the
    // engine must exhaust every split before failing. 20 `a`s is ~2^20 steps:
    // slow per line, but bounded, so the cost lands ACROSS lines where the
    // between-lines deadline can actually see it. (A single line with 40 `a`s
    // cannot be interrupted at all — that is the documented limit, not a bug.)
    const line = "a".repeat(20) + "!";
    const root = await repoWith({ "a.js": Array.from({ length: 4000 }, () => line).join("\n") });

    const started = Date.now();
    const res = await searchFiles(root, ["a.js"], "(a+)+$", { regex: true, timeBudgetMs: 200 });
    const elapsed = Date.now() - started;

    expect(res.timedOut).toBe(true);
    // `total` came from a partial scan, so it must not be advertised as exact.
    expect(res.exact).toBe(false);
    // The whole file would take many times the budget; returning well inside
    // that ceiling is what proves the deadline actually cut the scan short.
    expect(elapsed).toBeLessThan(20_000);
  }, 60_000);

  it("reports exact results and no timeout for an ordinary scan", async () => {
    const root = await repoWith({
      "a.ts": "const alpha = 1;\nconst beta = alpha + 1;\n",
      "b.ts": "import { alpha } from './a';\n",
    });

    const res = await searchFiles(root, ["a.ts", "b.ts"], "alpha");

    expect(res.timedOut).toBe(false);
    expect(res.exact).toBe(true);
    expect(res.total).toBe(3);
  });
});
