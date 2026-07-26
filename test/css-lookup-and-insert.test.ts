// Three field findings from a real stylesheet session, all consequences of
// CSS becoming addressable: the name you have in hand has no dot, outline_file
// was a second code path that never got CSS, and a selector legitimately
// repeats inside ONE file so pathPrefix cannot disambiguate an insert anchor.

import { describe, it, expect } from "vitest";
import { outline } from "../src/outline.js";
import { insertAtSymbol } from "../src/edit.js";

const CSS = [
  ".hub-section.hub-allow-overflow {",
  "  overflow: visible;",
  "}",
  "",
  ".swarm-arrow {",
  "  top: 0;",
  "}",
  "",
  "@media (max-width: 900px) {",
  "  .swarm-arrow { top: 5px; }",
  "}",
].join("\n");

describe("outline_file understands stylesheets", () => {
  it("no longer reports a stylesheet as having no declarations", () => {
    // The bug: get_file_skeleton mapped this file in full while outline_file
    // said "(no declarations detected)" — two code paths, one updated.
    expect(outline(CSS, 400, "AlgoTrading.css").length).toBeGreaterThan(0);
  });

  it("prints one entry per line, not one per selector", () => {
    const entries = outline(CSS, 400, "AlgoTrading.css");
    const lines = entries.map((e) => e.line);
    expect(new Set(lines).size).toBe(lines.length);
    // Line 1 carries two classes but is a single rule.
    expect(lines.filter((l) => l === 1)).toHaveLength(1);
  });

  it("leaves non-CSS files on the original outliner", () => {
    const ts = "export function alpha() {\n  return 1;\n}\n";
    expect(outline(ts, 400, "a.ts").some((e) => e.text.includes("alpha"))).toBe(true);
    // And a stylesheet passed with no filename cannot be treated as CSS.
    expect(outline(CSS, 400)).toHaveLength(0);
  });
});

describe("insert anchored by path + line", () => {
  // `.swarm-arrow` appears twice here and three times in the reported file:
  // a base rule plus media-query overrides. That is the NORMAL shape of a
  // stylesheet, so a name-only anchor is unusable and pathPrefix cannot help
  // when every duplicate shares a file.
  it("pins the first occurrence", () => {
    const res = insertAtSymbol(CSS, 5, "\n.swarm-arrow-tip { opacity: 0.5; }", "after");
    const lines = res.text.split("\n");
    // Lands after the base rule's closing brace, before the @media block.
    expect(lines[res.start]).toContain(".swarm-arrow-tip");
    expect(res.text.indexOf(".swarm-arrow-tip")).toBeLessThan(res.text.indexOf("@media"));
  });

  it("pins the occurrence inside the media query instead", () => {
    const res = insertAtSymbol(CSS, 10, "  .swarm-arrow-alt { top: 6px; }", "after");
    // Inserted inside the @media block, after the nested rule.
    expect(res.text.indexOf(".swarm-arrow-alt")).toBeGreaterThan(res.text.indexOf("@media"));
  });

  it("still refuses an out-of-range anchor line", () => {
    expect(() => insertAtSymbol(CSS, 999, "x", "after")).toThrow(/out of range/);
  });
});
