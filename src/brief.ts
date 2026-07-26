// The onboarding brief: one synthesized session-opener that folds together
// three things a fresh chat would otherwise reconstruct from scratch — what the
// repo is, where recent sessions were digging (from the automatic journal, no
// memory_save required), and which saved memories still line up with the code
// as it exists now. This is the visible payoff of the persistence layer no
// retrieval-only server has.

import type { CodeIndex, MemoryFact } from "./store.js";

const CODE_EXT =
  /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|kt|rb|php|swift|scala|cls|trigger|cpp|hpp|cc|c|h|m|mm)\b/gi;

/** Identifier-shaped mentions worth staleness-checking: `foo`, foo(), foo:12. */
function symbolMentions(text: string): string[] {
  const out = new Set<string>();
  // backticked `name`
  for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) out.add(m[1]);
  // call-shaped name(
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g)) out.add(m[1]);
  // name:123 (a "symbol lives at line" reference)
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,}):\d+/g)) out.add(m[1]);
  return [...out];
}

export interface Staleness {
  flag: "" | "ok" | "stale";
  note: string;
}

/**
 * Cross-reference one memory fact against the live index. Conservative on
 * purpose: a fact is only called out as possibly stale when every code-shaped
 * thing it names is absent from the current index. Any live mention wins (no
 * crying wolf on a fact that's mostly still accurate), and a fact that names
 * nothing code-shaped gets no flag at all. A hint, never a verdict.
 */
export function checkStaleness(fact: MemoryFact, liveFiles: Set<string>, liveSymbols: Set<string>): Staleness {
  const fileRefs = (fact.text.match(CODE_EXT) ?? []).map((f) => f.replace(/\\/g, "/"));
  const symRefs = symbolMentions(fact.text);
  const mentions = [...fileRefs, ...symRefs];
  if (mentions.length === 0) return { flag: "", note: "" };

  const fileLive = (ref: string) => {
    const base = ref.split("/").pop()!;
    for (const f of liveFiles) if (f === ref || f.endsWith("/" + ref) || f.split("/").pop() === base) return true;
    return false;
  };
  const live = [...fileRefs.filter(fileLive), ...symRefs.filter((s) => liveSymbols.has(s))];
  if (live.length) return { flag: "ok", note: "" };

  const dead = mentions.slice(0, 3).join(", ");
  return { flag: "stale", note: `mentions ${dead} — not in current index` };
}

export interface BriefInput {
  index: CodeIndex;
  facts: MemoryFact[];
  recap: string; // pre-rendered journal recap (formatRecap output)
  root: string;
}

/** Extensions whose real behaviour is decided by the rendered page, not the source. */
const VISUAL_EXTS = new Set([".css", ".scss", ".less", ".html", ".htm", ".jsx", ".tsx", ".vue", ".svelte"]);

/**
 * State up front what this index CANNOT answer.
 *
 * From a real session: an agent spent roughly six calls hunting an inherited
 * `white-space: nowrap` through global stylesheets before giving up and
 * measuring the page in a browser — which took one call. No index can tell you
 * whether text wraps, which element paints on top, or what happened at
 * runtime; those live in the rendered page and in the logs. A tool that says so
 * in its opener is worth more than another search mode, because the failure it
 * prevents is silent: searching *works*, it just cannot find something that was
 * never in the code.
 *
 * Kept to one line, and sharpened only when the repo is actually markup-heavy,
 * because the opener is re-read in every later turn.
 */
export function blindSpots(byExt: Map<string, number>, fileCount: number): string {
  let visual = 0;
  for (const [ext, n] of byExt) if (VISUAL_EXTS.has(ext)) visual += n;
  const visualHeavy = fileCount > 0 && visual / fileCount >= 0.2;
  return visualHeavy
    ? `Blind spots: this index sees code, not the rendered page — layout, overlap and CSS-cascade questions ` +
        `(${visual}/${fileCount} files are markup/style) are NOT answerable here; measure them in a browser first. ` +
        `Runtime behaviour needs the logs.`
    : `Blind spots: this index sees code, not behaviour — runtime questions need the logs, and anything about ` +
        `layout or rendering needs a browser.`;
}

/** Compose the human-readable brief. Pure over its inputs for testability. */
export function composeBrief({ index, facts, recap, root }: BriefInput): string {
  const files = Object.entries(index.files);
  const fileCount = files.length;
  const symCount = files.reduce((n, [, f]) => n + f.symbols.length, 0);

  // Language mix by extension, top few.
  const byExt = new Map<string, number>();
  for (const [f] of files) {
    const ext = f.includes(".") ? f.slice(f.lastIndexOf(".")) : "(none)";
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
  }
  const langs = [...byExt.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([e, n]) => `${e}×${n}`)
    .join(", ");

  const liveFiles = new Set(files.map(([f]) => f));
  const liveSymbols = new Set<string>();
  for (const [, f] of files) for (const s of f.symbols) liveSymbols.add(s.name);

  const lines: string[] = [];
  lines.push(`Onboarding brief for ${root}`);
  lines.push(`  Repo: ${fileCount} indexed file(s), ${symCount} symbol(s). Languages: ${langs || "n/a"}.`);
  lines.push(`  ${blindSpots(byExt, fileCount)}`);
  lines.push("");
  lines.push(recap.trim());
  lines.push("");

  if (!facts.length) {
    lines.push("Saved conclusions: none yet. Use memory_save when you confirm something worth keeping.");
  } else {
    lines.push("Saved conclusions (newest first, checked against the current index):");
    const shown = [...facts].reverse().slice(0, 8);
    for (const f of shown) {
      const st = checkStaleness(f, liveFiles, liveSymbols);
      const mark = st.flag === "ok" ? " ✓" : st.flag === "stale" ? " ⚠" : "";
      const suffix = st.flag === "stale" ? `  (stale? ${st.note})` : "";
      const tags = f.tags.length ? `(${f.tags.join(",")}) ` : "";
      lines.push(`  [${f.id}]${mark} ${tags}${f.text.slice(0, 160)}${f.text.length > 160 ? "…" : ""}${suffix}`);
    }
    const more = facts.length - shown.length;
    if (more > 0) lines.push(`  … ${more} older fact(s); memory_list for the rest.`);
    lines.push("");
    lines.push("✓ = still references live code · ⚠ = may be stale, verify before trusting.");
  }
  return lines.join("\n");
}
