# codeglance-mcp

A local [MCP](https://modelcontextprotocol.io) server that helps coding agents
**retrieve code narrowly** instead of reading whole files into context. An agent
asks CodeGlance for a specific outline, line range, symbol body, or reference
list, rather than loading a file to find one thing.

> **Status: pre-1.0.** It works on the repos it has been run
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

**Response budgeting:** `get_context` sections are opt-in via `include`
(default: definition, signature, callers, imports — add `body` or `dependents`
explicitly), callers are capped by `callerLimit`, and the response is bounded
by `maxChars` (default 12,000). Every cap that trips prints an explicit notice
(`showing 3 of 68`, `truncated at maxChars=...`) rather than dropping data
silently. `get_symbol_context` caps its span with `maxLines` the same way, and
`memory_list` returns the newest 50 facts unless told otherwise.

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

**Covered by the unit suite** (`npm test` runs 158 tests across 14 files):

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

- String/comment masking and brace-depth tracking — `lexer.test.ts`
- Per-language extraction for all twelve supported languages — `languages.test.ts`
- The index cache returns the same object until the index is rewritten
- `.codeglance.json` loading: every key applied through a real index build, plus
  the failure modes (invalid JSON, unknown keys, wrong types) each producing a
  visible warning instead of silence — `config.test.ts`
- `changed_files` against a real temporary git repository: hunk→symbol
  attribution, untracked files, explicit base refs, and formatting; skips
  cleanly when git isn't installed — `git.test.ts`
- The file watcher, with real fs events: a save is debounced, reindexed, and
  lands in the on-disk index — `watch.test.ts`
- Graph edges beyond imports: name-reference edges for import-less code
  (class→used-class, interface→implementation via dependents, trigger→handler)
  and declarative-wiring edges from repo XML (metadata-binding→class), with
  comment/string mentions excluded and per-build caching — `apexgraph.test.ts`
- The in-memory file cache serves repeats without re-reading and always serves
  fresh content after an on-disk change — `fscache.test.ts`

**Covered end to end, through the real MCP server** (`integration.test.ts` spawns
the server over stdio against a temporary fixture repo and asserts on output):
`index_repo`, `repo_map`, `read_lines`, `get_file_skeleton`, `outline_file`,
`get_symbol_context`, `find_definition`, `find_references`, `get_context`
(including its `maxChars` cap), `dep_graph` (imports + mermaid), `batch`,
`search_code`, `search_symbols`, `stats`, the `memory_save/search/list/delete`
round trip, the path-escape guard, and the not-found paths.

CI runs the build and both suites on Ubuntu + Windows, Node 20 and 22.

**Caveat on the watcher test:** recursive `fs.watch` is platform-dependent, so
`watch.test.ts` degrades to a logged skip on filesystems that never deliver an
event — same behavior as the watcher itself. On Windows, macOS, and current
Linux it asserts the full save→reindex path.

`npm run smoke` still exists but proves only that the pipeline is alive — the
correctness assertions live in `integration.test.ts`.

**Verified by inspection:** `src/` contains no network calls — no code leaves
your machine. This one you can check yourself:
`grep -rE "fetch\(|https?://|axios|http\.request" src/`.

## Longer documentation

In [`docs/`](docs/):

- [`tool-reference.html`](docs/tool-reference.html) — every tool with real
  captured output, the architecture, and the measured comparison
- [`explained-simply.html`](docs/explained-simply.html) — the same in plain
  language, with three end-to-end walkthroughs
- [`token-savings-report.md`](docs/token-savings-report.md) — the original A/B
  measurement, its method, and how to repeat it

## Language coverage

Two measurements, because fixtures alone prove very little.

**Fixtures** — one per language, counting the declarations a developer would
actually navigate to: **65/65 found, 0 false positives**, pinned by
`test/languages.test.ts`.

**Real third-party code** — extraction run over ~11,800 files from several
hundred real packages (React, Babel, Remix, Socket.io, Playwright, Three.js,
Emotion, zod, ajv …) and compared against an independently written heuristic for
what counts as a declaration: **95.9% recall**. Reproduce it yourself:

```bash
npm run audit -- ./node_modules            # or any directory of code you didn't write
```

That number is a floor, not a grade — the truth heuristic counts some
non-declarations, so real recall is a little higher. What it's for is catching
regressions and finding the next real gap.

### About frameworks

Almost nothing that failed the audit was framework-specific. Frameworks add
annotations, decorators and conventions; they rarely invent syntax. Handle the
language and the frameworks come with it — fflib's Application/Domain/Selector/
Service/UnitOfWork layers extract completely (129 declarations) without a single
fflib-aware rule.

The one genuine exception is **test DSLs**. A vitest/jest/mocha/RSpec file often
has no top-level declarations at all, so entire test directories used to index to
nothing. `describe`/`it`/`test` titles are now indexed as kind `test`, which is
what you actually navigate to in a test file.

Framework **semantics** are recovered wherever the reference exists somewhere
in the repo, through two extra edge sources in the graph:

- **Name-reference edges**, for languages that have no import statement (e.g.
  Apex): if one file's code — comments and strings masked out — mentions a
  top-level type defined in another file, that's an edge. This is what makes
  `implements` answerable as "who implements this interface", and links a
  trigger to the handler class it news up.
- **Declarative-wiring edges**: bindings that frameworks keep in configuration
  rather than code (custom-metadata records, flow definitions) usually live in
  the repo as XML with the type name as an element value. Repo XML is scanned
  for known type names — XML comments excluded — and each hit becomes a
  `metadata-file → class` edge, so `dependents` answers "what wires this up".

Both scans are cached per index build and cost nothing on repos without such
files. Pinned by `apexgraph.test.ts`. What no static reader can see is a
binding that exists **only in a live system** — configured in a running org or
database and never retrieved into the repo. If it's not in the repo in any
form, there is no edge to draw; search the type name instead.

| Language | Extensions | What's recognised |
|---|---|---|
| JavaScript / TypeScript | `.js .jsx .mjs .cjs .ts .tsx .vue .svelte` | classes, interfaces, types, enums, functions, top-level arrows, class and object-literal methods |
| Apex | `.cls .trigger` | classes, inner classes, methods (incl. `@AuraEnabled`, `global`, generic returns), triggers |
| Java | `.java` | classes, interfaces, enums, methods, generic methods with a leading `<T>` |
| C# | `.cs` | classes, interfaces, structs, async and generic methods, virtual members |
| Kotlin | `.kt` | classes, data classes, interfaces, `object`, `fun`, `suspend fun` |
| Swift | `.swift` | classes, structs, enums, protocols, `func`, `static func` |
| Python | `.py` | classes, `def`, `async def`, dunder and decorated methods |
| Go | `.go` | funcs, receiver methods, struct and interface types |
| Rust | `.rs` | structs, enums, traits, `fn`, `pub async fn`, impl methods |
| Ruby | `.rb` | classes, modules, `def`, `def self.x`, `attr_accessor/reader/writer` |
| PHP | `.php` | classes, interfaces, traits, methods, functions |
| Scala | `.scala` | classes, case classes, traits, objects, `def` with modifiers |
| C / C++ / Objective-C | `.c .h .cpp .hpp .cc .m .mm` | classes, structs, enums, free functions (incl. K&R braces, pointer returns), `Foo::bar` out-of-class definitions, ctors/dtors, namespaces, function-like `#define` macros, `typedef struct {…} Name`, `@interface`/`@implementation`/`@protocol` |

## Performance

Cold index is a full parse; warm is an mtime check per file. Measured on Windows,
Node 24.

| Repo | Files | Symbols | Cold index | Warm index | Typical query |
|---|---:|---:|---:|---:|---:|
| Salesforce DX org | 56 | 344 | 0.1 s | 15 ms | < 10 ms |
| Java + React app | 356 | 1,713 | 0.42 s | 26 ms | 3–57 ms |
| Synthetic stress | 5,000 | 50,000 | 1.5 s | 0.24 s | 5–22 ms |

The index is held in memory and invalidated by the index file's mtime. Without
that cache every tool call re-read and re-parsed the whole index — about 20 ms of
dead weight per call on the 5,000-file repo, and it grew with the repo.

`find_references` is the slowest tool at scale because it is a textual scan,
not an index lookup — but a literal pre-filter now skips the line-split and
per-line regex for any file whose raw source doesn't contain the searched name,
which on a typical repo is most of them. Scope with `pathPrefix` to cut the
remaining file reads when you know roughly where to look.

File contents are also served from a byte-bounded in-memory LRU (64 MB,
validated by mtime+size per hit), so the second scan of a repo — and the
skeleton→read_lines→context sequence agents actually perform on one file —
costs a `stat()` instead of a read.

## Memory across sessions

`memory_save` writes to `<root>/.codeglance/memory.json`, which outlives the
process — a fact saved in one chat is readable in the next, by a different
client, after a restart. Chat and editor share one store only when both point at
the same `CODEGLANCE_ROOT`.

Nothing is captured automatically: the server never sees your conversation, so
the agent has to decide what's worth keeping. The shipped `instructions` tell it
to read memory first in a new session and to save decisions, constraints and
gotchas as it learns them — but that's guidance to the model, not a guarantee.

## Known limitations

- Symbol extraction is **regex-based and heuristic**, not a parser or LSP. It can
  miss unusual declarations, and `find_references` is a **textual** match that may
  include same-named but unrelated identifiers.
- Symbol and outline extraction now run against a **masked** copy of each line,
  with string and comment contents blanked out, so declaration-shaped prose
  inside a template literal is no longer indexed as code. Declarations are also
  **depth-aware**: a `const x = () => …` or `type X = …` counts only at top
  level, because locals inside a function body are not things anyone navigates
  to. Class methods are still indexed at their nesting depth.
- An *inline* Python `#` comment containing a brace can still confuse block
  extraction (`#` is also the JS private-field sigil, so it can't be stripped
  blindly).
- `changed_files` attributes a hunk to the **nearest preceding declaration** —
  right for a normal function body, approximate for code between declarations.
  Treat it as blast radius, not a call graph.
- `search_code` reports an exact total but stops at an internal scan cap on very
  large result sets, printing `N+ (scan cap reached)` rather than a confident
  wrong number.
- Language support is uneven: JS/TS is the best-covered. C-family and Ruby,
  formerly the thinnest, gained dedicated rules (free functions, `Foo::bar`
  definitions, function-like macros, `attr_*`); the remaining soft spots are
  advanced C++ shapes — templates split across lines, operator overloads.
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
- **A tree-sitter parser backend** — this is the one that would close the
  remaining ~4%, and it was costed rather than hand-waved: `web-tree-sitter` is
  WASM so it needs no native compilation, but the grammars
  (`tree-sitter-wasms`) are **51.7 MB** unpacked against ~4.5 MB for the whole
  current install. Evaluated and declined at 95.9% measured recall, because
  "installs in a second, runs offline, no configuration" is the property this
  server exists to have. `src/parser.ts` remains the seam if that calculus ever
  changes — a backend drops in there without touching a tool or the index
  format.

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
| `CODEGLANCE_WATCH` | Set to `1` to auto-reindex on file save (native watcher, no deps) |
| `CODEGLANCE_PARSER` | Parser backend; only `regex` exists today |
| `CODEGLANCE_TERSE` | Set to `1` for terser response text: shorter headers and no column padding in `search_code`, `find_definition`, `search_symbols`, `find_references`, `repo_map`, `read_lines`. Default output is byte-identical to before. |

## The persistent cache

Per repository, CodeGlance writes to `<repo>/.codeglance/`:

- `index.json` — the code index (mtime-invalidated per file, and discarded
  wholesale when the index format version changes, so a stale index built by an
  older extractor is never reused)
- `memory.json` — saved memory facts
- `stats.json` — per-tool usage counters

The directory ignores itself: a `*` `.gitignore` is written inside it (the
`node_modules/.cache` trick), so it never shows up in `git status` and you don't
have to touch the repo's own `.gitignore`. Delete that inner file if you *want*
to commit the cache.

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
