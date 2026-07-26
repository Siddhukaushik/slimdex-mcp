// Is the PreToolUse hook actually installed, and can we install it from inside
// a session?
//
// THE LIMIT, stated plainly because it is the whole reason this file is shaped
// the way it is: **an MCP server cannot register a hook.** The protocol has no
// capability negotiation for it, no lifecycle event, nothing — a server exposes
// tools and that is the entire surface. So "I registered slimdex in mcp.json,
// the hook should just be there" is not achievable by any route available to
// this process at registration time. Hooks live in the CLIENT's config.
//
// What IS achievable, and what this file does:
//
//   1. NOTICE. The server can read the client's config files and see that the
//      hook is missing. Costing one file read at session open, that turns a
//      silent misconfiguration — the failure mode this project keeps hitting —
//      into a visible line in `brief`.
//   2. OFFER. An `install_hook` tool turns the fix into one tool call the user
//      approves in the client's own UI, instead of a terminal command in
//      another window. That is as close to automatic as the protocol permits,
//      and the approval is the point, not an obstacle.
//
// What this file deliberately does NOT do is write hook config on server start.
// A hook runs an arbitrary command on every tool call; a server that installs
// one merely because it was registered is the exact shape of a supply-chain
// problem — benign here, wrong as a precedent, and invisible to whoever
// inherits the machine. The same reasoning already rules out npm postinstall
// (see scripts/install-hook.mjs). Detection is free; writing needs a human.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Install targets, matching scripts/install-hook.mjs flags. */
export const SCOPES = {
  "claude-global": "--global",
  "claude-local": "--local",
  "claude-project": "",
  "copilot-global": "--copilot-global",
  "copilot-project": "--copilot",
} as const;

export type Scope = keyof typeof SCOPES;

export interface HookState {
  installed: boolean;
  /** Config files that reference the hook. */
  where: string[];
}

const MARKER = "slimdex-edit-hook";

/**
 * Every config file either client reads, in the order a human would check.
 *
 * `home` is injectable because detection spans BOTH scopes: a user-level
 * install legitimately covers this repo, so the answer depends on the machine
 * running it. Without a seam, a test asserting "absent" passes or fails
 * depending on whether the developer happens to have the hook installed — which
 * is precisely the kind of environment-dependent green this codebase has been
 * bitten by already.
 */
function candidates(root: string, home = os.homedir()): string[] {
  return [
    path.join(root, ".claude", "settings.json"),
    path.join(root, ".claude", "settings.local.json"),
    path.join(home, ".claude", "settings.json"),
    path.join(root, ".github", "hooks", "slimdex.json"),
    path.join(home, ".copilot", "hooks", "slimdex.json"),
  ];
}

/**
 * Read-only. Never throws: a missing or malformed config is "not installed",
 * not an error worth failing a session over.
 *
 * Matches on the script name rather than parsing each client's schema, because
 * the two clients nest hooks differently and a third would nest them a third
 * way. The question here is only "is this wired up at all".
 */
export async function hookState(root: string, home?: string): Promise<HookState> {
  const where: string[] = [];
  for (const file of candidates(root, home)) {
    try {
      if ((await fs.readFile(file, "utf8")).includes(MARKER)) where.push(file);
    } catch {
      /* absent or unreadable — same answer either way */
    }
  }
  return { installed: where.length > 0, where };
}

/** One line for `brief` when the enforcement half is missing, "" when it is fine. */
export function hookNote(state: HookState): string {
  if (state.installed) return "";
  return (
    `\n⚠ The PreToolUse hook is not installed, so slimdex's write discipline is advisory only.\n` +
    `  Instructions lose to reflex — measured, repeatedly: without the hook, whole-symbol rewrites\n` +
    `  go through the client's generic edit tool and cost roughly double the output tokens.\n` +
    `  Fix it with the install_hook tool (one approval), or: npm run install-hook -- --global`
  );
}

/**
 * Run the real installer as a child process.
 *
 * Shelling out rather than reimplementing: scripts/install-hook.mjs is the
 * published CLI and already handles merge-don't-clobber, both clients' nesting,
 * idempotency, the committed-file warning and uninstall. A second
 * implementation here would drift from it, and the two would disagree about a
 * user's config — which is the one place disagreement is expensive.
 */
export function runInstaller(root: string, scope: Scope, uninstall = false): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(here, "..", "scripts", "install-hook.mjs");
  const args = [script, SCOPES[scope], uninstall ? "--uninstall" : ""].filter(Boolean);
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: root, timeout: 20_000 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim();
      resolve(err && !out ? `Installer failed: ${err.message}` : out || "Installer produced no output.");
    });
  });
}
