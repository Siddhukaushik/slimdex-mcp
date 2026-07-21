// Dependency graph queries over the cached import data. Resolves relative
// imports (JS/TS/Python-style) to real files where it can, so "what imports X"
// and "what does X import" return concrete repo paths, not just raw strings.

import path from "node:path";
import type { CodeIndex } from "./store.js";

const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

// Try to turn a raw import string written in `fromFile` into a repo-relative
// path that actually exists in the index. Returns null for external packages.
function resolve(fromFile: string, mod: string, files: Set<string>): string | null {
  // Relative JS/TS import
  if (mod.startsWith(".")) {
    const base = path.posix.join(path.posix.dirname(fromFile), mod);
    const candidates = [
      base,
      ...JS_EXT.map((e) => base + e),
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
