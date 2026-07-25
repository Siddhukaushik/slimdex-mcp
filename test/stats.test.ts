import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadStats, record, resetStats } from "../src/stats.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await resetStats(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("stats root isolation", () => {
  it("does not share cached counters between repositories", async () => {
    const first = await fs.mkdtemp(path.join(tmpdir(), "slimdex-stats-a-"));
    const second = await fs.mkdtemp(path.join(tmpdir(), "slimdex-stats-b-"));
    roots.push(first, second);

    await record(first, "read_lines", 10, false);
    await record(second, "search_code", 20, false);

    expect((await loadStats(first)).tools).toHaveProperty("read_lines");
    expect((await loadStats(first)).tools).not.toHaveProperty("search_code");
    expect((await loadStats(second)).tools).toHaveProperty("search_code");
    expect((await loadStats(second)).tools).not.toHaveProperty("read_lines");
  });
});
