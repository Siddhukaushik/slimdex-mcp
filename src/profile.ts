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

export type Profile = "full" | "lean";

export function profile(): Profile {
  return process.env.SLIMDEX_PROFILE === "lean" ? "lean" : "full";
}

/** Whether this tool appears in tools/list. Hidden tools remain batch-callable. */
export function advertised(name: string): boolean {
  return profile() === "full" || LEAN_TOOLS.has(name);
}
