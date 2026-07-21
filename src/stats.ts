// Usage accounting.
//
// The README claims this server saves tokens; nothing measured it. This records
// per-tool call counts and response sizes to <root>/.codeglance/stats.json so the
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

import { promises as fs } from "node:fs";
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

let cache: StatsFile | null = null;
let flushTimer: NodeJS.Timeout | null = null;

function file(root: string): string {
  return path.join(root, ".codeglance", "stats.json");
}

export async function loadStats(root: string): Promise<StatsFile> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(file(root), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && parsed.tools) {
      cache = parsed as StatsFile;
      return cache;
    }
  } catch {
    /* fresh */
  }
  cache = empty();
  return cache;
}

async function flush(root: string): Promise<void> {
  if (!cache) return;
  try {
    await fs.mkdir(path.dirname(file(root)), { recursive: true });
    await fs.writeFile(file(root), JSON.stringify(cache, null, 2), "utf8");
  } catch {
    /* stats are best-effort; never surface an error to the model */
  }
}

export async function record(root: string, tool: string, responseChars: number, isError: boolean): Promise<void> {
  const s = await loadStats(root);
  const t = (s.tools[tool] ??= { calls: 0, chars: 0, maxChars: 0, errors: 0 });
  t.calls++;
  t.chars += responseChars;
  if (responseChars > t.maxChars) t.maxChars = responseChars;
  if (isError) t.errors++;
  // Debounce: a batch of 20 calls shouldn't mean 20 disk writes.
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(root), 1500);
  flushTimer.unref?.();
}

export async function resetStats(root: string): Promise<void> {
  cache = empty();
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
  return (
    `codeglance usage since ${s.since}\n${body}\n` +
    `  ${"TOTAL".padEnd(20)} ${String(totalCalls).padStart(5)} calls  ${String(total).padStart(9)} chars\n` +
    `(chars, not tokens — see stats.ts for why)`
  );
}
