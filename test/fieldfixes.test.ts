// Fixes for three things a real session reported wasting effort on:
//   - a symbol lookup that found nothing because the symbol is an object
//     property with an arrow-function value (`syncPortfolio: async () => {}`)
//   - context packs that came back padded with unrelated symbols
//   - `batch` being the largest output source, with no way to see which
//     sub-tool actually produced the characters

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { extractSymbols } from "../src/symbols.js";
import { outline } from "../src/outline.js";

const SERVICE = [
  "export const portfolioService = {",
  "  syncPortfolio: async () => {",
  "    return fetchHoldings();",
  "  },",
  "  refresh: async (force: boolean) => {",
  "    return 1;",
  "  },",
  "  reset: () => {",
  "    return 0;",
  "  },",
  "  legacy: function () {",
  "    return 2;",
  "  },",
  "};",
].join("\n");

// The false positive the trailing-brace requirement exists to prevent: these
// arrows are type signatures, not definitions. Indexing them would send a
// lookup to an interface member instead of the implementation.
const TYPES = [
  "export interface Props {",
  "  onClick: (e: Event) => void;",
  "  format: (v: number) => string;",
  "  loader: () => Promise<Data>;",
  "}",
  "type Handler = (req: Req) => Res;",
].join("\n");

describe("object-property arrow functions are indexed", () => {
  it("finds a property whose value is an async arrow", () => {
    const names = extractSymbols(SERVICE).map((s) => s.name);
    expect(names).toContain("syncPortfolio");
    expect(names).toContain("refresh");
    expect(names).toContain("reset");
    expect(names).toContain("legacy"); // the `: function` form still works
  });

  it("reports the property's real line, so a body fetch lands on it", () => {
    const sym = extractSymbols(SERVICE).find((s) => s.name === "syncPortfolio")!;
    expect(SERVICE.split("\n")[sym.line - 1]).toContain("syncPortfolio");
  });

  it("does NOT index keyword-named properties (iterator protocol)", () => {
    const iter = ['const it = {', '  next: () => {', '    return 1;', '  },', '  return: () => {', '    return 2;', '  },', '};'].join('\n');
    const names = extractSymbols(iter).map((s) => s.name);
    expect(names).toContain('next');
    expect(names).not.toContain('return');
  });

  it("does NOT index arrow TYPE annotations as definitions", () => {
    const names = extractSymbols(TYPES).map((s) => s.name);
    for (const n of ["onClick", "format", "loader"]) expect(names).not.toContain(n);
  });

  it("outline_file agrees with the index", () => {
    const kinds = outline(SERVICE).map((e) => e.text);
    expect(kinds.some((t) => t.includes("syncPortfolio"))).toBe(true);
    expect(outline(TYPES).some((e) => e.text.includes("onClick"))).toBe(false);
  });
});

// ---- end to end ----

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
  root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-ff-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/portfolio.ts"), SERVICE, "utf8");
  await fs.writeFile(path.join(root, "src/types.ts"), TYPES, "utf8");
  // One strongly-matching symbol plus a pile of weakly-matching noise, so the
  // relevance floor has something to prune.
  await fs.writeFile(
    path.join(root, "src/auth.ts"),
    [
      "export function validateUserEmail(email: string) {",
      "  return email.includes('@');",
      "}",
      "export function unrelatedUserThing() {",
      "  return 1;",
      "}",
      "export function anotherUserHelper() {",
      "  return 2;",
      "}",
      "export function yetMoreUserStuff() {",
      "  return 3;",
      "}",
      "export function userNoiseFour() {",
      "  return 4;",
      "}",
      "export function userNoiseFive() {",
      "  return 5;",
      "}",
    ].join("\n"),
    "utf8"
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, SLIMDEX_ROOT: root } as Record<string, string>,
  });
  client = new Client({ name: "fieldfixes", version: "1.0.0" });
  await client.connect(transport);
  await call("index_repo");
}, 60_000);

afterAll(async () => {
  if (!built) return;
  await client?.close();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

describe.skipIf(!built)("field fixes over the wire", () => {
  it("get_symbol_context resolves an object-property arrow by name", async () => {
    const out = await call("get_symbol_context", { name: "syncPortfolio" });
    expect(out).toContain("fetchHoldings");
    expect(out).not.toMatch(/No definition indexed/);
  });

  it("context_pack prunes the weak tail instead of padding to the limit", async () => {
    const out = await call("context_pack", { query: "validate user email" });
    expect(out).toContain("validateUserEmail");
    expect(out).toMatch(/omitted as unrelated/);
    // The noise functions share the token "user" and so all score > 0; they must
    // not be presented as relevant just because a slot was free.
    expect(out).not.toContain("userNoiseFive");
  });

  it("context_pack still returns everything when hits are genuinely close", async () => {
    const out = await call("context_pack", { query: "user", symbols: 4 });
    expect(out).not.toMatch(/omitted as unrelated/);
  });

  it("stats attributes batch output to the sub-tools, not to batch", async () => {
    await call("stats", { reset: true });
    await client.callTool({
      name: "batch",
      arguments: {
        calls: [
          { tool: "read_lines", args: { path: "src/auth.ts", start: 1, end: 18 } },
          { tool: "get_file_skeleton", args: { path: "src/portfolio.ts" } },
        ],
      },
    });
    const s = await call("stats");
    expect(s).toMatch(/read_lines/);
    expect(s).toMatch(/get_file_skeleton/);

    // The batch row must be the envelope only — the headers and separators —
    // so the total is not double-counted.
    const batchRow = /^\s+batch\s+(\d+) calls\s+(\d+) chars/m.exec(s);
    expect(batchRow).toBeTruthy();
    const readRow = /^\s+read_lines\s+\d+ calls\s+(\d+) chars/m.exec(s);
    expect(readRow).toBeTruthy();
    expect(Number(batchRow![2])).toBeLessThan(Number(readRow![1]));
  });

  it("follow-through accounting now sees skeletons routed through batch", async () => {
    await call("stats", { reset: true });
    await client.callTool({
      name: "batch",
      arguments: { calls: [{ tool: "get_file_skeleton", args: { path: "src/portfolio.ts" } }] },
    });
    const s = await call("stats");
    expect(s).toMatch(/follow-through: 1 skeleton/);
  });
});
