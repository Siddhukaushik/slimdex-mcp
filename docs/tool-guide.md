# Slimdex tool guide

Every tool the server exposes, explained twice — once technically, once in plain
words — with an example of each, and then how they chain together into a
workflow. All example output comes from running the tools against this very
repository.

The one-sentence pitch: **Slimdex replaces "read the whole file" with narrow
retrieval.** An AI assistant working on your code normally pulls entire files
into its context window to find one function. Slimdex keeps a persistent
index of every symbol and import, and serves small, targeted slices instead.

---

## Group 1 — Orientation: "where am I?"

### `repo_map`

**Technical:** Aggregates the index by directory: file counts, total lines,
symbol counts. Pass `path` to drill into one directory and list its largest
files; `top` caps the list.

**Plain words:** The table of contents of your project. Before opening any
book, glance at the shelf labels.

```
repo_map()
→ src        14 files   2501 lines    79 symbols
  test       12 files   1684 lines   129 symbols
  scripts     1 files     97 lines     2 symbols

repo_map(path: "src", top: 3)
→ the 3 largest files inside src/, with their line counts
```

### `changed_files`

**Technical:** Runs `git diff` (working tree vs HEAD, or vs an explicit
`base` ref) and maps every hunk to the enclosing function/class via the index.
Reports per-file +added/−deleted counts and real A/D/M/R statuses — without
pulling the patch text into context.

**Plain words:** "What did I touch since my last save point, and which
functions live in those touched spots?" — a summary of your edits, not the
edits themselves.

```
changed_files()
→ M src/graph.ts  +75/-0
    touches: function dependents, function toMermaid
  ? src/terse.ts  +32/-0        (? = brand new file)
    touches: function t, function fileHeader
```

### `index_repo`

**Technical:** Builds or incrementally refreshes the persistent index
(symbols + imports) under `.slimdex/index.json`. Uses each file's **mtime**
— the filesystem's "last modified" timestamp — to skip unchanged files: if the
stored mtime equals the current one, the cached entry is reused verbatim; only
changed files are re-parsed. Honors `.slimdex.json` config
(ignoreDirs/extensions/exclude/maxFileBytes).

**Plain words:** Rebuilds the library's card catalog, but only re-catalogs
books that were edited since last time. Every file on disk carries a hidden
timestamp saying when it last changed; matching timestamp = nothing to redo.
That's why re-running it is cheap — treat it like hitting "refresh".

```
index_repo()
→ Indexed 31 files
  parsed: 7   reused(cache): 24   removed: 0
  symbols indexed: 228
```

Seven files had changed since the last run, so only those seven were re-read.
The other 24 were served straight from the cache.

---

## Group 2 — Reading a file without reading the file

### `outline_file`

**Technical:** Declarations with line numbers, no bodies, no signatures'
detail. The cheapest per-file view.

**Plain words:** The chapter list of one book.

```
outline_file(path: "src/store.ts")
→ interface FileEntry     :13
  function loadIndex      :74
  function saveMemory     :119
```

### `get_file_skeleton`

**Technical:** Every declaration's full signature with indentation preserved
and bodies replaced by `… {line}`. A 2,000-line file becomes a readable map at
a fraction of the tokens.

**Plain words:** The book with every chapter's first sentence kept and the
rest of each chapter torn out — you see exactly what's in it and where, without
reading it.

```
get_file_skeleton(path: "src/store.ts")
→ export interface FileEntry … {13}
  export async function loadIndex(root: string): Promise<CodeIndex> … {74}
  export async function saveMemory(root: string, mem: MemoryStore): Promise<void> … {119}
```

### `read_lines`

**Technical:** Returns lines `[start..end]` (1-indexed, inclusive) of one
file. The precise follow-up once an outline/skeleton told you where to look.

**Plain words:** "Open the book to pages 45–60 only."

```
read_lines(path: "src/store.ts", start: 49, end: 60)
→ the 12 lines of the ensureDir function, nothing else
```

---

## Group 3 — Finding things by name

A "symbol" is anything with a name in code: a function, class, method,
interface, variable. These tools answer name-shaped questions from the index,
which is far cheaper and less noisy than text-searching raw files.

### `search_symbols`

**Technical:** Fuzzy name match over the index only (no file reads), ranked
exact > prefix > substring > subsequence. Filterable by `kind` and
`pathPrefix`.

**Plain words:** "I half-remember the name — something like 'loadMem'?" It
checks the card catalog, never the shelves.

```
search_symbols(query: "loadMem")
→ loadMemory   function   src/store.ts:108
```

### `search_intent`

**Technical:** BM25 ranking of every indexed symbol against a natural-language
query. Names are tokenized on camelCase/snake_case boundaries, so the query
words are matched against the *words inside* the name, plus its kind and
filename. No embeddings, no model, no second index — pure lexical scoring over
the symbol table you already have. Scores are explainable term contributions.

**Plain words:** "I don't know what it's called, but it *validates an email*."
This searches by meaning-of-the-name, not spelling — the featherweight version
of semantic search, with nothing to install and nothing to keep in sync.

```
search_intent(query: "validate a user email")
→ src/auth.ts:40   function validateEmail    (3.11)
  src/auth.ts:88   function emailValidator   (2.74)
  src/user.ts:12   method   checkUserAddress (0.91)
```

### `find_definition`

**Technical:** Exact-name lookup in the index → definition site(s) as
`path:line:col` plus kind. Heuristic, not a type-checker.

**Plain words:** "Where is this thing *born*?" — the one place it's declared.

```
find_definition(name: "ensureDir")
→ src/store.ts:49:1   function
```

### `find_references`

**Technical:** Whole-word textual scan for a name across indexed files, each
hit attributed to its enclosing function/class. Not scope-aware — a same-named
identifier in an unrelated file will match too. Scope with `pathPrefix`.

**Plain words:** "Where is this thing *used*?" — every place that mentions it.

```
find_references(name: "ensureDir", pathPrefix: "src")
→ src/store.ts:69:8    (inside loadIndex)
  src/store.ts:114:9   (inside saveMemory)
```

### `find_tests`

**Technical:** Of everything that references a symbol, the subset whose
references live in test files — decided by path convention (`*.test.*`,
`*.spec.*`, `__tests__/`, `test_*.py`, `*_test.go`, `*_spec.rb`, `*Test.java`,
…) or by an enclosing `describe`/`it`/`test` title. Textual, so the same
same-named-identifier caveat as `find_references` applies.

**Plain words:** "If I change this, which tests will catch a break?" — run those
instead of the whole suite. And if the answer is *none*, you learn that before
you edit, not after.

```
find_tests(name: "calculateTax")
→ 2 test reference(s) to "calculateTax" — run these before changing it:
    test/tax.test.ts:12   in test computes GST
    test/tax.test.ts:45   in test rounds correctly
```

### `search_code`

**Technical:** Literal or regex text search over indexed files, returning
`path:line:col` + the matching line. Exact total unless the scan cap trips
(then it says so). Paginated via `limit` + `offset`/`cursor`. Vendor/build
directories are pre-excluded.

**Plain words:** Ctrl+F across the whole project. Use it for *text* ("find
this error message"), not for names — the name tools above are sharper.

```
search_code(pattern: "mtimeMs", pathPrefix: "src/indexer.ts")
→ src/indexer.ts:186:30   if (existing && existing.mtimeMs === stat.mtimeMs) {
  src/indexer.ts:197:7    mtimeMs: stat.mtimeMs,
```

---

## Group 4 — Pulling just the code you need

### `get_symbol_context`

**Technical:** Returns only the body of one symbol plus a few context lines
(`before`/`after`, capped by `maxLines`). Resolve by `name` via the index, or
by explicit `path`+`line`. The single biggest per-lookup token saver.

**Plain words:** "Show me just that one function" — a paragraph, not the book.

```
get_symbol_context(name: "ensureDir")
→ async function ensureDir(root: string): Promise<void> {
    await fs.mkdir(dir(root), { recursive: true });
    ...12 lines total...
  }
```

### `get_context`

**Technical:** One call assembling what would otherwise take four:
definition site, signature, callers (attributed to their enclosing symbol),
imports — with `body` and `dependents` opt-in via `include`. Bounded by
`callerLimit` and `maxChars` with explicit truncation notices.

**Plain words:** The full dossier on one thing: where it lives, what it looks
like, who calls it, what it pulls in — in a single question instead of four.

```
get_context(name: "saveMemory", include: ["definition", "callers"])
→ definition: src/store.ts:119
  signature:  export async function saveMemory(root, mem): Promise<void>
  callers:    memory_save handler (src/index.ts), memory_delete handler (src/index.ts)
```

---

## Group 4b — Writing code back (the output side)

Every other tool here optimizes what the model *reads*. This one optimizes what
it *writes* — output tokens cost roughly 4–5× input, and the biggest avoidable
chunk is re-sending old code to an edit tool just so it can find the spot.

### `replace_symbol`

**Technical:** Overwrites the whole definition block of a symbol — resolved by
`name` via the index (or explicit `path`+`line`) — with `body`. The line range
comes from the same `extractBlock` the read tools use. The file is snapshotted
to `.slimdex/snapshots/` *before* the write, then re-indexed, and the response
reports the new line span. An ambiguous or unknown name is refused, not guessed.

**Plain words:** "Replace this function with that" — you send only the new
version. You never paste the old code back just so a matcher can locate it,
because Slimdex already knows where it lives. There's an automatic backup, and
you're told the new line numbers so you don't have to re-read to check.

```
replace_symbol(name: "calculateTax", body: "export function calculateTax(...) {\n  ...\n}")
→ Replaced calculateTax: lines 40-58 → 40-61 (22 line(s)). snapshot saved
  (.slimdex/snapshots/2026-…); re-indexed, a symbol is present in the new range.
```

---

## Group 5 — How files connect

### `dep_graph`

**Technical:** Queries the internal import graph. `mode:"imports"` — what a
file imports. `mode:"dependents"` — the reverse: what imports it.
`mode:"mermaid"` — a Mermaid diagram, walked BFS outward from `root` by
`depth` hops, or scoped to a path prefix.

**Plain words:** Files borrow from each other. Before changing a shared
recipe, ask "who's cooking from this?" — that list is your blast radius.

```
dep_graph(mode: "dependents", target: "src/store.ts")
→ src/index.ts, src/indexer.ts, src/intel.ts

dep_graph(mode: "mermaid", root: "src/store.ts", depth: 1)
→ graph TD
    index.ts --> store.ts
    indexer.ts --> store.ts
```

---

## Group 6 — Memory that survives between chats

An AI session normally starts blank: everything figured out last time is gone.
Slimdex keeps a small notebook at `.slimdex/memory.json` — saved on your
disk, next to your code, surviving restarts. A new session reads the notebook
first and starts already informed.

The rule of thumb: save **decisions, gotchas, and "why"s** — things the code
itself cannot tell you. Don't save what reading the code would reveal anyway.

### `brief`

**Technical:** One synthesized session-opener. Combines the repo summary, the
journal-derived recap (where recent sessions were digging), and every saved
memory fact cross-referenced against the live index — each flagged ✓ (still
references code that exists) or ⚠ (names something no longer in the index, so it
may be stale). Conservative: only facts whose every code mention is gone get the
stale flag; a fact naming nothing code-shaped is left unmarked.

**Plain words:** "Catch me up." Instead of reading the notebook and the activity
log separately and wondering whether the notes are still true, you get one
paragraph that already checked them against the current code. Call it first in a
fresh chat.

```
brief()
→ Onboarding brief for /repo
    Repo: 17 indexed file(s), 102 symbol(s). Languages: .ts×17.
    Recap — files examined: src/graph.ts; symbols looked up: nameRefEdges …
    Saved conclusions (checked against the current index):
      [39b8fc15] ✓ (graph) nameRefEdges also walks repo XML …
      [aa01] ⚠ the fix lives in oldHelper()  (stale? mentions oldHelper …)
```

### `memory_save`

**Technical:** Appends a fact `{id, text, tags[], created, context?}` to
`memory.json`. `context` is provenance — a compact note of what the agent was
looking at (from the journal) when the fact was saved — recorded automatically.

**Plain words:** Write a sticky note in the shared notebook.

```
memory_save(
  text: "INDEX_VERSION was bumped 1→2 because the old parser captured prose
         inside template literals as fake declarations",
  tags: ["indexer", "gotcha"])
→ saved [1a517171]
```

### `memory_list`

**Technical:** Facts newest-first, `limit` default 50.

**Plain words:** Flip through the notebook. **First call of every new
session.**

```
memory_list()
→ [1a517171] (indexer, gotcha) 2026-07-21
  "INDEX_VERSION was bumped 1→2 because ..."
```

### `memory_search`

**Technical:** Filter by substring and/or tag — for when the store outgrows
a straight listing.

```
memory_search(tag: "gotcha")
→ only the facts tagged gotcha
```

### `memory_delete`

**Technical:** Remove one fact by the id shown in list/search output.

```
memory_delete(id: "1a517171")
→ deleted
```

---

## Group 7 — Plumbing

### `batch`

**Technical:** Executes up to 20 independent Slimdex calls in one request,
eliminating per-call protocol overhead. Cannot nest.

**Plain words:** Ask five questions in one breath instead of five phone calls.

```
batch(calls: [
  { tool: "find_definition", args: { name: "loadIndex" } },
  { tool: "find_definition", args: { name: "saveIndex" } }
])
→ both answers in one round trip
```

### `stats`

**Technical:** Per-tool call counts and response sizes (characters, not
tokens — char/4 estimates are unreliable across tokenizers) recorded to
`.slimdex/stats.json`. `reset:true` clears the counters.

**Plain words:** The receipt. Which tool is actually filling up the context
window?

```
stats()
→ batch        6 calls   17468 chars   avg 2911
  read_lines   3 calls   10070 chars   avg 3357
  TOTAL       19 calls   30638 chars
```

---

## How they all flow together

You start with `repo_map` to see the folder structure and get oriented. Then
you narrow down with `search_symbols` or `search_code` to find what you're
looking for across the codebase. Once you've found it, `find_definition` takes
you to where it's declared, and `get_file_skeleton` or `outline_file` shows
you the file's structure without reading everything. Then `get_context`,
`get_symbol_context`, or `read_lines` pulls the actual code you need to read.
If you need to see everywhere something is used, `find_references` shows all
those places. `dep_graph` helps you understand how files connect and depend on
each other. And throughout all this, `memory_save` and `memory_search` let you
document what you've learned so it persists into the next session. `stats`
tracks which tools are consuming your tokens so you stay efficient.

Everything works together to keep you reading only what's necessary — never
dumping whole files into context — so token usage stays proportional to the
question, not to the size of the repository.

**A worked example.** "Why does saving memory sometimes create a `.gitignore`
file?"

1. `memory_list` — has a past session already answered this? (Say no.)
2. `search_symbols(query: "saveMemory")` → `src/store.ts:119`.
3. `get_file_skeleton(path: "src/store.ts")` → 11 declarations; `ensureDir`
   at line 49 looks relevant.
4. `get_symbol_context(name: "ensureDir")` → there it is: the function writes
   a self-ignoring `*` gitignore into `.slimdex/`, flag `wx` so it never
   overwrites a user's edit.
5. `memory_save(text: ".slimdex/ writes its own * .gitignore in ensureDir,
   flag wx — never clobbers an edited one", tags: ["store"])`.

Total context spent: five small answers. Without Slimdex: reading
`store.ts`, probably `index.ts`, maybe `indexer.ts` — whole.

---

## The persistence story, end to end

Everything durable lives in one folder at the repo root: **`.slimdex/`**

| File | What it holds | Invalidation |
|---|---|---|
| `index.json` | every symbol + import per file | per-file, by mtime |
| `memory.json` | the saved facts | never — only explicit `memory_delete` |
| `stats.json` | usage counters | only explicit `stats(reset:true)` |
| `.gitignore` | a single `*` | written once, never overwritten |

**How mtime invalidation works, precisely.** The filesystem stamps every file
with the moment it was last modified (`mtimeMs`). The index stores that stamp
alongside each file's parsed symbols. On the next `index_repo`, each file is
`stat`-ed (cheap — no read) and compared: stamp unchanged → reuse the cached
entry; stamp changed → someone edited the file, so re-parse just that one. The
cost of a refresh is therefore proportional to *what changed*, not to repo
size. The same trick is used one level up: the whole parsed index is held in
process memory keyed on `index.json`'s own mtime, so even the ~20 ms of
re-reading a multi-megabyte index on every call is skipped.

One thing mtime *cannot* catch: a change to the parser itself. If symbol
extraction improves, every cached entry is stale even though no file changed.
That's what `INDEX_VERSION` is for — bumping it discards the whole index
regardless of timestamps.
