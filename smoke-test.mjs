// Minimal smoke test: spins up the server over stdio and calls a few tools
// against a target repo to prove the pipeline works end to end.
//   node smoke-test.mjs [path-to-repo]     (defaults to this repo)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const root = path.resolve(process.argv[2] || process.cwd());
const serverPath = path.join(process.cwd(), "dist", "index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, SLIMDEX_ROOT: root },
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
  console.log(text.split("\n").slice(0, 14).join("\n"));
  return text;
}

await call("index_repo", {});
await call("repo_map", { depth: 2 });
await call("repo_map", { path: "src", top: 5 });
await call("search_code", { pattern: "function", limit: 4, highlight: true });
await call("search_symbols", { query: "context" });
await call("changed_files", {});

// Write a memory fact, then delete it again. Earlier versions left one behind on
// every run, so a repo's memory store slowly filled with "smoke test ran" rows —
// test noise crowding out real facts. Correctness assertions live in
// test/integration.test.ts; this script only proves the pipeline is alive.
const saved = await call("memory_save", { text: "slimdex smoke test ran", tags: ["test"] });
await call("memory_list", {});
const id = saved.match(/[0-9a-f]{6,}/)?.[0];
if (id) await call("memory_delete", { id });

await call("stats", {});

await client.close();
process.exit(0);
