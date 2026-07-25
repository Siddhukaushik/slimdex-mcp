// Durable shutdown, end-to-end through the real server over stdio.
//
// The journal and stats counters are written on debounced, UNREF'd timers, so
// before the shutdown hooks existed a session that ended promptly lost whatever
// it had just recorded. This spawns a real server, makes one call, and closes
// the transport IMMEDIATELY — inside the debounce window — so the assertions
// fail if the sync flush is ever removed.

import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SERVER = path.resolve("dist/index.js");
const built = existsSync(SERVER);
const roots: string[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-shutdown-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "a.ts"), "export function alpha() {\n  return 1;\n}\n", "utf8");
  return root;
}

async function readJson(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

describe.skipIf(!built)("durable shutdown", () => {
  it("flushes the journal and stats when the transport closes mid-debounce", async () => {
    const root = await fixture();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, SLIMDEX_ROOT: root },
    });
    const client = new Client({ name: "shutdown-test", version: "1.0.0" });
    await client.connect(transport);

    await client.callTool({ name: "index_repo", arguments: {} });
    // Journaled tool (index_repo is on the journal's SKIP list, stats are not).
    await client.callTool({ name: "get_file_skeleton", arguments: { path: "src/a.ts" } });

    // Close at once: the journal debounce is 300ms and stats 1.5s, so without a
    // synchronous flush on shutdown neither file can contain this call yet.
    await client.close();

    // Give the OS a moment to reap the process and land the sync writes.
    await new Promise((r) => setTimeout(r, 1500));

    const journal = await readJson(path.join(root, ".slimdex", "journal.json"));
    expect(journal, "journal.json should exist after a clean shutdown").not.toBeNull();
    expect(journal.entries.some((e: any) => e.tool === "get_file_skeleton")).toBe(true);

    const stats = await readJson(path.join(root, ".slimdex", "stats.json"));
    expect(stats, "stats.json should exist after a clean shutdown").not.toBeNull();
    expect(stats.tools.get_file_skeleton?.calls).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
