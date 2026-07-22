// Per-language extraction coverage.
//
// The extension list in indexer.ts is a promise: if a file type is in it, the
// user reasonably expects symbols out of it. This suite is what keeps that
// promise honest — .php, .kt, .swift and .scala were all in the list for a
// while with no rules backing them, so those files indexed to nothing and no
// test noticed.
//
// Each case lists the declarations a developer would expect to navigate to.

import { describe, it, expect } from "vitest";
import { extractSymbols } from "../src/symbols.js";

function names(src: string): string[] {
  return extractSymbols(src).map((s) => s.name);
}

function expectAll(src: string, wanted: string[]) {
  const got = names(src);
  for (const w of wanted) expect(got, `expected to find "${w}" in:\n${src}`).toContain(w);
}

describe("Java", () => {
  const src = [
    "public class OrderService {",
    "    public OrderService(Repo repo) { this.repo = repo; }",
    "    public Map<String, List<Order>> groupByCustomer(List<Order> orders) {",
    "    }",
    "    protected static <T> Optional<T> firstOf(List<T> xs) { return null; }",
    "    private void helper() {}",
    "}",
    "interface Repo { void save(Order o); }",
    "enum Status { NEW, PAID }",
  ].join("\n");

  it("finds classes, interfaces, enums and methods", () => {
    expectAll(src, ["OrderService", "groupByCustomer", "helper", "Repo", "Status"]);
  });

  it("finds a method with a leading generic type parameter", () => {
    // `static <T> Optional<T> firstOf(…)` — the <T> before the return type.
    expectAll(src, ["firstOf"]);
  });
});

describe("C#", () => {
  it("finds async, generic and virtual members", () => {
    const src = [
      "namespace App {",
      "    public class UserService {",
      "        public async Task<int> GetUserAsync(string id) { return 1; }",
      "        private static Dictionary<string, object> Build() { return null; }",
      "        protected virtual void OnChanged() { }",
      "    }",
      "    public interface IRepo { void Save(); }",
      "    public struct Point { public int X; }",
      "}",
    ].join("\n");
    expectAll(src, ["UserService", "GetUserAsync", "Build", "OnChanged", "IRepo", "Point"]);
  });
});

describe("Apex", () => {
  it("finds annotated, global and generic-returning methods", () => {
    const src = [
      "public with sharing class ACH_Service {",
      "    @AuraEnabled(cacheable=true)",
      "    public static Map<String, Decimal> getSummary() { return null; }",
      "    global static List<Account> getAccounts() { return null; }",
      "    private static Set<Id> ids() { return null; }",
      "    public class Wrapper { public String name; }",
      "}",
    ].join("\n");
    expectAll(src, ["ACH_Service", "getSummary", "getAccounts", "ids", "Wrapper"]);
  });

  it("finds a trigger declaration", () => {
    const src = "trigger CommitmentTrigger on SK_ACH_Commitment__c (before insert, after update) {\n}";
    expect(names(src)).toContain("CommitmentTrigger");
  });
});

describe("Kotlin", () => {
  it("finds fun, suspend fun, data class and object", () => {
    const src = [
      "class UserService(private val repo: Repo) {",
      "    fun getUser(id: String): User? = null",
      "    suspend fun loadAll(): List<User> { return emptyList() }",
      "    private fun helper() {}",
      "}",
      "data class User(val id: String)",
      "interface Repo { fun save(u: User) }",
      "object Singleton { fun go() {} }",
    ].join("\n");
    expectAll(src, ["UserService", "getUser", "loadAll", "helper", "User", "Repo", "Singleton"]);
  });
});

describe("Swift", () => {
  it("finds func, static func, struct and protocol", () => {
    const src = [
      "class UserService {",
      "    func getUser(id: String) -> User? { return nil }",
      "    private func helper() { }",
      "    static func build() -> UserService { return UserService() }",
      "}",
      "struct User { let id: String }",
      "protocol Repo { func save(_ u: User) }",
      "enum Status { case new, paid }",
    ].join("\n");
    expectAll(src, ["UserService", "getUser", "helper", "build", "User", "Repo", "Status"]);
  });
});

describe("Scala", () => {
  it("finds def with preceding modifiers", () => {
    const src = [
      "class UserService(repo: Repo) {",
      "  def getUser(id: String): Option[User] = None",
      "  private def helper(): Unit = {}",
      "}",
      "trait Repo { def save(u: User): Unit }",
      "case class User(id: String)",
    ].join("\n");
    expectAll(src, ["UserService", "getUser", "helper", "Repo", "User"]);
  });
});

describe("Ruby", () => {
  it("captures the method name from `def self.build`, not `self`", () => {
    const src = ["class Invoice", "  def self.build; new(1); end", "  def total_amount; 0; end", "end"].join("\n");
    const got = names(src);
    expect(got).toContain("build");
    expect(got).toContain("total_amount");
    expect(got).not.toContain("self");
  });

  it("finds attr_accessor / attr_reader / attr_writer declarations", () => {
    const src = [
      "class Account",
      "  attr_accessor :balance, :owner",
      "  attr_reader :created_at",
      "  attr_writer :flagged?",
      "end",
    ].join("\n");
    expectAll(src, ["balance", "created_at", "flagged?"]);
  });
});

describe("C / C++", () => {
  it("finds unindented free functions, including pointer returns and K&R braces", () => {
    const src = [
      "#include <stdio.h>",
      "static void helper(void) {",
      "}",
      "char *duplicate(const char *s) {",
      "}",
      "int main(int argc, char **argv)",
      "{",
      "  return 0;",
      "}",
      "int prototype_only(int x);", // declaration, not definition — stays out
    ].join("\n");
    const got = names(src);
    expectAll(src, ["helper", "duplicate", "main"]);
    expect(got).not.toContain("prototype_only");
  });

  it("finds qualified out-of-class definitions, ctors and dtors", () => {
    const src = [
      "void Widget::render(const Ctx &ctx) {",
      "}",
      "Widget::Widget() : id_(0) {",
      "}",
      "Widget::~Widget() {",
      "}",
      "int Registry::count() const noexcept {",
      "}",
      "Widget::render(ctx);", // a qualified *call* must not register
    ].join("\n");
    const got = names(src);
    expectAll(src, ["render", "Widget", "~Widget", "count"]);
    expect(got.filter((n) => n === "render").length).toBe(1);
  });

  it("finds namespaces, function-like macros and typedef'd structs", () => {
    const src = [
      "namespace app::detail {",
      "}",
      "#define MAX(a, b) ((a) > (b) ? (a) : (b))",
      "#define PLAIN_CONSTANT 42", // object-like: deliberately not indexed
      "typedef struct {",
      "  int x;",
      "} Point;",
    ].join("\n");
    const got = names(src);
    expectAll(src, ["app::detail", "MAX", "Point"]);
    expect(got).not.toContain("PLAIN_CONSTANT");
  });

  it("does not mistake top-level scripting-language calls for C functions", () => {
    expect(names("assert validate(x)\n")).toEqual([]);
    expect(names("puts render(x)\n")).toEqual([]);
    expect(names('export default connect(mapState)(App);\n')).toEqual([]);
  });
});

describe("Objective-C", () => {
  it("finds @interface / @implementation / @protocol containers", () => {
    const src = [
      "@interface PhotoView : UIView",
      "@end",
      "@implementation PhotoView",
      "- (void)renderInto:(CGRect)rect {",
      "}",
      "@end",
      "@protocol Cachable",
      "@end",
    ].join("\n");
    expectAll(src, ["PhotoView", "renderInto", "Cachable"]);
  });
});

describe("PHP", () => {
  it("finds classes, methods, functions, interfaces and traits", () => {
    const src = [
      "<?php",
      "class UserRepository {",
      "    public function findById(int $id): ?User { return null; }",
      "    private static function build(): self { return new self(); }",
      "}",
      "function helper_fn(array $x): void {}",
      "interface Jsonable { public function toJson(): string; }",
      "trait Timestamps { }",
    ].join("\n");
    expectAll(src, ["UserRepository", "findById", "build", "helper_fn", "Jsonable", "Timestamps"]);
  });
});

describe("Go", () => {
  it("finds funcs, receivers and types", () => {
    const src = [
      "type Server struct { addr string }",
      "type Handler interface { Serve() }",
      "func NewServer(addr string) *Server { return &Server{addr} }",
      "func (s *Server) Start() error { return nil }",
      "func helper() {}",
    ].join("\n");
    expectAll(src, ["Server", "Handler", "NewServer", "Start", "helper"]);
  });
});

describe("Rust", () => {
  it("does not lose a trait to an inline fn on the same line", () => {
    // One symbol is taken per line, so container rules must be checked first;
    // otherwise this reports `serve` and the trait disappears.
    expect(names("pub trait Handler { fn serve(&self); }")).toContain("Handler");
  });

  it("finds structs, enums, impl methods and free functions", () => {
    const src = [
      "pub struct Server { addr: String }",
      "pub enum Status { New, Paid }",
      "impl Server {",
      "    pub fn new(addr: String) -> Self { Server { addr } }",
      "    pub async fn start(&self) -> Result<(), Error> { Ok(()) }",
      "}",
      "fn helper() {}",
    ].join("\n");
    expectAll(src, ["Server", "Status", "new", "start", "helper"]);
  });
});

describe("Python", () => {
  it("finds classes, dunder, async and decorated methods", () => {
    const src = [
      "class UserService:",
      "    def __init__(self, repo):",
      "        self.repo = repo",
      "    async def get_user(self, id: str) -> 'User':",
      "        return None",
      "    @staticmethod",
      "    def build():",
      "        return UserService(None)",
      "def helper(x): return x",
    ].join("\n");
    expectAll(src, ["UserService", "__init__", "get_user", "build", "helper"]);
  });
});

describe("framework idioms (fflib, Spring, DI-style code)", () => {
  it("finds interface method declarations that have no body and no modifier", () => {
    // Interface-heavy frameworks are mostly these, and they're exactly the names
    // you navigate to. The modifier-required method rules miss them entirely.
    const src = [
      "public interface IAccountService {",
      "    void createAccounts(List<Account> accs);",
      "    Map<Id, Account> byId(Set<Id> ids);",
      "}",
    ].join("\n");
    expectAll(src, ["IAccountService", "createAccounts", "byId"]);
  });

  it("does not mistake ordinary statements for declarations", () => {
    // `return foo(x);` parses as return-type `return`, name `foo` without a
    // guard, which would index every return statement in the codebase.
    const src = [
      "class C {",
      "    void m() {",
      "        return foo(x);",
      "        this.helper(a);",
      "        Logger.debug('m');",
      "        int y = calc(z);",
      "        obj.method(1);",
      "    }",
      "}",
    ].join("\n");
    expect(names(src).sort()).toEqual(["C", "m"]);
  });

  it("handles annotated, inherited-sharing, extending and implementing classes", () => {
    const src = [
      "@RestResource(urlMapping='/v1/accounts/*')",
      "global with sharing class AccountApi extends fflib_SObjectDomain implements Database.Batchable<SObject> {",
      "    public inherited sharing class Inner implements fflib_SObjectDomain.IConstructable {",
      "        public fflib_SObjectDomain construct(List<SObject> records) { return null; }",
      "    }",
      "    global Database.QueryLocator start(Database.BatchableContext bc) { return null; }",
      "    @AuraEnabled(cacheable=true)",
      "    public static List<Map<String, Object>> query(String soql) { return null; }",
      "    public override void onApplyDefaults() { }",
      "    private AccountApi() { }",
      "}",
    ].join("\n");
    expectAll(src, ["AccountApi", "Inner", "construct", "start", "query", "onApplyDefaults"]);
  });

  it("finds constructors, which have no return type", () => {
    const src = ["public class Application {", "    private Application() { }", "}"].join("\n");
    expect(names(src).filter((n) => n === "Application").length).toBe(2); // class + constructor
  });
});

describe("real-world JS shapes (found by auditing node_modules)", () => {
  it("finds a function expression assigned to a variable", () => {
    // The single most-missed shape across ~12,000 real framework files:
    // arrows were handled, `= function` was not.
    expect(names("var slc = function (v, s, e) {\n};")).toContain("slc");
  });

  it("finds prototype and exports assignments", () => {
    const src = [
      "Foo.prototype.render = function () {};",
      "exports.parse = function (s) {};",
      "module.exports.stringify = async function (o) {};",
    ].join("\n");
    expectAll(src, ["render", "parse", "stringify"]);
  });

  it("finds function-valued properties in an object literal", () => {
    const src = ["const opts = {", "  onSuccess: function (res) {},", "  onError: async function (e) {},", "};"].join("\n");
    expectAll(src, ["onSuccess", "onError"]);
  });

  it("does not mistake a call to something merely starting with 'function'", () => {
    expect(names("const x = functionCall(1);")).not.toContain("x");
  });
});

describe("test DSLs", () => {
  it("indexes test titles, which are a test file's real navigable units", () => {
    const src = [
      'describe("Invoice totals", () => {',
      '  it("sums line items", () => {});',
      '  test("handles empty", () => {});',
      "});",
    ].join("\n");
    const got = extractSymbols(src).filter((s) => s.kind === "test").map((s) => s.name);
    expect(got).toEqual(["Invoice totals", "sums line items", "handles empty"]);
  });

  it("reads the title from the raw line even though masking blanks strings", () => {
    // The title lives inside a string literal, which masking blanks — so this
    // rule matches the original line. Without that it captured only spaces.
    const got = extractSymbols('test("literal string correct", () => {});');
    expect(got[0].name).toBe("literal string correct");
  });

  it("ignores a commented-out test", () => {
    expect(extractSymbols('// test("disabled case", () => {});').length).toBe(0);
  });
});
