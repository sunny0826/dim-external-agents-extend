# 开发记录（阶段 0–5）

> 本文件是插件的开发过程记录，面向贡献者与接手者。
>
> - 用户文档：[README.md](../README.md)
> - 开工入口（已验事实、数据源地图、调试命令、启动提示词）：[HANDOFF.md](HANDOFF.md)
> - 验证证据与可复现脚本：[verification/](verification/)

## 项目状态

**external-agents-extend**（2026-09-17 由暂名 `agent-log` 更名）——让用户能在 dim 里查看由 dim 后台拉起的外部 agent（kimi / cursor / codex / grok / opencode / zcode）委托任务的执行日志：运行状态、工具调用序列、中间输出、失败原因。

- 状态：**✅ 全部 6 个阶段完成**（阶段 0–5：技术验证 → 核心数据层 → MCP 工具层 → Widget → CLI/Skill → 验收分发）；真实数据验收通过（11 任务样本矩阵 / 运行中近实时 / 边界场景）；证据 `docs/verification/`
- 2026-09-18 增补：Widget 视觉系统重构（设计变量 + 深浅双主题 + 进入/展开动效）、时间戳默认可见、cursor `<timestamp>` 解析（用户消息真实时间）、工具调用摘要改为展示真实参数；测试 90 项全绿
- 2026-09-18 二次增补：事件流改为行式 Agent 轨迹（弃对话气泡）；文本输出 Markdown 渲染（零依赖、纯 DOM）；连续工具调用聚合为「工具调用」折叠组（≥2 个调用，展开为 rail 明细）；界面重设计为 neutral-first 工程工具风（去紫色 accent / 玻璃拟态 / 光晕 / 胶囊徽章，边框优先、圆角收紧），List 页改为行式列表
- 2026-09-19 增补：显示外部 Agent 使用的模型——列表显示派发时选择（`metadata.selectedModelId`，`default` 本地化显示），日志页头部显示会话实际模型（kimi `modelAlias` / cursor assistant `modelName` / codex `turn_context`・`thread_settings`，经 `meta.model` 契约透出）；`list_agent_runs` 返回 `model`、`read_agent_run` 返回 `session.model`、CLI `show` 同时打印两者；日志 Markdown 渲染支持 GFM 表格（表头样式、`:---:` 列对齐、单元格行内标记、宽表横向滚动兜底）；测试 100 项全绿
- 2026-09-19 二次增补（触发方式强化）：① `UserPromptSubmit` 新增「完成/失败补报」——最近 4 小时内结束且未提醒过的任务注入 `[外部 Agent 完成]` 摘要（每 taskId 去重，上限 3 条），并统一按**本会话**过滤（与 `list_agent_runs` 默认 `scope=session` 口径一致）；② 新增 `PostToolUse` hook（`hooks/on-post-tool.js`，matcher `agent`）在 `create_external` 委托瞬间精确捕获任务（`sourceToolCallId` 精确匹配，2 分钟会话兜底），`Stop` hook 优先按捕获记录提醒、仅在没有捕获时回退扫库（本会话 + 10 分钟窗），消除跨会话串场；③ 修复 `Stop` hook 只读 camelCase `sessionId` 导致会话 id 取不到的缺陷（宿主 stdin 为 snake_case）；测试 120 项全绿
- 可行性：已验证（2026-09-17，本机实测）；事后与近实时（2s 轮询）可行，完全流式不在范围
- 2026-09-19 三次增补（会话名称统一，v0.1.0）：新增 `list_external_sessions` / `rename_external_sessions` 两个 MCP 工具与 `sessions` / `rename` 两个 CLI 子命令，外加 skill `external-session-names`。把各外部 agent 自己攒的会话名统一为 `[codex] 09-19 20:31 · 修复 GUO-108 审查问题`：命名优先级 = dim 任务标题 → 会话自身标题（通用标题如 `Help` / `New session - <ISO>` / 纯 uuid 被识别并跳过）→ 首条 prompt 里有意义的行（跳过委托包装样板，含 Issue token 的行优先）→ `未命名会话 · <cwd 末段或会话短码>`。回写（默认 dry-run、写前备份到 `~/.dimcode/ea-extend-backups/`、幂等、保护用户自定义标题）覆盖全部 6 个 agent：codex（`session_index.jsonl.thread_name`）/ kimi（`state.json.title` + `isCustomTitle`）/ cursor（`meta.json.title`）/ grok（`summary.json` 的 `generated_title` + `title_is_manual`，**不写** `session_search.sqlite`——那只是会重建的搜索索引）/ opencode（`session.title`，大库只备份受影响行）/ zcode（`~/.zcode/cli/db/db.sqlite` 的 `session.title` + `title_source='custom'`；桌面 `tasks-index.sqlite` 是任务索引不是会话表，仅展示）。**修掉一处根因级错配**：zcode 适配器原先读桌面任务索引（0 行），真实会话在 CLI 库。测试 159 项全绿
- 2026-09-19 四次增补（来源标记 + 全自动命名）：① 统一名带来源标记——`[dim]` 表示由 dim 委托产生、`[手动]` 表示其它来源（展示名形如 `[codex] 09-19 20:31 · [dim] 修复 GUO-108 审查问题`），工具输出同时给 `source` 与 `delegated`（后者识别「被某个编排器拉起但不是 dim」的情况），`sourcePrefix: false` 可关闭标记；② 新增 `hooks/auto-name.js`（挂在 UserPromptSubmit / PostToolUse / Stop）：dim 委托后**自动**把该外部会话的泛化标题改写成统一名，无需对话或 CLI——只动能关联到 dim 任务、且自身标题泛化的会话，只回溯 2 小时，写前备份，每任务一次，10 秒节流，静默；`EA_EXT_AUTO_NAME=off` 或 `~/.dimcode/ea-extend-config.json` 的 `{autoName:false}` 可关闭；③ 新增 `auto_name_sessions` 工具与 `autoname` 子命令用于显式回填（默认 dry-run）；④ 名称识别增强：只剩委托前缀的标题（「你是实现者」）算泛化，带任务信息的先剥前缀（「你是 Project V 的执行开发者。任务：时间轴重构」→「任务：时间轴重构」），并修掉「二次改名叠加标记成 `[手动] [手动] …`」的缺陷；⑤ 自动命名改为**默认关闭（opt-in）**：开关由 `~/.dimcode/ea-extend-config.json` 的 `autoName` 决定（环境变量 `EA_EXT_AUTO_NAME` 优先，默认关闭），`autoname --enable/--disable` 一条命令切换；⑥ 开关可在桌面端操作：全屏面板右上角新增「自动命名」开关（widget 经新增的 `get_settings` / `set_auto_name` 工具读写配置），也可在对话里说一句；dim 原生插件设置页只服务内置插件（读 `settingsSchema` + `controller`），第三方插件只能自带开关；⑦ 修复面板开关位置：自动命名开关原先复用 `label.follow` 类，而 `body.view-list label.follow{display:none}` 把该类限定为「仅日志详情页显示」——导致一个**全局设置**反而只在任务详情页可见、列表页看不到；改用独立的 `label.global` 类（列表页右上角，详情页与 inline 卡片隐藏），并加测试锁住该意图（197 项）；⑧ 修复「并发会话下运行中的外部 Agent 看似没被识别」：`scope=session` 原先依赖一个全局单会话文件（任何会话的 hook 都会覆盖它），两个会话同时在用时面板会解析到别的会话而显示空列表——改为按会话记录最近活跃时间的映射（`server/src/core/active-session.js`，hook 侧转发），并在「解析到的会话没有任务、且其它会话仍有正在运行的任务」时回退为全部会话 + `scopeFallback` 说明（含在跑数量）+ 每条任务带 `sessionId`（别处只剩历史时保持空态，避免默认视图倒出历史失败），`list_agent_runs` 支持显式 `sessionId`；⑨ 面板交互整理（2026-09-20）：列表页筛选收敛为一个「筛选」按钮 + 弹出面板（全部会话 / 显示已结束 / **显示失败**，工具层新增 `includeFailed`，默认只看本会话且隐藏已结束与失败）；筛选与「自动命名」开关改为**仅列表页**（日志详情页不再显示列表级控件）；自动命名改为开关样式并加 hover 提示（文案如实写明「立即生效、无需重启」——hook 每次事件新起进程并即时读配置）；日志详情页头部加对应 Agent 的 logo（复用列表页同一套内联图标）。测试 201 项全绿；浏览器实测：开关未选/选中轨道与滑块、hover 提示可见、筛选开合与角标计数、列表页/详情页控件可见性、logo 样式规则；⑩ 顶栏对齐修正（2026-09-20）：`.switch-wrap`/`.filter` 这类"包裹一个 inline-flex 子元素"的容器必须是 `display: flex; align-items: center`——若留默认 `block`，子元素按基线排版会贴在行顶，底部留下 strut 的下伸空间，整组比相邻控件（标题/徽标/刷新）高出约 2px。已加测试断言这两条规则含 `display: flex` + `align-items: center`；浏览器实测各元素中心与顶栏中心偏差一致（均为 -0.5px）。⑫ 三项增补（2026-09-20）：①**grok 日志打通**——`mapping.js` 新增 `findGrokRef`（按 `~/.grok/sessions/<enc-cwd>/<id>/summary.json` 的 `created_at` 定位，实测比任务派发晚 0.1–2.8s，5s 窗口足够；并用任务侧 Issue ID token 与 `session_summary`/`generated_title` 交叉消歧），新增 `server/src/core/adapters/grok.js` 把 `updates.jsonl`（ACP 风格 session/update 流，每行带 `timestamp` 秒 / `_meta.agentTimestampMs` 毫秒）归一化为统一事件：`hook_execution`/`user_message_chunk`/`plan`/`retry_state`/`task_backgrounded`/`task_completed`/`background_tasks` → notice，`agent_thought_chunk` → think，`agent_message_chunk` → text，`tool_call` → tool_call（detail 带 rawInput 与工具元信息），`tool_call_update`（有 status）→ tool_result（按 toolCallId 关联工具名），无 status 的补充描述不产事件只计数，`turn_completed` → usage（模型名兜底来源）；cursor = updates.jsonl 字节偏移，尾部半行不消费；②**筛选覆盖全部状态**——面板筛选改为四个状态复选框（运行中/已完成/已取消/失败，可多选）+ 范围（本会话/全部会话），工具层新增 `statuses`（空数组 = 不按状态筛，避免全部取消勾选时静默空列表），默认仍只看本会话的运行中任务；③**「跟随」改开关样式**——复用 `label.switch` 的轨道+滑块，作用域规则从 `label.follow` 改为 `#followSwitch`（列表页与 inline 卡片隐藏）。测试 212 项全绿；浏览器实测：菜单五项（状态 4 + 范围 1）与分组标题/分隔线、角标 0→1→2→3、标题文案（中文状态名）、列表页/日志页控件可见性、跟随开关轨道 26×15 且与返回按钮中心一致。（kimi state.json / cursor meta.json / grok summary.json 原本是压缩单行，不再被改写成美化格式），并新增 `restore` 子命令与 `restore_backups` 工具按备份字节回滚。测试 201 项全绿
- 里程碑：M1 工具层可用 → M2 Widget 面板可用 → M3 完整交付

## 阶段 0 结论（2026-09-17）

完整记录与可复现脚本见 [docs/verification/2026-09-17-stage0/RESULTS.md](verification/2026-09-17-stage0/RESULTS.md)。

- **T0.1 骨架冒烟 ✅**：仓库根即插件根；`~/.agents/plugins/external-agents-extend` 软链接指向本仓库后，dim 可发现并加载（`dim exec` 新会话调用 `external-agents-extend__hello` 工具成功）。
- **T0.2 SQLite 方案 ✅**：`node:sqlite` + `readOnly:true` 直读、零第三方依赖；活跃 WAL 库可并发只读；损坏/非数据库文件在**查询时**才报错 → 适配器必须在查询层 try/catch。
- **T0.3 MCP App 冒烟 ✅**：server 端 ✅（`open_agent_run_log` + `ui://` 资源已注册、dim 链路验证不崩）；桌面端渲染 ✅（2026-09-17 实测，fullscreen 面板正常显示）——**关键**：widget 必须实现 `ui/initialize` 握手（protocolVersion `2026-01-26`），否则宿主 iframe 保持透明、面板静默空白。
- 开发注意：`dim mcp test` 的 `tools` 字段在 dimcode 0.5.5 恒为空（对照已正常工作的 server 亦然），连通性判定以 `success:true` 为准；仓库作为工作区时根 `.mcp.json` 会重复加载为 project 级工具（开发期现象，不影响分发）。

## 阶段 1 结论（2026-09-17）

完整记录见 [docs/verification/2026-09-17-stage1/RESULTS.md](verification/2026-09-17-stage1/RESULTS.md)。

- **核心数据层完成**：`server/src/core/`（统一事件模型 / runs / 任务↔会话映射 + kimi・cursor・codex 三适配器），零第三方依赖，49 项测试全绿（`mise exec -- node --test`）。
- **并行任务消歧**：纯时间戳在并行任务下会配对颠倒（实测两个会话创建仅差 1ms）→ 用 Issue ID token 与会话文本交叉消歧；HANDOFF 2.3 的两个样本已修正。
- **cursor 顺序恢复**：`store.db` 消息顺序可完整恢复（`meta` → 快照 protobuf field#1），全量 7682 条 tool_result 因果校验通过。
- **增量读语义**：kimi/codex 用字节 offset（半行不推进）、cursor 用内容寻址 id；越界/失效 cursor 复位并显式警告。

## 阶段 2 结论（2026-09-17）

完整记录见 [docs/verification/2026-09-17-stage2/RESULTS.md](verification/2026-09-17-stage2/RESULTS.md)。

- **两个数据工具就绪**：`list_agent_runs`（任务列表，默认 20 条）与 `read_agent_run`（事件分页 + 游标，默认 100 条/页）；58 项测试全绿。
- **四类语义**：task_not_found / no_log / degraded / running 均为可解释状态（isError=false），系统故障（db_unavailable）才标 isError。
- **验收**：CLI 新会话实测——模型实际调用两个工具后，能准确回答任务背景、状态与继续阅读方式。

## 阶段 3 结论（2026-09-17）

完整记录见 [docs/verification/2026-09-17-stage3/RESULTS.md](verification/2026-09-17-stage3/RESULTS.md)。

- **Widget 日志查看器就绪**：打开面板即见任务列表 + 事件流；运行中任务每 2s 增量追加、历史读尽自动停止；超长文本折叠、错误高亮、空态/错误态齐备。
- **会话内联卡片（2026-09-17 增强）**：`show_external_agents` 在会话时间线显示「外部 Agent」卡片（每 5s 刷新），**点击任一 Agent** 即请求切全屏并直达该任务的实时日志（inline → fullscreen 同实例切换）。
- **自动检测（2026-09-17 增强）**：插件 `UserPromptSubmit` hook 每轮静默注入运行中外部 Agent 摘要（无任务零输出、异常静默）；`Stop` hook 在**新任务启动后的回合末尾**阻止结束并让模型补一轮**自动展示状态卡片**（10 分钟窗口 + 每任务只提醒一次 + `stop_hook_active` 防循环）。CLI 端到端实测：派活后模型自动调用 `show_external_agents` 并展示卡片。
- **widget 数据通道打通**：widget 经 `tools/call` 通道直接调用数据工具（工具已加 `visibility: ['model','app']`），无需模型中转。
- **安全**：全部 textContent 渲染（零 innerHTML）；资源全内联、CSP 无外部域。
- **桌面端实测通过**（2026-09-17 14:13）；另记录一处启动竞态：重启后需等 ~20 秒再开新会话（详见 HANDOFF 2.4）。

## 阶段 4 结论（2026-09-17）

完整记录见 [docs/verification/2026-09-17-stage4/RESULTS.md](verification/2026-09-17-stage4/RESULTS.md)。

- **CLI 就绪**：`dim-external-agents-extend list / show / tail`（复用四类语义；`--json` 供脚本消费；纯本机零依赖）；`validate_plugin` 通过。
- **插件 skill 就绪**：`skills/external-agents-extend/SKILL.md` 描述使用时机与工具用法；CLI 会话实测已被加载。
- **过程中修复两个真实 bug**：`tail` 对 `db_unavailable` 无处理导致死循环（已修 + 加入测试）；测试 fixture 的 db 路径语义修正。

## 阶段 5 结论（2026-09-17）

完整记录见 [docs/verification/2026-09-17-stage5/RESULTS.md](verification/2026-09-17-stage5/RESULTS.md)。

- **样本对照**：11 任务 × 3 agent 全部 mapping 正确、tool_call/tool_result 完整配对、零格式降级。
- **运行中近实时**：真实运行中 cursor 任务观测——事件单调增长（171→181→193）、seq 连续不丢不重、2s 粒度可见最新活动。
- **边界**：空日志 / 格式漂移（4 类异常显式降级）/ 10.1MB kimi（35ms）与 599.6MB codex（15ms）/ 并发只读 20/20。
- **打包**：`validate_plugin` 通过；git URL 分发安装实测通过（2026-09-17）：安装结构完整、`dim mcp test plugin:external-agents-extend/external-agents-extend` → `success:true`、`validate_plugin.py` 通过；同名插件已存在时会明确拒绝（防重复）。

## 分发实测记录

- 安装到 `<DIMCODE_HOME>/plugins/` 并记录 `resolvedRevision`；安装/卸载：删除 `<DIMCODE_HOME>/plugins/external-agents-extend` 目录即可。
- **本地开发**：`~/.agents/plugins/external-agents-extend` 软链接指向本仓库（保持单一真实来源）；改动后需重启桌面端生效（注意重启存在启动竞态：等 ~20 秒再开新会话，见 HANDOFF 2.4）。
- **形态**：发布版 **v0.0.1**（2026-09-18 打 tag）；零第三方依赖、无构建步骤、资源全内联（无外部域）。

## 开工入口

接手者（人或 Agent）先读 [docs/HANDOFF.md](HANDOFF.md)：含已验事实、数据源地图、6 阶段任务清单、开工指引与调试命令。**读完即可开工，无需重新调研。**

新会话可直接使用交接文档第 6 节的「启动提示词」。

## 仓库结构

```
dim-external-agents-extend/
  README.md
  LICENSE                    # MIT
  docs/HANDOFF.md            # 交接文档（开工入口）
  docs/DEVELOPMENT.md        # 本文件：阶段 0–5 开发记录
  docs/verification/         # 验证记录（阶段 0–5 全部入库）
  docs/images/               # README 界面截图
  .codex-plugin/plugin.json  # 插件清单 ✅
  .mcp.json                  # MCP server 声明 ✅（stdio → server/src/index.js）
  server/src/index.js        # MCP server（协议泵 + 冒烟工具 + 数据工具注册）✅
  server/src/tools.js        # MCP 数据工具 ✅（阶段 2 + 会话名称）：list_agent_runs / read_agent_run / list_external_sessions / rename_external_sessions
  server/src/cli.js          # CLI 实现 ✅（阶段 4 + 会话名称）：list / show / tail / sessions / rename
  server/src/core/           # 核心数据层 ✅（阶段 1）：events / runs / mapping + adapters/{kimi,cursor,codex}
  server/src/core/sessions.js     # 会话清单与改名 ✅（2026-09-19）：6 个 agent 的会话读取 + dim 任务标题关联 + 回写 + 全自动命名（autoNameSessions）
  server/src/core/settings.js     # 插件设置（autoName 开关，默认关闭）✅（2026-09-19）
  server/src/core/session-name.js # 会话名称归一化 ✅（2026-09-19）：通用标题识别、委托前缀剥离、命名优先级、统一格式化（纯函数）
  server/src/widget/log.html # MCP App widget ✅（阶段 3，2026-09-18 视觉重构）：日志查看器（任务列表 + 事件流 + 2s 轮询）
  server/test/               # node:test 测试 ✅（175 项；含 widget harness、CLI、会话名称/改名/自动命名）
  bin/dim-external-agents-extend  # CLI ✅（阶段 4 + 会话名称）：list / show / tail / sessions / rename / autoname → server/src/cli.js
  skills/external-agents-extend/  # 插件 skill ✅（阶段 4）：SKILL.md（使用时机与工具用法）
  skills/external-session-names/  # 插件 skill ✅（2026-09-19）：会话名称统一与改名
  hooks/                     # 自动状态检测（UserPromptSubmit / Stop）+ 全自动会话命名（auto-name.js）✅
  scripts/build-logos.js     # 从本机应用提取 agent 图标（macOS sips）✅
  mise.toml                  # 开发环境固定（node 24.18.0）
```
