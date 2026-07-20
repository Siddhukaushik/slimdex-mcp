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

// Compact Mermaid rendering of the internal import graph (optionally scoped to
// a subtree) so an IDE that renders Mermaid shows an actual diagram.
export function toMermaid(graph: GraphEdges, scope?: string, maxEdges = 120): string {
  const lines = ["graph LR"];
  let n = 0;
  const id = (p: string) => "n" + Buffer.from(p).toString("hex").slice(0, 10);
  const label = (p: string) => p.replace(/"/g, "'");
  const seen = new Set<string>();
  for (const [file, deps] of Object.entries(graph.imports)) {
    if (scope && !file.startsWith(scope)) continue;
    for (const dep of deps) {
      if (scope && !dep.startsWith(scope)) continue;
      if (n >= maxEdges) break;
      lines.push(`  ${id(file)}["${label(file)}"] --> ${id(dep)}["${label(dep)}"]`);
      seen.add(file);
      seen.add(dep);
      n++;
    }
    if (n >= maxEdges) break;
  }
  if (n === 0) return "graph LR\n  empty[No internal edges in scope]";
  return lines.join("\n");
}
