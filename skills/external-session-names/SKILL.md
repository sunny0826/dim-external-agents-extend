---
name: external-session-names
description: 统一外部 agent（codex / kimi / cursor / grok / opencode / zcode）自己那些会话的名称——把它们五花八门、看不出区别的标题收敛成统一格式（带 [dim] / [手动] 来源标记），并可按需把统一名称写回各 agent 的会话存储（改名）。新委托的会话由 hook 自动命名，无需对话或命令行。当用户说"外部 agent 的会话名太乱 / 分不清 / 太难看 / 想统一命名 / 帮我整理一下会话列表 / 找某个外部会话 / 为什么这条会话没改名"，或想按 agent 列出全部历史会话时使用本技能。
---

# External Session Names（外部会话名称统一）

各外部 agent 自己会攒下成百上千个会话，标题五花八门：codex 是中英混杂的短语（`Help`、`Simplify and refactor codebase`）、cursor 是泛化英文（`Code Review Agent`）、opencode 直接是 `New session - 2026-09-16T14:12:03.160Z`、kimi 会把整段 prompt 当标题、grok 的目录名是 URL 编码路径。本技能把它们统一成一种可读格式，并在你确认后把新名字写回各 agent 自己的存储。

数据全部来自本机（dim 任务库 + 各 agent 自己的会话文件/数据库），只读扫描；只有 `rename_external_sessions` 且 `apply: true` 时才会写入。

## 统一命名规则

**展示名**：`[codex] 09-19 20:31 · [dim] 修复 GUO-108 审查问题（P0/P1/P2）`
**统一名**（实际写进各 agent 自己存储的名字）：`[dim] 修复 GUO-108 审查问题（P0/P1/P2）`

- `[dim]` = 由 dim 委托产生的会话；`[手动]` = 其它来源（你手动开的，或别的编排器拉起的）。
  没有关联到 dim 任务的会话标 `[手动]`；如果它其实是被别的编排器（如 slock）拉起的，
  工具输出里的 `delegated: true` 会说明这一点。
- 标题按以下优先级推导：

1. **dim 任务标题**（`background_tasks.metadata.taskTitle`）——dim 委托过的会话优先用它，本来就是人话中文；
2. **会话自身标题**——当它不是通用标题时（`Help`、`New session - <ISO>`、纯 uuid、纯路径、只剩委托前缀的「你是实现者」等会被识别为通用）；带委托前缀的标题会先剥掉前缀（`你是 Project V 的执行开发者。任务：时间轴重构` → `任务：时间轴重构`）；
3. **会话首条 prompt**——跳过委托包装样板（`You are an agent handling a delegated task…` 这类），含 `GUO-108` 形式 token 的行优先；
4. **兜底**：`未命名会话 · <工作目录末段 或 会话短码>`。

- 同一 agent 内出现重名时，统一名追加 `· 09-19` 保持可区分。

## 自动改名（默认关闭，需显式开启）

开启后，dim 每次委托任务，插件的 hook（`hooks/auto-name.js`，挂在 UserPromptSubmit / PostToolUse / Stop）会**自动**把该外部会话的泛化标题改写成统一名——你不用在对话里说，也不用敲命令。**默认关闭（opt-in）**：改名会写进别的工具自己的存储，必须由你显式打开。

边界（比手动改名更保守）：

- 只处理**能关联到 dim 任务**的会话，你手动开的会话一律不碰；
- 只处理**会话自身标题泛化**的（名称已有信息量的不动，你自定义过标题的更不动）；
- 只回溯最近 **2 小时**内委托的任务（不翻旧账）；
- 写前照常备份；每个 taskId 只处理一次；10 秒节流；
- 静默：不打印任何内容、不影响 hook 的放行/阻止语义。

开关方式（三种，等价）：

1. **桌面端面板**：打开全屏面板（`open_agent_run_log`）后，右上角「自动命名」开关点一下；
2. **对话里说一句**：「把自动命名打开 / 关掉」→ 调用 `set_auto_name`（`get_settings` 读当前状态）；
3. **命令行**：`dim-external-agents-extend autoname --enable` / `--disable`。

等价的手工方式：配置文件 `~/.dimcode/ea-extend-config.json` 写 `{ "autoName": true }`；
或环境变量 `EA_EXT_AUTO_NAME=on`（注意 macOS 桌面 App 不继承 shell 的 export，配置文件才可靠）。
优先级：环境变量 > 配置文件 > 默认（关闭）。

想**回填**更早的会话（自动改名不翻旧账）时，显式调用一次：

```bash
dim-external-agents-extend autoname --window 1440 --dry-run   # 先看 24 小时内的计划
dim-external-agents-extend autoname --window 1440            # 确认后写入
```

## 工具

1. **`list_external_sessions`** — 列出各 agent 的会话（可按 `agentType` / `since` / `search` 过滤，默认最新在前）。
   每条返回：`key`（改名要用的稳定 id，形如 `codex:01a0b7ee-…`）、`agentType`、`displayName`（统一展示名）、`unifiedName`（要写入的统一名）、`title` / `titleSource`（dim-task / session / prompt / fallback）、`source`（dim / manual）、`delegated`、`rawTitle`（原名）、`customTitle`（用户自己设过标题）、`dimTask`、`writable`。
2. **`rename_external_sessions`** — 把统一名称写回各 agent 自己的存储。**必须显式给 `keys`**（没有"全部重命名"）。`apply` 默认 false（只出计划），确认后再 `apply: true`；写入前自动备份到 `~/.dimcode/ea-extend-backups/<时间戳>/`。你自己手动设过标题的会话默认跳过（要改加 `force: true`）；`sourcePrefix: false` 可去掉 `[dim]` / `[手动]` 标记。
3. **`auto_name_sessions`** — 批量回填（默认只看最近 120 分钟、最多 20 条、只出计划）。日常新委托由 hook 自动处理，这个工具用于显式补历史。
4. **`restore_backups`** — 从备份目录回滚改名（默认最新备份、默认只预览）。文件级备份按字节还原；数据库行级备份（opencode / zcode）只报告，需按记录手动改回。
5. **`get_settings` / `set_auto_name`** — 读 / 写自动命名开关（面板上的那个开关就走这两个工具）。**要改开关前先问用户**，不要擅自开启。

回写目标（每个 agent 自己的真实存储）：

| agent | 写回位置 | 状态 |
|---|---|---|
| codex | `~/.codex/session_index.jsonl` → `thread_name` | 支持 |
| kimi | `<会话目录>/state.json` → `title` + `isCustomTitle: true` | 支持 |
| cursor | `~/.cursor/acp-sessions/<uuid>/meta.json` → `title` | 支持 |
| grok | `<会话目录>/summary.json` → `generated_title` + `session_summary` + `title_is_manual: true` | 支持 |
| opencode | `~/.local/share/opencode/opencode.db` → `session.title` | 支持 |
| zcode | `~/.zcode/cli/db/db.sqlite` → `session.title` + `title_source: 'custom'` | 支持 |

写回细节与坑：

- **grok** 的权威标题在 `summary.json`，`session_search.sqlite` 只是会重建的搜索索引（写它没用）；置 `title_is_manual: true` 后自动命名不再覆盖。grok 自己用 `summary.json.lock`，**建议 grok 未运行时改名**。
- **opencode** 只覆盖默认标题（`New session - <ISO>` 这类），写入非默认名即持久；库很大（本机 3.3 GB），所以只备份受影响的那一行，不整库备份。
- **zcode** 要区分两个库：会话在 `~/.zcode/cli/db/db.sqlite`，桌面 app 的 `~/.zcode/v2/tasks-index.sqlite` 是任务索引（不是会话表，仅展示、不回写）。
- **codex** 的 `session_index.jsonl` 由 CLI 自己维护，它运行时可能整体重写，建议空闲时改名。
- **kimi** 写回时会置 `isCustomTitle: true`，与它自己的重命名语义一致。

## 工作流

1. 先 `list_external_sessions` 看清现状（建议带 `agentType` 和 `limit`，别一次拉全量）；
2. 向用户汇报时**直接给统一展示名**（含 `[dim]` / `[手动]` 来源标记），不要复述原始乱名；说明有多少条是 dim 任务标题推导、多少条是兜底命名；
3. 若用户问「为什么这条没改名」：自动命名**默认关闭**，先看开关状态（`autoname` 输出会显示「自动命名：已关闭（默认）」）；开启后只处理 2 小时内的新委托、只动泛化标题、不碰自定义标题；更早的用 `auto_name_sessions` 显式回填；用户想开启时用 `autoname --enable`（需用户同意，不要擅自开启）；
4. 用户要手动改名时：挑出目标 `key` → 先 `rename_external_sessions`（不传 `apply`）出计划 → 把「原名 → 新名」列给用户确认 → 再 `apply: true`；
5. 写回后告知备份目录，以及哪些被跳过（自定义标题 / 不支持写回的记录）。

## 命令行（等价能力，位于 exec PATH）

```bash
dim-external-agents-extend sessions --type codex --limit 20
dim-external-agents-extend sessions --search "GUO-108" --json
dim-external-agents-extend rename --keys codex:01a0b7ee-a483-7a70-835b-78b7f93349e7
dim-external-agents-extend rename --keys kimi:session_a2ec…,cursor:a887ba64-… --apply
dim-external-agents-extend autoname --window 1440 --dry-run
dim-external-agents-extend restore --apply    # 改错了？按备份回滚（先不带 --apply 预览）
```

## 注意事项

- **不要批量改名**：只改用户明确点名或确认过的会话；不确定就先出计划让用户看；
- `titleSource: dim-task` 说明这条会话由 dim 委托产生，改名会影响外部 CLI 的会话列表显示，但不影响 dim 侧记录；
- 同一会话被 dim 任务标题命名时，若 dim 库不可读会降级为会话自身标题，并带 `db_unavailable` 警告；
- 外部 CLI 正在运行时自己的存储可能被重写（codex 索引、grok 的 `summary.json.lock`），建议在对应 CLI 空闲时改名；
- **改错了可以回滚**：每次写入前都会备份到 `~/.dimcode/ea-extend-backups/<时间戳>/`，用 `dim-external-agents-extend restore`（默认最新备份、默认只预览）即可按字节还原；数据库行级备份需要按记录手动改回；
- 会话名里可能包含任务信息（含 Issue 编号、仓库路径），属于本机敏感内容，不要外传。
