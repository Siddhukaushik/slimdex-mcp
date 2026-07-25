# Slimdex Agent Brain

**This file deliberately does NOT repeat the tool rules.** The slimdex server
injects those into your context automatically on every turn (session opener,
question→tool routing, the follow-through rule, memory discipline, editing).
Duplicating them here would cost tokens in a file whose entire purpose is saving
them.

If your client does NOT surface a server's `instructions` (Claude Code, Claude
Desktop and Codex all do), you are missing the tool rules — use the full
`docs/agent-brain.md` from the slimdex-mcp repo instead of this file. That is also
the human-readable reference if you just want to read the whole thing.

What follows is only what the server instructions do *not* carry.

## Prime directive
Return the answer, not the haystack. But when you genuinely can't be sure without
more context, get it — a wrong edit is more expensive than any read.

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
