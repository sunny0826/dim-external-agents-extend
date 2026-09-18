# 阶段 2 验证记录：MCP 工具层（2026-09-17）

## 交付

| 文件 | 内容 |
|---|---|
| `server/src/tools.js` | `list_agent_runs` / `read_agent_run` 实现 + 四类语义 + 工具定义（含完整 inputSchema） |
| `server/src/index.js` | 注册 2 个新工具（tools/list 共 4 个：hello / open_agent_run_log / list_agent_runs / read_agent_run）；tools/call 增加数据工具分发 |
| `server/test/tools.test.js` | 9 项用例（dim db + kimi 会话 fixture，覆盖全部状态分支与分页） |

测试：`mise exec -- node --test` → **58 pass / 0 fail**（阶段 1 的 49 项 + 本次 9 项）。

## 工具规格

- **`list_agent_runs(limit?, agentType?, status?)`**：任务列表，默认 20 条（上限 200）；摘要字段：taskId / agentType / agentName / status / taskTitle / startedAt / completedAt / promptHead（200 字符）；过滤在 SQL 层（JSON1）。
- **`read_agent_run(taskId, cursor?, limit?)`**：事件分页，默认 100 条/页（上限 500）。返回 `task` / `session`（adapter/matchedBy/confidence）/ `total` / `cursor` / `nextCursor` / `events` / `meta`。事件已去除 `raw` 字段（体积控制）；`cursor` 为已消费事件序号（字符串），`nextCursor=null` 表示读完。

## 四类错误/空态语义（T2.3）

| 状态 | 触发 | isError |
|---|---|---|
| `task_not_found` | taskId 不存在 | false（模型可解释给用户） |
| `no_log` | 任务存在但无会话（附 `reason`：unsupported / 会话缺失或已清理） | false |
| `degraded` | 读取成功但格式降级（meta.warnings 全文透出） | false |
| `running` | 任务仍在运行（附 `hint`：用上次 nextCursor 轮询增量） | false |
| `empty` | 列表无结果 | false |
| `bad_arguments` / `db_unavailable` | 参数缺失 / dim 库不可读 | **true**（系统级） |

## 端到端验收（CLI 新会话，2026-09-17）

```bash
dim exec "用 external-agents-extend 插件列出最近 3 个 kimi 任务，读最新一个的开头事件并总结"
```

结果：模型**实际调用** `list_agent_runs`（agentType=kimi, limit=3）与 `read_agent_run`（limit=3），正确列出 3 个任务的标题/状态/时间，并总结最新任务（`task_1789612549186_4bh3fb`）为「project-v PR #71 复查后修补（验证记录入 PR + 描述补正）」，状态 completed；还主动指出「开头 3 条只是会话元信息，继续读需翻页」——**验收标准「新模型可回答任务执行详情」达成**。

## 已知边界（留待 T3）

1. `read_agent_run` 每次调用从完整事件流重新分页（适配器全量读；kimi 5 任务 4001 事件为毫秒级，codex 大文件 13–313ms）。近实时轮询的增量优化（复用适配器 cursor）留待 T3。
2. `list_agent_runs` 不附带会话映射状态（避免每次扫描会话目录）；映射失败原因在 `read_agent_run` 的 `no_log.reason` 中给出。
3. `open_agent_run_log`（widget）在本阶段未接数据（仅冒烟），属 T3 范围。

## 复现

```bash
mise exec -- node --test                                        # 58 项测试
mise exec -- node --test server/test/tools.test.js              # 仅工具层
dim exec "列出最近 3 个 kimi 任务并读最新一个的开头事件"          # 端到端（新会话）
```
