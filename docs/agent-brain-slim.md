# Slimdex operating card

Drop-in for CLAUDE.md / AGENTS.md / `.github/copilot-instructions.md`.
Goal: fewest tokens that still get the answer right. A wrong edit costs more
than any read — when you genuinely can't be sure, get the context.

## Open every session

```
batch: [ index_repo, brief ]
```

`brief` returns: repo shape, **what this index cannot answer**, where recent
sessions dug, saved conclusions checked against current code (✓ live / ⚠ stale),
and the running server's build time. Facts come as ~150-char previews — expand
with `memory_get ids:[…]`. Never open with `memory_list full:true` (~18,600
chars on an 18-fact store, re-read every turn after).

Dirty tree? add `changed_files`. Digest exists? `digest_get` is the repo in a page.

## Question → tool → what comes back

| Question | Call | Returns |
|---|---|---|
| What is this repo? | `repo_map` → `repo_map path:"dir"` | dirs with file/line/symbol counts |
| How does <area> work? | `context_pack "how X works"` | ranked symbols + import links + top bodies, one bounded bundle |
| What's in this file? | `get_file_skeleton` | every declaration + line number, bodies elided |
| Where is X defined? | `find_definition` | `path:line:col` per candidate |
| Half-remember the name? | `search_symbols` | fuzzy-ranked matches |
| Know what it does, not its name? | `search_intent` | BM25-ranked symbols |
| Body of X (or X, Y, Z)? | `get_symbol_context names:[…]` | just those bodies, bounded |
| Name in several files? | add `pathPrefix:"src"` | resolves in ONE call |
| Same name twice in ONE file? | add `path` + `line` | pathPrefix can't help there |
| Lines 40–80 exactly? | `read_lines` | that span only |
| Who uses X? | `find_references` (+`pathPrefix`) | every call site + enclosing symbol |
| Which tests cover X? | `find_tests` | test refs, or an explicit "nothing covers this" |
| Where does this literal appear? | `search_code` | `path:line:col` + the line |
| What changed? | `changed_files` | files + which symbols the diff lands in |
| What depends on this file? | `dep_graph` | imports / dependents / mermaid |

Symbol-shaped question → symbol tool. `search_code` is **literal by default**:
`foo(` matches `foo(`; pass `regex:true` only for a real pattern.

CSS is indexed: `.hub-card` is a symbol. A rule is findable under **any** class
in its selector, so `.hub-section.hub-allow-overflow` answers to either — and
`find_definition` takes the bare `hub-allow-overflow` you copied from JSX.

## The savings, biggest first

| Do this | Instead of | Why it pays |
|---|---|---|
| `batch: [index_repo, brief]` | reading files to orient | opener is bounded; a full memory dump measured ~18,600 chars |
| `context_pack "<question>"` | ~10 exploratory calls | one bounded bundle; ten results linger and re-cost every later turn |
| `get_file_skeleton` → `get_symbol_context names:[…]` | reading a 300+ line file | measured: 2,655-line file read via ~400 targeted lines |
| `get_context name:"X"` | `find_definition` + `find_references` + `dep_graph` | one call, one response |
| `replace_symbol` | re-sending old code to locate an edit | output costs ~4–5× input |
| `digest_save` once you know the shape | the next session re-exploring | biggest cross-session saving |
| save memory → fresh chat | one long session | history is re-read every turn |

## Editing — the expensive side

| Situation | Call |
|---|---|
| Rewriting most of a named function / class / method / CSS rule | `replace_symbol name:"X" body:"…"` |
| Adding something new beside existing code | `replace_symbol after:"neighbour" body:"…"` (or `before:`) |
| Adding beside a name that repeats in one file | `replace_symbol after:"X" path:"f.css" line:42 body:"…"` |
| Several symbols at once | `replace_symbol edits:[{name,body},…]` — one snapshot, one re-index |
| A line or two inside a big function | plain `Edit` — **correct, don't force slimdex** |

Test: *rewriting most of a named thing, or poking at part of it?* Most →
`replace_symbol`. Part → `Edit`. A one-line change in a 250-line component
through `replace_symbol` re-emits 250 lines; `Edit` sends six.

Writes snapshot first, refuse if the file changed since indexing, re-index
after, and report the new line span — so don't re-read to verify. Read the
response: it says if the write landed but the re-index failed.

Before changing X: `find_tests X` — run those, or treat "nothing covers it" as risk.

## The two rules that actually leak tokens

**Follow through.** After `get_file_skeleton`, pull only the named bodies. A
whole-file read after a skeleton throws the saving away at the moment it was
about to pay. `stats` prints `follow-through: N skeletons → M narrow reads`;
M < N means you're doing it wrong. Measured failure: 21 skeletons, 1 narrow read.

**Stay narrow.** `batch` costs the **sum** of its sub-calls — it saves
round-trips, not tokens. Batch narrow lookups; give a big call its own turn.
`read_lines` is cheap only if the span is; for a whole symbol use
`get_symbol_context`, which stops at the symbol boundary. Measured failure:
14 `read_lines` calls, 46,897 chars — ~3,350 each.

## Memory — only conclusions survive

`memory_save` the moment something is confirmed: a decision and WHY, a
constraint, a gotcha that cost time, a confirmed bug, half-done work, next
steps. Sessions have no end signal; unsaved is lost.

Lead with the conclusion — later sessions see only the first ~150 chars. One
fact, one thing. `memory_search` before saving so you correct rather than
duplicate; `memory_delete` what's wrong. Don't save what the index or git
already knows.

## Blind spots — go elsewhere first

This index sees **code, not behaviour**.

- **Layout, overlap, "why is this on top"** → measure in a browser. No index
  can tell you whether text wraps.
- **Runtime behaviour, "why did it do that"** → the logs.
- **Exact patch review** → `git diff`. `changed_files` gives blast radius, not hunks.

Extraction is regex-heuristic (~96%); a miss costs one `search_code` fallback.
`find_references`/`find_tests` are textual, so same-named strangers appear.
Symlinked directories are not followed — `index_repo` says so when it skips any.

## Close

Finish a chunk → save to memory → **start a fresh chat**. History is re-read
every turn, so long sessions compound. Never paste large blobs; summarize.

Measure one task: `stats checkpoint:true` at the start, `stats session:true` at
the end. Plain counters span every earlier session, and `session:true` alone
means "since the server booted".

If a result looks wrong, check the build line in `stats` — an MCP server is
long-lived, and a fix compiled after it started is not in the process you are
talking to. Restart before debugging.

If another agent or a human may be in the same checkout, check `changed_files`
and file mtimes before editing. Two writers in one worktree clobber each other
silently.
