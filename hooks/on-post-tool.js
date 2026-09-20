#!/usr/bin/env node
'use strict';
/**
 * PostToolUse hook（matcher: agent）：捕获 create_external 委托瞬间。
 *
 * 目的：把「本会话刚委托的外部 Agent 任务」写入临时状态文件，供 Stop hook 精确提醒，
 * 替代过去「扫全库 + 10 分钟时间窗」的猜测式检测（同时消除跨会话串场）。
 *
 * dim command hook 协议：
 * - stdin 收到 JSON（snake_case）：hook_event_name / session_id / tool_name / tool_use_id /
 *   tool_input / tool_response；
 * - PostToolUse 不能 block；本 hook 只写状态文件，不产生任何 stdout/stderr 输出
 *   （避免被宿主当作 systemPromptAppend 注入）；
 * - 任何异常静默退出（exit 0），绝不影响会话。
 *
 * taskId 获取顺序：
 * 1) 用 tool_use_id 精确匹配 background_tasks.sourceToolCallId（首选）；
 * 2) 兜底：本会话 + 最近 2 分钟内启动的最新 agent 任务；
 * 3) 仍拿不到则只记录基本信息（agentType/taskTitle），由 Stop 端按会话提示。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listRuns, findRunByToolCallId } = require('../server/src/core/runs');
const { recordActiveSession } = require('./active-session');
const { runAutoName } = require('./auto-name');

const STATE_FILE = process.env.EA_EXT_DELEGATED_STATE || path.join(os.tmpdir(), 'ea-extend-delegated.json');
const KEEP_MS = 60 * 60 * 1000; // 条目保留 1 小时（足够覆盖「委托 → 回合结束」）
const MAX_ENTRIES = 50;
const FALLBACK_WINDOW_MS = 2 * 60 * 1000;

/** 读 hook stdin（JSON）；失败返回 {}。 */
function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { pending: Array.isArray(parsed.pending) ? parsed.pending : [] };
  } catch {
    return { pending: [] };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pending: state.pending.slice(-MAX_ENTRIES) }));
  } catch {
    /* 写入失败：Stop 端还有 DB 兜底，忽略 */
  }
}

/** startedAt（ISO 字符串 / 毫秒数 / 数字字符串）→ 毫秒时间戳；不可解析返回 NaN。 */
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

/** 同一委托的重复条目判定（taskId 优先，其次 会话+类型+标题）。 */
function sameEntry(a, b) {
  if (a.taskId && b.taskId) return a.taskId === b.taskId;
  return a.sessionId === b.sessionId && a.agentType === b.agentType && a.taskTitle === b.taskTitle;
}

(function main() {
  const input = readStdin();
  recordActiveSession(input);

  // 只看 agent 工具的 create_external（matcher 已在宿主侧按工具名过滤，这里再确认 action）。
  if (input.tool_name !== 'agent') return;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : null;
  if (!toolInput || toolInput.action !== 'create_external') return;

  const sessionId =
    typeof input.session_id === 'string' && input.session_id.length > 0 ? input.session_id : null;

  let run = null;
  try {
    const dbOpts = process.env.DIM_EXT_HOOK_DB ? { dbPath: process.env.DIM_EXT_HOOK_DB } : {};
    if (typeof input.tool_use_id === 'string' && input.tool_use_id.length > 0) {
      run = findRunByToolCallId(input.tool_use_id, dbOpts);
    }
    if (!run && sessionId) {
      const now = Date.now();
      run =
        listRuns({ ...dbOpts, sessionId, limit: 5 }).find((r) => {
          const t = parseTime(r.startedAt);
          return Number.isFinite(t) && now - t <= FALLBACK_WINDOW_MS;
        }) || null;
    }
  } catch {
    /* DB 不可用：仍记录基本信息 */
  }

  const entry = {
    taskId: (run && run.taskId) || null,
    agentType:
      (run && run.agentType) ||
      (typeof toolInput.agentType === 'string' && toolInput.agentType.length > 0 ? toolInput.agentType : null),
    taskTitle:
      (run && run.taskTitle) ||
      (typeof toolInput.taskTitle === 'string' && toolInput.taskTitle.length > 0 ? toolInput.taskTitle : null),
    sessionId,
    capturedAt: Date.now(),
  };
  if (!entry.taskId && !entry.agentType) return; // 无可用信息：不记录

  const now = Date.now();
  const state = loadState();
  state.pending = state.pending.filter((e) => now - Number(e.capturedAt || 0) <= KEEP_MS);
  if (state.pending.some((e) => sameEntry(e, entry))) return; // 重复捕获：跳过
  state.pending.push(entry);
  saveState(state);

  /* 全自动会话命名：此刻外部会话通常还没落盘（返回 no-op），真正生效多在下一次
     UserPromptSubmit / Stop；这里留着是为了「委托后用户长时间不再输入」的场景。
     静默、可关、带节流，绝不影响本 hook 的写状态语义。 */
  try {
    runAutoName();
  } catch {
    /* 忽略 */
  }
})();
