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
