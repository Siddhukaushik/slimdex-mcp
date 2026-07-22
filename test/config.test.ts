// .codeglance.json loading, exercised through buildOrRefresh against real temp
// dirs. This was flagged in the README as "manually exercised only" — a config
// regression (say, exclude rules silently ignored) would have shipped unseen.

import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildOrRefresh } from "../src/indexer.js";

const roots: string[] = [];

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "codeglance-cfg-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, "utf8");
  }
  return root;
}

afterEach(async () => {
  while (roots.length) {
    const r = roots.pop()!;
    await fs.rm(r, { recursive: true, force: true });
  }
});

const TS = "export function f() { return 1; }\n";

describe("no config file", () => {
  it("uses defaults and says so", async () => {
    const root = await makeRepo({ "a.ts": TS, "node_modules/b.ts": TS });
    const r = await buildOrRefresh(root);
    expect(r.config).toBe("no .codeglance.json (defaults)");
    expect(r.warnings).toEqual([]);
    expect(Object.keys(r.index.files)).toEqual(["a.ts"]); // node_modules skipped by default
  });
});

describe("the cache directory", () => {
  it("writes a self-ignoring .gitignore, and never clobbers an edited one", async () => {
    const root = await makeRepo({ "a.ts": TS });
    await buildOrRefresh(root);
    const ignorePath = path.join(root, ".codeglance", ".gitignore");
    expect(await fs.readFile(ignorePath, "utf8")).toBe("*\n");

    await fs.writeFile(ignorePath, "index.json\n", "utf8"); // user customized it
    await buildOrRefresh(root);
    expect(await fs.readFile(ignorePath, "utf8")).toBe("index.json\n");
  });
});

describe("valid config", () => {
  it("ignoreDirs adds to the built-in ignore set", async () => {
    const root = await makeRepo({
      ".codeglance.json": JSON.stringify({ ignoreDirs: ["fixtures"] }),
      "a.ts": TS,
      "fixtures/x.ts": TS,
    });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files)).toEqual(["a.ts"]);
    expect(r.config).toContain("+1 ignoreDirs");
  });

  it("extensions adds new indexable extensions", async () => {
    const root = await makeRepo({
      ".codeglance.json": JSON.stringify({ extensions: [".astro"] }),
      "page.astro": TS,
    });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files)).toEqual(["page.astro"]);
  });

  it("exclude filters by repo-relative path substring", async () => {
    const root = await makeRepo({
      ".codeglance.json": JSON.stringify({ exclude: ["generated/"] }),
      "a.ts": TS,
      "generated/z.ts": TS,
      "src/generated/w.ts": TS, // substring match, not prefix — both go
    });
    const r = await buildOrRefresh(root);
    expect(Object.keys(r.index.files)).toEqual(["a.ts"]);
  });

  it("maxFileBytes skips oversized files and counts them", async () => {
    const root = await makeRepo({
      ".codeglance.json": JSON.stringify({ maxFileBytes: 10 }),
      "big.ts": TS, // 34 bytes > 10
    });
    const r = await buildOrRefresh(root);
    expect(r.skipped).toBe(1);
    expect(r.index.files["big.ts"]).toBeUndefined();
  });
});

describe("broken config is visible, never silent", () => {
  it("invalid JSON warns and falls back to defaults", async () => {
    const root = await makeRepo({ ".codeglance.json": "{ not json", "a.ts": TS });
    const r = await buildOrRefresh(root);
    expect(r.config).toBe("invalid .codeglance.json");
    expect(r.warnings.some((w) => w.includes("not valid JSON"))).toBe(true);
    expect(Object.keys(r.index.files)).toEqual(["a.ts"]); // still indexes
  });

  it("unknown keys are named in a warning", async () => {
    const root = await makeRepo({
      ".codeglance.json": JSON.stringify({ ignoredDirs: ["typo"] }),
      "a.ts": TS,
    });
    const r = await buildOrRefresh(root);
    expect(r.warnings.some((w) => w.includes('unknown key "ignoredDirs"'))).toBe(true);
  });

  it("non-array value for an array key warns and is ignored", async () => {
    const root = await makeRepo({
      ".codeglance.json": JSON.stringify({ exclude: "generated/" }),
      "generated/z.ts": TS,
    });
    const r = await buildOrRefresh(root);
    expect(r.warnings.some((w) => w.includes('"exclude" must be an array'))).toBe(true);
    expect(r.index.files["generated/z.ts"]).toBeDefined(); // rule not applied
  });

  it("extension without a leading dot warns but is still added", async () => {
    const root = await makeRepo({
      ".codeglance.json": JSON.stringify({ extensions: ["astro"] }),
      "a.ts": TS,
    });
    const r = await buildOrRefresh(root);
    expect(r.warnings.some((w) => w.includes("should start with a dot"))).toBe(true);
  });

  it("bad maxFileBytes warns and keeps the default", async () => {
    const root = await makeRepo({
      ".codeglance.json": JSON.stringify({ maxFileBytes: -5 }),
      "a.ts": TS,
    });
    const r = await buildOrRefresh(root);
    expect(r.warnings.some((w) => w.includes('"maxFileBytes" must be a positive number'))).toBe(true);
    expect(r.index.files["a.ts"]).toBeDefined();
  });
});
