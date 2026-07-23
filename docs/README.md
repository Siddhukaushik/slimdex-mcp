# docs

Longer-form material that would bloat the root README.

| File | What it is | Who it's for |
|---|---|---|
| [`overview.md`](overview.md) | One page: how the tools flow together, no per-tool depth | Anyone wanting the picture in two minutes |
| [`tool-guide.md`](tool-guide.md) | Every tool explained twice — technically and in plain words — with an example each, the combined workflow, and how mtime-based persistence works | Anyone: read the plain-words halves for the idea, the technical halves for the detail |
| [`tool-guide.html`](tool-guide.html) | The same guide as a styled, self-contained page for presentation | Same audience, nicer to read in a browser |
| [`token-savings-report.md`](token-savings-report.md) | The original A/B measurement from 2026-07-21 — method, raw numbers, and a recipe to reproduce it | Anyone checking the savings claims |
| [`agent-brain.md`](agent-brain.md) | The operating discipline, as a drop-in `CLAUDE.md`/`AGENTS.md` for any repo where slimdex is connected — session ritual, tool decision table, follow-through rule, field results | The agent itself; paste it into your project |
| [`showcase.md`](showcase.md) | The project in one page — problem, approach, trade-offs, architecture | Someone deciding whether to look closer |

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

## Field results (real sessions, 2026-07-22)

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

## Realistic honest band across your whole workflow:
 ~45% on output-heavy days, ~55–60% on navigation-heavy days. Averaged over real use, call it ~50% — and 55–60% whenever the work leans toward reading and understanding rather than churning out new code.
