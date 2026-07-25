## Prime directive
Return the answer, not the haystack. But when you genuinely can't be sure without
more context, get it — a wrong edit is more expensive than any read.

## Savings ladder — biggest first
| Do this | Instead of | Why it pays |
|---|---|---|
| `batch: [index_repo, brief]` to open | reading files, or `memory_list full:true` | opener is bounded; a full memory dump measured ~18,600 chars |
| `context_pack "<question>"` to learn an area | ~10 exploratory calls | one bounded bundle; ten results linger in the transcript and re-cost every later turn |
| `get_file_skeleton` → `get_symbol_context names:[…]` | reading a 300+ line file | the skeleton tells you where everything is; read only that |
| `get_context name:"X"` | chaining find_definition + find_references + dep_graph | one call, one response |
| `replace_symbol name/edits:[…]` | re-emitting a file to change a few lines | output costs ~4–5× input |
| `digest_save` once you know the shape | the next session re-exploring from zero | biggest cross-session saving |
| save + fresh chat | one long session | history is re-read every turn |

**The follow-through rule — the #1 observed leak.** After a skeleton, pull ONLY the
named symbols or line ranges. A whole-file read after a skeleton throws the saving
away at the exact moment it was about to pay. `stats` prints
`follow-through: N skeleton(s) → M narrow read(s)`; if M < N you are doing it wrong.
Exception: if you already know you're rewriting the whole file, skip the skeleton.

## Question → tool (never a bare file read)
| Question | Tool |
|---|---|
| What is this repo / where is the code? | `repo_map`, then `repo_map path:"dir"` |
| How does <area> work? | `context_pack` |
| What's in this file? | `get_file_skeleton` (`outline_file` if unindexed) |
| Where is X defined? | `find_definition`; half-remembered name → `search_symbols` |
| The thing that does Y, name unknown? | `search_intent` |
| Body of X (or X, Y, Z)? | `get_symbol_context names:[…]` |
| Exact lines 40–80? | `read_lines` |
| Who calls X? | `find_references` (+ `pathPrefix`) |
| What is X, who calls it, what does it use? | `get_context` |
| Which tests cover X? | `find_tests` |
| Where does this literal string appear? | `search_code` (real text only, `regex:true` for `A|B`) |
| What changed in the tree? | `changed_files` |
| What depends on this file? | `dep_graph` (`mode:"mermaid"` for blast radius) |
| What did past sessions conclude / do? | `brief`; then `memory_get ids:[…]` |

Symbol-shaped questions → symbol tools, never `search_code`: plain text search
returns same-named identifiers from unrelated files. Scope with `pathPrefix` when
you know the area, and keep `limit` small, paging with `offset`/cursor.

## Memory — how to save so it's worth having
`memory_save` the moment something is confirmed: a decision and WHY, a non-obvious
constraint, a gotcha that cost time, a confirmed bug, half-done work, agreed next
steps. Sessions have no end signal — the user just opens a new chat, and anything
unsaved is gone.
- **Lead with the conclusion.** Later sessions see only the first ~150 chars as a
  preview. Put the answer in the opening clause; one fact to one thing. Over ~1,200
  chars warns; over 20,000 is refused (that's a `digest_save`, not a fact).
- Tag it, `memory_search` before saving to correct rather than duplicate, and
  `memory_delete` what turns out wrong. A store of stale notes is worse than none.
- Don't save what the index or git already knows — memory is for what reading the
  code cannot tell you.

## Session hygiene (the lever no tool can pull for you)
Finish a chunk → save to memory → **start a fresh chat.** History is re-read every
turn, so a long session compounds roughly quadratically; resets are the only thing
that touches that cost. `/compact` if one session must stay long. Never paste large
blobs (logs, diffs, dumps) — they are re-read forever; summarize instead. Keep the
MCP setup stable within a session (churn breaks the prompt cache), and disconnect
servers you aren't using.

## Writing new code
Skeleton the target file + 1–2 siblings to match idiom — don't full-read the module.
`search_symbols`/`find_definition` to reuse helpers and avoid name clashes.
`find_references` on any type you extend. Write it in one focused edit, not
draft → rewrite → rewrite.

## Bug analysis / review
Verify every claim against the actual code before agreeing — pull the cited lines,
don't rubber-stamp. Judge severity by threat model (a "user-controlled input" flaw
in a local single-user tool ≠ the same in a public service). Check a proposed fix
doesn't break an internal caller. Call a rough edge a rough edge, not a
vulnerability.

## What slimdex is NOT
Symbol extraction is regex-heuristic (~96%) — a miss costs one `search_code`
fallback. `find_references` and `find_tests` are textual, so same-named strangers
can appear. The server never sees your conversation. On a repo of tiny files, plain
reads are fine — no ceremony.

## Automatic behavior worth knowing
- A second identical `read_lines`/`get_file_skeleton`/`outline_file` answers with a
  pointer to the earlier call instead of the body. "Unchanged" means the file
  HASHES the same and the index hasn't been rebuilt. Ask a third time and the full
  body returns — the escape hatch if compaction dropped it.
- `replace_symbol edits:[…]` is refused before any write if a target is ambiguous,
  two edits overlap, or a file isn't writable. Within a file the write is atomic;
  across files it can't be, so a mid-batch failure rolls back and reports the exact
  state of each file. Read the response, don't assume success.
- Uncommitted work is snapshotted to `.slimdex/snapshots/` (hourly at most, on
  `index_repo` with a dirty tree). Undo buffer for a stray `git checkout .`; a
  pushed commit is still the only real backup.

## Env knobs (MCP config, not per call)
- Output is terse by default; `SLIMDEX_PRETTY=1` restores human-aligned padding.
- `SLIMDEX_NO_DEDUPE=1` turns off repeat suppression.
- `SLIMDEX_PROFILE=lean` — off by default and **not recommended**: it advertises 15
  tools instead of 29, but the other 14 (including `get_context`, `changed_files`,
  `find_tests`, `digest_save`, which the guidance tells you to use) must then be
  reached via `batch`. If you do see a lean surface, route those steps through
  `batch` — never silently skip one or fall back to a broad read.

## Self-audit (run `stats`)
Opened with `index_repo` + `brief`, not a full memory dump? Follow-through M ≥ N?
Any avoidable full read? Any whole-file rewrite? `search_code` count below the
symbol-tool count? Saved every conclusion? Session long enough that a reset would
be cheaper than continuing?
