import { describe, it, expect } from "vitest";
import { buildGraph, dependents, toMermaid } from "../src/graph.js";
import type { CodeIndex, FileEntry } from "../src/store.js";

function entry(imports: string[]): FileEntry {
  return { mtimeMs: 1, lines: 10, symbols: [], imports: imports.map((m, i) => ({ module: m, line: i + 1 })) };
}

const index: CodeIndex = {
  version: 1,
  builtAt: "",
  files: {
    "src/app.ts": entry(["./db", "./lib/util", "react"]),
    "src/db.ts": entry(["node:fs"]),
    "src/lib/util/index.ts": entry([]),
    "pkg/main.py": entry(["helpers"]),
    "helpers.py": entry([]),
  },
};

describe("buildGraph", () => {
  const g = buildGraph(index);

  it("resolves relative JS imports with extension and index candidates", () => {
    expect(g.imports["src/app.ts"]).toEqual(
      expect.arrayContaining(["src/db.ts", "src/lib/util/index.ts"])
    );
  });

  it("classifies unresolvable modules as external", () => {
    expect(g.external["src/app.ts"]).toEqual(["react"]);
    expect(g.external["src/db.ts"]).toEqual(["node:fs"]);
  });

  it("resolves Python top-level modules", () => {
    expect(g.imports["pkg/main.py"]).toEqual(["helpers.py"]);
  });

  it("dependents is the reverse edge lookup", () => {
    expect(dependents(g, "src/db.ts")).toEqual(["src/app.ts"]);
    expect(dependents(g, "src/app.ts")).toEqual([]);
  });
});

describe("toMermaid", () => {
  const g = buildGraph(index);

  it("emits edges for internal deps only", () => {
    const m = toMermaid(g);
    expect(m).toContain("graph LR");
    expect(m).toContain('src/app.ts"');
    expect(m).not.toContain("react");
  });

  it("scoping filters both endpoints", () => {
    const m = toMermaid(g, "pkg/");
    // app.ts edges are outside the scope; pkg/main.py -> helpers.py crosses out of scope
    expect(m).toContain("No internal edges in scope");
  });
});
