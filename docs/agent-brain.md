# Slimdex Agent Brain

> **Dropping this into a repo as CLAUDE.md / AGENTS.md? Use
> [`agent-brain-slim.md`](agent-brain-slim.md) instead.** It is self-contained —
> savings ladder, question→tool table, memory discipline, session hygiene, review
> discipline, honest limits, env knobs — but carries the tool rules as dense
> tables rather than the prose below, since the server injects a fuller version of
> those into the model's context every turn anyway. Same coverage, ~30% smaller,
> and the rules agents skip most often (the follow-through rule) land twice on
> purpose. Keep this full version for reading.

Operating instructions for any LLM in a repo with the slimdex MCP server.
Goal: fewest tokens that still guarantee a correct result. This file is HOW to
use the tools — nothing else.

## Prime directive
Return the answer, not the haystack. Never read a whole file when a narrower tool
answers the question. But when you genuinely can't be sure without more context,
get it — a wrong edit is more expensive than any read.

## Session start (always, first)
```
index_repo    then    brief
```
- `brief` — the one-shot opener: repo summary + where recent sessions were digging
  (from the automatic journal) + every saved conclusion CHECKED against the current
  index (✓ still live / ⚠ maybe stale). It folds `memory_list` + `recap` together.
- Drop to `batch: [ memory_list, recap ]` only for the raw, unsynthesized lists.
- Saved facts arrive as ~150-char previews. Expand only what you need with
  `memory_get ids:[...]`; never open a session with `memory_list full:true` (measured
  ~18,600 chars on an 18-fact store, re-read in every later turn).
- `index_repo` first so `brief`'s staleness check runs against fresh symbols;
  re-run it after edits or a branch switch.
- On a dirty tree, also `changed_files` — the diff's symbols, not the patch.
- If a `digest_get` cheat-sheet exists and is fresh, read it — it explains the
  system in a page so you skip re-exploring the code. Write one with `digest_save`
  (set `covers`) once you understand the shape; it's the biggest cross-session saving.

## Question → tool (never a file read)
| Question | Tool |
|---|---|
| Where is the code / what's this repo? | `repo_map` (then `repo_map path:"dir"`) |
| Understand a whole AREA in one call? | `context_pack("how X works")` (not ~10 calls) |
| What's in this file? | `get_file_skeleton` (or `outline_file`) |
| Where is symbol X defined? | `find_definition` / fuzzy: `search_symbols` |
| Know what it does, not its name? | `search_intent` (BM25, no embeddings) |
| What is X, who calls it, what does it use? | `get_context` (one call, not four) |
| Body of X (or X, Y, Z)? | `get_symbol_context names:[...]` (up to 10) |
| Name defined in several files? | `get_symbol_context name:"X" pathPrefix:"src"` — one call, not a rejection + retry |
| Exact lines 40–80? | `read_lines` |
| Who uses X? | `find_references` (+ `pathPrefix`) |
| Which tests cover X? | `find_tests` (run those, or note X is untested) |
| Where does this string appear? | `search_code` (real text only) |
| What changed in the tree? | `changed_files` |
| What imports/depends on this file? | `dep_graph` |
| Rewrite a whole function/class? | `replace_symbol name:"X" body:"…"` (write) |

Symbol-shaped questions → the symbol tools. Reserve `search_code` for genuine text
hunts; scope with `pathPrefix` when you know the area.

## The follow-through rule (the #1 failure)
After `get_file_skeleton`, pull ONLY the named bodies with `get_symbol_context` or
`read_lines`. A whole-file read after a skeleton throws the saving away. `stats`
prints `follow-through: N skeleton(s) → M narrow read(s)` — if M < N you're wrong.

The four situations that tempt a full read, and the correct narrow move:
- **Ambiguous symbol** (common name, several defs) → `get_symbol_context name:"X"
  pathPrefix:"src/api"` resolves it in ONE call. Only when you can't narrow by path:
  `find_definition` for the candidates, then `get_symbol_context` by exact path+line.
- **Multi-hunk edit needs nearby context** → `read_lines` the exact span you'll
  patch, not the whole file.
- **Tool drift** (sliding into plain `read_file` "for convenience") → stay in
  slimdex through the edit.
- **Validation** (diffs/tests) → use `changed_files`; don't re-read whole files.

Full-read is allowed only when a block truly can't be disambiguated otherwise —
rare, not routine.

## Editing code
Narrow read → narrow edit. Output costs ~4-5x input, so this is where tokens actually
leak — attack it, don't just optimize reads.
- **Whole function/class/method?** → `replace_symbol name:"X" body:"…"`. You emit
  only the new body; you do NOT re-send the old code for a matcher to locate — slimdex
  has X's range from the index. It snapshots first and re-indexes after, and reports
  the new line span so you don't re-read to verify.
- **Several symbols at once?** → one `replace_symbol edits:[{name,body},…]` call: one
  snapshot, one re-index, one response, instead of N calls that each re-state the plan
  and re-pay the per-turn overhead. The batch is refused BEFORE any write if a target
  is ambiguous, two edits overlap, or a file isn't writable. Within one file the write
  is atomic; across files it cannot be, so a write that fails mid-batch rolls the
  earlier files back and tells you exactly what state each one is in. Read the response
  rather than assuming success.
- **A few lines inside a symbol?** → `read_lines` the exact span, patch with a small
  `Edit`/`apply_patch` hunk. Never rewrite a whole file for a few lines.
- **Before editing X** → `find_tests X`: run exactly the tests that cover it, or see
  that none do and treat that as risk. Before touching a shared module, `dep_graph
  mode:"mermaid" root:"<file>"` for blast radius; `find_references` (scoped) for every
  caller to update. Match reasoning effort to the task.

**Why this section is the one that gets skipped.** The tools you reliably use are
the ones you cannot proceed without — you can't edit a 3,000-line file without a
skeleton, so the skeleton gets called thirty times. Everything above is
*precautionary*: it pays off by preventing a mistake that hasn't happened yet, and
misplaced confidence never announces itself. Nothing fails when you skip
`find_tests`; you just meet the failure later as a broken build and experience it
as normal work. Nothing fails when you find callers with `search_code` instead of
`dep_graph`; you just don't learn what you missed. That is why reading this once per
turn doesn't stick — a rule competes with a trained reflex and loses. `stats` prints
the counts instead, which is the only intervention observed to interrupt it.

**Two known limits of `replace_symbol`.** Ranges come from the regex index, so a
symbol the parser doesn't span — a top-level `const X = \`…\`` holding a long
template literal is the case that bit — can be replaced as a *one-line* range,
leaving the old body orphaned below. It warns (`⚠ re-indexed but no symbol parsed in
the new range`); read the response and check the reported span rather than assuming.
An ambiguous name is refused outright, never guessed — pass `path` + `line`.

**Never splice by line number.** A script that edits by index is brittle the moment
anything above it shifts, and on a file you're editing repeatedly that is every
edit. Addressing by name is exactly the arithmetic `replace_symbol` removes.

## Writing new code
Skeleton the target file + 1–2 siblings to match idiom — don't full-read the module.
`search_symbols`/`find_definition` to reuse helpers and avoid name clashes.
`find_references` on any type you extend. Write it in one focused edit, not draft →
rewrite → rewrite.

## Bug analysis / review
Verify every claim against the actual code before agreeing — pull cited lines, don't
rubber-stamp. Judge severity by threat model (a "user-controlled input" flaw in a
local single-user tool ≠ the same in a public service). Check a proposed fix doesn't
break an internal caller. Call a rough edge a rough edge, not a vulnerability.

## Memory (only conclusions survive; nothing auto-saves them)
`memory_save` each finding the moment it's confirmed — bugs (open or fixed),
decisions + WHY, constraints, gotchas, half-done work, next steps. `memory_search`
before saving; `memory_delete` what's wrong. Don't save what the index or git
already knows. Sessions have no end signal — unsaved = lost.
- **Lead with the conclusion.** Later sessions read the first ~150 chars as a preview,
  so put the answer in the opening clause and keep one fact to one thing. Over ~1,200
  chars earns a warning; over 20,000 is refused (that is a `digest_save`, not a fact).
- Provenance is automatic: `memory_save` records what you were just looking at, so a
  saved decision carries its evidence trail. Name the symbols/files in the text too —
  `brief` staleness-checks those mentions and flags the note if they've since vanished.

## Width discipline (the #2 failure, after follow-through)
Narrow tools used widely cost as much as the full reads they replaced. Two ways it
leaks, both measured in a real session (`batch` ~149k chars, `read_lines` ~145k):
- **`batch` costs the SUM of its sub-calls.** It saves round-trips, not tokens.
  Batching several *wide* calls produces one huge response that arrives as a single
  unskippable block. Batch narrow, independent lookups; if one sub-call would be big
  on its own, make it its own call so you can bound it.
- **`read_lines` is only cheap if the span is.** Ask for the lines you will actually
  use. Want a whole symbol? `get_symbol_context` — it stops at the symbol boundary,
  so it cannot over-read the way a guessed range does. Reach for `read_lines` when
  you need an exact span that isn't a symbol.

To measure what ONE task cost: `stats checkpoint:true` when you start, `stats
session:true` when you finish. The plain counters span every earlier session on the repo,
and `session:true` alone means "since the SERVER booted" — it is long-lived, so without a
checkpoint that still spans several chats.

## Concurrent agents (check before you edit)
If another agent or a human may be working the same checkout, confirm it before
editing: `changed_files` plus the file's mtime. Two writers in one worktree clobber
each other silently — an edit tool that refuses with "file modified since read" is
the lucky case, not the normal one. Symptom to watch for: re-reading the same file
because its formatting keeps shifting under you. That is not a retrieval problem and
narrower reads will not fix it; stop and resolve the conflict first.

## Session hygiene
Finish a chunk → save to memory → start a fresh chat (don't run marathons; history
is re-read every turn). `/compact` if one session must stay long. Don't paste large
blobs (logs/diffs/dumps) — they're re-read forever; summarize instead. Keep the MCP
setup stable within a session (churn breaks the cache). Batch independent lookups.
Disconnect MCP servers you aren't using.

## Budget knobs
Search tools: small `limit` first, page with `offset`/cursor. `get_context`:
`include` opt-in (add `body`/`dependents` only when needed). `get_symbol_context`:
`maxLines`. Always `pathPrefix` when you know the area.

Server-side knobs (MCP config, not per call):
- `SLIMDEX_PROFILE=lean` — OFF by default and not recommended. It advertises 15
  tools instead of 29 (~10,300 fewer chars per turn) but the other 14 — including
  `get_context`, `changed_files`, `find_tests` and `digest_save`, which the guidance
  above actively tells you to use — then have to be reached through `batch`, e.g.
  `batch: [{tool:"find_tests",args:{name:"X"}}]`. The instructions list them under
  that profile, so nothing is unreachable, but the indirection is a correctness risk
  for a saving the default no longer needs. If you DO see a lean surface: route those
  steps through `batch`; never silently skip one or fall back to a broad read.
- Output is terse by default; `SLIMDEX_PRETTY=1` restores human-aligned padding.
- `SLIMDEX_NO_DEDUPE=1` turns off repeat suppression.

## Repeat suppression (automatic)
A second identical `read_lines` / `get_file_skeleton` / `outline_file` answers with a
pointer to the earlier call instead of the body — it is already in your transcript, and
a response is paid again in every later turn. "Unchanged" means the file HASHES the
same and the index has not been rebuilt, not merely that its timestamp looks the same.
A third identical call re-emits in full: if you ask again after being told you already
have it, the honest reading is that compaction dropped it.

Only those three tools, and only when they were given a `path`. Name-addressed reads
(`get_symbol_context`) resolve their file internally and are never suppressed.

## Freshness (trust a result without re-reading)
`get_symbol_context` appends a ⚠ line only when the file changed since it was
indexed — the located line may be off, so `index_repo` then retry. Silent when
fresh. `brief` reports the repo-wide count. No warning = the line numbers are good;
don't spend a re-read to check.

## What slimdex is NOT
Extraction is regex-heuristic (~96%) — a miss costs one `search_code` fallback.
`find_references`/`find_tests` are textual (same-named strangers appear).
`search_intent` is lexical BM25, not embeddings — it ranks by shared name-words, so
it won't bridge pure synonyms with no token overlap. The server never sees the
conversation. On a repo of tiny files, plain reads are fine — no ceremony.

## Self-audit (`stats checkpoint:true` at the start, `stats session:true` at the end)
Started with `index_repo` + `brief` (not a full memory dump)? follow-through M ≥ N? Any avoidable full read? Any
whole-file rewrite? search_code below symbol-tool count? Saved every conclusion?
Session long enough to reset? Is `batch` or `read_lines` top of the chars column —
and if so, were those calls as narrow as they could have been?

`stats` answers the write side and the never-reached-for side without you having to
remember to ask — it prints a **write discipline** block and a **not reached for
this session** block. How to read them:

- **"Changed outside slimdex"** — files whose *content* moved between two
  `index_repo` runs that slimdex didn't write. An mtime bump with identical bytes
  doesn't count, so the number isn't noise. If it dwarfs `symbol(s) rewritten by
  name`, every whole-function rewrite in there re-sent an old body purely so a tool
  could locate it, paid at output prices.
- **Blind writes** — no check since the *previous* write. One `find_tests` at the
  top of a session doesn't buy credit for edit number four, and a check that errored
  buys nothing at all.
- **"Not reached for"** — the failure nothing else can catch. An unused tool leaves
  no trace, so a session that never called `find_tests` looks exactly like one where
  nothing needed testing. Not a checklist; plenty of sessions legitimately need none
  of it.

Both are honest about their limits: slimdex never observes your edit tool, only that
bytes moved, so a human editing in another window counts too.

## Indexing hygiene (junk in the index costs every search)
Build output crowds out real hits — one session had ~2.5MB of untracked bundles
indexed and roughly a third of its search results were minified noise. Two defences
run by default: the usual build directories are skipped by name, and any file whose
lines run past ~5,000 characters is treated as minified and left out. The second
exists because no *name* list can catch a hash-named bundle (`index-B7xK2p9q.js`)
inside a directory called `assets` — and `assets`, `public` and `static` are
deliberately not ignored, since real source lives in them. `index_repo` reports the
count as `skipped(minified build output): N`.

Still noisy? Add `.slimdex.json` at the repo root:
`{"ignoreDirs": ["fixtures", "backend/src/main/resources/static/assets"]}`. A bare
name matches any directory so called at any depth; an entry containing `/` is
anchored at the repo root and respects directory boundaries (`src/gen` will not also
ignore `src/generated`). Read the `config:` line `index_repo` prints rather than
assuming the config took — it warns on unknown keys and malformed values.

## If your injected instructions look short
MCP `instructions` can be truncated silently by the client. One cut a 5,401-char
block at ~2,000, mid-sentence, dropping every memory and editing rule — and the
result was an agent that used slimdex read-only for an entire session while
believing it had complete guidance. The shipped block is now written to a budget so
it fits, but if you have never seen a rule about `replace_symbol` or `find_tests` in
your context, that is truncation, not absence. This file does not depend on a client
buffer; it is the copy to trust.

## Safety / meta tools (infrastructure, not token savers)
- `snapshot` — copies uncommitted files to `.slimdex/snapshots/`; also auto-runs
  (hourly, dirty tree) via `index_repo`, and once per `replace_symbol` before it
  writes. Undo buffer for a stray `git checkout .` or a bad edit; a pushed commit is
  the only real backup.
- `stats` — the meter: shows the follow-through line and char totals. Run it to
  check discipline, not to explore.
- `outline_file` — flat symbol list (lighter than `get_file_skeleton`).