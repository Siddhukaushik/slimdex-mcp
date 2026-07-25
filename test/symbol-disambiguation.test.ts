// get_symbol_context pathPrefix: resolving a duplicated name in ONE call.
//
// A name defined in several files used to cost a rejection listing the
// candidates, then a second path+line call to fetch the body. pathPrefix
// collapses that into one round trip.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SERVER = path.resolve("dist/index.js");
const built = existsSync(SERVER);

let root = "";
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r: any = await client.callTool({ name, arguments: args });
  return r.content.map((c: any) => c.text ?? "").join("\n");
}

beforeAll(async () => {
  if (!built) return;
  root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-ambig-"));
  // NOT "vendor" — that is in the indexer's ignore list, so only one definition
  // would exist and the name would never be ambiguous.
  for (const dir of ["src", "legacy"]) await fs.mkdir(path.join(root, dir), { recursive: true });
  // Same symbol name in two places — the everyday shape of an ambiguous lookup.
  await fs.writeFile(path.join(root, "src", "handler.ts"), "export function handle() {\n  return 'REAL';\n}\n", "utf8");
  await fs.writeFile(path.join(root, "legacy", "handler.ts"), "export function handle() {\n  return 'OLD';\n}\n", "utf8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, SLIMDEX_ROOT: root },
  });
  client = new Client({ name: "ambig-test", version: "1.0.0" });
  await client.connect(transport);
  await call("index_repo");
});

afterAll(async () => {
  if (!built) return;
  await client?.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(!built)("get_symbol_context disambiguation", () => {
  it("refuses an ambiguous name and points at the way to narrow it", async () => {
    const out = await call("get_symbol_context", { name: "handle" });
    expect(out).toContain("2 definitions");
    expect(out).toContain("pathPrefix");
    // Crucially it returns no body — that is the round trip being eliminated.
    expect(out).not.toContain("REAL");
  });

  it("returns the body in one call when pathPrefix picks a side", async () => {
    const out = await call("get_symbol_context", { name: "handle", pathPrefix: "src" });
    expect(out).toContain("REAL");
    expect(out).not.toContain("OLD");
  });

  it("says so when the prefix excludes every definition, and still lists them", async () => {
    const out = await call("get_symbol_context", { name: "handle", pathPrefix: "nowhere" });
    expect(out).toContain("not under");
    expect(out).toContain("src/handler.ts");
  });
});
