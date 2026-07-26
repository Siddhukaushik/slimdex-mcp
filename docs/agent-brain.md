# Slimdex Agent Brain — the reasoning behind the card

> **Dropping this into a repo as CLAUDE.md / AGENTS.md?** Use
> [`agent-brain-slim.md`](agent-brain-slim.md) — it is the complete operating
> card and it is what an agent should carry. This file is the same rules with
> the evidence attached, for a human deciding whether to trust them. Every rule
> here earned its place by costing a real session real tokens.

## Prime directive

Return the answer, not the haystack. But when you genuinely can't be sure
without more context, get it — a wrong edit is more expensive than any read.
Every rule below is subordinate to that one.

## Why the follow-through rule is #1

`get_file_skeleton` is an *investment*: it costs a call to learn where
everything is, and only pays if the next call is narrow. A whole-file read
after a skeleton throws the saving away at the exact moment it was about to
pay — you paid for the map and then bought the territory anyway.

This is the most-broken rule in practice, which is why `stats` prints
`follow-through: N skeletons → M narrow reads`. Measured in a real session: 21
skeletons, 1 narrow read. That session read the bodies with a generic file
reader instead, invisible to slimdex and paid in full.

The four situations that tempt a full read, and the narrow move:

- **Ambiguous symbol** → `get_symbol_context name:"X" pathPrefix:"src/api"`
  resolves it in one call. Only if you can't narrow by path: `find_definition`
  for candidates, then `get_symbol_context` by exact `path`+`line`.
- **Multi-hunk edit needs nearby context** → `read_lines` the exact span.
- **Tool drift** — sliding back to a plain file read "for convenience".
- **Validating your own change** → `changed_files`, not a re-read.

## Why width matters as much as count

Narrow tools used widely cost what the full reads did. Measured in one session:
`batch` 149k chars, `read_lines` 145k — from 14 calls, so ~3,350 chars each.
The call count looked disciplined; the spans weren't.

`batch` is the subtler trap because it *looks* like a saving. It saves
round-trips, not tokens: the response is the sum of its sub-calls, arriving as
one unskippable block. Batch narrow, independent lookups; give a call that would
be big on its own its own turn, where you can bound it.

## Why editing is where the money is

Output tokens cost roughly 4–5× input. A generic edit tool needs you to quote
the code you're replacing so it can find it — so a 60-line rewrite emits ~120
lines. `replace_symbol` addresses the target by name and takes its range from
the index, so you emit 60.

That advantage **inverts** for small changes. Changing one line inside a
250-line component through `replace_symbol` means re-emitting 250 lines; a plain
`Edit` sends six. A real session correctly used `Edit` for exactly this and was
right to. The honest rule is not "always use slimdex" — it is *am I rewriting
most of a named thing, or poking at part of it?*

Insert (`after:` / `before:`) exists because that same session had to add a new
method and `replace_symbol` could only overwrite something already there — so
the flagship write tool sat unused for one of the most common edits there is.

Stylesheets are addressable for the same reason: `.css` was indexed for text
search but emitted no symbols, so on a 60-jsx/32-css repo most of the tree was
invisible to every symbol-shaped tool. A rule is indexed under **each** class
in its selector list, because the one you reach for is often not the first.

## Why memory is the whole cross-session story

The server never sees your conversation. It records which files were examined
(the journal), but it cannot record what you *concluded* — only you can.
Sessions have no end signal: the user abandons the tab, and anything unsaved is
gone. A findings list dying with a chat was the most expensive loss observed in
real use.

Lead with the conclusion, because later sessions see only the first ~150 chars
as a preview. Keep one fact to one thing. Over ~1,200 chars warns; over 20,000
is refused — that's a `digest_save`, not a fact.

`brief` staleness-checks the symbols and files a fact names, so naming them in
the text is what lets a later session be told the note may have rotted.

## Why the blind spots are stated up front

An agent once spent ~6 calls hunting an inherited `white-space: nowrap` through
global stylesheets before measuring the page in a browser instead — one call.
No index can tell you whether text wraps, what paints on top, or what happened
at runtime.

The failure mode is silent, which is what makes it expensive: searching *works*,
it just cannot find something that was never in the code. So `brief` now says so
in its opener, sharpened when the repo is actually markup-heavy.

Related honest limits:

- Extraction is regex-heuristic (~96%). A miss costs one `search_code` fallback.
- `find_references` / `find_tests` are textual — same-named strangers appear.
- `search_intent` is lexical BM25, not embeddings: it ranks by shared
  name-words, so it won't bridge pure synonyms.
- `changed_files` gives blast radius, not hunks. Exact patch review is `git diff`.
- On a repo of tiny files, plain reads are fine. No ceremony.

## Why the build stamp is on `stats` and `brief`

An MCP server is long-lived: started once, then serving every chat until
something restarts it. So a fix can be written, compiled and committed while
the process answering you is still running yesterday's code — and from inside a
session there was no way to tell "the fix is broken" from "you're talking to an
old process".

That cost a real re-verification. Three servers were live, all started before
the build they were being tested against, and a fixed lookup looked broken. The
only way to know was comparing process start times against a file mtime from
outside the tool.

`stats` and `brief` now print the running file's build time. If a result
surprises you, check that line before debugging.

## Why symlinks are skipped, and now said out loud

The walker classifies entries with `Dirent`, which is lstat-based, so a symlink
is neither `isFile()` nor `isDirectory()` and falls through every branch. That
is what keeps indexing inside the root — a link pointing at `/etc` cannot drag
the filesystem in.

But it was silent, and a pnpm workspace or a monorepo that links shared
packages then indexes **nothing** from them while reporting success. An empty
answer that looks like a complete one is the failure mode this codebase refuses
everywhere else, so `index_repo` now names the links it did not follow.

## Why containment is one function

`safeResolve` checks lexically and again after `realpath`. Both halves are
needed for different reasons: the lexical pass stops `../../secrets` and the
Windows cross-drive case — `path.relative("C:\repo", "D:\secrets")` returns
`D:\secrets`, which contains no `..` at all — while the realpath pass stops a
link inside the repo pointing outside it, which no string inspection can see.

Dedupe had only the lexical half, so a symlink anchor was opened and hashed
before the handler's own check refused it. The bytes never reached the caller,
but the read happened. Both callers now share one exported guard, because the
same asymmetry had already been fixed once at the tool layer and reappeared one
level down.

## Automatic behaviour worth knowing

- **Repeat suppression.** A second identical `read_lines` / `get_file_skeleton`
  / `outline_file` answers with a pointer instead of the body. "Unchanged" means
  the file *hashes* the same and the index hasn't been rebuilt. A third identical
  call re-emits in full — the escape hatch if compaction dropped it.
- **Self-healing staleness.** If a file moved under the index, a NAME is
  re-resolved against a fresh parse automatically. An explicit `path`+`line`
  still refuses, because that coordinate is yours and silently retargeting it is
  how you overwrite the wrong function.
- **Snapshots.** Uncommitted work is copied to `.slimdex/snapshots/` hourly on a
  dirty `index_repo`, and once before every write. An undo buffer for a stray
  `git checkout .` — a pushed commit is still the only real backup.
- **Batched writes** are refused before any write if a target is ambiguous, two
  edits overlap, or a file isn't writable. Within a file the write is atomic;
  across files it can't be, so a mid-batch failure rolls back and reports the
  exact state of each file. Read the response rather than assuming success.

## Env knobs

- `SLIMDEX_PRETTY=1` — human-aligned padding; output is terse by default.
- `SLIMDEX_NO_DEDUPE=1` — turn off repeat suppression.
- `SLIMDEX_PROFILE=lean` — off by default and **not recommended**. It advertises
  15 tools instead of 29, but the other 14 (including `get_context`,
  `changed_files`, `find_tests`, `digest_save`, which the guidance actively tells
  you to use) must then be reached through `batch`. If you do see a lean surface,
  route those steps through `batch` — never silently skip one or fall back to a
  broad read.

## Making the discipline non-optional

Instructions are advisory, and advice loses to reflex — three audit sessions
read "use `replace_symbol`" every turn and still reached for the built-in edit
tool. Nothing inside slimdex can change that: MCP is additive, so a server
cannot wrap a client's built-in tools.

A `PreToolUse` hook can, because it sees the one deciding signal at call time —
how much old code is about to be re-sent. See [`hooks.md`](hooks.md).

## Self-audit

Run `stats checkpoint:true` at the start of a task and `stats session:true` at
the end. Then ask: did it open with `index_repo` + `brief` rather than a memory
dump? Is follow-through M ≥ N? Any avoidable full read, or whole-file rewrite?
Is `search_code` above the symbol tools in call count? Are `batch` and
`read_lines` top of the chars column — and if so, were those calls as narrow as
they could have been? Was every conclusion saved?
