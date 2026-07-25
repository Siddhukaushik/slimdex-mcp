The one-page operating sheet. Long-form reasoning: `agent-brain.md`.

The server also injects a compressed copy each turn — but clients truncate
`instructions` (one cut a 5,401-char block at ~2,000, silently dropping every
memory and editing rule). If you've never seen a rule about `replace_symbol` or
`find_tests` in your context, that's truncation, not absence. This file is the
copy that doesn't depend on a buffer.

## Prime directive
Return the answer, not the haystack. But when you genuinely can't be sure without
more context, get it — a wrong edit costs more than any read.

## The two rules everything else serves

**Follow-through (#1 leak).** After a skeleton, pull ONLY the named symbols or
line ranges. A whole-file read after a skeleton throws the saving away at the
moment it was about to pay. `stats` prints `follow-through: N skeleton(s) → M
narrow read(s)`; M < N means you're doing it wrong. Exception: if you already know
you're rewriting the whole file, skip the skeleton.

**Blind edits (#1 leak on the write side).** The tools you always use are the ones
you can't proceed without — you can't edit a 3,000-line file without a skeleton.
The ones you skip are *precautionary*: `find_tests`, `dep_graph`, `get_context`,
`changed_files`. They pay by preventing a mistake that hasn't happened yet, and
misplaced confidence never announces itself. Nothing fails when you skip them, so
nothing corrects the habit — which is why reading this once per turn doesn't stick.
`stats` prints the counts instead.

## All 29 tools: question → tool → what it saves

**Orient**
| Question | Tool | Saves |
|---|---|---|
| Starting a chat | `brief` | repo shape + prior conclusions, index-checked; builds the index if cold |
| Is the index current? | `index_repo` | incremental — re-run like `git fetch` before trusting a search |
| What is this repo? | `repo_map` (`path:` drills in) | dir-level counts without opening a file |
| What did past sessions do? | `recap` | reconstructed from the journal, even if nothing was saved |
| What's already dirty? | `changed_files` | which symbols the diff hits, without the patch |
| Is there a cheat-sheet? | `digest_get` | read it before re-deriving the shape |

**Locate** — never read a file to find something
| Question | Tool | Saves |
|---|---|---|
| Where is X? | `find_definition` | the site, not 40 grep hits |
| Who calls X? | `find_references` (+`pathPrefix`) | callers, scoped |
| Half-remembered name? | `search_symbols` | the real one |
| Know the behaviour, not the name? | `search_intent` | BM25 over names — see caveat below |
| A literal string? | `search_code` (`regex:true` for `A\|B`) | path:line:col |

**Read narrowly** — the core saving
| Question | Tool | Saves |
|---|---|---|
| What's in this big file? | `get_file_skeleton` | 3,000 lines → ~30 signatures |
| …and it's not indexed? | `outline_file` | flat symbol list |
| Body of X (or X,Y,Z)? | `get_symbol_context names:[…]` | stops at the symbol — can't over-read |
| Exact non-symbol span? | `read_lines` | just those lines |
| How does <area> work? | `context_pack` | ONE bundle vs ~10 calls that re-cost every later turn |
| What is X, who calls it, what does it use? | `get_context` | all three in one call |
| What depends on this file? | `dep_graph` (`mode:"mermaid"`) | blast radius |

**Write and verify** — output costs ~4–5× input
| Question | Tool | Saves |
|---|---|---|
| Which tests cover X? | `find_tests` | run only those — or SEE none exist, before editing |
| Rewrite a whole function/class? | `replace_symbol` | by NAME — old body never re-sent to locate it |
| Safety net | `snapshot` | auto before every write; `.slimdex/snapshots/` |

**Carry across sessions** — the biggest saving of all
| Question | Tool | Saves |
|---|---|---|
| Something worth keeping | `memory_save` | the only thing that survives this chat |
| Expand / browse / dedupe | `memory_get` · `memory_list` · `memory_search` | previews, not dumps |
| Wrong note | `memory_delete` | stale notes are worse than none |
| Know the shape now | `digest_save` | next session reads a page instead of re-exploring |

**Meta** — `batch` (round-trips; costs the SUM of sub-calls, so batch NARROW) ·
`stats` (the audit)

## Search caveats
Symbol-shaped → symbol tools, never `search_code`: text search returns same-named
identifiers from unrelated files. Scope with `pathPrefix`, keep `limit` small, page
with `offset`/cursor.

**"Where does this live in this huge file?" is a skeleton question, not a search
question** — a text search returns every mention ranked by nothing. `search_code`
now says so when most hits pile into one big file. `search_intent` matches
*wording*, so a vague query ranks confidently on whichever one or two words exist;
it now names the words that scored nothing and flags when a single live word is
doing all the work.

## Editing
| Before changing a symbol | Tool |
|---|---|
| Which tests cover it? | `find_tests name:"X"` — or see that none do, and treat that as risk |
| Who breaks if the shape changes? | `get_context name:"X"` |
| Is it a shared module? | `dep_graph mode:"mermaid" root:"<file>"` |

**Whole function/class/method → `replace_symbol name:"X" body:"…"`.** Addressed by
NAME: you never re-send the old body so a tool can locate the change — that waste
scales with what you're replacing and is paid in output tokens. Snapshots,
re-indexes, reports the new span. Several at once: `edits:[{name,body},…]`.

Generic find-and-replace only for partial changes (a line, a condition, a string).
**Never splice by line number** — indices go stale the moment anything above shifts.

Mixing slimdex writes with an ordinary edit tool is fine: if the file moved under
the index, `replace_symbol name:` re-parses and re-resolves itself. Only explicit
`path`+`line` refuses — that coordinate is yours, computed against moved state.

Two limits: ranges come from the regex index, so a symbol the parser doesn't span
(a top-level `const X = \`…\`` with a long template literal) can be replaced as a
*one-line* range, orphaning the old body — it warns, so read the reported span.
Ambiguous names are refused, never guessed; pass `path`+`line`.

## Writing new code
Skeleton the target + 1–2 siblings for idiom — don't full-read the module.
`search_symbols`/`find_definition` to reuse helpers and avoid clashes.
`find_references` on any type you extend. One focused edit, not draft → rewrite →
rewrite. Slimdex adds least here; the moment you touch existing code, the table
above applies.

## Memory
`memory_save` the moment something is confirmed — a decision and WHY, a non-obvious
constraint, a gotcha that cost time, a confirmed bug, half-done work, agreed next
steps. Sessions have no end signal; the user just opens a new chat.
- **Lead with the conclusion** — later sessions see only the first ~150 chars. One
  fact to one thing. Over ~1,200 chars warns; over 20,000 is refused (that's a
  `digest_save`).
- `memory_search` before saving to correct rather than duplicate; `memory_delete`
  what turns out wrong.
- Don't save what the index or git already knows.

## Width discipline (#2 failure, after follow-through)
Narrow tools used widely cost what full reads did — measured in one session:
`batch` 149k chars, `read_lines` 145k.
- **`batch` costs the SUM of its sub-calls.** It saves round-trips, not tokens.
  Batch narrow, independent lookups; give a big call its own turn so you can bound it.
- **`read_lines` is cheap only if the span is.** Want a whole symbol? Use
  `get_symbol_context` — it stops at the boundary.

## Session hygiene (the lever no tool can pull for you)
Finish a chunk → save to memory → **start a fresh chat.** History is re-read every
turn, so a long session compounds roughly quadratically. `/compact` if one must stay
long. Never paste large blobs — they're re-read forever; summarize. Keep the MCP
setup stable within a session (churn breaks the prompt cache).

## Concurrent agents
If another agent or human may be in the same checkout, check `changed_files` and
mtime before editing. Two writers in one worktree clobber each other silently.
Symptom: re-reading a file because its formatting keeps shifting — that's a
conflict, not a retrieval problem.

## Indexing hygiene
Build output crowds out real hits. Skipped by default: the usual build dirs, plus
any file with lines past ~5,000 chars (minified). That content check exists because
no *name* list catches a hash-named bundle in a directory called `assets` — and
`assets`/`public`/`static` are deliberately not ignored, since real source lives
there. Still noisy? `.slimdex.json`:
`{"ignoreDirs": ["fixtures", "backend/src/main/resources/static/assets"]}` — bare
names match any directory so called; entries with `/` are anchored at the repo root
and respect boundaries (`src/gen` won't hit `src/generated`). Read the `config:`
line `index_repo` prints rather than assuming it took.

## Bug analysis / review
Verify every claim against the actual code before agreeing — pull the cited lines.
Judge severity by threat model (a "user-controlled input" flaw in a local
single-user tool ≠ the same in a public service). Check a proposed fix doesn't break
an internal caller. Call a rough edge a rough edge, not a vulnerability.

## What slimdex is NOT
Symbol extraction is regex-heuristic (~96%) — a miss costs one `search_code`
fallback. `find_references` and `find_tests` are textual, so same-named strangers
appear. The server never sees your conversation. On a repo of tiny files, plain
reads are fine.

## Automatic behavior
- A repeated identical `read_lines`/`get_file_skeleton`/`outline_file` answers with
  a pointer to the earlier call. "Unchanged" means the file HASHES the same and the
  index wasn't rebuilt. Ask a third time for the full body — the escape hatch if
  compaction dropped it.
- `replace_symbol edits:[…]` is refused before any write if a target is ambiguous,
  two edits overlap, or a file isn't writable. Atomic within a file; across files it
  can't be, so a mid-batch failure rolls back and reports each file's exact state.
  Read the response, don't assume success.
- Uncommitted work is snapshotted (hourly at most, on `index_repo` with a dirty
  tree). Undo buffer for a stray `git checkout .`; a pushed commit is the real backup.

## Env knobs (MCP config, not per call)
`SLIMDEX_PRETTY=1` restores human padding · `SLIMDEX_NO_DEDUPE=1` turns off repeat
suppression · `SLIMDEX_PROFILE=lean` advertises 15 tools instead of 29 — **not
recommended**: the other 14 (`get_context`, `changed_files`, `find_tests`,
`digest_save`…) must then go through `batch`. If you see a lean surface, route those
steps through `batch` — never skip one or fall back to a broad read.

## Self-audit (`stats checkpoint:true` before, `stats session:true` after)
Opened with `brief`, not a full memory dump? Follow-through M ≥ N? Any avoidable
full read or whole-file rewrite? `search_code` below the symbol-tool count? Saved
every conclusion? Is `batch` or `read_lines` top of the chars column — and were
those calls as narrow as they could be?

`stats` answers the rest itself, in two blocks:

- **write discipline** — `replace_symbol` calls and symbols rewritten by name, vs
  files *changed outside slimdex* (content moved between two `index_repo` runs; an
  mtime bump with identical bytes doesn't count). If the second dwarfs the first,
  every whole-function rewrite in there re-sent an old body at output prices. Plus
  **blind writes**: no check since the *previous* write — one `find_tests` at the top
  of a session doesn't cover edit four.
- **not reached for** — the failure nothing else catches, since an unused tool leaves
  no trace: a session that never called `find_tests` looks exactly like one where
  nothing needed testing. Not a checklist.

Both are honest about limits: slimdex never sees your edit tool, only that bytes
moved — a human editing in another window counts too.
