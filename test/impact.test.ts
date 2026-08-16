import { describe, expect, it } from "vitest";
import { impactLine, type Impact } from "../src/impact.js";

// The impact line rides on every single-symbol read, so its cost is paid
// constantly and its wording is load-bearing: it is the input to "is this safe
// to change alone?". These assert the two things that matter — that it stays
// one short line, and that the risky case is never the quiet one.

const imp = (files: string[], tests: string[] = [], capped = false): Impact => ({ files, tests, capped });

describe("impactLine", () => {
  it("names the first two referencing files and counts the rest", () => {
    const line = impactLine(imp(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]));
    expect(line).toContain("4 file(s) reference it");
    expect(line).toContain("src/a.ts, src/b.ts +2");
  });

  it("calls out missing coverage rather than staying silent about it", () => {
    // The whole point: no covering test is the difference between "change it
    // and run the suite" and "change it and hope".
    expect(impactLine(imp(["src/a.ts"]))).toContain("⚠ no covering tests");
    expect(impactLine(imp(["src/a.ts"], ["test/a.test.ts"]))).toContain("1 covering test file(s)");
  });

  it("says a lone symbol is safe instead of printing an empty impact", () => {
    expect(impactLine(imp([]))).toContain("safe to change alone");
  });

  it("marks counts as a floor when the scan hit its cap", () => {
    expect(impactLine(imp(["src/a.ts", "src/b.ts"], [], true))).toContain("2+ file(s)");
  });

  it("excludes test files from the reference count they are reported under", () => {
    // A symbol used by one module and three tests is a 1-dependent symbol with
    // good coverage, not a 4-dependent one — conflating them would read as risk.
    const line = impactLine(imp(["src/a.ts", "test/a.test.ts", "test/b.test.ts"], ["test/a.test.ts", "test/b.test.ts"]));
    expect(line).toContain("1 file(s) reference it");
    expect(line).toContain("2 covering test file(s)");
  });

  it("stays on one line and under ~120 chars, since it is paid on every read", () => {
    const line = impactLine(imp(["src/aaaaaaaaaaaa.ts", "src/bbbbbbbbbbbb.ts", "src/cccccccccc.ts"], ["test/x.test.ts"]));
    expect(line.split("\n").filter(Boolean)).toHaveLength(1);
    expect(line.length).toBeLessThan(120);
  });

  it("emits nothing when there is no impact to report", () => {
    expect(impactLine(null)).toBe("");
  });
});
