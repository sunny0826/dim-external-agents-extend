---
name: external-agents-extend
description: 查看由 dim 后台拉起的外部 agent（kimi / cursor / codex / grok / opencode / zcode）委托任务的执行日志，包括运行状态、工具调用序列、中间输出与失败原因。当用户问"某个外部 agent 任务跑到哪了 / 跑完了吗 / 完成了吗 / 结果如何 / 为什么失败 / 它做了什么"，或需要列出最近的外部 agent 委托任务、回放某次委托过程时使用本技能。
---

# External Agents Extend（外部 Agent 日志）

查看 dim 委托给外部 agent 的任务执行日志。数据全部来自本机（dim 任务库 + 各 agent 自己的会话文件），只读、不联网。

## 何时使用

- 用户询问某个外部 agent 任务（kimi / cursor / codex 等）的进度、结果或失败原因（含"跑完了吗 / 结束了吗 / 结果如何"）；
- 需要列出最近的外部 agent 委托任务及其状态；
- 需要回放某次委托的工具调用序列与中间输出（排查行为、核对结果）；
- 用户想在当前会话里"一眼看到"有哪些外部 Agent 在跑（用 `show_external_agents` 卡片）；
- **上下文出现 `[外部 Agent 完成]` 注入**（hook 在任务结束后的下一轮自动补报）时：优先用 `read_agent_run` 读取该任务结果并主动简报，失败任务说明原因；
- **用户通过输入区的「技能」按钮或斜杠菜单选中本技能（`/external-agents-extend`）时**：不要反问，**立即调用 `open_agent_run_log` 打开列表页**（默认本会话、只看运行中；要看历史时提示在右上角「筛选」里勾选 已完成 / 已取消 / 失败 或「全部会话」）。

> 若用户的问题是「外部 agent 的会话名太乱 / 分不清 / 想统一命名」，那是另一件事——用 `external-session-names` 技能（`list_external_sessions` / `rename_external_sessions`），不要用本技能。

## 工具

1. **`list_agent_runs`** — 列出任务（可按 `agentType` / `status` 过滤，默认最新在前）。`scope` 默认 `session`（只列当前会话委托的任务），传 `all` 看全部历史；**用户点名某个会话时传 `sessionId`**（如 `sess_1789815375220_xj6kk13bpc`）。
   - **回退语义**：只有当**其它会话确实有正在运行的任务**时，才回退为全部会话并带 `scopeFallback`（含在跑的数量与原因），每条任务带 `sessionId`；如果别处只有历史（已完成/失败/取消），则保持本会话空态，不会把历史倒出来。列表里出现别的会话的任务时，要如实说明来源。
   - 返回 `taskId`、所属 `sessionId` 与派发时选择的 `model`，供后续读取。
2. **`read_agent_run`** — 按 `taskId` 读取归一化事件流（工具调用 / 工具结果 / 文本 / 思考 / 用量 / 步骤），游标分页；`session.model` 为会话实际使用的模型（可探测到时，如 kimi-code/k3、gpt-6-astra）。
   - 返回的 `status` 语义：
     - `ok`：完整历史；
     - `running`：任务未结束，日志可能不完整——用返回的 `nextCursor` 稍后再读增量；
     - `degraded`：存在格式降级（`meta.warnings` 列出未识别项，事件仍完整输出）；
     - `no_log`：任务存在但无日志（`reason` 说明原因，如会话已被清理）；
     - `task_not_found`：无此任务。
3. **`show_external_agents`** — 在会话里显示一张**内联卡片**，列出最近的外部 Agent 任务（类型/标题/状态，每 5s 刷新）；**点击卡片里的某个 Agent** 即切换到全屏实时日志。当用户想在会话中"一眼看到"外部 Agent 们时优先用它。
4. **`open_agent_run_log`** — 直接打开全屏日志面板（两页：任务列表页 + 聊天式日志页；列表默认本会话、只看运行中，「筛选」面板覆盖全部状态与「全部会话」；运行中每 2s 增量）。

## 工作流

1. 先调 `list_agent_runs` 找到目标 `taskId`（默认按开始时间倒序）；
2. 调 `read_agent_run(taskId)` 读事件；事件多时用返回的 `nextCursor` 继续翻页；
3. 需要直观界面时：想"一屏看到所有外部 Agent"用 `show_external_agents`（内联卡片，点击进实时日志）；想直接开日志面板用 `open_agent_run_log`；
4. 回答用户时引用具体事件（工具名、时间、错误状态），不要只给统计。

## 命令行（等价能力，位于 exec PATH）

```bash
dim-external-agents-extend list --type kimi --limit 10
dim-external-agents-extend show task_1789559570749_9kvwq6
dim-external-agents-extend tail task_1789620769595_mugj1d --interval 2000
```

`--json` 输出机器可读格式，便于在脚本里二次处理。

## 注意事项

- 日志内容包含外部 agent 的 prompt 与代码片段，属于敏感内容，按本机内容对待，不要外传；
- `no_log` 常见原因是外部会话文件被清理；日志适配目前覆盖 kimi / cursor / codex / grok / opencode，其余 agent 类型（zcode）会返回 `unsupported`；
- **opencode 的日志按 step 粒度推进**：它的库是状态式存储（part 行会被原地改写、文本流式写入），所以插件只在一个 step 结束后才输出该 step 的内容。任务进行中时日志看起来"慢一拍"是正常的，不是卡住；读到 `tool_in_flight` 警告即表示有工具调用尚未返回结果；
- 若桌面端刚重启，等待约 20 秒再开新会话，否则新会话可能拿不到本插件的工具（已知启动竞态）。
