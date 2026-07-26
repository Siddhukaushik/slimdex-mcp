// Stylesheet rules as first-class symbols.
//
// .css/.scss/.less were indexed for TEXT SEARCH but emitted no symbols, so on a
// frontend repo most of the tree was invisible to find_definition,
// search_symbols, get_file_skeleton and replace_symbol. Reported from a session
// on a 60-jsx/32-css repo where `.swarm-flow` could not be addressed at all.

import { describe, it, expect } from "vitest";
import { extractSymbols } from "../src/symbols.js";

const CSS = [
  ".swarm-flow {",
  "  display: grid;",
  "}",
  "",
  "/* .commented-out { color: red; } */",
  ".hub-card.hub-allow-overflow, .panel {",
  "  overflow: visible;",
  "}",
  "",
  "#main-panel { z-index: 10; }",
  "",
  "@media (max-width: 700px) {",
  "  .swarm-flow { grid-template-columns: 1fr; }",
  "}",
  "",
  "@keyframes fadeIn { from { opacity: 0; } }",
].join("\n");

const names = (src: string, file: string) => extractSymbols(src, 2000, file).map((s) => s.name);

describe("CSS rule extraction", () => {
  it("indexes every class/id in a selector list, not just the first", () => {
    // The reported case: .hub-allow-overflow is the SECOND class in a compound
    // selector, and is exactly the one you reach for.
    const n = names(CSS, "src/app.css");
    expect(n).toContain(".hub-card");
    expect(n).toContain(".hub-allow-overflow");
    expect(n).toContain(".panel");
  });

  it("finds a rule at top level and nested inside an at-rule", () => {
    const hits = extractSymbols(CSS, 2000, "src/app.css").filter((s) => s.name === ".swarm-flow");
    expect(hits).toHaveLength(2);
    expect(hits[0].line).toBe(1);
    expect(hits[1].line).toBe(13);
  });

  it("indexes ids and at-rules", () => {
    const n = names(CSS, "src/app.css");
    expect(n).toContain("#main-panel");
    expect(n).toContain("@keyframes fadeIn");
    expect(n.some((x) => x.startsWith("@media"))).toBe(true);
  });

  it("does not index selectors inside comments", () => {
    expect(names(CSS, "src/app.css")).not.toContain(".commented-out");
  });

  it("points at the line the rule opens on", () => {
    const swarm = extractSymbols(CSS, 2000, "src/app.css").find((s) => s.name === ".swarm-flow")!;
    expect(CSS.split("\n")[swarm.line - 1]).toContain(".swarm-flow");
  });

  it("applies to scss and less too", () => {
    expect(names(".a { color: red; }", "x.scss")).toContain(".a");
    expect(names(".a { color: red; }", "x.less")).toContain(".a");
  });
});

describe("CSS rules do not leak into code files", () => {
  it("does not read a method chain as a class rule", () => {
    // Without extension gating, a selector regex reads `.filter(x => {` as a
    // rule named ".filter" — which is why CSS gets its own extractor rather
    // than sharing the code rule list.
    const js = ["const r = items", "  .filter(x => {", "    return x > 1;", "  });"].join("\n");
    expect(names(js, "src/a.js")).not.toContain(".filter");
  });

  it("still extracts ordinary code symbols when no file is given", () => {
    const ts = "export function alpha() {\n  return 1;\n}\n";
    expect(extractSymbols(ts).map((s) => s.name)).toContain("alpha");
    expect(names(ts, "src/a.ts")).toContain("alpha");
  });
});
