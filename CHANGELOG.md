# Changelog

本项目所有重要变更记录于此。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.0.1] - 2026-09-18

首个公开版本：在 DimAgent 中查看由 dim 后台拉起的外部 Agent（Kimi / Cursor / Codex 等）委托任务的执行日志——运行状态、工具调用序列、中间输出与失败原因。

### 新增

- **任务列表**（`list_agent_runs`）：列出本会话或全部历史的外部 Agent 委托任务，支持按 Agent 类型、状态过滤
- **执行日志**（`read_agent_run`）：归一化事件流（工具调用 / 工具结果 / 文本 / 思考 / 用量 / 步骤），游标分页；运行中任务约 2 秒粒度增量读取
- **全屏日志面板**（`open_agent_run_log`）：聊天式事件流、工具调用折叠块、跟随滚动、深浅双主题
- **会话内嵌卡片**（`show_external_agents`）：在对话中展示最近任务卡片，点击直达实时日志
- **自动状态提示**：`UserPromptSubmit` / `Stop` hooks 自动感知运行中的外部任务并提示
- **CLI**：`dim-external-agents-extend list / show / tail`，支持 `--json`
- **插件 Skill**：`/external-agents-extend` 快速打开日志面板
- **执行日志适配**：Kimi（`wire.jsonl`）、Cursor（`store.db`）、Codex（rollout JSONL）；Grok / OpenCode / ZCode 支持任务列表

### 说明

- 纯本机运行：只读本地数据、不联网；零第三方依赖、无构建步骤，使用 DimAgent 内置 Node 运行时
- 要求 DimAgent 桌面版（实测 0.9.32）

[0.0.1]: https://github.com/sunny0826/dim-external-agents-extend/releases/tag/v0.0.1
