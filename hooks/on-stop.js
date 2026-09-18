#!/usr/bin/env node
'use strict';
/**
 * Stop hook：外部 Agent 刚启动时，阻止本轮结束并让模型补一轮打开实时日志面板。
 *
 * dim command hook 协议：
 * - stdin 收到 JSON（含 stop_hook_active / session_id 等）；
 * - 退出码 0 = 放行；退出码 2 = block，stderr/stdout 文本作为 continueReason 让模型继续；
 * - stop_hook_active=true 表示当前已处于 continue 回合，必须放行（防循环）。
 *
 * 触发条件：存在「最近 WINDOW_MS 内启动、且未提醒过」的运行中外部任务；
 * 提醒记录写临时文件（每个 taskId 只提醒一次）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listRuns } = require('../server/src/core/runs');
const { recordActiveSession } = require('./active-session');

const WINDOW_MS = 10 * 60 * 1000; // 只看最近 10 分钟内启动的任务
const STATE_FILE =
  process.env.EA_EXT_HOOK_STATE || path.join(os.tmpdir(), 'ea-extend-hook-reminded.json');

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

(function main() {
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    input = {};
  }
  recordActiveSession(input); // 记录活跃会话（供列表默认按本会话过滤）
  // 诊断心跳：每次 Stop 被调用都留痕（用于判断 hook 是否注册/执行，与是否 block 无关）
  try {
    fs.writeFileSync(
      process.env.EA_EXT_STOP_HEARTBEAT || path.join(os.tmpdir(), 'ea-extend-stop-heartbeat.json'),
      JSON.stringify({ at: Date.now(), sessionId: input.sessionId || null, reason: input.reason || null })
    );
  } catch {
    /* 忽略 */
  }
  if (input && (input.stop_hook_active === true || input.stopHookActive === true)) return; // 防循环（兼容两种字段命名）

  let runs;
  try {
    const dbPath = process.env.DIM_EXT_HOOK_DB;
    runs = listRuns(dbPath ? { status: 'running', limit: 20, dbPath } : { status: 'running', limit: 20 });
  } catch {
    return; // DB 不可用：静默放行
  }

  const now = Date.now();
  const state = loadState();
  const reminded = new Set(state.reminded);
  const fresh = runs.filter((r) => {
    if (!r.agentType || r.agentType === 'tui_worker') return false;
    if (reminded.has(r.taskId)) return false;
    const t = Number(r.startedAt) || Date.parse(r.startedAt || '');
    return Number.isFinite(t) && t > 0 && now - t <= WINDOW_MS;
  });
  if (fresh.length === 0) return;

  fresh.forEach((r) => reminded.add(r.taskId));
  saveState({ reminded: Array.from(reminded) });

  const items = fresh
    .map((r) => `- ${r.agentType}：${String(r.taskTitle || '').trim().slice(0, 40) || '(无标题)'}（${r.taskId}）`)
    .join('\n');
  process.stderr.write(
    `[外部 Agent 新启动] 以下任务刚刚被拉起：\n${items}\n` +
      `请在本次回复末尾调用一次 open_agent_run_log 打开实时日志面板。`
  );
  process.exit(2);
})();
