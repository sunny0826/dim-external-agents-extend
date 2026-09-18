# 阶段 4 验证记录：CLI 与 Skill（2026-09-17）

## 交付

| 文件 | 内容 |
|---|---|
| `server/src/cli.js` | CLI 实现：`list` / `show <taskId>` / `tail <taskId>`，复用 tools.js 的四类语义；选项 `--json` / `--type` / `--status` / `--limit` / `--interval` / `--home`；纯本机、零依赖 |
| `bin/dim-external-agents-extend` | 占位脚本替换为真实入口（POSIX sh → `exec node server/src/cli.js "$@"`） |
| `skills/external-agents-extend/SKILL.md` | 插件 skill：使用时机 + 工具用法（含 status 语义）+ CLI 等价命令 + 注意事项 |
| `.codex-plugin/plugin.json` | 增加 `"skills": "./skills/"` |
| `server/test/cli.test.js` | 10 项子进程测试（真实 spawn CLI，覆盖三个子命令与用法错误） |

## 验证

- **测试**：`mise exec -- node --test` → **72 pass / 0 fail**（62 + CLI 10）。
- **真实数据**：`bin list --type kimi`（表格正常）；`bin show <taskId>`（任务头 + 事件流；session 显示 `timestamp+token · high`，印证阶段 1 消歧在真实会话上的效果）。
- **插件校验**：`python3 plugin-creator/scripts/validate_plugin.py .` → `Plugin validation passed`。
- **skill 加载实测**：CLI 新会话确认 `external-agents-extend` skill 已被加载（模型如实复述其触发条件）。

## 修复记录（开发中抓到两个真实 bug）

1. **`tail` 无限循环**：`readAgentRun` 返回 `db_unavailable` 时响应中**没有 nextCursor 字段**（undefined），而退出条件写作 `data.nextCursor === null` ——永不满足，tail 死循环不退出（测试 15s 超时才暴露）。已修：`tail`/`show` 显式处理 `db_unavailable`（打印错误并退出 1）；退出条件兼容 `undefined/null`。
2. **测试 fixture 路径语义**：fixture db 原放在 `<home>/dimcode.sqlite`，而 CLI 的 `--home` 推导为 `<home>/.dimcode/v2/dimcode.sqlite`——修正 fixture 后测试全绿（也验证了 `--home` 的推导正确）。

## 复现

```bash
mise exec -- node --test
mise exec -- ./bin/dim-external-agents-extend list --limit 5
mise exec -- ./bin/dim-external-agents-extend show <taskId>
mise exec -- ./bin/dim-external-agents-extend tail <taskId> --interval 2000
python3 ~/.dimcode/v2/skills/plugin-creator/scripts/validate_plugin.py .
```
