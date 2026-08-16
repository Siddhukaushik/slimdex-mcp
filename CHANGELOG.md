# Changelog

Notable changes per release, with the reasoning — a version number says what
moved, not why it was worth moving.

## 1.1.0 — 2026-08-16

The theme is **built-in tool gravity**: an MCP server publishes tools but cannot
wrap or replace a client's own `Read`/`Edit`/`Write`, and those built-ins are
shorter, always present, and heavily represented in training. Three audit
sessions read "use `replace_symbol`" on every turn and reached for `Edit`
anyway. The same pull explains why `dep_graph`, `find_tests` and `memory_search`
go unused *inside* slimdex: skipping a precaution costs nothing the model can
see — the edit still applies, the file still saves — and the bill arrives later,
as a human re-prompting.

Instructions cannot fix that; they are read once, dozens of turns before the
decision. So this release stops asking the model to choose well, and attaches
each step's value to a call it was already making.

### Added

- **Next-step lines on `get_file_skeleton` and `repo_map`.** The result now ends
  with the exact next call, naming real symbols picked by widest span — the
  bodies a whole-file read would cost the most to reach. Guidance that arrives
  one turn before the decision, and is re-read every turn as part of the
  transcript, rather than sitting in a tool description read at connect time.
  ~90 chars.

- **Impact attached to `get_symbol_context` and `replace_symbol`.** Direct
  dependents and covering tests ride along with the call made right before an
  edit, and with the edit itself:

  ```
  Impact: 3 file(s) reference it (src/index.ts, src/intel.ts +1) · 2 covering test file(s)
  Impact: 1 file(s) reference it (src/index.ts) · ⚠ no covering tests
  ```

  Deliberately **not** a gate. Refusing an edit until `dep_graph` runs would make
  slimdex the only tool in the client with friction, and the model would fall
  back to the built-in `Edit` — handing the write to the one path that cannot be
  seen or measured. Attaching beats the built-ins; gating loses to them.
  One bounded scan, single-symbol reads only. `SLIMDEX_IMPACT=0` disables.

- **Session recall on the first call.** `brief` exists to open a session with
  what earlier ones concluded, and the journal shows sessions opening with
  `repo_map` or `search_code` instead. A tool that must be *remembered* cannot
  fix a problem caused by not remembering, so recall now rides on whatever the
  first call happens to be — previews plus an id, once per process, silent when
  nothing was ever saved. `SLIMDEX_RECALL=0` disables.

- **`slimdex_start` prompt.** The MCP prompts primitive was previously unused.
  `instructions` cannot carry a workflow: clients truncate near 2,000 chars and
  slimdex already sends ~1,560, so anything appended silently deletes the tail
  where the memory and editing rules live. A prompt has no such budget and costs
  nothing per turn. `/slimdex_start <issue>` lays out the lifecycle — recall,
  locate, impact, edit by name, save.

- **`npm run gravity`.** The measurement that makes all of the above falsifiable.
  The server never learns that a built-in `Read` happened; the `PreToolUse` hook
  is the only vantage point that can see one. It now keeps a ledger of every
  built-in read/edit/write, merged with the server's own journal and scored on
  **first hop per session** — which tool the model reached for first — because
  totals only reflect whatever it settled into. The report flags its own blind
  spots rather than quoting a flattering rate.

- **Tool annotations** on the 7 state-touching tools (`destructiveHint` on
  `replace_symbol`, `memory_delete`, `install_hook`). Omitted for the 23
  read-only ones: `tools/list` is re-sent every turn, and repeating the spec
  default 23 times would cost schema chars to say nothing.

- **`Dockerfile`** for containerised runs, and `glama.json` for directory
  maintainer verification.

### Fixed

- **The server reported the wrong version.** `SERVER_VERSION` was hardcoded, so
  `1.0.0` announced itself as `v0.9.0` in the MCP handshake. The registration now
  reuses the constant so the two cannot drift.
- **GitHub read the licence as "Other".** A `Business Number` line inside the
  copyright block broke exact-match detection, so the project showed as
  unlicensed on GitHub, npm, and every downstream directory.
- **`memory_delete`'s description** did not say the delete is permanent and
  unsnapshotted — the one destructive tool whose text implied no consequence.

### Honest limits

Every byte cost above is measured on the real server. **None of it is yet proven
to change behaviour** — that is what `npm run gravity` is for. Run sessions
normally, run some with `SLIMDEX_HINTS=0`, and compare first-hop rates.

## 1.0.1 — 2026-08-09

Corrected the version reported in the MCP handshake, and a README that still
said the project was unpublished.

## 1.0.0 — 2026-08-04

First public release: published to npm as `slimdex-mcp` and listed in the
official MCP Registry as `io.github.Siddhukaushik/slimdex-mcp`.
