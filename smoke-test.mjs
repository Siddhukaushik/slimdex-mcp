// Minimal smoke test: spins up the server over stdio and calls a few tools
// against a target repo (default: finance-tracker) to prove the pipeline works.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const root = process.argv[2] || "C:/Users/vvkau/Desktop/finance-tracker";
const serverPath = path.join(process.cwd(), "dist", "index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, LEANCTX_ROOT: root },
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
  console.log(r.content.map((c) => c.text).join("\n").split("\n").slice(0, 14).join("\n"));
}

await call("index_repo", {});
await call("repo_map", { depth: 2 });
await call("search_code", { pattern: "function", maxMatches: 4, highlight: true });
await call("memory_save", { text: "leanctx smoke test ran", tags: ["test"] });
await call("memory_list", {});

await client.close();
process.exit(0);
