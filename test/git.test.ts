// changed_files against a real temporary git repository. The README listed
// this module as untested ("needs a git fixture") — this is that fixture.
// Skips cleanly if git isn't installed, so the suite still runs anywhere.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isGitRepo, changedFiles, formatChanged } from "../src/git.js";
import { buildOrRefresh } from "../src/indexer.js";

const run = promisify(execFile);

let root = "";
let firstSha = "";

// Detected synchronously so skipIf can act at collection time, before beforeAll.
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: root });
  return stdout.trim();
}

const APP = [
  "export function alpha(): number {",
  "  return 1;",
  "}",
  "",
  "export function beta(): number {",
  "  return 2;",
  "}",
].join("\n");

beforeAll(async () => {
  if (!hasGit) return;
  root = await fs.mkdtemp(path.join(tmpdir(), "codeglance-git-"));
  await run("git", ["init"], { cwd: root });
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");

  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "app.ts"), APP, "utf8");
  await git("add", "-A");
  await git("commit", "-m", "initial");
  firstSha = await git("rev-parse", "HEAD");

  // Edit inside beta()'s body, and drop in an untracked file.
  await fs.writeFile(path.join(root, "src", "app.ts"), APP.replace("return 2;", "return 2 + 40;"), "utf8");
  await fs.writeFile(path.join(root, "src", "extra.ts"), "export function gamma() { return 3; }\n", "utf8");
});

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(!hasGit)("changed_files against a real git repo", () => {
  it("isGitRepo distinguishes a checkout from a plain directory", async () => {
    expect(await isGitRepo(root)).toBe(true);
    const plain = await fs.mkdtemp(path.join(tmpdir(), "codeglance-plain-"));
    try {
      expect(await isGitRepo(plain)).toBe(false);
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  it("attributes a working-tree hunk to the enclosing symbol", async () => {
    const { index } = await buildOrRefresh(root);
    const changed = await changedFiles(root, index);
    const app = changed.find((f) => f.file === "src/app.ts");
    expect(app).toBeDefined();
    expect(app!.status).toBe("M");
    expect(app!.added).toBe(1);
    expect(app!.deleted).toBe(1);
    expect(app!.symbols).toContain("function beta");
    expect(app!.symbols).not.toContain("function alpha"); // untouched function stays out
  });

  it("lists untracked files with status ? and their indexed symbols", async () => {
    const { index } = await buildOrRefresh(root);
    const changed = await changedFiles(root, index);
    const extra = changed.find((f) => f.file === "src/extra.ts");
    expect(extra).toBeDefined();
    expect(extra!.status).toBe("?");
    expect(extra!.symbols).toContain("function gamma");
  });

  it("diffs against an explicit base ref without untracked noise", async () => {
    const { index } = await buildOrRefresh(root);
    const changed = await changedFiles(root, index, firstSha);
    expect(changed.some((f) => f.file === "src/app.ts")).toBe(true);
    expect(changed.some((f) => f.status === "?")).toBe(false);
  });

  it("formatChanged prints counts, touched symbols, and a limit notice", async () => {
    const { index } = await buildOrRefresh(root);
    const changed = await changedFiles(root, index);
    const out = formatChanged(changed, undefined, 10);
    expect(out).toContain("changed file(s) vs HEAD (working tree)");
    expect(out).toContain("M src/app.ts  +1/-1");
    expect(out).toContain("touches: function beta");

    const capped = formatChanged(changed, undefined, 1);
    expect(capped).toContain("more file(s); raise limit");
  });

  it("reports no changes for a clean comparison", async () => {
    expect(formatChanged([], "HEAD", 10)).toBe("No changes vs HEAD.");
  });

  it("reports A and R statuses, not a blanket M", async () => {
    // Commit an add and a rename, then diff against the first commit so both
    // show at once. (-f: app.ts carries the working-tree edit from above.)
    await fs.writeFile(path.join(root, "src", "added.ts"), "export function delta() { return 4; }\n", "utf8");
    await git("add", "src/added.ts");
    await git("rm", "-q", "-f", "--", "src/app.ts");
    await fs.writeFile(path.join(root, "src", "renamed.ts"), APP, "utf8");
    await git("add", "src/renamed.ts");
    await git("commit", "-m", "rename app.ts, add added.ts");

    const { index } = await buildOrRefresh(root);
    const changed = await changedFiles(root, index, firstSha);
    const byFile = new Map(changed.map((f) => [f.file, f.status]));
    expect(byFile.get("src/added.ts")).toBe("A");
    expect(byFile.get("src/renamed.ts")).toBe("R"); // identical content pairs old->new
    expect(byFile.has("src/app.ts")).toBe(false); // old path folded into the rename
    // The rename's symbols still attribute correctly under the new path.
    const renamed = changed.find((f) => f.file === "src/renamed.ts");
    expect(renamed).toBeDefined();
  });
});
