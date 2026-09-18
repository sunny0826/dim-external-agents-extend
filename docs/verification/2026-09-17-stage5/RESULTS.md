# 阶段 5 验证记录：验收与分发（2026-09-17）

## T5.1 样本对照（11 任务 × 3 agent）✅

脚本：`t5-acceptance.js`（原始数据 `t5-acceptance-output.json`）。

| agent | 条数 | mapping | tool_call / tool_result | 降级 | 读取耗时 |
|---|---|---|---|---|---|
| kimi | 4（3× `timestamp+token`/high，1× `timestamp`/low） | 4/4 matched | 31/31、74/74、134/134、42/42 | 0 | 3–11 ms |
| cursor | 4（`timestamp`/medium） | 4/4 matched | 212/212、208/208、173/173、107/107 | 0 | 23–38 ms |
| codex | 3（2 matched + 1 无 rollout 文件 → unmatched） | 2/3 | 2/2、31/31 | 0 | 7–17 ms |

**结论**：11 条有会话的样本全部 mapping 正确、tool_call/tool_result 完整配对、**零格式降级**。

## T5.2 运行中任务近实时 ✅

对象：**真实运行中**的 cursor 任务 `task_1789626824539_k3puxv`（14:33 启动的 M3 系列任务，观测时仍在运行）。

- 观测窗口 150s（2s 间隔）：171 事件（长工具期稳定）→ 150s 时 **181（+10）**；随后复核 **193**（持续增长）。
- **单调性**：delta ≥ 0（无回退）；**seq 连续性**：seq 0..192 → `seqOk: true`（不丢不重）。
- 运行中即可读到最新工具活动（最后事件为一次 Grep 的检索结果）；tool_call/tool_result 92/92 配对。
- **结论**：运行中任务**近实时读取成立**（2s 轮询粒度），增量语义正确。

注：CLI 会话不具备 `create_external` 能力（外部 agent 注册表由桌面侧加载），无法在 CLI 内发起人造任务——改用**现网真实任务**观测，证据强度不低于人造样本。

## T5.3 边界场景 ✅

| 场景 | 结果 |
|---|---|
| 空日志文件 | 0 事件、不崩、nextCursor `'0'` |
| 格式漂移（真实样本前 300 行 + 注入 4 类异常：未知顶层 / 未知内层 / 坏行 / 缺 event） | 304 事件（其中 **4 个 unknown**）、`degraded=true`、4 种 warning 码齐全（`unknown_top_type` / `unknown_event_type` / `malformed_line` / `malformed_loop_event`）、其余正常解析 |
| 大文件 · kimi 10.1 MB wire.jsonl | **35 ms** / 2892 事件 / 0 降级 |
| 大文件 · codex 599.6 MB rollout | **15 ms** / 68 事件（maxLines 保护）/ 0 降级 |
| 并发锁（dim 活跃写入期间连续只读 20 次） | **20/20 成功**，总计 23 ms |

## T5.4 打包与分发

- `validate_plugin.py` → **Plugin validation passed**（阶段 4 已验、本阶段复核）。
- git 仓库：阶段 0–2 / 3 / 4 三个提交 + 本阶段提交；工作区干净。
- 形态：零第三方依赖、无构建步骤、资源全内联（无外部域）。
- **git URL 分发安装实测通过（2026-09-17）**：`dim plugin install https://github.com/sunny0826/dim-external-agents-extend` → 安装成功并记录 `resolvedRevision`（`8d5bd87`）；安装版结构完整、`dim mcp test` → `success:true`、`validate_plugin` 通过；同名插件已存在时明确拒绝（防重复守卫正确）；验证后已回退到开发态软链接。

## T5.5 全项目验证记录索引

| 阶段 | 记录 | 核心证据 |
|---|---|---|
| 0 技术验证 | `docs/verification/2026-09-17-stage0/RESULTS.md` | 骨架 / SQLite 方案 / MCP App 握手（面板空白根因） |
| 1 核心数据层 | `docs/verification/2026-09-17-stage1/RESULTS.md` | kimi・cursor・codex 适配器、映射 token 消歧、cursor 顺序恢复 |
| 2 MCP 工具层 | `docs/verification/2026-09-17-stage2/RESULTS.md` | `list_agent_runs` / `read_agent_run` + 四类语义 |
| 3 Widget | `docs/verification/2026-09-17-stage3/RESULTS.md` | 日志查看器 + 2s 轮询 + 启动竞态记录 |
| 4 CLI 与 Skill | `docs/verification/2026-09-17-stage4/RESULTS.md` | `list` / `show` / `tail` + SKILL.md |
| 5 验收与分发 | 本文档 | 样本矩阵 / 近实时 / 边界 / 打包 |

**测试总览**：72 项 `node:test` 全绿（`mise exec -- node --test`）。

## 复现

```bash
mise exec -- node --test
mise exec -- node docs/verification/2026-09-17-stage5/t5-acceptance.js
mise exec -- node docs/verification/2026-09-17-stage5/t5-realtime-watch.js   # 跟踪新的 kimi running 任务（300s 窗口）
python3 ~/.dimcode/v2/skills/plugin-creator/scripts/validate_plugin.py .
```
