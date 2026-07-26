#!/usr/bin/env node
// Run the indexer over real repositories and report where it comes up empty.
//
// WHY THIS EXISTS
// Every parser gap this project has fixed was found the same slow way: a human
// read an AI session transcript days later and noticed a tool had answered "No
// definition indexed" for something that plainly existed. That found Java
// `record`, Apex same-line annotations, and single-line C/C++ bodies — but only
// after each had shipped, and only for the shapes those particular sessions
// happened to touch.
//
// Hand-written fixtures have the same blind spot in a different form: they test
// the shapes the author thought of. Real repositories don't care what anyone
// thought of.
//
// WHAT IT MEASURES
// Per language: how many indexed files yield ZERO symbols. That single number is
// the honest health check — a rule set that misses a common idiom shows up as a
// pile of empty files, and the sample paths tell you which idiom. It is a signal,
// not a verdict: some files legitimately have no declarations (constants, CSS,
// re-export barrels), so read the rate and the samples together.
//
// USAGE
//   node scripts/corpus-audit.mjs                 # default corpus
//   node scripts/corpus-audit.mjs --keep          # don't delete clones
//   node scripts/corpus-audit.mjs --repo url#name # audit one repo
//   node scripts/corpus-audit.mjs --local <path>  # audit a checkout you have

import { execFileSync } from "node:child_process";
import { promises as fs, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildOrRefresh } from "../dist/indexer.js";

// One well-known, idiomatic repo per language. Small enough to clone shallow,
// real enough to contain the idioms a synthetic fixture never thinks of.
const CORPUS = [
  ["python", "https://github.com/pallets/click.git"],
  ["typescript", "https://github.com/sindresorhus/got.git"],
  ["javascript", "https://github.com/expressjs/express.git"],
  ["go", "https://github.com/spf13/cobra.git"],
  ["rust", "https://github.com/BurntSushi/ripgrep.git"],
  ["java", "https://github.com/google/gson.git"],
  ["csharp", "https://github.com/dotnet/csharplang.git"],
  ["ruby", "https://github.com/sinatra/sinatra.git"],
  ["php", "https://github.com/guzzle/guzzle.git"],
  ["c", "https://github.com/antirez/sds.git"],
  ["cpp", "https://github.com/nlohmann/json.git"],
  ["kotlin", "https://github.com/square/okio.git"],
  ["swift", "https://github.com/Alamofire/Alamofire.git"],
  ["scala", "https://github.com/scalaz/scalaz.git"],
  ["apex", "https://github.com/trailheadapps/apex-recipes.git"],
  ["lwc-js", "https://github.com/trailheadapps/lwc-recipes.git"],
  ["vue", "https://github.com/vuejs/core.git"],
  ["svelte", "https://github.com/sveltejs/svelte.git"],
];

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : null;
};

function clone(url, dest) {
  execFileSync("git", ["clone", "--depth", "1", "--quiet", url, dest], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 180_000,
  });
}

/** Index one checkout and bucket its files by extension. */
async function audit(label, root) {
  const t0 = Date.now();
  const r = await buildOrRefresh(root, true);
  const ms = Date.now() - t0;

  const byExt = new Map();
  for (const [rel, entry] of Object.entries(r.index.files)) {
    const ext = path.extname(rel).toLowerCase();
    const b = byExt.get(ext) ?? { files: 0, empty: 0, symbols: 0, lines: 0, samples: [] };
    b.files++;
    b.symbols += entry.symbols.length;
    b.lines += entry.lines;
    // A tiny file with no declarations is noise; an empty file of real size is
    // the interesting case — that's where a missed idiom hides.
    if (entry.symbols.length === 0) {
      b.empty++;
      if (entry.lines >= 30 && b.samples.length < 3) b.samples.push(`${rel} (${entry.lines}L)`);
    }
    byExt.set(ext, b);
  }
  return { label, ms, result: r, byExt };
}

function report(a) {
  const { label, ms, result, byExt } = a;
  const rows = [...byExt.entries()].filter(([, b]) => b.files >= 3).sort((x, y) => y[1].files - x[1].files);
  console.log(`\n=== ${label} — ${result.totalFiles} files, ${ms}ms` + (result.generated ? `, ${result.generated} generated/minified skipped` : "") + " ===");
  if (!rows.length) return [];

  const flagged = [];
  console.log("  ext      files   empty   rate   sym/file");
  for (const [ext, b] of rows) {
    const rate = b.empty / b.files;
    const mark = rate >= 0.5 ? "  <== HIGH" : rate >= 0.25 ? "  <-- check" : "";
    console.log(
      `  ${ext.padEnd(8)} ${String(b.files).padStart(5)} ${String(b.empty).padStart(7)} ${(rate * 100).toFixed(0).padStart(5)}% ${(b.symbols / b.files).toFixed(1).padStart(9)}${mark}`
    );
    if (rate >= 0.25 && b.samples.length) {
      for (const s of b.samples) console.log(`      empty: ${s}`);
      flagged.push({ label, ext, rate, files: b.files, samples: b.samples });
    }
  }
  return flagged;
}

const audits = [];
const local = flag("--local");
const single = flag("--repo");

if (local) {
  audits.push(await audit(path.basename(local), path.resolve(local)));
} else {
  const targets = single ? [[single.split("#")[1] ?? "repo", single.split("#")[0]]] : CORPUS;
  const work = mkdtempSync(path.join(tmpdir(), "slimdex-corpus-"));
  console.log(`Cloning ${targets.length} repo(s) into ${work}`);
  for (const [label, url] of targets) {
    const dest = path.join(work, label);
    try {
      if (!existsSync(dest)) clone(url, dest);
    } catch (e) {
      console.log(`\n=== ${label} — CLONE FAILED (${String(e.message).split("\n")[0]}) ===`);
      continue;
    }
    try {
      audits.push(await audit(label, dest));
    } catch (e) {
      console.log(`\n=== ${label} — INDEX FAILED: ${e.message} ===`);
    }
  }
  if (!keep) await fs.rm(work, { recursive: true, force: true }).catch(() => {});
}

const flagged = audits.flatMap(report);

console.log("\n" + "=".repeat(64));
if (!flagged.length) {
  console.log("No extension over the 25% empty-file threshold. Nothing to chase.");
} else {
  console.log("Extensions worth investigating (>=25% of indexed files yielded no symbols):");
  for (const f of flagged.sort((a, b) => b.rate - a.rate)) {
    console.log(`  ${f.label}/${f.ext}: ${(f.rate * 100).toFixed(0)}% of ${f.files} files`);
  }
  console.log("\nA high rate is a lead, not a bug: barrels, constants files and CSS are");
  console.log("legitimately empty. Open a sample before changing a rule.");
}
