# docs

Longer-form material that would bloat the root README.

| File | What it is | Who it's for |
|---|---|---|
| [`overview.md`](overview.md) | One page: how the tools flow together, no per-tool depth | Anyone wanting the picture in two minutes |
| [`tool-guide.md`](tool-guide.md) | Every tool explained twice — technically and in plain words — with an example each, the combined workflow, and how mtime-based persistence works | Anyone: read the plain-words halves for the idea, the technical halves for the detail |
| [`tool-guide.html`](tool-guide.html) | The same guide as a styled, self-contained page for presentation | Same audience, nicer to read in a browser |
| [`token-savings-report.md`](token-savings-report.md) | The original A/B measurement from 2026-07-21 — method, raw numbers, and a recipe to reproduce it | Anyone checking the savings claims |

Open the HTML file directly in a browser; it's self-contained, with no
external assets, and follows the system light/dark theme.

## On the numbers

Every figure in these documents came from a real run against a real repository —
nothing is illustrative. But they are **single measurements, not benchmarks**:
one project, one A/B run each. The method is written down in
`token-savings-report.md` precisely so it can be disputed or repeated.

The headline comparison — the same task run with and without the MCP, and what
the first-prompt indexing cost means — is explained in
[`overview.md`](overview.md).
