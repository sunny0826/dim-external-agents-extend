# 阶段 0 验证记录（2026-09-17）

环境基线：DimAgent 0.9.32 ｜ dimcode 0.5.5 ｜ dim 嵌入式 node v24.18.0 ｜ mise node v24.18.0（本仓库 `mise.toml` 固定，与运行时同版本）

> **更名注记**：本文档记录时的插件暂名为 `agent-log`；2026-09-17 更名为 **`external-agents-extend`**。以下原始输出（命名空间 `plugin:agent-log/*`、工具前缀 `agent-log__*`、`bin/dim-agent-log` 等）是当时的真实证据，保留不改；更名后对应为 `plugin:external-agents-extend/external-agents-extend`、`external-agents-extend__*`、`bin/dim-external-agents-extend`、`ui://external-agents-extend/log.html`。

## T0.1 插件骨架冒烟 ✅

- **脚手架**：`create_basic_plugin.py agent-log --with-mcp --with-bin` 生成后落位到仓库根；CLI 入口 `bin/dim-agent-log`。
- **插件发现**：`ln -s <repo> ~/.agents/plugins/agent-log` 后，`dim mcp list` 出现 `plugin:agent-log/agent-log`（stdio）——**软链接方案可用**，仓库保持唯一真实来源。
- **连通性**：`dim mcp test plugin:agent-log/agent-log --json` → `{"success":true,"tools":[]}`。
  - 对照实验：探针 server 在 initialize / tools-list 报错时返回 `success:false` + error；正常时 `success:true`。
  - 对照实验：**已知可用**的 `plugin:nowledge-mem/nowledge-mem` 同样返回 `{"success":true,"tools":[]}`。
  - **结论（踩坑记录）：dimcode 0.5.5 的 `dim mcp test` 中 `tools` 字段恒为空数组，判定连通性以 `success:true` 为准；工具可用性须用 `dim exec` 新会话实际调用验证。**
- **真实调用（新会话）**：`dim exec` 中模型调用 `agent-log__hello` 成功，返回 `hello from agent-log @ 2026-09-17T02:42:50.586Z`。
- **附注 1（zod 严格校验）**：dim 对 `tools/list` 响应做严格校验——工具缺 `inputSchema` 时 `dim mcp test` 报 `Failed to discover tools from server ... tools.5.inputSchema: expected object, received undefined`（**报错，非静默丢弃**）。
- **附注 2（开发期重名）**：仓库作为会话工作区时，根 `.mcp.json` 会同时被当作 project 级配置加载，出现重名工具（`agent-log__hello` 与 `hello_<hash>`）。仅影响本仓库内会话，不影响插件分发。

## T0.2 SQLite 方案定稿 ✅

脚本：本目录 `t02-sqlite-probe.js` ｜ 运行：`mise exec -- node t02-sqlite-probe.js`

| 场景 | 结果 |
|---|---|
| dimcode.sqlite（活跃 WAL 库，含 -wal/-shm）只读读取 | OK，agent 任务 158 条 |
| 样本任务 + metadata JSON 抽取 | OK（task_1789559570749_9kvwq6 → kimi / completed） |
| cursor store.db 只读 | OK，blobs 299 |
| 不存在的文件 | 打开即报错 `unable to open database file`；**未创建文件** |
| 非数据库文件 | 打开不报错，**查询时**报 `file is not a database` |
| 截断的 SQLite 头（16 字节魔数） | 查询时同样报 `file is not a database` |

结论：

1. **方案定稿**：`new DatabaseSync(path, { readOnly: true })`，零第三方依赖。
2. **异常必须在查询层捕获**——打开成功不代表文件可用（非数据库文件延迟到首次读取才报错）。
3. dim 运行时 node 与 mise node（均 v24.18.0）行为一致。
4. 活跃 WAL 库并发只读正常（dim 进程持续写入期间读取成功，不需要写权限）。

## T0.3 MCP App 冒烟 ✅（server 端 + 桌面端均已验证）

server 端已实现并验证：

- 工具 `open_agent_run_log`：`_meta.ui` = `{ resourceUri: "ui://agent-log/log.html", visibility: ["model","app"], displayMode: "fullscreen" }`。
- `resources/list` + `resources/read`：返回恰好 1 条 `text/html;profile=mcp-app`，uri 与 mime 精确匹配；未知 URI 返回 `-32002`。
- 本地冒烟：initialize 能力含 `tools`+`resources`；工具均带完整 `inputSchema`；资源读取 573 字节 HTML。
- dim 链路：`dim mcp test` → `success:true`；`dim exec` 新会话中 **`agent-log__open_agent_run_log` 与 `agent-log__hello` 均注册**——`_meta.ui` 严格校验通过，未触发 server 级回滚。
- **桌面端渲染 ✅（2026-09-17 11:53 实测）**：新会话调用 `open_agent_run_log` 后，fullscreen 面板渲染出「external-agents-extend 面板（T0.3 冒烟）」、渲染时间与握手状态 `initialized 已发送`。
- **桌面端空白面板根因（2026-09-17 定位并修复）**：dim 的 MCP App 宿主**要求 widget 完成 `ui/initialize` 握手后才显示内容**——未握手时 iframe 保持 `opacity:0`（全透明）且**静默无报错**，表现为面板永久空白（重开/重启均无效）。widget 侧最小握手（零依赖，已加入 `server/src/widget/log.html`）：
  1. 发请求 `{jsonrpc:"2.0", id, method:"ui/initialize", params:{appInfo:{name,version}, appCapabilities:{}, protocolVersion:"2026-01-26"}}`（0.9.32 仅接受 `2026-01-26`）；
  2. 收到 result 后发 `{jsonrpc:"2.0", method:"ui/notifications/initialized", params:{}}` → 宿主将 phase 置为 `ready`，内容可见。
  另注：宿主对 `ui://` 资源按 `serverId+uri` 内存缓存，**修改 widget 文件后需重启应用（或触发 server 重连）才生效**；plugin server 被杀后不会自动重连。
- **更名后回归（2026-09-17）**：`dim mcp test plugin:external-agents-extend/external-agents-extend` → `success:true`；`dim exec` 新会话确认 `external-agents-extend__hello` 与 `external-agents-extend__open_agent_run_log` 均注册。

契约参考：`plugin-creator/references/mcp-apps.md`（`resourceUri` 必须 `ui://`、`visibility` 数组非空无重复、`displayMode` 枚举、`resources/read` 恰好 1 条 `text/html;profile=mcp-app`）。
