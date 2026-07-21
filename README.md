# leanctx-mcp

A local [MCP](https://modelcontextprotocol.io) server that helps coding agents
**spend fewer tokens** on a codebase. Instead of reading whole files into the
model's context, an agent asks leanctx for exactly what it needs:

| Tool | What it returns | Why it's cheaper |
|------|-----------------|------------------|
| `index_repo` | Builds/refreshes a persistent symbol + import index | Reused across sessions; only changed files re-parse |
| `outline_file` | Declarations of one file with line numbers | A map, not the body — hundreds of tokens vs thousands |
| `get_file_skeleton` | Signatures with bodies elided, nesting preserved | A 2,000-line file becomes a ~50-line map |
| `read_lines` | One line range | Read the 20 lines you need, not the 800-line file |
| `get_symbol_context` | Just a function/class body ±2 lines | ~95% saved vs reading the whole file for one symbol |
| `search_code` | `path:line:col` + the matching line (+ caret highlight) | No file dumps; `limit` + `offset`/opaque-`cursor` pagination; exact totals |
| `find_definition` | Definition site(s) of a symbol as `path:line:col` | Go-to-definition without loading files |
| `search_symbols` | Fuzzy symbol-name lookup, ranked exact→prefix→substring→subsequence | Index-only; finds a half-remembered name without a noisy text search |
| `find_references` | References as `path:line:col` **+ enclosing function** | Lightweight call-hierarchy; locations only |
| `get_context` | **One call**: opt-in definition / signature / callers / imports / dependents, budgeted | Replaces ~5 tool calls with one bounded brief |
| `repo_map` | Dir-level file/line/symbol counts; `path:` drills into a dir's largest files | Orient in one small response |
| `changed_files` | Changed files + **which symbols each hunk lands in** | Session start on a dirty repo without the patch in context |
| `dep_graph` | `imports` / `dependents` / a Mermaid diagram (`root`+`depth` BFS) | Graph notation compresses relationships far better than JSON |
| `stats` | Per-tool call counts and response sizes | Shows which tool actually produces your context |
| `batch` | Runs several calls in one request | Cuts per-call MCP protocol overhead |
| `memory_save/search/list/delete` | Durable notes in `.leanctx/memory.json` | Persistent memory across restarts |

The retrieval discipline below is also shipped in the server's MCP `instructions`,
so every client injects it into the model's context automatically — it isn't
guidance that only lives in this README.

### Recommended agent flow (max token savings)

`get_context("Foo")` first — it usually answers "what is this, who calls it, what
does it depend on" in a single response. Drop to `get_symbol_context` for one
body, `get_file_skeleton` for a file's shape, and `read_lines` only when you need
exact source. Use `batch` to bundle several lookups. Every search tool takes
`limit` (default 20) and `offset`.

**Response budgeting** (so the aggregator never becomes the token hog):
`get_context` sections are opt-in via `include`, callers are capped by
`callerLimit`, and the whole response is bounded by `maxChars` — every cap that
trips prints an explicit notice (`showing 3 of 68`, `truncated at maxChars=...`),
never a silent drop. `get_symbol_context` caps its span with `maxLines` the same
way. This directly follows the peer-review guidance: skip model-specific token
*estimation*, but never skip deterministic response *budgeting*.

### Config: `<root>/.leanctx.json` (optional)

```json
{
  "ignoreDirs": ["fixtures", "snapshots"],
  "extensions": [".astro", ".vue"],
  "exclude": ["generated/", "legacy/vendor"],
  "maxFileBytes": 2000000
}
```

Merged on top of the built-in ignore list (`node_modules`, `dist`, `.venv`, …),
so vendor/build dirs never blow up your context. `index_repo` echoes what it
loaded and warns about unknown keys, wrong types, or invalid JSON — a typo'd
config is never silently indistinguishable from having none.

### How the token saving actually works

There's no magic compression. The saving is behavioral: these tools let the
agent **retrieve narrowly** (outlines, ranges, locations) instead of the usual
"read the whole file to find one thing." The persistent index means repeat
lookups cost a cached query rather than a re-read. That's the entire trick, and
it's honest — no code is sent to any third party, everything runs locally.

### Honest limitations

- Block extraction (used by `get_symbol_context` / `get_context`) counts braces
  **string- and comment-aware**: braces inside `"..."`, `'...'`, backtick
  templates, `//` and `/* */` comments, and full-line `#` comments are ignored.
  Known gap: an *inline* Python `#` comment containing a brace can still
  confuse it (`#` is also the JS private-field sigil, so it can't be stripped
  blindly).
- Symbol extraction is **regex-based and heuristic**, not a full parser or LSP.
  It supports JS/TS (including class and object-literal methods), Python, Go,
  Rust, Java/C#, Ruby, and common C-family syntax. It can miss unusual
  declarations and `find_references` is a *textual* match (may include
  same-named but unrelated identifiers).
- `changed_files` attributes a hunk to the **nearest preceding declaration**,
  which is right for a normal function body and approximate for code between
  declarations. Treat it as blast radius, not a call graph.
- `search_code` counts every occurrence on a line and reports an exact total,
  but stops at an internal scan cap on very large result sets — when that
  happens the total is printed as `N+ (scan cap reached)` rather than a
  confident wrong number.
- For LSP-grade precision you'd swap the parser for tree-sitter or a real
  language server. `src/parser.ts` is the seam for exactly this: a `Parser`
  interface selected by `LEANCTX_PARSER`, with the regex parser as the default
  implementation. A tree-sitter backend drops in there without touching any tool
  or the index format. It's deferred (not shipped) because per-language grammars
  trade away the "installs instantly, runs offline, zero config" property that is
  the whole point — deliberate, per the design notes, not an oversight.

### Deliberately NOT built (and why)

Several popular "token-saving" ideas were evaluated and rejected because they
don't actually work under MCP's execution model:

- **Symbol-ID dictionaries (`S42` → path)** — MCP has no client-side expansion
  layer, so the model just receives an opaque token it must spend another call
  to resolve. Net negative.
- **Token-budget managers / cost estimators** — `chars/4` estimates are
  unreliable across tokenizers; auto-compressing on a bad estimate silently
  drops data the model needed.
- **Delta / "already-sent, see response #5" caching** — after context
  compaction the earlier payload is gone, so the reference resolves to nothing.
- **Embeddings / semantic search** — 100 MB+ of dependencies for a marginal
  win; kept as a future optional flag, not a default.

---

## Install

Once published to npm, no build step or checkout is needed — MCP clients can run
it on demand:

```jsonc
"command": "npx", "args": ["-y", "leanctx-mcp"]
```

### Or build from source

```bash
cd leanctx-mcp
npm install
npm run build      # produces dist/index.js
npm test           # vitest unit suite
```

The tests pin down the heuristics everything else rests on — symbol extraction,
block detection, search counting, import resolution — because those regress
silently: a missing regex rule doesn't throw, it just returns fewer symbols.

Verify it runs end to end against any repo:

```bash
npm run smoke                              # this repo
node smoke-test.mjs "C:/path/to/some/repo" # any other
```

### Environment variables

| Var | Effect |
|-----|--------|
| `LEANCTX_ROOT` | Repo to index (or pass as the first CLI arg; defaults to cwd) |
| `LEANCTX_WATCH` | Set to `1` to auto-reindex on file save (native watcher, no deps) |
| `LEANCTX_PARSER` | Parser backend; only `regex` ships today (tree-sitter is a documented future slot) |

## The persistent cache

Per repository, leanctx writes to `<repo>/.leanctx/`:

- `index.json` — the code index (mtime-invalidated per file)
- `memory.json` — your saved memory facts

Add `.leanctx/` to that repo's `.gitignore` if you don't want to commit it.

---

## Wiring it into IDEs / LLM clients

MCP is a shared standard, so the **same server** plugs into every MCP-capable
client. The project root is passed via the `LEANCTX_ROOT` env var (or as the
first CLI arg). Point it at whatever repo you want indexed.

Replace the path below with your build output:
`C:\Users\vvkau\Desktop\leanctx-mcp\dist\index.js`

### Claude Desktop
`%APPDATA%\Claude\claude_desktop_config.json`
```json
{
  "mcpServers": {
    "leanctx": {
      "command": "node",
      "args": ["C:\\Users\\vvkau\\Desktop\\leanctx-mcp\\dist\\index.js"],
      "env": { "LEANCTX_ROOT": "C:\\Users\\vvkau\\Desktop\\finance-tracker" }
    }
  }
}
```

### Claude Code (CLI)
```bash
claude mcp add leanctx --env LEANCTX_ROOT=C:\\Users\\vvkau\\Desktop\\finance-tracker -- node C:\\Users\\vvkau\\Desktop\\leanctx-mcp\\dist\\index.js
```

### Cursor
`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)
```json
{
  "mcpServers": {
    "leanctx": {
      "command": "node",
      "args": ["C:\\Users\\vvkau\\Desktop\\leanctx-mcp\\dist\\index.js"],
      "env": { "LEANCTX_ROOT": "${workspaceFolder}" }
    }
  }
}
```

### Windsurf
`~/.codeium/windsurf/mcp_config.json` — same `mcpServers` shape as Cursor.

### VS Code (Copilot / MCP)
`.vscode/mcp.json`
```json
{
  "servers": {
    "leanctx": {
      "command": "node",
      "args": ["C:\\Users\\vvkau\\Desktop\\leanctx-mcp\\dist\\index.js"],
      "env": { "LEANCTX_ROOT": "${workspaceFolder}" }
    }
  }
}
```

### Cline (VS Code extension)
Cline settings → MCP Servers → add:
```json
{
  "leanctx": {
    "command": "node",
    "args": ["C:\\Users\\vvkau\\Desktop\\leanctx-mcp\\dist\\index.js"],
    "env": { "LEANCTX_ROOT": "C:\\Users\\vvkau\\Desktop\\finance-tracker" }
  }
}
```

### Zed
`settings.json` → `context_servers`
```json
{
  "context_servers": {
    "leanctx": {
      "command": { "path": "node", "args": ["C:\\Users\\vvkau\\Desktop\\leanctx-mcp\\dist\\index.js"], "env": { "LEANCTX_ROOT": "C:\\Users\\vvkau\\Desktop\\finance-tracker" } }
    }
  }
}
```

> Tip: for clients that expose the workspace folder (Cursor, VS Code), use
> `${workspaceFolder}` so leanctx always indexes the repo you have open.

## Typical agent workflow

1. `index_repo` once at the start (fast on subsequent runs).
2. `repo_map` → get the lay of the land.
3. `outline_file` on a file of interest → pick line ranges.
4. `read_lines` for just those ranges.
5. `find_definition` / `find_references` / `dep_graph` to navigate.
6. `memory_save` decisions and gotchas so the next session starts informed.

## License

MIT
