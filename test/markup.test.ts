// Regression guard for the newly-indexed markup/style extensions (.css .scss
// .less .html). extractSymbols runs ALL language rules on any content, so the
// thing that could break is junk symbols from selectors or markup. This pins the
// verified behavior: CSS/HTML produce no junk, only genuine declarations
// (an SCSS @function, an inline <script> function) are surfaced.

import { describe, it, expect } from "vitest";
import { extractSymbols } from "../src/symbols.js";

const names = (src: string) => extractSymbols(src).map((s) => s.name);

describe("markup/style extraction produces no junk symbols", () => {
  it("CSS yields zero symbols (selectors, @media, custom props are not code)", () => {
    const css = [
      ".card-grid { display: grid; grid-template-columns: repeat(3, 1fr); }",
      "@media (max-width: 600px) { .card { width: 100%; } }",
      ":root { --gap: 8px; }",
      ".btn:hover { color: red; }",
    ].join("\n");
    expect(extractSymbols(css)).toEqual([]);
  });

  it("SCSS surfaces a real @function but not selectors or nesting", () => {
    const scss = [
      "$primary: #333;",
      "@mixin flexCenter($dir: row) { display: flex; }",
      "@function double($n) { @return $n * 2; }",
      ".panel { .title { font-weight: bold; } }",
    ].join("\n");
    const got = names(scss);
    expect(got).toContain("double"); // the @function is a genuine declaration
    expect(got).not.toContain("panel"); // selectors are not symbols
    expect(got).not.toContain("title");
    expect(got).not.toContain("primary");
  });

  it("HTML/LWC template yields only inline <script> functions, not markup", () => {
    const html = [
      "<template>",
      '  <div class="cards">',
      "    <c-card record-id={id} onclick={handleClick}></c-card>",
      "  </div>",
      "  <script>function inlineThing() { return 1; }</script>",
      "</template>",
    ].join("\n");
    const got = names(html);
    expect(got).toContain("inlineThing"); // real JS in the file
    expect(got).not.toContain("template"); // tags are not symbols
    expect(got).not.toContain("div");
    expect(got).not.toContain("cards");
  });
});
