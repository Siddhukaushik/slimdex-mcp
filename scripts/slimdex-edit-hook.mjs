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
// CODE you are about to re-send. That is invisible when the instructions are
// written and obvious at call time.
//
// DESIGN RULES, both learned the hard way:
//
//   1. Fire only where replace_symbol genuinely WINS. A one-line change inside
//      a 250-line component is a case where Edit is correct, and pushing
//      replace_symbol there costs MORE output tokens, not fewer — the exact
//      failure this is meant to prevent. Hence a line threshold, not "any Edit".
//   2. Stay silent where slimdex is not in use. The hook checks for an existing
//      .slimdex index and exits otherwise, so installing it globally cannot
//      make an agent chase a tool that isn't connected.
//
// MODES (SLIMDEX_HOOK_MODE):
//   warn  (default) — prints to stdout and exits 0. The call proceeds. Visible
//                     in the transcript; use it to watch what WOULD have been
//                     redirected before changing anything.
//   block           — writes to stderr and exits 2, which Claude Code feeds
//                     back to the model and cancels the call. This is the mode
//                     that changes behaviour.
//
// Install: see docs/hooks.md.

import { existsSync, statSync } from "node:fs";
import path from "node:path";

const MODE = (process.env.SLIMDEX_HOOK_MODE || "warn").toLowerCase();

/** Re-sending at least this many lines of existing code is where replace_symbol pays. */
const EDIT_LINE_THRESHOLD = Number(process.env.SLIMDEX_HOOK_EDIT_LINES || 25);

/** Rough byte size at which a whole-file read should have been a skeleton (~300 lines). */
const READ_BYTE_THRESHOLD = Number(process.env.SLIMDEX_HOOK_READ_BYTES || 12000);

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

/** Emit advice in the configured mode. Never throws; a hook must not break a tool call. */
function advise(message) {
  const text = `slimdex: ${message}`;
  if (MODE === "block") {
    process.stderr.write(text + "\n");
    process.exit(2); // Claude Code: cancel the call and show stderr to the model
  }
  process.stdout.write(text + "\n");
  process.exit(0);
}

function lineCount(s) {
  return typeof s === "string" && s.length ? s.split(/\r?\n/).length : 0;
}

try {
  const hook = JSON.parse((await readStdin()) || "{}");
  const cwd = hook.cwd || process.cwd();

  // Silent unless this repo actually uses slimdex. This is what makes a global
  // install safe: no index, no opinion.
  if (!existsSync(path.join(cwd, ".slimdex", "index.json"))) process.exit(0);

  const tool = hook.tool_name || "";
  const input = hook.tool_input || {};
  const file = input.file_path || input.path || "";
  const ext = path.extname(file).toLowerCase();

  if (tool === "Edit" || tool === "MultiEdit") {
    // MultiEdit carries an array; judge it by its largest single replacement,
    // since that is the one that would have been a replace_symbol.
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    const biggest = Math.max(0, ...edits.map((e) => lineCount(e.old_string)));
    if (biggest >= EDIT_LINE_THRESHOLD && INDEXED.has(ext)) {
      advise(
        `this Edit re-sends ${biggest} lines of existing code just to locate the change. ` +
          `replace_symbol name:"<symbol>" body:"…" rewrites it by NAME — you emit only the new body, ` +
          `which is roughly half the output. It snapshots first, re-indexes after, and reports the new line span. ` +
          `(Adding something new rather than rewriting? replace_symbol after:"<neighbour>" body:"…".)`
      );
    }
    process.exit(0);
  }

  if (tool === "Write" && file && existsSync(file)) {
    const size = statSync(file).size;
    if (size >= READ_BYTE_THRESHOLD && INDEXED.has(ext)) {
      advise(
        `Write replaces all of ${path.basename(file)} (${size} bytes). If you are changing part of it, ` +
          `replace_symbol costs a fraction of a whole-file rewrite — output tokens are the expensive side.`
      );
    }
    process.exit(0);
  }

  if (tool === "Read" && file) {
    // A ranged read is already the disciplined move; only whole-file reads qualify.
    if (input.offset || input.limit) process.exit(0);
    if (!INDEXED.has(ext) || !existsSync(file)) process.exit(0);
    const size = statSync(file).size;
    if (size >= READ_BYTE_THRESHOLD) {
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
