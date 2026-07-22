// Repo walking + incremental indexing. Walks the tree once, skipping the usual
// noise dirs and binary/large files, and (re)parses only files whose mtime
// changed since the last build. The result is cached to disk by store.ts.

import { promises as fs } from "node:fs";
import path from "node:path";
import { getParser } from "./parser.js";
import { loadIndex, saveIndex, INDEX_VERSION, type CodeIndex, type FileEntry } from "./store.js";

const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", "target",
  "__pycache__", ".venv", "venv", "env", ".idea", ".vscode", "coverage",
  ".slimdex", ".cache", "vendor", "bin", "obj", ".gradle", ".mvn",
  // Salesforce DX writes generated apex/lwc typings here — thousands of lines
  // of machine output with no symbols worth indexing.
  ".sfdx", ".sf",
]);

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
  ".java", ".cs", ".rb", ".php", ".c", ".h", ".cpp", ".hpp", ".cc",
  ".kt", ".swift", ".scala", ".m", ".mm", ".vue", ".svelte",
  // Apex. Syntactically Java-like, so the existing Java/C# rules find its
  // classes and methods without needing rules of their own.
  ".cls", ".trigger",
]);

const MAX_FILE_BYTES = 1_500_000; // skip anything larger; almost certainly generated

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

// Optional per-repo config at <root>/.slimdex.json:
//   { "ignoreDirs": ["fixtures"], "extensions": [".astro"], "exclude": ["generated/"],
//     "maxFileBytes": 2000000 }
interface SlimdexConfig {
  ignoreDirs: Set<string>;
  extensions: Set<string>;
  exclude: string[]; // substring match against repo-relative posix path
  maxFileBytes: number;
  // Reported back to the caller so a typo'd key or malformed JSON is visible in
  // index_repo's output. Silently swallowing config errors made a broken
  // .slimdex.json indistinguishable from having none at all.
  present: boolean;
  warnings: string[];
  summary: string;
}

const KNOWN_KEYS = new Set(["ignoreDirs", "extensions", "exclude", "maxFileBytes"]);

async function loadConfig(root: string): Promise<SlimdexConfig> {
  const ignoreDirs = new Set(IGNORE_DIRS);
  const extensions = new Set(CODE_EXT);
  const exclude: string[] = [];
  const warnings: string[] = [];
  let maxFileBytes = MAX_FILE_BYTES;
  let present = false;
  const added = { ignoreDirs: 0, extensions: 0, exclude: 0 };

  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, ".slimdex.json"), "utf8");
    present = true;
  } catch {
    return { ignoreDirs, extensions, exclude, maxFileBytes, present: false, warnings, summary: "no .slimdex.json (defaults)" };
  }

  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    warnings.push(`.slimdex.json is not valid JSON (${(e as Error).message}) — ignoring it and using defaults`);
    return { ignoreDirs, extensions, exclude, maxFileBytes, present, warnings, summary: "invalid .slimdex.json" };
  }

  for (const key of Object.keys(cfg)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown key "${key}" in .slimdex.json (known: ${[...KNOWN_KEYS].join(", ")})`);
  }

  const asArray = (key: string): unknown[] => {
    const v = cfg[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      warnings.push(`"${key}" must be an array — ignored`);
      return [];
    }
    return v;
  };

  for (const d of asArray("ignoreDirs")) {
    ignoreDirs.add(String(d));
    added.ignoreDirs++;
  }
  for (const e of asArray("extensions")) {
    const ext = String(e).toLowerCase();
    if (!ext.startsWith(".")) warnings.push(`extension "${e}" should start with a dot`);
    extensions.add(ext);
    added.extensions++;
  }
  for (const x of asArray("exclude")) {
    exclude.push(toPosix(String(x)));
    added.exclude++;
  }
  if (cfg.maxFileBytes !== undefined) {
    const n = Number(cfg.maxFileBytes);
    if (Number.isFinite(n) && n > 0) maxFileBytes = n;
    else warnings.push(`"maxFileBytes" must be a positive number — using default ${MAX_FILE_BYTES}`);
  }

  const summary =
    `.slimdex.json loaded (+${added.ignoreDirs} ignoreDirs, +${added.extensions} extensions, ` +
    `${added.exclude} exclude rules, maxFileBytes ${maxFileBytes})`;
  return { ignoreDirs, extensions, exclude, maxFileBytes, present, warnings, summary };
}

async function walk(root: string, dir: string, acc: string[], cfg: SlimdexConfig): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (cfg.ignoreDirs.has(e.name)) continue;
      await walk(root, full, acc, cfg);
    } else if (e.isFile()) {
      if (!cfg.extensions.has(path.extname(e.name).toLowerCase())) continue;
      const rel = toPosix(path.relative(root, full));
      if (cfg.exclude.some((x) => rel.includes(x))) continue;
      acc.push(full);
    }
  }
}

export interface IndexResult {
  index: CodeIndex;
  parsed: number;
  reused: number;
  removed: number;
  totalFiles: number;
  skipped: number; // over maxFileBytes
  parser: string;
  config: string; // human-readable config summary
  warnings: string[];
}

export async function buildOrRefresh(root: string, force = false): Promise<IndexResult> {
  // loadIndex now returns a cached object shared with every other caller, and
  // the loop below assigns into `index.files`. Copy the map first so a refresh
  // in progress can never mutate what other tool calls are reading. Entries are
  // replaced wholesale rather than edited, so a shallow copy is sufficient.
  const loaded = await loadIndex(root);
  const index: CodeIndex = force
    ? { version: INDEX_VERSION, builtAt: "", files: {} }
    : { ...loaded, files: { ...loaded.files } };

  const cfg = await loadConfig(root);
  const files: string[] = [];
  await walk(root, root, files, cfg);

  const present = new Set<string>();
  const parser = getParser();
  let parsed = 0;
  let reused = 0;
  let skipped = 0;

  for (const full of files) {
    const rel = toPosix(path.relative(root, full));
    present.add(rel);
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (stat.size > cfg.maxFileBytes) {
      skipped++;
      present.delete(rel); // not indexed, so don't treat it as still-present
      continue;
    }

    const existing = index.files[rel];
    if (existing && existing.mtimeMs === stat.mtimeMs) {
      reused++;
      continue;
    }
    let source: string;
    try {
      source = await fs.readFile(full, "utf8");
    } catch {
      continue;
    }
    const entry: FileEntry = {
      mtimeMs: stat.mtimeMs,
      lines: source.split(/\r?\n/).length,
      symbols: parser.extractSymbols(source),
      imports: parser.extractImports(source),
    };
    index.files[rel] = entry;
    parsed++;
  }

  // drop deleted files
  let removed = 0;
  for (const rel of Object.keys(index.files)) {
    if (!present.has(rel)) {
      delete index.files[rel];
      removed++;
    }
  }

  await saveIndex(root, index);
  return {
    index,
    parsed,
    reused,
    removed,
    totalFiles: present.size,
    skipped,
    parser: parser.name,
    config: cfg.summary,
    warnings: cfg.warnings,
  };
}
