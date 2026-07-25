// Intent search: "find the code that does X" by keyword, when you don't know the
// exact symbol name. The field's answer to this is vector embeddings (a heavy
// dependency and an index to maintain); ours is BM25 over the symbol index we
// already have — no embeddings, no model, instant and offline. It ranks by
// meaning-of-the-name, not exact match: "validate email" surfaces
// validateEmail, emailValidator, checkEmailFormat, because names are tokenized
// (camelCase/snake_case split) into their words. Scores are explainable, which
// the honesty culture here prefers over an opaque cosine number.

import type { CodeIndex } from "./store.js";

// Minimal English stoplist only. Code words like "get"/"set"/"is" are kept —
// they carry intent in identifiers (isValid, getUser).
const STOP = new Set(["the", "a", "an", "of", "to", "in", "that", "this", "for", "and", "or", "with", "on"]);

/** camelCase/snake_case/path → lowercase word tokens, ≥2 chars, no stopwords. */
export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase boundary
    .replace(/[_\-.]/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

export interface IntentHit {
  file: string;
  line: number;
  name: string;
  kind: string;
  score: number;
}

interface Doc {
  file: string;
  line: number;
  name: string;
  kind: string;
  terms: string[];
}

/** One BM25 "document" per indexed symbol: its name-words + kind + filename-words. */
export function buildCorpus(index: CodeIndex): Doc[] {
  const docs: Doc[] = [];
  for (const [f, entry] of Object.entries(index.files)) {
    const pathToks = tokenize(f.split("/").pop() ?? "");
    for (const s of entry.symbols) {
      docs.push({ file: f, line: s.line, name: s.name, kind: s.kind, terms: [...tokenize(s.name), s.kind.toLowerCase(), ...pathToks] });
    }
  }
  return docs;
}

export interface RankOptions {
  /**
   * Rank every non-test symbol above every test symbol (context_pack).
   *
   * Test titles are prose — "splice symbol replaces a body" — so against a
   * natural-language query they routinely out-score the very function they
   * exercise. BM25 is matching wording, and a test title is worded like the
   * question, often matching more query terms than the identifier does. That
   * is a fine answer for search_intent ("which test covers this?") and the
   * wrong one for context_pack, whose whole job is "show me how this works".
   *
   * Implemented as a sort tier rather than a score multiplier for two reasons:
   * a multiplier big enough to beat a near-verbatim title match is arbitrary
   * and still not a guarantee, and search_intent PRINTS the score — scaling it
   * would make the reported number a fiction. Tests are demoted, never
   * dropped, so they still surface once the implementation has had its turn.
   */
  deprioritizeTests?: boolean;
}

/**
 * BM25-rank the indexed symbols against a natural-language query. Pure over the
 * index; rebuilds the corpus each call (O(symbols), a few ms even at 50k) so it
 * never holds a second stale structure to invalidate.
 */
export function rankIntent(index: CodeIndex, query: string, limit = 10, opts: RankOptions = {}): IntentHit[] {
  const docs = buildCorpus(index);
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length || !docs.length) return [];

  const N = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.terms)) df.set(t, (df.get(t) ?? 0) + 1);
  const avgdl = docs.reduce((n, d) => n + d.terms.length, 0) / N;
  const k1 = 1.5;
  const b = 0.75;
  const idf = (t: string) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));

  const hits: IntentHit[] = [];
  for (const d of docs) {
    const tf = new Map<string, number>();
    for (const t of d.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const q of qTerms) {
      const f = tf.get(q) ?? 0;
      if (!f) continue;
      score += idf(q) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.terms.length) / avgdl)));
    }
    if (score > 0) hits.push({ file: d.file, line: d.line, name: d.name, kind: d.kind, score });
  }
  const tier = (h: IntentHit) => (opts.deprioritizeTests && h.kind === "test" ? 1 : 0);
  hits.sort((a, b2) => tier(a) - tier(b2) || b2.score - a.score || a.file.localeCompare(b2.file));
  return hits.slice(0, limit);
}
