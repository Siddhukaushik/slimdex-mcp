// Two round-trips that a real session paid for nothing, reported back from a
// repo where slimdex was used for a full debugging job:
//
//   1. `brief` is documented as the FIRST call of every chat, and on a repo with
//      no index it answered "run index_repo first, then brief" — making the
//      documented opening move a guaranteed wasted turn on exactly the sessions
//      (first-ever, or post-INDEX_VERSION-bump) that need the opener most.
//   2. `replace_symbol` refused twice because the file had been touched by an
//      ordinary edit tool in between, costing an index_repo + retry each time.
//      Mixing slimdex writes with other writes is normal, not misuse.
//
// Both are self-healable: the work the agent was being told to do is work the
// server can do inline. What must NOT self-heal is an explicit path+line, where
// the caller supplied a coordinate computed against state that has since moved.

import { describe, it, expect, afterEach } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Through the real server, like integration.test.ts: ROOT is fixed when the
// module loads, and a cold index is precisely a property of server startup —
// calling the handlers directly would not exercise the thing under test.
const SERVER = path.resolve("dist/index.js");
const built = existsSync(SERVER);

const roots: string[] = [];
const clients: Client[] = [];

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-heal-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, "utf8");
  }
  return root;
}

async function connect(root: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, SLIMDEX_ROOT: root } as Record<string, string>,
  });
  const client = new Client({ name: "self-heal", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
  return r.content.map((c) => c.text ?? "").join("\n");
}

/** Push mtime forward: the index cache resolves to the millisecond. */
async function touch(file: string): Promise<void> {
  const t = new Date(Date.now() + 5_000);
  await fs.utimes(file, t, t);
}

afterEach(async () => {
  while (clients.length) await clients.pop()!.close().catch(() => {});
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true }).catch(() => {});
});

const SRC = `export function alpha() {
  return 1;
}

export function beta() {
  return 2;
}
`;

describe.skipIf(!built)("brief on a cold index", () => {
  it("builds the index instead of sending the agent away", async () => {
    const root = await makeRepo({ "src/a.ts": SRC });
    const client = await connect(root);
    const out = await call(client, "brief");
    expect(out).not.toContain("run index_repo first");
    expect(out).toContain("index was empty — built it first");
    // and it produced an actual brief, not just the notice
    expect(out.length).toBeGreaterThan(120);
  });

  it("says something useful when there is genuinely nothing to index", async () => {
    // An empty build is not the same as a cold one, and "run index_repo" would
    // be a loop here — the second run finds nothing too.
    const root = await makeRepo({ "notes.txt": "no code here\n" });
    const client = await connect(root);
    const out = await call(client, "brief");
    expect(out).toContain("no supported files");
    expect(out).toMatch(/extensions|ignoreDirs/);
  });
});

describe.skipIf(!built)("replace_symbol against an index the file has outgrown", () => {
  it("re-indexes and applies, instead of refusing, when addressed by name", async () => {
    const root = await makeRepo({ "src/a.ts": SRC });
    const client = await connect(root);
    await call(client, "index_repo");

    // Simulate the reported sequence: an ordinary edit tool writes the file,
    // shifting beta() down, and only then does replace_symbol run.
    await fs.writeFile(path.join(root, "src/a.ts"), `// header added by another tool\n// second line\n${SRC}`, "utf8");
    await touch(path.join(root, "src/a.ts"));

    const out = await call(client, "replace_symbol", {
      name: "beta",
      body: "export function beta() {\n  return 99;\n}",
    });
    expect(out).not.toContain("re-index before replacing");
    expect(out).toContain("Replaced");

    // The decisive check: it replaced beta where beta NOW is, and left the
    // header and alpha intact. A stale range would have eaten the wrong lines.
    const after = await fs.readFile(path.join(root, "src/a.ts"), "utf8");
    expect(after).toContain("header added by another tool");
    expect(after).toContain("return 99");
    expect(after).toContain("export function alpha");
    expect(after).not.toContain("return 2");
  });

  it("still refuses an explicit path+line, which the caller computed themselves", async () => {
    // Retargeting someone else's line number is how you overwrite the wrong
    // function. Only a NAME can be re-resolved safely.
    const root = await makeRepo({ "src/a.ts": SRC });
    const client = await connect(root);
    await call(client, "index_repo");

    await fs.writeFile(path.join(root, "src/a.ts"), `// shifted\n${SRC}`, "utf8");
    await touch(path.join(root, "src/a.ts"));

    const out = await call(client, "replace_symbol", {
      path: "src/a.ts",
      line: 5,
      body: "export function beta() {\n  return 99;\n}",
    });
    expect(out).toContain("changed since index_repo");
  });

  it("heals a batch without refusing the edits that follow the stale one", async () => {
    // The regression this guards: resolving one stale target re-indexes, and a
    // hoisted index object would leave every later edit comparing against
    // entries that had just been replaced.
    const root = await makeRepo({ "src/a.ts": SRC });
    const client = await connect(root);
    await call(client, "index_repo");

    await fs.writeFile(path.join(root, "src/a.ts"), `// shifted\n${SRC}`, "utf8");
    await touch(path.join(root, "src/a.ts"));

    const out = await call(client, "replace_symbol", {
      edits: [
        { name: "alpha", body: "export function alpha() {\n  return 11;\n}" },
        { name: "beta", body: "export function beta() {\n  return 22;\n}" },
      ],
    });
    expect(out).toContain("Applied 2 edit(s)");
    const after = await fs.readFile(path.join(root, "src/a.ts"), "utf8");
    expect(after).toContain("return 11");
    expect(after).toContain("return 22");
    expect(after).toContain("// shifted");
  });
});

// A search result that knows something about itself and doesn't say it.
describe.skipIf(!built)("pointing at the skeleton when a search is really a hunt", () => {
  // One big file, many mentions of the same word — the exact shape of "where
  // does this feature live", which a text search answers badly and a skeleton
  // answers in one call.
  const BIG = Array.from({ length: 400 }, (_, i) =>
    i % 8 === 0 ? `function handler${i}() { return input(${i}); }` : `  // filler line ${i}`
  ).join("\n");

  it("names the file and suggests get_file_skeleton", async () => {
    const root = await makeRepo({ "src/app.js": BIG, "src/other.js": "const input = 1;\n" });
    const client = await connect(root);
    await call(client, "index_repo");

    const out = await call(client, "search_code", { pattern: "input", limit: 30 });
    expect(out).toContain("get_file_skeleton");
    expect(out).toContain("src/app.js");
    expect(out).toMatch(/\d+ lines/);
  });

  it("stays quiet when the hits are spread across files", async () => {
    // Scattered hits are a real text search, not a misdirected hunt. Advice
    // that fires on everything gets ignored on the one occasion it matters.
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`src/m${i}.js`] = "const input = 1;\n";
    const root = await makeRepo(files);
    const client = await connect(root);
    await call(client, "index_repo");

    const out = await call(client, "search_code", { pattern: "input", limit: 30 });
    expect(out).not.toContain("get_file_skeleton");
  });

  it("stays quiet on a small file, where a plain read is fine", async () => {
    const root = await makeRepo({ "src/tiny.js": "const input=1;\n".repeat(20) });
    const client = await connect(root);
    await call(client, "index_repo");

    const out = await call(client, "search_code", { pattern: "input", limit: 30 });
    expect(out).not.toContain("get_file_skeleton");
  });
});

// Reading a symbol out of a file you have been editing.
//
// get_symbol_context detected staleness and warned — then returned the drifted
// lines anyway. A reported session got a body from an unrelated text block plus a
// ⚠, fell back to grep, and concluded symbol lookups are untrustworthy once you
// start writing. Correct about the behaviour; the fix costs one file re-parse.
describe.skipIf(!built)("get_symbol_context on a file edited since indexing", () => {
  const V1 = [
    "const NOTES = `",
    "  filler text that must never be mistaken for a symbol body",
    "`;",
    "",
    "export function target() {",
    "  return 'ORIGINAL';",
    "}",
  ].join("\n");

  it("re-indexes and returns the symbol's real body, not drifted lines", async () => {
    const root = await makeRepo({ "src/a.ts": V1 });
    const client = await connect(root);
    await call(client, "index_repo");

    // Push target() down by inserting above it — exactly what editing a file all
    // turn does to every symbol offset below the edit.
    const shifted = ["// a new line", "// another new line", "// a third", V1].join("\n");
    await fs.writeFile(path.join(root, "src/a.ts"), shifted, "utf8");
    await touch(path.join(root, "src/a.ts"));

    const out = await call(client, "get_symbol_context", { name: "target" });
    expect(out).toContain("ORIGINAL");
    expect(out).not.toContain("filler text");
    expect(out).not.toContain("may be off");
  });

  it("keeps warning on an explicit path+line, which is the caller's coordinate", async () => {
    const root = await makeRepo({ "src/a.ts": V1 });
    const client = await connect(root);
    await call(client, "index_repo");

    await fs.writeFile(path.join(root, "src/a.ts"), `// shifted\n${V1}`, "utf8");
    await touch(path.join(root, "src/a.ts"));

    const out = await call(client, "get_symbol_context", { path: "src/a.ts", line: 5 });
    expect(out).toMatch(/may be off|changed since/i);
  });

  it("heals once for a whole names:[…] batch", async () => {
    const src = `${V1}\nexport function second() {\n  return 'SECOND';\n}\n`;
    const root = await makeRepo({ "src/a.ts": src });
    const client = await connect(root);
    await call(client, "index_repo");

    await fs.writeFile(path.join(root, "src/a.ts"), `// shifted\n// twice\n${src}`, "utf8");
    await touch(path.join(root, "src/a.ts"));

    const out = await call(client, "get_symbol_context", { names: ["target", "second"] });
    expect(out).toContain("ORIGINAL");
    expect(out).toContain("SECOND");
    expect(out).not.toContain("filler text");
  });
});

// Unbounded responses, found by running the real server against Elasticsearch
// (31,210 files / 316,731 symbols) — a scale where an unpaged list stops being a
// list and becomes a wall.
//
//   find_definition    103,102 chars for ONE lookup
//   get_symbol_context  96,835 chars, all of it an "ambiguous name" refusal
//
// Neither is reachable on a small repo, which is why both survived: every sibling
// tool pages, and find_definition did not, because "a definition" sounds singular.
// A refusal that costs more than the work it prevents is the worst shape a
// response can take — it is re-paid on every later turn and cannot be acted on.
describe.skipIf(!built)("responses stay bounded at scale", () => {
  /** A repo where one name is defined in a great many files. */
  async function crowded(n: number) {
    const files: Record<string, string> = {};
    for (let i = 0; i < n; i++) files[`src/m${i}.ts`] = `export function process() { return ${i}; }\n`;
    return makeRepo(files);
  }

  it("pages find_definition instead of printing every site", async () => {
    const root = await crowded(300);
    const client = await connect(root);
    await call(client, "index_repo");

    const out = await call(client, "find_definition", { name: "process" });
    expect(out).toContain("300 def"); // exact total, always (terse or pretty)
    expect(out).toContain("more");
    expect(out.length).toBeLessThan(6000);
    // Default page is 50 sites; the tail must be summarised, not printed.
    expect(out.split("\n").length).toBeLessThan(60);
  });

  it("honours limit, offset and pathPrefix on find_definition", async () => {
    const root = await crowded(120);
    const client = await connect(root);
    await call(client, "index_repo");

    const page = await call(client, "find_definition", { name: "process", limit: 5, offset: 10 });
    expect(page).toContain("120 def");
    expect(page).toContain("showing 11-15");

    const scoped = await call(client, "find_definition", { name: "process", pathPrefix: "src/m1.ts" });
    expect(scoped).toContain("1 def");
  });

  it("caps the ambiguous-name refusal from get_symbol_context", async () => {
    const root = await crowded(300);
    const client = await connect(root);
    await call(client, "index_repo");

    const out = await call(client, "get_symbol_context", { name: "process" });
    expect(out).toContain("300 definitions"); // the count is the useful part
    expect(out).toContain("pathPrefix");
    expect(out.length).toBeLessThan(2000); // was ~96k on a real repo
  });

  it("caps the same refusal from replace_symbol", async () => {
    const root = await crowded(300);
    const client = await connect(root);
    await call(client, "index_repo");

    const out = await call(client, "replace_symbol", { name: "process", body: "export function process() { return 0; }" });
    expect(out).toContain("300 definitions");
    expect(out).toContain("won't guess");
    expect(out.length).toBeLessThan(2000);
  });

  it("still prints every site when there are only a few", async () => {
    // The cap must not make small, actionable answers worse.
    const root = await crowded(3);
    const client = await connect(root);
    await call(client, "index_repo");

    const out = await call(client, "find_definition", { name: "process" });
    expect(out).toContain("src/m0.ts");
    expect(out).toContain("src/m2.ts");
    expect(out).not.toContain("more");
  });
});
