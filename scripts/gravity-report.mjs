#!/usr/bin/env node
// Measure built-in tool gravity from real sessions.
//
// THE QUESTION
// slimdex's whole thesis is that narrow retrieval beats whole-file reads. That
// only pays if the model actually reaches for slimdex. Three audit sessions read
// "use replace_symbol" on every turn and reached for the built-in Edit anyway —
// so the honest metric is not token savings, it is SELECTION: when the model
// went for code, where did it go first?
//
// WHY TWO LOGS
// Neither source can answer it alone. The MCP server never learns that a built-in
// `Read` happened — from its side that turn simply doesn't exist. The PreToolUse
// hook sees built-ins but not slimdex's own calls (its matcher doesn't cover
// mcp__slimdex__*). So:
//
//   .slimdex/hook-events.jsonl   built-in Read/Edit/Write   (hook, "g" records)
//   .slimdex/journal.json        slimdex tool calls         (server)
//
// Merged on timestamp, the two reconstruct the sequence a single turn-by-turn
// transcript would have shown.
//
// FIRST HOP
// Sessions are split on a gap in activity. Within each, the first code-access
// call decides that session's vote — first hop, not totals, because totals are
// dominated by whichever tool the model settled into, while the first choice is
// the one gravity actually decides. A session that opens with `Read` has already
// paid for the file; what follows is damage control.
//
// USAGE
//   node scripts/gravity-report.mjs [repoPath] [--gap 30] [--json]
//
// A/B-ing the next-step hints: run some sessions with SLIMDEX_HINTS=0 and some
// without, then compare. This script reports what happened; it does not run the
// agent, because a scripted agent chooses nothing and would measure only itself.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const asJson = args.includes("--json");
const GAP_MIN = Number(flag("gap", 30));
const root = path.resolve(args.find((a) => !a.startsWith("--") && !/^\d+$/.test(a)) || process.cwd());

const SLIMDEX_READS = new Set([
  "get_file_skeleton",
  "get_symbol_context",
  "read_lines",
  "outline_file",
  "context_pack",
  "get_context",
  "search_code",
  "find_definition",
  "find_references",
  "search_symbols",
  "search_intent",
  "repo_map",
]);
const SLIMDEX_WRITES = new Set(["replace_symbol"]);

function loadHookEvents(dir) {
  const f = path.join(dir, ".slimdex", "hook-events.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        const e = JSON.parse(l);
        // Only the gravity ledger. Intervention records describe what the hook
        // did, not what the model chose, and counting both double-counts a turn.
        return e.g ? [{ t: Date.parse(e.t), side: "builtin", kind: e.g, tool: e.tool, file: e.file }] : [];
      } catch {
        return [];
      }
    });
}

function loadServerJournal(dir) {
  const f = path.join(dir, ".slimdex", "journal.json");
  if (!existsSync(f)) return [];
  try {
    const data = JSON.parse(readFileSync(f, "utf8"));
    return (data.entries || []).flatMap((e) => {
      const kind = SLIMDEX_WRITES.has(e.tool) ? "edit" : SLIMDEX_READS.has(e.tool) ? "read" : null;
      return kind ? [{ t: Date.parse(e.t), side: "slimdex", kind, tool: e.tool, file: e.hint }] : [];
    });
  } catch {
    return [];
  }
}

function sessionize(events, gapMs) {
  const out = [];
  let cur = null;
  for (const e of events) {
    if (!cur || e.t - cur.end > gapMs) {
      cur = { start: e.t, end: e.t, events: [] };
      out.push(cur);
    }
    cur.end = e.t;
    cur.events.push(e);
  }
  return out;
}

const events = [...loadHookEvents(root), ...loadServerJournal(root)]
  .filter((e) => Number.isFinite(e.t))
  .sort((a, b) => a.t - b.t);

if (events.length === 0) {
  console.log(`No activity recorded under ${root}/.slimdex/.

Nothing has been measured yet. The ledger needs:
  - the PreToolUse hook installed   (npm run install-hook)   -> built-in calls
  - at least one slimdex tool call  (any session)            -> slimdex calls

A repo with only one of the two produces a 0% or 100% reading that means nothing.`);
  process.exit(0);
}

const sessions = sessionize(events, GAP_MIN * 60_000);

let firstBuiltin = 0;
let firstSlimdex = 0;
const totals = { builtin: { read: 0, edit: 0, write: 0 }, slimdex: { read: 0, edit: 0 } };
const rows = [];

for (const s of sessions) {
  const first = s.events[0];
  if (first.side === "builtin") firstBuiltin++;
  else firstSlimdex++;
  for (const e of s.events) totals[e.side][e.kind] = (totals[e.side][e.kind] || 0) + 1;
  rows.push({
    started: new Date(s.start).toISOString().replace("T", " ").slice(0, 16),
    calls: s.events.length,
    firstHop: `${first.side}:${first.tool}`,
  });
}

const builtinCalls = Object.values(totals.builtin).reduce((a, b) => a + b, 0);
const slimdexCalls = Object.values(totals.slimdex).reduce((a, b) => a + b, 0);
const pct = (n, d) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(0)}%`);

if (asJson) {
  console.log(JSON.stringify({ root, sessions: sessions.length, firstBuiltin, firstSlimdex, totals, rows }, null, 2));
  process.exit(0);
}

console.log(`gravity report — ${root}
sessions: ${sessions.length} (split on ${GAP_MIN}min gaps)

FIRST HOP  (which tool the model reached for first, per session)
  slimdex   ${String(firstSlimdex).padStart(4)}   ${pct(firstSlimdex, sessions.length)}
  built-in  ${String(firstBuiltin).padStart(4)}   ${pct(firstBuiltin, sessions.length)}

ALL CALLS
  slimdex   ${String(slimdexCalls).padStart(4)}   read ${totals.slimdex.read || 0}  replace_symbol ${totals.slimdex.edit || 0}
  built-in  ${String(builtinCalls).padStart(4)}   read ${totals.builtin.read || 0}  edit ${totals.builtin.edit || 0}  write ${totals.builtin.write || 0}
`);

if (rows.length) {
  console.log("PER SESSION");
  for (const r of rows.slice(-15)) {
    console.log(`  ${r.started}  ${String(r.calls).padStart(4)} calls   first: ${r.firstHop}`);
  }
  if (rows.length > 15) console.log(`  … ${rows.length - 15} earlier session(s)`);
}

// A one-sided ledger produces a flattering number that means nothing, and the
// most likely cause is mundane: the gravity records began after the server
// journal did, so every earlier session is slimdex-only by construction. Say so
// rather than let a 100% first-hop rate be quoted.
const firstBuiltinAt = events.find((e) => e.side === "builtin")?.t;
const firstSlimdexAt = events.find((e) => e.side === "slimdex")?.t;
const ledgerLate = firstBuiltinAt && firstSlimdexAt && firstBuiltinAt - firstSlimdexAt > 24 * 3600_000;

if (builtinCalls === 0) {
  console.log(`
⚠ Zero built-in calls recorded. Either the hook is not installed in this repo,
  or its journal was pruned. A 100% first-hop rate from a one-sided ledger is
  not evidence — verify with: npm run install-hook -- --local`);
} else if (ledgerLate) {
  const from = new Date(firstBuiltinAt).toISOString().slice(0, 10);
  console.log(`
⚠ The built-in ledger only starts ${from}, while slimdex activity goes back
  further. Sessions before that date could only ever record slimdex calls, so
  the first-hop rate above is inflated. Trust sessions from ${from} onward, and
  re-run once a few real sessions have accumulated.`);
}
