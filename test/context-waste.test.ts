import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rankIntent } from "../src/intent.js";
import { loadSessionStats, loadStats, record, resetStats } from "../src/stats.js";
import type { CodeIndex } from "../src/store.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await resetStats(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

function indexWith(files: CodeIndex["files"]): CodeIndex {
  return { version: 3, builtAt: new Date().toISOString(), files };
}

const entry = (symbols: { name: string; kind: string; line: number }[]) => ({
  mtimeMs: 0,
  contentHash: "x",
  lines: 100,
  imports: [],
  symbols: symbols.map((s) => ({ ...s, col: 1 })),
});

describe("context_pack ranking", () => {
  // A test TITLE is prose, so it matches a natural-language query better than
  // the identifier it exercises. context_pack must still put the code first.
  const index = indexWith({
    "src/edit.ts": entry([{ name: "spliceSymbol", kind: "function", line: 10 }]),
    "test/edit.test.ts": entry([{ name: "splice symbol replaces a body", kind: "test", line: 5 }]),
  });

  it("ranks the test above the implementation without the penalty", () => {
    const hits = rankIntent(index, "splice symbol replaces a body", 5);
    expect(hits[0].kind).toBe("test");
  });

  it("puts implementation first when tests are deprioritized", () => {
    const hits = rankIntent(index, "splice symbol replaces a body", 5, { deprioritizeTests: true });
    expect(hits[0].kind).toBe("function");
    expect(hits[0].name).toBe("spliceSymbol");
    // Discounted, not filtered: it is still reachable when it is the answer.
    expect(hits.some((h) => h.kind === "test")).toBe(true);
  });
});

describe("session-scoped stats", () => {
  it("separates this run's counters from the repo's all-time totals", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-session-"));
    roots.push(root);

    // Pre-existing history on disk, as a real repo would have.
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

    await record(root, "read_lines", 120, false);

    const all = await loadStats(root);
    const session = await loadSessionStats(root);

    expect(all.tools.read_lines.calls).toBe(100); // 99 inherited + 1 now
    expect(session.tools.read_lines.calls).toBe(1); // only this run
    expect(session.tools.read_lines.chars).toBe(120);
    // maxChars is why this is tracked rather than subtracted: differencing
    // cumulative totals could never recover this session's largest response.
    expect(session.tools.read_lines.maxChars).toBe(120);
  });
});
