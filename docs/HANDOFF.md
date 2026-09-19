# 交接文档：DimAgent 外部 Agent 扩展插件（`external-agents-extend`）

> 生成时间：2026-09-17 ｜ 来源：DimAgent 桌面会话的可行性调研（原会话工作区在 project-v；本插件不隶属 project-v，现于本仓库 `dim-external-agents-extend` 开发，本文档为权威版本）
> 修订记录（2026-09-17 接手会话核验）：基线全部复核通过（DimAgent 0.9.32 / dim CLI 0.5.5 / 嵌入式 node v24.18.0 / 样本任务可复现 / `node:sqlite` 可用）；2.1 补时间列格式、2.2 修正 kimi 事件层级并补实测统计、2.4 补 node 版本差异、第 4 节定仓库结构、文末清单同步。
> 更名（2026-09-17，用户决定）：插件由暂名 `agent-log` 更名为 **`external-agents-extend`**，命名空间为 `plugin:external-agents-extend/<server>`。阶段 0 验证记录中的旧名输出是当时的原始证据，保留不改。
> 阅读对象：接手本项目的开发者 / Agent 会话。读完本文即可开工，**无需重新调研**——"已验证事实"一节均为本机实测结论。

---

## 1. 项目目标

做一个 DimAgent 插件，让用户能在 dim 里查看由 dim 后台拉起的外部 agent（kimi / cursor / codex / grok / opencode / zcode）委托任务的执行日志：运行状态、工具调用序列、中间输出、失败原因。

**背景与动机**

- dim 通过 `agent create_external` 拉起外部 agent 后异步执行，UI 只显示任务状态与最终摘要，执行过程不可见。
- 实测确认 dim 不保存外部 agent 的过程日志（详见 2.1），但**每个外部 agent 各自把完整执行轨迹写在本机**（JSONL / SQLite），插件读取并归一化展示即可。
- 可行性分档：**事后查看、近实时（2s 轮询）可行**；完全实时流式（终端式）不可行——需 dim 官方开放接口，不在本方案范围。

---

## 2. 已验证事实（本机实测，2026-09-17）

**环境版本**：DimAgent 桌面 `0.9.32`；dim CLI `dimcode 0.5.5`；dim 嵌入式 node `v24.18.0`（实际路径：`/Users/guoxudong/Library/Application Support/DimAgent/runtimes/node/v24.18.0/darwin-arm64/node-v24.18.0-darwin-arm64/bin/node`，即 PATH 里的 `node`）。

### 2.1 dim 侧数据（任务源）

- 数据库：`~/.dimcode/v2/dimcode.sqlite` → 表 `background_tasks`
  - 过滤条件 `toolName='agent'`（其余值为 `exec` / `schedule_wakeup`）。
  - 关键列：`taskId`、`sessionId`、`status`（running/completed/failed/cancelled）、`metadata`、`completion`、`startedAt`、`completedAt`。
  - ⚠️ `startedAt` / `completedAt` 为 **ISO 8601 文本**（实测值如 `2026-09-16T11:52:50.749Z`），不是毫秒数；SQL 中不要按毫秒换算（`startedAt/1000` 会得到 1970 年），按字符串排序／比较即可。
  - `metadata` JSON 字段：`subagentType` / `externalAgentType`（外部 agent 时两者一致；内部子 agent 为 `tui_worker`）、`childSessionId`、`taskTitle`、`agentName`、`subagentInput.prompt`、`selectedProviderId/ModelId`。
  - **agent 任务 `outputPath` 为空；`completion` 仅为最终结果摘要——过程不落盘。**
  - 历史分布（150 条）：cursor 84、kimi 37、grok 18、opencode 4、codex 3、zcode 1、tui_worker 3。
- 拉起机制：桌面主进程（DimAgent.app）直接 spawn 外部 CLI，子进程 cwd = 任务工作区；stdout/stderr 走管道/套接字（插件无法截获）。
- `app.asar` 中无读取外部会话目录的代码（`.kimi-code/sessions`、`acp-sessions` 等命中 0 次）——插件填补的空白真实存在。

### 2.2 外部 agent 数据源地图

| agent | 路径 | 格式 | 备注 |
|---|---|---|---|
| kimi | `~/.kimi-code/sessions/<wd_hash>/<session_xxx>/agents/main/wire.jsonl` | JSONL，**两层信封结构**（protocol_version 1.5）：顶层 `type` 为 `context.append_loop_event` 等 16 种；工具调用与文本在**内层** `event.type`：`tool.call` / `tool.result` / `step.begin` / `step.end` / `content.part`（再内层 `event.part.type` = `think` 或 `text`）；`llm.request` 为独立顶层类型 | **最佳数据源**；同目录还有 `logs/kimi-code.log`（会话级 LLM 日志）、`state.json`（`lastPrompt` 含任务 prompt）、`notify/`；全局 `~/.kimi-code/session_index.jsonl`（sessionId/sessionDir/workDir） |
| cursor | `~/.cursor/acp-sessions/<uuid>/` | `store.db`（SQLite）：表 `blobs(id,data)` 内容寻址、data 为 JSON 消息；表 `meta` 1 行 hex-JSON；`meta.json` 含 cwd/title | 目录 birthtime 可作创建时间；**消息顺序已可恢复**（2026-09-17：`meta`→`latestRootBlobId`→快照 protobuf field#1 有序列表，详见阶段 1 记录） |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL，每行 `{timestamp, ordinal, type, payload}`；首行 `session_meta`（含 session_id/cwd/originator） | 公开生态格式 |
| opencode | `~/.local/share/opencode/opencode.db` + `storage/` + `log/` | SQLite（表 `session` `message` `part` `event` `todo` 等） | 后续扩展 |
| grok | `~/.grok/sessions/<urlencoded-workspace>/<uuid>/` | 多文件目录（19 项/会话）+ `session_search.sqlite` | 后续扩展 |
| zcode | `~/.zcode/v2/tasks-index.sqlite` + `logs/` | SQLite + logs | 后续扩展 |

**wire.jsonl 实测样本统计**（2026-09-16 会话，482 行，protocol_version 1.5；2026-09-17 复核）：

- 顶层 `type`：`context.append_loop_event` 297、`llm.request` 53、`usage.record` 53、`token_counting.measured` 53、`file_history.tracked` 7、`context.append_message` 6，其余 10 种（`prompt.accepted`、`turn.prompt`、`metadata`、`plugin.session_start` 等）各 1–2 条。
- 内层 `event.type`（位于 `context.append_loop_event.event`）：`tool.call` 65、`tool.result` 63、`content.part` 63（其中 `think` 53、`text` 10）、`step.begin` 53、`step.end` 53。
- **适配器要点**：工具调用、步骤、文本均不在顶层，必须解包 `context.append_loop_event.event`（及 `event.part`）；只读顶层 `type` 会漏掉全部过程内容。

### 2.3 任务↔会话映射（关键机制，已核验；**2026-09-17 修正样本对应**）

- 方法：`taskId` 前 13 位即任务创建的毫秒时间戳；与外部会话创建时间（kimi：`state.json.createdAt`；cursor：目录 birthtime；codex：rollout 首行 `payload.timestamp`）匹配，实测误差 < 1s。
- ⚠️ **并行任务必须 token 消歧**：并行任务的外部会话创建时间可仅差 **1ms**（实测），纯时间戳最近邻会选错。做法：从 `taskTitle`/`prompt` 提取 Issue ID token（`[A-Z]{2,}-\d+`）与会话 `state.json.lastPrompt` 交叉比对（kimi，命中唯一候选 → `matchedBy: timestamp+token`）。反例：kimi 的 `lastPrompt` 是改写包装文本（80 字符切片命中率 1/13）、cursor 的 `meta.json.title` 是自动英文标题——**均不能作相等性校验**，只能作消歧加分；多候选接近（差 <1s）时输出 `ambiguous_candidates` 警告。
- 已核验样本（2026-09-17 修正；原记录两个样本**对应颠倒**，系纯时间戳最近邻所致）：
  - `task_1789559570749_9kvwq6`（GUO-63） ↔ `~/.kimi-code/sessions/wd_project-v_2138e21490eb/session_66159b01-bde9-4f73-9bd1-82ae12e0b22e`（差 579ms）
  - `task_1789559570654_00qg0m`（GUO-62） ↔ `~/.kimi-code/sessions/wd_project-v_2138e21490eb/session_c46bdf25-aaa0-472a-be7c-22500046b20a`（差 578ms）
  - 证据：两会话 wire.jsonl 中 GUO-63 出现 47/0 次、GUO-62 出现 0/29 次（互斥）；详见 `docs/verification/2026-09-17-stage1/RESULTS.md`。
- 映射器实现：`server/src/core/mapping.js`（cursor 容差 20s——实测目录创建晚于派发 5.8s；kimi/codex 5s；不支持的 agent 返回 `unsupported`）。

### 2.4 Dim 插件机制要点

- 插件结构：`.codex-plugin/plugin.json` 清单 + 可选 `skills/`、`hooks`、`.mcp.json`、`bin/`。
- 本地开发根：`~/.agents/plugins/<name>/`；分发安装：Dim 桌面 Plugins → Add plugin 填 git URL，装到 `<DIMCODE_HOME>/plugins/`。
- 脚手架/校验脚本：`/Users/guoxudong/.dimcode/v2/skills/plugin-creator/scripts/{create_basic_plugin.py,validate_plugin.py}`（随 skill 版本变化，开工前先读同目录 SKILL.md）。
- MCP server：stdio 从 plugin root 运行（相对 args 可用）；id 命名空间 `plugin:<name>/<server>`；格式错误的 server 会被**静默丢弃**。
- MCP App（widget）：工具 `_meta.ui` 严格校验（`resourceUri` 必须 `ui://`；`displayMode` 为 `inline|fullscreen`；`visibility` 为数组）；`ui://` 资源必须返回恰好 1 条 `text/html;profile=mcp-app` 内容；widget 可调同 server 的 `visibility:["app"]` 工具；CSP 只能放声明过的外部域（本方案无需外域，纯本地）。**widget 还必须实现 Ext Apps 握手**（发 `ui/initialize`，params 含 `appInfo`/`appCapabilities`/`protocolVersion:"2026-01-26"`；收 result 后发 `ui/notifications/initialized`）——否则宿主不显示内容且**静默无报错**（iframe opacity:0），详见 `docs/verification/2026-09-17-stage0/RESULTS.md` T0.3 节。
- hooks：插件声明仅支持 10 个事件（SessionStart/SubagentStart/PreToolUse/PermissionRequest/PostToolUse/PreCompact/PostCompact/UserPromptSubmit/SubagentStop/Stop），**无 external agent 生命周期事件**；声明未识别事件会让整个 hooks 文件被拒（`Unsupported hook event`）。阶段 3 起采用「UserPromptSubmit 状态注入 + PostToolUse 委托捕获 + Stop 提醒」方案（见阶段 3 增强记录）。
- 运行时：MCP server 用 `node`（即 dim 嵌入式 v24.18.0）；**实测 `node:sqlite`（DatabaseSync）可用**，零第三方依赖即可只读 cursor `store.db`。
  - 版本差异（2026-09-17 复核）：dim node v24.18.0 调用无警告；升级前 mise 全局 node v24.12.0 可用但打印 `ExperimentalWarning`。现已用 `mise.toml` 将开发 node 固定为 **24.18.0**（与运行时同版本），差异消失。
  - 只读实测：`new DatabaseSync(path, {readOnly: true})` 读 cursor `store.db` 成功（样本 blobs 293 行）。
- ⚠️ `dim mcp test plugin:<name>/<server> --json` 的 `tools` 字段在 dimcode 0.5.5 **恒为空数组**（对照已正常工作的 `plugin:nowledge-mem/nowledge-mem` 亦然）——连通性判定以 `success: true` 为准；工具可用性必须用 `dim exec` 新会话实际调用验证。
- ⚠️ dim 对 `tools/list` 响应做 zod 严格校验：工具缺 `inputSchema` 时直接报错（`Failed to discover tools from server ... inputSchema: expected object, received undefined`），**不是静默丢弃**——工具定义必须带完整 `inputSchema`。
- ⚠️ 插件注册表在**应用启动时**加载——更名/新增插件后需**重启应用**（仅开新会话不够）；`ui://` 资源另有主进程内存缓存（按 `serverId+uri`），修改 widget 后同样需重启应用（或触发 server 断开重连）才生效。
- ⚠️ **重启后启动竞态（2026-09-17 实测）**：plugin MCP 连接是**异步**建立的（app 启动后 ~13 秒才拉起 server 进程；插件元数据扫描 <1s）——**此窗口内新建的会话不会注册插件工具**（工具列表在会话创建时固定，该会话内无法恢复）。**重启后等 ~20 秒再开新会话**。

---

## 3. 实施方案（任务清单）

> 预估总量 3–5 个工作日（取决于 T1.4 cursor 调查深度）。M1（阶段 0–2）→ M2（阶段 3）→ M3（阶段 4–5）。

### 阶段 0 · 技术验证（0.5 天）
- [x] T0.1 插件骨架冒烟（2026-09-17 ✅）：脚手架生成、落位仓库根；软链接 `~/.agents/plugins/external-agents-extend → 本仓库` 可用；`dim exec` 新会话实际调用 `external-agents-extend__hello` 成功
- [x] T0.2 SQLite 方案定稿（2026-09-17 ✅）：`node:sqlite` + `readOnly:true`；活跃 WAL 库只读正常；不存在文件打开即错且不创建；损坏文件**查询时**才报错（须在查询层捕获）；证据 `docs/verification/2026-09-17-stage0/`
- [x] T0.3 MCP App 冒烟（2026-09-17 ✅）：server 端 + 桌面端渲染均已验证；**widget 必须实现 `ui/initialize` 握手**（protocolVersion `2026-01-26`，收 result 后发 `ui/notifications/initialized`）——否则面板静默空白（iframe opacity:0）；宿主对 `ui://` 资源有内存缓存，改动 widget 后需重启应用生效
- [x] T0.4 阶段 0 结论记录到 README（T0.3 完成后补记）

### 阶段 1 · 核心数据层（2026-09-17 ✅；证据 `docs/verification/2026-09-17-stage1/`）
- [x] T1.1 runs 模块（`server/src/core/runs.js`）：只读 `background_tasks`；PRAGMA 列裁剪 + 查询层 try/catch（`db_unavailable` / `query_failed`）；agentType 过滤在 SQL 层（JSON1 + json_valid 防御，避免被 LIMIT 截断）
- [x] T1.2 映射器（`server/src/core/mapping.js`）：时间戳 + token 消歧 + 多候选歧义警告；unmatched/unsupported 状态明确
- [x] T1.3 kimi 适配器（`adapters/kimi.js`）：两层信封解包；49 种顶层 type 全映射（扫 282 个历史文件核对）；offset 增量读（半行不推进）
- [x] T1.4 cursor 适配器（`adapters/cursor.js`）：**顺序恢复成功**（`meta` 表 hex-JSON → `latestRootBlobId` → 快照 protobuf field#1 有序消息列表；全量 7682 条 tool_result 因果零越界）；游标 `{v,rootId,lastId}`
- [x] T1.5 codex 适配器（`adapters/codex.js`）：8 类顶层 + 二级键全映射；孪生记录跨流去重（id/文本/命令指纹）；offset 增量读 + 1 MiB 回看
- [x] T1.6 统一事件模型（`core/events.js`）：kind 枚举 + `degraded`/`warnings` 显式降级；不可识别一律 `unknown`
- [x] 验收：**49 项测试全绿**（`mise exec -- node --test`）+ 端到端冒烟（最近 120 条任务：matched 106 / unmatched 1 / unsupported 13）

### 阶段 2 · MCP 工具层（2026-09-17 ✅；证据 `docs/verification/2026-09-17-stage2/`）
- [x] T2.1 `list_agent_runs(limit?, agentType?, status?)`（`server/src/tools.js`；摘要字段 + SQL 层过滤）
- [x] T2.2 `read_agent_run(taskId, cursor?, limit?)` → 事件分页（cursor=已消费事件序号）+ `nextCursor` + `total`；事件去 raw
- [x] T2.3 四类语义：task_not_found / no_log（附 reason）/ degraded（warnings 透出）/ running（附轮询 hint）；系统故障 → isError
- [x] 验收：CLI 新会话实测——模型实际调用两工具并正确总结任务背景与状态（见阶段 2记录）

### 阶段 3 · Widget 日志查看器（2026-09-17 ✅；证据 `docs/verification/2026-09-17-stage3/`）
- [x] T3.1 前端（`server/src/widget/log.html` 重写）：任务列表 + 事件流（时间/类型徽章/正文/折叠详情）+ **2s 轮询增量**（cursor=已消费数；历史读尽自动停）
- [x] T3.2 `open_agent_run_log` fullscreen 面板；资源全内联、CSP 无外部域；widget 经 `tools/call` 通道调数据工具（工具已加 `visibility: ['model','app']`）
- [x] T3.3 全 `textContent` 渲染（零 innerHTML）、超长截断/展开、`tool_result` 错误红色高亮
- [x] T3.4 空态（无任务/未选中/暂无事件）与错误态（no_log / task_not_found / 读取失败）齐备
- [x] 验收：桌面端实测面板正常渲染（任务列表 + 事件流）；运行中任务 2s 增量追加（用户确认）
- [x] **增强（2026-09-17）**：`show_external_agents` 内联卡片（inline MCP App → `ui/request-display-mode` 切 fullscreen、同实例直达实时日志）；dim 内置「子任务」组件不可被插件扩展的限制见风险节第 7 条
- [x] **增强（2026-09-17）·自动检测**：`hooks/hooks.json` + `hooks/context.js`——`UserPromptSubmit` 命令 hook 每轮静默查询任务库，注入本会话运行中外部 Agent 摘要（类型/标题/taskId/时长 + open_agent_run_log 指引）；DB 不可用等异常一律静默退出 0。**插件 hooks 白名单仅 10 个事件**（SessionStart / SubagentStart / PreToolUse / PermissionRequest / PostToolUse / PreCompact / PostCompact / UserPromptSubmit / SubagentStop / Stop；宿主本身支持 21 个，但插件声明未识别事件会导致整个 hooks 文件被拒——app.asar `yRt` 白名单 + `Unsupported hook event` 抛错实证）；CLI 端到端实测注入生效
- [x] **增强（2026-09-17）·启动即自动展示**：`hooks/on-stop.js`——`Stop` 命令 hook 在新任务启动后的回合末尾以 exit 2（block）注入 `continueReason`，让模型补一轮自动调用 `open_agent_run_log`；去重（tmp 状态文件）+ `stop_hook_active` 防循环。trace 实证：Stop output 含 continueReason、模型自动展示卡片。command hook 协议：stdin JSON（**snake_case**：session_id / tool_name / tool_use_id / tool_input / tool_response / stop_hook_active）、exit 2=block（stderr 优先作 blockMessage）；事件效果表与 matcher 字段见 app.asar
- [x] **增强（2026-09-19）·触发方式强化**：`context.js` 增加「完成/失败补报」（最近 4 小时结束、每 taskId 去重、最多 3 条）并统一按本会话过滤（与 `list_agent_runs` 默认 scope=session 一致）；新增 `hooks/on-post-tool.js`（`PostToolUse`，matcher `agent`）在 `create_external` 委托瞬间捕获任务（`sourceToolCallId` 精确匹配，2 分钟会话兜底；写入 `ea-extend-delegated.json`）；`on-stop.js` 改为优先按捕获记录提醒、无捕获时回退扫库（本会话 + 10 分钟窗），消除跨会话串场；修复 Stop 读不到 session_id 的缺陷（曾只查 camelCase）；测试 120 项全绿

### 阶段 4 · CLI 与 Skill（2026-09-17 ✅；证据 `docs/verification/2026-09-17-stage4/`）
- [x] T4.1 `bin/dim-external-agents-extend`（真实入口 → `server/src/cli.js`）：`list` / `show <taskId>` / `tail <taskId>`（--json / --type / --status / --limit / --interval）；纯本机、零依赖
- [x] T4.2 插件 skill（`skills/external-agents-extend/SKILL.md`）：使用时机 + 工具用法（含 status 语义）+ CLI 等价命令；plugin.json 已声明 `"skills": "./skills/"`；CLI 会话实测已加载

### 阶段 5 · 验收与分发（2026-09-17 ✅；证据 `docs/verification/2026-09-17-stage5/`）
- [x] T5.1 样本对照：11 任务 × 3 agent 全部 mapping 正确、tool 配对完整、零降级
- [x] T5.2 运行中近实时：真实运行中 cursor 任务观测（171→181→193，单调、seq 连续、2s 粒度）
- [x] T5.3 边界：空日志 / 格式漂移（4 类异常显式降级）/ 10MB & 599MB 大文件（35ms / 15ms）/ 并发 20/20
- [x] T5.4 打包：`validate_plugin.py` 通过；**git URL 分发安装已实测**（`dim plugin install` → 结构完整 / mcp test success / validate 通过 / 重复安装守卫正确；安装与分发说明见 README「安装与分发」）
- [x] T5.5 验证记录：本文 + 全项目索引；测试总数 72 项全绿

---

## 4. 新项目开工指引

**本仓库结构（已定，2026-09-17）**：插件文件直接放仓库根（本仓库只承载这一个插件）。

```
dim-external-agents-extend/
  README.md
  docs/HANDOFF.md            # 本交接文档
  docs/verification/         # 验证记录（阶段 0–3 已入库）
  .codex-plugin/plugin.json  # 插件清单 ✅
  .mcp.json                  # MCP server 声明 ✅
  server/src/index.js        # MCP server（协议泵 + 冒烟工具 + 数据工具注册）✅
  server/src/tools.js        # MCP 数据工具 ✅（阶段 2）：list_agent_runs / read_agent_run + 四类语义
  server/src/core/           # 核心数据层 ✅（阶段 1）：events.js / runs.js / mapping.js + adapters/{kimi,cursor,codex}.js
  server/src/cli.js          # CLI 实现 ✅（阶段 4）：list / show / tail
  server/src/widget/log.html # MCP App widget ✅（阶段 3）：日志查看器（任务列表 + 事件流 + 2s 轮询）
  server/test/               # node:test 测试 ✅（72 项：mise exec -- node --test）
  bin/dim-external-agents-extend  # CLI ✅（阶段 4）：list / show / tail → server/src/cli.js
  skills/external-agents-extend/  # 插件 skill ✅（阶段 4）：SKILL.md（使用时机与工具用法）
  mise.toml                  # 开发环境固定（node 24.18.0）
```

> 本地开发：`~/.agents/plugins/external-agents-extend` **软链接**指向本仓库（2026-09-17 验证可用，仓库保持唯一真实来源）。
> 开工前置：`mise.toml` 已固定开发 node 24.18.0（与 dim 运行时同版本），见 2.4。

**开发循环**：改代码 → `mise exec -- node --test`（49 项；node 24 下**不能**用目录参数 `node --test server/test/`，会被当模块加载而报 MODULE_NOT_FOUND）→ 新会话验证（或用 `dim mcp test plugin:external-agents-extend/external-agents-extend --json` 验证 server 连通，判定看 `success:true`）→ `validate_plugin.py`。
端到端冒烟（真实数据只读）：`mise exec -- node docs/verification/2026-09-17-stage1/t1-smoke.js [agentType]`。

**调试命令速查**

```bash
# 列最近外部任务
sqlite3 ~/.dimcode/v2/dimcode.sqlite "SELECT taskId, json_extract(metadata,'$.externalAgentType'), status FROM background_tasks WHERE toolName='agent' ORDER BY startedAt DESC LIMIT 10;"

# 跟踪 kimi 执行事件流
tail -f ~/.kimi-code/sessions/<wd_hash>/<session>/agents/main/wire.jsonl

# 用 node 读 cursor store.db（已验证可用）
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.HOME+'/.cursor/acp-sessions/<uuid>/store.db',{readOnly:true});console.log(db.prepare('SELECT COUNT(*) c FROM blobs').get());"
```

**验证资产（本机已存在）**：2.3 的已完成样本任务可直接对照；运行中任务随时可发起新的外部任务复现。

---

## 5. 风险与开放问题

1. ~~cursor 消息顺序恢复~~（T1.4 已解决）：顺序恢复自 `meta.latestRootBlobId` → 快照 blob protobuf field#1（全量 7682 条因果校验通过）；保留降级路径（快照缺失 → 集合视图 + `order_unrecovered`）。另注：cursor 的 reasoning 文本为加密 signature（不产出 think）。
2. **私有格式漂移**：wire protocol / acp store schema / dim 表结构均非公开契约；适配器隔离 + 降级 + 版本记录；**dim 升级后重验 2.1–2.3 关键事实**。
3. **近实时 = 2s 轮询**（非流式），需在 README 说明预期。
4. **敏感内容**：日志含 prompt/代码，全部本机处理、widget 不联网；README 声明。
5. 插件命名已定：**`external-agents-extend`**（2026-09-17，原名 agent-log）；发布形态（本地插件 / git 分发）待定；仓库位置已定：插件文件放仓库根（见第 4 节）。
6. 是否扩展到 grok/opencode/zcode（其余 26 条任务）、是否需要"导出日志为文件"，MVP 后再定。
7. **上游能力缺口（建议反馈 dim）**：会话内的「子任务」卡片/面板为 dim 内置 UI，插件体系（skill/hooks/MCP/MCP App）没有挂载点可改写其交互；且 dim 未采集外部子任务的完整执行日志。建议 dim 支持：外部子任务卡片提供"查看执行日志"入口，或允许插件注册为视图提供者。当前替代：`show_external_agents` 内联卡片（点击进实时日志）+ `open_agent_run_log` 全屏面板。

---

## 6. 新会话启动提示词（可直接粘贴使用）

> 开始开发本仓库（`/Users/guoxudong/codes/dim-external-agents-extend`）的 DimAgent 插件「external-agents-extend」（外部 agent 执行日志查看）。先读交接文档 `docs/HANDOFF.md`（仓库内），按当前阶段开始执行；关键事实在第 2 节，不要再重新调研。完成后按第 5 节检查风险项。

---

## 附：交接检查清单

- [x] 新项目目录已建立，HANDOFF.md 已纳入仓库（`docs/HANDOFF.md`）
- [x] dim 版本确认（2026-09-17：DimAgent 0.9.32 / dim CLI 0.5.5 / 嵌入式 node v24.18.0，均与第 2 节基线一致）
- [x] `node:sqlite` 可用性确认（v24.18.0 与 v24.12.0 均可用；差异见 2.4）
- [x] 已知样本任务仍可复现映射（task_1789559570749_9kvwq6：任务在库、kimi 会话与 wire.jsonl 485KB 均在）
- [x] 补 `mise.toml`（node 24.18.0，与 dim 运行时同版本）
- [x] 插件根 `~/.agents/plugins/` 下新会话能正常加载（2026-09-17：软链接方案 + `dim exec` 已验证）
