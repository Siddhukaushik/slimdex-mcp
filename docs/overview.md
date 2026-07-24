# Slimdex — fewer tokens, fewer credits

Slimdex cuts token usage — and therefore credits — on every chat. Use it in
one session and you save on that session; use it in every session and the
savings compound, because each chat reads less, remembers more, and never
re-derives what a past chat already figured out. The better you follow the
flow below, the bigger the reduction.

The comparison is simple: run the **same command with and without the MCP**,
and the with-MCP run uses fewer tokens and fewer credits. In one real test on
this repo, the same task cost **15 credits without the MCP and 5 credits with
it** — a third of the price for the same answer.

One honest caveat: the **first prompt with the MCP can sometimes cost more**,
because the initial `index_repo` has to scan the whole project once to build
the index. That's a one-time cost — every prompt after that reuses the index
and only pays for what changed, so the savings show up from the second
question onward and keep compounding across chats.

For per-tool detail and examples, see [`tool-guide.md`](tool-guide.md).

You start with `repo_map` to see the folder structure and get oriented. Then
you use `search_symbols` or `search_code` to find what you're looking for
across the codebase — or, when you know what the code *does* but not its name,
`search_intent` ranks symbols by a natural-language query (BM25, no embeddings).
Or, to understand a whole *area* rather than hunt symbol by symbol,
`context_pack("how does X work")` runs the entire exploration for you and returns
one bounded bundle — the relevant symbols, how they connect, and the key bodies —
so it costs one call and one transcript entry instead of ten scattered lookups.
Once you've found it, `find_definition` takes you to where it's declared, and
`get_file_skeleton` or `outline_file` shows you the structure without reading
everything. Then `get_context`, `get_symbol_context`, or `read_lines` pulls the
actual code you need to read — and `get_symbol_context` flags itself if the file
has changed since it was indexed, so you know when a line number is worth
re-checking and, more usefully, when it isn't.

If you need to see everywhere something is used, `find_references` shows all
those places, and `find_tests` narrows that to the tests that cover a symbol —
so before you change it you know exactly what will catch a regression, or that
nothing will. `dep_graph` helps you understand how files connect and depend on
each other. When you're ready to change a whole function, `replace_symbol`
rewrites it by name — you send only the new body, never the old code just to
locate the edit, and the file is snapshotted first. And throughout all this,
`memory_save` and `memory_search` let you document what you've learned so it
persists across sessions; `brief` reads all of that back at the start of the
next session — with any note that no longer matches the code already flagged —
so you start informed. And `digest_save` keeps a one-page architecture
cheat-sheet the whole team's agents can read via `digest_get` instead of
re-exploring the code each time, with a freshness check that flags it when a
covered file changes. `stats` tracks which tools are consuming your tokens so
you stay efficient.

Everything works together to keep you reading only what's necessary — avoiding
dumping whole files into context — so your token usage stays proportional to
the question, not to the size of the repository.
