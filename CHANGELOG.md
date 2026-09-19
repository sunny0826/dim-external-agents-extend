# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Model visibility** — the task list shows the model chosen at delegation time (`default` is displayed as 默认), and the log header shows the model actually used by the external session: Kimi (`modelAlias`), Cursor (assistant `modelName`), Codex (`turn_context` / `thread_settings`). `list_agent_runs` returns `model` per run, `read_agent_run` returns `session.model`, and the CLI `show` command prints both
- **Markdown tables** — agent text output now renders GFM-style tables (`| a | b |` plus a `|---|` separator row) as real tables: header styling, per-column alignment (`:---`, `:---:`, `---:`), inline formatting inside cells, and horizontal scrolling for wide tables
- **Proactive completion reports** — when an external task finishes or fails, the next turn receives an automatic `[外部 Agent 完成]` digest (tasks finished within the last 4 hours, deduped per task), so you no longer have to ask for the result; running-task hints now scope to the current session
- **Precise delegation capture** — a new `PostToolUse` hook (matcher: `agent`) records every `create_external` delegation into a temp state file with the taskId resolved via `sourceToolCallId`; the `Stop` hook reminds from that record first and only falls back to scanning the task DB (per-session, 10-minute window), which removes cross-session misfires

### Fixed

- Markdown tables in the execution log rendered as plain text; the renderer now supports tables in addition to headings, lists, quotes, and code blocks
- The `Stop` hook could not read the session ID (it only checked camelCase `sessionId` while the host sends snake_case `session_id`), so its diagnostics and session scoping were unreliable

## [0.0.2] - 2026-09-18

Interface refresh: the event stream is now a full-width agent trace instead of chat bubbles, agent text is Markdown-rendered, and consecutive tool calls collapse into groups. The visual system moved to a neutral, border-first engineering style.

### Changed

- **Event stream redesign**: one line per event (icon, label, parameter summary, timestamp, expand chevron) with expanded content in a left rail — no more avatars, bubbles, or cards; matches the timeline language of DimAgent itself
- **Markdown rendering** for agent text output: headings, lists, task items, quotes, code blocks, and inline code/bold/italic — rendered by a zero-dependency, DOM-only renderer (no `innerHTML`, CSP-safe)
- **Tool-call grouping**: consecutive tool events collapse into a "tool calls" group when there are 2+ calls, with a per-tool count summary (e.g. `read ×5 · search ×1 (6 steps)`); expand to inspect each step; failures surface on the group header
- **Neutral-first visual system**: removed the purple accent, glassmorphism, glow background, and pill badges; border-first surfaces, tightened corner radii, desaturated status colors; the task list is now a row list with hairline separators
- **Expansion state is preserved** when the running-task view rebuilds on its 2s polling cycle

### Fixed

- Error styling on collapsed group headers no longer bleeds into child rows

[0.0.2]: https://github.com/sunny0826/dim-external-agents-extend/releases/tag/v0.0.2

## [0.0.1] - 2026-09-18

First public release: view execution logs of external-agent tasks delegated from DimAgent (Kimi / Cursor / Codex, ...) — status, tool call sequences, intermediate output, and failure reasons.

### Added

- **Task list** (`list_agent_runs`): list tasks delegated in the current session or across all history, filterable by agent type and status
- **Execution log** (`read_agent_run`): normalized event stream (tool calls / tool results / text / reasoning / usage / steps) with cursor pagination; incremental reads for running tasks (~2s granularity)
- **Fullscreen log panel** (`open_agent_run_log`): chat-style event stream, collapsible tool-call blocks, follow mode, light & dark themes
- **Inline session card** (`show_external_agents`): show recent task cards in the conversation, click through to the live log
- **Automatic status hints**: `UserPromptSubmit` / `Stop` hooks detect running external tasks and surface them automatically
- **CLI**: `dim-external-agents-extend list / show / tail`, with `--json` output
- **Plugin skill**: `/external-agents-extend` opens the log panel directly
- **Log adapters**: Kimi (`wire.jsonl`), Cursor (`store.db`), Codex (rollout JSONL); Grok / OpenCode / ZCode are supported in the task list

### Notes

- Runs entirely on your machine: reads local data only, no network; zero third-party dependencies, no build step — uses the Node runtime bundled with DimAgent
- Requires DimAgent desktop (tested on 0.9.32)

[0.0.1]: https://github.com/sunny0826/dim-external-agents-extend/releases/tag/v0.0.1
