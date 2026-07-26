# Slimdex operating card

Drop-in for CLAUDE.md / AGENTS.md. Goal: fewest tokens that still get the
answer right. A wrong edit costs more than any read — when you genuinely can't
be sure, get the context.

## Open every session

```
batch: [ index_repo, brief ]
```

`brief` returns: repo shape, **what this index cannot answer**, where recent
sessions dug, and every saved conclusion checked against the current code
(✓ live / ⚠ maybe stale). Facts arrive as ~150-char previews — expand only what
you need with `memory_get ids:[…]`. Never open with `memory_list full:true`.

Dirty tree? Add `changed_files`. Digest exists? `digest_get` explains the repo
in a page.

## Question → tool → what you get back

| Question | Call | Returns |
|---|---|---|
| What is this repo? | `repo_map`, then `repo_map path:"dir"` | dirs with file/line/symbol counts |
| How does <area> work? | `context_pack "how X works"` | ranked symbols + import links + top bodies, one bounded bundle |
| What's in this file? | `get_file_skeleton` | every declaration + line number, bodies elided |
| Where is X defined? | `find_definition` | `path:line:col` per candidate |
| Half-remember the name? | `search_symbols` | fuzzy-ranked matches |
| Know what it does, not its name? | `search_intent` | BM25-ranked symbols |
| Body of X (or X, Y, Z)? | `get_symbol_context names:[…]` | just those bodies, bounded |
| Name in several files? | add `pathPrefix:"src"` | resolves in ONE call |
| Lines 40–80 exactly? | `read_lines` | that span only |
| Who calls X? | `find_references` (+`pathPrefix`) | call sites with enclosing symbol |
| Which tests cover X? | `find_tests` | test refs, or an explicit "nothing covers this" |
| Where does this literal appear? | `search_code` | `path:line:col` + the line |
| What changed? | `changed_files` | files + which symbols the diff lands in |
| What depends on this file? | `dep_graph` | imports / dependents / mermaid |

Symbol-shaped question → symbol tool. `search_code` is for literal text only,
and it is **literal by default** (metacharacters are matched as plain text; pass
`regex:true` only for a real pattern).

## Editing — the expensive side

Output costs ~4–5× input, so the rule is: **don't re-send old code to locate a
change.**

| Situation | Call |
|---|---|
| Rewriting most of a named function/class/method/CSS rule | `replace_symbol name:"X" body:"…"` |
| Adding something new next to existing code | `replace_symbol after:"neighbour" body:"…"` (or `before:`) |
| Several symbols at once | `replace_symbol edits:[{name,body},…]` — one snapshot, one re-index |
| A line or two inside a big function | plain `Edit` — **this one is correct**, don't force slimdex |

Rough test: *am I rewriting most of a named thing, or poking at part of it?*
Most → `replace_symbol`. Part → `Edit`.

Writes snapshot first, refuse if the file changed since indexing, re-index
after, and report the new line span — so don't re-read to verify. Read the
response: it tells you if the write landed but the re-index failed.

Before changing X: `find_tests X` — run those, or treat "nothing covers it" as
risk.

## The two rules that actually leak tokens

**Follow through.** After `get_file_skeleton`, pull only the named bodies with
`get_symbol_context` / `read_lines`. A whole-file read after a skeleton throws
the saving away at the moment it was about to pay. `stats` prints
`follow-through: N skeletons → M narrow reads`; M < N means you're doing it wrong.

**Stay narrow.** `batch` costs the **sum** of its sub-calls — it saves
round-trips, not tokens, so batch narrow lookups and give a big call its own
turn. `read_lines` is only cheap if the span is; for a whole symbol use
`get_symbol_context`, which stops at the symbol boundary.

## Memory — only conclusions survive

`memory_save` the moment something is confirmed: a decision and WHY, a
constraint, a gotcha that cost time, a confirmed bug, half-done work, next
steps. Sessions have no end signal; unsaved is lost.

Lead with the conclusion — later sessions see only the first ~150 chars.
One fact, one thing. `memory_search` before saving so you correct rather than
duplicate; `memory_delete` what turns out wrong. Don't save what the index or
git already knows.

Once you know the repo's shape, `digest_save` a page of architecture with
`covers` set — the biggest cross-session saving there is.

## Blind spots — go elsewhere first

This index sees **code, not behaviour**.

- **Layout, overlap, "why is this on top"** → measure it in a browser. No index
  can tell you whether text wraps.
- **Runtime behaviour, "why did it do that"** → the logs.
- **Exact patch review** → `git diff`. `changed_files` gives blast radius, not hunks.

Extraction is regex-heuristic (~96%); a miss costs one `search_code` fallback.
`find_references`/`find_tests` are textual, so same-named strangers can appear.

## Close

Finish a chunk → save to memory → **start a fresh chat**. History is re-read
every turn, so long sessions compound. Never paste large blobs; summarize.

Measure one task with `stats checkpoint:true` at the start and
`stats session:true` at the end — plain counters span every earlier session, and
`session:true` alone means "since the server booted".

If another agent or a human may be in the same checkout, check `changed_files`
and file mtimes before editing. Two writers in one worktree clobber each other
silently.
