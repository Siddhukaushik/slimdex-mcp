// The PreToolUse hook. Its whole value is WHEN IT STAYS QUIET, so the silence
// cases are asserted as hard as the advice ones: a hook that nags on every Edit
// would push replace_symbol into the case where Edit is genuinely cheaper,
// which is the failure it exists to prevent.
//
// The second axis these tests pin down is WHO HEARS IT. PreToolUse stdout on
// exit 0 goes to the debug log — not the transcript, not the model — so the
// original default printed perfect advice into a void. Each mode is asserted
// against the specific channel it is supposed to reach.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const HOOK = path.resolve("scripts/slimdex-edit-hook.mjs");
let repo = ""; // a dir that looks like a slimdex-indexed repo
let bare = ""; // a dir with no .slimdex at all

/** 40 lines whose first line is the definition — a whole-symbol rewrite. */
const symBody = ["function paintBoard() {", ...Array.from({ length: 38 }, (_, i) => `  step(${i});`), "}"].join("\n");
/** The same shape under a distinct name, written to disk with CRLF endings. */
const crlfBody = symBody.replace("paintBoard", "paintCrlf");
/** 40 lines that begin nowhere near a definition — an HTML fragment. */
const fragBody = Array.from({ length: 40 }, (_, i) => `  <div class="row-${i}"></div>`).join("\n");
/** 40 lines inside a file whose only definition is far below the edited span. */
const midBody = Array.from({ length: 40 }, (_, i) => `  tail(${i});`).join("\n");

beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(tmpdir(), "hook-repo-"));
  await fs.mkdir(path.join(repo, ".slimdex"), { recursive: true });

  await fs.writeFile(path.join(repo, "sym.ts"), symBody + "\n");
  await fs.writeFile(path.join(repo, "frag.html"), fragBody + "\n");
  // The definition sits at line 41, below the 40-line span an edit would cover.
  await fs.writeFile(path.join(repo, "mid.ts"), midBody + "\nfunction tail() {}\n");
  await fs.writeFile(path.join(repo, "a.css"), symBody + "\n");
  await fs.writeFile(path.join(repo, "b.css"), symBody + "\n");
  // Same content, CRLF on disk. Windows repos are almost entirely CRLF while an
  // old_string routinely arrives LF-normalised; comparing them raw fails on
  // every file and the hook goes quiet, which is indistinguishable from "no
  // symbol covered this". LF-only fixtures pass either way, so this one exists.
  await fs.writeFile(path.join(repo, "crlf.ts"), crlfBody.replace(/\n/g, "\r\n") + "\r\n");
  await fs.writeFile(path.join(repo, "big.ts"), "x".repeat(40_000));
  await fs.writeFile(path.join(repo, "small.ts"), "const a = 1;\n");

  await fs.writeFile(
    path.join(repo, ".slimdex", "index.json"),
    JSON.stringify({
      version: 5,
      builtAt: new Date().toISOString(),
      files: {
        "sym.ts": { lines: 40, symbols: [{ name: "paintBoard", kind: "function", line: 1, col: 0 }] },
        // Indexed, but structureless — the case the line threshold alone got wrong.
        "frag.html": { lines: 40, symbols: [] },
        "mid.ts": { lines: 41, symbols: [{ name: "tail", kind: "function", line: 41, col: 0 }] },
        // The same selector name in two files: replace_symbol refuses an
        // ambiguous name, so advice must not tell the caller to use one.
        "a.css": { lines: 40, symbols: [{ name: ".space", kind: "rule", line: 1, col: 0 }] },
        "b.css": { lines: 40, symbols: [{ name: ".space", kind: "rule", line: 1, col: 0 }] },
        "crlf.ts": { lines: 40, symbols: [{ name: "paintCrlf", kind: "function", line: 1, col: 0 }] },
        "big.ts": { lines: 1, symbols: [] },
        "small.ts": { lines: 1, symbols: [] },
      },
    })
  );
  bare = await fs.mkdtemp(path.join(tmpdir(), "hook-bare-"));
});

afterAll(async () => {
  for (const d of [repo, bare]) await fs.rm(d, { recursive: true, force: true });
});

function runHook(payload: unknown, mode?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [HOOK],
      { env: { ...process.env, ...(mode ? { SLIMDEX_HOOK_MODE: mode } : {}) } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === "number" ? (err as any).code : 0;
        resolve({ code, out: stdout, err: stderr });
      }
    );
    child.stdin!.end(JSON.stringify(payload));
  });
}

const editOn = (file: string, old: string) => ({
  cwd: repo,
  tool_name: "Edit",
  tool_input: { file_path: path.join(repo, file), old_string: old },
});

describe("hook advises where replace_symbol wins", () => {
  it("flags an Edit that re-sends a whole symbol, and names it", async () => {
    const r = await runHook(editOn("sym.ts", symBody));
    expect(r.out).toMatch(/replace_symbol/);
    expect(r.out).toMatch(/40 lines/);
    expect(r.out).toMatch(/paintBoard/); // advice you can act on without a lookup
    expect(r.code).toBe(0); // nudge never cancels the call
  });

  it("addresses an ambiguous name by path+line instead", async () => {
    // ".space" is defined in two files. Telling the caller name:".space" would
    // earn a refusal and cost a round-trip.
    const r = await runHook(editOn("a.css", symBody));
    const advice = JSON.parse(r.out.trim()).hookSpecificOutput.additionalContext;
    expect(advice).toMatch(/path:"a\.css" line:1/);
    expect(advice).not.toMatch(/name:"\.space"/);
    expect(advice).toMatch(/more than one place/);
  });

  it("matches a CRLF file against an LF old_string", async () => {
    // The regression that made this hook useless on Windows: the file is CRLF,
    // the old_string is LF, a raw comparison finds nothing, and the silence is
    // indistinguishable from "Edit was the right call". Found by running the
    // hook against a real repo — every LF fixture above passes without this.
    const r = await runHook(editOn("crlf.ts", crlfBody));
    expect(r.out).toMatch(/paintCrlf/);
    expect(r.out).toMatch(/40 lines/);
  });

  it("flags a whole-file Read of a large indexed file", async () => {
    const r = await runHook({ cwd: repo, tool_name: "Read", tool_input: { file_path: path.join(repo, "big.ts") } });
    expect(r.out).toMatch(/get_file_skeleton/);
  });
});

describe("hook speaks both clients' vocabularies", () => {
  // VS Code Copilot runs PreToolUse hooks and reads .claude/settings.json, so
  // one install covers both editors — but its tools are named differently and
  // its tool_input is camelCase. Matching only Claude Code's names would leave
  // the hook silently inert in VS Code.
  it("fires on Copilot's editFiles with camelCase input", async () => {
    const r = await runHook({
      cwd: repo,
      tool_name: "editFiles",
      tool_input: { filePath: path.join(repo, "sym.ts"), oldString: symBody },
    });
    expect(r.out).toMatch(/paintBoard/);
  });

  it("fires on a namespaced tool name", async () => {
    const r = await runHook({
      cwd: repo,
      tool_name: "edit/editFiles",
      tool_input: { filePath: path.join(repo, "sym.ts"), oldString: symBody },
    });
    expect(r.out).toMatch(/paintBoard/);
  });

  it("flags Copilot's readFile on a large indexed file", async () => {
    const r = await runHook({
      cwd: repo,
      tool_name: "read/readFile",
      tool_input: { filePath: path.join(repo, "big.ts") },
    });
    expect(r.out).toMatch(/get_file_skeleton/);
  });

  it("ignores a tool it does not recognise rather than guessing", async () => {
    const r = await runHook({
      cwd: repo,
      tool_name: "runTerminalCommand",
      tool_input: { filePath: path.join(repo, "sym.ts"), oldString: symBody },
    });
    expect(r.out.trim()).toBe("");
  });
});

describe("hook reaches the intended audience", () => {
  it("nudge puts the advice where the MODEL sees it, without cancelling", async () => {
    const r = await runHook(editOn("sym.ts", symBody), "nudge");
    const payload = JSON.parse(r.out.trim());
    expect(payload.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(payload.hookSpecificOutput.additionalContext).toMatch(/replace_symbol/);
    // Rides along because additionalContext is undocumented for PreToolUse on
    // VS Code: if that channel is dropped, a human still sees the advice.
    expect(payload.systemMessage).toMatch(/replace_symbol/);
    // No permissionDecision: absent means the normal permission flow.
    expect(payload.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(r.code).toBe(0);
  });

  it("warn puts it where the USER sees it, and tells the model nothing", async () => {
    const r = await runHook(editOn("sym.ts", symBody), "warn");
    const payload = JSON.parse(r.out.trim());
    expect(payload.systemMessage).toMatch(/replace_symbol/);
    expect(payload.hookSpecificOutput).toBeUndefined();
    expect(r.code).toBe(0);
  });

  it("block cancels the call and feeds stderr back to the model", async () => {
    const r = await runHook(editOn("sym.ts", symBody), "block");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/replace_symbol/);
  });
});

describe("hook stays silent where the built-in tool is the right choice", () => {
  it("says nothing about a big edit with no symbol covering it", async () => {
    // The precision fix: 40 lines of HTML trips the line threshold, but there is
    // nothing to name, so the advice would be unfollowable.
    const r = await runHook(editOn("frag.html", fragBody));
    expect(r.out.trim()).toBe("");
    expect(r.code).toBe(0);
  });

  it("says nothing when the definition is below the edited span", async () => {
    // An edit that merely runs up to a definition is not a rewrite OF it;
    // replace_symbol would have to cover more than the caller meant.
    const r = await runHook(editOn("mid.ts", midBody));
    expect(r.out.trim()).toBe("");
  });

  it("says nothing about a small Edit", async () => {
    const r = await runHook(editOn("small.ts", "const a = 1;"));
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
      tool_input: { file_path: path.join(bare, "a.ts"), old_string: symBody },
    });
    expect(r.out.trim()).toBe("");
  });

  it("says nothing about a file type slimdex does not index", async () => {
    const r = await runHook(editOn("notes.txt", symBody));
    expect(r.out.trim()).toBe("");
  });

  it("never breaks a tool call on malformed input", async () => {
    const r = await runHook("not an object");
    expect(r.code).toBe(0);
  });
});

describe("hook journals its verdict for stats", () => {
  it("records both the fired and the correctly-silent cases", async () => {
    await runHook(editOn("sym.ts", symBody));
    await runHook(editOn("frag.html", fragBody));
    const raw = await fs.readFile(path.join(repo, ".slimdex", "hook-events.jsonl"), "utf8");
    const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const fired = events.filter((e) => e.fired && e.symbol === "paintBoard");
    const quiet = events.filter((e) => !e.fired && e.reason === "no covering symbol");
    expect(fired.length).toBeGreaterThan(0);
    // The silent case is recorded too: "Edit was correct here" is a fact the
    // report needs, not an absence.
    expect(quiet.length).toBeGreaterThan(0);
  });
});
