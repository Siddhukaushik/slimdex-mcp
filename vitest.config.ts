import { defineConfig } from "vitest/config";

// Why this file exists: slimdex's own safety snapshots copy every uncommitted
// file into .slimdex/snapshots/<stamp>/, which includes test files while they
// are still unstaged. Vitest's default include glob then collects those copies
// and fails them — the copied test imports `../src/...`, which does not resolve
// from inside the snapshot directory.
//
// The cache directory is already excluded from the index and self-gitignored;
// this closes the same hole for the test runner. Anything under .slimdex is a
// copy or a cache, never a source of truth.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.slimdex/**"],
  },
});
