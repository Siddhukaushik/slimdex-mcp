// Coverage audit against real third-party code.
//
// Point it at directories full of code you did not write — node_modules is
// ideal, being thousands of files from hundreds of frameworks in every style
// from ES5 prototypes to modern TS. It reports what fraction of
// declaration-shaped lines the extractor actually finds.
//
//   node scripts/audit-coverage.mjs <dir> [dir...]
//
// The "truth" heuristic is written independently of the extraction rules, so
// agreement between the two means something. It is not perfect — it counts some
// non-declarations, so the real recall is a little higher than reported. Treat
// the number as a floor and a regression signal, not a grade.

// Scan a large body of real framework code and find files where extraction
// clearly under-performs. The "truth" heuristic below is deliberately written
// independently of the extraction rules — it looks for declaration-shaped lines
// by a different route, so agreement between the two is meaningful.

import { extractSymbols } from "../dist/symbols.js";
import fs from "node:fs";
import path from "node:path";

const roots = process.argv.slice(2);
const EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".php"]);

// Independent ground truth: lines that a human would call a declaration.
const TRUTH = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$]/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+[A-Za-z_$]/,
  /^\s*(?:export\s+)?interface\s+[A-Za-z_$]/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:function|\()/,
  /^\s*(?:async\s+)?def\s+[A-Za-z_]/,
  /^\s*func\s+/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+/,
  /^\s*(?:public|private|protected)\s+[\w<>\[\],.\s]+\s+[A-Za-z_]\w*\s*\(/,
];

function truthCount(src) {
  let n = 0;
  for (const line of src.split(/\r?\n/)) {
    if (line.length > 400) continue; // minified
    for (const re of TRUTH) if (re.test(line)) { n++; break; }
  }
  return n;
}

function* walk(dir, depth = 0) {
  if (depth > 12) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { yield* walk(p, depth + 1); }
    else if (EXT.has(path.extname(e.name))) yield p;
  }
}

let scanned = 0, skipped = 0, totalTruth = 0, totalFound = 0;
const failures = [];
const byExt = {};

for (const root of roots) {
  for (const f of walk(root)) {
    let src;
    try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    if (src.length > 400_000) { skipped++; continue; }
    // Skip minified bundles: they are one enormous line and not what anyone navigates.
    const lines = src.split(/\r?\n/);
    if (lines.length < 5 || src.length / lines.length > 200) { skipped++; continue; }

    const truth = truthCount(src);
    if (truth === 0) continue; // nothing to detect; not evidence either way

    const found = extractSymbols(src).length;
    scanned++; totalTruth += truth; totalFound += Math.min(found, truth);

    const ext = path.extname(f);
    byExt[ext] ??= { files: 0, truth: 0, found: 0, zero: 0 };
    byExt[ext].files++; byExt[ext].truth += truth; byExt[ext].found += Math.min(found, truth);

    if (found === 0) { byExt[ext].zero++; failures.push({ f, truth, found }); }
    else if (truth >= 6 && found < truth * 0.4) failures.push({ f, truth, found });
  }
}

console.log(`scanned ${scanned} files (skipped ${skipped} minified/huge)`);
console.log(`declaration-ish lines: ${totalTruth}   matched by extractor: ${totalFound}  (${((totalFound / totalTruth) * 100).toFixed(1)}%)\n`);
console.log("ext      files    recall   zero-symbol files");
for (const [ext, s] of Object.entries(byExt).sort((a, b) => b[1].files - a[1].files)) {
  console.log(`${ext.padEnd(8)} ${String(s.files).padStart(5)}    ${((s.found / s.truth) * 100).toFixed(1).padStart(5)}%   ${s.zero}`);
}
console.log(`\nworst cases (${failures.length} total):`);
for (const x of failures.sort((a, b) => b.truth - a.truth).slice(0, 12)) {
  console.log(`  truth ${String(x.truth).padStart(3)}  found ${String(x.found).padStart(3)}  ${x.f.replace(/.*node_modules[\\/]/, "")}`);
}
