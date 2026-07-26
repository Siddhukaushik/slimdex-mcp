# Putting slimdex in front of the decision

The instructions the server injects are **advisory**, and advice loses to reflex.
Three separate audit sessions read "use `replace_symbol`" on every single turn
and still reached for the built-in `Edit`. That is not carelessness — the
built-ins are shorter, always present, and heavily represented in training,
while the guidance was read forty turns earlier.

Nothing inside slimdex can fix that. **MCP is additive**: a server exposes
tools, and cannot wrap or replace a client's built-in `Read`/`Edit`/`Write`.
There is no capability negotiation where a server registers as the
implementation of editing. The routing decision belongs to the model.

A `PreToolUse` hook is the only place the deciding signals exist — **how much
old code you are about to re-send**, and **whether a definition actually covers
it**. Both are invisible when the instructions are written and obvious at call
time.

> Claude Code only. Cursor, Windsurf and Claude Desktop have no equivalent, so
> this is one client's integration, not a universal fix.

## Install

```bash
npm run install-hook              # <repo>/.claude/settings.json       shared, committed
npm run install-hook -- --local   # <repo>/.claude/settings.local.json yours, gitignored
npm run install-hook -- --global  # ~/.claude/settings.json            yours, every repo
npm run install-hook -- --uninstall
```

It resolves the absolute path for you, merges rather than clobbers, and is safe
to re-run.

### Which file — this matters on a shared repo

Claude Code reads hooks from **its own** settings files. It does **not** read
`.vscode/settings.json`; that is VS Code's config and putting hooks there does
nothing. The three it does read:

| File | Scope | Committed |
|---|---|---|
| `~/.claude/settings.json` | you, every repo | no |
| `<repo>/.claude/settings.json` | that repo, everyone | **yes** |
| `<repo>/.claude/settings.local.json` | that repo, you only | no |

The hook command contains an **absolute path to your clone**, so on a repo you
share with a team, do not put it in the committed file — a teammate would get a
hook pointing at a directory that does not exist on their machine. Use
`--local`, or `--global`.

`--global` is the usual right answer, and it is safe precisely because the hook
exits silently in any repo with no `.slimdex` index: it has no opinion where
slimdex isn't in use.

The installer prints a warning if you write to the shared file, rather than
letting you find out from a colleague.

### VS Code

Claude Code's VS Code extension reads the same files as the terminal, so there
is nothing extension-specific to configure. Hooks are read at session start —
an already-open session won't pick up a change.

Other MCP clients in VS Code (Cline, Continue, Copilot) do not have this hook
mechanism. The closest repo-level substitute for Copilot is the shipped
[Copilot instructions](../.github/copilot-instructions.md) file: it is
advisory, not enforced, but it puts the same narrow-retrieval discipline into
the model's prompt every turn.

### Why `npm install` doesn't just do it

It would be one line in a `postinstall`, and it would be the wrong line. A hook
executes an arbitrary shell command on **every matching tool call**, so a
package that silently registers one during install is exactly the shape of a
supply-chain problem — benign here, wrong as a precedent, and invisible to
whoever inherits the machine. `npm install --ignore-scripts` is also common,
and a postinstall cannot know which `.claude/settings.json` you meant: this
project's, or the global one.

There is also a hard limit underneath: hooks live in the **client's** config.
An MCP server has no mechanism to register one — the protocol has no hook, no
capability negotiation, nothing. So "install the server and you're done" is not
achievable for hooks by any route. One explicit command is as close as it gets.

## Modes

| `SLIMDEX_HOOK_MODE` | Who hears it | Call proceeds? |
|---|---|---|
| `nudge` (default) | **the model** — `additionalContext`, placed next to the tool result | yes |
| `warn` | **the user** — `systemMessage` | yes |
| `block` | **the model** — stderr, exit 2 | no, cancelled |

`nudge` is the default because it is the only mode that both informs and costs
nothing when the advice is wrong: the agent reads it, and can still go ahead
with the `Edit` if `replace_symbol` genuinely does not fit.

### The bug this table used to hide

Earlier versions defaulted to printing on stdout with exit 0, and this page
claimed that was "visible in the transcript." **It is not.** For `PreToolUse`,
Claude Code writes stdout to the *debug log* — not the transcript, and not the
model's context. Only `UserPromptSubmit`, `UserPromptExpansion` and
`SessionStart` add stdout as context the model can see.

So the hook was installed, fired on exactly the right edits, and reached
nobody. An audit later found a session with three whole-symbol rewrites sent
through `Edit`, every one of them correctly detected and silently discarded.
If you installed this before that fix, you were running the null mode.

Use `warn` when you deliberately want to audit without changing agent behaviour
— it reaches you and not the model. Then compare `stats checkpoint:true` at the
start of a task with `stats session:true` at the end: with the hook installed,
the write block reports a **measured** count of whole-symbol edits rather than
an inference. Promote to `block` only if `nudge` is being read and ignored.

## What it fires on

Two triggers, both chosen because they are the cases where slimdex genuinely
wins:

- **`Edit`/`MultiEdit` whose `old_string` spans ≥25 lines *and* is covered by an
  indexed definition** — you are re-sending a whole symbol purely to locate it.
  `replace_symbol` addresses it by name, so you emit only the new body: roughly
  half the output.
- **A whole-file `Read` of an indexed file ≥12 KB** — `get_file_skeleton` then
  narrow reads costs a fraction.

The thresholds are env-tunable (`SLIMDEX_HOOK_EDIT_LINES`,
`SLIMDEX_HOOK_READ_BYTES`, `SLIMDEX_HOOK_DEF_WINDOW`).

### Why the size threshold is not enough on its own

A 40-line edit to an HTML fragment, a CSS block with no indexed selector, or
the interior of an IIFE trips the line count but has **no symbol to address**.
Advice you cannot follow is worse than silence — it is how a signal gets tuned
out. So the hook looks the span up in `.slimdex/index.json` and stays quiet
unless it can *name* the definition being rewritten, which it then puts in the
message. If the name is defined in more than one place (routine for CSS
selectors), it advises `path:`+`line:` instead, because `replace_symbol` refuses
an ambiguous name rather than guessing.

## What it records

Every verdict is appended to `.slimdex/hook-events.jsonl` — both the fires and
the deliberate silences. This is what lets `stats` report *"4 edits re-sent a
whole symbol's body"* as a measurement instead of inferring it from how many
files changed. The server cannot see a built-in `Edit` at all; the hook can, so
it is the only honest source for that number. The log is capped and self-trims.

Without the hook installed, the write block says plainly that the expensive
case is **not observable from here**, rather than guessing.

## It stays quiet, on purpose

The value is in the silence as much as the advice. A hook that nagged on every
`Edit` would push `replace_symbol` into cases where `Edit` is genuinely cheaper
— a one-line change inside a 250-line component would have to re-emit the whole
function — which is the exact failure it exists to prevent.

So it says nothing about:

- **Small edits.** `Edit` is the correct tool there, and the hook agrees.
- **Ranged reads.** Already the disciplined move.
- **File types slimdex does not index.**
- **Repos with no `.slimdex` index.** This is what makes a global install safe:
  without an index, the hook has no opinion, so it can never tell an agent to
  reach for a tool that is not connected.
- **Malformed input.** A broken hook must never block real work.

## Reverting

Delete the `hooks` block. Nothing else changes — the hook touches no slimdex
state, no index, no memory, and no code. It is pure configuration.
