// Detecting the hook, and the line brief shows when it is missing.
//
// This closes the loop the server cannot close itself: MCP has no way for a
// server to register a hook, so the next best thing is that a session OPENS by
// telling you the enforcement half is absent, rather than quietly running
// advisory-only — which is how this project's write discipline was lost for
// three audits in a row.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hookState, hookNote } from "../src/hookstate.js";

let root = "";
// A home directory with no config, so a developer who HAS the hook installed
// globally does not get a different answer than one who does not.
let emptyHome = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "hookstate-"));
  emptyHome = await fs.mkdtemp(path.join(tmpdir(), "hookhome-"));
});
afterEach(async () => {
  for (const d of [root, emptyHome]) await fs.rm(d, { recursive: true, force: true });
});

describe("hook detection", () => {
  it("reports absent in a repo with no config at all", async () => {
    const s = await hookState(root, emptyHome);
    expect(s.installed).toBe(false);
    expect(s.where).toEqual([]);
  });

  it("finds the hook in Claude's project settings", async () => {
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'node "/x/slimdex-edit-hook.mjs"' }] }] } })
    );
    const s = await hookState(root, emptyHome);
    expect(s.installed).toBe(true);
    expect(s.where[0]).toContain("settings.json");
  });

  it("finds the hook in Copilot's native workspace file", async () => {
    // The case that matters for a repo which has never used Claude Code: no
    // .claude directory exists, and .github/hooks is where VS Code looks.
    await fs.mkdir(path.join(root, ".github", "hooks"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".github", "hooks", "slimdex.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ type: "command", command: 'node "x/slimdex-edit-hook.mjs"' }] } })
    );
    const s = await hookState(root, emptyHome);
    expect(s.installed).toBe(true);
  });

  it("treats an unparseable config as absent rather than throwing", async () => {
    // A broken settings file is someone's whole editor configuration. Detection
    // must never be the thing that fails a session over it.
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    await fs.writeFile(path.join(root, ".claude", "settings.json"), "{ not json");
    await expect(hookState(root, emptyHome)).resolves.toMatchObject({ installed: false });
  });
});

describe("the note brief appends", () => {
  it("names the fix and says why it matters when the hook is missing", () => {
    const note = hookNote({ installed: false, where: [] });
    expect(note).toContain("install_hook");
    expect(note).toContain("advisory only");
    expect(note).toContain("install-hook -- --global");
  });

  it("says nothing at all once the hook is installed", () => {
    // A note that appears every session regardless is a note that stops being
    // read — the same failure as the old unconditional write warning.
    expect(hookNote({ installed: true, where: ["/x/.claude/settings.json"] })).toBe("");
  });
});
