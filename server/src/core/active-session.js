'use strict';

/**
 * 活跃 dim 会话的共享状态（hook 写、MCP 工具读）。
 *
 * 文件：`<tmp>/ea-extend-active-session.json`（可用 `EA_EXT_ACTIVE_SESSION` 覆盖）。
 *
 * 为什么存**多个会话的映射**而不是单个 id：多个 dim 会话可能同时在用（甚至同时有
 * 外部 Agent 在跑），而 hook 是「谁触发谁写」——单个 id 会被别的会话覆盖，
 * 导致本会话解析成别的会话、列表静默变空（实测发生过）。所以按会话记录最近活跃时间，
 * 读取方取最新的一条；解析不到任务时由调用方回退并明确标注。
 *
 * 兼容旧的单会话格式 `{ sessionId, updatedAt }`。
 * 约束：任何异常都静默（hook 绝不影响会话）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE_NAME = 'ea-extend-active-session.json';
const KEEP_MS = 24 * 60 * 60 * 1000; // 只保留最近 24 小时活跃过的会话
const MAX_SESSIONS = 20;

function activeSessionPath() {
  return process.env.EA_EXT_ACTIVE_SESSION || path.join(os.tmpdir(), FILE_NAME);
}

/** 读取活跃会话映射（兼容旧的单会话格式）。 */
function readActiveSessions(file = activeSessionPath()) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object') return {};
  /* 旧格式：{ sessionId, updatedAt } */
  if (typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0) {
    return { [parsed.sessionId]: Number(parsed.updatedAt) || 0 };
  }
  const out = {};
  if (parsed.sessions !== null && typeof parsed.sessions === 'object') {
    for (const [sid, at] of Object.entries(parsed.sessions)) {
      if (typeof sid === 'string' && sid.length > 0 && Number.isFinite(Number(at))) out[sid] = Number(at);
    }
  }
  return out;
}

/** 最近活跃的会话 id（没有记录返回 null）。 */
function latestActiveSession(file = activeSessionPath()) {
  const map = readActiveSessions(file);
  let best = null;
  let bestAt = -1;
  for (const [sid, at] of Object.entries(map)) {
    if (at >= bestAt) {
      best = sid;
      bestAt = at;
    }
  }
  return best;
}

/** 从 hook 输入对象里取会话 id 并落盘；无 id 或失败则静默。 */
function recordActiveSession(input) {
  try {
    const sid = input && (input.sessionId || input.session_id);
    if (typeof sid !== 'string' || sid.length === 0) return;
    const file = activeSessionPath();
    const now = Date.now();
    const map = readActiveSessions(file);
    map[sid] = now;
    /* 剪枝：超期条目丢弃；条数超限时保留最新的若干条 */
    const sessions = Object.fromEntries(
      Object.entries(map)
        .filter(([, at]) => now - at <= KEEP_MS)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_SESSIONS)
    );
    fs.writeFileSync(file, JSON.stringify({ sessions, updatedAt: now }));
  } catch {
    /* 忽略：仅影响默认过滤范围，不影响功能 */
  }
}

module.exports = { activeSessionPath, readActiveSessions, latestActiveSession, recordActiveSession };
