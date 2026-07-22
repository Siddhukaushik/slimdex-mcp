// Dependency graph queries over the cached import data. Resolves relative
// imports (JS/TS/Python-style) to real files where it can, so "what imports X"
// and "what does X import" return concrete repo paths, not just raw strings.

import path from "node:path";
import { promises as fs } from "node:fs";
import type { CodeIndex } from "./store.js";
import { readFileCached } from "./fscache.js";
import { scanLines } from "./lexer.js";

const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

// Try to turn a raw import string written in `fromFile` into a repo-relative
// path that actually exists in the index. Returns null for external packages.
function resolve(fromFile: string, mod: string, files: Set<string>): string | null {
  // Relative JS/TS import
  if (mod.startsWith(".")) {
    const base = path.posix.join(path.posix.dirname(fromFile), mod);
    // TypeScript's NodeNext/ESM convention writes `./outline.js` for a file that
    // is actually `outline.ts`. Without stripping that extension the graph came
    // out completely empty for every TS project using module: Node16/NodeNext.
    const stripped = base.replace(/\.(js|mjs|cjs)$/, "");
    const candidates = [
      base,
      ...JS_EXT.map((e) => base + e),
      ...(stripped !== base ? JS_EXT.map((e) => stripped + e) : []),
      ...JS_EXT.map((e) => path.posix.join(base, "index" + e)),
    ];
    for (const c of candidates) if (files.has(c)) return c;
    return null;
  }
  // Python dotted module -> path
  if (/^[A-Za-z0-9_.]+$/.test(mod) && mod.includes(".") === false) {
    const py = mod + ".py";
    if (files.has(py)) return py;
  }
  if (/^[A-Za-z0-9_.]+$/.test(mod)) {
    const py = mod.split(".").join("/") + ".py";
    if (files.has(py)) return py;
  }
  return null;
}

export interface GraphEdges {
  imports: Record<string, string[]>; // file -> resolved internal deps
  external: Record<string, string[]>; // file -> unresolved (external) modules
}

export function buildGraph(index: CodeIndex): GraphEdges {
  const files = new Set(Object.keys(index.files));
  const imports: Record<string, string[]> = {};
  const external: Record<string, string[]> = {};

  for (const [file, entry] of Object.entries(index.files)) {
    const internal: string[] = [];
    const ext: string[] = [];
    for (const imp of entry.imports) {
      const r = resolve(file, imp.module, files);
      if (r) internal.push(r);
      else ext.push(imp.module);
    }
    if (internal.length) imports[file] = [...new Set(internal)];
    if (ext.length) external[file] = [...new Set(ext)];
  }
  return { imports, external };
}

// ---------------------------------------------------------------------------
// Name-reference edges for languages with NO import statement.
//
// Apex is the motivating case: a .cls file uses another class by bare name —
// `AccountService`, `IAccountService`, `TriggerHandler` — with nothing at the
// top of the file to parse. Import-based graphing therefore returned an empty
// graph for every Salesforce repo, which the README used to list as a hard
// limitation. But the reference IS in the text: if file A's code mentions a
// top-level class defined in file B, that's a dependency edge A -> B.
//
// This also recovers most of the "framework wiring" that import parsing can
// never see: `class AccountService implements IAccountService` links the
// implementation to its interface (so dependents(IAccountService) answers
// "who implements this"), and a trigger that news up its handler class links
// trigger -> handler. What remains invisible is wiring held purely in
// metadata/config files — that's data, not code, and no static reader of the
// code can conjure it.
//
// Method: collect every top-level type name from the no-import files, then
// tokenize each file's MASKED source (strings and comments blanked, so a name
// in a comment or a debug string is not an edge) and intersect. Tokenizing
// once per file keeps it O(total source), not O(files × names).

const NAMEREF_EXTS = [".cls", ".trigger"];
const NAMEREF_KINDS = new Set(["class", "interface", "enum", "type", "trigger"]);

// Declarative wiring lives in the repo too: SFDX source format stores
// custom-metadata records, flows and similar bindings as XML whose element
// values are type names (`<value>AccountTriggerHandler</value>`). Scanning
// repo XML for known type names turns "bound in metadata" from invisible into
// an edge: metadata-file -> class. Only config that exists solely in a live
// system, never retrieved into the repo, remains out of reach.
const META_IGNORE = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", "coverage", "vendor",
  ".sfdx", ".sf", ".codeglance", ".idea", ".vscode", "__pycache__", ".venv", "venv",
]);
const META_FILE_CAP = 3000; // scan bound for pathological repos
const META_BYTE_CAP = 256 * 1024;

async function walkXml(dir: string, acc: string[], depth = 0): Promise<void> {
  if (acc.length >= META_FILE_CAP || depth > 12) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= META_FILE_CAP) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!META_IGNORE.has(e.name)) await walkXml(full, acc, depth + 1);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".xml")) {
      acc.push(full);
    }
  }
}

// Keyed by index object identity: loadIndex returns the same cached object
// until the index file is rewritten, so a WeakMap can never serve stale edges.
const nameRefCache = new WeakMap<CodeIndex, Record<string, string[]>>();

export async function nameRefEdges(root: string, index: CodeIndex): Promise<Record<string, string[]>> {
  const cached = nameRefCache.get(index);
  if (cached) return cached;

  const typeToFile = new Map<string, string>();
  const candidates: string[] = [];
  for (const [file, entry] of Object.entries(index.files)) {
    if (!NAMEREF_EXTS.some((e) => file.endsWith(e))) continue;
    candidates.push(file);
    for (const s of entry.symbols)
      if ((s.depth ?? 0) === 0 && NAMEREF_KINDS.has(s.kind)) typeToFile.set(s.name, file);
  }

  const edges: Record<string, string[]> = {};
  for (const file of candidates) {
    let src: string;
    try {
      src = await readFileCached(path.join(root, file));
    } catch {
      continue;
    }
    const tokens = new Set<string>();
    for (const { masked } of scanLines(src))
      for (const m of masked.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) tokens.add(m[0]);
    const out: string[] = [];
    for (const [name, target] of typeToFile)
      if (target !== file && tokens.has(name)) out.push(target);
    if (out.length) edges[file] = [...new Set(out)].sort();
  }

  // Metadata pass: only when the repo actually has name-referencing types to
  // find, so non-Salesforce repos never pay for an XML walk.
  if (typeToFile.size > 0) {
    const xmlFiles: string[] = [];
    await walkXml(root, xmlFiles);
    for (const abs of xmlFiles) {
      let src: string;
      try {
        const st = await fs.stat(abs);
        if (st.size > META_BYTE_CAP) continue;
        src = await readFileCached(abs);
      } catch {
        continue;
      }
      const clean = src.replace(/<!--[\s\S]*?-->/g, " "); // a name in an XML comment is not wiring
      const tokens = new Set(clean.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
      const out: string[] = [];
      for (const [name, target] of typeToFile) if (tokens.has(name)) out.push(target);
      if (out.length) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        edges[rel] = [...new Set([...(edges[rel] ?? []), ...out])].sort();
      }
    }
  }

  nameRefCache.set(index, edges);
  return edges;
}

// Merge name-reference edges into an import graph (dedup, in place). Callers
// that only have import-bearing languages get back the same object untouched.
export function mergeEdges(g: GraphEdges, extra: Record<string, string[]>): GraphEdges {
  for (const [file, targets] of Object.entries(extra)) {
    g.imports[file] = [...new Set([...(g.imports[file] ?? []), ...targets])];
  }
  return g;
}

export function dependents(graph: GraphEdges, target: string): string[] {
  const out: string[] = [];
  for (const [file, deps] of Object.entries(graph.imports)) {
    if (deps.includes(target)) out.push(file);
  }
  return out;
}

// Compact Mermaid rendering of the internal import graph.
//   - scope:   only include files under this path prefix
//   - root:    start from this file and walk outward (BFS) instead of dumping
//              everything — keeps a monorepo graph from exploding
//   - depth:   how many import hops to follow from root (default 2)
// Without a root, it renders scoped/whole-graph edges as before (capped).
export function toMermaid(
  graph: GraphEdges,
  scope?: string,
  opts: { root?: string; depth?: number; maxEdges?: number } = {}
): string {
  const maxEdges = opts.maxEdges ?? 120;
  const lines = ["graph LR"];
  // Stable, collision-free node ids: assign n0, n1, … per unique path. (The old
  // hex-prefix scheme collided for paths sharing a prefix like "backend/src/…".)
  const ids = new Map<string, string>();
  const id = (p: string) => {
    let v = ids.get(p);
    if (!v) {
      v = "n" + ids.size;
      ids.set(p, v);
    }
    return v;
  };
  const label = (p: string) => p.replace(/"/g, "'");
  const edges: [string, string][] = [];

  if (opts.root) {
    // BFS from root following import edges up to `depth` hops.
    const depth = opts.depth ?? 2;
    const seen = new Set<string>([opts.root]);
    let frontier = [opts.root];
    for (let d = 0; d < depth && edges.length < maxEdges; d++) {
      const next: string[] = [];
      for (const file of frontier) {
        for (const dep of graph.imports[file] ?? []) {
          if (edges.length >= maxEdges) break;
          edges.push([file, dep]);
          if (!seen.has(dep)) {
            seen.add(dep);
            next.push(dep);
          }
        }
      }
      frontier = next;
    }
  } else {
    for (const [file, deps] of Object.entries(graph.imports)) {
      if (scope && !file.startsWith(scope)) continue;
      for (const dep of deps) {
        if (scope && !dep.startsWith(scope)) continue;
        if (edges.length >= maxEdges) break;
        edges.push([file, dep]);
      }
      if (edges.length >= maxEdges) break;
    }
  }

  if (edges.length === 0) return "graph LR\n  empty[No internal edges in scope]";
  for (const [a, b] of edges) lines.push(`  ${id(a)}["${label(a)}"] --> ${id(b)}["${label(b)}"]`);
  return lines.join("\n");
}
