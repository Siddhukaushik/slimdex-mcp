// Tool-surface profiles.
//
// Measured on this repo: the tools/list payload is ~21,200 chars and the server
// instructions another ~4,700. That is re-sent on EVERY turn, before slimdex
// reads a single line of code — the one cost bucket that scales with turn count
// no matter how disciplined the retrieval is.
//
// The honest fix is not to merge tools (renaming breaks existing configs, and
// the descriptions carry the operating discipline — they are the product, not
// filler). It is to let a repo expose only the surface it actually needs.
//
// SLIMDEX_PROFILE=lean advertises the core set and hides the rest. Crucially,
// hidden tools are NOT removed: they stay in the handler registry, so `batch`
// can still dispatch to every one of them. Lean pays the schema cost of ~13
// tools while keeping the capability of all of them — the specialist tools
// (Apex graphs, digests, snapshots) are one batch call away when a repo turns
// out to need them.
//
// Default is `full`: the advertised surface is unchanged unless asked for.

/**
 * The core set. Chosen as: orient (brief/repo_map/index_repo), locate
 * (search_code/find_definition/find_references/search_intent), read narrowly
 * (get_file_skeleton/get_symbol_context/read_lines), the one-shot explorer
 * (context_pack), write narrowly (replace_symbol), the escape hatch (batch),
 * and the persistence the opener depends on (memory_save + memory_get, since brief hands back fact
 * previews and something has to be able to expand one).
 */
export const LEAN_TOOLS = new Set([
  "batch",
  "index_repo",
  "brief",
  "repo_map",
  "search_code",
  "search_intent",
  "find_definition",
  "find_references",
  "get_file_skeleton",
  "get_symbol_context",
  "read_lines",
  "context_pack",
  "replace_symbol",
  "memory_save",
  "memory_get",
]);

/**
 * The tools lean hides. Kept explicitly rather than derived, because the server
 * `instructions` are fixed at construction time — before any tool registers —
 * and the instructions MUST name these: 11 of them are actively recommended by
 * the guidance sent every turn (get_context, find_tests, changed_files,
 * digest_save …). A tool the model is told to use but cannot see in its tool
 * list is capability lost, not surface saved. A test asserts this list matches
 * what the lean server actually hides, so it cannot drift.
 */
export const BATCH_ONLY = [
  "get_context",
  "changed_files",
  "find_tests",
  "dep_graph",
  "outline_file",
  "search_symbols",
  "recap",
  "memory_list",
  "memory_search",
  "memory_delete",
  "digest_save",
  "digest_get",
  "snapshot",
  "stats",
  // Setup, not retrieval: needed once per machine, so it earns no schema in the
  // lean tool list. `brief` names it when the hook is missing, and lean's own
  // note says hidden tools still run through batch — so the advice stays
  // actionable without the surface.
  "install_hook",
];

/**
 * The line appended to INSTRUCTIONS under lean, so nothing is unreachable in
 * practice. Kept terse on purpose: it is appended INSIDE the instructions
 * budget (see INSTRUCTIONS_BUDGET in index.ts), so every char spent restating
 * the point here is a char of actual guidance that gets truncated away.
 */
export function leanNote(): string {
  return (
    `\n\nLEAN PROFILE — these are fully working but NOT in your tool list: ${BATCH_ONLY.join(", ")}. ` +
    `Reach them via batch [{tool:"find_tests",args:{…}}]; the guidance above still applies, so route the ` +
    `step through batch rather than skipping it or falling back to a broad read.`
  );
}

export type Profile = "full" | "lean";

export function profile(): Profile {
  return process.env.SLIMDEX_PROFILE === "lean" ? "lean" : "full";
}

/** Whether this tool appears in tools/list. Hidden tools remain batch-callable. */
export function advertised(name: string): boolean {
  return profile() === "full" || LEAN_TOOLS.has(name);
}
