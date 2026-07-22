// End-to-end tests through the real MCP server over stdio.
//
// These exist because the unit suite covers the *functions* but not the tool
// handlers that wrap them, and because `npm run smoke` only proved the server
// responded — it asserted nothing, so a tool could return confident nonsense and
// still "pass". Every tool exercised here previously had zero assertions.
//
// Runs against a temporary fixture repo rather than this one: assertions stay
// stable as the real source changes, and memory_save writes land in a temp dir
// instead of polluting the developer's own .slimdex/memory.json.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
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

const FILES: Record<string, string> = {
  "src/math.ts": [
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "",
    "export function unused(): void {}",
  ].join("\n"),
  "src/app.ts": [
    'import { add } from "./math.js";',
    "",
    "export class Calculator {",
    "  run(a: number, b: number) {",
    "    return add(a, b);",
    "  }",
    "}",
    "",
    "// A template literal that must NOT produce symbols:",
    "export const HELP = `call function ghost() or class Phantom {`;",
  ].join("\n"),
  "lib/util.py": ["def helper(x):", "    return x * 2", "", "class Box:", "    def open(self):", "        return 1"].join("\n"),
};

beforeAll(async () => {
  if (!built) return;
  root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-it-"));
  for (const [rel, body] of Object.entries(FILES)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, "utf8");
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, SLIMDEX_ROOT: root } as Record<string, string>,
  });
  client = new Client({ name: "integration", version: "1.0.0" });
  await client.connect(transport);
  await call("index_repo");
}, 60_000);

afterAll(async () => {
  if (!built) return;
  await client?.close();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe.skipIf(!built)("MCP server end to end", () => {
  it("exposes its full tool set", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ["index_repo", "read_lines", "get_context", "dep_graph", "batch"]) {
      expect(names).toContain(t);
    }
  });

  it("index_repo reports what it indexed", async () => {
    const out = await call("index_repo");
    expect(out).toMatch(/Indexed \d+ files/);
    expect(out).toMatch(/symbols indexed: \d+/);
  });

  it("repo_map lists directories with counts", async () => {
    const out = await call("repo_map", { depth: 2 });
    expect(out).toContain("src");
    expect(out).toContain("lib");
  });

  // ---- previously untested tools ----

  it("read_lines returns exactly the requested range, numbered", async () => {
    const out = await call("read_lines", { path: "src/math.ts", start: 1, end: 2 });
    expect(out).toContain("return a + b;");
    expect(out).not.toContain("unused"); // line 5 must not leak in
  });

  it("get_file_skeleton elides bodies but keeps signatures", async () => {
    const out = await call("get_file_skeleton", { path: "src/math.ts" });
    expect(out).toContain("add");
    expect(out).not.toContain("return a + b;"); // body is elided
  });

  it("get_file_skeleton does not invent symbols from a template literal", async () => {
    const out = await call("get_file_skeleton", { path: "src/app.ts" });
    expect(out).toContain("Calculator");
    expect(out).not.toContain("ghost");
    expect(out).not.toContain("Phantom");
  });

  it("find_definition locates a symbol as path:line:col", async () => {
    const out = await call("find_definition", { name: "add" });
    expect(out).toMatch(/src\/math\.ts:1:\d+/);
  });

  it("find_references finds the call site and its enclosing symbol", async () => {
    const out = await call("find_references", { name: "add" });
    expect(out).toContain("src/app.ts");
  });

  it("get_context assembles multiple sections in one response", async () => {
    const out = await call("get_context", { name: "add", include: ["definition", "signature", "callers"] });
    expect(out).toContain("add");
    expect(out).toMatch(/src\/math\.ts/);
  });

  it("get_context honours maxChars and says so when it truncates", async () => {
    const out = await call("get_context", { name: "add", maxChars: 500 });
    expect(out.length).toBeLessThanOrEqual(700); // cap plus the truncation notice
  });

  it("get_symbol_context returns just the one function body", async () => {
    const out = await call("get_symbol_context", { name: "add" });
    expect(out).toContain("return a + b;");
    expect(out).not.toContain("unused");
  });

  it("dep_graph resolves an internal import", async () => {
    const out = await call("dep_graph", { mode: "imports", target: "src/app.ts" });
    expect(out).toContain("math");
  });

  it("dep_graph renders mermaid", async () => {
    const out = await call("dep_graph", { mode: "mermaid", root: "src/app.ts", depth: 2 });
    expect(out).toMatch(/graph|flowchart/i);
  });

  it("batch runs several calls in one request", async () => {
    const out = await call("batch", {
      calls: [
        { tool: "find_definition", args: { name: "add" } },
        { tool: "read_lines", args: { path: "src/math.ts", start: 1, end: 1 } },
      ],
    });
    expect(out).toContain("src/math.ts");
    expect(out).toContain("export function add");
  });

  it("search_code reports path:line:col matches", async () => {
    const out = await call("search_code", { pattern: "return" });
    expect(out).toMatch(/:\d+:\d+/);
  });

  it("search_symbols finds a Python declaration", async () => {
    const out = await call("search_symbols", { query: "helper" });
    expect(out).toContain("lib/util.py");
  });

  it("outline_file lists declarations with line numbers", async () => {
    const out = await call("outline_file", { path: "lib/util.py" });
    expect(out).toContain("helper");
    expect(out).toContain("Box");
  });

  // ---- memory: save / search / list / delete round trip ----

  it("round-trips a memory fact through save, search, list and delete", async () => {
    const saved = await call("memory_save", { text: "the parser seam lives in src/parser.ts", tags: ["arch"] });
    const id = saved.match(/[0-9a-f]{6,}/)?.[0];
    expect(id).toBeTruthy();

    expect(await call("memory_search", { query: "parser seam" })).toContain("parser seam");
    expect(await call("memory_list")).toContain("parser seam");

    await call("memory_delete", { id });
    expect(await call("memory_list")).not.toContain("parser seam");
  });

  it("stats counts the calls it has served", async () => {
    const out = await call("stats");
    expect(out).toMatch(/index_repo|TOTAL/);
  });

  // ---- error handling ----

  it("rejects a path outside the repo root instead of reading it", async () => {
    const out = await call("read_lines", { path: "../../../etc/passwd", start: 1, end: 1 });
    expect(out.toLowerCase()).toMatch(/outside|escape|invalid|not found/);
  });

  it("returns a terse message for a symbol that does not exist", async () => {
    const out = await call("find_definition", { name: "definitelyNotARealSymbol" });
    expect(out.toLowerCase()).toMatch(/no|not found|0/);
  });
});
