# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
