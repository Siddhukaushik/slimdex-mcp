# codeglance-mcp

A local [MCP](https://modelcontextprotocol.io) server that helps coding agents
**retrieve code narrowly** instead of reading whole files into context. An agent
asks CodeGlance for a specific outline, line range, symbol body, or reference
list, rather than loading a file to find one thing.

> **Status: pre-1.0, personal project.** It works on the repos it has been run
> against, but it has not been published, packaged, or validated broadly. Read
> [What's actually verified](#whats-actually-verified) before relying on it.

| Tool | What it returns |
|------|-----------------|
| `index_repo` | Builds/refreshes a persistent symbol + import index; only changed files re-parse |
| `outline_file` | Declarations of one file with line numbers |
| `get_file_skeleton` | Signatures with bodies elided, nesting preserved |
| `read_lines` | One line range |
| `get_symbol_context` | One function/class body ±2 lines, capped by `maxLines` |
| `search_code` | `path:line:col` + the matching line with caret highlight; `limit`/`offset`/cursor pagination |
| `find_definition` | Definition site(s) of a symbol as `path:line:col` |
| `search_symbols` | Fuzzy symbol-name lookup, ranked exact→prefix→substring→subsequence |
| `find_references` | Textual references as `path:line:col` + enclosing function |
| `get_context` | One call: opt-in definition / signature / callers / imports / dependents, budgeted |
| `repo_map` | Dir-level file/line/symbol counts; `path:` drills into a dir's largest files |
| `changed_files` | Changed files + which symbols each hunk lands in |
| `dep_graph` | `imports` / `dependents` / a Mermaid diagram (`root`+`depth` BFS) |
| `stats` | Per-tool call counts and response sizes, in characters |
| `batch` | Runs several calls in one request |
| `memory_save/search/list/delete` | Durable notes in `.codeglance/memory.json` |

The retrieval guidance below also ships in the server's MCP `instructions`, so
clients inject it into the model's context automatically.

### Recommended agent flow

`get_context("Foo")` first — it aims to answer "what is this, who calls it, what
does it depend on" in one response. Drop to `get_symbol_context` for one body,
`get_file_skeleton` for a file's shape, and `read_lines` when you need exact
source. Use `batch` to bundle several lookups. Every search tool takes `limit`
(default 20) and `offset`.

**Response budgeting:** `get_context` sections are opt-in via `include`, callers
are capped by `callerLimit`, and the response is bounded by `maxChars`. Every cap
that trips prints an explicit notice (`showing 3 of 68`,
`truncated at maxChars=...`) rather than dropping data silently.
`get_symbol_context` caps its span with `maxLines` the same way.

### Config: `<root>/.codeglance.json` (optional)

```json
{
  "ignoreDirs": ["fixtures", "snapshots"],
  "extensions": [".astro", ".vue"],
  "exclude": ["generated/", "legacy/vendor"],
  "maxFileBytes": 2000000
}
```

Merged on top of the built-in ignore list (`node_modules`, `dist`, `.venv`, …).
`index_repo` echoes what it loaded and warns about unknown keys, wrong types, or
invalid JSON, so a typo'd config isn't silently indistinguishable from none.

### How the token saving works

There's no compression trick. The saving is behavioral: these tools let an agent
retrieve outlines, ranges, and locations instead of whole files, and the
persistent index means repeat lookups hit a cached query rather than a re-read.

**Measured once, on one repository** (2026-07-21, against a ~50-file JS project):

| Scope | Without | With | Delta |
|---|---|---|---|
| Skeleton vs. full read of a 405-line file | ~5,400 tok | ~160 tok | ~33× |
| One real task ("how are charts populated?") | ~7,000 tok | ~860 tok | ~8× |
| Whole session, same task both ways (`/status`) | $0.27 | $0.21 | ~29% cheaper |

The per-file number is large and the per-session number is small **because they
measure different scopes**. A session's cost is mostly fixed overhead — system
prompt, tool definitions, project files — that CodeGlance doesn't touch. It only
shaves the file-reading slice, so the whole-session saving is diluted. The ~29%
is the figure that reaches the bill.

**Treat these as one data point, not a benchmark.** Single repo, single task, one
A/B run each, self-measured, no repetitions or variance. Your mileage depends
heavily on whether your agent actually reaches for the narrow tools instead of
falling back to reading files — which varies by client and model. The method is
repeatable if you want to check it: run the same task in two fresh sessions, one
instructed to use only CodeGlance and one instructed to avoid it, and compare
`/status` cache-write.

---

## What's actually verified

Being explicit, since the rest of this README is easy to over-read.

**Covered by the unit suite** (47 tests, 6 files — `npm test`):

- Symbol extraction across JS/TS (incl. class and object-literal methods),
  Python, Go, Rust, Java/C#, and comment skipping — `symbols.test.ts`
- Import extraction for JS `import`/`require`/`export-from`, Python, Rust
- Block extraction, brace-scoped and indentation-scoped, with string/comment
  awareness (quotes, templates, `//`, `/* */`, full-line `#`) — `extractBlock.test.ts`
- Import resolution, external-module classification, reverse-edge dependents,
  Mermaid emission, and root-BFS depth scoping — `graph.test.ts`
- Search match format, pagination without overlap, per-line occurrence counting,
  exact totals, regex escaping/rejection — `search.test.ts`
- Opaque cursor round-tripping and malformed-cursor rejection; parser-backend
  fallback — `pagination.test.ts`
- Outline declaration detection vs. control flow — `outline.test.ts`
- `get_symbol_context` `maxLines` budgeting and truncation notice

Note these test the underlying functions, not the MCP tool handlers that wrap
them. CI runs the build and suite on Ubuntu + Windows, Node 20 and 22.

**Exercised only by the end-to-end smoke test** (`npm run smoke` — asserts only
that the server starts and the tool returns something, never that the output is
correct): `index_repo`, `repo_map`, `search_code`, `search_symbols`,
`changed_files`, `memory_save`, `memory_list`, `stats`.

**No test coverage of any kind:** `read_lines`, `get_file_skeleton`,
`find_definition`, `find_references`, `get_context`, `dep_graph`, `batch`,
`memory_search`, `memory_delete`, file watching (`src/watch.ts`), and
`.codeglance.json` config loading. Several of these sit on unit-tested
foundations, but the tools themselves are only manually exercised and will
regress silently.

**Verified by inspection:** `src/` contains no network calls — no code leaves
your machine. This one you can check yourself:
`grep -rE "fetch\(|https?://|axios|http\.request" src/`.

## Known limitations

- Symbol extraction is **regex-based and heuristic**, not a parser or LSP. It can
  miss unusual declarations, and `find_references` is a **textual** match that may
  include same-named but unrelated identifiers.
- Block extraction is string- and comment-aware, but an *inline* Python `#`
  comment containing a brace can still confuse it (`#` is also the JS
  private-field sigil, so it can't be stripped blindly).
- `changed_files` attributes a hunk to the **nearest preceding declaration** —
  right for a normal function body, approximate for code between declarations.
  Treat it as blast radius, not a call graph.
- `search_code` reports an exact total but stops at an internal scan cap on very
  large result sets, printing `N+ (scan cap reached)` rather than a confident
  wrong number.
- Language support is uneven: JS/TS is the best-covered, C-family and Ruby are
  the thinnest.
- For LSP-grade precision you'd swap the parser for tree-sitter or a language
  server. `src/parser.ts` is the seam: a `Parser` interface selected by
  `CODEGLANCE_PARSER`, with the regex parser as the only implementation that
  ships. A tree-sitter backend would drop in there without touching any tool or
  the index format. It is **not built** — per-language grammars trade away the
  "installs instantly, runs offline, zero config" property.

## Deliberately not built

Ideas evaluated and rejected, with reasoning — these are design opinions, not
measured results:

- **Symbol-ID dictionaries (`S42` → path)** — MCP has no client-side expansion
  layer, so the model receives an opaque token it must spend another call to
  resolve.
- **Token-budget managers / cost estimators** — `chars/4` estimates are
  unreliable across tokenizers, and auto-compressing on a bad estimate can drop
  data the model needed.
- **Delta / "already-sent, see response #5" caching** — after context compaction
  the earlier payload is gone, so the reference resolves to nothing.
- **Embeddings / semantic search** — large dependency footprint; possible future
  optional flag, not a default.

---

## Install

**Not published to npm.** There is no `npx codeglance-mcp`. Build from source:

```bash
git clone https://github.com/Siddhukaushik/codeglance-mcp
cd codeglance-mcp
npm install
npm run build      # produces dist/index.js
npm test           # vitest unit suite
```

Verify it runs end to end against a repo:

```bash
npm run smoke                                # this repo
node smoke-test.mjs "C:/path/to/some/repo"   # any other
```

### Environment variables

| Var | Effect |
|-----|--------|
| `CODEGLANCE_ROOT` | Repo to index (or pass as the first CLI arg; defaults to cwd) |
| `CODEGLANCE_WATCH` | Set to `1` to auto-reindex on file save (native watcher, no deps; untested) |
| `CODEGLANCE_PARSER` | Parser backend; only `regex` exists today |

## The persistent cache

Per repository, CodeGlance writes to `<repo>/.codeglance/`:

- `index.json` — the code index (mtime-invalidated per file)
- `memory.json` — saved memory facts
- `stats.json` — per-tool usage counters

Add `.codeglance/` to that repo's `.gitignore` if you don't want to commit it.

---

## Wiring it into MCP clients

MCP is a shared standard, so the same server should plug into any MCP-capable
client. The project root is passed via `CODEGLANCE_ROOT` (or as the first CLI
arg).

**Only Claude Code and Claude Desktop have actually been run.** The others below
are the standard config shape for each client, written from their documented
format — they are untested here and may need adjustment.

Replace `<ABS_PATH>` with your build output, e.g.
`C:\path\to\codeglance-mcp\dist\index.js`, and `<REPO>` with the repo to index.

### Claude Code (CLI) — tested
```bash
claude mcp add codeglance --env CODEGLANCE_ROOT=<REPO> -- node <ABS_PATH>
```

### Claude Desktop — tested
`%APPDATA%\Claude\claude_desktop_config.json`
```json
{
  "mcpServers": {
    "codeglance": {
      "command": "node",
      "args": ["<ABS_PATH>"],
      "env": { "CODEGLANCE_ROOT": "<REPO>" }
    }
  }
}
```

### Cursor — untested
`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)
```json
{
  "mcpServers": {
    "codeglance": {
      "command": "node",
      "args": ["<ABS_PATH>"],
      "env": { "CODEGLANCE_ROOT": "${workspaceFolder}" }
    }
  }
}
```

### Windsurf — untested
`~/.codeium/windsurf/mcp_config.json` — same `mcpServers` shape as Cursor.

### VS Code (Copilot / MCP) — untested
`.vscode/mcp.json`
```json
{
  "servers": {
    "codeglance": {
      "command": "node",
      "args": ["<ABS_PATH>"],
      "env": { "CODEGLANCE_ROOT": "${workspaceFolder}" }
    }
  }
}
```

### Cline (VS Code extension) — untested
Cline settings → MCP Servers → add:
```json
{
  "codeglance": {
    "command": "node",
    "args": ["<ABS_PATH>"],
    "env": { "CODEGLANCE_ROOT": "<REPO>" }
  }
}
```

### Zed — untested
`settings.json` → `context_servers`
```json
{
  "context_servers": {
    "codeglance": {
      "command": { "path": "node", "args": ["<ABS_PATH>"], "env": { "CODEGLANCE_ROOT": "<REPO>" } }
    }
  }
}
```

> For clients that expose the workspace folder (Cursor, VS Code),
> `${workspaceFolder}` keeps CodeGlance pointed at the repo you have open.

## Typical agent workflow

1. `index_repo` once at the start (faster on subsequent runs).
2. `repo_map` → get the lay of the land.
3. `outline_file` on a file of interest → pick line ranges.
4. `read_lines` for just those ranges.
5. `find_definition` / `find_references` / `dep_graph` to navigate.
6. `memory_save` decisions and gotchas so the next session starts informed.

## License

MIT © 2026 Kael VK Inc. (Business Number 751569161 RC0001) — see [LICENSE](LICENSE).

Provided as is, with no warranty and no support. If it doesn't build, doesn't
run, or doesn't work on your setup, that's yours to carry — see the disclaimer
in the license.
