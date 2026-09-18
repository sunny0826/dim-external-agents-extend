'use strict';

/**
 * 任务↔会话映射器（T1.2）。
 *
 * 机制（已核验，见 HANDOFF 2.3）：`taskId` 前 13 位是任务创建的毫秒时间戳，
 * 与外部会话创建时间（kimi: state.json.createdAt；cursor: 目录 birthtime；
 * codex: rollout 文件首行 session_meta.timestamp）匹配，实测误差 < 1s。
 * 加强校验：prompt / title 文本匹配（可选），未匹配时返回明确状态。
 *
 * 输出统一为「会话引用」：
 *   { status, agentType, ref: { adapter, kind: 'dir'|'file', path, id }, matchedBy, confidence, warnings }
 * 适配器（adapters/*.js）消费 ref 读取事件。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { warning } = require('./events');

const DEFAULT_TOLERANCE_MS = 5000;

/** taskId → 毫秒时间戳；无法解析返回 null。 */
function taskTimestampMs(taskId) {
  const m = /^task_(\d{13})_/.exec(String(taskId));
  return m ? Number(m[1]) : null;
}

function safeJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function safeReadJsonl(file, maxLines = 20000) {
  const out = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && i < maxLines; i += 1) {
    const t = lines[i].trim();
    if (t.length === 0) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** 只读文件头部若干字节并返回第一行（避免为读 session_meta 而载入整个 rollout 文件）。 */
function readFirstLine(file, maxBytes = 262144) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const idx = text.indexOf('\n');
    return idx >= 0 ? text.slice(0, idx) : text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 从候选（{delta}）中裁决最佳匹配：
 * - 唯一候选 → confidence 'medium'；
 * - 多候选且前两名差距 < 1s（无法可靠区分）→ confidence 'low' + ambiguous_candidates 警告；
 * - 多候选但差距明显 → 取最接近者，'medium'。
 * 注：kimi 的 state.json.lastPrompt 是改写后的包装文本（切片命中率 1/13）、cursor 的
 * meta.json.title 是自动生成英文标题（与任务标题不等），二者均不能作为相等性校验——
 * 匹配以时间戳 + delta 排序为准（实测误差 < 1s）。
 */
function pickCandidate(candidates) {
  candidates.sort((a, b) => a.delta - b.delta);
  const best = candidates[0];
  const second = candidates[1];
  const warnings = [];
  let confidence = 'medium';
  if (second !== undefined && second.delta - best.delta < 1000) {
    confidence = 'low';
    warnings.push(
      warning(
        'ambiguous_candidates',
        `时间窗内存在多个候选会话（delta ${Math.round(best.delta)}ms / ${Math.round(second.delta)}ms），按最接近者返回`
      )
    );
  }
  return { best, confidence, warnings };
}

/**
 * 提取任务侧的高价值消歧 token（Linear Issue ID 形态，如 GUO-63）。
 * 用于并行任务场景：多个外部会话创建时间可相差 1ms，纯 delta 无法区分
 * （实测 task_...749 / task_...654 两个并行 kimi 任务 ↔ 两个会话 createdAt 仅差 1ms）。
 */
function extractTaskTokens(run) {
  const out = new Set();
  const re = /\b[A-Z]{2,}-\d+\b/g;
  for (const source of [run.taskTitle || '', run.prompt || '']) {
    const m = source.match(re);
    if (m) for (const t of m) out.add(t);
  }
  return [...out];
}

/* ------------------------------- kimi ---------------------------------- */

function findKimiRef(run, { home, toleranceMs }) {
  const ts = taskTimestampMs(run.taskId);
  if (ts === null) return null;
  const indexFile = path.join(home, '.kimi-code', 'session_index.jsonl');
  const entries = safeReadJsonl(indexFile);
  if (entries.length === 0) return null;

  const candidates = [];
  for (const e of entries) {
    if (!e || typeof e.sessionDir !== 'string') continue;
    const state = safeJson(path.join(e.sessionDir, 'state.json'));
    const createdAt = state ? Number(state.createdAt) : NaN;
    if (!Number.isFinite(createdAt)) continue;
    const delta = Math.abs(createdAt - ts);
    if (delta <= toleranceMs) candidates.push({ e, state, delta });
  }
  if (candidates.length === 0) return null;

  // token 消歧：用任务侧 Issue ID token（如 GUO-63）与会话 state.json.lastPrompt 交叉比对。
  // 并行任务场景下多个候选的 delta 可能只差 1ms，纯 delta 排序会选错（实测已发生）。
  const tokens = extractTaskTokens(run);
  if (tokens.length > 0) {
    for (const c of candidates) {
      const lp = c.state && typeof c.state.lastPrompt === 'string' ? c.state.lastPrompt : '';
      c.tokenHits = tokens.reduce((n, t) => n + (lp.includes(t) ? 1 : 0), 0);
    }
    const withHits = candidates.filter((c) => c.tokenHits > 0);
    if (withHits.length > 0) {
      withHits.sort((a, b) => b.tokenHits - a.tokenHits || a.delta - b.delta);
      const top = withHits[0];
      const tied = withHits.length > 1 && withHits[1].tokenHits === top.tokenHits;
      if (!tied) {
        return {
          status: 'matched',
          agentType: 'kimi',
          ref: {
            adapter: 'kimi',
            kind: 'dir',
            path: top.e.sessionDir,
            id: typeof top.e.sessionId === 'string' ? top.e.sessionId : null,
          },
          matchedBy: 'timestamp+token',
          confidence: 'high',
          warnings: [],
        };
      }
    }
  }

  const { best, confidence, warnings } = pickCandidate(candidates);
  return {
    status: 'matched',
    agentType: 'kimi',
    ref: {
      adapter: 'kimi',
      kind: 'dir',
      path: best.e.sessionDir,
      id: typeof best.e.sessionId === 'string' ? best.e.sessionId : null,
    },
    matchedBy: 'timestamp',
    confidence,
    warnings,
  };
}

/* ------------------------------ cursor --------------------------------- */

function findCursorRef(run, { home, toleranceMs }) {
  const ts = taskTimestampMs(run.taskId);
  if (ts === null) return null;
  const root = path.join(home, '.cursor', 'acp-sessions');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(root, e.name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    const birth = st.birthtimeMs || st.ctimeMs;
    const delta = Math.abs(birth - ts);
    if (delta <= toleranceMs) candidates.push({ full, name: e.name, delta });
  }
  if (candidates.length === 0) return null;
  const { best, confidence, warnings } = pickCandidate(candidates);
  return {
    status: 'matched',
    agentType: 'cursor',
    ref: { adapter: 'cursor', kind: 'dir', path: best.full, id: best.name },
    matchedBy: 'timestamp',
    confidence,
    warnings,
  };
}

/* ------------------------------- codex --------------------------------- */

function findCodexRef(run, { home, toleranceMs }) {
  const ts = taskTimestampMs(run.taskId);
  if (ts === null) return null;
  const base = path.join(home, '.codex', 'sessions');

  // 时区边界：扫任务时间前后各一天。
  const days = [-1, 0, 1].map((off) => {
    const d = new Date(ts + off * 86400000);
    return path.join(base, String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate()));
  });

  const candidates = [];
  for (const dir of days) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      const first = readFirstLine(full);
      if (!first) continue;
      let meta;
      try {
        meta = JSON.parse(first);
      } catch {
        continue;
      }
      const payload = meta && meta.payload;
      const iso = payload && payload.timestamp;
      const fileTs = iso ? Date.parse(iso) : NaN;
      if (!Number.isFinite(fileTs)) continue;
      const delta = Math.abs(fileTs - ts);
      if (delta <= toleranceMs) candidates.push({ full, payload, delta });
    }
  }
  if (candidates.length === 0) return null;
  const { best, confidence, warnings } = pickCandidate(candidates);
  return {
    status: 'matched',
    agentType: 'codex',
    ref: {
      adapter: 'codex',
      kind: 'file',
      path: best.full,
      id: (best.payload && best.payload.session_id) || null,
    },
    matchedBy: 'timestamp',
    confidence,
    warnings,
  };
}

/* ------------------------------ dispatch -------------------------------- */

const FINDERS = { kimi: findKimiRef, cursor: findCursorRef, codex: findCodexRef };

/**
 * 把任务映射到外部会话引用。
 * @param {object} run 来自 runs 模块的任务记录
 * @param {{home?: string, toleranceMs?: number}} [options]
 */
function mapRunToSession(run, options = {}) {
  const home = options.home || os.homedir();
  const toleranceMs = options.toleranceMs || DEFAULT_TOLERANCE_MS;
  const agentType = run && run.agentType ? run.agentType : null;

  if (!agentType) {
    return {
      status: 'unsupported',
      agentType: null,
      ref: null,
      matchedBy: null,
      confidence: null,
      warnings: [warning('no_agent_type', '任务缺少 agent 类型（externalAgentType/subagentType 均缺失）')],
    };
  }
  const finder = FINDERS[agentType];
  if (!finder) {
    return {
      status: 'unsupported',
      agentType,
      ref: null,
      matchedBy: null,
      confidence: null,
      warnings: [warning('unsupported_agent', `暂不支持 ${agentType} 的会话定位`)],
    };
  }
  // 容差按 agent 定制：cursor CLI 启动 + 会话目录创建有数秒开销（实测 birthtime 晚于任务派发 5.8s），
  // 用 20s 窗口；kimi/codex 实测 <1s，保持 5s。
  const effectiveToleranceMs = agentType === 'cursor' ? Math.max(toleranceMs, 20000) : toleranceMs;
  let result;
  try {
    result = finder(run, { home, toleranceMs: effectiveToleranceMs });
  } catch (err) {
    return {
      status: 'unmatched',
      agentType,
      ref: null,
      matchedBy: null,
      confidence: null,
      warnings: [warning('mapping_failed', `会话定位失败：${String((err && err.message) || err)}`)],
    };
  }
  if (!result) {
    return { status: 'unmatched', agentType, ref: null, matchedBy: null, confidence: null, warnings: [] };
  }
  return result;
}

module.exports = { mapRunToSession, taskTimestampMs, DEFAULT_TOLERANCE_MS };
