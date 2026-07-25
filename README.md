# slimdex-mcp

A local [MCP](https://modelcontextprotocol.io) server that helps coding agents
**retrieve code narrowly** instead of reading whole files into context. An agent
asks Slimdex for a specific outline, line range, symbol body, or reference
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
| `get_symbol_context` | One function/class body ±2 lines, capped by `maxLines`; `names:[...]` pulls several bodies in one call |
| `search_code` | `path:line:col` + the matching line with caret highlight; `limit`/`offset`/cursor pagination |
| `find_definition` | Definition site(s) of a symbol as `path:line:col` |
| `search_symbols` | Fuzzy symbol-name lookup, ranked exact→prefix→substring→subsequence |
| `search_intent` | Natural-language query ranked over symbols by BM25 (no embeddings) — find code by what it does |
| `context_pack` | One call: ranks a topic's symbols, shows how they connect, and bundles the top bodies under a budget — the whole exploration in one round-trip |
| `find_references` | Textual references as `path:line:col` + enclosing function |
| `find_tests` | Of the references to a symbol, which live in test files — or a warning that none do |
| `replace_symbol` | Overwrite a symbol's body addressed by name (no re-sent old code); snapshots first, re-indexes after |
| `get_context` | One call: opt-in definition / signature / callers / imports / dependents, budgeted |
| `repo_map` | Dir-level file/line/symbol counts; `path:` drills into a dir's largest files |
| `changed_files` | Changed files + which symbols each hunk lands in |
| `dep_graph` | `imports` / `dependents` / a Mermaid diagram (`root`+`depth` BFS) |
| `stats` | Per-tool call counts and response sizes, in characters |
| `batch` | Runs several calls in one request |
| `recap` | Prior sessions' activity, reconstructed automatically from the server's tool-call journal — works even when nothing was saved |
| `brief` | One-shot session opener: repo summary + journal-derived focus + saved conclusions checked against the live index (✓ live / ⚠ maybe stale) |
| `digest_save` / `digest_get` | Store a compact repo architecture cheat-sheet once; read it back with a per-covered-file freshness verdict, so the next session skips re-exploring |
| `snapshot` | Copies uncommitted files into `.slimdex/snapshots/` (also auto-runs hourly via `index_repo` on a dirty tree) — insurance against accidental resets, not a substitute for committing |
| `memory_save/search/list/delete` | Durable notes in `.slimdex/memory.json` |

The retrieval guidance below also ships in the server's MCP `instructions`, so
clients inject it into the model's context automatically.

### Recommended agent flow

`brief` first, at the very start of a session — one call that reports what the
repo is, where recent sessions were digging, and which saved conclusions still
match the code (stale ones flagged), so a fresh chat starts informed instead of
blank. Then `get_context("Foo")` to answer "what is this, who calls it, what does
it depend on" in one response. To understand a whole *area* rather than one
symbol, `context_pack("how does auth work")` runs the entire exploration
server-side and hands back a single bounded bundle — the relevant symbols, how
they connect, and the top bodies — so you spend one call and one transcript
entry instead of ten. Don't know the name, only what it does? —
`search_intent("parse the config file")` ranks symbols by intent with BM25, no
embeddings. Drop to `get_symbol_context` for one body (it flags itself if the file
drifted from the index, so you don't re-read to check), `get_file_skeleton` for a
file's shape, and `read_lines` when you need exact source. Before editing a
symbol, `find_tests` on it to see what covers it; to
rewrite a whole function, `replace_symbol` (you send only the new body — the old
code isn't re-sent just to locate the edit). Use `batch` to bundle several
lookups. Every search tool takes `limit` (default 20) and `offset`.

**Response budgeting:** `get_context` sections are opt-in via `include`
(default: definition, signature, callers, imports — add `body` or `dependents`
explicitly), callers are capped by `callerLimit`, and the response is bounded
by `maxChars` (default 12,000). Every cap that trips prints an explicit notice
(`showing 3 of 68`, `truncated at maxChars=...`) rather than dropping data
silently. `get_symbol_context` caps its span with `maxLines` the same way, and
`memory_list` returns the newest 50 facts unless told otherwise, as ~150-char
previews rather than whole bodies (`memory_get ids:[...]` expands them,
`full:true` dumps everything). On an 18-fact store that is the difference
between ~4,100 and ~18,600 chars in the call every session opens with.

### Config: `<root>/.slimdex.json` (optional)

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

Two later sessions, run by different models on different repo shapes, added
real-world numbers to the original report:

**Multi-file web app, bug-fix session (GPT-5.3-Codex).**
19 credits reported with slimdex; the model's own estimate for the same scope
without it: 45–70 credits. Math: 19/45 → 19/70 ≈ **58–73% cheaper**. The
counterfactual is the model's estimate, not a measured A/B — directional.

**Single giant file (folio-app: one 6,200-line, 313 KB `app.js`).**
Slimdex's own stats: ~34,000 chars across 8 calls ≈ 9–10k tokens — one
skeleton (213 signatures), then bodies of only ~12 relevant functions, 9 of
them fetched in a single `get_symbol_context names:[...]` call. The naive
path: 313 KB ≈ 78–85k tokens across 3–4 forced full reads. Math: ~10k vs
~80k ≈ **~70k tokens saved, an 85–90% reduction** on exploration. The bug's
diagnosis (an export path with no matching import path) was visible from the
skeleton's signatures before a single body was opened.

Together they sketch the scaling law: **the saving scales with how much
irrelevant code the naive path would drag in.** One giant file is the best
case; a normal repo lands around half to two-thirds cheaper; a repo of tiny
files breaks even. Same standing caveats as everything here: stats count
chars, not tokens (÷3.5–4), and single sessions are evidence, not benchmarks.


### The realistic whole-workflow band

The figures above are single-scenario *exploration* numbers — the best case,
where the naive path would have dragged in the most irrelevant code. Averaged
across a whole real workday, not just the exploration slice, the band settles
lower:

- **~55–60%** on navigation-heavy work — reading and understanding a codebase,
  where narrow retrieval replaces whole-file reads most often.
- **~45%** on output-heavy work — churning out new code, where more of the cost
  is generation the server doesn't touch (though `replace_symbol` now shaves the
  write side too).
- **~50% averaged** over regular day-to-day use. The saving compounds the more
  sessions run through it, because `brief` and memory mean each new chat starts
  informed instead of re-deriving the repo from zero.

Use it regularly across sessions in your IDE for the best of this.

**Treat these as one data point, not a benchmark.** Single repo, single task, one
A/B run each, self-measured, no repetitions or variance. Your mileage depends
heavily on whether your agent actually reaches for the narrow tools instead of
falling back to reading files — which varies by client and model. The method is
repeatable if you want to check it: run the same task in two fresh sessions, one
instructed to use only Slimdex and one instructed to avoid it, and compare
`/status` cache-write.

---

## What's actually verified

Being explicit, since the rest of this README is easy to over-read.

**Covered by the unit suite** (`npm test` runs 224 tests across 23 files):

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
- `.slimdex.json` loading: every key applied through a real index build, plus
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
- Test-file detection across JS/TS/Python/Go/Ruby/Java/C# conventions, with
  Windows separators normalized and ordinary source (`latest.ts`, `Contest.java`)
  not misflagged — `testlink.test.ts`
- The write side: replacing a symbol's block, trailing code preserved, and CRLF
  vs LF line endings kept so an edit isn't reflowed into a whole-file diff —
  `edit.test.ts`
- Memory staleness: a fact is marked live when it names a symbol/file that still
  exists, flagged stale only when every code mention is gone, and left unflagged
  for prose — plus brief composition — `brief.test.ts`
- Intent search: camelCase/snake_case tokenization, and BM25 ranking that surfaces
  a differently-named symbol by its intent words while scoring an unrelated query
  to nothing — `intent.test.ts`
- Freshness: a file newer than its indexed mtime reads as stale (line numbers may
  be off), a matching mtime reads as fresh, and a missing file never cries stale —
  `freshness.test.ts`
- `context_pack` assembly: header + ranked symbols + bodies in one bundle, the
  no-match message, char-budget gating that still guarantees the first body, and
  the symbols-limit cap — `pack.test.ts`
- The architecture digest: covered files modified after the digest read as stale,
  a newer digest reads clean, coverage-scope and directory-prefix filtering, and
  the rendered fresh/stale verdict — `digest.test.ts`

**Covered end to end, through the real MCP server** (`integration.test.ts` spawns
the server over stdio against a temporary fixture repo and asserts on output):
`index_repo`, `repo_map`, `read_lines`, `get_file_skeleton`, `outline_file`,
`get_symbol_context`, `find_definition`, `find_references`, `find_tests` (the hit
and the no-coverage warning), `search_intent` (intent ranking), `context_pack` (one-call
bundle), `digest_save`/`digest_get` (round trip with freshness verdict),
`get_context` (including its `maxChars` cap),
`dep_graph` (imports + mermaid), `batch`, `search_code`, `search_symbols`,
`stats`, `brief`, `replace_symbol` (write-then-query round trip and the
unknown-symbol refusal), the `memory_save/search/list/delete` round trip, the
path-escape guard, and the not-found paths.

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

- [`tool-guide.md`](docs/tool-guide.md) — every tool explained twice
  (technically and in plain words) with an example each, the combined
  workflow, and how mtime-based persistence works
- [`tool-guide.html`](docs/tool-guide.html) — the same guide as a styled,
  self-contained page for the browser
- [`token-savings-report.md`](docs/token-savings-report.md) — the original A/B
  measurement, its method, and how to repeat it
- [`agent-brain.md`](docs/agent-brain.md) — the full operating discipline as a
  readable document
- [`agent-brain-slim.md`](docs/agent-brain-slim.md) — **the one to drop into a
  repo** as CLAUDE.md / AGENTS.md. The server already injects the tool rules on
  every turn, so this carries only what they don't: session hygiene, review
  discipline, honest limits, env knobs. Half the size, nothing lost.

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

`memory_save` writes to `<root>/.slimdex/memory.json`, which outlives the
process — a fact saved in one chat is readable in the next, by a different
client, after a restart. Chat and editor share one store only when both point at
the same `SLIMDEX_ROOT`.

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
  `SLIMDEX_PARSER`, with the regex parser as the only implementation that
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

**Not published to npm.** There is no `npx slimdex-mcp`. Build from source:

```bash
git clone https://github.com/Siddhukaushik/slimdex-mcp
cd slimdex-mcp
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
| `SLIMDEX_ROOT` | Repo to index (or pass as the first CLI arg; defaults to cwd) |
| `SLIMDEX_WATCH` | Set to `1` to auto-reindex on file save (native watcher, no deps) |
| `SLIMDEX_PARSER` | Parser backend; only `regex` exists today |
| `SLIMDEX_PRETTY` | Set to `1` to restore the verbose, human-aligned rendering: longer headers and column padding in `search_code`, `find_definition`, `search_symbols`, `find_references`, `repo_map`, `read_lines`, `outline_file`. Terse is the **default** — that padding is context the model pays for in every later turn. `SLIMDEX_TERSE=0` does the same thing. |
| `SLIMDEX_PROFILE` | `lean` advertises 15 tools instead of 29, cutting the tool schemas re-sent on every turn from ~22,300 to ~12,600 chars. The other 14 (`get_context`, `changed_files`, `find_tests`, `dep_graph`, `outline_file`, `search_symbols`, `recap`, `memory_list`, `memory_search`, `memory_delete`, `digest_save`, `digest_get`, `snapshot`, `stats`) still work and are called through `batch` — and the server instructions name them under this profile, so the model is told what is batch-only rather than left to discover it. Default `full`. |
| `SLIMDEX_NO_DEDUPE` | Set to `1` to disable repeat-response suppression (a second identical `read_lines`/`get_file_skeleton`/`outline_file` on an unchanged file answers with a pointer to the earlier call instead of the body; a third identical call re-emits in full). |

## The persistent cache

Per repository, Slimdex writes to `<repo>/.slimdex/`:

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
client. The project root is passed via `SLIMDEX_ROOT` (or as the first CLI
arg).

**Only Claude Code and Claude Desktop have actually been run.** The others below
are the standard config shape for each client, written from their documented
format — they are untested here and may need adjustment.

Replace `<ABS_PATH>` with your build output, e.g.
`C:\path\to\slimdex-mcp\dist\index.js`, and `<REPO>` with the repo to index.

**No tuning required.** The savings that matter are on by default in every
client: memory facts list as previews, responses are terse, an identical re-read
of an unchanged file answers with a pointer instead of the body, and several
symbol edits go in one call. The env vars below are for opting *out*, or for
`lean` — which trades a further ~8,700 chars/turn against routing a third of the
tools through `batch`, so it is deliberately not the default.

### Claude Code (CLI) — tested
```bash
claude mcp add slimdex --env SLIMDEX_ROOT=<REPO> -- node <ABS_PATH>
```

### Claude Desktop — tested
`%APPDATA%\Claude\claude_desktop_config.json`
```json
{
  "mcpServers": {
    "slimdex": {
      "command": "node",
      "args": ["<ABS_PATH>"],
      "env": { "SLIMDEX_ROOT": "<REPO>" }
    }
  }
}
```

### Codex CLI — tested
`~/.codex/config.toml`
```toml
[mcp_servers.slimdex]
command = 'C:\Program Files\nodejs\node.exe'
args = ['<ABS_PATH>']
startup_timeout_sec = 30
```
Registered globally like this, slimdex attaches to every Codex task and uses
that task's working directory as the repo root — no `SLIMDEX_ROOT` needed. Codex
launches the server with a restricted environment, so give `command` an absolute
path to node rather than relying on `PATH`.

### Cursor — untested
`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)
```json
{
  "mcpServers": {
    "slimdex": {
      "command": "node",
      "args": ["<ABS_PATH>"],
      "env": { "SLIMDEX_ROOT": "${workspaceFolder}" }
    }
  }
}
```

### Windsurf — tested
`~/.codeium/windsurf/mcp_config.json` — same `mcpServers` shape as Cursor.

### VS Code (Copilot / MCP) — tested
`.vscode/mcp.json`
```json
{
  "servers": {
    "slimdex": {
      "command": "node",
      "args": ["<ABS_PATH>"],
      "env": { "SLIMDEX_ROOT": "${workspaceFolder}" }
    }
  }
}
```

### Cline (VS Code extension) — tested
Cline settings → MCP Servers → add:
```json
{
  "slimdex": {
    "command": "node",
    "args": ["<ABS_PATH>"],
    "env": { "SLIMDEX_ROOT": "<REPO>" }
  }
}
```

### Zed — tested
`settings.json` → `context_servers`
```json
{
  "context_servers": {
    "slimdex": {
      "command": { "path": "node", "args": ["<ABS_PATH>"], "env": { "SLIMDEX_ROOT": "<REPO>" } }
    }
  }
}
```

> For clients that expose the workspace folder (Cursor, VS Code),
> `${workspaceFolder}` keeps Slimdex pointed at the repo you have open.

## Typical agent workflow

1. `index_repo` once at the start (faster on subsequent runs), then `brief` to
   pick up where past sessions left off with stale notes already flagged.
2. `repo_map` → get the lay of the land.
3. `outline_file` on a file of interest → pick line ranges.
4. `read_lines` for just those ranges.
5. `find_definition` / `find_references` / `dep_graph` to navigate.
6. `find_tests` before editing a symbol; `replace_symbol` to rewrite one without
   re-sending its old body.
7. `memory_save` decisions and gotchas so the next session starts informed.

## License

MIT © 2026 Kael VK Inc. (Business Number 751569161 RC0001) — see [LICENSE](LICENSE).

Provided as is, with no warranty and no support. If it doesn't build, doesn't
run, or doesn't work on your setup, that's yours to carry — see the disclaimer
in the license.
