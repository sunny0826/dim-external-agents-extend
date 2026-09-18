# Dim External Agents Extend

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> View execution logs of external-agent tasks delegated from DimAgent — status, tool calls, intermediate output, and failure reasons.

When DimAgent hands a task to an external agent (Kimi, Cursor, Codex, ...) via `agent create_external`, it runs asynchronously and the UI only shows the task status and a final summary — **the execution process is invisible**. This plugin fills that gap: each external agent writes its full execution trace to your machine (JSONL / SQLite); the plugin reads, normalizes, and displays it.

![Task list](docs/images/panel-list.png)

## Features

- **Task list** — List tasks delegated to external agents in the current session (or across all history): agent type, status, start time, and duration
- **Execution logs** — Click a task to see the full event stream: tool calls, file reads, command output, reasoning, and errors; running tasks refresh incrementally every 2 seconds
- **Inline session card** — Show task cards right in the conversation; click one to open the live log fullscreen
- **Automatic status hints** — Detect running external tasks each turn; new tasks surface a status card automatically, no need to ask
- **CLI** — `list` / `show` / `tail` commands with `--json` output for scripting
- **Local-only** — Reads local data only, no network; never modifies dim or any agent's original files

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

The plugin provides four tools, which the model calls automatically:

| Tool | Purpose |
| --- | --- |
| `list_agent_runs` | List delegated tasks (filter by agent type, status) |
| `read_agent_run` | Read a task's execution log (paginated + incremental polling) |
| `show_external_agents` | Show task cards in the conversation (click through to the live log) |
| `open_agent_run_log` | Open the fullscreen log panel |

You can also pick `/external-agents-extend` from the skills button or slash menu in the input area to open the log panel directly.

### Fullscreen log panel

![Log page](docs/images/panel-log.png)

- The header shows task context: agent, title, status, and time range
- The event stream is grouped by type: message bubbles, tool calls (a collapsible "work log" — expand to see every step), and system events (collapsible)
- With "Follow" enabled, it auto-scrolls to the latest; running tasks append incrementally every 2 seconds
- Check "All sessions" for historical tasks, and "Show finished" for completed / cancelled tasks

### CLI

The plugin ships a command-line tool that is available directly in dim's exec environment:

```bash
dim-external-agents-extend list                    # recent tasks
dim-external-agents-extend list --type cursor      # cursor only
dim-external-agents-extend show <taskId>           # view one task's log
dim-external-agents-extend tail <taskId>           # keep following (2s interval by default)
dim-external-agents-extend show <taskId> --json    # JSON output for scripting
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

Or remove it from Dim desktop → Plugins. The plugin keeps no persistent state (it only records the current session ID in the system temp directory for default filtering, cleaned up automatically by the system), so deleting the folder removes it completely.

## Development

- Onboarding entry (verified facts, data-source map, debug commands): [docs/HANDOFF.md](docs/HANDOFF.md)
- Stage-by-stage development log: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- Verification evidence: [docs/verification/](docs/verification/)

```bash
mise exec -- node --test   # run all tests (90)
```

## License

This project is licensed under the [MIT License](LICENSE).

Agent icons shown in the UI (Kimi / Cursor / Codex / Grok / OpenCode / ZCode) are copyright of their respective vendors and are used only as local UI identifiers; they are not covered by this project's license. Icons are extracted from locally installed apps by `scripts/build-logos.js`.
