#!/usr/bin/env node
'use strict';
/**
 * UserPromptSubmit hook：检测外部 Agent 状态并向会话注入摘要。
 *
 * 两类注入（均只针对「本会话委托」的任务；当前会话未知时回退全局）：
 * 1) 运行中任务（原有能力）；
 * 2) 最近完成 / 失败、尚未提醒过的任务（补报，避免「用户不问就永远不知道结果」）。
 *
 * 设计约束（安全无感）：
 * - 只读本机 dim 任务库，不联网；
 * - 毫秒级；任何异常都静默退出（输出空、exit 0），绝不影响会话；
 * - 无内容时不输出任何内容（零打扰）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listRuns } = require('../server/src/core/runs');
const { recordActiveSession } = require('./active-session');

const FINISHED_WINDOW_MS = 4 * 60 * 60 * 1000; // 只补报最近 4 小时内结束的任务
const FINISHED_MAX = 3; // 单次最多补报条数
const FINISHED_STATE_FILE =
  process.env.EA_EXT_FINISHED_STATE || path.join(os.tmpdir(), 'ea-extend-finished-reminded.json');

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

/** 时间字段（ISO 字符串 / 毫秒数 / 数字字符串）→ 毫秒时间戳；不可解析返回 NaN。 */
function parseTime(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return NaN;
}

/** 读 hook stdin（JSON）；失败返回 {}。 */
function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/** 取当前会话 id（兼容 snake_case / camelCase）。 */
function sessionIdOf(input) {
  const sid = input && (input.session_id || input.sessionId);
  return typeof sid === 'string' && sid.length > 0 ? sid : null;
}

function loadFinishedState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FINISHED_STATE_FILE, 'utf8'));
    return { reminded: Array.isArray(parsed.reminded) ? parsed.reminded : [] };
  } catch {
    return { reminded: [] };
  }
}

function saveFinishedState(state) {
  try {
    fs.writeFileSync(FINISHED_STATE_FILE, JSON.stringify({ reminded: state.reminded.slice(-200) }));
  } catch {
    /* 忽略：仅可能重复补报 */
  }
}

(function main() {
  const input = readStdin();
  recordActiveSession(input);
  const sessionId = sessionIdOf(input);

  let running;
  let finishedRaw;
  try {
    const dbPath = process.env.DIM_EXT_HOOK_DB;
    const dbOpts = dbPath ? { dbPath } : {};
    const scope = sessionId ? { sessionId } : {};
    running = listRuns({ ...dbOpts, status: 'running', limit: 20, ...scope });
    finishedRaw = [
      ...listRuns({ ...dbOpts, status: 'failed', limit: 50, ...scope }),
      ...listRuns({ ...dbOpts, status: 'completed', limit: 50, ...scope }),
    ];
  } catch {
    return; // DB 不可用 / 查询失败：静默
  }

  const external = running.filter((r) => r.agentType && r.agentType !== 'tui_worker');

  // 完成 / 失败补报：窗口内、未提醒过，按结束时间倒序取前 FINISHED_MAX 条
  const now = Date.now();
  const finishedState = loadFinishedState();
  const remindedSet = new Set(finishedState.reminded);
  const finished = finishedRaw
    .filter((r) => r.agentType && r.agentType !== 'tui_worker' && r.taskId && !remindedSet.has(r.taskId))
    .map((r) => ({ run: r, at: parseTime(r.completedAt), status: r.status }))
    .filter((e) => Number.isFinite(e.at) && now - e.at <= FINISHED_WINDOW_MS)
    .sort((a, b) => b.at - a.at);
  const shown = finished.slice(0, FINISHED_MAX);

  if (external.length === 0 && shown.length === 0) return;

  const lines = [];
  if (external.length > 0) {
    const items = external.slice(0, 5).map((r) => {
      const title = String(r.taskTitle || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '(无标题)';
      const dur = duration(r.startedAt);
      return `- ${r.agentType}：${title}（${r.taskId}${dur ? '，' + dur : ''}）`;
    });
    const more = external.length > 5 ? `，另 ${external.length - 5} 个未列出` : '';
    lines.push(`[外部 Agent 状态] 当前有 ${external.length} 个外部 Agent 任务运行中${more}：`);
    lines.push(...items);
  }
  if (shown.length > 0) {
    const more = finished.length > FINISHED_MAX ? `（另有 ${finished.length - FINISHED_MAX} 个未列出）` : '';
    lines.push(`[外部 Agent 完成] 最近结束的任务${more}：`);
    lines.push(
      ...shown.map((e) => {
        const title = String(e.run.taskTitle || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '(无标题)';
        const label = e.status === 'failed' ? '失败' : '已完成';
        return `- ${e.run.agentType}：${title}（${e.run.taskId}，${label}）`;
      })
    );
  }
  lines.push('查看实时执行日志：调用 open_agent_run_log 打开日志面板，或 read_agent_run(taskId)。');
  console.log(lines.join('\n'));

  if (shown.length > 0) {
    shown.forEach((e) => remindedSet.add(e.run.taskId));
    saveFinishedState({ reminded: Array.from(remindedSet) });
  }
})();
