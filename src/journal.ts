// Automatic activity journal — the continuity layer that needs NO agent
// cooperation. The server never sees the conversation, so it cannot save
// conclusions; but it sees every tool call, and that is enough to leave a
// scent trail: which files were examined, which symbols were looked up, what
// was searched. A fresh chat reads it back via the `recap` tool and starts
// where the last one left off instead of blank.
//
// Written server-side on every call (debounced), capped and rolling, so it
// can't grow unbounded and costs nothing to the model unless recap is called.

import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_ENTRIES = 400;

interface Entry {
  t: string; // ISO timestamp
  tool: string;
  hint?: string; // the interesting bit of the args: a name, path, or pattern
}

interface JournalFile {
  version: 1;
  entries: Entry[];
}

let cache: { root: string; data: JournalFile } | null = null;
let timer: NodeJS.Timeout | null = null;

function file(root: string): string {
  return path.join(root, ".slimdex", "journal.json");
}

async function load(root: string): Promise<JournalFile> {
  if (cache && cache.root === root) return cache.data;
  let data: JournalFile = { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(await fs.readFile(file(root), "utf8"));
    if (parsed && Array.isArray(parsed.entries)) data = parsed as JournalFile;
  } catch {
    /* first run or unreadable — start fresh */
  }
  cache = { root, data };
  return data;
}

// Bookkeeping calls journal nothing; journaling the journal would be noise.
const SKIP = new Set(["stats", "recap", "memory_save", "memory_search", "memory_list", "memory_delete", "batch", "index_repo", "snapshot"]);

function hintOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ["name", "query", "pattern", "target", "path", "root"]) {
    if (typeof a[k] === "string" && (a[k] as string).length) parts.push(a[k] as string);
  }
  if (Array.isArray(a.names)) for (const n of (a.names as unknown[]).slice(0, 5)) if (typeof n === "string") parts.push(n);
  return parts.length ? parts.join(" ").slice(0, 120) : undefined;
}

export async function journalRecord(root: string, tool: string, args: unknown): Promise<void> {
  if (SKIP.has(tool)) return;
  const data = await load(root);
  data.entries.push({ t: new Date().toISOString(), tool, hint: hintOf(args) });
  if (data.entries.length > MAX_ENTRIES) data.entries.splice(0, data.entries.length - MAX_ENTRIES);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushJournal(root), 300);
  timer.unref?.();
}

// Provenance for memory_save: the last few distinct hints the agent left in the
// journal, as a compact one-liner. Answers "what was on screen when this
// conclusion was reached" without the agent having to state it. Best-effort.
export async function recentHints(root: string, n = 8): Promise<string> {
  try {
    const data = await load(root);
    const seen: string[] = [];
    for (let i = data.entries.length - 1; i >= 0 && seen.length < n; i--) {
      const h = data.entries[i].hint;
      if (h && !seen.includes(h)) seen.push(h);
    }
    return seen.reverse().join(", ");
  } catch {
    return "";
  }
}

// Exposed so tests (and shutdown paths) can force the debounced write.
export async function flushJournal(root: string): Promise<void> {
  if (!cache || cache.root !== root) return;
  try {
    await fs.mkdir(path.dirname(file(root)), { recursive: true });
    await fs.writeFile(file(root), JSON.stringify(cache.data), "utf8");
  } catch {
    /* journaling must never break a tool call */
  }
}

function top(counts: Map<string, number>, n: number): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => (v > 1 ? `${k} (${v})` : k))
    .join(", ");
}

export async function formatRecap(root: string, limit = 200): Promise<string> {
  const data = await load(root);
  const entries = data.entries.slice(-Math.max(1, limit));
  if (entries.length === 0) return "No prior activity journaled yet — this looks like the first session on this repo.";

  const files = new Map<string, number>();
  const symbols = new Map<string, number>();
  const searches: string[] = [];
  const toolCounts = new Map<string, number>();

  for (const e of entries) {
    toolCounts.set(e.tool, (toolCounts.get(e.tool) ?? 0) + 1);
    if (!e.hint) continue;
    if (e.tool === "read_lines" || e.tool === "get_file_skeleton" || e.tool === "outline_file") {
      files.set(e.hint, (files.get(e.hint) ?? 0) + 1);
    } else if (e.tool === "search_code") {
      if (!searches.includes(e.hint)) searches.push(e.hint);
    } else {
      // symbol-shaped lookups: find_definition, find_references, get_context,
      // get_symbol_context, search_symbols, dep_graph targets …
      for (const part of e.hint.split(" ")) symbols.set(part, (symbols.get(part) ?? 0) + 1);
    }
  }

  const lines: string[] = [
    `Recap — last ${entries.length} journaled call(s), ${entries[0].t.slice(0, 10)} → ${entries[entries.length - 1].t.slice(0, 10)}:`,
  ];
  if (files.size) lines.push(`  files examined: ${top(files, 10)}`);
  if (symbols.size) lines.push(`  symbols looked up: ${top(symbols, 10)}`);
  if (searches.length) lines.push(`  searches: ${searches.slice(-5).map((s) => JSON.stringify(s)).join(", ")}`);
  lines.push(`  calls: ${top(toolCounts, 8)}`);
  lines.push(
    `The journal shows WHERE past sessions looked; memory_list shows WHAT they concluded. Read both before re-deriving anything.`
  );
  return lines.join("\n");
}

// Test hook.
export function clearJournalCache(): void {
  cache = null;
  if (timer) clearTimeout(timer);
  timer = null;
}
