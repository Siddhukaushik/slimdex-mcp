// The PreToolUse hook. Its whole value is WHEN IT STAYS QUIET, so the silence
// cases are asserted as hard as the advice ones: a hook that nags on every Edit
// would push replace_symbol into the case where Edit is genuinely cheaper,
// which is the failure it exists to prevent.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HOOK = path.resolve("scripts/slimdex-edit-hook.mjs");
let repo = ""; // a dir that looks like a slimdex-indexed repo
let bare = ""; // a dir with no .slimdex at all

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(tmpdir(), "hook-repo-"));
  await fs.mkdir(path.join(repo, ".slimdex"), { recursive: true });
  await fs.writeFile(path.join(repo, ".slimdex", "index.json"), "{}");
  await fs.writeFile(path.join(repo, "big.ts"), "x".repeat(40_000));
  await fs.writeFile(path.join(repo, "small.ts"), "const a = 1;\n");
  bare = await fs.mkdtemp(path.join(tmpdir(), "hook-bare-"));
});

afterAll(async () => {
  for (const d of [repo, bare]) await fs.rm(d, { recursive: true, force: true });
});

function runHook(payload: unknown, mode?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [HOOK],
      { env: { ...process.env, ...(mode ? { SLIMDEX_HOOK_MODE: mode } : {}) } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === "number" ? (err as any).code : 0;
        resolve({ code, out: `${stdout}${stderr}` });
      }
    );
    child.stdin!.end(JSON.stringify(payload));
  });
}

const bigOld = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

describe("hook advises where replace_symbol wins", () => {
  it("flags an Edit that re-sends a whole symbol", async () => {
    const r = await runHook({
      cwd: repo,
      tool_name: "Edit",
      tool_input: { file_path: path.join(repo, "small.ts"), old_string: bigOld },
    });
    expect(r.out).toMatch(/replace_symbol/);
    expect(r.out).toMatch(/40 lines/);
    expect(r.code).toBe(0); // warn mode never cancels the call
  });

  it("flags a whole-file Read of a large indexed file", async () => {
    const r = await runHook({
      cwd: repo,
      tool_name: "Read",
      tool_input: { file_path: path.join(repo, "big.ts") },
    });
    expect(r.out).toMatch(/get_file_skeleton/);
  });

  it("cancels the call in block mode", async () => {
    const r = await runHook(
      { cwd: repo, tool_name: "Edit", tool_input: { file_path: path.join(repo, "small.ts"), old_string: bigOld } },
      "block"
    );
    expect(r.code).toBe(2); // Claude Code: cancel, and feed stderr back to the model
    expect(r.out).toMatch(/replace_symbol/);
  });
});

describe("hook stays silent where the built-in tool is the right choice", () => {
  it("says nothing about a small Edit", async () => {
    const r = await runHook({
      cwd: repo,
      tool_name: "Edit",
      tool_input: { file_path: path.join(repo, "small.ts"), old_string: "const a = 1;" },
    });
    expect(r.out.trim()).toBe("");
    expect(r.code).toBe(0);
  });

  it("says nothing about an already-ranged Read", async () => {
    const r = await runHook({
      cwd: repo,
      tool_name: "Read",
      tool_input: { file_path: path.join(repo, "big.ts"), offset: 10, limit: 40 },
    });
    expect(r.out.trim()).toBe("");
  });

  it("says nothing in a repo that does not use slimdex", async () => {
    // The global-install footgun: without this, the hook would tell an agent to
    // reach for a tool that is not connected.
    const r = await runHook({
      cwd: bare,
      tool_name: "Edit",
      tool_input: { file_path: path.join(bare, "a.ts"), old_string: bigOld },
    });
    expect(r.out.trim()).toBe("");
  });

  it("says nothing about a file type slimdex does not index", async () => {
    const r = await runHook({
      cwd: repo,
      tool_name: "Edit",
      tool_input: { file_path: path.join(repo, "notes.txt"), old_string: bigOld },
    });
    expect(r.out.trim()).toBe("");
  });

  it("never breaks a tool call on malformed input", async () => {
    const r = await runHook("not an object");
    expect(r.code).toBe(0);
  });
});
