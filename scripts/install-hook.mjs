#!/usr/bin/env node
// One-command hook install.
//
// Why this is a command you RUN and not something `npm install` does for you:
// a hook executes an arbitrary shell command on every matching tool call, and a
// package that silently registers one during install is exactly the shape of a
// supply-chain problem — benign here, wrong as a precedent, and invisible to
// whoever inherits the machine. npm postinstall is also routinely disabled
// (--ignore-scripts) and cannot know which .claude/settings.json you meant.
//
// So: explicit, idempotent, reversible, and it prints exactly what it changed.
//
//   npm run install-hook              # <repo>/.claude/settings.json      (SHARED - committed)
//   npm run install-hook -- --local   # <repo>/.claude/settings.local.json (yours - gitignored)
//   npm run install-hook -- --global  # ~/.claude/settings.json            (yours - every repo)
//   npm run install-hook -- --copilot        # <repo>/.github/hooks/slimdex.json (SHARED - committed)
//   npm run install-hook -- --copilot-global # ~/.copilot/hooks/slimdex.json     (yours - every repo)
//   npm run install-hook -- --uninstall
//
// The Copilot targets exist because a repo that only ever uses VS Code chat has
// no .claude directory at all, and telling those users to create one to
// configure Copilot is backwards. VS Code reads both — its own paths and
// Claude's — so the choice is about which file the repo actually keeps, not
// which editor is in front of you.
//
// Pick --local or --global for a SHARED repo. The hook command contains an
// absolute path to this clone, so committing it to <repo>/.claude/settings.json
// hands every teammate a path that does not exist on their machine. The default
// is the committed file because that is the documented Claude Code convention
// for project settings, but it is the wrong choice for a repo you don't own —
// hence the warning it prints.
//
// A global install is safe: the hook exits silently in any repo with no
// .slimdex index, so it can never point an agent at a server that isn't there.

import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const GLOBAL = args.has("--global");
const LOCAL = args.has("--local");
const COPILOT = args.has("--copilot");
const COPILOT_GLOBAL = args.has("--copilot-global");
const UNINSTALL = args.has("--uninstall");

const here = path.dirname(fileURLToPath(import.meta.url));
// Forward slashes even on Windows: Node accepts them, and they survive being
// stored in JSON and then handed to cmd, PowerShell or bash unchanged.
// JSON.stringify() on a Windows path doubles every backslash, and the shell
// then receives `C:\\Users\\…` — which is not the path anyone meant.
const hookScript = path.join(here, "slimdex-edit-hook.mjs").split(path.sep).join("/");
const COMMAND = `node "${hookScript}"`;
// Both clients' vocabularies. Claude Code sends Edit/MultiEdit/Write/Read; VS
// Code Copilot — which reads this same .claude/settings.json — sends
// editFiles/createFile/readFile, sometimes namespaced (edit/editFiles). Missing
// half the names would install a hook that is silently inert in one of the two
// editors, which is the failure this whole mechanism keeps rediscovering.
// The hook re-checks the name itself, so an over-broad matcher costs nothing.
const MATCHER =
  "Edit|MultiEdit|Write|Read|.*editFiles|.*createFile|.*readFile|replace_string_in_file|insert_edit_into_file|apply_patch";

// Copilot keeps hooks in its own dedicated files rather than a shared settings
// blob: .github/hooks/*.json in the workspace, ~/.copilot/hooks/*.json for the
// user. The top-level shape is the same { hooks: { PreToolUse: [...] } }, so
// everything below — merge, detect, uninstall — works unchanged.
const settingsPath = COPILOT_GLOBAL
  ? path.join(os.homedir(), ".copilot", "hooks", "slimdex.json")
  : COPILOT
    ? path.join(process.cwd(), ".github", "hooks", "slimdex.json")
    : GLOBAL
      ? path.join(os.homedir(), ".claude", "settings.json")
      : path.join(process.cwd(), ".claude", LOCAL ? "settings.local.json" : "settings.json");

/** True when we are about to write into a file the repo COMMITS. */
const sharedFile = !GLOBAL && !LOCAL && !COPILOT_GLOBAL;

// A committed config with an absolute path to one person's clone is useless to
// everyone else. When slimdex is a dependency of the target repo, there is a
// path that works on every machine, so prefer it over the absolute one.
const depScript = path.join("node_modules", "slimdex-mcp", "scripts", "slimdex-edit-hook.mjs");
const portable = sharedFile && existsSync(path.join(process.cwd(), depScript));
const command = portable ? `node "${depScript.split(path.sep).join("/")}"` : COMMAND;

async function readSettings() {
  try {
    return JSON.parse(await fs.readFile(settingsPath, "utf8"));
  } catch (e) {
    if ((e ).code === "ENOENT") return {};
    // Never clobber a settings file we cannot parse — that is someone's whole
    // Claude Code configuration.
    throw new Error(`${settingsPath} exists but is not valid JSON (${e.message}). Fix or move it aside; nothing was written.`);
  }
}

/** Does this entry already point at our hook script? Handles both nestings. */
const mentionsUs = (c) => typeof c === "string" && c.includes("slimdex-edit-hook");
const isOurs = (entry) => mentionsUs(entry?.command) || (entry?.hooks ?? []).some((h) => mentionsUs(h?.command));

const settings = await readSettings();
settings.hooks ??= {};
const pre = (settings.hooks.PreToolUse ??= []);
const existing = pre.findIndex(isOurs);

if (UNINSTALL) {
  if (existing < 0) {
    console.log(`No slimdex hook found in ${settingsPath} — nothing to do.`);
    process.exit(0);
  }
  pre.splice(existing, 1);
  if (!pre.length) delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  console.log(`Removed the slimdex hook from ${settingsPath}. Nothing else changed.`);
  process.exit(0);
}

// VS Code ignores `matcher` entirely — every registered hook runs on every tool
// invocation — so writing one into a Copilot file would only imply a filtering
// guarantee that does not exist. The hook checks the tool name itself either
// way; on Copilot that check is the ONLY thing narrowing it.
//
// The two clients also nest differently. Claude Code groups commands under a
// matcher: { matcher, hooks: [ {type, command} ] }. Copilot's native files list
// the command objects directly: [ {type, command} ]. Writing Claude's shape into
// a Copilot file produces an entry with no `command` at the level Copilot reads,
// which parses fine and runs nothing — a silent no-op of exactly the kind this
// hook keeps being bitten by.
const entry =
  COPILOT || COPILOT_GLOBAL ? { type: "command", command } : { matcher: MATCHER, hooks: [{ type: "command", command }] };

if (existing >= 0) {
  pre[existing] = entry; // refresh the path in case the repo moved
  console.log(`Updated the existing slimdex hook in ${settingsPath}.`);
} else {
  pre.push(entry);
  console.log(`Added the slimdex hook to ${settingsPath}.`);
}

await fs.mkdir(path.dirname(settingsPath), { recursive: true });
await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

console.log(`
  matcher : ${COPILOT || COPILOT_GLOBAL ? "(none — VS Code ignores matcher; the hook filters by tool name itself)" : MATCHER}
  command : ${command}
  mode    : nudge (the model sees it; the call still proceeds)

It speaks up only where slimdex actually wins — an Edit re-sending 25+ lines of
code that an indexed definition actually covers, or a whole-file Read of an
indexed file over 12KB — and stays silent everywhere else, including repos with
no .slimdex index, and big edits with no symbol to name.

SLIMDEX_HOOK_MODE=warn reaches YOU instead of the model (audit without changing
behaviour); =block cancels the call outright. Undo any time with:
  npm run install-hook -- --uninstall`);

if (sharedFile && !portable) {
  console.log(`
⚠ ${path.relative(process.cwd(), settingsPath) || path.basename(settingsPath)} is COMMITTED, and the command above
  contains an absolute path to your clone. On a teammate's machine that path
  does not exist, so committing this hands them a hook that cannot run.

  On a repo you share, re-run with one of:
    npm run install-hook -- --local           (.claude/settings.local.json, gitignored)
    npm run install-hook -- --global          (~/.claude/settings.json, all your repos)
    npm run install-hook -- --copilot-global  (~/.copilot/hooks, all your repos, VS Code)

  Either global is safe: the hook exits silently in any repo with no .slimdex
  index, so it can never point an agent at a server that isn't connected.`);
} else if (portable) {
  console.log(`
  This repo has slimdex in node_modules, so the command above is a RELATIVE path
  and works on a teammate's machine too — safe to commit.`);
}
