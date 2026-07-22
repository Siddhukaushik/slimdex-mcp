# slimdex — Setup & Token-Savings Report

_Last updated: 2026-07-21_

slimdex is a local MCP server (installed from source and run from a build
output such as `<BUILD_OUTPUT>/dist/index.js`) that
serves compact repo context — file skeletons, code search, jump-to-definition,
dependency graph, and a per-repo memory store — instead of dumping whole files
into the model's context. Goal: **one repo → one brain**, shared between Claude
chat and Claude Code, with far fewer tokens burned.

---

## 1. Config file locations

There are **two products**, each with its own config. slimdex must be registered
in each one separately — they do **not** share MCP connections.

| Product | Config file | slimdex key |
|---|---|---|
| **Claude Code** (project) | `<REPO_ROOT>/.mcp.json` | `slimdex` (pinned to that repo) |
| **Claude Code** (global) | `%USERPROFILE%\.claude.json` | `slimdex-mcp` (no root → uses `cwd()`) |
| **Claude Desktop** (chat) | `%APPDATA%\Claude\claude_desktop_config.json` | `slimdex` (needs a pinned root) |

> `%APPDATA%` is the current user's roaming app-data folder.

### Example server entry
```json
{
  "mcpServers": {
    "slimdex": {
      "command": "node",
      "args": ["<BUILD_OUTPUT>/dist/index.js"],
      "env": { "SLIMDEX_ROOT": "<REPO_ROOT>" }
    }
  }
}
```

- **`args`** = where the slimdex *program* is installed.
- **`SLIMDEX_ROOT`** = which *codebase* slimdex analyzes AND where it stores memory
  (`<ROOT>\.slimdex\memory.json`). This is the "brain" location.

---

## 2. How the root / brain resolves

From `src/index.ts:27`:
```
ROOT = SLIMDEX_ROOT  →  argv[2]  →  process.cwd()
```

- **Claude Code (any project):** global entry has no `SLIMDEX_ROOT`, so it falls
  back to `cwd()` = the folder you opened. slimdex auto-follows every repo →
  one repo, one brain, automatically. No manual pinning needed.
- **Claude Desktop chat:** has no project `cwd()`, so `SLIMDEX_ROOT` **must** be
  pinned to one repo. Chat can only aim at one repo at a time — re-pin the
  Desktop config to switch projects.

**Cross-chat memory works only when chat and code point at the same ROOT.**
If both clients point at the same repo, they share one `.slimdex\memory.json`
brain.

> After editing the Desktop config, **fully quit and reopen Claude Desktop**
> (from the system tray) for it to load the new MCP server.

---

## 3. Token-savings — measured results

### A) Per-file navigation test (`server.js`, 405 lines)
| Approach | Tokens |
|---|---|
| Read full file | ~5,400 |
| slimdex skeleton | ~160 |
| **Saving** | **~33×** |

### B) Real task: "how are charts populated in a sample app?"
| Path | Tokens pulled into context |
|---|---|
| Naive (read 4 files whole) | ~7,000 |
| slimdex (search → skeleton → read only needed lines) | ~860 |
| **Saving** | **~8×** |

### C) Session-level A/B (Claude Code `/status`, same task both ways)
| Metric | WITH slimdex | WITHOUT slimdex | Difference |
|---|---|---|---|
| Cost | $0.21 | $0.27 | without **~29% more** |
| Cache read (context re-read each turn) | 325.4k | 602.6k | without holds **~85% more** |
| Cache write (new context added) | 41.6k | 53.2k | without **~28% more** |
| slimdex footprint | 3% | — (no MCP) | |

**Verdict:** same task cost ~29% more without slimdex, and dragged nearly
double the context around. slimdex's own footprint was only 3% of usage.

### Why 8× per-file but only 29% per-session?
`/status` measures the whole session, most of which is **fixed overhead**
(system prompt, tool defs, CLAUDE.md, memory) that's identical either way and
doesn't shrink with slimdex. slimdex only shaves the *file-reading* slice:
- Per-file-read work → ~8× cheaper (the true slimdex effect).
- Whole-session bill → ~29% cheaper (overhead dilutes it).

Both are correct; they just measure different scopes. The 29% is what actually
hits the wallet.

---

## 4. Biggest cost lever (from usage panel)

The `/status` "What's using your limits?" panel showed the real budget-eater is
**"93% ran above 150k context"** — i.e. sessions carrying a large context window,
re-read every turn. slimdex directly fights this by keeping context lean.

**Habits that save the most:**
- `/compact` mid-task when a session gets long.
- `/clear` when switching to an unrelated task.
- Keep using slimdex — it's the *cause* of context staying small, and at 3%
  it's not itself a cost concern.

---

## 5. Quick verification recipe (repeatable)

Run the **same** task in two fresh chats and compare `/status` **cache write**:

- **Chat A:** `Using slimdex only, explain how charts are populated in the sample app. Then stop.`
- **Chat B:** `Do not use slimdex or any MCP. Read the files directly and explain how charts are populated in the sample app. Then stop.`

Same question, same stopping point, only slimdex differs = valid apples-to-apples.
