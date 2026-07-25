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
import { buildOrRefresh, looksMinified } from "../src/indexer.js";

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
    expect(r.minified).toBe(2);
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
    expect(r.minified).toBe(1);
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
    expect(second.minified).toBe(1);
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
