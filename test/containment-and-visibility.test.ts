// Security-audit follow-ups: one shared containment guard, and making a stale
// server process visible from inside a session.

import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { containmentError, escapesBase } from "../src/indexer.js";
import { checkRepeat, resetDedupe } from "../src/dedupe.js";

const roots: string[] = [];
afterEach(async () => {
  resetDedupe();
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

async function tmp(prefix: string): Promise<string> {
  const d = await fs.mkdtemp(path.join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

/** Symlink creation needs privileges on Windows; skip rather than fail there. */
async function canSymlink(dir: string): Promise<boolean> {
  try {
    await fs.writeFile(path.join(dir, "_t"), "x");
    await fs.symlink(path.join(dir, "_t"), path.join(dir, "_l"));
    return true;
  } catch {
    return false;
  }
}

describe("containmentError is the whole guard, not half of it", () => {
  it("rejects lexical traversal", async () => {
    const root = await tmp("cont-");
    expect(await containmentError(root, path.join(root, "..", "secrets"))).toMatch(/escapes/);
  });

  it("rejects a different drive / unrelated absolute root", () => {
    // path.relative("C:\\repo", "D:\\secrets") returns "D:\\secrets" — no ".."
    // anywhere in it, so a naive check sails straight through.
    expect(escapesBase(path.resolve("/elsewhere/secrets"))).toBe(true);
  });

  it("accepts a real file inside the root", async () => {
    const root = await tmp("cont-");
    await fs.writeFile(path.join(root, "a.ts"), "x");
    expect(await containmentError(root, path.join(root, "a.ts"))).toBeNull();
  });

  it("rejects an in-repo symlink pointing outside — the half that was missing", async () => {
    const root = await tmp("cont-");
    const outside = await tmp("outside-");
    if (!(await canSymlink(root))) return; // unprivileged Windows
    const secret = path.join(outside, "secret.txt");
    await fs.writeFile(secret, "s".repeat(2000));
    const link = path.join(root, "link.ts");
    await fs.symlink(secret, link);
    // Lexically this looks contained; only realpath catches it.
    expect(escapesBase(path.relative(root, link))).toBe(false);
    expect(await containmentError(root, link)).toMatch(/symlink/);
  });
});

describe("dedupe uses the same guard as the tool handlers", () => {
  it("does not hash a file reached through an escaping symlink", async () => {
    const root = await tmp("dd-");
    const outside = await tmp("dd-out-");
    if (!(await canSymlink(root))) return;
    await fs.writeFile(path.join(outside, "secret.txt"), "s".repeat(2000));
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.ts"));

    // No signature -> no suppression bookkeeping at all, and crucially the
    // bytes were never read. Before the shared guard, the lexical check passed
    // and this file was opened, hashed and seeded into the content cache.
    const d = await checkRepeat(root, "read_lines", { path: "link.ts" });
    expect(d.notice).toBeUndefined();
    expect(d.remember).toBeUndefined();
  });

  it("still works for an ordinary in-root file", async () => {
    const root = await tmp("dd-");
    await fs.writeFile(path.join(root, "a.ts"), "y".repeat(2000));
    expect((await checkRepeat(root, "read_lines", { path: "a.ts" })).remember).toBeTypeOf("function");
  });
});
