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
