# Slimdex Agent Brain

Drop this file into any project's `CLAUDE.md` / `AGENTS.md` (or reference it
from there) when the slimdex MCP server is connected. It is the operating
discipline that turns 21 tools into actual token savings. It is deliberately
short — a brain file that bloats context defeats its own purpose.

## Prime directive

**Return the answer, not the haystack.** Never read a whole file when a
narrower tool answers the question. One wasteful read charges rent every turn
for the rest of the session — context is re-sent on every model call, so
tokens saved early compound.

## Session start ritual (always, before anything else)

```
batch: [ memory_list, recap, index_repo ]
```

- `memory_list` — what past sessions **concluded** (decisions, bugs, gotchas).
- `recap` — where past sessions **looked** (auto-journaled files/symbols/searches;
  works even if the last session saved nothing).
- `index_repo` — refresh the symbol index; incremental, milliseconds when warm.
  On a dirty tree it also auto-snapshots uncommitted files (hourly).

One batch call ≈ a few hundred tokens, and it routinely replaces re-deriving
an entire previous session.

## Decision table — question → tool

| Your question | Call this — NOT a file read |
|---|---|
| What is this repo / where is the code? | `repo_map` (then `repo_map path:"dir"` to drill) |
| What's in this file? | `get_file_skeleton` (or `outline_file` for a flat list) |
| Where is symbol X defined? | `find_definition` / fuzzy: `search_symbols` |
| What is X, who calls it, what does it use? | `get_context` — one call replaces four |
| Show me the body of X (or X, Y and Z) | `get_symbol_context` with `names:[...]` |
| Show me exact lines 40–80 | `read_lines` |
| Who uses X? | `find_references` (+ `pathPrefix` to scope) |
| Where does this string/pattern appear? | `search_code` (real text only — symbols have better tools) |
| What changed in this working tree? | `changed_files` — the diff's *symbols*, not the patch |
| What imports / depends on this file? | `dep_graph` (imports / dependents / mermaid blast-radius) |
| What did previous sessions do? | `recap` + `memory_list` |
| Am I following the discipline? | `stats` — read the follow-through line |

## The follow-through rule (the #1 observed failure)

A skeleton is an **investment**. After `get_file_skeleton` shows you where the
functions are, pull the bodies with `get_symbol_context names:[...]` (up to 10
in one call) or `read_lines` on the spans it named. **Falling back to a
whole-file read after a skeleton throws the saving away at the exact moment it
was about to pay.** In one measured real session this single defection cost
more than every other inefficiency combined. `stats` prints
`follow-through: N skeleton(s) → M narrow read(s)` — if M < N, you are doing
it wrong.

## Memory: save-when-confirmed, never "at the end"

Sessions never announce their end — the user just opens a new chat, and
anything unsaved is gone. Therefore:

- `memory_save` each finding **the moment it is confirmed**: bugs (open OR
  fixed — fixed bugs recur), decisions and their WHY, constraints, gotchas,
  half-done work, agreed next steps. Tag everything.
- Do NOT save what the index already knows (symbol locations) or what git
  already records.
- `memory_search` before saving (correct, don't duplicate); `memory_delete`
  facts that turn out wrong.

## Budget knobs (defaults are sane; tighten when scanning wide)

- Every search tool: `limit` (default 20–25) + `offset` / cursor pagination.
- `get_context`: sections opt-in via `include` (default: definition,
  signature, callers, imports — add `body` or `dependents` only when needed),
  `callerLimit` (12), `maxChars` (12000). Every cap that trips says so —
  nothing is dropped silently.
- `get_symbol_context`: `maxLines` (200) per symbol.
- `find_references` / `search_code`: always pass `pathPrefix` when you know
  the rough area.
- `batch` any independent lookups — one round-trip, one protocol overhead.

## Protection layers (know where things live)

| Layer | Holds | Lifetime |
|---|---|---|
| journal → `recap` | where sessions looked | rolling last ~400 calls |
| `memory_*` | conclusions | forever (until deleted) |
| `snapshot` (auto-hourly on dirty tree) | uncommitted file copies, newest 10 | until pruned; same disk |
| git commit + push | everything | forever, disaster-proof |

Snapshots defeat a stray `git checkout .` — they do not replace committing.
When substantial work is done, suggest a commit to the user.

## What slimdex is NOT (don't fight it)

- Extraction is regex-heuristic (~96% recall) — a missed symbol costs one
  `search_code` fallback; that's normal, not broken.
- `find_references` is textual — same-named strangers can appear.
- Graph edges cover imports, name references (import-less languages), and
  repo-XML declarative wiring — but never bindings that exist only in a live
  system, never retrieved into the repo.
- The server never sees the conversation. Conclusions survive only if YOU
  save them.

## Env flags (set in the MCP client config, not per-call)

`SLIMDEX_ROOT` (repo), `SLIMDEX_WATCH=1` (auto-reindex on save — use when a
human edits alongside the agent), `SLIMDEX_TERSE=1` (shorter output text),
`SLIMDEX_PARSER` (backend seam; only `regex` ships).

## The economics, so the discipline feels worth it

Measured (one repo, self-measured, directional): skeleton vs full read ~33×
fewer tokens; a navigation task ~8× fewer; a whole session ~29% cheaper — the
session number is smaller because fixed overhead (system prompt, tool defs)
dominates and slimdex only shaves the file-reading slice. The discipline above
is what decides whether you land near the 33× or near zero: the tools cannot
save tokens that a whole-file read spends anyway.
