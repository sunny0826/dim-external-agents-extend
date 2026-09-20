# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Pi logs** — pi runs now show their execution log. dim delegates pi through `pi-acp` (an ACP bridge), and the sessions it creates land in the same place as your own: `~/.pi/agent/sessions/<cwd>/<timestamp>_<uuid>.jsonl`. A session is located by the timestamp in its filename (30s window) with the same tie-breakers as grok: prompt fingerprint → Issue-ID token → closest timestamp. Pi's format is **append-only JSONL** (version 3) — the opposite of opencode — so it uses a plain byte offset like Kimi / Codex / Grok, and a half-written trailing line is left for the next read. Pi writes one line per assistant turn, so a turn's content appears once that line lands; like opencode this trades a little latency for logs that are never duplicated or truncated. The adapter maps `session` / `model_change` / `thinking_level_change` / `custom` records and all four message roles (user, assistant, toolResult, system) into the normalized stream, including thinking, assistant text, tool calls with arguments, tool results with error status, token usage with cost, and assistant errors. Two large fields are stripped: `image` parts carry base64 (measured 312KB in one case) and `toolResult.details` is a **Python repr string**, not JSON, that can embed an entire file — only MIME type, byte size and a truncated preview reach an event. Verified against all 89 sessions on this machine: zero unknown records, zero warnings, paginated reads matching a one-shot read event for event, no base64 fingerprints anywhere in the output, and 89/89 sessions resolving to themselves
- **OpenCode logs** — opencode runs now show their execution log instead of `no readable log: opencode session lookup is not supported yet`. A session is located by `~/.local/share/opencode/opencode.db` `session.time_created` (30s window, since the CLI takes seconds to boot) with the same tie-breakers as grok: prompt fingerprint → session title → Issue-ID token → closest timestamp; on this machine all 4 opencode runs resolve with high confidence. The adapter turns `message` / `part` rows into the normalized stream (task prompt, thinking, assistant text, tool calls with arguments and results, step boundaries, token usage and cost, patches, compaction, attached files). Unlike the append-only jsonl agents, opencode is **state-based**: a `part` row is rewritten as it progresses (`tool` goes `running` → `completed`) and text is streamed into it (measured up to 35s of streaming for text and 83s for reasoning), so a byte-offset or monotonic-timestamp cursor would leave a tool stuck on "running" forever and truncate streamed text. The adapter therefore uses opencode's own step structure as a **stability boundary** and only emits a step's content once that step has finished — a running task's log may lag by one step, but it is never duplicated or truncated mid-stream, and a `tool_in_flight` warning tells you a tool call has not returned yet. The cursor is a `(time_created, id)` tuple, so every part is emitted exactly once. Inline `file` parts keep only their MIME type and filename — the base64 data URI (measured up to several MB each) never enters an event

### Changed

- **A task's log folds to one line by default** — the log detail page now shows a single trajectory summary (`思考3轮 · 读1次文件、改2次文件、执行2次命令、搜索1次`) instead of one row per thinking step and tool call. Clicking the row expands the full trail: thinking lines, tool calls with their arguments, tool results, and grouped system events. The agent's own text output stays visible at full width, and the stream is split at each text output — a task that narrates between tool batches gets one summary row per batch. A failing call turns the summary red while still folded, and an expanded row stays expanded across the 2s poll rebuild. The fold replaces the previous "工具调用" group (which only appeared for ≥2 consecutive calls) and now covers every non-text event, single call included

## [0.1.0] - 2026-09-19

External-agent session names are now normalized and can be written back, so both the plugin and the agents' own pickers become readable.

### Added

- **Unified session names** — `list_external_sessions` lists the sessions each agent keeps for itself (Codex / Kimi / Cursor / Grok / OpenCode / ZCode) with one display format and a source marker: `[codex] 09-19 20:31 · [dim] Fix GUO-108 review issues` for sessions dim delegated, `[手动]` for everything else. Naming priority: dim task title → the session's own title (generic ones such as `Help`, `New session - <ISO>`, bare UUID/path, or nothing but a delegation prefix are rejected; delegation prefixes are stripped first) → first meaningful prompt line (delegation boilerplate skipped, issue-token lines preferred) → `未命名会话 · <cwd tail or session id prefix>`. Session sources are per-agent: Codex `session_index.jsonl` (creation time from the rollout `session_meta`), Kimi `state.json`, Cursor `meta.json`, Grok `summary.json.generated_title`, OpenCode `session.title`, ZCode `~/.zcode/cli/db/db.sqlite`
- **Automatic naming (opt-in, off by default)** — a hook (`hooks/auto-name.js`, wired into UserPromptSubmit / PostToolUse / Stop) renames the external session right after dim delegates, so no conversation or CLI is needed: only sessions traced to a dim task, only generic titles, only delegations from the last 2 hours, backup before write, one pass per task, 10s throttle, silent. Since it writes into other tools' stores it is disabled by default; enable with `dim-external-agents-extend autoname --enable`, `{"autoName": true}` in `~/.dimcode/ea-extend-config.json`, or `EA_EXT_AUTO_NAME=on` (precedence: env > config > default off). `auto_name_sessions` (tool) and `autoname` (CLI) backfill older sessions explicitly and are not affected by the switch
- **Session rename with write-back** — `rename_external_sessions` writes the unified name into the agent's own store: Codex `session_index.jsonl` (`thread_name`), Kimi `state.json` (`title` + `isCustomTitle`), Cursor `meta.json` (`title`), Grok `summary.json` (`generated_title` + `title_is_manual`, since `session_search.sqlite` is only a rebuilt search index), OpenCode `opencode.db` (`session.title`), ZCode `~/.zcode/cli/db/db.sqlite` (`session.title` + `title_source: 'custom'`). Requires explicit session keys (no "rename everything"), previews by default, backs up before writing (the whole file, or just the affected row for OpenCode's multi-gigabyte DB), is idempotent, and skips titles you set yourself unless forced
- **New skill `external-session-names`** — triggers on "the external agent session names are a mess / hard to tell apart / unify them"; the existing `external-agents-extend` skill points to it for that case
- **Grok logs** — grok runs now show their execution log instead of `no readable log: grok session lookup is not supported yet`: a grok session is located by `~/.grok/sessions/<cwd>/<id>/summary.json` `created_at` (measured 0.1–2.8s after delegation), with a **prompt fingerprint** as the primary tie-breaker (parallel delegations create sessions ~90ms apart, which timestamps alone cannot separate), then Issue-ID tokens, then the closest timestamp; a new adapter turns `updates.jsonl` into the normalized stream (tool calls with arguments, tool results with status, thinking, assistant text, plan, retries, background tasks, token usage) with byte-offset incremental reads. All 8 grok runs on this machine now resolve with high confidence
- **Status filter covers every state** — the 筛选 popover now lists running / completed / cancelled / failed as independent checkboxes (plus the all-sessions scope), so any status or combination is reachable; `list_agent_runs` gained `statuses` (an empty array means no status filter) and the default view stays this session with running work only
- **跟随 is a toggle now** — the log page's follow control uses the same track + knob switch as 自动命名, and the dead `label.follow` rules were replaced by `#followSwitch` scoping
- **Header alignment** — the automatic-naming switch no longer sits ~2px above the title, badge and refresh button: its wrapper was a plain block, so the inline-flex label was baseline-aligned to the top of the line box and left a strut's descender space below it; the wrapper (and the filter's) is now a flex container
- **Panel polish** — the list page's filters are now a single **筛选** button with a popover (all sessions / show finished / **show failed**, defaulting to this session with finished *and* failed hidden, `includeFailed` added to `list_agent_runs`); filters and the automatic-naming switch are list-page-only, so a task's log page no longer shows list-scoped controls; the automatic-naming control is a real toggle with a hover tooltip; the log page header now shows the agent's logo
- **Switch it from the desktop** — the automatic-naming switch is reachable three ways: a "自动命名" toggle on the panel's **list page** (top-right; it is a global setting, so it stays out of a task's log page), saying it in the conversation, or `autoname --enable` / `--disable`. The widget drives the new `get_settings` / `set_auto_name` tools. DimAgent's native plugin settings page is only for built-in plugins (it reads `settingsSchema` + `controller` from the bundle), so third-party plugins have to render their own switch
- **Rollback** — every write is backed up first; `restore_backups` (tool) and `restore` (CLI) roll the latest backup back byte-for-byte, file-based backups automatically and database row backups by report. Renames also preserve the original file formatting (a minified `state.json` stays minified)
- **CLI** — `sessions` (unified list, with `--type` / `--since` / `--search` / `--all`), `rename` (preview by default, `--apply` to write), `autoname` (backfill, `--window` / `--dry-run`) and `restore` (rollback, preview by default)
- **Model visibility** — the task list shows the model chosen at delegation time (`default` is displayed as 默认), and the log header shows the model actually used by the external session: Kimi (`modelAlias`), Cursor (assistant `modelName`), Codex (`turn_context` / `thread_settings`). `list_agent_runs` returns `model` per run, `read_agent_run` returns `session.model`, and the CLI `show` command prints both
- **Markdown tables** — agent text output now renders GFM-style tables (`| a | b |` plus a `|---|` separator row) as real tables: header styling, per-column alignment (`:---`, `:---:`, `---:`), inline formatting inside cells, and horizontal scrolling for wide tables
- **Proactive completion reports** — when an external task finishes or fails, the next turn receives an automatic `[外部 Agent 完成]` digest (tasks finished within the last 4 hours, deduped per task), so you no longer have to ask for the result; running-task hints now scope to the current session
- **Precise delegation capture** — a new `PostToolUse` hook (matcher: `agent`) records every `create_external` delegation into a temp state file with the taskId resolved via `sourceToolCallId`; the `Stop` hook reminds from that record first and only falls back to scanning the task DB (per-session, 10-minute window), which removes cross-session misfires

### Fixed

- **Running external agents could look "unrecognized" in a concurrent session**: `scope: session` resolved through a single global file that any session's hook overwrites, so with two dim sessions in use the panel could resolve to the wrong session and show an empty list. The file now records a map of recently active sessions, and when the resolved session has no runs **while another session still has work running**, the list falls back to all sessions with an explicit `scopeFallback` reason (plus `sessionId` on every run) instead of silently returning nothing — if the only other tasks are historical (completed / failed / cancelled) it keeps the session-scoped empty state, so the default view never dumps old failures. `list_agent_runs` also accepts an explicit `sessionId`
- The panel's automatic-naming switch reused the `label.follow` class, and `body.view-list label.follow{display:none}` scopes that class to the log page — so a global setting ended up visible only inside a task's log detail and invisible on the list page. It now uses its own `label.global` class (list page only, hidden in the log view and the inline card), with a test locking that intent
- Markdown tables in the execution log rendered as plain text; the renderer now supports tables in addition to headings, lists, quotes, and code blocks
- The `Stop` hook could not read the session ID (it only checked camelCase `sessionId` while the host sends snake_case `session_id`), so its diagnostics and session scoping were unreliable
- OpenCode session titles such as `New session - <ISO>` now fall back to the first user message; OpenCode stores message/part content in a `data` JSON column, which the fallback now parses
- Codex session creation time is read from the rollout's `session_meta` instead of `session_index.updated_at` (last activity), so dim task titles match the right session

[0.1.0]: https://github.com/sunny0826/dim-external-agents-extend/releases/tag/v0.1.0

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
