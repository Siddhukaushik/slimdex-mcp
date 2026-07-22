Slimdex — slimdex-mcp
TypeScript · Model Context Protocol server · MIT

## The problem

A coding agent asked a narrow question — "what calls this function?" — usually
answers it the expensive way: open the file, read all 800 lines, use one. Do
that four times and most of the context window is spent on code that was
never relevant. Worse, context is re-read every turn, so one wasteful read
keeps charging rent for the rest of the session.

## The approach

Give the agent a way to ask precisely. A file skeleton instead of a file. A
line range instead of a module. One symbol's body instead of its
neighbourhood. A list of `path:line:col` instead of the files containing them.
Twenty-one tools, one idea: return the answer, not the haystack. The headline
tool, `get_context`, assembles a symbol's definition, signature, callers and
imports into a single bounded brief — four round-trips collapsed into one
(add `dependents` or `body` when the question actually calls for them).

## How it differs

| Approach | Strength | Cost |
|---|---|---|
| Pack the whole repo into the prompt | Trivial, nothing to build | Spend scales with repo size, not question size |
| Embeddings / semantic search | Finds things by meaning | Heavy deps, an index that drifts, fuzzy answers to exact questions |
| Language servers / tree-sitter | Genuinely precise | A grammar or server per language, real install weight |
| Slimdex | Installs instantly, offline, zero config, no native deps | Regex heuristics — less precise than a real parser |

I took the last row deliberately: starting in a second and running offline is
the value, and per-language grammars would have traded it away. That's a real
trade, not a free win — if you need go-to-definition exactly right every time,
a language server beats this.

## Architecture

Four decisions stacked.

A **persistent index invalidated by mtime**, so refreshing re-parses only
what changed and stays cheap enough to run constantly — an incremental
rebuild over 5,000 files costs milliseconds, not seconds.

A **parser seam rather than a parser commitment** — extraction sits behind a
`Parser` interface, so tree-sitter can drop in later without touching a tool
or the index format; the weakness is quarantined in one file. The same
quarantine pattern extends the graph past what regex extraction alone can
see: for languages with no import statement, a masked-token scan links a file
to the other files whose classes it names by reference, and a second pass
reads the repo's own configuration files (metadata records, bindings) for the
same names — so "what implements this interface" and "what wires this up"
get real answers even where there's no `import` to parse.

**Budgeting on every response**, because an aggregator that returns
everything is just a new way to waste context — sections are opt-in, callers
capped, size bounded, and every cap that trips says so out loud
(`showing 3 of 68`). A tool that silently truncates is worse than one that
over-returns, because the model can't tell.

The **discipline ships with the server** via MCP's `instructions` channel, so
knowing when to skeleton instead of read travels with it instead of sitting in
a README nobody feeds the model.

What got rejected is as telling: symbol-ID dictionaries (MCP has no
client-side expansion, so the model burns a call resolving an opaque token),
token-budget estimators (`chars/4` lies across tokenizers), "see response #5"
caching (after compaction the referent is gone), and a session-budget refusal
tool (an agent hitting a refusal just falls back to reading whole files — the
failure mode it exists to prevent).

## What it's worth

Measured on a real project: a skeleton cost ~33× fewer tokens than reading the
file, a navigation task ~8× fewer, the same task end-to-end ~29% cheaper. The
gap is the honest part — a session is mostly fixed overhead Slimdex never
touches, so it only shaves the file-reading slice. One repo, one A/B run,
self-measured: directional, not a benchmark.

173 unit and integration tests across 16 files, CI on Ubuntu + Windows across
Node 20/22, and zero network calls in `src/` — verifiable with one grep.
