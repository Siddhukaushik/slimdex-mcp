// changed_files `base` must not reach git as an OPTION.
//
// git treats any argv element starting with "-" as an option wherever it
// appears, and `base` comes straight from a tool call. Before the guard,
// base="--output=<path>" made changed_files write the diff to an arbitrary path
// outside the repo. execFile stops SHELL injection; this is the argv-level
// problem it does not address.

import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { changedFiles, assertUsableRef } from "../src/git.js";
import type { CodeIndex } from "../src/store.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

const emptyIndex = (): CodeIndex => ({ version: 3, builtAt: new Date().toISOString(), files: {} });

async function dirtyRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-gitopt-"));
  roots.push(root);
  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["config", "user.email", "t@example.com"], { cwd: root });
  await run("git", ["config", "user.name", "t"], { cwd: root });
  await fs.writeFile(path.join(root, "a.txt"), "one\n");
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "init"], { cwd: root });
  await fs.writeFile(path.join(root, "a.txt"), "two\n"); // make the tree dirty
  return root;
}

describe("changed_files base is not an option vector", () => {
  it("refuses --output= instead of writing a file outside the diff", async () => {
    const root = await dirtyRepo();
    const marker = path.join(root, "PWNED.txt");

    await expect(changedFiles(root, emptyIndex(), `--output=${marker}`)).rejects.toThrow(/reads as an option/);

    // The real assertion: the guard is what stopped the write, not luck.
    await expect(fs.stat(marker)).rejects.toThrow();
  }, 30_000);

  it("refuses any dash-leading base", () => {
    for (const bad of ["--ext-diff", "-p", "--no-index", "--output=/tmp/x"]) {
      expect(() => assertUsableRef(bad)).toThrow(/reads as an option/);
    }
  });

  it("still accepts ordinary revisions", async () => {
    const root = await dirtyRepo();
    for (const good of ["HEAD", "HEAD~0", "main", "refs/heads/main", "a1b2c3d"]) {
      expect(() => assertUsableRef(good)).not.toThrow();
    }
    // And the normal path keeps working end to end.
    const files = await changedFiles(root, emptyIndex(), "HEAD");
    expect(files.some((f) => f.file === "a.txt")).toBe(true);
  }, 30_000);
});
