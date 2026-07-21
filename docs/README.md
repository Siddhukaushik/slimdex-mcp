# docs

Longer-form material that would bloat the root README.

| File | What it is | Who it's for |
|---|---|---|
| [`tool-reference.html`](tool-reference.html) | All 19 tools with real captured output, the architecture, the measured with/without comparison, language and scale tables | Someone deciding whether to use it, or working on it |
| [`explained-simply.html`](explained-simply.html) | The same thing in plain language, built around a library/card-catalog analogy, with three worked end-to-end examples | Someone who wants the idea without the jargon |
| [`token-savings-report.md`](token-savings-report.md) | The original A/B measurement from 2026-07-21 — method, raw numbers, and a recipe to reproduce it | Anyone checking the savings claims |

Open the HTML files directly in a browser; they're self-contained, with no
external assets, and follow the system light/dark theme.

## On the numbers

Every figure in these documents came from a real run against a real repository —
nothing is illustrative. But they are **single measurements, not benchmarks**:
one project, one A/B run each, taken by the author. The method is written down in
`token-savings-report.md` precisely so it can be disputed or repeated.

The headline pair is worth understanding rather than quoting:

- **~8× fewer tokens** on a single navigation task
- **~29% cheaper** across a whole working session

Both are true and they measure different scopes. A session is mostly fixed
overhead — system prompt, tool definitions, project files — that CodeGlance never
touches, so it only shaves the file-reading slice. The large number describes the
slice; the smaller one describes the bill.
