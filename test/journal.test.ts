// The automatic activity journal: breadcrumbs recorded per tool call with no
// agent cooperation, summarized by recap for the next session.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { journalRecord, formatRecap, flushJournal, clearJournalCache } from "../src/journal.js";

let root = "";
const roots: string[] = [];

beforeEach(async () => {
  clearJournalCache();
  root = await fs.mkdtemp(path.join(tmpdir(), "slimdex-journal-"));
  roots.push(root);
});

afterAll(async () => {
  clearJournalCache();
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});

describe("journal", () => {
  it("summarizes files, symbols and searches from recorded calls", async () => {
    await journalRecord(root, "get_file_skeleton", { path: "src/parsers.js" });
    await journalRecord(root, "get_file_skeleton", { path: "src/parsers.js" });
    await journalRecord(root, "read_lines", { path: "src/normalize.js", start: 1, end: 40 });
    await journalRecord(root, "find_references", { name: "isCrossSourceDuplicate" });
    await journalRecord(root, "search_code", { pattern: "workerSrc" });

    const recap = await formatRecap(root);
    expect(recap).toContain("src/parsers.js (2)");
    expect(recap).toContain("src/normalize.js");
    expect(recap).toContain("isCrossSourceDuplicate");
    expect(recap).toContain('"workerSrc"');
  });

  it("survives a restart via the on-disk journal", async () => {
    await journalRecord(root, "find_definition", { name: "parseBankPdf" });
    await flushJournal(root);
    clearJournalCache(); // simulate a fresh server process
    const recap = await formatRecap(root);
    expect(recap).toContain("parseBankPdf");
  });

  it("does not journal bookkeeping calls", async () => {
    await journalRecord(root, "stats", {});
    await journalRecord(root, "memory_list", {});
    await journalRecord(root, "recap", {});
    const recap = await formatRecap(root);
    expect(recap).toContain("first session");
  });

  it("caps the journal instead of growing forever", async () => {
    for (let i = 0; i < 450; i++) await journalRecord(root, "read_lines", { path: `f${i}.ts` });
    await flushJournal(root);
    const raw = JSON.parse(await fs.readFile(path.join(root, ".slimdex", "journal.json"), "utf8"));
    expect(raw.entries.length).toBeLessThanOrEqual(400);
  });

  it("reports a clean first-session message on an empty repo", async () => {
    expect(await formatRecap(root)).toContain("first session");
  });
});
