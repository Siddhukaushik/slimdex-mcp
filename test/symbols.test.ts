import { describe, it, expect } from "vitest";
import { extractSymbols, extractImports } from "../src/symbols.js";

const names = (src: string) => extractSymbols(src).map((s) => s.name);

describe("extractSymbols", () => {
  it("finds JS/TS declarations with correct positions", () => {
    const src = [
      "export class UserService {",
      "  login() {}",
      "}",
      "export interface Config {}",
      "export type Id = string;",
      "export async function fetchAll() {}",
      "const handler = async (req) => {",
      "};",
    ].join("\n");
    const syms = extractSymbols(src);
    expect(names(src)).toEqual(expect.arrayContaining(["UserService", "Config", "Id", "fetchAll", "handler"]));
    const cls = syms.find((s) => s.name === "UserService")!;
    expect(cls.kind).toBe("class");
    expect(cls.line).toBe(1);
    expect(cls.col).toBe(14); // column where the name starts, 1-indexed
  });

  it("finds Python defs and classes", () => {
    const src = "class Parser:\n    def parse(self):\n        pass\n\nasync def main():\n    pass";
    expect(names(src)).toEqual(expect.arrayContaining(["Parser", "parse", "main"]));
  });

  it("finds Go and Rust declarations", () => {
    const go = "func (s *Server) Handle(w http.ResponseWriter) {\n}\ntype Config struct {\n}";
    expect(names(go)).toEqual(expect.arrayContaining(["Handle", "Config"]));
    const rust = "pub async fn run() {}\npub struct State {}\npub trait Store {}";
    expect(names(rust)).toEqual(expect.arrayContaining(["run", "State", "Store"]));
  });

  it("finds class and object-literal methods, not just the class", () => {
    const src = [
      "export class UserService {",
      "  constructor(private db: string) {}",
      "  async getUser(id: string): Promise<string> {",
      "    return this.db;",
      "  }",
      "  get size(): number {",
      "    return 1;",
      "  }",
      "  handleClose() {",
      "  }",
      "}",
    ].join("\n");
    expect(names(src)).toEqual(
      expect.arrayContaining(["UserService", "constructor", "getUser", "size", "handleClose"])
    );
    expect(extractSymbols(src).find((s) => s.name === "getUser")!.kind).toBe("method");
  });

  it("does not mistake control flow for a method", () => {
    // `if (cond) {` is shape-identical to `name(args) {` — only the keyword
    // list tells them apart, so this is the regression that matters most.
    const src = [
      "function outer() {",
      "  if (a) {",
      "  }",
      "  for (const x of y) {",
      "  }",
      "  while (z) {",
      "  }",
      "  switch (k) {",
      "  }",
      "}",
    ].join("\n");
    expect(names(src)).toEqual(["outer"]);
  });

  it("finds Java/C# methods where a return type precedes the name", () => {
    const src = ["class Foo {", "  public async Task<int> GetUser(string id) {", "  }", "}"].join("\n");
    expect(names(src)).toEqual(expect.arrayContaining(["Foo", "GetUser"]));
  });

  it("skips comment lines", () => {
    const src = "// function fake() {}\n# def also_fake():\nfunction real() {}";
    expect(names(src)).toEqual(["real"]);
  });
});

describe("extractImports", () => {
  it("captures JS import/require/export-from", () => {
    const src = [
      `import db from "./db.js";`,
      `import { x } from "../lib/util";`,
      `const fs = require("node:fs");`,
      `export { y } from "./y";`,
    ].join("\n");
    const mods = extractImports(src).map((i) => i.module);
    expect(mods).toEqual(["./db.js", "../lib/util", "node:fs", "./y"]);
  });

  it("captures Python and Rust imports", () => {
    const py = "from utils.helpers import clean\nimport os";
    expect(extractImports(py).map((i) => i.module)).toEqual(["utils.helpers", "os"]);
    const rs = "use crate::store;";
    expect(extractImports(rs).map((i) => i.module)).toEqual(["crate::store"]);
  });
});
