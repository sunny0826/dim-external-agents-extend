#!/usr/bin/env node
'use strict';
/**
 * Stop hook：外部 Agent 新委托时，阻止本轮结束并让模型补一轮打开实时日志面板。
 *
 * 候选来源（按优先级）：
 * 1) PostToolUse 捕获的「本会话委托」条目（hooks/on-post-tool.js 写入）——精确、无时间窗猜测；
 * 2) 兜底：直接扫任务库（本会话 + 最近 WINDOW_MS 内启动的 running 任务），
 *    覆盖 PostToolUse 未生效（未注册 / 被禁用 / DB 竞态）的情况。
 *
 * dim command hook 协议：
 * - stdin 收到 JSON（snake_case：session_id / stop_hook_active 等）；
 * - 退出码 0 = 放行；退出码 2 = block，stderr/stdout 文本作为 continueReason 让模型继续；
 * - stop_hook_active=true 表示当前已处于 continue 回合，必须放行（防循环）。
 *
 * 去重：reminded 集合（每 taskId 只提醒一次）；delegated 条目提醒后即移除。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listRuns } = require('../server/src/core/runs');
const { recordActiveSession } = require('./active-session');
const { runAutoName } = require('./auto-name');

const WINDOW_MS = 10 * 60 * 1000; // 兜底扫描只看最近 10 分钟内启动的任务
const STATE_FILE =
  process.env.EA_EXT_HOOK_STATE || path.join(os.tmpdir(), 'ea-extend-hook-reminded.json');
const DELEGATED_FILE =
  process.env.EA_EXT_DELEGATED_STATE || path.join(os.tmpdir(), 'ea-extend-delegated.json');
const KEEP_MS = 60 * 60 * 1000; // delegated 条目保留窗口（与 on-post-tool 一致）

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8'); // fd 0；宿主写入后关闭
  } catch {
    return '';
  }
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { reminded: Array.isArray(parsed.reminded) ? parsed.reminded : [] };
  } catch {
    return { reminded: [] };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ reminded: state.reminded.slice(-200) }));
  } catch {
    /* 状态写入失败仅意味着可能重复提醒，忽略 */
  }
}

function loadDelegated() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DELEGATED_FILE, 'utf8'));
    return { pending: Array.isArray(parsed.pending) ? parsed.pending : [] };
  } catch {
    return { pending: [] };
  }
}

function saveDelegated(state) {
  try {
    fs.writeFileSync(DELEGATED_FILE, JSON.stringify({ pending: state.pending.slice(-50) }));
  } catch {
    /* 忽略 */
  }
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

/** 取当前会话 id（兼容 snake_case / camelCase）。 */
function sessionIdOf(input) {
  const sid = input && (input.session_id || input.sessionId);
  return typeof sid === 'string' && sid.length > 0 ? sid : null;
}

/** 条目是否属于当前会话；任一侧会话未知时视为匹配（回退全局，避免提醒失效）。 */
function belongsToSession(entrySessionId, currentSessionId) {
  if (!currentSessionId || !entrySessionId) return true;
  return entrySessionId === currentSessionId;
}

(function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    input = {};
  }
  recordActiveSession(input); // 记录活跃会话（供列表默认按本会话过滤）
  /* 全自动会话命名：静默执行，不改动本 hook 的放行/阻止语义。 */
  try {
    runAutoName();
  } catch {
    /* 忽略 */
  }
  // 诊断心跳：每次 Stop 被调用都留痕（用于判断 hook 是否注册/执行，与是否 block 无关）
  try {
    fs.writeFileSync(
      process.env.EA_EXT_STOP_HEARTBEAT || path.join(os.tmpdir(), 'ea-extend-stop-heartbeat.json'),
      JSON.stringify({ at: Date.now(), sessionId: sessionIdOf(input), reason: input.reason || null })
    );
  } catch {
    /* 忽略 */
  }
  if (input && (input.stop_hook_active === true || input.stopHookActive === true)) return; // 防循环（兼容两种字段命名）

  const currentSessionId = sessionIdOf(input);
  const now = Date.now();
  const state = loadState();
  const reminded = new Set(state.reminded);

  // 1) PostToolUse 捕获的候选（精确，优先）
  const delegated = loadDelegated();
  const captured = delegated.pending.filter(
    (e) =>
      now - Number(e.capturedAt || 0) <= KEEP_MS &&
      belongsToSession(e.sessionId, currentSessionId) &&
      (!e.taskId || !reminded.has(e.taskId))
  );

  // 2) 兜底：扫库（本会话 + 时间窗），仅当没有捕获候选时执行
  let candidates = captured;
  if (candidates.length === 0) {
    let runs;
    try {
      const dbPath = process.env.DIM_EXT_HOOK_DB;
      runs = listRuns({
        status: 'running',
        limit: 20,
        ...(dbPath ? { dbPath } : {}),
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      });
    } catch {
      return; // DB 不可用：静默放行
    }
    candidates = runs.filter((r) => {
      if (!r.agentType || r.agentType === 'tui_worker') return false;
      if (reminded.has(r.taskId)) return false;
      const t = parseTime(r.startedAt);
      return Number.isFinite(t) && t > 0 && now - t <= WINDOW_MS;
    });
  }
  if (candidates.length === 0) return;

  // 标记已提醒：taskId 进 reminded 集合；delegated 中已提醒的条目移除
  candidates.forEach((c) => {
    if (c.taskId) reminded.add(c.taskId);
  });
  saveState({ reminded: Array.from(reminded) });
  if (captured.length > 0) {
    delegated.pending = delegated.pending.filter((e) => !captured.includes(e));
    saveDelegated(delegated);
  }

  const items = candidates
    .map(
      (c) =>
        `- ${c.agentType || 'agent'}：${String(c.taskTitle || '').trim().slice(0, 40) || '(无标题)'}${
          c.taskId ? `（${c.taskId}）` : ''
        }`
    )
    .join('\n');
  process.stderr.write(
    `[外部 Agent 新启动] 以下任务刚刚被拉起：\n${items}\n` +
      `请在本次回复末尾调用一次 open_agent_run_log 打开实时日志面板。`
  );
  process.exit(2);
})();
