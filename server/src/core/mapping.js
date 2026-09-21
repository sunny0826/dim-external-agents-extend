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
const { DatabaseSync } = require('node:sqlite');
const { warning } = require('./events');

/**
 * 任务↔会话时间容差（ms）。taskId 里的时间戳是 dim 的派发时刻，而会话文件的时间戳是
 * 外部 CLI 真正建会话的时刻——中间隔着进程启动、认证与项目扫描，冷启动实测可达 5.4s
 * （codex 2026-09-21 样本 Δ=5.354s / 5.447s）。阈值必须覆盖冷启动，否则任务被判为
 * 「未找到对应的外部会话」。
 * 与 sessions.js 的 TOLERANCE_MS 保持同一张表：同一批任务在两处必须得到相同结论。
 */
const TOLERANCE_MS = {
  kimi: 5000,
  codex: 20000,
  cursor: 20000,
  grok: 30000,
  opencode: 30000,
  // zcode 目前没有日志 finder（FINDERS 未登记），但容差表与 sessions.js 保持同构，
  // 避免将来补上 finder 时静默落到 DEFAULT 而与会话列表分叉。
  zcode: 30000,
};

/** 未在 TOLERANCE_MS 中登记的 agent 的兜底窗口。 */
const DEFAULT_TOLERANCE_MS = 20000;

/** opencode CLI 启动 + 建会话有数秒开销，与 sessions.js 的 TOLERANCE_MS.opencode 对齐。 */
const OPENCODE_TOLERANCE_MS = 30000;

/** 按 agent 类型取时间容差。 */
function toleranceFor(agentType) {
  return TOLERANCE_MS[agentType] || DEFAULT_TOLERANCE_MS;
}

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

/** 宽松解析 sqlite 的 JSON 文本列（可能是对象、字符串或损坏值）。 */
function safeJsonText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function closeQuietly(db) {
  if (db === undefined || db === null) return;
  try {
    db.close();
  } catch {
    /* best-effort */
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

/** 只读文件头部若干字节（避免为解析元数据/指纹而载入整个会话文件）。 */
function readHead(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
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

/** 只读文件头部若干字节并返回第一行（避免为读 session_meta 而载入整个 rollout 文件）。 */
function readFirstLine(file, maxBytes = 262144) {
  const head = readHead(file, maxBytes);
  if (head === null) return null;
  const idx = head.indexOf('\n');
  return idx >= 0 ? head.slice(0, idx) : head;
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

/**
 * dim 派发的 codex 会话在 session_meta.originator 里固定标记为 'dimcode'（本机 28/28 实测）。
 * 用于把 dim 任务和用户自己在 Codex Desktop / codex-tui 里开的会话区分开。
 */
function isDimDelegatedCodex(payload) {
  return Boolean(payload) && payload.originator === 'dimcode';
}

/**
 * rollout 头部里所有 user 消息文本（归一化）。dim 把 prompt 原样交给 CLI，所以任务 prompt
 * 会作为其中一条出现——但**不是第一条**：前面还有 CLI 自己注入的 recommended_plugins、
 * AGENTS.md 与 environment_context。只读文件头部若干字节。
 */
function codexUserTexts(file, maxBytes = 1048576) {
  const head = readHead(file, maxBytes);
  if (head === null) return [];
  const out = [];
  for (const line of head.split('\n')) {
    const t = line.trim();
    if (t.length === 0 || t[0] !== '{') continue;
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      continue; // 头部截断处可能是半行
    }
    const payload = rec && rec.payload;
    if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;
    for (const part of Array.isArray(payload.content) ? payload.content : []) {
      if (part && part.type === 'input_text' && typeof part.text === 'string') out.push(normalizeText(part.text));
    }
  }
  return out;
}

/**
 * 用 dim 侧的 prompt 给候选会话打分：
 *   2 = 与某条 user 消息归一化后完整相等（dim 原样传递，最强判据）
 *   1 = 命中 prompt 开头 60 字符（开头带任务标题，是独特的）
 *   0 = 无
 * 刻意不做 tail 匹配：这类委派 prompt 的结尾是模板文本，并发任务的结尾一字不差
 * （实测 GUO-102 / GUO-120 的尾 60 字符完全相同），用 tail 会让两个候选互相命中。
 */
function codexPromptScore(prompt, userTexts) {
  const p = normalizeText(prompt);
  if (p.length < 24) return 0; // 太短不足以作为指纹
  if (userTexts.some((t) => t === p)) return 2;
  const head = p.slice(0, 60);
  return userTexts.some((t) => t.includes(head)) ? 1 : 0;
}

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
      if (delta <= toleranceMs) {
        candidates.push({ full, payload, delta, delegated: isDimDelegatedCodex(payload) });
      }
    }
  }
  if (candidates.length === 0) return null;
  // `~/.codex/sessions` 是 dim 与用户自建会话共用的目录树，只按时间戳会误选用户会话
  // （放宽容差后风险更高）。优先在 dim 派发的候选里裁决；窗口内一个 dimcode 候选都没有时
  // 回退到全部候选并显式告警——未来 codex 改了这个字段值也不至于让匹配整体失效。
  const delegated = candidates.filter((c) => c.delegated);
  const pool = delegated.length > 0 ? delegated : candidates;
  const extraWarnings = [];
  if (delegated.length === 0) {
    extraWarnings.push(
      warning(
        'codex_originator_unknown',
        '时间窗内没有 originator=dimcode 的 codex 会话，已按时间戳回退匹配（可能选到用户自建会话）'
      )
    );
  }

  // 并发派发：多个任务在同一时间窗里各建一个会话，时间戳只差几十毫秒，无法区分
  // （实测两个任务相差 470ms、两个 rollout 相差 58ms，结果都指向同一个文件）。
  // 这时用 dim 侧的 prompt 认领会话——prompt 是原样传下去的，能唯一确定归属。
  // 只有多候选才做：单候选的时间戳已经唯一，不必付读文件的代价。
  if (pool.length > 1) {
    for (const c of pool) c.fp = codexPromptScore(run.prompt, codexUserTexts(c.full));
    const bestFp = Math.max(...pool.map((c) => c.fp));
    const hits = bestFp > 0 ? pool.filter((c) => c.fp === bestFp) : [];
    // 唯一命中才认；同级多命中（例如同一 prompt 被派发两次）交回时间戳裁决。
    if (hits.length === 1) {
      return {
        status: 'matched',
        agentType: 'codex',
        ref: {
          adapter: 'codex',
          kind: 'file',
          path: hits[0].full,
          id: (hits[0].payload && hits[0].payload.session_id) || null,
        },
        matchedBy: 'timestamp+prompt',
        confidence: 'high',
        warnings: extraWarnings,
      };
    }
  }

  const { best, confidence, warnings } = pickCandidate(pool);
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
    warnings: [...extraWarnings, ...warnings],
  };
}

/* ------------------------------- grok ---------------------------------- */

/** 归一化文本：折叠空白，便于做包含判断。 */
function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * 会话首条 user_message_chunk 的文本（dim 把任务 prompt 原样交给 CLI）。
 * 只读文件头部若干字节：首条用户消息总在最前面，避免为消歧载入整个 updates.jsonl。
 */
function firstUserMessage(dir, maxBytes = 262144) {
  let fd;
  try {
    fd = fs.openSync(path.join(dir, 'updates.jsonl'), 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      const t = line.trim();
      if (t.length === 0 || t[0] !== '{') continue;
      let rec;
      try {
        rec = JSON.parse(t);
      } catch {
        continue; // 可能是被截断的半行，跳过
      }
      const update = rec && rec.params && rec.params.update;
      if (update && update.sessionUpdate === 'user_message_chunk') {
        const content = update.content;
        return normalizeText(content && typeof content.text === 'string' ? content.text : '');
      }
    }
    return null;
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

/**
 * prompt 指纹命中：会话首条用户消息里能找到任务 prompt 的开头或结尾窗口。
 * 这是比时间戳更强的信号——并行/重试场景下多个会话创建时间只差几十毫秒，
 * 但 prompt 各不相同（实测两个 grok 会话创建时间相差 94ms、delta 无法区分）。
 */
function promptHits(run, sessionUserText) {
  if (typeof sessionUserText !== 'string' || sessionUserText.length === 0) return false;
  const prompt = normalizeText(run.prompt);
  if (prompt.length < 24) return false; // 太短不足以作为指纹
  const window = 60;
  const head = prompt.slice(0, window);
  const tail = prompt.slice(-window);
  return sessionUserText.includes(head) || (tail.length >= 24 && sessionUserText.includes(tail));
}

/**
 * grok 会话目录：`~/.grok/sessions/<url 编码的 cwd>/<session-id>/`，
 * `summary.json.created_at` 是会话创建时间（实测比任务派发晚 0.1–2.8s，5s 窗口足够）。
 * 消歧顺序：prompt 指纹（最强）→ 标题里的 Issue ID token → 时间差。
 */
function findGrokRef(run, { home, toleranceMs }) {
  const ts = taskTimestampMs(run.taskId);
  if (ts === null) return null;
  const root = path.join(home, '.grok', 'sessions');
  let cwdDirs;
  try {
    cwdDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const cwdEntry of cwdDirs) {
    if (!cwdEntry.isDirectory()) continue;
    const cwdPath = path.join(root, cwdEntry.name);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(cwdPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessionDirs) {
      if (!s.isDirectory()) continue;
      const dir = path.join(cwdPath, s.name);
      const summary = safeJson(path.join(dir, 'summary.json'));
      const createdAt = summary ? Date.parse(summary.created_at) : NaN;
      if (!Number.isFinite(createdAt)) continue;
      const delta = Math.abs(createdAt - ts);
      if (delta <= toleranceMs) candidates.push({ dir, id: s.name, summary, delta });
    }
  }
  if (candidates.length === 0) return null;

  // ① prompt 指纹：唯一命中即高置信度
  for (const c of candidates) c.promptHit = promptHits(run, firstUserMessage(c.dir));
  const byPrompt = candidates.filter((c) => c.promptHit);
  if (byPrompt.length === 1) {
    const only = byPrompt[0];
    return {
      status: 'matched',
      agentType: 'grok',
      ref: { adapter: 'grok', kind: 'dir', path: only.dir, id: only.id },
      matchedBy: 'timestamp+prompt',
      confidence: 'high',
      warnings: [],
    };
  }

  // ② 标题里的 Issue ID token
  const tokens = extractTaskTokens(run);
  if (tokens.length > 0) {
    for (const c of candidates) {
      const hay = [c.summary && c.summary.session_summary, c.summary && c.summary.generated_title, c.summary && c.summary.agent_name]
        .filter((v) => typeof v === 'string')
        .join(' ');
      c.tokenHits = tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    }
    const withHits = candidates.filter((c) => c.tokenHits > 0);
    if (withHits.length > 0) {
      withHits.sort((a, b) => b.tokenHits - a.tokenHits || a.delta - b.delta);
      const top = withHits[0];
      const tied = withHits.length > 1 && withHits[1].tokenHits === top.tokenHits;
      if (!tied) {
        return {
          status: 'matched',
          agentType: 'grok',
          ref: { adapter: 'grok', kind: 'dir', path: top.dir, id: top.id },
          matchedBy: 'timestamp+token',
          confidence: 'high',
          warnings: [],
        };
      }
    }
  }

  // ③ 时间差（多候选且相近时保留歧义警告，不假装确定）
  const { best, confidence, warnings } = pickCandidate(candidates);
  return {
    status: 'matched',
    agentType: 'grok',
    ref: { adapter: 'grok', kind: 'dir', path: best.dir, id: best.id },
    matchedBy: 'timestamp',
    confidence,
    warnings,
  };
}

/* ------------------------------ opencode -------------------------------- */

/**
 * opencode 会话位于 `~/.local/share/opencode/opencode.db` 的 `session` 表
 * （`time_created` 即会话创建时间）。CLI 启动 + 建会话有数秒开销，用 30s 窗口。
 *
 * 消歧顺序与 grok 一致：**prompt 指纹 > 标题命中 > Issue ID token > 时间差**。
 * prompt 取该会话**首条 user message 的 text part**——dim 把任务 prompt 原样交给 CLI，
 * 所以首条 user 文本就是任务 prompt（opencode 把内容放在 `part.data` / `message.data`
 * 的 JSON 列里，role 在 `message.data.role`，没有独立文本列）。
 *
 * 标题**不能**单独作为强信号：自动命名是 opt-in，未开启时 dim 委托的会话标题仍是
 * `New session - <ISO>`；开启后才会被改写成 `[dim] <任务标题>`。因此标题只用于
 * 「唯一命中」的加速判定，指纹与时间差仍是兜底。
 */
function makeOpencodePromptLoader(dbFile) {
  const cache = new Map();
  return (sessionId) => {
    if (cache.has(sessionId)) return cache.get(sessionId);
    let value = null;
    let db;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT p.data AS part_data, m.data AS msg_data
             FROM part p JOIN message m ON m.id = p.message_id
            WHERE p.session_id = ?
            ORDER BY p.time_created ASC
            LIMIT 20`
        )
        .all(sessionId);
      for (const row of rows) {
        const msg = safeJsonText(row.msg_data);
        if (!msg || msg.role !== 'user') continue;
        const part = safeJsonText(row.part_data);
        if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
        if (part.text.trim().length === 0) continue;
        value = part.text;
        break;
      }
    } catch {
      value = null;
    } finally {
      closeQuietly(db);
    }
    cache.set(sessionId, value);
    return value;
  };
}

function findOpencodeRef(run, { home, toleranceMs }) {
  const ts = taskTimestampMs(run.taskId);
  if (ts === null) return null;
  const dbFile = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  const window = Math.max(toleranceMs, OPENCODE_TOLERANCE_MS);

  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
  } catch {
    return null;
  }

  const candidates = [];
  try {
    const rows = db
      .prepare(
        `SELECT id, title, directory, parent_id, time_created FROM session
          WHERE time_created >= ? AND time_created <= ?`
      )
      .all(ts - window, ts + window);
    for (const row of rows) {
      if (typeof row.id !== 'string' || row.id.length === 0) continue;
      const delta = Math.abs(Number(row.time_created) - ts);
      if (!Number.isFinite(delta)) continue;
      candidates.push({ row, id: row.id, delta });
    }
  } catch {
    return null;
  } finally {
    closeQuietly(db);
  }
  if (candidates.length === 0) return null;

  const matched = (c, matchedBy) => ({
    status: 'matched',
    agentType: 'opencode',
    ref: { adapter: 'opencode', kind: 'db', path: dbFile, id: c.id },
    matchedBy,
    confidence: 'high',
    warnings: [],
  });

  // ① prompt 指纹：唯一命中即高置信度（并行委托下创建时间可能只差几十毫秒）
  const loadPrompt = makeOpencodePromptLoader(dbFile);
  for (const c of candidates) c.promptHit = promptHits(run, loadPrompt(c.id));
  const byPrompt = candidates.filter((c) => c.promptHit);
  if (byPrompt.length === 1) return matched(byPrompt[0], 'timestamp+prompt');

  // ② 标题命中：会话标题里含任务标题（自动命名开启过，或用户手改成了任务名）
  const taskTitle = normalizeText(run.taskTitle || '');
  if (taskTitle.length >= 6) {
    for (const c of candidates) {
      const title = normalizeText(typeof c.row.title === 'string' ? c.row.title : '');
      c.titleHit = title.length > 0 && title.includes(taskTitle);
    }
    const byTitle = candidates.filter((c) => c.titleHit);
    if (byTitle.length === 1) return matched(byTitle[0], 'timestamp+title');
  }

  // ③ Issue ID token（如 GUO-63）：与会话标题 / 首条 prompt 交叉比对
  const tokens = extractTaskTokens(run);
  if (tokens.length > 0) {
    for (const c of candidates) {
      const hay = [
        typeof c.row.title === 'string' ? c.row.title : '',
        c.promptHit === false ? '' : String(loadPrompt(c.id) || ''),
      ].join(' ');
      c.tokenHits = tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    }
    const withHits = candidates.filter((c) => c.tokenHits > 0);
    if (withHits.length > 0) {
      withHits.sort((a, b) => b.tokenHits - a.tokenHits || a.delta - b.delta);
      const top = withHits[0];
      const tied = withHits.length > 1 && withHits[1].tokenHits === top.tokenHits;
      if (!tied) return matched(top, 'timestamp+token');
    }
  }

  // ④ 时间差（多候选且相近时保留歧义警告，不假装确定）
  const { best, confidence, warnings } = pickCandidate(candidates);
  return {
    status: 'matched',
    agentType: 'opencode',
    ref: { adapter: 'opencode', kind: 'db', path: dbFile, id: best.id },
    matchedBy: 'timestamp',
    confidence,
    warnings,
  };
}

/* ---------------------------------- pi ---------------------------------- */

/**
 * pi 会话：`~/.pi/agent/sessions/<cwd 编码>/<ISO 时间戳>_<uuid>.jsonl`。
 * 目录名是 cwd 把 `/` 换成 `-` 后首尾各加一个 `-`；**文件名前缀就是会话创建时间**
 * （UTC，如 `2026-09-20T02-54-16-805Z_…`），因此可以用纯字符串解析粗筛候选，
 * 不必为了拿时间戳去逐个打开文件。
 *
 * dim 经 `pi-acp` 委托 pi，会话仍落在同一目录（`pi-acp/session-map.json` 的
 * `sessionFile` 也指向这里），所以与用户手跑的会话格式、位置完全一致。
 *
 * 消歧顺序与 grok / opencode 一致：prompt 指纹 > Issue ID token > 时间差。
 * prompt 取该会话**首条 user message 的文本**（dim 把任务 prompt 原样交给 CLI）。
 */
const PI_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/;

/** 文件名前缀（UTC）→ 毫秒时间戳；不匹配返回 null。 */
function piFileTimestamp(name) {
  const m = PI_FILE_RE.exec(name);
  if (!m) return null;
  const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`);
  return Number.isFinite(ts) ? ts : null;
}

/** 文件名里的会话 uuid（`<时间戳>_<uuid>.jsonl`）。 */
function piFileId(name) {
  const base = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;
  const i = base.indexOf('_');
  return i >= 0 ? base.slice(i + 1) : base;
}

/** pi 的 content（数组 / 字符串）→ 文本；用于取首条 user 消息。 */
function piTextOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const out = [];
  for (const p of content) {
    if (p && typeof p === 'object' && typeof p.text === 'string') out.push(p.text);
  }
  return out.length === 0 ? null : out.join('\n');
}

/** 惰性读取「首条 user message 文本」（prompt 指纹用）；每个文件至多读一次。 */
function makePiPromptLoader() {
  const cache = new Map();
  return (file) => {
    if (cache.has(file)) return cache.get(file);
    let value = null;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(262144);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        const t = line.trim();
        if (t.length === 0 || t[0] !== '{') continue;
        let rec;
        try {
          rec = JSON.parse(t);
        } catch {
          continue; // 可能是被截断的半行
        }
        if (!rec || rec.type !== 'message') continue;
        const msg = rec.message;
        if (!msg || msg.role !== 'user') continue;
        const text = piTextOfContent(msg.content);
        if (typeof text === 'string' && text.trim().length > 0) {
          value = text;
          break;
        }
      }
    } catch {
      value = null;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* best-effort */
        }
      }
    }
    cache.set(file, value);
    return value;
  };
}

function findPiRef(run, { home, toleranceMs }) {
  const ts = taskTimestampMs(run.taskId);
  if (ts === null) return null;
  const root = path.join(home, '.pi', 'agent', 'sessions');
  let cwdDirs;
  try {
    cwdDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const dirEntry of cwdDirs) {
    if (!dirEntry.isDirectory()) continue;
    const dir = path.join(root, dirEntry.name);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const createdAt = piFileTimestamp(name);
      if (createdAt === null) continue;
      const delta = Math.abs(createdAt - ts);
      if (delta > toleranceMs) continue;
      candidates.push({ file: path.join(dir, name), id: piFileId(name), delta });
    }
  }
  if (candidates.length === 0) return null;

  const matched = (c, matchedBy) => ({
    status: 'matched',
    agentType: 'pi',
    ref: { adapter: 'pi', kind: 'file', path: c.file, id: c.id },
    matchedBy,
    confidence: 'high',
    warnings: [],
  });

  // ① prompt 指纹：唯一命中即高置信度
  const loadPrompt = makePiPromptLoader();
  for (const c of candidates) c.promptHit = promptHits(run, loadPrompt(c.file));
  const byPrompt = candidates.filter((c) => c.promptHit);
  if (byPrompt.length === 1) return matched(byPrompt[0], 'timestamp+prompt');

  // ② Issue ID token（如 GUO-63）：与会话首条 prompt 交叉比对
  const tokens = extractTaskTokens(run);
  if (tokens.length > 0) {
    for (const c of candidates) {
      const hay = c.promptHit === false ? '' : String(loadPrompt(c.file) || '');
      c.tokenHits = tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    }
    const withHits = candidates.filter((c) => c.tokenHits > 0);
    if (withHits.length > 0) {
      withHits.sort((a, b) => b.tokenHits - a.tokenHits || a.delta - b.delta);
      const top = withHits[0];
      const tied = withHits.length > 1 && withHits[1].tokenHits === top.tokenHits;
      if (!tied) return matched(top, 'timestamp+token');
    }
  }

  // ③ 时间差（多候选且相近时保留歧义警告，不假装确定）
  const { best, confidence, warnings } = pickCandidate(candidates);
  return {
    status: 'matched',
    agentType: 'pi',
    ref: { adapter: 'pi', kind: 'file', path: best.file, id: best.id },
    matchedBy: 'timestamp',
    confidence,
    warnings,
  };
}

/* ------------------------------ dispatch -------------------------------- */

const FINDERS = {
  kimi: findKimiRef,
  cursor: findCursorRef,
  codex: findCodexRef,
  grok: findGrokRef,
  opencode: findOpencodeRef,
  pi: findPiRef,
};

/**
 * 把任务映射到外部会话引用。
 * @param {object} run 来自 runs 模块的任务记录
 * @param {{home?: string, toleranceMs?: number}} [options]
 */
function mapRunToSession(run, options = {}) {
  const home = options.home || os.homedir();
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
  // 容差按 agent 定制（见 TOLERANCE_MS）；调用方显式传入 toleranceMs 时以调用方为准。
  const effectiveToleranceMs = options.toleranceMs || toleranceFor(agentType);
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

module.exports = { mapRunToSession, taskTimestampMs, DEFAULT_TOLERANCE_MS, TOLERANCE_MS };
