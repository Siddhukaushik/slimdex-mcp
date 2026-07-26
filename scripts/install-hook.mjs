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
//   npm run install-hook              # this project's .claude/settings.json
//   npm run install-hook -- --global  # ~/.claude/settings.json (all repos)
//   npm run install-hook -- --uninstall
//
// A global install is safe: the hook exits silently in any repo with no
// .slimdex index, so it can never point an agent at a server that isn't there.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const GLOBAL = args.has("--global");
const UNINSTALL = args.has("--uninstall");

const here = path.dirname(fileURLToPath(import.meta.url));
// Forward slashes even on Windows: Node accepts them, and they survive being
// stored in JSON and then handed to cmd, PowerShell or bash unchanged.
// JSON.stringify() on a Windows path doubles every backslash, and the shell
// then receives `C:\\Users\\…` — which is not the path anyone meant.
const hookScript = path.join(here, "slimdex-edit-hook.mjs").split(path.sep).join("/");
const COMMAND = `node "${hookScript}"`;
const MATCHER = "Edit|MultiEdit|Write|Read";

const settingsPath = GLOBAL
  ? path.join(os.homedir(), ".claude", "settings.json")
  : path.join(process.cwd(), ".claude", "settings.json");

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

/** Does this entry already point at our hook script? */
const isOurs = (entry) =>
  (entry?.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes("slimdex-edit-hook"));

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

const entry = { matcher: MATCHER, hooks: [{ type: "command", command: COMMAND }] };

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
  matcher : ${MATCHER}
  command : ${COMMAND}
  mode    : warn (advisory; the call still proceeds)

It speaks up only where slimdex actually wins — an Edit re-sending 25+ lines of
existing code, or a whole-file Read of an indexed file over 12KB — and stays
silent everywhere else, including repos with no .slimdex index.

Set SLIMDEX_HOOK_MODE=block once you have watched it for a session and agree
with what it flagged. Undo any time with: npm run install-hook -- --uninstall`);
