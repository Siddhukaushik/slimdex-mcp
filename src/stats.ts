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

/**
 * The write side of the discipline, which nothing measured.
 *
 * `follow-through` worked because it turned an invisible overpayment into a
 * number: skeletons that were never followed by a narrow read show up as a low
 * ratio, and you cannot argue with your own transcript. There was no equivalent
 * for editing, and the cost of that showed up in a real session — dozens of
 * whole-symbol rewrites sent through a generic edit tool (which has to be handed
 * the old body just to locate the change), three hand-rolled line splices, and a
 * build broken by an edit `find_tests` would have flagged in one call.
 *
 * The rules against all three were being injected every turn and lost anyway.
 * Rules compete with a trained reflex; a count of what you actually did does not.
 */
export interface WriteStat {
  /** Symbols rewritten through replace_symbol (a batch of 5 counts 5). */
  slimdexSymbols: number;
  /** replace_symbol calls, batched or not. */
  slimdexCalls: number;
  /**
   * Files that changed on disk between one index_repo and the next, which
   * slimdex did not write. Not proof the agent edited them — a human with an
   * editor open counts too — so the wording in the report says "outside
   * slimdex", not "you".
   */
  externalFiles: number;
  /**
   * Write events with no find_tests / dep_graph / get_context / changed_files
   * call since the previous one. The precautionary tools are exactly the ones
   * skipped under momentum, because their payoff is a mistake that hasn't
   * happened yet.
   */
  blindEdits: number;
  /** Pre-edit checks called at all, so a good session can show as good. */
  checks: number;
}

export interface StatsFile {
  version: 2;
  since: string;
  /**
   * When the `write` counters started accumulating, which is NOT always `since`.
   * The write block shipped after the tool counters did, so a repo that has been
   * recording since last week migrates with a full tool history and a write
   * history of zero. Reported together they read as a contradiction — the table
   * showing `replace_symbol: 2 calls` directly above `replace_symbol: 0 call(s)`
   * — and the instrument that is supposed to catch sloppy editing instead looks
   * broken. Carrying the second window makes the gap explicit rather than
   * silent.
   *
   * Optional, and deliberately not back-filled: a file already carrying write
   * counters but no stamp was written by the build where the block had just
   * shipped, and its true start is unrecoverable. Defaulting it to `since`
   * would re-assert the very claim this field exists to retract, and defaulting
   * it to `now` would quietly shrink a window the counts were not earned in.
   * Absent means unknown, and the report says unknown.
   */
  writeSince?: string;
  tools: Record<string, ToolStat>;
  write: WriteStat;
}

/**
 * What the PreToolUse hook actually observed, as opposed to what the server can
 * infer from its own call log.
 *
 * The server cannot see a built-in `Edit` — it only notices, later, that a file
 * changed underneath the index. That gap is why the write warning used to be
 * phrased as a conditional ("IF any were whole-function rewrites"), and a
 * conditional that fires on every session with more than one externally-edited
 * file is a signal that gets tuned out — it was, in a real audit, and the
 * warning was then repeated to a user as fact.
 *
 * The hook runs in front of the decision and knows both things the server
 * cannot: how many lines of old code the edit re-sent, and whether a symbol
 * actually covered them. It journals that verdict; this reads it back, so the
 * report can state a measurement instead of a suspicion.
 */
export interface BypassStat {
  /** Edits the hook confirmed were whole-symbol rewrites sent through a generic edit tool. */
  wholeSymbolEdits: number;
  /** Big edits with no symbol covering them — cases where a generic edit tool is CORRECT. */
  correctGenericEdits: number;
  /** Whole-file reads of large indexed files. */
  wholeFileReads: number;
  /** Symbols involved, most recent first, for naming names. */
  symbols: string[];
}

/** Tools whose whole purpose is to be called BEFORE a change. */
const PRE_EDIT_CHECKS = new Set(["find_tests", "dep_graph", "get_context", "changed_files"]);

const emptyWrite = (): WriteStat => ({
  slimdexSymbols: 0,
  slimdexCalls: 0,
  externalFiles: 0,
  blindEdits: 0,
  checks: 0,
});

const empty = (): StatsFile => {
  const now = new Date().toISOString();
  return { version: 2, since: now, writeSince: now, tools: {}, write: emptyWrite() };
};

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
  /**
   * Pre-edit checks seen since the last write event. Process-local and never
   * persisted: "did you look before this edit" is a question about one sequence
   * of calls, and a count reloaded from disk would answer it with a check made
   * last Tuesday.
   */
  checksSinceWrite: number;
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
    // v1 had no `write` block. Migrate rather than discard: the all-time tool
    // counters are the one number a repo cannot reconstruct, and throwing them
    // away to add a field would be a poor trade.
    if (parsed && (parsed.version === 1 || parsed.version === 2) && parsed.tools) {
      // A file with no `write` block predates the counters entirely, so they
      // begin now — not at `since`, which would credit the write block with a
      // week of history it never observed. A file that HAS the block but no
      // stamp keeps `undefined`: unknown, reported as unknown.
      const writeSince: string | undefined = parsed.writeSince ?? (parsed.write ? undefined : new Date().toISOString());
      const data: StatsFile = {
        ...parsed,
        version: 2,
        writeSince,
        write: { ...emptyWrite(), ...(parsed.write ?? {}) },
      };
      states.set(rootKey, { data, session: empty(), flushTimer: null, checksSinceWrite: 0 });
      return data;
    }
  } catch {
    /* fresh */
  }
  const data = empty();
  states.set(rootKey, { data, session: empty(), flushTimer: null, checksSinceWrite: 0 });
  return data;
}

/**
 * Record symbols rewritten through replace_symbol — the good path, counted so
 * the report can compare it against what happened outside slimdex.
 */
export async function recordSlimdexWrite(root: string, symbols: number): Promise<void> {
  await loadStats(root);
  const state = states.get(key(root))!;
  for (const w of [state.data.write, state.session.write]) {
    w.slimdexCalls++;
    w.slimdexSymbols += symbols;
    if (state.checksSinceWrite === 0) w.blindEdits++;
  }
  state.checksSinceWrite = 0;
}

/**
 * Record files that changed on disk without slimdex writing them.
 *
 * These are detectable at all only because the index stores a content hash per
 * file: anything index_repo has to re-parse whose hash moved was edited by
 * something else. replace_symbol re-indexes immediately after writing, so its
 * own edits are already absorbed by the time a later index_repo runs and are
 * never miscounted here — except if that inline re-index failed, which the
 * response already warns loudly about.
 */
export async function recordExternalEdits(root: string, files: number): Promise<void> {
  if (files <= 0) return;
  await loadStats(root);
  const state = states.get(key(root))!;
  for (const w of [state.data.write, state.session.write]) {
    w.externalFiles += files;
    if (state.checksSinceWrite === 0) w.blindEdits++;
  }
  state.checksSinceWrite = 0;
}

/**
 * Counters for this process only — what the work in front of you actually cost,
 * as opposed to everything ever recorded for this repo.
 */
/**
 * Zero the session tally, leaving the all-time counters untouched.
 *
 * "Session" here means "since this process started", and an MCP server is
 * long-lived — one process serves many chats. So `session:true` alone answers
 * "since the server booted", which across a day of work is nearly as useless as
 * the cumulative number it was meant to replace: a reviewer measuring one audit
 * got a figure spanning three.
 *
 * This is the missing half. Call it when a task begins and `session:true` at
 * the end, and the difference is that task. `reset` cannot serve this purpose —
 * it destroys the repo's all-time history, which is the one number you cannot
 * reconstruct.
 */
export async function checkpointStats(root: string): Promise<void> {
  await loadStats(root); // ensure the root has state
  states.get(key(root))!.session = empty(); // `since` becomes now
}

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
  // A failed check is not a check — it told the model nothing, so it must not
  // buy credit for the edit that follows.
  if (!isError && PRE_EDIT_CHECKS.has(tool)) {
    state.checksSinceWrite++;
    for (const w of [s.write, state.session.write]) w.checks++;
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
  states.set(rootKey, { data: empty(), session: empty(), flushTimer: null, checksSinceWrite: 0 });
  await flush(root);
}

/**
 * Capabilities worth naming when they went unused, and the question each one
 * answers. Deliberately NOT all 29 tools — a list that long is wallpaper, and a
 * report nobody reads measures nothing.
 *
 * These are the ones with no cheap substitute, where the fallback is either a
 * broad read or a guess: skipping `dep_graph` doesn't fail, it just means you
 * found callers with grep and hoped that was all of them. That is exactly the
 * class of tool that loses to a reflex, because nothing signals the loss.
 */
const WORTH_PROMPTING: Array<[string, string]> = [
  ["brief", "opens a session with prior conclusions instead of re-exploring"],
  ["context_pack", "one bundle for 'how does X work', instead of ~10 calls"],
  ["get_file_skeleton", "maps a big file for a fraction of a full read"],
  ["get_context", "definition + callers + deps in one call"],
  ["find_tests", "names the covering tests BEFORE you change a symbol"],
  ["dep_graph", "blast radius of a shared module while it is still cheap"],
  ["replace_symbol", "rewrite by name, without re-sending the old body"],
  ["search_intent", "finds a symbol when you know the behaviour, not the name"],
  ["memory_save", "the only thing that survives this chat"],
  ["digest_save", "an architecture cheat-sheet the next session reads instead of re-exploring"],
  ["recap", "what past sessions actually did, reconstructed from the journal"],
];

/**
 * Name the capabilities that were never reached for.
 *
 * The write-discipline block catches doing a thing the expensive way. This
 * catches not doing it at all — the more common failure, and the harder one to
 * notice, since an unused tool produces no evidence of its absence. A session
 * that never called `find_tests` looks identical to one where nothing needed
 * testing.
 */
export function formatUnused(s: StatsFile): string {
  const totalCalls = Object.values(s.tools).reduce((n, t) => n + t.calls, 0);
  // Under ~5 calls there is no pattern yet, only a short session.
  if (totalCalls < 5) return "";
  const unused = WORTH_PROMPTING.filter(([name]) => !(s.tools[name]?.calls > 0));
  if (unused.length === 0) return "";
  return (
    `\nnot reached for this session:\n` +
    unused.map(([name, why]) => `  ${name.padEnd(20)} ${why}`).join("\n") +
    `\n(Not a checklist — plenty of sessions legitimately need none of these. But an` +
    ` unused tool leaves no trace, so this is the only place its absence is visible.)`
  );
}

/**
 * Read back the PreToolUse hook's journal.
 *
 * Best-effort and forgiving: the hook is a separate process that may not be
 * installed at all, and a missing or half-written journal must degrade to "no
 * measurement", never to an error. `since` bounds the window so the write block
 * describes the same period as the counters above it.
 */
export async function loadBypass(root: string, since?: string): Promise<BypassStat | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, ".slimdex", "hook-events.jsonl"), "utf8");
  } catch {
    return undefined; // hook not installed, or nothing recorded yet
  }
  const out: BypassStat = { wholeSymbolEdits: 0, correctGenericEdits: 0, wholeFileReads: 0, symbols: [] };
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue; // a torn final line from a concurrent append
    }
    if (since && typeof e.t === "string" && e.t < since) continue;
    if (e.tool === "Edit" || e.tool === "MultiEdit") {
      if (e.fired) {
        out.wholeSymbolEdits++;
        if (e.symbol && !seen.has(e.symbol)) {
          seen.add(e.symbol);
          out.symbols.unshift(e.symbol);
        }
      } else out.correctGenericEdits++;
    } else if (e.tool === "Read" && e.fired) out.wholeFileReads++;
  }
  return out;
}

export function formatStats(s: StatsFile, bypass?: BypassStat): string {
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
    followThrough +
    formatWrite(s.write, { writeSince: s.writeSince, since: s.since }, bypass) +
    formatUnused(s)
  );
}

/**
 * The write-side companion to follow-through.
 *
 * Deliberately reports counts and one verdict line, not a lecture. The failure
 * this exists to catch is not an agent that disagrees with the rules — it is one
 * that never weighed them, because a generic edit tool is a reflex and
 * replace_symbol is a decision. A number in your own transcript is the only
 * thing observed to interrupt that.
 */
export function formatWrite(
  w: WriteStat | undefined,
  window?: { writeSince?: string; since?: string },
  bypass?: BypassStat
): string {
  if (!w) return "";
  const touched = w.slimdexCalls + w.externalFiles;
  if (touched === 0) return ""; // read-only session; nothing to say
  // Three cases, and the wrong one to collapse is the third: a stamp equal to
  // `since` and a missing stamp mean different things, and only the first
  // licenses comparing this block against the table above it.
  const known = window?.writeSince;
  const differs = known && window?.since && known !== window.since;
  const unknown = !known && !!window?.since;
  const heading = differs
    ? `\nwrite discipline (since ${known}; the table above starts ${window!.since}):`
    : unknown
      ? `\nwrite discipline (window unknown; the table above starts ${window!.since}):`
      : `\nwrite discipline:`;
  const lines = [
    heading,
    `  replace_symbol: ${w.slimdexCalls} call(s), ${w.slimdexSymbols} symbol(s) rewritten by name`,
    `  changed outside slimdex: ${w.externalFiles} file(s)`,
    `  pre-edit checks (find_tests/dep_graph/get_context/changed_files): ${w.checks}`,
  ];
  if (differs || unknown) {
    lines.push(
      `  (These counters started later than the tool counters, so they cannot be compared` +
        ` against the table above — a zero here may mean "not recorded yet", not "never done".)`
    );
  }
  // Measured beats inferred. With the hook installed we know which edits were
  // whole-symbol rewrites; without it we can only note that we cannot tell, and
  // saying so is better than a conditional warning that fires either way.
  if (bypass) {
    if (bypass.wholeSymbolEdits > 0) {
      const named = bypass.symbols.slice(0, 3).join(", ");
      lines.push(
        `  ⚠ ${bypass.wholeSymbolEdits} edit(s) re-sent a whole symbol's body through a generic edit tool` +
          (named ? ` (${named}${bypass.symbols.length > 3 ? ", …" : ""})` : "") +
          `. The old body bought nothing but the location — output tokens cost ~4-5x input.`
      );
    } else if (bypass.correctGenericEdits > 0) {
      lines.push(
        `  ${bypass.correctGenericEdits} large edit(s) had no symbol covering them — a generic edit tool was the` +
          ` right call there, and replace_symbol would have cost more.`
      );
    }
    if (bypass.wholeFileReads > 0) {
      lines.push(
        `  ⚠ ${bypass.wholeFileReads} whole-file read(s) of a large indexed file — get_file_skeleton then narrow` +
          ` reads costs a fraction.`
      );
    }
  } else if (w.externalFiles > w.slimdexSymbols && w.externalFiles > 1) {
    lines.push(
      `  ${w.externalFiles} file(s) changed outside slimdex. Whether any were whole-symbol rewrites (the expensive` +
        ` case) is not observable from here — the PreToolUse hook measures it directly: see docs/hooks.md.`
    );
  }
  if (w.blindEdits > 0) {
    lines.push(
      `  ⚠ ${w.blindEdits} write(s) with no preceding check. find_tests names the covering tests` +
        ` before a change instead of a failed build after it; dep_graph shows the blast radius of a` +
        ` shared module while it is still cheap to know.`
    );
  }
  return lines.join("\n");
}
