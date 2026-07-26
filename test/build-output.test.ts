// Keeping build output out of the index.
//
// Both cases here come from one real session on a frontend+Java repo, where
// ~2.5MB of untracked bundles under backend/src/main/resources/static/assets
// were indexed as if they were source. Roughly a third of the session's search
// results were minified junk: a search for one component name returned 51 hits
// whose first 8 were all bundle noise.
//
// The two fixes are deliberately different in kind, because the problem has two
// halves:
//   - a path-shaped ignoreDirs entry was ACCEPTED, counted in the summary, and
//     then matched nothing (the walk compares basenames), so the config said it
//     worked and did not;
//   - and no directory-name list would have helped anyway, because the
//     directory was called `assets` — a name real source uses constantly. That
//     half is caught by content shape instead.

import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildOrRefresh, looksMinified, looksGeneratedDoc, hasIndexedSuffix } from "../src/indexer.js";

const roots: string[] = [];

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-build-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, "utf8");
  }
  return root;
}

afterEach(async () => {
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

const TS = "export function f() { return 1; }\n";
// Shaped like a real bundle: one enormous line. Name and extension are
// indistinguishable from source, which is the whole point.
const BUNDLE = `!function(){"use strict";${"var a=1;".repeat(1200)}}();\n`;

describe("path-shaped ignoreDirs entries", () => {
  it("ignores a multi-segment path instead of silently matching nothing", async () => {
    const root = await makeRepo({
      ".slimdex.json": JSON.stringify({ ignoreDirs: ["backend/static/assets"] }),
      "a.ts": TS,
      "backend/static/assets/x.ts": TS,
    });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files)).toEqual(["a.ts"]);
    expect(r.config).toContain("+1 ignoreDirs");
  });

  it("anchors a path entry at the repo root, unlike a bare name", async () => {
    // "static/assets" must not ignore "vendor-copy/static/assets" — an anchored
    // rule that quietly went recursive would be the same class of surprise in
    // the other direction.
    const root = await makeRepo({
      ".slimdex.json": JSON.stringify({ ignoreDirs: ["static/assets"] }),
      "static/assets/x.ts": TS,
      "other/static/assets/y.ts": TS,
    });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files)).toEqual(["other/static/assets/y.ts"]);
  });

  it("respects directory boundaries, so src/gen does not swallow src/generated", async () => {
    const root = await makeRepo({
      ".slimdex.json": JSON.stringify({ ignoreDirs: ["src/gen"] }),
      "src/gen/x.ts": TS,
      "src/generated/y.ts": TS,
    });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files)).toEqual(["src/generated/y.ts"]);
  });

  it("tolerates trailing slashes, ./ prefixes and backslashes", async () => {
    const root = await makeRepo({
      ".slimdex.json": JSON.stringify({ ignoreDirs: ["./build\\out/", "src/gen/"] }),
      "build/out/x.ts": TS,
      "src/gen/y.ts": TS,
      "keep.ts": TS,
    });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files)).toEqual(["keep.ts"]);
  });

  it("warns rather than counting an empty entry", async () => {
    const root = await makeRepo({
      ".slimdex.json": JSON.stringify({ ignoreDirs: ["", "fixtures"] }),
      "a.ts": TS,
    });
    const r = await buildOrRefresh(root);
    expect(r.warnings.join(" ")).toContain("empty ignoreDirs entry");
    expect(r.config).toContain("+1 ignoreDirs");
  });
});

describe("minified detection", () => {
  it("recognises bundle shape, not bundle names", () => {
    expect(looksMinified(BUNDLE)).toBe(true);
    expect(looksMinified(TS)).toBe(false);
    expect(looksMinified("")).toBe(false);
  });

  it("does not trip on ordinary source with long-ish lines", () => {
    const wide = `const msg = "${"x".repeat(400)}";\n`.repeat(50);
    expect(looksMinified(wide)).toBe(false);
  });

  it("catches an unterminated final line", () => {
    expect(looksMinified("var a=1;".repeat(1000))).toBe(true);
  });

  it("keeps hash-named bundles out of the index and reports the count", async () => {
    const root = await makeRepo({
      "src/App.tsx": TS,
      // Exactly the case that beat the directory list: a plausible source name,
      // a source extension, inside a directory called `assets`.
      "static/assets/index-B7xK2p9q.js": BUNDLE,
      "static/assets/vendor-a91f2c.js": BUNDLE,
    });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files)).toEqual(["src/App.tsx"]);
    expect(r.generated).toBe(2);
    expect(r.totalFiles).toBe(1);
  });

  it("still indexes real source living beside bundles in assets/", async () => {
    // The reason `assets` is not in the default ignore list: plenty of repos
    // keep hand-written source there, and ignoring it by name would lose it.
    const root = await makeRepo({
      "assets/helper.ts": TS,
      "assets/app.min.js": BUNDLE,
    });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files)).toEqual(["assets/helper.ts"]);
    expect(r.generated).toBe(1);
  });

  it("drops a bundle that an older index had already recorded", async () => {
    const root = await makeRepo({ "a.ts": TS, "b.js": TS });
    const first = await buildOrRefresh(root);
    expect(Object.keys(first.index.files).sort()).toEqual(["a.ts", "b.js"]);

    // b.js becomes build output. A stale entry surviving on mtime alone is the
    // failure mode the INDEX_VERSION bump exists to prevent.
    await fs.writeFile(path.join(root, "b.js"), BUNDLE, "utf8");
    const second = await buildOrRefresh(root, true);
    expect(Object.keys(second.index.files)).toEqual(["a.ts"]);
    expect(second.generated).toBe(1);
  });
});

describe("default ignore dirs", () => {
  it("skips framework build output without any config", async () => {
    const root = await makeRepo({
      "src/a.ts": TS,
      ".svelte-kit/generated/x.ts": TS,
      ".turbo/y.ts": TS,
      "ios/Pods/z.ts": TS,
      ".pytest_cache/w.py": "def f(): pass\n",
    });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files)).toEqual(["src/a.ts"]);
  });

  it("leaves public/ and static/ alone — those hold real source", async () => {
    const root = await makeRepo({ "public/app.ts": TS, "static/util.ts": TS });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files).sort()).toEqual(["public/app.ts", "static/util.ts"]);
  });
});

// Generated API documentation, found by the corpus audit rather than by guessing.
//
// On a real Swift repo, 332 of 440 indexed files were jazzy HTML — 700-800 lines
// each, zero symbols — crowding every search exactly the way minified bundles did.
// No directory list catches it: the pages sit in plain `docs/`, which just as many
// repos use for hand-written documentation, and one lived in `Alamofire.docset`,
// which a basename ignore also misses.
//
// The first attempt at this looked for `<meta name="generator">` and a "Generated
// by" comment, and caught NONE of them — jazzy writes neither. These fixtures are
// taken from what the tools actually emit.
describe("generated documentation", () => {
  const jazzy = [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "  <head>",
    "    <title>Adapter Class Reference</title>",
    '    <link rel="stylesheet" type="text/css" href="../css/jazzy.css" />',
    '    <script src="../js/jazzy.js" defer></script>',
    "  </head>",
    "  <body>",
    '    <a name="//apple_ref/swift/Class/Adapter" class="dashAnchor"></a>',
    "  </body>",
    "</html>",
  ].join("\n");

  it("recognises output whose only signature is its own assets", () => {
    expect(looksGeneratedDoc(jazzy)).toBe(true);
  });

  it("recognises the conventional generator meta tag too", () => {
    expect(looksGeneratedDoc('<html><head><meta name="generator" content="mkdocs-1.5"></head>')).toBe(true);
    expect(looksGeneratedDoc("<!-- Generated by javadoc (17) -->\n<html>")).toBe(true);
  });

  it("leaves hand-written HTML alone", () => {
    const real = [
      "<!DOCTYPE html>",
      '<html><head><title>My App</title><link rel="stylesheet" href="app.css"></head>',
      "<body><div id=\"app\"></div>",
      "<script>function initApp() {}</script>",
      "</body></html>",
    ].join("\n");
    expect(looksGeneratedDoc(real)).toBe(false);
  });

  it("only trusts the head, so prose mentioning a generator is safe", () => {
    // A hand-written page discussing javadoc must not be mistaken for javadoc.
    const article = "<html><head><title>Notes</title></head><body>\n" + "<p>filler</p>\n".repeat(400) + "<p>Generated by javadoc is a phrase.</p>";
    expect(looksGeneratedDoc(article)).toBe(false);
  });

  it("keeps generated docs out of the index and counts them", async () => {
    const root = await makeRepo({ "src/App.swift": "class App {\n  func run() {}\n}\n", "docs/Api.html": jazzy });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files)).toEqual(["src/App.swift"]);
    expect(r.generated).toBe(1);
  });
});

// Salesforce metadata sidecars, matched by NAME SUFFIX rather than extension.
//
// Every deployable Salesforce component is paired with one — AccountSvc.cls-meta.xml,
// errorPanel.js-meta.xml, Account.object-meta.xml — and they decide API version,
// visibility, exposure and field-level security. A Salesforce developer searches
// them constantly; slimdex could not see them, because path.extname() says ".xml".
//
// Adding ".xml" to CODE_EXT would have worked and been wrong: pom.xml, web.xml and
// every config tree come with it, recreating the index noise the minified and
// generated-doc checks had just removed. Verified on trailheadapps/lwc-recipes:
// 261 -meta.xml indexed, 0 other .xml — including manifest/package.xml, which is a
// deploy manifest, not component metadata.
describe("suffix-matched files", () => {
  const META = `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <isExposed>true</isExposed>
    <targets><target>lightning__AppPage</target></targets>
</LightningComponentBundle>`;

  it("matches the suffix, not the extension", () => {
    expect(hasIndexedSuffix("AccountSvc.cls-meta.xml")).toBe(true);
    expect(hasIndexedSuffix("errorPanel.js-meta.xml")).toBe(true);
    expect(hasIndexedSuffix("Account.object-meta.xml")).toBe(true);
    // The whole point of not adding ".xml":
    expect(hasIndexedSuffix("pom.xml")).toBe(false);
    expect(hasIndexedSuffix("web.xml")).toBe(false);
    expect(hasIndexedSuffix("package.xml")).toBe(false);
  });

  it("indexes metadata sidecars and leaves other XML out", async () => {
    const root = await makeRepo({
      "force-app/classes/AccountSvc.cls": "public class AccountSvc {\n  public void go() {}\n}\n",
      "force-app/classes/AccountSvc.cls-meta.xml": META,
      "force-app/lwc/panel/panel.js-meta.xml": META,
      "manifest/package.xml": META, // a deploy manifest, NOT component metadata
      "pom.xml": META,
    });
    const r = await buildOrRefresh(root);
    const files = Object.keys(r.index.files).sort();
    expect(files).toEqual([
      "force-app/classes/AccountSvc.cls",
      "force-app/classes/AccountSvc.cls-meta.xml",
      "force-app/lwc/panel/panel.js-meta.xml",
    ]);
  });

  it("makes them searchable, which is the entire point", async () => {
    const root = await makeRepo({ "force-app/lwc/panel/panel.js-meta.xml": META });
    const r = await buildOrRefresh(root);
    const entry = r.index.files["force-app/lwc/panel/panel.js-meta.xml"];
    expect(entry).toBeDefined();
    // No symbols, by design — same standing as CSS/HTML. read_lines and
    // search_code reach it; find_definition should never resolve to a tag.
    expect(entry.symbols).toEqual([]);
    expect(entry.lines).toBeGreaterThan(3);
  });

  it("accepts extra suffixes from .slimdex.json", async () => {
    const root = await makeRepo({
      ".slimdex.json": JSON.stringify({ suffixes: [".stories.mdx"] }),
      "src/Button.stories.mdx": "# Button\n\nsome docs\n",
      "src/other.mdx": "# Not matched\n",
    });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files)).toEqual(["src/Button.stories.mdx"]);
    expect(r.config).toContain("+1 suffixes");
  });

  it("points a bare extension at the right config key", async () => {
    const root = await makeRepo({
      ".slimdex.json": JSON.stringify({ suffixes: [".astro"] }),
      "a.ts": TS,
    });
    const r = await buildOrRefresh(root);
    expect(r.warnings.join(" ")).toContain('put it in "extensions"');
  });
});
