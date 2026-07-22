// Name-reference dependency edges for import-less languages (Apex).
//
// The README used to list "dep_graph is empty for Apex" as a hard limitation:
// .cls files have no import statements to parse. These tests pin the fix — a
// masked-token scan that turns "file A's code mentions a class defined in
// file B" into an edge — including the framework shapes that motivated it:
// interface -> implementation and trigger -> handler.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildOrRefresh } from "../src/indexer.js";
import { buildGraph, dependents, nameRefEdges, mergeEdges, toMermaid } from "../src/graph.js";
import type { CodeIndex } from "../src/store.js";

let root = "";
let index: CodeIndex;

const FILES: Record<string, string> = {
  "classes/IAccountService.cls": ["public interface IAccountService {", "    void save(Account a);", "}"].join("\n"),
  "classes/AccountService.cls": [
    "public with sharing class AccountService implements IAccountService {",
    "    public void save(Account a) {",
    "        Logger.log('saving'); // string + comment below must not add edges",
    "    }",
    "}",
  ].join("\n"),
  "classes/Logger.cls": [
    "// Used by AccountService — a comment mention, NOT a dependency.",
    "public class Logger {",
    "    public static void log(String msg) { System.debug(msg); }",
    "}",
  ].join("\n"),
  "triggers/AccountTrigger.trigger": [
    "trigger AccountTrigger on Account (before insert) {",
    "    new AccountService().save(Trigger.new[0]);",
    "}",
  ].join("\n"),
  // A string-only mention: 'IAccountService' inside quotes must not link.
  "classes/Docs.cls": ["public class Docs {", "    public String topic = 'IAccountService';", "}"].join("\n"),
  // Declarative wiring, SFDX-style: a custom-metadata record binding a handler
  // class by name. This is the "held purely in metadata" case — the binding is
  // still in the repo, as XML.
  "customMetadata/Trigger_Binding.Account.md-meta.xml": [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<CustomMetadata>",
    "    <!-- IAccountService mentioned in a comment: must NOT create an edge -->",
    "    <values>",
    "        <field>Handler_Class__c</field>",
    '        <value xsi:type="xsd:string">AccountService</value>',
    "    </values>",
    "</CustomMetadata>",
  ].join("\n"),
  "customMetadata/Unrelated.md-meta.xml": ["<CustomMetadata>", "    <label>Nothing here</label>", "</CustomMetadata>"].join("\n"),
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "codeglance-apex-"));
  for (const [rel, body] of Object.entries(FILES)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body, "utf8");
  }
  index = (await buildOrRefresh(root)).index;
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("nameRefEdges (Apex)", () => {
  it("links a class to the classes it uses, by bare name", async () => {
    const edges = await nameRefEdges(root, index);
    expect(edges["classes/AccountService.cls"]).toEqual(
      expect.arrayContaining(["classes/IAccountService.cls", "classes/Logger.cls"])
    );
  });

  it("answers 'who implements this interface' via dependents", async () => {
    const g = mergeEdges(buildGraph(index), await nameRefEdges(root, index));
    expect(dependents(g, "classes/IAccountService.cls")).toContain("classes/AccountService.cls");
  });

  it("links a trigger to its handler class", async () => {
    const edges = await nameRefEdges(root, index);
    expect(edges["triggers/AccountTrigger.trigger"]).toContain("classes/AccountService.cls");
  });

  it("ignores mentions inside comments and strings", async () => {
    const edges = await nameRefEdges(root, index);
    expect(edges["classes/Logger.cls"]).toBeUndefined(); // comment mention only
    expect(edges["classes/Docs.cls"]).toBeUndefined(); // string mention only
  });

  it("links declarative metadata wiring to the class it binds", async () => {
    const edges = await nameRefEdges(root, index);
    const xml = "customMetadata/Trigger_Binding.Account.md-meta.xml";
    expect(edges[xml]).toEqual(["classes/AccountService.cls"]);
    // ...and NOT the interface, which only appears inside an XML comment.
    expect(edges[xml]).not.toContain("classes/IAccountService.cls");
    expect(edges["customMetadata/Unrelated.md-meta.xml"]).toBeUndefined();

    // dependents() answers "what wires AccountService up", including metadata.
    const g = mergeEdges(buildGraph(index), edges);
    expect(dependents(g, "classes/AccountService.cls")).toContain(xml);
  });

  it("feeds the mermaid diagram", async () => {
    const g = mergeEdges(buildGraph(index), await nameRefEdges(root, index));
    const m = toMermaid(g);
    expect(m).toContain("AccountService.cls");
    expect(m).toContain("IAccountService.cls");
  });

  it("returns the cached object for the same index build", async () => {
    const a = await nameRefEdges(root, index);
    const b = await nameRefEdges(root, index);
    expect(b).toBe(a); // WeakMap identity, not a rescan
  });

  it("is a no-op merge for repos with no import-less languages", async () => {
    const jsOnly: CodeIndex = { version: 1, builtAt: "", files: { "a.ts": { mtimeMs: 1, lines: 1, symbols: [], imports: [] } } };
    expect(await nameRefEdges(root, jsOnly)).toEqual({});
  });
});
