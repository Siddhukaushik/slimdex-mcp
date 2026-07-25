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

**The blind-edit rule — the same leak on the write side.** The tools that get used
are the ones you can't proceed without: you cannot edit a 3,000-line file without a
skeleton, so the skeleton gets called thirty times. The tools that get skipped are
*precautionary* — `find_tests`, `dep_graph`, `get_context`, `changed_files`. They
pay off by preventing a mistake that hasn't happened yet, and misplaced confidence
is the one thing that never announces itself. Nothing fails when you skip them, so
nothing corrects the habit. That's the entire mechanism, and it is why reading a
rule about them once per turn does not work: a rule competes with a trained reflex
and loses. `stats` prints the counts instead — see the self-audit.

**Read the instructions your client actually delivered.** MCP `instructions` can be
truncated silently — one client cut a 5,401-char block at ~2,000, dropping every
memory and editing rule, and the result was an agent that used slimdex read-only
for a whole session while believing it had the full guidance. If you have never
seen a rule about `replace_symbol` or `find_tests` in your injected context, that is
truncation, not absence. This file is the copy that doesn't depend on a buffer.

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
| What did past sessions actually *do*, if nothing was saved? | `recap` (reconstructed from the tool-call journal) |
| Is there an architecture cheat-sheet already? | `digest_get` — read it before re-deriving the shape |

Symbol-shaped questions → symbol tools, never `search_code`: plain text search
returns same-named identifiers from unrelated files. Scope with `pathPrefix` when
you know the area, and keep `limit` small, paging with `offset`/cursor.

## Every tool, and what it saves
All 29. A tool you've forgotten exists is one you fall back from — usually to a
broad read, which is the cost this server exists to remove.

**Orient (start here, cheapest)**
| Tool | Saves you |
|---|---|
| `index_repo` | incremental; re-run like `git fetch` before trusting any search |
| `brief` | the whole session opener — repo shape + prior conclusions, index-checked |
| `repo_map` | dir-level counts; `path:` drills in — orientation without opening a file |
| `recap` | what past sessions did, from the journal, even if nothing was saved |
| `changed_files` | which symbols a dirty tree's diff lands in, without the patch |

**Locate (never read a file to find something)**
| Tool | Saves you |
|---|---|
| `find_definition` | where X is, exactly — not 40 grep hits |
| `find_references` | who calls X (`pathPrefix` to scope) |
| `search_symbols` | half-remembered name → the real one |
| `search_intent` | you know the behaviour, not the name ("validate email") |
| `search_code` | literal strings only; `regex:true` for `A\|B` |

**Read narrowly (the core saving)**
| Tool | Saves you |
|---|---|
| `get_file_skeleton` | a 3,000-line file as ~30 lines of signatures |
| `outline_file` | same, for a file that isn't indexed yet |
| `get_symbol_context` | one or many symbol bodies; stops at the boundary, so it can't over-read |
| `read_lines` | an exact non-symbol span |
| `context_pack` | a whole area in ONE bundle instead of ~10 calls |
| `get_context` | definition + callers + deps in one call |
| `dep_graph` | blast radius before a shared-module change |

**Write and verify (output costs ~4–5× input)**
| Tool | Saves you |
|---|---|
| `find_tests` | the covering tests *before* the edit, not a broken build after |
| `replace_symbol` | rewrite by name — the old body is never re-sent to locate it |
| `snapshot` | pre-edit safety net in `.slimdex/snapshots/` |

**Carry across sessions (the biggest saving of all)**
| Tool | Saves you |
|---|---|
| `memory_save` | the only thing that survives this chat |
| `memory_get` / `memory_list` / `memory_search` | expand, browse, and avoid duplicating facts |
| `memory_delete` | a store of stale notes is worse than an empty one |
| `digest_save` / `digest_get` | an architecture cheat-sheet the next session reads instead of re-deriving |

**Meta**
| Tool | Saves you |
|---|---|
| `batch` | round-trips — but it costs the SUM of its sub-calls, so batch NARROW |
| `stats` | the audit: follow-through, write discipline, and what you never reached for |

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

## Width discipline (the #2 failure, after follow-through)
Narrow tools used widely cost what the full reads did. Measured in one real session:
`batch` 149k chars, `read_lines` 145k.
- **`batch` costs the SUM of its sub-calls** — it saves round-trips, not tokens.
  Batch narrow, independent lookups; give a call that would be big on its own its
  own turn, so you can bound it.
- **`read_lines` is cheap only if the span is.** Want a whole symbol? Use
  `get_symbol_context` — it stops at the symbol boundary, so it cannot over-read the
  way a guessed range does. Keep `read_lines` for exact non-symbol spans.
- `stats checkpoint:true` at the start of a task, `stats session:true` at the end, to
  see what that task cost. Plain counters span every earlier session on the repo, and
  `session:true` alone means "since the server booted", which outlives one chat.

## Concurrent agents
If another agent or a human may be in the same checkout, check `changed_files` and
the file's mtime before editing. Two writers in one worktree clobber each other
silently. Symptom: re-reading a file because its formatting keeps shifting under
you — that is a conflict, not a retrieval problem, and narrower reads won't fix it.

## Session hygiene (the lever no tool can pull for you)
Finish a chunk → save to memory → **start a fresh chat.** History is re-read every
turn, so a long session compounds roughly quadratically; resets are the only thing
that touches that cost. `/compact` if one session must stay long. Never paste large
blobs (logs, diffs, dumps) — they are re-read forever; summarize instead. Keep the
MCP setup stable within a session (churn breaks the prompt cache), and disconnect
servers you aren't using.

## Editing — the half that gets skipped
Reading discipline is the famous part and the cheaper half. Output costs ~4–5× input,
so an undisciplined edit wastes more than an undisciplined read.

| Before you change a symbol | Tool | What it buys |
|---|---|---|
| Which tests cover it? | `find_tests name:"X"` | run only those, or SEE nothing covers it — that's risk, and you want it *before* the edit, not from a broken build |
| Who breaks if I change the shape? | `get_context name:"X"` | definition + callers + deps in one call |
| Is this a shared module? | `dep_graph mode:"mermaid" root:"<file>"` | blast radius before, not after |
| What's already dirty? | `changed_files` | which symbols the diff lands in, without pulling the patch in |

**Rewriting a whole function/class/method → `replace_symbol name:"X" body:"…"`.**
Addressed by NAME: you never re-send the old body just so a tool can locate the
change. That waste scales with the size of what you're replacing, and it is paid in
output tokens. It snapshots first, re-indexes after, and reports the new line span,
so you don't re-read to verify either. Several at once: `edits:[{name,body},…]`.

Use a generic find-and-replace only for genuinely partial changes (a line, a
condition, a string). **Never splice by line number** — indices go stale the moment
anything above them shifts, which is precisely the arithmetic `replace_symbol`
exists to remove.

**Mixing slimdex writes with an ordinary edit tool is fine.** If the file moved
under the index, `replace_symbol name:` re-parses it and re-resolves the name
itself — no `index_repo` round-trip. Only an explicit `path`+`line` still refuses,
because that coordinate is yours and was computed against state that has moved.
Same for `brief` on a repo slimdex has never seen: it builds the index rather than
telling you to.

Two known limits: `replace_symbol` takes ranges from the regex index, so a symbol
the parser doesn't span — a top-level `const X = \`…\`` holding a long template
literal is the case that bit — can be replaced as a *one-line* range, leaving the old
body orphaned below. It warns (`⚠ re-indexed but no symbol parsed in the new range`);
read the response and check the reported span. And an ambiguous name is refused,
never guessed — pass `path` + `line`.

## Writing new code
Skeleton the target file + 1–2 siblings to match idiom — don't full-read the module.
`search_symbols`/`find_definition` to reuse helpers and avoid name clashes.
`find_references` on any type you extend. Write it in one focused edit, not
draft → rewrite → rewrite. Slimdex adds least here — new code has nothing to
retrieve — but the moment you touch something that already exists, the table above
applies.

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

## Self-audit (`stats checkpoint:true` before, `stats session:true` after)
Opened with `index_repo` + `brief`, not a full memory dump? Follow-through M ≥ N?
Any avoidable full read? Any whole-file rewrite? `search_code` count below the
symbol-tool count? Saved every conclusion? Session long enough that a reset would
be cheaper than continuing?

`stats` answers the rest for you, in two blocks you don't have to remember to check:

```
write discipline:
  replace_symbol: 0 call(s), 0 symbol(s) rewritten by name
  changed outside slimdex: 12 file(s)
  pre-edit checks (find_tests/dep_graph/get_context/changed_files): 0
  ⚠ Most edits bypassed replace_symbol. …
  ⚠ 9 write(s) with no preceding check. …

not reached for this session:
  find_tests           names the covering tests BEFORE you change a symbol
  dep_graph            blast radius of a shared module while it is still cheap
  replace_symbol       rewrite by name, without re-sending the old body
```

Read them the way you read follow-through. **"Changed outside slimdex"** counts files
whose *content* moved between two `index_repo` runs that slimdex didn't write — an
mtime bump with identical bytes doesn't count, so it isn't noise. If it dwarfs
`symbol(s) rewritten by name`, every whole-function rewrite in there re-sent an old
body purely so a tool could find it, at output prices. A **blind write** has no check
since the *previous* write; one `find_tests` at the top of a session doesn't cover
edit number four. **"Not reached for"** is the one that catches the failure nothing
else can: an unused tool leaves no trace, so a session that never called `find_tests`
looks identical to one where nothing needed testing.

Both are honest about their limits. The counter never sees your edit tool, only that
bytes moved — a human editing in another window counts too. And the unused list is
not a checklist; plenty of sessions legitimately need none of it.
