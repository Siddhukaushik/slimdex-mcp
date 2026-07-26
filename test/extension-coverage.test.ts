// The structural proof: every extension slimdex indexes must have a fixture here.
//
// This exists because the same failure keeps recurring and keeps being found by a
// HUMAN reading a session transcript, weeks later:
//
//   - `.php`, `.kt`, `.swift`, `.scala` sat in CODE_EXT for a while with no rules
//     behind them. Those files indexed to nothing and no test noticed.
//   - Java `record` was absent from the rules entirely; a session hit it as
//     "No definition indexed" for a type sitting in plain sight.
//   - Apex annotations on the same line as a signature (`@isTest static void
//     t() {}`) were invisible, while the identical method with the annotation on
//     its OWN line indexed fine. Salesforce test classes and LWC controllers are
//     almost entirely the broken form.
//
// Every one of those was a promise silently broken: an extension in CODE_EXT tells
// the user "symbols come out of this". Reviewing AI session retrospectives is a
// slow, lossy way to discover otherwise.
//
// So the list below is checked AGAINST CODE_EXT at runtime. Add an extension to
// the indexer without adding a fixture here and this suite fails, naming it. An
// extension that legitimately yields no symbols must say so explicitly — silence
// and "documented as empty" must not look the same.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractSymbols } from "../src/symbols.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const indexerSrc = readFileSync(path.join(here, "..", "src", "indexer.ts"), "utf8");

/** The extensions the indexer actually walks — read from source, not restated. */
const CODE_EXT: string[] = (() => {
  const block = indexerSrc.match(/const CODE_EXT = new Set\(\[([\s\S]*?)\]\)/);
  if (!block) throw new Error("could not find CODE_EXT in src/indexer.ts");
  return [...block[1].matchAll(/"(\.[a-z]+)"/g)].map((m) => m[1]);
})();

interface Fixture {
  /** A realistic snippet — idiomatic, not a minimal toy. */
  src: string;
  /** Symbol names that MUST come out. Empty = documented as symbol-free. */
  expect: string[];
  /** Required when expect is empty: why this file type carries no symbols. */
  why?: string;
}

// Shared bodies for extensions that are the same language.
const TS = `export interface Opts { retries: number }
export class Client {
  constructor(private opts: Opts) {}
  async fetchUser(id: string): Promise<Opts> { return this.opts; }
}
export function makeClient(o: Opts) { return new Client(o); }
export const DEFAULTS: Opts = { retries: 3 };`;

const JSX = `export default function Card({ title }) { return <div>{title}</div>; }
export const Badge = ({ n }) => <span>{n}</span>;
function useCardState() { return null; }`;

const JS = `function initApp() {}
const helper = () => {};
module.exports = { initApp };`;

const APEX = `public with sharing class AccountSvc implements Queueable {
    @AuraEnabled(cacheable=true)
    public static List<Account> getTop(Integer n) { return null; }
    @AuraEnabled public static Map<String, List<Account>> search(String q) { return null; }
    @future(callout=true) public static void syncRemote(Set<Id> ids) {}
    @isTest static void testGetTop() {}
    static testMethod void legacyTest() {}
    private class Inner { Integer x; }
    public AccountSvc() {}
    void execute(QueueableContext ctx) {}
}`;

const FIXTURES: Record<string, Fixture> = {
  // DEFAULTS is deliberately absent: `const X = { … }` is data, not a
  // declaration you navigate to, and indexing every object literal would flood
  // find_definition. Arrow-function consts ARE indexed — those are callable.
  ".ts": { src: TS, expect: ["Opts", "Client", "fetchUser", "makeClient"] },
  ".tsx": { src: JSX, expect: ["Card", "Badge", "useCardState"] },
  ".js": { src: JS, expect: ["initApp", "helper"] },
  ".jsx": { src: JSX, expect: ["Card", "Badge", "useCardState"] },
  ".mjs": { src: `export function loadConfig() {}\nexport default class Runner {}`, expect: ["loadConfig", "Runner"] },
  ".cjs": { src: JS, expect: ["initApp", "helper"] },
  ".py": {
    src: `class Repo:\n    def save(self, order):\n        pass\n\ndef helper(x):\n    return x * 2\n\nasync def fetch(url):\n    return None`,
    expect: ["Repo", "save", "helper", "fetch"],
  },
  ".go": {
    src: `package main\n\ntype Store struct { db *DB }\n\nfunc (s *Store) Save(o Order) error { return nil }\n\nfunc NewStore(db *DB) *Store { return nil }`,
    expect: ["Store", "Save", "NewStore"],
  },
  ".rs": {
    src: `pub struct Config { pub retries: u32 }\n\nimpl Config {\n    pub fn new() -> Self { Config { retries: 3 } }\n}\n\npub fn load() -> Config { Config::new() }\n\npub enum Mode { Fast, Safe }`,
    expect: ["Config", "new", "load", "Mode"],
  },
  ".java": {
    src: `public class OrderService {\n    public record Decision(String action, double price) {}\n    public Map<String, List<Order>> groupBy(List<Order> os) { return null; }\n    private void helper() {}\n}\ninterface Repo { void save(Order o); }\nenum Status { NEW, PAID }`,
    expect: ["OrderService", "Decision", "groupBy", "helper", "Repo", "Status"],
  },
  ".cs": {
    src: `namespace App {\n    public class UserService {\n        public async Task<int> GetUser(string id) { return 0; }\n        private void Log() {}\n    }\n    public interface IRepo { void Save(); }\n}`,
    expect: ["UserService", "GetUser", "Log", "IRepo"],
  },
  ".rb": {
    src: `module Billing\n  class Invoice\n    def total\n      1\n    end\n    def self.build\n      new\n    end\n  end\nend`,
    expect: ["Billing", "Invoice", "total", "build"],
  },
  ".php": {
    src: `<?php\nclass OrderRepo {\n    public function save(Order $o) {}\n    private static function helper() {}\n}\nfunction bootstrap() {}`,
    expect: ["OrderRepo", "save", "helper", "bootstrap"],
  },
  ".c": { src: `int add(int a, int b) {\n    return a + b;\n}\n\nstatic void helper(void) {}`, expect: ["add", "helper"] },
  ".h": { src: `struct Point { int x; };\n\nint add(int a, int b);\n\ntypedef struct Node Node;`, expect: ["Point"] },
  ".cpp": {
    src: `class Engine {\npublic:\n    void start();\n};\n\nvoid Engine::start() {}\n\nint main(int argc, char** argv) { return 0; }`,
    expect: ["Engine", "start", "main"],
  },
  ".hpp": { src: `class Widget {\npublic:\n    void draw();\n};`, expect: ["Widget"] },
  ".cc": { src: `void Engine::stop() {}\n\nint helper(int x) { return x; }`, expect: ["stop", "helper"] },
  ".kt": {
    src: `class UserRepo(private val db: Db) {\n    fun findAll(): List<User> = emptyList()\n    suspend fun load(id: String): User? = null\n}\n\nfun topLevel() {}`,
    expect: ["UserRepo", "findAll", "load", "topLevel"],
  },
  ".swift": {
    src: `class ViewModel {\n    func reload() {}\n    private func helper() -> Int { return 1 }\n}\n\nstruct Item { let id: String }`,
    expect: ["ViewModel", "reload", "helper", "Item"],
  },
  ".scala": {
    src: `class Service(repo: Repo) {\n  def run(x: Int): Int = x\n  private def helper = 1\n}\n\nobject Service {\n  def apply() = new Service(null)\n}`,
    expect: ["Service", "run", "helper"],
  },
  ".m": {
    src: `@implementation ViewController\n\n- (void)viewDidLoad {\n}\n\n+ (instancetype)shared {\n    return nil;\n}\n\n@end`,
    expect: ["ViewController", "viewDidLoad", "shared"],
  },
  ".mm": { src: `@implementation Bridge\n\n- (void)send:(NSString *)msg {\n}\n\n@end`, expect: ["Bridge", "send"] },
  ".cls": { src: APEX, expect: ["AccountSvc", "getTop", "search", "syncRemote", "testGetTop", "legacyTest", "Inner", "execute"] },
  ".trigger": {
    src: `trigger AccountTrigger on Account (before insert, after update) {\n    AccountSvc.syncRemote(Trigger.newMap.keySet());\n}`,
    expect: ["AccountTrigger"],
  },
  ".vue": {
    src: `<script setup>\nfunction onSubmit() {}\nconst total = computed(() => 1);\n</script>\n<template><div/></template>`,
    expect: ["onSubmit", "total"],
  },
  ".svelte": { src: `<script>\nexport function reset() {}\nfunction handleClick() {}\n</script>`, expect: ["reset", "handleClick"] },
  ".html": {
    src: `<div id="app"></div>\n<script>\nfunction initApp() {}\n</script>`,
    expect: ["initApp"],
  },
  ".htm": { src: `<script>\nfunction legacyBoot() {}\n</script>`, expect: ["legacyBoot"] },
  ".scss": {
    src: `@function rem($px) { @return $px / 16 * 1rem; }\n.card { color: red; }`,
    expect: ["rem"],
  },
  ".css": {
    src: `.btn-primary { color: red; }\n#header { top: 0; }`,
    expect: [],
    why:
      "CSS has no callable declarations. Indexed anyway so read_lines / search_code / " +
      "get_file_skeleton work on stylesheets — which frontend repos genuinely need — " +
      "but a selector is not a symbol and inventing one would pollute find_definition.",
  },
  ".less": {
    src: `.mixin(@c) { color: @c; }\n.btn { .mixin(red); }`,
    expect: [],
    why: "Same as .css — LESS mixins are selectors, not declarations the symbol tools should resolve.",
  },
};

/**
 * Files reached by NAME SUFFIX rather than extension. These are indexed for
 * search and read reach, not for symbols — the same standing as CSS, and the
 * reason each one carries a `why`.
 */
const SUFFIX_FIXTURES: Record<string, Fixture> = {
  "-meta.xml": {
    src: `<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <isExposed>true</isExposed>
</LightningComponentBundle>`,
    expect: [],
    why:
      "Salesforce metadata sidecars decide API version, visibility and field-level " +
      "security, so they must be searchable — but a <fullName> tag is not a declaration " +
      "find_definition should resolve to.",
  },
};

describe("every indexed extension is covered", () => {
  it("has a fixture for each entry in CODE_EXT", () => {
    const missing = CODE_EXT.filter((e) => !(e in FIXTURES));
    expect(
      missing,
      `Extensions in CODE_EXT with no fixture in this file. Adding an extension to the ` +
        `indexer promises the user that symbols come out of it — add a realistic snippet ` +
        `to FIXTURES (with expect: [] and a why: if it genuinely has none):\n  ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("has no fixture for an extension the indexer stopped walking", () => {
    // The other direction: a stale fixture is a test proving nothing.
    const orphans = Object.keys(FIXTURES).filter((e) => !CODE_EXT.includes(e));
    expect(orphans, `Fixtures for extensions no longer in CODE_EXT: ${orphans.join(", ")}`).toEqual([]);
  });

  it("has a fixture for each suffix-matched file type too", () => {
    // Suffix matching is a second doorway into the index (Salesforce
    // `-meta.xml`), and a doorway with no test is exactly how `.php`/`.kt` came
    // to be indexable with nothing behind them.
    const block = indexerSrc.match(/const INDEX_SUFFIXES = \[([\s\S]*?)\]/);
    expect(block, "could not find INDEX_SUFFIXES in src/indexer.ts").toBeTruthy();
    const suffixes = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const missing = suffixes.filter((s) => !(s in SUFFIX_FIXTURES));
    expect(missing, `INDEX_SUFFIXES entries with no fixture: ${missing.join(", ")}`).toEqual([]);
  });

  it("documents why, for every extension that yields nothing", () => {
    const undocumented = Object.entries(FIXTURES)
      .filter(([, f]) => f.expect.length === 0 && !f.why)
      .map(([e]) => e);
    expect(undocumented, `Empty expectations need a why: ${undocumented.join(", ")}`).toEqual([]);
  });
});

describe.each(Object.entries(FIXTURES))("%s", (ext, fixture) => {
  const got = extractSymbols(fixture.src).map((s) => s.name);

  if (fixture.expect.length === 0) {
    it(`yields no symbols, by design — ${fixture.why}`, () => {
      expect(got).toEqual([]);
    });
    return;
  }

  it("extracts every declaration a developer would navigate to", () => {
    const missed = fixture.expect.filter((w) => !got.includes(w));
    expect(missed, `${ext}: not extracted: ${missed.join(", ")}\nGot: ${got.join(", ") || "(nothing)"}`).toEqual([]);
  });

  it("does not index the file into nothing", () => {
    // The .php/.kt/.swift/.scala failure mode: extension listed, no rules behind
    // it, every file silently empty.
    expect(got.length, `${ext} produced no symbols at all`).toBeGreaterThan(0);
  });
});

describe("Apex, in the shapes Salesforce actually writes", () => {
  // Called out separately because Apex is the case where an annotation's
  // placement — same line vs own line — decided whether a method existed.
  const one = (src: string) => extractSymbols(src).map((s) => s.name);

  it("finds a method whose annotation shares the signature's line", () => {
    expect(one(`    @isTest static void t() {}`)).toContain("t");
    expect(one(`    @AuraEnabled public static void go() {}`)).toContain("go");
    expect(one(`    @future(callout=true) public static void sync() {}`)).toContain("sync");
    expect(one(`    @TestSetup static void setup() {}`)).toContain("setup");
  });

  it("finds it identically when the annotation is on its own line", () => {
    // The invariant that was broken: a newline must not decide existence.
    expect(one(`    @isTest\n    static void t() {}`)).toContain("t");
  });

  it("finds legacy testMethod declarations", () => {
    expect(one(`    static testMethod void legacyTest() {}`)).toContain("legacyTest");
  });

  it("still refuses control flow and calls", () => {
    // The annotation prefix is optional and must not have loosened the guard.
    for (const line of ["    if (x > 1) {", "    for (Account a : accs) {", "    System.debug(msg);", "    return foo(1);"]) {
      expect(extractSymbols(line), `matched: ${line}`).toEqual([]);
    }
  });
});
