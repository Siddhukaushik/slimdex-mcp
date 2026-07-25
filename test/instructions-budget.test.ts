// The server `instructions` are the product's operating discipline, and they are
// only worth anything if the client actually delivers them.
//
// This test exists because one didn't. A real client cut the 5,401-char block at
// 2,072 chars — mid-sentence, at rule 9 of 16. Rules 10-16 (all of MEMORY, all of
// EDITING) never reached the model. The visible result was a session that used
// slimdex purely for reading: whole functions rewritten through a generic edit
// tool that has to be handed the old body to find the change, line-number
// splicing, and a broken build from a change find_tests would have caught in one
// call. The guidance for all three was written, shipped, and truncated.
//
// So the length is a hard constraint, not a style note: guidance past the cut is
// worse than no guidance, because it reads as complete on the way out.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { leanNote, BATCH_ONLY } from "../src/profile.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, "..", "src", "index.ts"), "utf8");

function extract(name: string): string {
  const m = src.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;\\n"));
  if (!m) throw new Error(`could not find ${name} in src/index.ts`);
  return m[1];
}

const BUDGET = Number(src.match(/INSTRUCTIONS_BUDGET = (\d+)/)?.[1]);
const INSTRUCTIONS = extract("INSTRUCTIONS");

describe("instructions budget", () => {
  it("declares a budget", () => {
    expect(BUDGET).toBeGreaterThan(0);
  });

  it("fits the budget on the full profile", () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(BUDGET);
  });

  it("fits the budget on lean, where leanNote is appended to it", () => {
    // The worst case is what has to fit — lean pays the note ON TOP of the
    // instructions, so budgeting only the full profile would let lean truncate.
    expect(INSTRUCTIONS.length + leanNote().length).toBeLessThanOrEqual(BUDGET);
  });

  it("keeps the write-side tools inside the surviving text", () => {
    // The specific rules whose absence was observed. If a future edit pushes
    // them out to make room, that is the regression this file is here to catch.
    for (const tool of ["replace_symbol", "find_tests", "dep_graph", "changed_files"]) {
      expect(INSTRUCTIONS).toContain(tool);
    }
  });

  it("still names the batch-only tools it tells lean users to reach for", () => {
    // profile.ts promises the instructions name these; a shorter block must not
    // quietly break that contract by advising a tool lean users cannot see.
    const advised = ["get_context", "find_tests", "dep_graph", "changed_files", "digest_save"];
    for (const t of advised) {
      expect(BATCH_ONLY).toContain(t);
      expect(leanNote()).toContain(t);
    }
  });
});
