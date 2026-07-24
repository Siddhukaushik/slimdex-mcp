// Test-to-code linkage: deciding whether a file is a test, so "which tests
// exercise this symbol" can be answered by filtering references, not by a new
// index. Path convention is the primary signal; the caller layers on the
// `kind: "test"` symbol tag (describe/it/test titles) as a second signal for
// files that don't follow a naming convention.
//
// Heuristic on purpose — same honesty as the rest of the extractor. A file that
// holds tests but matches none of these patterns (and has no indexed `test`
// symbol) is invisible here; that's a miss we name rather than hide.

const TEST_PATTERNS: RegExp[] = [
  /(^|\/)__tests__\//i, // JS/TS convention dir
  /(^|\/)tests?\//i, //   test/ or tests/ dir (JS, Java, C#, generic)
  /(^|\/)spec\//i, //      spec/ dir (Ruby, JS)
  /\.(test|spec)\.[cm]?[jt]sx?$/i, // foo.test.ts, foo.spec.jsx, foo.test.mjs
  /(^|\/)test_[^/]+\.py$/i, //       test_foo.py (pytest/unittest)
  /_test\.py$/i, //                  foo_test.py
  /_test\.go$/i, //                  foo_test.go
  /_spec\.rb$/i, //                  foo_spec.rb
  /_test\.rb$/i, //                  foo_test.rb
  /[A-Za-z0-9]Tests?\.(java|kt|cs|scala|swift)$/, // FooTest.java, BarTests.cs
  /\.test\.(php)$/i, //              foo.test.php
];

/** True when the repo-relative POSIX path looks like a test file. */
export function isTestFile(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  return TEST_PATTERNS.some((re) => re.test(p));
}
