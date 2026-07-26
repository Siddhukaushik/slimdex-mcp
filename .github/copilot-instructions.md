# Slimdex Copilot Instructions

Use Slimdex first when this repo is connected. The goal is the fewest tokens
that still get the answer right.

## Open every session

Start with:

```text
batch: [ index_repo, brief ]
```

`brief` shows the repo shape, recent search focus, and saved conclusions that
still match the current index. Treat `memory_list full:true` as a last resort.

`index_repo` is incremental, like `git fetch`. Re-run it after your own edits or
a branch change before trusting a search — a stale index answers confidently and
wrongly.

## Question -> tool

| Question | Call |
|---|---|
| What is this repo? | `repo_map` |
| How does an area work? | `context_pack "how X works"` |
| What's in this file? | `get_file_skeleton` |
| Where is X defined? | `find_definition` |
| Definition + callers + deps at once? | `get_context` |
| Know what it does, not its name? | `search_intent` |
| Body of X, Y, Z? | `get_symbol_context names:[...]` |
| Exact lines? | `read_lines` |
| Who uses X? | `find_references` |
| Which tests cover X? | `find_tests` |
| Where does this literal appear? | `search_code` |
| What changed? | `changed_files` |
| What depends on this file? | `dep_graph` |
| What did past sessions do? | `recap` |

Symbol-shaped questions should use symbol tools. Use `search_code` for literal
text only.

When a name has several definitions, the tool says so and lists them. Narrow with
`pathPrefix`, or pass `path` + `line` — do not read all the candidates to pick
one.

## Editing

When rewriting most of a named function, class, method, or CSS rule, use
`replace_symbol` so you send only the new body. For a small change inside a big
symbol, use `Edit`.

Never splice by line number, and never edit through shell text substitution
(`sed`, `python -c`, PowerShell `-replace`). Both silently half-apply: a shell
quoting slip mangles the body, and a missed anchor changes nothing while
reporting success. `replace_symbol` fails loudly instead, snapshots first, then
re-indexes and reports the new span.

Before changing a symbol, check `find_tests` for coverage. If there are no
tests, treat that as risk. Before touching a shared module, `dep_graph
root:"<file>"` shows the blast radius while it is still cheap to know.

`snapshot` lists what was saved before each write, so a bad edit is recoverable.

## Stay narrow

After `get_file_skeleton`, follow through with `get_symbol_context` or
`read_lines` for just the needed spans. Do not widen a focused read into a
whole-file read.

Use `batch` for several narrow lookups in one round-trip, but keep each call
small.

## Memory

Save confirmed findings, decisions, and gotchas with `memory_save` as soon as
they are confirmed. Sessions do not end cleanly, so waiting until the end loses
the note.

Lead with the conclusion. Later sessions see only the first ~150 characters, so
a note that opens with background buries the part that mattered.

`digest_save` is for the architecture cheat-sheet a future session reads instead
of re-exploring.

## Checking your own cost

`stats checkpoint:true` at the start of a task, `stats session:true` at the end,
and the difference is that task. `session:true` alone means "since the server
booted", which can span several chats.

The report carries two windows. The tool table runs from `since`; the write
block runs from `writeSince`, which is later on any repo that was recording
before the write counters shipped. A zero in the write block within that gap
means "not recorded yet", not "never done" — the report says so when the two
differ.

## Blind spots

This repo index sees code, not the rendered page. Layout, overlap, and runtime
behavior need a browser or logs.

History is re-read every turn, so a long session compounds. Save each conclusion
when it is confirmed, then start fresh rather than running a marathon.
