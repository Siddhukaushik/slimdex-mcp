// stats checkpoint: measuring ONE task on a long-lived server.
//
// `session:true` means "since this process started", and an MCP server outlives
// any single chat — so on its own it reported a figure spanning several tasks,
// which is the same complaint the cumulative counter had. checkpoint zeroes the
// session tally without destroying the repo's all-time history.

import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadStats, loadSessionStats, checkpointStats, record, resetStats } from "../src/stats.js";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) {
    await resetStats(r);
    await fs.rm(r, { recursive: true, force: true });
  }
});

async function repo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-ckpt-"));
  roots.push(root);
  return root;
}

describe("stats checkpoint", () => {
  it("zeroes the session tally but keeps all-time history", async () => {
    const root = await repo();

    // Work from an earlier task in the same long-lived process.
    await record(root, "read_lines", 5000, false);
    await record(root, "search_code", 1000, false);

    await checkpointStats(root);

    // Only what happens after the checkpoint should count as "this task".
    await record(root, "get_symbol_context", 300, false);

    const session = await loadSessionStats(root);
    expect(Object.keys(session.tools)).toEqual(["get_symbol_context"]);
    expect(session.tools.get_symbol_context.chars).toBe(300);
    // The earlier task must be gone from the session view...
    expect(session.tools.read_lines).toBeUndefined();

    // ...but never from the all-time totals.
    const all = await loadStats(root);
    expect(all.tools.read_lines.chars).toBe(5000);
    expect(all.tools.search_code.chars).toBe(1000);
    expect(all.tools.get_symbol_context.chars).toBe(300);
  });

  it("is repeatable, so each task measures only itself", async () => {
    const root = await repo();

    await checkpointStats(root);
    await record(root, "brief", 100, false);
    expect((await loadSessionStats(root)).tools.brief.chars).toBe(100);

    await checkpointStats(root);
    await record(root, "brief", 42, false);
    const second = await loadSessionStats(root);
    expect(second.tools.brief.chars).toBe(42); // not 142

    expect((await loadStats(root)).tools.brief.chars).toBe(142); // all-time still sums
  });

  it("does not lose all-time history that predates this process", async () => {
    const root = await repo();
    await fs.mkdir(path.join(root, ".slimdex"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".slimdex", "stats.json"),
      JSON.stringify({
        version: 1,
        since: "2020-01-01T00:00:00.000Z",
        tools: { read_lines: { calls: 99, chars: 400_000, maxChars: 9000, errors: 0 } },
      }),
      "utf8"
    );

    await checkpointStats(root);
    await record(root, "read_lines", 10, false);

    expect((await loadSessionStats(root)).tools.read_lines.calls).toBe(1);
    expect((await loadStats(root)).tools.read_lines.calls).toBe(100); // 99 inherited + 1
  });
});
