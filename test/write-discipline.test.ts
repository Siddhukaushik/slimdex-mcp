// The write-side counterpart to follow-through.
//
// `follow-through` exists because a skeleton followed by a whole-file read is an
// invisible overpayment, and the only thing that reliably corrects it is a number
// in the agent's own transcript. Editing had the same problem and no such number:
// a real session rewrote dozens of whole symbols through a generic edit tool
// (re-sending each old body purely so the tool could locate the change), spliced
// by line number three times, and broke a build with an edit `find_tests` would
// have flagged in one call — while the rules against all three were being injected
// every turn.
//
// So these tests pin the two things the metric has to get right to be worth
// having: it must not cry wolf (an mtime bump is not an edit), and it must not
// blame slimdex's own writes on some other tool.

import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildOrRefresh } from "../src/indexer.js";
import {
  loadStats,
  resetStats,
  record,
  recordSlimdexWrite,
  recordExternalEdits,
  formatWrite,
  formatUnused,
  type WriteStat,
  type StatsFile,
} from "../src/stats.js";

const roots: string[] = [];

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-wd-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, "utf8");
  }
  return root;
}

afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const TS = "export function f() { return 1; }\n";

/** Push mtime forward so the millisecond-resolution cache sees a change. */
async function touch(file: string): Promise<void> {
  const t = new Date(Date.now() + 5_000);
  await fs.utimes(file, t, t);
}

describe("detecting edits made outside slimdex", () => {
  it("reports a file whose content changed", async () => {
    const root = await makeRepo({ "a.ts": TS, "b.ts": TS });
    const first = await buildOrRefresh(root);
    expect(first.changedPaths).toEqual([]); // first build: everything is new, nothing is an edit

    await fs.writeFile(path.join(root, "a.ts"), "export function f() { return 2; }\n", "utf8");
    // The mtime cache works in milliseconds, and a test rewrites the file inside
    // one. Real edits are seconds apart; nudge the clock so this exercises the
    // hash comparison rather than the cache's timing resolution.
    await touch(path.join(root, "a.ts"));
    const second = await buildOrRefresh(root);
    expect(second.changedPaths).toEqual(["a.ts"]);
  });

  it("still detects the edit on a forced rebuild", async () => {
    // `force` empties the working index, so the comparison has to be against
    // the baseline loaded from disk — otherwise a forced run reports zero edits.
    const root = await makeRepo({ "a.ts": TS });
    await buildOrRefresh(root);
    await fs.writeFile(path.join(root, "a.ts"), "export function g() { return 2; }\n", "utf8");
    await touch(path.join(root, "a.ts"));
    const forced = await buildOrRefresh(root, true);
    expect(forced.changedPaths).toEqual(["a.ts"]);
  });

  it("does not count an mtime bump that left the bytes identical", async () => {
    // A checkout, a copy, or a formatter that changed nothing all move mtime.
    // Counting those would make the number noise, and a noisy warning is one
    // the agent learns to scroll past — which is the exact failure being fixed.
    const root = await makeRepo({ "a.ts": TS });
    await buildOrRefresh(root);

    const future = new Date(Date.now() + 10_000);
    await fs.utimes(path.join(root, "a.ts"), future, future);
    const second = await buildOrRefresh(root);
    expect(second.changedPaths).toEqual([]);
  });

  it("does not count a brand-new file as an edit", async () => {
    const root = await makeRepo({ "a.ts": TS });
    await buildOrRefresh(root);
    await fs.writeFile(path.join(root, "new.ts"), TS, "utf8");
    const second = await buildOrRefresh(root);
    expect(second.changedPaths).toEqual([]);
  });
});

describe("the write ledger", () => {
  it("counts symbols rewritten by name", async () => {
    const root = await makeRepo({ "a.ts": TS });
    await resetStats(root);
    await recordSlimdexWrite(root, 5); // one batched call, five symbols
    const s = await loadStats(root);
    expect(s.write.slimdexCalls).toBe(1);
    expect(s.write.slimdexSymbols).toBe(5);
  });

  it("counts a write with no preceding check as blind", async () => {
    const root = await makeRepo({ "a.ts": TS });
    await resetStats(root);
    await recordSlimdexWrite(root, 1);
    expect((await loadStats(root)).write.blindEdits).toBe(1);
  });

  it("clears the blind flag when a check ran first", async () => {
    const root = await makeRepo({ "a.ts": TS });
    await resetStats(root);
    await record(root, "find_tests", 200, false);
    await recordSlimdexWrite(root, 1);
    const s = await loadStats(root);
    expect(s.write.blindEdits).toBe(0);
    expect(s.write.checks).toBe(1);
  });

  it("does not let one check cover every later edit", async () => {
    // Checking before edit 1 says nothing about edit 4. The counter resets on
    // each write, so credit has to be re-earned.
    const root = await makeRepo({ "a.ts": TS });
    await resetStats(root);
    await record(root, "dep_graph", 200, false);
    await recordSlimdexWrite(root, 1); // covered
    await recordSlimdexWrite(root, 1); // blind
    await recordSlimdexWrite(root, 1); // blind
    expect((await loadStats(root)).write.blindEdits).toBe(2);
  });

  it("gives no credit for a check that errored", async () => {
    const root = await makeRepo({ "a.ts": TS });
    await resetStats(root);
    await record(root, "find_tests", 40, true); // failed — told the model nothing
    await recordSlimdexWrite(root, 1);
    const s = await loadStats(root);
    expect(s.write.blindEdits).toBe(1);
    expect(s.write.checks).toBe(0);
  });

  it("ignores tools that are not pre-edit checks", async () => {
    const root = await makeRepo({ "a.ts": TS });
    await resetStats(root);
    await record(root, "read_lines", 300, false);
    await recordSlimdexWrite(root, 1);
    expect((await loadStats(root)).write.blindEdits).toBe(1);
  });

  it("treats external edits as write events too", async () => {
    const root = await makeRepo({ "a.ts": TS });
    await resetStats(root);
    await recordExternalEdits(root, 3);
    const s = await loadStats(root);
    expect(s.write.externalFiles).toBe(3);
    expect(s.write.blindEdits).toBe(1); // one unchecked event, not three
  });

  it("is a no-op when nothing changed", async () => {
    const root = await makeRepo({ "a.ts": TS });
    await resetStats(root);
    await recordExternalEdits(root, 0);
    expect((await loadStats(root)).write.blindEdits).toBe(0);
  });
});

describe("migrating a v1 stats file", () => {
  it("keeps the all-time tool counters instead of discarding them", async () => {
    // The one number a repo cannot reconstruct. Dropping it to add a field
    // would be a bad trade.
    const root = await makeRepo({ "a.ts": TS });
    await fs.mkdir(path.join(root, ".slimdex"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".slimdex", "stats.json"),
      JSON.stringify({
        version: 1,
        since: "2026-01-01T00:00:00.000Z",
        tools: { read_lines: { calls: 42, chars: 9000, maxChars: 500, errors: 0 } },
      }),
      "utf8"
    );
    const s = await loadStats(root);
    expect(s.version).toBe(2);
    expect(s.tools.read_lines.calls).toBe(42);
    expect(s.write.slimdexCalls).toBe(0);
  });
});

describe("migrating a stats file that predates the write block", () => {
  it("starts the write window now, not at the tool window", async () => {
    const root = await makeRepo({ "a.ts": TS });
    await fs.mkdir(path.join(root, ".slimdex"), { recursive: true });
    // A v1 file: a week of tool history, no write block at all.
    await fs.writeFile(
      path.join(root, ".slimdex", "stats.json"),
      JSON.stringify({
        version: 1,
        since: "2026-07-19T00:00:00.000Z",
        tools: { replace_symbol: { calls: 2, chars: 292, maxChars: 214, errors: 0 } },
      }),
      "utf8"
    );
    const s = await loadStats(root);
    expect(s.since).toBe("2026-07-19T00:00:00.000Z");
    // Dating the write counters to `since` would claim they watched a week of
    // editing and saw none of it — the exact false accusation this guards.
    expect(s.writeSince).not.toBe(s.since);
    expect(Date.parse(s.writeSince)).toBeGreaterThan(Date.parse(s.since));
    await resetStats(root);
  });

  it("leaves the window unknown when counters exist but no stamp does", async () => {
    const root = await makeRepo({ "a.ts": TS });
    await fs.mkdir(path.join(root, ".slimdex"), { recursive: true });
    // Written by the build where the write block had just shipped: the counts
    // are real, their start date is gone. Guessing `since` would restore the
    // false claim; guessing `now` would shrink a window they were not earned in.
    await fs.writeFile(
      path.join(root, ".slimdex", "stats.json"),
      JSON.stringify({
        version: 2,
        since: "2026-07-19T00:00:00.000Z",
        tools: { replace_symbol: { calls: 2, chars: 292, maxChars: 214, errors: 0 } },
        write: { slimdexSymbols: 0, slimdexCalls: 0, externalFiles: 4, blindEdits: 1, checks: 0 },
      }),
      "utf8"
    );
    const s = await loadStats(root);
    expect(s.writeSince).toBeUndefined();
    expect(formatWrite(s.write, { writeSince: s.writeSince, since: s.since })).toContain("window unknown");
    await resetStats(root);
  });

  it("keeps the write window once it has been stamped", async () => {
    const root = await makeRepo({ "a.ts": TS });
    await fs.mkdir(path.join(root, ".slimdex"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".slimdex", "stats.json"),
      JSON.stringify({
        version: 2,
        since: "2026-07-19T00:00:00.000Z",
        writeSince: "2026-07-24T00:00:00.000Z",
        tools: {},
        write: { slimdexSymbols: 3, slimdexCalls: 2, externalFiles: 0, blindEdits: 0, checks: 5 },
      }),
      "utf8"
    );
    const s = await loadStats(root);
    expect(s.writeSince).toBe("2026-07-24T00:00:00.000Z");
    expect(s.write.slimdexSymbols).toBe(3);
    await resetStats(root);
  });
});

describe("the report", () => {
  const base: WriteStat = {
    slimdexSymbols: 0,
    slimdexCalls: 0,
    externalFiles: 0,
    blindEdits: 0,
    checks: 0,
  };

  it("says nothing at all on a read-only session", () => {
    expect(formatWrite(base)).toBe("");
  });

  it("warns when the edits bypassed replace_symbol", () => {
    const out = formatWrite({ ...base, externalFiles: 12, slimdexSymbols: 0, blindEdits: 1 });
    expect(out).toContain("Most edits bypassed replace_symbol");
    expect(out).toContain("4-5x input");
  });

  it("does not nag a session that used the by-name path", () => {
    const out = formatWrite({ ...base, slimdexCalls: 4, slimdexSymbols: 9, checks: 4, externalFiles: 0 });
    expect(out).toContain("9 symbol(s) rewritten by name");
    expect(out).not.toContain("⚠");
  });

  it("does not fire the bypass warning on a single stray file", () => {
    // One external edit is a config tweak or a README, not a pattern worth a
    // warning. Warnings that fire on noise stop being read.
    const out = formatWrite({ ...base, externalFiles: 1, checks: 1 });
    expect(out).not.toContain("Most edits bypassed");
  });

  it("names the blind writes and what would have caught them", () => {
    const out = formatWrite({ ...base, slimdexCalls: 2, slimdexSymbols: 2, blindEdits: 2 });
    expect(out).toContain("2 write(s) with no preceding check");
    expect(out).toContain("find_tests");
    expect(out).toContain("dep_graph");
  });

  it("survives a stats file written before the write block existed", () => {
    expect(formatWrite(undefined)).toBe("");
  });

  // The failure this prevents: a repo recording tool counts since last week
  // migrates to v2 with a write history of zero, and the report prints
  // `replace_symbol: 2 calls` in the table directly above
  // `replace_symbol: 0 call(s)` in this block. Read together they look like a
  // broken counter, which costs the block the credibility it needs to be acted
  // on. Two windows, said out loud, instead of one window implied.
  it("names its own window when it is narrower than the table's", () => {
    const out = formatWrite(
      { ...base, slimdexCalls: 1, slimdexSymbols: 1, checks: 1 },
      { writeSince: "2026-07-26T00:00:00.000Z", since: "2026-07-24T00:00:00.000Z" }
    );
    expect(out).toContain("write discipline (since 2026-07-26T00:00:00.000Z");
    expect(out).toContain("the table above starts 2026-07-24T00:00:00.000Z");
    expect(out).toContain("not recorded yet");
  });

  it("stays quiet about windows when both counters started together", () => {
    const same = "2026-07-24T00:00:00.000Z";
    const out = formatWrite({ ...base, slimdexCalls: 1, slimdexSymbols: 1, checks: 1 }, { writeSince: same, since: same });
    expect(out).toContain("\nwrite discipline:");
    expect(out).not.toContain("not recorded yet");
  });
});

// The write block catches doing something the expensive way. This catches not
// doing it at all — the more common failure, and invisible by construction: a
// session that never called find_tests looks exactly like one where nothing
// needed testing.
describe("naming the tools that went unused", () => {
  const mk = (tools: Record<string, number>): StatsFile => ({
    version: 2,
    since: "2026-01-01T00:00:00.000Z",
    writeSince: "2026-01-01T00:00:00.000Z",
    tools: Object.fromEntries(
      Object.entries(tools).map(([k, v]) => [k, { calls: v, chars: v * 100, maxChars: 100, errors: 0 }])
    ),
    write: { slimdexSymbols: 0, slimdexCalls: 0, externalFiles: 0, blindEdits: 0, checks: 0 },
  });

  it("stays quiet on a session too short to have a pattern", () => {
    expect(formatUnused(mk({ read_lines: 2 }))).toBe("");
  });

  it("names the precautionary tools a grep-and-read session skipped", () => {
    const out = formatUnused(mk({ search_code: 20, read_lines: 30, get_file_skeleton: 5 }));
    expect(out).toContain("find_tests");
    expect(out).toContain("dep_graph");
    expect(out).toContain("replace_symbol");
    expect(out).not.toContain("get_file_skeleton"); // it WAS used
  });

  it("says nothing when the session reached for all of them", () => {
    const all = mk({
      brief: 1,
      context_pack: 1,
      get_file_skeleton: 1,
      get_context: 1,
      find_tests: 1,
      dep_graph: 1,
      replace_symbol: 1,
      search_intent: 1,
      memory_save: 1,
      digest_save: 1,
      recap: 1,
    });
    expect(formatUnused(all)).toBe("");
  });

  it("frames it as information, not a checklist", () => {
    // A nag gets tuned out, and then it measures nothing. The wording has to
    // leave room for sessions that genuinely needed none of these.
    const out = formatUnused(mk({ search_code: 20, read_lines: 30 }));
    expect(out).toContain("Not a checklist");
  });
});
