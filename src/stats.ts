// Usage accounting.
//
// The README claims this server saves tokens; nothing measured it. This records
// per-tool call counts and response sizes to <root>/.slimdex/stats.json so the
// claim is checkable and the defaults (callerLimit, maxChars, limit) can be
// tuned against what actually happens rather than a guess.
//
// Chars, not tokens: `chars/4` estimates are unreliable across tokenizers, and
// this project already rejected pretending otherwise. Chars are what we can
// measure honestly; the ratio to tokens is roughly constant per-tokenizer, so
// relative comparisons between tools still hold.
//
// Writes are debounced and best-effort: instrumentation must never be able to
// fail a tool call.

import { promises as fs, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ToolStat {
  calls: number;
  chars: number;
  maxChars: number;
  errors: number;
}

export interface StatsFile {
  version: 1;
  since: string;
  tools: Record<string, ToolStat>;
}

const empty = (): StatsFile => ({ version: 1, since: new Date().toISOString(), tools: {} });

interface RootState {
  data: StatsFile;
  // Counters for THIS process only, tracked alongside the cumulative ones.
  //
  // stats.json accumulates until someone runs `stats reset`, so "422k chars"
  // silently spanned every earlier session on the repo and could not be
  // attributed to the work in front of you. Tracked as its own tally rather
  // than differenced from a start-of-process snapshot, because maxChars cannot
  // be recovered by subtraction — an all-time max set last week tells you
  // nothing about this session's largest response.
  session: StatsFile;
  flushTimer: NodeJS.Timeout | null;
}

const states = new Map<string, RootState>();

function key(root: string): string {
  return path.resolve(root);
}

function file(root: string): string {
  return path.join(root, ".slimdex", "stats.json");
}

export async function loadStats(root: string): Promise<StatsFile> {
  const rootKey = key(root);
  const hit = states.get(rootKey);
  if (hit) return hit.data;
  try {
    const raw = await fs.readFile(file(root), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.tools) {
      const data = parsed as StatsFile;
      states.set(rootKey, { data, session: empty(), flushTimer: null });
      return data;
    }
  } catch {
    /* fresh */
  }
  const data = empty();
  states.set(rootKey, { data, session: empty(), flushTimer: null });
  return data;
}

/**
 * Counters for this process only — what the work in front of you actually cost,
 * as opposed to everything ever recorded for this repo.
 */
export async function loadSessionStats(root: string): Promise<StatsFile> {
  await loadStats(root); // ensure the root has state
  return states.get(key(root))!.session;
}

async function flush(root: string): Promise<void> {
  const state = states.get(key(root));
  if (!state) return;
  try {
    await fs.mkdir(path.dirname(file(root)), { recursive: true });
    await fs.writeFile(file(root), JSON.stringify(state.data, null, 2), "utf8");
  } catch {
    /* stats are best-effort; never surface an error to the model */
  }
}

/**
 * Synchronous last-chance write, for process exit. The debounced flush waits
 * 1.5s on an UNREF'd timer, so a session that ended before it fired lost its
 * most recent accounting — including, ironically, the calls that measured the
 * work you just did. An exit handler cannot await, so this one is sync.
 */
export function flushStatsSync(root: string): void {
  const state = states.get(key(root));
  if (!state) return;
  try {
    mkdirSync(path.dirname(file(root)), { recursive: true });
    writeFileSync(file(root), JSON.stringify(state.data, null, 2), "utf8");
  } catch {
    /* instrumentation must never break a shutdown */
  }
}

export async function record(root: string, tool: string, responseChars: number, isError: boolean): Promise<void> {
  const s = await loadStats(root);
  const state = states.get(key(root))!;
  // Cumulative and session-only tallies move together, so the session view is
  // exact rather than a subtraction that cannot recover maxChars.
  for (const bucket of [s.tools, state.session.tools]) {
    const t = (bucket[tool] ??= { calls: 0, chars: 0, maxChars: 0, errors: 0 });
    t.calls++;
    t.chars += responseChars;
    if (responseChars > t.maxChars) t.maxChars = responseChars;
    if (isError) t.errors++;
  }
  // Debounce: a batch of 20 calls shouldn't mean 20 disk writes.
  if (state.flushTimer) clearTimeout(state.flushTimer);
  state.flushTimer = setTimeout(() => void flush(root), 1500);
  state.flushTimer.unref?.();
}

export async function resetStats(root: string): Promise<void> {
  const rootKey = key(root);
  const old = states.get(rootKey);
  if (old?.flushTimer) clearTimeout(old.flushTimer);
  states.set(rootKey, { data: empty(), session: empty(), flushTimer: null });
  await flush(root);
}

export function formatStats(s: StatsFile): string {
  const rows = Object.entries(s.tools).sort((a, b) => b[1].chars - a[1].chars);
  if (rows.length === 0) return "No tool calls recorded yet.";
  const total = rows.reduce((n, [, t]) => n + t.chars, 0);
  const totalCalls = rows.reduce((n, [, t]) => n + t.calls, 0);
  const body = rows
    .map(
      ([name, t]) =>
        `  ${name.padEnd(20)} ${String(t.calls).padStart(5)} calls  ${String(t.chars).padStart(9)} chars  ` +
        `avg ${String(Math.round(t.chars / t.calls)).padStart(6)}  max ${String(t.maxChars).padStart(6)}` +
        (t.errors ? `  (${t.errors} err)` : "")
    )
    .join("\n");
  // Follow-through: a skeleton is an *investment* that only pays off if the
  // bodies it located are then read narrowly. Skeletons followed by whole-file
  // reads (which happen client-side, invisible to us) show up here as a low
  // ratio — the one number that says whether the retrieval discipline held.
  const skeletons = s.tools["get_file_skeleton"]?.calls ?? 0;
  const narrow = (s.tools["get_symbol_context"]?.calls ?? 0) + (s.tools["read_lines"]?.calls ?? 0);
  const followThrough =
    skeletons > 0
      ? `\nfollow-through: ${skeletons} skeleton(s) → ${narrow} narrow read(s) (get_symbol_context + read_lines).` +
        (narrow < skeletons ? ` Low — bodies were likely read as whole files outside slimdex; that forfeits the saving.` : ``)
      : ``;
  return (
    `slimdex usage since ${s.since}\n${body}\n` +
    `  ${"TOTAL".padEnd(20)} ${String(totalCalls).padStart(5)} calls  ${String(total).padStart(9)} chars\n` +
    `(chars, not tokens — see stats.ts for why)` +
    followThrough
  );
}
