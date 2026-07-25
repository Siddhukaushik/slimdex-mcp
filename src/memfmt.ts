// Rendering for the memory store.
//
// Why this file exists: memory_list was the most expensive call in a session.
// It dumped every fact's full body, and the session-opening ritual calls it
// first — on an 18-fact store that is ~18,600 chars, paid at the start of every
// session and then re-read in every later turn. Facts are written to be
// self-contained paragraphs, so they only grow; the cost of the opener scaled
// with the size of everything ever learned, which is exactly backwards.
//
// So the default is a preview: enough to recognise a fact and decide whether to
// expand it (id, date, tags, opening clause), with the full body one memory_get
// away. `brief` already worked this way — this makes memory_list agree with it
// instead of being the one place that dumps everything.

import type { MemoryFact } from "./store.js";

/** Chars of body shown per fact in list mode. */
export const PREVIEW_CHARS = 150;

/** Chars of body shown per hit in search mode — a search already narrowed. */
export const SEARCH_PREVIEW_CHARS = 240;

/**
 * A fact this long is doing too many jobs at once: it will be previewed in
 * every list, and a future session has to read the whole thing to use any of
 * it. Warn at save time (never truncate — silently losing a conclusion the
 * agent just confirmed would be far worse than a long fact).
 */
export const SOFT_MAX_FACT_CHARS = 1200;

/**
 * Refusal threshold. Guards against a runaway paste (a whole file, a stack
 * trace dump) becoming a permanent per-session tax. Explicit refusal, not a
 * silent trim, so the caller can split it deliberately.
 */
export const HARD_MAX_FACT_CHARS = 20000;

function tagPart(f: MemoryFact): string {
  return f.tags.length ? `(${f.tags.join(",")}) ` : "";
}

function datePart(f: MemoryFact): string {
  // The date is why a preview is enough to triage: newer conclusions supersede
  // older ones, and "is this still true?" starts with when it was written.
  return f.created ? f.created.slice(0, 10) + " " : "";
}

/** Collapse whitespace so a multi-line fact previews as one readable row. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** One preview row: `[id] (tags) 2026-07-24 opening clause…` */
export function factPreview(f: MemoryFact, chars = PREVIEW_CHARS): string {
  const body = flatten(f.text);
  const clipped = body.length > chars ? body.slice(0, chars).trimEnd() + "…" : body;
  return `[${f.id}] ${tagPart(f)}${datePart(f)}${clipped}`;
}

/** Full rendering of one fact, including the provenance note if present. */
export function factFull(f: MemoryFact): string {
  const head = `[${f.id}] ${tagPart(f)}${datePart(f)}`.trimEnd();
  const prov = f.context ? `\n  (saved while looking at: ${f.context})` : "";
  return `${head}\n${f.text}${prov}`;
}

export interface FactListOpts {
  full?: boolean;
  previewChars?: number;
  /** Rendered when previews are in play, to point at the expansion path. */
  expandHint?: string;
}

/**
 * Render a list of facts, newest-first order assumed to be applied by caller.
 * Returns previews by default; `full: true` restores the old whole-body dump
 * verbatim so any caller that genuinely wants everything still has it.
 */
export function formatFactList(facts: MemoryFact[], opts: FactListOpts = {}): string {
  if (!facts.length) return "";
  if (opts.full) return facts.map((f) => `[${f.id}] ${tagPart(f)}${f.text}`).join("\n");
  const rows = facts.map((f) => factPreview(f, opts.previewChars ?? PREVIEW_CHARS));
  const clipped = facts.some((f) => flatten(f.text).length > (opts.previewChars ?? PREVIEW_CHARS));
  const hint = clipped && opts.expandHint ? `\n${opts.expandHint}` : "";
  return rows.join("\n") + hint;
}
