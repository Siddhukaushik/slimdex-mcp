# Slimdex Agent Brain

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
- **Ambiguous symbol** (common name, several defs) → `find_definition` gives all
  candidates with `path:line`; `get_symbol_context` the right one by exact path.
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
- **A few lines inside a symbol?** → `read_lines` the exact span, patch with a small
  `Edit`/`apply_patch` hunk. Never rewrite a whole file for a few lines.
- **Before editing X** → `find_tests X`: run exactly the tests that cover it, or see
  that none do and treat that as risk. Before touching a shared module, `dep_graph
  mode:"mermaid" root:"<file>"` for blast radius; `find_references` (scoped) for every
  caller to update. Match reasoning effort to the task.

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
- Provenance is automatic: `memory_save` records what you were just looking at, so a
  saved decision carries its evidence trail. Name the symbols/files in the text too —
  `brief` staleness-checks those mentions and flags the note if they've since vanished.

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

## Self-audit (run `stats`)
Started with memory+recap+index? follow-through M ≥ N? Any avoidable full read? Any
whole-file rewrite? search_code below symbol-tool count? Saved every conclusion?
Session long enough to reset?

## Safety / meta tools (infrastructure, not token savers)
- `snapshot` — copies uncommitted files to `.slimdex/snapshots/`; also auto-runs
  (hourly, dirty tree) via `index_repo`, and once per `replace_symbol` before it
  writes. Undo buffer for a stray `git checkout .` or a bad edit; a pushed commit is
  the only real backup.
- `stats` — the meter: shows the follow-through line and char totals. Run it to
  check discipline, not to explore.
- `outline_file` — flat symbol list (lighter than `get_file_skeleton`).