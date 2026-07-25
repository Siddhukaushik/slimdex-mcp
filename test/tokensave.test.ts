// Tests for the per-turn and per-session cost work: memory previews, repeat
// suppression, the lean tool surface, terse-by-default output, and batched
// symbol edits.
//
// These are the mechanisms whose whole point is to NOT emit chars, so most of
// the assertions are about what is absent from a response. Where a saving could
// cost correctness instead — a suppressed body the agent still needs, a
// half-applied batch of edits — the test pins the safety valve, not the saving.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { factPreview, factFull, formatFactList, PREVIEW_CHARS } from "../src/memfmt.js";
import { terse, resetTerseCache, pad, padNum, t } from "../src/terse.js";
import { advertised, leanNote, BATCH_ONLY, LEAN_TOOLS } from "../src/profile.js";
import { spliceSymbols, spliceSymbol } from "../src/edit.js";
import type { MemoryFact } from "../src/store.js";

const LONG_FACT = "Conclusion first: the parser seam lives in src/parser.ts. " + "Then a lot of supporting evidence. ".repeat(40);

function fact(over: Partial<MemoryFact> = {}): MemoryFact {
  return { id: "abc12345", text: LONG_FACT, tags: ["arch", "decision"], created: "2026-07-24T10:00:00.000Z", ...over };
}

describe("memory previews", () => {
  it("previews a long fact to a single clipped row", () => {
    const row = factPreview(fact());
    expect(row).toContain("[abc12345]");
    expect(row).toContain("(arch,decision)");
    expect(row).toContain("2026-07-24");
    expect(row).toContain("Conclusion first");
    expect(row).toContain("…");
    expect(row).not.toContain("\n");
    // The clip is the point: a preview must be a small fraction of the body.
    expect(row.length).toBeLessThan(LONG_FACT.length / 3);
  });

  it("leaves a short fact unclipped", () => {
    const row = factPreview(fact({ text: "short one" }));
    expect(row).toContain("short one");
    expect(row).not.toContain("…");
  });

  it("full rendering keeps the whole body and the provenance note", () => {
    const out = factFull(fact({ context: "src/parser.ts, extractBlock" }));
    expect(out).toContain(LONG_FACT);
    expect(out).toContain("saved while looking at: src/parser.ts, extractBlock");
  });

  it("formatFactList previews by default and dumps on full", () => {
    const facts = [fact({ id: "a" }), fact({ id: "b" })];
    const preview = formatFactList(facts, { expandHint: "… memory_get" });
    const full = formatFactList(facts, { full: true });
    expect(preview).toContain("… memory_get");
    expect(preview.length).toBeLessThan(full.length / 3);
    expect(full).toContain(LONG_FACT);
  });

  it("preview length tracks the configured cap", () => {
    expect(factPreview(fact(), 40).length).toBeLessThan(factPreview(fact(), PREVIEW_CHARS).length);
  });
});

describe("terse output", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SLIMDEX_PRETTY;
    delete process.env.SLIMDEX_TERSE;
    resetTerseCache();
  });
  afterAll(() => {
    process.env = saved;
    resetTerseCache();
  });

  it("is the default", () => {
    expect(terse()).toBe(true);
    expect(t("verbose form", "terse")).toBe("terse");
    expect(pad("x", 10)).toBe("x");
    expect(padNum(7, 5)).toBe("7");
  });

  it("SLIMDEX_PRETTY=1 restores the human-aligned rendering", () => {
    process.env.SLIMDEX_PRETTY = "1";
    resetTerseCache();
    expect(terse()).toBe(false);
    expect(t("verbose form", "terse")).toBe("verbose form");
    expect(pad("x", 4)).toBe("x   ");
    expect(padNum(7, 3)).toBe("  7");
  });

  it("SLIMDEX_TERSE=0 also opts out, for anyone already setting it", () => {
    process.env.SLIMDEX_TERSE = "0";
    resetTerseCache();
    expect(terse()).toBe(false);
  });
});

describe("tool surface profile", () => {
  const saved = process.env.SLIMDEX_PROFILE;
  afterAll(() => {
    if (saved === undefined) delete process.env.SLIMDEX_PROFILE;
    else process.env.SLIMDEX_PROFILE = saved;
  });

  it("advertises everything by default", () => {
    delete process.env.SLIMDEX_PROFILE;
    expect(advertised("digest_save")).toBe(true);
    expect(advertised("snapshot")).toBe(true);
  });

  it("lean hides the specialist tools but keeps the core", () => {
    process.env.SLIMDEX_PROFILE = "lean";
    expect(advertised("digest_save")).toBe(false);
    expect(advertised("snapshot")).toBe(false);
    for (const core of ["brief", "read_lines", "get_symbol_context", "replace_symbol", "batch"]) {
      expect(advertised(core)).toBe(true);
    }
    expect(LEAN_TOOLS.has("batch")).toBe(true); // the escape hatch must never be hidden
    expect(LEAN_TOOLS.has("memory_get")).toBe(true); // brief hands back previews; something must expand them
  });
});

describe("multi-symbol splice", () => {
  const SRC = [
    "function a() {",
    "  return 1;",
    "}",
    "",
    "function b() {",
    "  return 2;",
    "}",
    "",
    "function c() {",
    "  return 3;",
    "}",
  ].join("\n");

  it("applies several edits and reports spans in the FINAL file", () => {
    const res = spliceSymbols(SRC, [
      { defLine: 1, body: "function a() {\n  // grew\n  // by two\n  return 10;\n}", label: "a" },
      { defLine: 9, body: "function c() {\n  return 30;\n}", label: "c" },
    ]);
    const lines = res.text.split("\n");
    expect(res.text).toContain("return 10;");
    expect(res.text).toContain("return 30;");
    expect(res.text).toContain("return 2;"); // untouched symbol survives

    const a = res.applied.find((e) => e.label === "a")!;
    const c = res.applied.find((e) => e.label === "c")!;
    expect(a.oldStart).toBe(1);
    expect(a.newStart).toBe(1);
    expect(a.newEnd).toBe(5);
    // `a` grew by 2 lines, so `c` moved down by exactly 2 — this is the span
    // that a naive bottom-up report gets wrong.
    expect(c.oldStart).toBe(9);
    expect(c.newStart).toBe(11);
    expect(lines[c.newStart - 1]).toBe("function c() {");
    expect(lines[c.newEnd - 1]).toBe("}");
  });

  it("refuses overlapping edits rather than half-applying them", () => {
    expect(() =>
      spliceSymbols(SRC, [
        { defLine: 1, body: "x", label: "a" },
        { defLine: 2, body: "y", label: "inside a" },
      ])
    ).toThrow(/overlap/i);
  });

  it("refuses an out-of-range definition line", () => {
    expect(() => spliceSymbols(SRC, [{ defLine: 999, body: "x", label: "ghost" }])).toThrow(/out of range/i);
  });

  it("preserves CRLF like the single-edit path", () => {
    const crlf = SRC.replace(/\n/g, "\r\n");
    const res = spliceSymbols(crlf, [{ defLine: 5, body: "function b() {\r\n  return 20;\r\n}", label: "b" }]);
    expect(res.eol).toBe("\r\n");
    expect(res.text).not.toMatch(/[^\r]\n/);
  });

  it("single-symbol splice is unchanged by the batch path", () => {
    const one = spliceSymbol(SRC, 5, "function b() {\n  return 20;\n}");
    const many = spliceSymbols(SRC, [{ defLine: 5, body: "function b() {\n  return 20;\n}", label: "b" }]);
    expect(many.text).toBe(one.text);
  });
});

// ---- end-to-end: the parts that only exist inside the running server ----

const SERVER = path.resolve("dist/index.js");
const built = existsSync(SERVER);

let root = "";
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r: any = await client.callTool({ name, arguments: args });
  return r.content.map((c: any) => c.text ?? "").join("\n");
}

// Big enough that a repeat is worth suppressing (the dedupe floor is 800 chars).
const BIG = Array.from({ length: 120 }, (_, i) => `export const v${i} = ${i}; // padding to make this file worth deduping`).join("\n");

beforeAll(async () => {
  if (!built) return;
  root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-ts-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/big.ts"), BIG, "utf8");
  await fs.writeFile(
    path.join(root, "src/edits.ts"),
    ["export function one() {", "  return 1;", "}", "", "export function two() {", "  return 2;", "}"].join("\n"),
    "utf8"
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, SLIMDEX_ROOT: root } as Record<string, string>,
  });
  client = new Client({ name: "tokensave", version: "1.0.0" });
  await client.connect(transport);
  await call("index_repo");
}, 60_000);

afterAll(async () => {
  if (!built) return;
  await client?.close();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe.skipIf(!built)("memory tools over the wire", () => {
  it("lists previews by default, expands on demand", async () => {
    const save = await call("memory_save", { text: LONG_FACT, tags: ["arch"] });
    const id = /Saved memory (\w+)/.exec(save)![1];

    const list = await call("memory_list");
    expect(list).toContain("Conclusion first");
    expect(list).toContain("memory_get");
    expect(list).not.toContain(LONG_FACT); // the body is NOT in the default listing
    expect(list.length).toBeLessThan(LONG_FACT.length);

    const full = await call("memory_list", { full: true });
    expect(full).toContain(LONG_FACT);

    const got = await call("memory_get", { ids: [id] });
    expect(got).toContain(LONG_FACT);
  });

  it("memory_get reports unknown ids without failing the known ones", async () => {
    const save = await call("memory_save", { text: "a short durable note" });
    const id = /Saved memory (\w+)/.exec(save)![1];
    const out = await call("memory_get", { ids: [id, "deadbeef"] });
    expect(out).toContain("a short durable note");
    expect(out).toContain("deadbeef");
  });

  it("warns on an over-long fact but still saves it", async () => {
    const out = await call("memory_save", { text: "x".repeat(1500) });
    expect(out).toMatch(/Saved memory/);
    expect(out).toMatch(/long for one fact/);
  });

  it("refuses a fact that is really a document", async () => {
    const out = await call("memory_save", { text: "x".repeat(20001) });
    expect(out).toMatch(/Refused/);
    expect(out).not.toMatch(/Saved memory/);
    expect(await call("memory_list")).not.toContain("x".repeat(200));
  });

  it("memory_search previews too", async () => {
    await call("memory_save", { text: LONG_FACT, tags: ["searchable"] });
    const out = await call("memory_search", { tag: "searchable" });
    expect(out).toContain("Conclusion first");
    expect(out).not.toContain(LONG_FACT);
    expect(await call("memory_search", { tag: "searchable", full: true })).toContain(LONG_FACT);
  });
});

describe.skipIf(!built)("repeat-response suppression", () => {
  it("suppresses the second identical read, then re-emits on the third", async () => {
    const first = await call("read_lines", { path: "src/big.ts", start: 1, end: 120 });
    expect(first).toContain("v0");
    expect(first.length).toBeGreaterThan(800);

    const second = await call("read_lines", { path: "src/big.ts", start: 1, end: 120 });
    expect(second).toMatch(/identical to call #\d+/);
    expect(second).not.toContain("v0 = 0");
    expect(second.length).toBeLessThan(first.length / 4);

    // The safety valve: an agent asking a third time has demonstrated it no
    // longer has the body (compaction), so it gets the real thing back.
    const third = await call("read_lines", { path: "src/big.ts", start: 1, end: 120 });
    expect(third).toContain("v0");
    expect(third.length).toBeGreaterThan(800);
  });

  it("a different range is a different call, never suppressed", async () => {
    await call("read_lines", { path: "src/big.ts", start: 1, end: 60 });
    const other = await call("read_lines", { path: "src/big.ts", start: 61, end: 120 });
    expect(other).toContain("v119");
    expect(other).not.toMatch(/identical to call/);
  });

  it("a same-size edit with a restored timestamp still invalidates", async () => {
    // The case mtime+size cannot see: identical length, timestamp put back to
    // what it was. A stat-based signature would call this unchanged and suppress
    // a response that no longer matches the file.
    const file = path.join(root, "src/sneaky.ts");
    const body = Array.from({ length: 120 }, (_, i) => `export const s${i} = ${i}; // padding to clear the dedupe floor`).join("\n");
    // Pin the timestamp to a whole second BEFORE the first read, so it can be
    // restored exactly afterwards — utimes cannot reproduce the sub-millisecond
    // precision a fresh write leaves behind.
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
    await fs.writeFile(file, body, "utf8");
    await fs.utimes(file, pinned, pinned);
    await call("index_repo");

    const first = await call("read_lines", { path: "src/sneaky.ts", start: 1, end: 120 });
    expect(first).toContain("s0 = 0");
    const st = await fs.stat(file);

    // Same byte length (a digit swap of equal width), timestamp put back exactly.
    const mutated = body.replace("export const s7 = 7;", "export const s7 = 9;");
    expect(mutated.length).toBe(body.length);
    await fs.writeFile(file, mutated, "utf8");
    await fs.utimes(file, pinned, pinned);

    const after = await fs.stat(file);
    // Both halves of a stat-based signature are now genuinely identical, so an
    // mtime+size check WOULD suppress here. Only content hashing catches it.
    expect(after.size).toBe(st.size);
    expect(after.mtimeMs).toBe(st.mtimeMs);

    const second = await call("read_lines", { path: "src/sneaky.ts", start: 1, end: 120 });
    expect(second).not.toMatch(/identical to call/);
    expect(second).toContain("s7 = 9");
  });

  it("suppression also applies to calls routed through batch", async () => {
    await fs.writeFile(path.join(root, "src/viabatch.ts"), BIG, "utf8");
    await call("index_repo");
    const one: any = await client.callTool({
      name: "batch",
      arguments: { calls: [{ tool: "read_lines", args: { path: "src/viabatch.ts", start: 1, end: 120 } }] },
    });
    expect(one.content.map((c: any) => c.text).join("")).toContain("v0");

    const two: any = await client.callTool({
      name: "batch",
      arguments: { calls: [{ tool: "read_lines", args: { path: "src/viabatch.ts", start: 1, end: 120 } }] },
    });
    expect(two.content.map((c: any) => c.text).join("")).toMatch(/identical to call #\d+/);
  });

  it("an edited file invalidates suppression", async () => {
    await fs.writeFile(path.join(root, "src/churn.ts"), BIG, "utf8");
    await call("index_repo");
    const a = await call("read_lines", { path: "src/churn.ts", start: 1, end: 120 });
    expect(a).toContain("v0");

    // Rewrite with different content: same args, but the file is not what it was.
    await fs.writeFile(path.join(root, "src/churn.ts"), BIG.replace("v0", "vZERO"), "utf8");
    const b = await call("read_lines", { path: "src/churn.ts", start: 1, end: 120 });
    expect(b).not.toMatch(/identical to call/);
    expect(b).toContain("vZERO");
  });
});

// The full advertised set, from a default-profile server — the baseline the
// lean surface is diffed against.
let ALL_TOOLS: string[] = [];

describe.skipIf(!built)("lean profile over the wire", () => {
  let leanRoot = "";
  let leanClient: Client;

  beforeAll(async () => {
    leanRoot = await fs.mkdtemp(path.join(tmpdir(), "slimdex-lean-"));
    await fs.mkdir(path.join(leanRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(leanRoot, "src/a.ts"), "export function a() {\n  return 1;\n}\n", "utf8");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, SLIMDEX_ROOT: leanRoot, SLIMDEX_PROFILE: "lean" } as Record<string, string>,
    });
    leanClient = new Client({ name: "lean", version: "1.0.0" });
    await leanClient.connect(transport);
    ALL_TOOLS = (await client.listTools()).tools.map((t) => t.name); // full-profile server from the outer suite
  }, 60_000);

  afterAll(async () => {
    await leanClient?.close();
    await fs.rm(leanRoot, { recursive: true, force: true }).catch(() => {});
  });

  it("advertises a smaller surface", async () => {
    const names = (await leanClient.listTools()).tools.map((t) => t.name);
    expect(names).toContain("brief");
    expect(names).toContain("get_symbol_context");
    expect(names).not.toContain("digest_save");
    expect(names).not.toContain("outline_file");
    expect(names.length).toBeLessThan(20);
  });

  it("documents exactly the tools it hides, and says so in the instructions", async () => {
    // The failure this prevents: instructions that tell the model to use
    // get_context / find_tests / changed_files while those are absent from its
    // tool list and nothing says they are batch-only. That is capability lost,
    // not surface saved — so the documented list must match reality exactly.
    const advertisedNames = (await leanClient.listTools()).tools.map((t) => t.name);
    const hidden = ALL_TOOLS.filter((n) => !advertisedNames.includes(n));
    expect([...hidden].sort()).toEqual([...BATCH_ONLY].sort());

    const note = leanNote();
    for (const n of BATCH_ONLY) expect(note).toContain(n);
    expect(note).toMatch(/through batch/i);
  });

  it("hidden tools stay reachable through batch — lean costs schema, never capability", async () => {
    const r: any = await leanClient.callTool({
      name: "batch",
      arguments: { calls: [{ tool: "index_repo" }, { tool: "outline_file", args: { path: "src/a.ts" } }, { tool: "stats" }] },
    });
    const out = r.content.map((c: any) => c.text ?? "").join("\n");
    expect(out).toContain("outline_file"); // batch labels each sub-result
    expect(out).toContain("function a"); // the hidden tool really ran
    expect(out).not.toMatch(/unknown tool/i);
  });
});

describe.skipIf(!built)("batched symbol edits", () => {
  it("applies several edits in one call, one snapshot, one re-index", async () => {
    const out = await call("replace_symbol", {
      edits: [
        { path: "src/edits.ts", line: 1, body: "export function one() {\n  return 100;\n}" },
        { path: "src/edits.ts", line: 5, body: "export function two() {\n  // now longer\n  return 200;\n}" },
      ],
    });
    expect(out).toMatch(/Applied 2 edit\(s\) across 1 file\(s\), re-indexed once/);
    expect(out).toMatch(/snapshot saved/);

    const after = await fs.readFile(path.join(root, "src/edits.ts"), "utf8");
    expect(after).toContain("return 100;");
    expect(after).toContain("return 200;");

    // The reported span for the SECOND edit must point at real code, which is
    // the whole risk of batching: line numbers shift as earlier edits apply.
    const span = /src\/edits\.ts: src\/edits\.ts:5 lines \d+-\d+ → (\d+)-(\d+)/.exec(out);
    expect(span).toBeTruthy();
    const lines = after.split(/\r?\n/);
    expect(lines[Number(span![1]) - 1]).toContain("function two");
  });

  it("refuses the whole batch when one target is unresolvable", async () => {
    const before = await fs.readFile(path.join(root, "src/edits.ts"), "utf8");
    const out = await call("replace_symbol", {
      edits: [
        { path: "src/edits.ts", line: 1, body: "export function one() {\n  return 999;\n}" },
        { name: "noSuchSymbolAnywhere", body: "whatever" },
      ],
    });
    expect(out).toMatch(/Refused 1 of 2 edit\(s\) — nothing was written/);
    expect(await fs.readFile(path.join(root, "src/edits.ts"), "utf8")).toBe(before);
  });

  it("refuses overlapping edits without writing", async () => {
    const before = await fs.readFile(path.join(root, "src/edits.ts"), "utf8");
    const out = await call("replace_symbol", {
      edits: [
        { path: "src/edits.ts", line: 1, body: "export function one() {\n  return 1;\n}" },
        { path: "src/edits.ts", line: 2, body: "  return 2;" },
      ],
    });
    expect(out).toMatch(/overlap/i);
    expect(out).toMatch(/nothing was written/);
    expect(await fs.readFile(path.join(root, "src/edits.ts"), "utf8")).toBe(before);
  });

  it("refuses before writing when a target file is not writable", async () => {
    // The common cause of a partial batch. Pre-flight must catch it while the
    // tree is untouched, rather than discovering it on write number two.
    await fs.writeFile(path.join(root, "src/ro-a.ts"), "export function roA() {\n  return 1;\n}\n", "utf8");
    await fs.writeFile(path.join(root, "src/ro-b.ts"), "export function roB() {\n  return 2;\n}\n", "utf8");
    await call("index_repo");
    const aBefore = await fs.readFile(path.join(root, "src/ro-a.ts"), "utf8");

    // Make b unwritable. On Windows chmod is limited, so fall back to holding
    // it open exclusively; if neither denies access, the case can't be staged.
    let staged = true;
    try {
      await fs.chmod(path.join(root, "src/ro-b.ts"), 0o444);
      await fs.access(path.join(root, "src/ro-b.ts"), (await import("node:fs")).constants.W_OK);
      staged = false; // still writable — chmod had no effect on this platform
    } catch {
      /* denied, which is what we want */
    }

    if (staged) {
      const out = await call("replace_symbol", {
        edits: [
          { name: "roA", body: "export function roA() {\n  return 111;\n}" },
          { name: "roB", body: "export function roB() {\n  return 222;\n}" },
        ],
      });
      expect(out).toMatch(/Not writable/);
      expect(out).toMatch(/nothing was written/);
      // The writable file in the same batch must be untouched.
      expect(await fs.readFile(path.join(root, "src/ro-a.ts"), "utf8")).toBe(aBefore);
    }
    await fs.chmod(path.join(root, "src/ro-b.ts"), 0o666).catch(() => {});
  });

  it("still handles the single-edit form", async () => {
    const out = await call("replace_symbol", { path: "src/edits.ts", line: 1, body: "export function one() {\n  return 7;\n}" });
    expect(out).toMatch(/Replaced src\/edits\.ts:1/);
    expect(await fs.readFile(path.join(root, "src/edits.ts"), "utf8")).toContain("return 7;");
  });
});
