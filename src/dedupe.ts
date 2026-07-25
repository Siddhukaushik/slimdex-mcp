// Repeat-response suppression.
//
// The history bucket: a tool response is not paid once, it is paid in every
// later turn that re-reads the transcript. So the same 4,000-char file span
// pulled twice in a session costs more than twice — and agents do re-pull the
// same symbol constantly (after an edit, after a compaction, after a detour).
//
// When a call is provably identical to an earlier one — same tool, same args,
// and the underlying file and index are byte-for-byte unchanged — the body is
// already in the transcript, so we say where instead of repeating it.
//
// Three deliberate limits, because a wrong suppression costs an agent
// information it cannot get back:
//
//   1. Allowlist only. Just the pure, file-scoped readers whose output is a
//      deterministic function of (args, file bytes, index). Anything touching
//      git state, the journal, memory, or multiple files is out of scope —
//      those have invalidation surfaces this cache does not model.
//   2. A validity signature, not a guess: the target file's mtime+size AND the
//      index's builtAt. An external edit or a re-index invalidates.
//   3. Suppression happens ONCE per identical call. A third identical call
//      re-emits in full — if an agent asks again after being told "you already
//      have this", the honest reading is that it no longer does (compaction
//      dropped it), and the body matters more than the saving.
//
// Set SLIMDEX_NO_DEDUPE=1 to disable entirely.

import { promises as fs } from "node:fs";
import path from "node:path";
import { loadIndex } from "./store.js";

/**
 * Tools whose response is a pure function of (args, target file, index).
 * `path` is a required arg for all three, which is what makes the file-level
 * validity signature computable — name-addressed tools (get_symbol_context)
 * resolve their file internally and are deliberately excluded.
 */
const ALLOW = new Set(["read_lines", "get_file_skeleton", "outline_file"]);

/** Below this, suppression saves nothing worth the ambiguity it introduces. */
const MIN_CHARS = 800;

interface Seen {
  n: number; // how many times this exact call has been made
  sig: string; // validity signature at the time of the first response
  chars: number; // size of that response
  call: number; // global call number it was served at
}

const seen = new Map<string, Seen>();
let callNo = 0;

/** Test seam: a fresh process is the normal state, tests need it on demand. */
export function resetDedupe(): void {
  seen.clear();
  callNo = 0;
}

function enabled(): boolean {
  return process.env.SLIMDEX_NO_DEDUPE !== "1";
}

/** Stable key: arg order must not make two identical calls look different. */
function keyOf(tool: string, args: Record<string, unknown>): string {
  const parts = Object.keys(args)
    .filter((k) => args[k] !== undefined)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`);
  return `${tool}(${parts.join(",")})`;
}

/**
 * mtime+size of the target file, plus when the index was built. Any external
 * write bumps the former; any re-parse bumps the latter. Returns null when the
 * signature cannot be established, which disables suppression for that call
 * (fail open — re-sending a body is a cost, suppressing wrongly is a bug).
 */
async function signature(root: string, args: Record<string, unknown>): Promise<string | null> {
  const p = args.path;
  if (typeof p !== "string" || !p) return null;
  try {
    const st = await fs.stat(path.join(root, p));
    const index = await loadIndex(root);
    return `${st.mtimeMs}:${st.size}:${index.builtAt}`;
  } catch {
    return null;
  }
}

export interface DedupeDecision {
  /** When set, serve this instead of calling the handler. */
  notice?: string;
  /** Called with the real response when the handler did run. */
  remember?: (response: string) => void;
}

/**
 * Decide whether this call can be answered by pointing at an earlier one.
 * Always returns a `remember` unless the tool is out of scope, so the first
 * call records what a later one is compared against.
 */
export async function checkRepeat(
  root: string,
  tool: string,
  args: Record<string, unknown>
): Promise<DedupeDecision> {
  callNo++;
  if (!enabled() || !ALLOW.has(tool)) return {};

  const sig = await signature(root, args);
  if (!sig) return {};

  const key = keyOf(tool, args);
  const prev = seen.get(key);
  const at = callNo;

  if (prev && prev.sig === sig && prev.chars >= MIN_CHARS && prev.n === 1) {
    // Second identical call, nothing changed underneath: point, don't repeat.
    prev.n = 2;
    return {
      notice:
        `identical to call #${prev.call} earlier this session (${prev.chars} chars) — ` +
        `${typeof args.path === "string" ? args.path : "file"} is byte-for-byte unchanged since, so the body you ` +
        `already have is current. Re-request to force a full re-emit if it is no longer in your context.`,
    };
  }

  return {
    remember: (response: string) => {
      // A re-emit (n >= 2) resets the counter: the agent has demonstrated it
      // needs this body, so don't suppress the same call again immediately.
      seen.set(key, { n: 1, sig, chars: response.length, call: at });
    },
  };
}
