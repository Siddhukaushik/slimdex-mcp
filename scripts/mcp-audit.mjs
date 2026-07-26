#!/usr/bin/env node
// Drive the REAL MCP server against large repositories and measure what it costs.
//
// WHY THIS IS SEPARATE FROM corpus-audit.mjs
// corpus-audit calls buildOrRefresh() directly. That checks the parser — it does
// not touch a single tool handler, so it cannot see a tool that errors, returns
// an empty result, or answers a reasonable question with 40,000 characters. Those
// are the failures that actually cost tokens in a session, and they were being
// found by reading transcripts afterwards.
//
// This boots dist/index.js over stdio exactly as a client does, runs a realistic
// session against each repo, and reports per-tool response SIZE, errors and empty
// answers. Size is the point: slimdex's entire claim is that a narrow tool beats a
// full read, and a tool quietly returning 30k chars is that claim failing.
//
// Big repos on purpose. Gaps that hide on a 100-file project — pagination caps,
// symbol-count ceilings, scan timeouts, quadratic scans — only appear at scale.
//
// USAGE
//   node scripts/mcp-audit.mjs                # default: 4 large repos
//   node scripts/mcp-audit.mjs --keep         # keep clones
//   node scripts/mcp-audit.mjs --local <path> # audit a checkout you already have

import { execFileSync } from "node:child_process";
import { promises as fs, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = path.resolve("dist/index.js");

// Large, real, and deliberately varied in language and layout.
const BIG = [
  ["typescript-compiler", "https://github.com/microsoft/TypeScript.git"],
  ["django", "https://github.com/django/django.git"],
  ["elasticsearch", "https://github.com/elastic/elasticsearch.git"],
  ["salesforce-lwc", "https://github.com/salesforce/lwc.git"],
];

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};

// A response past this is worth a hard look. Set just above get_context's own
// documented 12,000-char cap: at exactly 12,000 the tool reports its truncation
// notice and lands at ~12,089, so a 12,000 threshold flagged a bounded tool
// working correctly on every single run. A check that always fires is one you
// stop reading, which costs more than the noise it reports.
const LIMIT = 12_500;

function clone(url, dest) {
  try {
    // core.longpaths: three of four large repos failed to check out on Windows
    // with "unable to checkout working tree" — deep test-fixture paths exceed
    // MAX_PATH. Nothing to do with the repo's content, everything to do with
    // the host, so set it per-command rather than requiring global git config.
    execFileSync("git", ["-c", "core.longpaths=true", "clone", "--depth", "1", "--quiet", url, dest], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 900_000,
    });
  } catch (e) {
    // The first version reported only "Command failed", which hid the actual
    // cause and cost a manual reproduction to recover. Surface git's own words.
    const detail = (e.stderr?.toString() || e.message || "").trim().split("\n").slice(-3).join(" | ");
    throw new Error(detail || "clone failed with no output");
  }
}

async function connect(root) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, SLIMDEX_ROOT: root },
  });
  const client = new Client({ name: "mcp-audit", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** One tool call, timed and measured. Never throws — a failure IS a finding. */
async function probe(client, rows, name, args = {}) {
  const t0 = Date.now();
  let text = "";
  let error = null;
  try {
    const r = await client.callTool({ name, arguments: args });
    text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
    if (r.isError) error = "isError";
  } catch (e) {
    error = String(e.message ?? e).slice(0, 120);
  }
  const ms = Date.now() - t0;
  // "Err:" is how the server reports a handled failure in-band.
  if (!error && /^Err:/.test(text)) error = text.slice(0, 120);
  rows.push({ name, ms, chars: text.length, error, text });
  return text;
}

async function auditRepo(label, root) {
  console.log(`\n${"=".repeat(70)}\n${label}\n${"=".repeat(70)}`);
  const client = await connect(root);
  const rows = [];

  // A realistic session: orient, locate, read narrowly, inspect, audit.
  const idx = await probe(client, rows, "index_repo");
  console.log(idx.split("\n").slice(0, 3).join("\n"));

  await probe(client, rows, "brief");
  await probe(client, rows, "repo_map");
  await probe(client, rows, "search_code", { pattern: "TODO", limit: 20 });
  await probe(client, rows, "search_intent", { query: "parse configuration file", limit: 10 });
  await probe(client, rows, "search_symbols", { query: "test" });

  // Pick the largest indexed file and exercise the read path on it — the case
  // slimdex exists for, and where a ceiling would show up.
  const map = await probe(client, rows, "repo_map", { path: "" });
  const big = [...map.matchAll(/([\w./-]+\.\w+)\s+\((\d+) lines\)/g)]
    .map((m) => ({ file: m[1], lines: +m[2] }))
    .sort((a, b) => b.lines - a.lines)[0];
  if (big) {
    await probe(client, rows, "get_file_skeleton", { path: big.file });
    await probe(client, rows, "read_lines", { path: big.file, start: 1, end: 60 });
  }

  // Symbol path, using a name the index actually holds.
  const sym = (await probe(client, rows, "search_symbols", { query: "create" })).match(/\s([A-Za-z_]\w{4,})\s*$/m);
  if (sym) {
    await probe(client, rows, "find_definition", { name: sym[1] });
    await probe(client, rows, "find_references", { name: sym[1], limit: 20 });
    await probe(client, rows, "get_symbol_context", { name: sym[1] });
    await probe(client, rows, "get_context", { name: sym[1] });
    await probe(client, rows, "find_tests", { name: sym[1] });
  }

  await probe(client, rows, "context_pack", { query: "how does configuration loading work" });
  await probe(client, rows, "changed_files");
  const stats = await probe(client, rows, "stats", { session: true });

  await client.close().catch(() => {});

  console.log("\n  tool                    ms     chars   note");
  const findings = [];
  for (const r of rows) {
    const note = r.error ? `ERROR ${r.error}` : r.chars > LIMIT ? "<== LARGE" : r.chars === 0 ? "empty" : "";
    console.log(`  ${r.name.padEnd(22)} ${String(r.ms).padStart(5)} ${String(r.chars).padStart(8)}   ${note}`);
    if (r.error) findings.push({ label, kind: "error", tool: r.name, detail: r.error });
    else if (r.chars > LIMIT) findings.push({ label, kind: "large", tool: r.name, detail: `${r.chars} chars` });
  }
  const total = rows.reduce((n, r) => n + r.chars, 0);
  const slow = rows.filter((r) => r.ms > 5000);
  console.log(`  ${"TOTAL".padEnd(22)} ${String(rows.reduce((n, r) => n + r.ms, 0)).padStart(5)} ${String(total).padStart(8)}`);
  for (const s of slow) findings.push({ label, kind: "slow", tool: s.name, detail: `${s.ms}ms` });
  if (stats.includes("write discipline") || stats.includes("not reached")) {
    console.log("\n  (stats returned its discipline blocks)");
  }
  return findings;
}

const local = flag("--local");
const findings = [];

if (local) {
  findings.push(...(await auditRepo(path.basename(local), path.resolve(local))));
} else {
  if (!existsSync(SERVER)) {
    console.error("dist/index.js missing — run npm run build first.");
    process.exit(1);
  }
  const work = mkdtempSync(path.join(tmpdir(), "slimdex-mcp-audit-"));
  console.log(`Cloning ${BIG.length} large repo(s) into ${work} (this takes a while)`);
  for (const [label, url] of BIG) {
    const dest = path.join(work, label);
    try {
      if (!existsSync(dest)) clone(url, dest);
    } catch (e) {
      console.log(`\n${label}: CLONE FAILED — ${String(e.message).split("\n")[0]}`);
      continue;
    }
    try {
      findings.push(...(await auditRepo(label, dest)));
    } catch (e) {
      console.log(`\n${label}: AUDIT FAILED — ${e.message}`);
      findings.push({ label, kind: "error", tool: "(session)", detail: e.message });
    }
  }
  if (!keep) await fs.rm(work, { recursive: true, force: true }).catch(() => {});
}

console.log("\n" + "=".repeat(70));
if (!findings.length) {
  console.log("No errors, no oversized responses, no slow calls.");
} else {
  console.log("Findings:");
  for (const f of findings) console.log(`  [${f.kind}] ${f.label} ${f.tool}: ${f.detail}`);
  console.log(`\nLARGE means over ${LIMIT} chars — every one of those is paid again in`);
  console.log("every later turn of the session that asked for it.");
}
