# 阶段 3 验证记录：Widget 日志查看器（2026-09-17）

## 交付

| 文件 | 内容 |
|---|---|
| `server/src/widget/log.html`（重写） | 完整日志查看器：任务列表（左）+ 事件流（右）+ 顶栏（跟随开关 / 刷新 / 状态点） |
| `server/src/tools.js` | 两个数据工具加 `_meta.ui.visibility: ['model','app']`（widget 才可经 tools/call 通道调用） |
| `server/test/widget.test.js` | 4 项 harness 测试（轻量 DOM stub 跑 widget 脚本，断言消息序列与状态行为） |

### widget 实现要点

- **握手**：`ui/initialize`（protocolVersion `2026-01-26`）→ 收到 result 后发 `ui/notifications/initialized`（宿主据此将面板置为可见）。
- **数据通道**：经宿主转发 `tools/call`（JSON-RPC over postMessage），带 id 管理与"初始化前请求队列"；工具文本结果 JSON.parse 后渲染。
- **2s 轮询增量**：cursor = 已消费事件数（天然续读，无需状态）；`running` 或有未读完页 → 持续轮询；历史读尽 → 自动停；`document.hidden` 时跳过；"跟随"开关可暂停。
- **安全**：全部 `textContent` 渲染（**零 innerHTML**，日志内容不可信）；资源全内联、CSP 无外部域。
- **体验**：打开即自动选中最新任务；事件流含时间 / kind 徽章 / 正文；超长文本「展开全文」；`detail` JSON 折叠；`tool_result` 错误红色高亮；空态（无任务 / 未选中 / 暂无事件）与错误态（no_log / task_not_found / 读取失败）齐备；暗色适配；窄屏（<640px）上下布局。

## 验证

- 测试：`mise exec -- node --test` → **62 pass / 0 fail**（阶段 0–2 的 58 项 + widget 4 项）。
- 工具链路：`dim mcp test` → `success:true`（含 visibility 的 `_meta.ui` 校验通过、无 server 级回滚）；CLI 新会话调用 `list_agent_runs` 成功返回真实任务。
- **桌面端实测（14:13+）**：新会话调用 `open_agent_run_log` 后面板**正常渲染**（用户确认）——任务列表 + 事件流可用，T3 验收达成。

## 已知边界（留待 T5 收口）

1. 轮询粒度 2s（设计目标）；`read_agent_run` 每轮从完整事件流分页（适配器级增量优化留待后续）。
2. widget 固定自动选中最新任务（不记忆上次选择）。
3. 跨批次 `tool_result.name` 关联、codex 去重回看窗口等适配器边界同阶段 1 记录。

## 附：重启竞态（本次踩坑，已写入 HANDOFF 2.4）

- **现象**：重启 DimAgent 后 10 秒内新建的会话**没有任何插件工具**（该会话内无法恢复）；~60 秒后再开会话正常。
- **根因**：会话的工具列表在**创建时固定**，而 plugin MCP 连接是**异步建立**的——实测 app 启动后 ~13 秒才拉起 plugin server 进程（插件元数据扫描则在 <1s 完成）。
- **规避**：重启后**等 ~20 秒**再开新会话（或先开一个"预热"会话）。

## 复现

```bash
mise exec -- node --test                                    # 62 项测试
mise exec -- node --test server/test/widget.test.js         # 仅 widget
# 桌面端：重启 DimAgent 等 20 秒 → 新会话发「调用 open_agent_run_log」
```
