#!/usr/bin/env node
// A PreToolUse hook that puts slimdex in front of the DECISION, not in a
// paragraph the model read forty turns ago.
//
// Why this exists at all: MCP is additive. A server exposes tools; it cannot
// wrap or replace the host's built-in Read/Edit/Write, so nothing in slimdex
// can make an editor route through `replace_symbol`. The choice is made by the
// model from tool descriptions — and it loses, reliably. Three separate audit
// sessions read "use replace_symbol" on every single turn and still reached for
// Edit, because the built-ins are shorter, always present, and heavily
// represented in training.
//
// A hook is the only place the deciding signal actually exists: how much OLD
// CODE you are about to re-send, and whether a symbol actually covers it. Both
// are invisible when the instructions are written and obvious at call time.
//
// DESIGN RULES, all three learned the hard way:
//
//   1. Fire only where replace_symbol genuinely WINS. A one-line change inside
//      a 250-line component is a case where Edit is correct, and pushing
//      replace_symbol there costs MORE output tokens, not fewer — the exact
//      failure this is meant to prevent. Hence a line threshold, not "any Edit".
//   2. Fire only where replace_symbol CAN be used. A 40-line edit to an HTML
//      fragment or the interior of an IIFE trips the line threshold but has no
//      symbol to address, so the advice is unfollowable — and unfollowable
//      advice is how a signal gets tuned out. Hence the index lookup: the hook
//      must be able to NAME the symbol before it recommends naming it.
//   3. Stay silent where slimdex is not in use. The hook checks for an existing
//      .slimdex index and exits otherwise, so installing it globally cannot
//      make an agent chase a tool that isn't connected.
//
// MODES (SLIMDEX_HOOK_MODE):
//   nudge (default) — emits PreToolUse JSON carrying `additionalContext`, which
//                     Claude Code places next to the tool result. THE MODEL SEES
//                     IT and the call still proceeds. This is the only mode that
//                     both informs and costs nothing when the advice is wrong.
//   warn            — emits `systemMessage`: the USER sees it, the model does
//                     not, the call proceeds. Use it to audit what would be
//                     redirected without touching agent behaviour.
//   block           — writes to stderr and exits 2, which Claude Code feeds
//                     back to the model and CANCELS the call.
//
// Why `nudge` is the default, and why plain stdout is not a mode any more:
// PreToolUse stdout on exit 0 goes to the DEBUG LOG. Not the transcript, not
// the model. The old default printed careful advice into a void — the hook was
// installed, fired correctly, and could not reach anyone. That is the single
// reason the write discipline it exists to enforce kept losing.
//
// Install: see docs/hooks.md.

import { existsSync, statSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Journal size at which the oldest entries are dropped. */
const JOURNAL_MAX_BYTES = 262_144;
const JOURNAL_KEEP_LINES = 500;

const MODE = (process.env.SLIMDEX_HOOK_MODE || "nudge").toLowerCase();

/** Re-sending at least this many lines of existing code is where replace_symbol pays. */
const EDIT_LINE_THRESHOLD = Number(process.env.SLIMDEX_HOOK_EDIT_LINES || 25);

/** Rough byte size at which a whole-file read should have been a skeleton (~300 lines). */
const READ_BYTE_THRESHOLD = Number(process.env.SLIMDEX_HOOK_READ_BYTES || 12000);

/**
 * How far into the edited span a definition may start and still count as "this
 * edit is a whole-symbol rewrite". Zero would miss every function preceded by
 * its own doc comment (the common case in this codebase); a large window would
 * match an edit that merely happens to run past an unrelated definition.
 */
const DEF_LINE_WINDOW = Number(process.env.SLIMDEX_HOOK_DEF_WINDOW || 10);

/** Don't scan a pathological file to locate old_string; the advice isn't worth it. */
const MAX_SCAN_BYTES = 8_000_000;

// CLIENTS. Claude Code and VS Code Copilot both run PreToolUse hooks, and VS
// Code reads .claude/settings.json directly — so one install covers both. What
// does NOT carry over is the vocabulary: Copilot's built-ins are `editFiles`,
// `createFile`, `readFile` (sometimes namespaced `edit/editFiles`), and its
// tool_input uses camelCase keys. Matching only Claude Code's names is the same
// silent-no-op the stdout default was, just wearing a different client.
//
// Unknown names are treated as "not an edit" rather than guessed at: run with
// SLIMDEX_HOOK_TRACE=1 for one session and the journal records every tool_name
// and input key this client actually sends, which turns a guess into a
// measurement. That is how the CRLF bug should have been found.
const norm = (name) => String(name || "").split("/").pop();
const EDIT_TOOLS = new Set([
  "Edit", "MultiEdit", "editFiles", "replace_string_in_file", "insert_edit_into_file", "apply_patch",
]);
const WRITE_TOOLS = new Set(["Write", "createFile", "create_file"]);
const READ_TOOLS = new Set(["Read", "readFile", "read_file"]);

/** First present key, so one hook reads both snake_case and camelCase clients. */
const pick = (obj, ...keys) => {
  for (const k of keys) if (obj && typeof obj[k] === "string" && obj[k]) return obj[k];
  return "";
};

/** Extensions slimdex indexes; anything else it has nothing better to offer for. */
const INDEXED = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".cs", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cc", ".kt", ".swift",
  ".scala", ".m", ".mm", ".vue", ".svelte", ".cls", ".trigger",
  ".css", ".scss", ".less", ".html", ".htm",
]);

async function readStdin() {
  let s = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

function lineCount(s) {
  return typeof s === "string" && s.length ? s.split(/\r?\n/).length : 0;
}

/**
 * Record what the hook decided, so `stats` can report a MEASURED fact ("4 edits
 * re-sent a whole symbol") instead of inferring one from file counts. The hook
 * is a separate process from the server, so a tiny append-only log is the
 * cheapest honest channel between them.
 *
 * Best-effort by construction: a journal that fails must never cost a tool call.
 */
function journal(root, event) {
  try {
    const file = path.join(root, ".slimdex", "hook-events.jsonl");
    // Bounded, because this appends on every large edit and nothing else prunes
    // it. Keeping the tail matters more than the head: the window that gets
    // reported is recent, and an unbounded log in a dot-directory is exactly the
    // kind of thing nobody notices until it is 40 MB.
    try {
      if (statSync(file).size > JOURNAL_MAX_BYTES) {
        const kept = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-JOURNAL_KEEP_LINES);
        writeFileSync(file, kept.join("\n") + "\n");
      }
    } catch {
      /* no journal yet, or unreadable — the append below decides */
    }
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n");
  } catch {
    /* ignore */
  }
}

/** Emit advice in the configured mode. Never throws; a hook must not break a tool call. */
function advise(message) {
  const text = `slimdex: ${message}`;
  if (MODE === "block") {
    process.stderr.write(text + "\n");
    process.exit(2); // Claude Code: cancel the call and show stderr to the model
  }
  if (MODE === "warn") {
    // systemMessage reaches the USER. Deliberately not additionalContext: warn
    // exists for auditing without changing what the agent does.
    process.stdout.write(JSON.stringify({ systemMessage: text }) + "\n");
    process.exit(0);
  }
  // nudge: the model sees this next to the tool result, and the call proceeds.
  // No permissionDecision field — absent means the normal permission flow, which
  // is what we want and is stable across clients.
  //
  // `systemMessage` rides along deliberately. additionalContext is verified on
  // Claude Code but is NOT documented for PreToolUse on VS Code Copilot, and a
  // channel that might be ignored is exactly how this hook spent its first
  // release talking to nobody. systemMessage is documented on both and reaches
  // the user, so the worst case degrades to "a human sees it" instead of
  // silence. Costs one line; removes a whole class of null mode.
  process.stdout.write(
    JSON.stringify({
      systemMessage: text,
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text },
    }) + "\n"
  );
  process.exit(0);
}

/** The index, or null if it cannot be read. Never throws. */
function loadIndex(root) {
  try {
    const raw = readFileSync(path.join(root, ".slimdex", "index.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.files ? parsed : null;
  } catch {
    return null;
  }
}

/** CRLF and LF must compare equal here — see startLineOf. */
const toLF = (s) => s.replace(/\r\n/g, "\n");

/**
 * 1-indexed line on which `needle` starts inside `haystack`, or 0 if
 * absent/ambiguous.
 *
 * Both sides are normalised to LF first, and that is not a nicety: on Windows
 * nearly every source file is CRLF while an `old_string` routinely arrives with
 * LF endings. A raw indexOf then fails on every file in the repo, the hook goes
 * quiet, and it looks exactly like "no symbol covered the edit" — a silent
 * false negative that disables the whole mechanism on the platform it was
 * written on. Caught only by running it against a real CRLF repo; LF fixtures
 * pass either way.
 */
function startLineOf(haystack, needle) {
  const at = haystack.indexOf(needle);
  if (at < 0) return 0;
  // A non-unique old_string is Edit's own error to report, not ours.
  if (haystack.indexOf(needle, at + 1) >= 0) return 0;
  let line = 1;
  for (let i = 0; i < at; i++) if (haystack.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Decide whether this edit is a whole-symbol rewrite, and if so which symbol.
 *
 * Returns null when the hook should stay quiet — which is most of the time, and
 * is the point. The caller must be able to say "use replace_symbol on X"; if we
 * cannot fill in X, we have nothing useful to say.
 */
function coveringSymbol(index, root, absFile, oldString) {
  const rel = path.relative(root, absFile).split(path.sep).join("/");
  const entry = index.files[rel];
  if (!entry || !Array.isArray(entry.symbols) || entry.symbols.length === 0) return null;

  let source;
  try {
    if (statSync(absFile).size > MAX_SCAN_BYTES) return null;
    source = readFileSync(absFile, "utf8");
  } catch {
    return null;
  }

  const start = startLineOf(toLF(source), toLF(oldString));
  if (!start) return null;
  const end = start + lineCount(oldString) - 1;

  // A definition that begins at (or just after) the top of the edited span is
  // the signature of "you are re-sending this whole symbol to locate it". A
  // definition merely somewhere in the middle is not: that is an edit spanning
  // a boundary, where replace_symbol would have to rewrite more than you meant.
  const hit = entry.symbols
    .filter((s) => s.line >= start && s.line <= Math.min(end, start + DEF_LINE_WINDOW))
    .sort((a, b) => a.line - b.line)[0];
  if (!hit) return null;

  // Ambiguity check: replace_symbol refuses a name with several definitions
  // rather than guessing, so advice that says name:"X" would cost a round-trip.
  // Names repeat constantly in CSS (`.space` four times in one sheet is normal).
  let occurrences = 0;
  for (const e of Object.values(index.files))
    for (const s of e.symbols || []) if (s.name === hit.name) occurrences++;

  return { name: hit.name, kind: hit.kind, line: hit.line, file: rel, ambiguous: occurrences > 1 };
}

try {
  const hook = JSON.parse((await readStdin()) || "{}");
  const cwd = hook.cwd || process.cwd();

  // Silent unless this repo actually uses slimdex. This is what makes a global
  // install safe: no index, no opinion.
  if (!existsSync(path.join(cwd, ".slimdex", "index.json"))) process.exit(0);

  const tool = norm(hook.tool_name);
  const input = hook.tool_input || {};
  const file = pick(input, "file_path", "filePath", "path", "uri");
  const ext = path.extname(file).toLowerCase();

  // Discovery mode: record what this client actually sends, then exit. One
  // session with this on tells you the real tool names and input keys instead
  // of inferring them from documentation.
  if (process.env.SLIMDEX_HOOK_TRACE) {
    journal(cwd, { trace: true, tool: hook.tool_name, inputKeys: Object.keys(input) });
  }

  if (EDIT_TOOLS.has(tool)) {
    // MultiEdit carries an array; judge it by its largest single replacement,
    // since that is the one that would have been a replace_symbol.
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    let biggest = null;
    for (const e of edits) {
      const old = pick(e, "old_string", "oldString", "oldStr", "old");
      const n = lineCount(old);
      if (!biggest || n > biggest.n) biggest = { n, old };
    }
    if (!biggest || biggest.n < EDIT_LINE_THRESHOLD || !INDEXED.has(ext)) process.exit(0);

    const index = loadIndex(cwd);
    const sym = index && file ? coveringSymbol(index, cwd, file, biggest.old) : null;
    if (!sym) {
      // Big edit, but nothing addressable covers it — an HTML fragment, the
      // interior of an IIFE, a config block. Edit is the right tool. Record the
      // near-miss so the thresholds can be judged against real sessions.
      journal(cwd, { tool, file: path.basename(file), lines: biggest.n, fired: false, reason: "no covering symbol" });
      process.exit(0);
    }

    const address = sym.ambiguous
      ? `path:"${sym.file}" line:${sym.line}`
      : `name:"${sym.name}"`;
    const ambiguityNote = sym.ambiguous
      ? ` ("${sym.name}" is defined in more than one place, so address it by path+line — replace_symbol refuses an ambiguous name rather than guessing.)`
      : "";
    journal(cwd, { tool, file: sym.file, lines: biggest.n, fired: true, symbol: sym.name });
    advise(
      `this Edit re-sends ${biggest.n} lines of existing code just to locate a change to ${sym.kind} ` +
        `${sym.name} (${sym.file}:${sym.line}). replace_symbol ${address} body:"…" rewrites it by address — you emit ` +
        `only the new body, roughly half the output. It snapshots first, re-indexes after, reports the new span, and ` +
        `names any nested definition your body dropped.${ambiguityNote} ` +
        `(Adding something new rather than rewriting? replace_symbol after:"<neighbour>" body:"…".)`
    );
  }

  if (WRITE_TOOLS.has(tool) && file && existsSync(file)) {
    const size = statSync(file).size;
    if (size >= READ_BYTE_THRESHOLD && INDEXED.has(ext)) {
      journal(cwd, { tool, file: path.basename(file), bytes: size, fired: true });
      advise(
        `Write replaces all of ${path.basename(file)} (${size} bytes). If you are changing part of it, ` +
          `replace_symbol costs a fraction of a whole-file rewrite — output tokens are the expensive side.`
      );
    }
    process.exit(0);
  }

  if (READ_TOOLS.has(tool) && file) {
    // A ranged read is already the disciplined move; only whole-file reads qualify.
    if (input.offset || input.limit) process.exit(0);
    if (!INDEXED.has(ext) || !existsSync(file)) process.exit(0);
    const size = statSync(file).size;
    if (size >= READ_BYTE_THRESHOLD) {
      journal(cwd, { tool, file: path.basename(file), bytes: size, fired: true });
      advise(
        `${path.basename(file)} is ${size} bytes — get_file_skeleton first, then pull only the bodies you need ` +
          `with get_symbol_context names:[…] or read_lines. A whole-file read is the single biggest avoidable cost.`
      );
    }
  }
} catch {
  // A broken hook must never block real work.
}
process.exit(0);
