# 阶段 1 验证记录：核心数据层（2026-09-17）

环境：mise node 24.18.0（与 dim 运行时同版本）｜ **零第三方依赖** ｜ 全部对本机真实数据只读

## 交付清单

| 任务 | 模块 | 测试（node:test） |
|---|---|---|
| T1.6 统一事件模型 | `server/src/core/events.js` | `server/test/events.test.js`（8） |
| T1.1 runs 模块 | `server/src/core/runs.js` | `server/test/runs.test.js`（7） |
| T1.2 任务↔会话映射 | `server/src/core/mapping.js` | `server/test/mapping.test.js`（9） |
| T1.3 kimi 适配器 | `server/src/core/adapters/kimi.js` | `server/test/adapters.kimi.test.js`（6） |
| T1.4 cursor 适配器 | `server/src/core/adapters/cursor.js` | `server/test/adapters.cursor.test.js`（8） |
| T1.5 codex 适配器 | `server/src/core/adapters/codex.js` | `server/test/adapters.codex.test.js`（11） |
| 适配器分发 | `server/src/core/adapters/index.js` | 惰性加载 + 全异常转 warnings |

测试运行（**node 24 不能把目录当参数**，用默认发现或 glob）：

```bash
mise exec -- node --test                                   # 49 pass / 0 fail
mise exec -- node --test "server/test/*.test.js"           # 等价
```

## 端到端冒烟（`docs/verification/2026-09-17-stage1/t1-smoke.js`）

最近 120 条 agent 任务：**matched 106 / unmatched 1 / unsupported 13**（grok/opencode/zcode/tui_worker 暂无适配器，属预期）。

抽样读取（每适配器至多 5 个）：

| 适配器 | 读取任务 | 事件数 | 降级任务 | 备注 |
|---|---|---|---|---|
| kimi | 5 | 4001 | 0 | tool_call / tool_result 各 415 完整配对 |
| cursor | 5 | 547 | 1 | 1 个会话 store.db 已不存在（`store_missing`，显式暴露） |
| codex | 1 | 21 | 0 | —— |

分类专项冒烟：**kimi 39/39 matched；cursor 103/103 matched；codex 2/3 matched**（1 个无 rollout 文件 → unmatched 状态明确）。

## 关键发现

### 1. 并行任务消歧（T1.2；修正 HANDOFF 2.3 的样本对应）

HANDOFF 2.3 记录的两个 kimi 样本对应**记反了**。实际场景：两个并行任务 `task_…749`（GUO-63）与 `task_…654`（GUO-62），两个会话创建时间仅差 **1ms**，纯时间戳最近邻无法区分（原记录即因此配对颠倒）。

- 证据（两会话 wire.jsonl 交叉核实）：`session_66159b01` 出现 GUO-63 共 **47** 次、GUO-62 共 0 次；`session_c46bdf25` 出现 GUO-62 共 **29** 次、GUO-63 共 0 次。
- **正确对应**：`task_1789559570749_9kvwq6 ↔ session_66159b01-bde9-4f73-9bd1-82ae12e0b22e`（差 579ms）、`task_1789559570654_00qg0m ↔ session_c46bdf25-aaa0-472a-be7c-22500046b20a`（差 578ms）。
- 修复：映射器实现 **token 消歧**——从 `taskTitle` / `prompt` 提取 Issue ID 形态 token（`/[A-Z]{2,}-\d+/`），与会话 `state.json.lastPrompt` 交叉比对；命中唯一候选 → `matchedBy: 'timestamp+token'`、confidence `high`。
- 反例核验：kimi 的 `lastPrompt` 是**改写后的包装文本**（80 字符切片命中率仅 1/13）、cursor 的 `meta.json.title` 是自动生成的英文标题——**均不能作相等性校验**；匹配以时间戳 + delta 排序为准，多候选接近（差 <1s）时输出 `ambiguous_candidates` 警告、confidence 降 `low`。

### 2. cursor 消息顺序恢复（T1.4；原列为开放风险 → 已解决）

**可恢复**：`store.db` 的 `meta` 表（1 行 hex-JSON）→ `latestRootBlobId` → 会话状态快照 blob 的 protobuf 字段 **#1 = 完整有序消息列表**（最旧→最新）。

全量校验（113 目录 → 103 个含库 → 102 个有可用快照）：列表内重复 0、JSON 消息未被列表覆盖 0、**7682 条 tool_result 的尾部因果校验 0 例越界**；并排除「按 rowid 排序」假设（实测存在 rowid 局部错位，如 13 排在 12 前）。快照缺失时降级集合视图 + `order_unrecovered` 警告。

### 3. codex 孪生记录跨流去重（T1.5）

Codex Desktop 0.15x 把一次 exec 同时写成 `custom_tool_call(+output)` 与 `CommandExecution`，且**id 无关联**（117 条 CE 中仅 6% 可按 id 对上）。实现按 **id 命中 / 文本指纹 / 命令指纹** 三类跨流去重：09-16 样本 12 条 CE 全部识别为孪生、token_count 与 token_usage_record 全量去重；无孪生的（09-13 样本 7/117）按「宁可多一条，不可丢」保留。

### 4. 增量读语义（三适配器共识）

- kimi / codex：cursor = 已消费**字节数**（字符串化）；只消费完整行，**尾部半行不推进 offset**（文件正在写的正常状态，不产生 warning）；codex 另回看 1 MiB 做跨批次去重预扫描。
- cursor：cursor = `{v, rootId, lastId}`（JSON 字符串）；以内容寻址 id 定位 tail，定位失败 → 整读 + `cursor_reset`。
- 越界/失效 cursor 一律复位 + 显式警告（`cursor_beyond_eof` / `cursor_reset`），不抛异常。

## 已知限制（留待后续）

1. **kimi 跨批次 `tool_result.name` 关联**：适配器无跨调用状态，调用方可用 `detail.toolCallId` 与更早批次的 `tool_call` 配对。
2. **codex 跨批去重现 1 MiB 回看窗口**：窗口外孪生可能多出一条 think/text（不丢事件）；可调 `CONTEXT_BYTES`。
3. **cursor `reasoning` 全空**（仅加密 signature）→ 不产出 think（`meta.detail.reasoningRedacted` 计数）；消息级无时间戳（`ts=null`）。
4. **`nextCursor` 形态差异**（kimi 空文件 `null` / codex `'0'`）：语义等价，T2 收口时统一。
5. grok / opencode / zcode / tui_worker 无适配器（mapping 返回 `unsupported`，状态明确）。

## 复现

```bash
mise exec -- node --test                                                        # 单元/集成测试（49）
mise exec -- node docs/verification/2026-09-17-stage1/t1-smoke.js [agentType]   # 端到端冒烟
```
