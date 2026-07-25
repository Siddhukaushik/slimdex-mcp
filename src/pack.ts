// context_pack: run the whole exploration loop server-side and return ONE
// bounded bundle, instead of the agent making ~10 separate calls (each a
// round-trip, and each result then re-sent in the transcript every turn for the
// rest of the session). It moves the exploration OUT of the model — where it's
// expensive and pollutes history — and INTO the server, where it's one
// deterministic pass over things we already have: BM25 intent ranking to find
// the relevant symbols, the import graph to show how they connect, and bounded
// bodies for the top few. No LLM on the server side; pure assembly.

import type { CodeIndex } from "./store.js";
import { rankIntent } from "./intent.js";
import { buildGraph, dependents } from "./graph.js";

export interface PackOptions {
  budget?: number; // soft char cap on the whole pack (default 6000)
  symbols?: number; // how many ranked symbols to list (default 8)
  bodies?: number; // how many top symbols to include full bodies for (default 3)
}

// Injected so the module stays pure/testable — the tool wires the real
// getSymbolContext; tests pass a stub.
export type BodyFetcher = (file: string, line: number, kind: string, maxLines: number) => Promise<string>;

const BODY_MAX_LINES = 30;

/** Keep a hit only if it scores at least this fraction of the best hit. */
const RELEVANCE_FLOOR = 0.3;

/** …but never prune below this many, so a close second/third always survives. */
const MIN_KEEP = 3;

export async function buildPack(index: CodeIndex, query: string, getBody: BodyFetcher, opts: PackOptions = {}): Promise<string> {
  const budget = opts.budget ?? 6000;
  const nSym = opts.symbols ?? 8;
  const nBodies = opts.bodies ?? 3;

  const ranked = rankIntent(index, query, nSym);
  if (!ranked.length) return `No symbols matched "${query}". Try search_code for a literal string, or different words.`;

  // Relevance floor. BM25 always returns SOMETHING for any term that appears
  // anywhere, so asking for 8 symbols got 8 whether or not 8 were relevant —
  // a narrow question came back padded with unrelated code, which is the
  // opposite of the point (reported from real use: "some context packs were too
  // broad and returned unrelated symbols"). Scores are only comparable within
  // one query, so the cut is relative to the best hit, never an absolute value.
  // A floor of 3 keeps a genuinely close second and third from being pruned by
  // one dominant match.
  const topScore = ranked[0].score;
  const hits = ranked.filter((h, i) => i < MIN_KEEP || h.score >= topScore * RELEVANCE_FLOOR);
  const dropped = ranked.length - hits.length;

  const out: string[] = [];
  out.push(`Context pack for "${query}" — ${hits.length} relevant symbol(s), budget ${budget} chars.`);
  out.push("");
  out.push("Relevant symbols (ranked by intent):");
  for (const h of hits) out.push(`  ${h.file}:${h.line}  ${h.kind} ${h.name}`);
  // Say so rather than silently narrowing: a weak tail can still be the answer
  // when the query was worded badly, and the caller needs to know the knob exists.
  if (dropped)
    out.push(`  (${dropped} weaker match(es) omitted as unrelated — raise symbols, or reword, if the answer is missing)`);

  // How they connect: one hop of the import graph for the involved files.
  const graph = buildGraph(index);
  const files = [...new Set(hits.map((h) => h.file))];
  const conn: string[] = [];
  for (const f of files) {
    const imp = graph.imports[f] ?? [];
    const dep = dependents(graph, f);
    if (!imp.length && !dep.length) continue;
    conn.push(`  ${f}`);
    if (imp.length) conn.push(`    imports: ${imp.join(", ")}`);
    if (dep.length) conn.push(`    used by: ${dep.join(", ")}`);
  }
  if (conn.length) {
    out.push("");
    out.push("How they connect (import graph, one hop):");
    out.push(...conn);
  }

  // Key bodies for the top few, stopping when the budget is spent. The first
  // body always shows (even if it alone is large) so the pack is never empty of
  // code; subsequent ones are gated on the remaining budget.
  out.push("");
  out.push("Key bodies:");
  let used = out.join("\n").length;
  let shown = 0;
  const wanted = Math.min(nBodies, hits.length);
  for (const h of hits.slice(0, wanted)) {
    const body = await getBody(h.file, h.line, h.kind, BODY_MAX_LINES);
    const block = `\n${h.file}:${h.line}  ${h.kind} ${h.name}\n${body}`;
    if (shown > 0 && used + block.length > budget) break;
    out.push(block);
    used += block.length;
    shown++;
  }
  if (shown < wanted) {
    out.push(`\n… ${wanted - shown} more body(ies) omitted to fit budget ${budget}; get_symbol_context names:[...] to pull them.`);
  }
  return out.join("\n");
}
