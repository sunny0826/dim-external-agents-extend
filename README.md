# Dim External Agents Extend

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> View execution logs of external-agent tasks delegated from DimAgent — status, tool calls, intermediate output, and failure reasons.

When DimAgent hands a task to an external agent (Kimi, Cursor, Codex, ...) via `agent create_external`, it runs asynchronously and the UI only shows the task status and a final summary — **the execution process is invisible**. This plugin fills that gap: each external agent writes its full execution trace to your machine (JSONL / SQLite); the plugin reads, normalizes, and displays it.

![Task list](docs/images/panel-list.png)

## Features

- **Task list** — List tasks delegated to external agents in the current session (or across all history): agent type, model, status, start time, and duration
- **Execution logs** — Click a task to see the full event stream: tool calls, file reads, command output, reasoning, and errors; agent text is Markdown-rendered (headings, lists, tables, code blocks); running tasks refresh incrementally every 2 seconds
- **Inline session card** — Show task cards right in the conversation; click one to open the live log fullscreen
- **Automatic status hints** — Detect running external tasks in the current session each turn; finished or failed tasks are reported proactively; new tasks open the live log panel automatically, no need to ask
- **Unified session names** — External agents pile up sessions with inconsistent titles (`Help`, `Code Review Agent`, `New session - 2026-09-16T…`). The plugin normalizes them to one format — `[codex] 09-19 20:31 · Fix GUO-108 review issues` — and can write that name back into the agent's own session store so its `resume` picker gets clean too
- **CLI** — `list` / `show` / `tail` / `sessions` / `rename` commands with `--json` output for scripting
- **Local-only** — Reads local data only, no network. dim's own database is never written; the only writes are session renames you explicitly confirm (a backup is taken first)

## Requirements

- **DimAgent desktop** (with the plugin system and MCP App support; tested on 0.9.32)
- Nothing else to install: the plugin has zero third-party dependencies and uses DimAgent's bundled Node runtime

## Installation

**From GitHub (recommended)**

Dim desktop → Plugins → Add plugin, and enter the repository URL:

```
https://github.com/sunny0826/dim-external-agents-extend
```

Or use the CLI:

```bash
dim plugin install https://github.com/sunny0826/dim-external-agents-extend
```

**Restart DimAgent** after installing.

**Local development install** (changes take effect immediately)

```bash
ln -s "$(pwd)" ~/.agents/plugins/external-agents-extend
```

## Usage

### In the conversation

Just ask your agent:

- "How is that cursor task doing?"
- "List the recent external-agent tasks"
- "Why did this delegation fail?"

The plugin provides seven tools, which the model calls automatically:

| Tool | Purpose |
| --- | --- |
| `list_agent_runs` | List delegated tasks (filter by agent type, status; `sessionId` to target a specific dim session) |
| `read_agent_run` | Read a task's execution log (paginated + incremental polling) |
| `list_external_sessions` | List the agents' own sessions with unified display names |
| `rename_external_sessions` | Write the unified name back into an agent's session store (preview by default) |
| `auto_name_sessions` | Backfill the unified name for older dim-delegated sessions |
| `restore_backups` | Roll a rename back from the backup directory |
| `get_settings` / `set_auto_name` | Read / flip the automatic-naming switch (the panel toggle uses these) |
| `show_external_agents` | Show task cards in the conversation (click through to the live log) |
| `open_agent_run_log` | Open the fullscreen log panel |

You can also pick `/external-agents-extend` from the skills button or slash menu in the input area to open the log panel directly, or `/external-session-names` to clean up session names.

### Fullscreen log panel

![Log page](docs/images/panel-log.png)

- The header shows task context: agent, model, title, status, and time range
- The event stream is grouped by type: agent text (Markdown rendered, including tables), tool calls (a collapsible "tool calls" group — expand to see every step), and reasoning/system events (collapsible)
- With "Follow" enabled, it auto-scrolls to the latest; running tasks append incrementally every 2 seconds
- Check "All sessions" for historical tasks, and "Show finished" for completed / cancelled tasks

### Session names

External agents keep their own session stores, and the titles there are inconsistent: Codex mixes languages and keeps generic ones (`Help`, `Simplify and refactor codebase`), Cursor writes vague English (`Code Review Agent`), OpenCode uses `New session - 2026-09-16T14:12:03.160Z`, Kimi sometimes dumps a whole prompt, and Grok names directories with URL-encoded paths. This plugin normalizes all of them into one format, with a source marker so you can tell where a session came from:

```
[codex] 09-19 20:31 · [dim] Fix GUO-108 review issues     ← delegated by dim
[codex] 09-19 12:31 · [手动] Maintain local skill          ← everything else
```

The name is derived in this order:

1. **dim task title** — for sessions dim delegated, this is already a human-readable sentence;
2. **the session's own title** — unless it is generic (`Help`, `New session - <ISO>`, a bare UUID or path, or nothing but a delegation prefix such as `你是实现者`); a delegation prefix is stripped first (`你是 Project V 的执行开发者。任务：时间轴重构` → `任务：时间轴重构`);
3. **the session's first prompt line** — delegation boilerplate (`You are an agent handling a delegated task…`) is skipped, and lines carrying an issue token (`GUO-108`) win;
4. **fallback** — `未命名会话 · <cwd tail or session id prefix>`.

#### Automatic naming (off by default)

Once enabled, a hook renames the external session right after dim delegates a task — no conversation, no CLI. It is **off by default**: renaming writes into other tools' own stores, so you opt in explicitly.

Three equivalent ways to flip it:

- **In the panel** — open the fullscreen log panel and use the "自动命名" switch in the top-right corner;
- **In the conversation** — just say "turn automatic naming on/off" (the model calls `set_auto_name`);
- **CLI** — `dim-external-agents-extend autoname --enable` / `--disable` (writes `~/.dimcode/ea-extend-config.json`).

(You can also write `{ "autoName": true }` into `~/.dimcode/ea-extend-config.json`, or set `EA_EXT_AUTO_NAME=on` — note that the macOS desktop app does not inherit shell exports, so the config file is the reliable way. Precedence: env > config > default off.)

When enabled:

- only sessions that trace back to a **dim task** are touched; sessions you created yourself are never touched;
- only **generic** titles are rewritten; a session that already has a meaningful name, or a title you set yourself, is left alone;
- only delegations from the last **2 hours** are considered (no retroactive renaming);
- a backup is taken before every write, each task is handled once, and runs are throttled to 10s.

To backfill older sessions, run it explicitly: `dim-external-agents-extend autoname --window 1440 --dry-run` (then drop `--dry-run`).

#### Writing the name back

If you want the agents' own pickers cleaned up too, the plugin writes the unified name into each agent's store:

| Agent | Write-back target | Status |
| --- | --- | --- |
| Codex | `~/.codex/session_index.jsonl` → `thread_name` | ✅ |
| Kimi | `<session dir>/state.json` → `title` + `isCustomTitle: true` | ✅ |
| Cursor | `~/.cursor/acp-sessions/<uuid>/meta.json` → `title` | ✅ |
| Grok | `<session dir>/summary.json` → `generated_title` + `title_is_manual: true` | ✅ |
| OpenCode | `~/.local/share/opencode/opencode.db` → `session.title` | ✅ |
| ZCode | `~/.zcode/cli/db/db.sqlite` → `session.title` + `title_source: 'custom'` | ✅ |

Rename safety: manual renames must name the sessions explicitly (there is no "rename everything"); the default is a preview, writing requires an explicit confirm; a backup lands in `~/.dimcode/ea-extend-backups/<timestamp>/`; and sessions whose title you set yourself are skipped unless you force it. Prefer renaming while the agent's CLI is idle — Codex rewrites its index and Grok takes a `summary.json.lock`. For OpenCode (whose database can be gigabytes) only the affected row is backed up. Pass `sourcePrefix: false` if you don't want the `[dim]` / `[手动]` marker in the written name. Every write is backed up to `~/.dimcode/ea-extend-backups/<timestamp>/`, and `dim-external-agents-extend restore` rolls the last one back byte-for-byte.

### CLI

The plugin ships a command-line tool that is available directly in dim's exec environment:

```bash
dim-external-agents-extend list                    # recent tasks
dim-external-agents-extend list --type cursor      # cursor only
dim-external-agents-extend show <taskId>           # view one task's log
dim-external-agents-extend tail <taskId>           # keep following (2s interval by default)
dim-external-agents-extend show <taskId> --json    # JSON output for scripting
dim-external-agents-extend sessions --type codex   # unified session names
dim-external-agents-extend rename --keys <key>     # preview a rename (add --apply to write)
dim-external-agents-extend autoname --window 1440 --dry-run   # backfill older sessions
dim-external-agents-extend restore                 # preview rolling a rename back
```

## Supported agents

| Agent | Task list | Execution log | Timestamps in log |
| --- | :---: | :---: | --- |
| Kimi | ✅ | ✅ | Full (per event) |
| Cursor | ✅ | ✅ | Task-level (no per-message time, see FAQ) |
| Codex | ✅ | ✅ | Full (per event) |
| Grok / OpenCode / ZCode | ✅ | Not yet | — |

> The task list comes from dim's own task database, so every agent type can be listed; execution logs require per-agent session format adapters — Kimi / Cursor / Codex are done so far.

## FAQ

**The panel opens blank?**
`ui://` resources are cached in memory by the host. Restart DimAgent after installing or updating the plugin.

**I don't see my tasks?**
By default the panel shows tasks delegated in the current session. Check "All sessions" at the top for history, and "Show finished" for completed / cancelled tasks.

**Why is the time column empty?**
Cursor's session log (`store.db`) does not record per-message timestamps, only the task-level time range (shown at the top of the log page); Kimi / Codex logs include full timestamps.

**The log says "degraded read (some formats unrecognized)"?**
That agent's log format contains parts the plugin does not recognize yet. No data is lost, but some events may be rendered in raw form — feel free to file an issue with the task ID.

**The task says "no readable log"?**
Two cases: ① the external session has been cleaned up (beyond the agent's own session retention); ② log reading for that agent type is not supported yet (Grok / OpenCode / ZCode).

**The task says "task not found"?**
The task record has been cleaned up, or the taskId is wrong.

## Uninstall

```bash
rm -rf <DIMCODE_HOME>/plugins/external-agents-extend
```

Or remove it from Dim desktop → Plugins. The plugin keeps no persistent state (it only records the current session ID and small reminder-dedup state in the system temp directory for default filtering and zero-nag behavior, cleaned up automatically by the system), so deleting the folder removes it completely.

## Development

- Onboarding entry (verified facts, data-source map, debug commands): [docs/HANDOFF.md](docs/HANDOFF.md)
- Stage-by-stage development log: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- Verification evidence: [docs/verification/](docs/verification/)

```bash
mise exec -- node --test                 # run all tests (120)
mise exec -- node scripts/validate.js    # structure & version consistency checks (same as CI)
```

## License

This project is licensed under the [MIT License](LICENSE).

Agent icons shown in the UI (Kimi / Cursor / Codex / Grok / OpenCode / ZCode) are copyright of their respective vendors and are used only as local UI identifiers; they are not covered by this project's license. Icons are extracted from locally installed apps by `scripts/build-logos.js`.
