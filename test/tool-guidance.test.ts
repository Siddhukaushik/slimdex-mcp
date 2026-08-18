import { describe, expect, it } from "vitest";
import { nextStepHint, withNextStepHint } from "../src/index.js";

const TOOLS = [
  "index_repo", "snapshot", "outline_file", "read_lines", "search_code", "find_definition", "search_symbols",
  "find_references", "find_tests", "search_intent", "context_pack", "get_symbol_context", "replace_symbol",
  "get_file_skeleton", "get_context", "repo_map", "changed_files", "dep_graph", "stats", "memory_save",
  "memory_search", "recap", "brief", "install_hook", "digest_save", "digest_get", "memory_list", "memory_get",
  "memory_delete", "batch",
];

describe("tool follow-on guidance", () => {
  it("gives every registered tool a concrete next step", () => {
    for (const tool of TOOLS) {
      expect(nextStepHint(tool), tool).toMatch(/^Next: .+/);
    }
  });

  it("adds guidance to ordinary results", () => {
    expect(withNextStepHint("find_definition", "src/math.ts:1 function add")).toContain(
      "Next: use get_symbol_context"
    );
  });

  it("preserves a handler's more-specific next step without repeating it", () => {
    const result = "src/math.ts skeleton\nNext: get_symbol_context names:[\"add\"] — bodies only.";
    expect(withNextStepHint("get_file_skeleton", result)).toBe(result);
  });
});