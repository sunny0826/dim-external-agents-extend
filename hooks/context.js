#!/usr/bin/env node
'use strict';
/**
 * UserPromptSubmit hook：检测运行中的外部 Agent 任务并向会话注入一行状态。
 *
 * 设计约束（安全无感）：
 * - 只读本机 dim 任务库，不联网；
 * - 毫秒级；任何异常都静默退出（输出空、exit 0），绝不影响会话；
 * - 无运行中任务时不输出任何内容（零打扰）。
 */

const fs = require('node:fs');
const { listRuns } = require('../server/src/core/runs');
const { recordActiveSession } = require('./active-session');

/** startedAt（毫秒数或 ISO 字符串）→ "已运行 X 分钟"；不可解析则返回空串。 */
function duration(startedAt) {
  let t = null;
  if (typeof startedAt === 'number') t = startedAt;
  else if (typeof startedAt === 'string') {
    const n = Number(startedAt);
    t = Number.isFinite(n) ? n : Date.parse(startedAt);
  }
  if (!Number.isFinite(t) || t <= 0) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (minutes < 1) return '刚启动';
  if (minutes < 60) return `已运行 ${minutes} 分钟`;
  return `已运行 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** 读 hook stdin（JSON）；失败返回 {}。 */
function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

(function main() {
  recordActiveSession(readStdin());

  let runs;
  try {
    const dbPath = process.env.DIM_EXT_HOOK_DB;
    runs = listRuns(dbPath ? { status: 'running', limit: 20, dbPath } : { status: 'running', limit: 20 });
  } catch {
    return; // DB 不可用 / 查询失败：静默
  }

  const external = runs.filter((r) => r.agentType && r.agentType !== 'tui_worker');
  if (external.length === 0) return;

  const lines = external.slice(0, 5).map((r) => {
    const title = String(r.taskTitle || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '(无标题)';
    const dur = duration(r.startedAt);
    return `- ${r.agentType}：${title}（${r.taskId}${dur ? '，' + dur : ''}）`;
  });
  const more = external.length > 5 ? `，另 ${external.length - 5} 个未列出` : '';
  console.log(`[外部 Agent 状态] 当前有 ${external.length} 个外部 Agent 任务运行中${more}：`);
  console.log(lines.join('\n'));
  console.log('查看实时执行日志：调用 open_agent_run_log 打开日志面板，或 read_agent_run(taskId)。');
})();
