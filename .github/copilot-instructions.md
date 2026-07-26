# Slimdex Copilot Instructions

Use Slimdex first. The goal is the fewest tokens that still get the answer right.

**Open with** `batch: [ index_repo, brief ]`. `brief` gives repo shape, where
recent sessions dug, and saved conclusions checked against the index (✓ live,
⚠ stale); it works cold, building the index itself. `index_repo` is incremental —
re-run after your edits or a branch change, or searches answer confidently and
wrongly.

## Find and read

| Need | Call | Knobs (defaults) |
|---|---|---|
| What is this repo | `repo_map` | |
| How it works, per last session | `digest_get` | flags files changed since |
| How an area works | `context_pack "how X works"` | `budget` 6000, `symbols` 8, `bodies` 3 |
| Half-remembered name | `search_symbols` — index only, opens no file | `kind`, `limit` 25, `pathPrefix` |
| Behaviour, not the name | `search_intent` | |
| Where X is defined | `find_definition` | |
| Definition + callers + imports at once | `get_context` | `include` is OPT-IN — `body`/`dependents` NOT default; `callerLimit` 12, `maxChars` 12000 |
| Who uses X | `find_references` | |
| Tests covering X | `find_tests` | `pathPrefix`, `limit` |
| Map a file | `outline_file` (declarations) / `get_file_skeleton` (signatures; use over ~300 lines) | |
| Bodies of X, Y, Z | `get_symbol_context names:[...]` | `maxLines` 200, `before`/`after`, `pathPrefix` |
| Exact lines | `read_lines` | |
| Literal text | `search_code` | `limit` 20 + `cursor` to page, `pathPrefix`, `regex`, `ignoreCase` |
| Imports / importers / diagram | `dep_graph mode:"imports"\|"dependents"\|"mermaid"` | `root`, `depth` 2, `scope` |
| Uncommitted changes | `changed_files` | |
| What past sessions did | `recap` | |

Symbol questions take symbol tools; `search_code` is for literals only. On an
ambiguous name use `pathPrefix` or `path`+`line` — don't read the candidates to
pick one. After a skeleton, follow through with `get_symbol_context`/`read_lines`
for just those spans; never widen to a whole file. `context_pack` orients — drop
to exact source after. `batch` runs up to 20 calls in one round-trip (no
nesting), but batching doesn't excuse a wide call.

## Write

`replace_symbol` writes by NAME, so the old body is never re-sent to locate the
edit.

- **Replace**: `name` (or `path`+`line`) + `body`.
- **Insert**: `after:"X"` / `before:"X"` + `body` adds a NEW symbol beside an
  existing one — use this, not `Edit`, to add a method next to its relatives.
  `after` means after the anchor's closing brace.
- **`edits:[{name, body}, ...]`**: up to 20 at once, one snapshot, one re-index.
  Refused before any write on an ambiguous target, overlapping edits, or an
  unwritable file; a mid-batch failure rolls back and says so.
- `body` is the complete definition, indented for the file. Insert is verbatim —
  add newlines yourself for blank lines.
- Small change inside a big symbol → `Edit`. Mixing is safe: a `name` re-resolves
  against a fresh parse if the file moved; an explicit `path`+`line` refuses,
  since that coordinate is yours.

Never splice by line number or edit via shell substitution (`sed`, `python -c`,
`-replace`) — both half-apply silently. `replace_symbol` refuses unknown or
ambiguous names, snapshots first, re-indexes, and reports the new span so you
don't re-read to verify.

Before editing: `find_tests` names the tests that would catch a break — run those;
nothing covering it is risk you accept knowingly. `dep_graph mode:"dependents"`
is the blast radius of a shared module.

`snapshot` copies every uncommitted file to `.slimdex/snapshots/<timestamp>/`;
also automatic (≤hourly) when `index_repo` sees a dirty tree, newest 10 kept. Not
a substitute for committing.

## Memory

`memory_save` the moment something is confirmed — sessions don't end cleanly.
Lead with the conclusion; only the opening clause survives as the preview.

Triage, then expand: `brief`/`memory_list` previews (`limit` 50) →
`memory_search query/tag` → `memory_get ids:[...]`. `full:true` dumps every body —
last resort. `memory_delete` anything proven wrong; a stale fact is worse than
none, because the next session trusts it.

`digest_save` stores the architecture cheat-sheet — pass `covers:[paths]` so
`digest_get` can flag it stale. The why and the shape, not a symbol list.
Overwrites the previous one.

## Cost

`stats checkpoint:true` at the start of a task, `session:true` at the end, and the
difference is that task. `session:true` alone means since the server booted.
`reset` destroys all-time history — use `checkpoint` for a clean number.

Two windows: the table runs from `since`, the write block from `writeSince`
(later, or unknown on old files). When the heading names a second window, a zero
there may mean "not recorded yet", and the sections can't be compared.

## Blind spots

The index sees code, not the rendered page — layout and runtime need a browser or
logs. `find_references`/`find_tests` are textual: same-named symbols show up,
dynamic calls are missed. History is re-read every turn, so save conclusions as
they land and start a fresh session rather than running a marathon.
