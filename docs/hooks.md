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

A `PreToolUse` hook is the only place the deciding signal exists — **how much
old code you are about to re-send**. That is invisible when the instructions are
written and obvious at call time.

> Claude Code only. Cursor, Windsurf and Claude Desktop have no equivalent, so
> this is one client's integration, not a universal fix.

## Install

```bash
npm run install-hook
```

That's it — it writes the entry into this project's `.claude/settings.json`,
resolves the absolute path for you, merges rather than clobbers, and is safe to
re-run. `-- --global` installs it for every repo; `-- --uninstall` removes it.

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

| `SLIMDEX_HOOK_MODE` | Behaviour |
|---|---|
| `warn` (default) | Prints to stdout, exits 0. The call proceeds. Use this first, to watch what *would* have been redirected. |
| `block` | Writes to stderr and exits 2, which cancels the call and feeds the message back to the model. This is the mode that changes behaviour. |

Start on `warn`. Run a few real sessions, then compare with
`stats checkpoint:true` at the start and `stats session:true` at the end — if
the advice was right, total chars go down and the `replace_symbol` row goes up.
Promote to `block` only once the numbers agree.

## What it fires on

Two triggers, both chosen because they are the cases where slimdex genuinely
wins:

- **`Edit`/`MultiEdit` whose `old_string` spans ≥25 lines** — you are re-sending
  a whole symbol purely to locate it. `replace_symbol` addresses it by name, so
  you emit only the new body: roughly half the output.
- **A whole-file `Read` of an indexed file ≥12 KB** — `get_file_skeleton` then
  narrow reads costs a fraction.

Both thresholds are env-tunable (`SLIMDEX_HOOK_EDIT_LINES`,
`SLIMDEX_HOOK_READ_BYTES`).

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
