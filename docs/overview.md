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
across the codebase. Once you've found it, `find_definition` takes you to
where it's declared, and `get_file_skeleton` or `outline_file` shows you the
structure without reading everything. Then `get_context`,
`get_symbol_context`, or `read_lines` pulls the actual code you need to read.

If you need to see everywhere something is used, `find_references` shows all
those places. `dep_graph` helps you understand how files connect and depend on
each other. And throughout all this, `memory_save` and `memory_search` let you
document what you've learned so it persists across sessions. `stats` tracks
which tools are consuming your tokens so you stay efficient.

Everything works together to keep you reading only what's necessary — avoiding
dumping whole files into context — so your token usage stays proportional to
the question, not to the size of the repository.
