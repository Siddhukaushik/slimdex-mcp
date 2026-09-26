import { describe, expect, it } from "vitest";
import { boundedLines } from "../src/line-budget.js";

describe("boundedLines", () => {
  it("pages large ranges without skipping or repeating lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `${i} ${"x".repeat(40)}`);
    const first = boundedLines(lines, 1, 20, 100);
    expect(first.next).toBeGreaterThan(1);
    const second = boundedLines(lines, first.next!, 20, 100);
    expect(second.body).toContain(`${String(first.next).padStart(5)}  `);
    expect(second.body).not.toContain(`${String(first.last).padStart(5)}  `);
  });

  it("returns one oversized line so paging always advances", () => {
    const result = boundedLines(["x".repeat(200), "next"], 1, 2, 100);
    expect(result.last).toBe(1);
    expect(result.next).toBe(2);
  });
});
