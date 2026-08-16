// Blast radius, attached to calls the agent already makes.
//
// dep_graph and find_tests only pay off BEFORE a change — which is the moment an
// agent is least likely to stop and ask. Skipping them costs nothing it can see:
// the edit still applies, the file still saves, and the bill arrives later as a
// human saying "you broke the login flow". A tool whose neglect is never
// punished in-loop gets neglected, and no amount of instruction fixes that.
//
// So the impact is not a tool to call. It rides along with get_symbol_context
// (the call made right before editing) and replace_symbol (the edit itself),
// where it cannot be skipped because it was never a separate decision.
//
// NOT a gate. Refusing an edit until dep_graph runs would make slimdex the only
// tool in the client with friction, and the model would simply fall back to the
// built-in Edit — handing the write to the one path that cannot be seen or
// measured. Attaching is strictly better than the built-ins; gating is strictly
// worse.

import type { CodeIndex } from "./store.js";
import { searchFiles } from "./search.js";
import { isTestFile } from "./testlink.js";

export interface Impact {
  files: string[]; // distinct files referencing the symbol, definition file excluded
  tests: string[]; // of those, the ones that are tests
  capped: boolean; // scan hit its ceiling, so counts are a floor
}

// Deliberately shallow and capped. This runs on reads that previously touched
// no graph at all, so it must stay cheap enough to be invisible: one bounded
// scan, direct references only, no transitive walk. A number that is a floor
// ("6+ files") is still decisive; a slow tool is not.
const MAX_MATCHES = 80;

export async function symbolImpact(
  root: string,
  index: CodeIndex,
  name: string,
  defFile?: string
): Promise<Impact | null> {
  if (!name || name.length < 2) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const { matches, total, exact } = await searchFiles(root, Object.keys(index.files), `\\b${escaped}\\b`, {
    regex: true,
    maxMatches: MAX_MATCHES,
    literalHint: name,
  });
  const files = [...new Set(matches.map((m) => m.file))].filter((f) => f !== defFile);
  return { files, tests: files.filter(isTestFile), capped: !exact || total > MAX_MATCHES };
}

/**
 * One line, or nothing. The value here is a decision input — "is this safe to
 * change alone?" — which is a count and a couple of names, not a report. A
 * multi-line block would cost more than the dep_graph call it replaces.
 *
 * Silent when a symbol has no references AND has tests: that is the boring case,
 * and boring cases should not be paid for on every read.
 */
export function impactLine(impact: Impact | null): string {
  if (!impact) return "";
  const { files, tests, capped } = impact;
  const nonTest = files.filter((f) => !isTestFile(f));
  if (files.length === 0) return "\nImpact: no other references indexed — safe to change alone.";

  const shown = nonTest.slice(0, 2).join(", ");
  const rest = nonTest.length - Math.min(2, nonTest.length);
  const where = nonTest.length ? ` (${shown}${rest > 0 ? ` +${rest}` : ""})` : "";
  const refs = `${nonTest.length}${capped ? "+" : ""} file(s) reference it${where}`;
  // No covering test is the finding, not a footnote — it is the difference
  // between "change it and run the suite" and "change it and hope".
  const cover = tests.length ? `${tests.length} covering test file(s)` : "⚠ no covering tests";
  return `\nImpact: ${refs} · ${cover}`;
}
