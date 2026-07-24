import { describe, it, expect } from "vitest";
import { isTestFile } from "../src/testlink.js";

describe("isTestFile", () => {
  it("recognizes JS/TS conventions", () => {
    expect(isTestFile("src/math.test.ts")).toBe(true);
    expect(isTestFile("src/math.spec.jsx")).toBe(true);
    expect(isTestFile("src/a.test.mjs")).toBe(true);
    expect(isTestFile("packages/x/__tests__/foo.ts")).toBe(true);
    expect(isTestFile("test/foo.ts")).toBe(true);
    expect(isTestFile("tests/foo.ts")).toBe(true);
  });

  it("recognizes other languages", () => {
    expect(isTestFile("app/test_views.py")).toBe(true);
    expect(isTestFile("app/views_test.py")).toBe(true);
    expect(isTestFile("pkg/server_test.go")).toBe(true);
    expect(isTestFile("spec/user_spec.rb")).toBe(true);
    expect(isTestFile("src/CalculatorTest.java")).toBe(true);
    expect(isTestFile("src/CalculatorTests.cs")).toBe(true);
  });

  it("normalizes Windows separators", () => {
    expect(isTestFile("src\\__tests__\\foo.ts")).toBe(true);
    expect(isTestFile("test\\math.test.ts")).toBe(true);
  });

  it("does not flag ordinary source files", () => {
    expect(isTestFile("src/math.ts")).toBe(false);
    expect(isTestFile("src/latest.ts")).toBe(false); // "test" as a substring, not a path segment
    expect(isTestFile("src/greatest.py")).toBe(false);
    expect(isTestFile("lib/util.py")).toBe(false);
    expect(isTestFile("src/Contest.java")).toBe(false);
  });
});
