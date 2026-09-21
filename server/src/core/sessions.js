'use strict';

/**
 * 外部 agent 会话清单与改名（T-N1）。
 *
 * 与 mapping.js 的区别：mapping 是「dim 任务 → 外部会话」（只看 dim 委托过的），
 * 本模块是「外部会话 → 统一名称」（看各 agent 自己存的所有会话，含用户手动开的）。
 *
 * 数据源（全部本机只读，回写仅在你显式 apply 时发生）：
 *   codex    ~/.codex/session_index.jsonl          { id, thread_name, updated_at }
 *   kimi     ~/.kimi-code/session_index.jsonl      { sessionId, sessionDir, workDir } + state.json
 *   cursor   ~/.cursor/acp-sessions/<uuid>/meta.json
 *   grok     ~/.grok/sessions/session_search.sqlite (session_docs) + <ws>/<uuid>/summary.json
 *   opencode ~/.local/share/opencode/opencode.db   (session)
 *   zcode    ~/.zcode/v2/tasks-index.sqlite        (tasks)
 *
 * 命名：dim 任务标题 > 会话自身标题 > 首条 prompt > 兜底（见 session-name.js）。
 * dim 任务关联沿用 mapping.js 已验证的机制：taskId 前 13 位是毫秒时间戳，
 * 与会话创建时间比对（容差按 agent 定制），再用 Issue ID token 消歧。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { listRuns } = require('./runs');
const { taskTimestampMs } = require('./mapping');
const {
  deriveSessionTitle,
  formatDisplayName,
  formatWritebackTitle,
  isGenericTitle,
  looksDelegated,
  normalizeTitle,
} = require('./session-name');

/**
 * 任务↔会话时间容差（ms）：CLI 启动 + 建会话有数秒开销，冷启动可达 5.4s（codex 实测
 * Δ=5.354s / 5.447s），阈值必须覆盖冷启动，否则会话关联不到 dim 任务。
 * 必须与 mapping.js 的 TOLERANCE_MS 保持一致：同一批任务在两处不能得出不同结论。
 */
const TOLERANCE_MS = { kimi: 5000, codex: 20000, cursor: 20000, grok: 30000, opencode: 30000, zcode: 30000 };
const DEFAULT_TOLERANCE_MS = 20000;

const SUPPORTED_AGENTS = ['codex', 'kimi', 'cursor', 'grok', 'opencode', 'zcode'];

/* ------------------------------- 基础工具 -------------------------------- */

function safeJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function safeReadJsonl(file) {
  const out = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* 跳过坏行 */
    }
  }
  return out;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function toMs(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number(value);
  if (Number.isFinite(n) && String(value).trim() !== '') {
    /* 秒级时间戳（grok session_docs.updated_at）→ 毫秒 */
    return n < 1e12 ? Math.round(n * 1000) : n;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** 惰性求值 + 结果缓存（用于只在需要时才读的 prompt）。 */
function memoize(fn) {
  let done = false;
  let value = null;
  return () => {
    if (!done) {
      try {
        value = fn();
      } catch {
        value = null;
      }
      done = true;
    }
    return value;
  };
}

/** 以读写方式打开 sqlite（写入方需自设 busy_timeout，避免和 CLI 抢锁直接报错）。 */
function openWritable(file, timeoutMs = 3000) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${Number(timeoutMs)}`);
  } catch {
    /* 老版本不支持时忽略 */
  }
  return db;
}

/* ------------------------------- codex 专项 ------------------------------ */

const CODEX_ROLLOUT_RE = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const rolloutIndexCache = new Map();

/** 扫描 `~/.codex/sessions/YYYY/MM/DD/`，建立 session_id → rollout 文件路径索引。 */
function codexRolloutIndex(home) {
  const root = path.join(home, '.codex', 'sessions');
  const cached = rolloutIndexCache.get(root);
  if (cached !== undefined) return cached;
  const index = new Map();
  for (const year of safeReaddir(root)) {
    if (!year.isDirectory()) continue;
    const yearDir = path.join(root, year.name);
    for (const month of safeReaddir(yearDir)) {
      if (!month.isDirectory()) continue;
      const monthDir = path.join(yearDir, month.name);
      for (const day of safeReaddir(monthDir)) {
        if (!day.isDirectory()) continue;
        const dayDir = path.join(monthDir, day.name);
        for (const file of safeReaddir(dayDir)) {
          if (!file.isFile()) continue;
          const m = CODEX_ROLLOUT_RE.exec(file.name);
          if (m === null) continue;
          if (!index.has(m[1])) index.set(m[1], path.join(dayDir, file.name));
        }
      }
    }
  }
  rolloutIndexCache.set(root, index);
  return index;
}

/** 只读文件头部若干字节并返回第一行（避免为读 session_meta 载入整个 rollout）。 */
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

/** rollout 首行 session_meta.timestamp → 毫秒（失败返回 null）。 */
function codexSessionStart(file) {
  const first = readFirstLine(file);
  if (!first) return null;
  try {
    const meta = JSON.parse(first);
    const iso = meta && meta.payload && meta.payload.timestamp;
    return iso ? toMs(iso) : null;
  } catch {
    return null;
  }
}

/** rollout 里第一条 user 消息文本（标题泛化时用于兜底命名）。 */
function codexFirstUserMessage(file, maxBytes = 1048576) {
  let text;
  try {
    const st = safeStat(file);
    const size = st === null ? maxBytes : Math.min(st.size, maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, size, 0);
      text = buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    let item;
    try {
      item = JSON.parse(t);
    } catch {
      continue; /* 截断行 */
    }
    const payload = item && item.payload;
    if (!payload || payload.role !== 'user') continue;
    const content = Array.isArray(payload.content) ? payload.content : [];
    for (const part of content) {
      if (part && typeof part.text === 'string' && part.text.trim().length > 0) return part.text;
    }
  }
  return null;
}

/** 原子写文本：同目录 tmp + rename，保留原文件权限位。 */
function atomicWrite(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.ea-extend.${process.pid}.tmp`);
  const st = safeStat(file);
  fs.writeFileSync(tmp, text, 'utf8');
  if (st !== null) {
    try {
      fs.chmodSync(tmp, st.mode & 0o7777);
    } catch {
      /* 权限保留失败不致命 */
    }
  }
  fs.renameSync(tmp, file);
}

function safeReadText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 按「原文件的排版风格」写回 JSON：外部 CLI 自己写的多是压缩单行（kimi state.json、
 * cursor meta.json、grok summary.json），我们就保持单行，别把它改成美化格式——
 * 减少对用户文件的额外改动，diff 也只看得到真正改掉的字段。
 */
function writeJsonLikeOriginal(file, obj) {
  const original = safeReadText(file);
  const minified = original.length > 0 && !original.includes('\n');
  atomicWrite(file, minified ? JSON.stringify(obj) : `${JSON.stringify(obj, null, 2)}\n`);
}

/** 备份目录：`~/.dimcode/ea-extend-backups/<YYYYMMDD-HHmmss>/`。 */
function backupDir(home, now = new Date()) {
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
  return path.join(home, '.dimcode', 'ea-extend-backups', stamp);
}

/** 备份单个文件（文件名扁平化，避免目录穿越）。 */
function backupFile(home, file, now) {
  const dir = backupDir(home, now);
  fs.mkdirSync(dir, { recursive: true });
  const flat = file.replace(/^[/\\]+/, '').replace(/[/\\:]/g, '__');
  const dest = path.join(dir, flat);
  fs.copyFileSync(file, dest);
  return dest;
}

/** 备份一行/一条记录（sqlite 场景）。 */
function backupRecord(home, label, record, now) {
  const dir = backupDir(home, now);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${label}.json`);
  fs.appendFileSync(dest, `${JSON.stringify(record)}\n`, 'utf8');
  return dest;
}

/* ----------------------------- dim 任务索引 ------------------------------ */

const TOKEN_RE = /\b[A-Z]{2,}-\d+\b/g;

function tokensOf(...texts) {
  const out = new Set();
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    const m = text.match(TOKEN_RE);
    if (m) for (const t of m) out.add(t);
  }
  return [...out];
}

/**
 * 构建 dim 委托任务索引（按时间戳排序，供会话侧近邻匹配）。
 * dim 库不可读时返回空索引 + warning（会话清单仍可用）。
 */
function buildTaskIndex({ home, dbPath, limit, warnings }) {
  let runs = [];
  try {
    runs = listRuns({ home, dbPath, limit, includeFinished: true });
  } catch (err) {
    warnings.push({
      code: 'db_unavailable',
      message: `dim 任务库不可读，将只使用会话自身标题：${String((err && err.message) || err)}`,
    });
    return [];
  }
  const index = [];
  for (const run of runs) {
    const ts = taskTimestampMs(run.taskId);
    if (ts === null) continue;
    index.push({
      taskId: run.taskId,
      ts,
      title: run.taskTitle || null,
      agentType: run.agentType || null,
      tokens: tokensOf(run.taskTitle || '', run.prompt || ''),
    });
  }
  index.sort((a, b) => a.ts - b.ts);
  return index;
}

/**
 * 为单个会话找对应的 dim 任务。
 * 先按时间容差筛候选，再用 Issue ID token 消歧（与 mapping.js 同规则）；
 * 候选仍多于一个且无法区分时返回置信度低的结果。
 */
function linkTask(session, taskIndex, toleranceMs) {
  if (taskIndex.length === 0 || session.createdAt === null) return null;
  const candidates = [];
  for (const task of taskIndex) {
    if (session.agentType !== null && task.agentType !== null && task.agentType !== session.agentType) continue;
    const delta = Math.abs(task.ts - session.createdAt);
    if (delta <= toleranceMs) candidates.push({ task, delta });
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    return { taskId: candidates[0].task.taskId, taskTitle: candidates[0].task.title, confidence: 'medium', matchedBy: 'timestamp' };
  }
  candidates.sort((a, b) => a.delta - b.delta);
  const sessionTokens = tokensOf(session.rawTitle || '', session.prompt || '');
  if (sessionTokens.length > 0) {
    const scored = candidates
      .map((c) => ({ ...c, hits: c.task.tokens.reduce((n, t) => n + (sessionTokens.includes(t) ? 1 : 0), 0) }))
      .filter((c) => c.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.delta - b.delta);
    if (scored.length > 0 && (scored.length === 1 || scored[1].hits < scored[0].hits)) {
      return { taskId: scored[0].task.taskId, taskTitle: scored[0].task.title, confidence: 'high', matchedBy: 'timestamp+token' };
    }
  }
  const best = candidates[0];
  const second = candidates[1];
  const ambiguous = second !== undefined && second.delta - best.delta < 1000;
  return {
    taskId: best.task.taskId,
    taskTitle: best.task.title,
    confidence: ambiguous ? 'low' : 'medium',
    matchedBy: 'timestamp',
  };
}

/* ------------------------------ 各 agent 读取 ---------------------------- */

const READERS = {
  codex(home) {
    const indexFile = path.join(home, '.codex', 'session_index.jsonl');
    const entries = safeReadJsonl(indexFile);
    const rollouts = codexRolloutIndex(home);
    const out = [];
    const seen = new Set();
    for (const e of entries) {
      if (!e || typeof e.id !== 'string' || seen.has(e.id)) continue;
      seen.add(e.id);
      const updatedAt = toMs(e.updated_at);
      const rollout = rollouts.get(e.id) || null;
      /* session_index 只有 updated_at（最后活动时间）；创建时间取 rollout 首行 session_meta.timestamp。 */
      const createdAt = rollout === null ? null : codexSessionStart(rollout);
      const record = {
        agentType: 'codex',
        sessionId: e.id,
        path: indexFile,
        rolloutPath: rollout,
        createdAt: createdAt === null ? updatedAt : createdAt,
        createdAtSource: createdAt === null ? 'updated_at' : 'rollout',
        updatedAt,
        cwd: null,
        rawTitle: typeof e.thread_name === 'string' ? e.thread_name : '',
        prompt: null,
        customTitle: false,
        writable: true,
        writebackKind: 'jsonl-index',
      };
      if (rollout !== null) record.promptLoader = memoize(() => codexFirstUserMessage(rollout));
      out.push(record);
    }
    return out;
  },

  kimi(home) {
    const indexFile = path.join(home, '.kimi-code', 'session_index.jsonl');
    const entries = safeReadJsonl(indexFile);
    const byId = new Map();
    for (const e of entries) {
      if (!e || typeof e.sessionDir !== 'string') continue;
      const id = typeof e.sessionId === 'string' ? e.sessionId : path.basename(e.sessionDir);
      const prev = byId.get(id);
      const state = safeJson(path.join(e.sessionDir, 'state.json'));
      const createdAt = state ? toMs(state.createdAt) : null;
      const updatedAt = state ? toMs(state.updatedAt) : null;
      const record = {
        agentType: 'kimi',
        sessionId: id,
        path: e.sessionDir,
        createdAt,
        updatedAt,
        cwd: typeof e.workDir === 'string' ? e.workDir : null,
        rawTitle: state && typeof state.title === 'string' ? state.title : '',
        prompt: state && typeof state.lastPrompt === 'string' ? state.lastPrompt : null,
        customTitle: Boolean(state && state.isCustomTitle),
        archived: Boolean(state && state.archived),
        writable: true,
        writebackKind: 'kimi-state',
      };
      /* 索引可能重复出现同一会话：保留时间较新的一条 */
      if (!prev || (record.updatedAt || 0) >= (prev.updatedAt || 0)) byId.set(id, record);
    }
    return [...byId.values()];
  },

  cursor(home) {
    const root = path.join(home, '.cursor', 'acp-sessions');
    const out = [];
    for (const e of safeReaddir(root)) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const meta = safeJson(path.join(dir, 'meta.json'));
      const st = safeStat(dir);
      const createdAt = st ? st.birthtimeMs || st.ctimeMs : null;
      out.push({
        agentType: 'cursor',
        sessionId: e.name,
        path: dir,
        createdAt,
        updatedAt: st ? st.mtimeMs : null,
        cwd: meta && typeof meta.cwd === 'string' ? meta.cwd : null,
        rawTitle: meta && typeof meta.title === 'string' ? meta.title : '',
        prompt: null,
        customTitle: false,
        writable: true,
        writebackKind: 'cursor-meta',
      });
    }
    return out;
  },

  grok(home) {
    const dbFile = path.join(home, '.grok', 'sessions', 'session_search.sqlite');
    const docs = new Map();
    try {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try {
        for (const row of db.prepare('SELECT session_id, cwd, updated_at, title, content FROM session_docs').all()) {
          docs.set(row.session_id, row);
        }
      } finally {
        db.close();
      }
    } catch {
      /* 索引库不可读时回退到目录扫描 */
    }
    const out = [];
    const seen = new Set();
    const root = path.join(home, '.grok', 'sessions');
    for (const ws of safeReaddir(root)) {
      if (!ws.isDirectory()) continue;
      let cwd = null;
      try {
        cwd = decodeURIComponent(ws.name);
      } catch {
        cwd = ws.name;
      }
      for (const e of safeReaddir(path.join(root, ws.name))) {
        if (!e.isDirectory()) continue;
        const dir = path.join(root, ws.name, e.name);
        const summary = safeJson(path.join(dir, 'summary.json'));
        const doc = docs.get(e.name);
        seen.add(e.name);
        const createdAt = toMs((summary && summary.created_at) || (doc && doc.updated_at));
        out.push({
          agentType: 'grok',
          sessionId: e.name,
          path: dir,
          createdAt,
          updatedAt: toMs((summary && summary.updated_at) || (doc && doc.updated_at)),
          cwd: (summary && summary.info && typeof summary.info.cwd === 'string' && summary.info.cwd) || (doc && typeof doc.cwd === 'string' && doc.cwd) || cwd,
          /* 权威标题在 summary.json（generated_title / session_summary）；
             session_search.sqlite 只是派生搜索索引，会被重建，仅作兜底。 */
          rawTitle:
            (summary && (summary.generated_title || summary.session_summary)) ||
            (doc && typeof doc.title === 'string' && doc.title) ||
            '',
          prompt: (doc && typeof doc.content === 'string' && doc.content) || null,
          customTitle: Boolean(summary && summary.title_is_manual === true),
          writable: true,
          writebackKind: 'grok-summary',
          summaryFile: path.join(dir, 'summary.json'),
        });
      }
    }
    /* 只在搜索索引里、目录已清理的会话也列出来（可读但不可回写） */
    for (const [id, doc] of docs) {
      if (seen.has(id)) continue;
      out.push({
        agentType: 'grok',
        sessionId: id,
        path: null,
        createdAt: toMs(doc.updated_at),
        updatedAt: toMs(doc.updated_at),
        cwd: typeof doc.cwd === 'string' ? doc.cwd : null,
        rawTitle: typeof doc.title === 'string' ? doc.title : '',
        prompt: typeof doc.content === 'string' ? doc.content : null,
        customTitle: false,
        writable: false,
        writebackKind: null,
      });
    }
    return out;
  },

  opencode(home) {
    const dbFile = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
    const out = [];
    let db;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true });
    } catch {
      return out;
    }
    try {
      const rows = db
        .prepare('SELECT id, title, slug, directory, parent_id, time_created, time_updated FROM session')
        .all();
      const firstUserText = makeOpencodeFirstMessageLoader(dbFile);
      for (const row of rows) {
        const record = {
          agentType: 'opencode',
          sessionId: row.id,
          path: dbFile,
          createdAt: toMs(row.time_created),
          updatedAt: toMs(row.time_updated),
          cwd: typeof row.directory === 'string' ? row.directory : null,
          rawTitle: typeof row.title === 'string' ? row.title : '',
          prompt: null,
          customTitle: false,
          subagent: Boolean(row.parent_id),
          writable: true,
          writebackKind: 'opencode-db',
        };
        if (firstUserText !== null) record.promptLoader = memoize(() => firstUserText(row.id));
        out.push(record);
      }
    } catch {
      /* 表结构漂移：返回空清单，由上层给 warning */
    } finally {
      try {
        db.close();
      } catch {
        /* best-effort */
      }
    }
    return out;
  },

  zcode(home) {
    const out = [];
    /* ZCode Protocol CLI 的会话库（dim 委托产生的会话在这里，标题多为 prompt 截断）。 */
    const cliDb = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
    let db;
    try {
      db = new DatabaseSync(cliDb, { readOnly: true });
    } catch {
      db = null;
    }
    if (db !== null) {
      try {
        const rows = db
          .prepare('SELECT id, title, title_source, directory, parent_id, slug, time_created, time_updated, time_archived FROM session')
          .all();
        for (const row of rows) {
          out.push({
            agentType: 'zcode',
            sessionId: row.id,
            path: cliDb,
            store: 'cli',
            createdAt: toMs(row.time_created),
            updatedAt: toMs(row.time_updated),
            cwd: typeof row.directory === 'string' ? row.directory : null,
            rawTitle: typeof row.title === 'string' ? row.title : '',
            prompt: null,
            customTitle: row.title_source === 'custom',
            archived: row.time_archived !== null && row.time_archived !== undefined,
            subagent: Boolean(row.parent_id),
            writable: true,
            writebackKind: 'zcode-cli-db',
          });
        }
      } catch {
        /* 表结构漂移：忽略，继续看桌面库 */
      } finally {
        try {
          db.close();
        } catch {
          /* best-effort */
        }
      }
    }

    /* 桌面 app 的任务索引库（当前为空；有行时一并列出，但不支持回写）。 */
    const appDb = path.join(home, '.zcode', 'v2', 'tasks-index.sqlite');
    let app;
    try {
      app = new DatabaseSync(appDb, { readOnly: true });
    } catch {
      app = null;
    }
    if (app !== null) {
      try {
        const rows = app
          .prepare('SELECT task_id, title, title_overridden, workspace_path, task_status, created_at, updated_at, archived, deleted FROM tasks')
          .all();
        for (const row of rows) {
          if (row.deleted) continue;
          out.push({
            agentType: 'zcode',
            sessionId: row.task_id,
            path: appDb,
            store: 'desktop',
            createdAt: toMs(row.created_at),
            updatedAt: toMs(row.updated_at),
            cwd: typeof row.workspace_path === 'string' ? row.workspace_path : null,
            rawTitle: typeof row.title === 'string' ? row.title : '',
            prompt: null,
            customTitle: Boolean(row.title_overridden),
            archived: Boolean(row.archived),
            status: row.task_status || null,
            writable: false,
            writebackKind: null,
          });
        }
      } catch {
        /* 同上 */
      } finally {
        try {
          app.close();
        } catch {
          /* best-effort */
        }
      }
    }
    return out;
  },
};

/**
 * opencode：取每个会话第一条 user 文本（标题泛化时用于兜底命名）。
 * 注意 opencode 的 `part` / `message` 表把内容放在 `data` JSON 列里（不是 text 列），
 * role 也在 `message.data.role`。
 *
 * loader 是惰性的，调用时列表读取用的连接已经关闭，因此这里**自己开一次只读连接**
 * （每个会话至多一次，由 memoize 兜住）。
 */
function makeOpencodeFirstMessageLoader(dbFile) {
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
           ORDER BY p.time_created ASC LIMIT 20`
        )
        .all(sessionId);
      for (const row of rows) {
        const msg = parseJsonLoose(row.msg_data);
        if (!msg || msg.role !== 'user') continue;
        const part = parseJsonLoose(row.part_data);
        if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
        if (part.text.trim().length === 0) continue;
        value = part.text;
        break;
      }
    } catch {
      value = null;
    } finally {
      if (db !== undefined) {
        try {
          db.close();
        } catch {
          /* best-effort */
        }
      }
    }
    cache.set(sessionId, value);
    return value;
  };
}

/** 宽松解析 JSON 文本列（sqlite 里可能是对象、字符串或损坏值）。 */
function parseJsonLoose(value) {
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

/* ------------------------------ 各 agent 回写 ---------------------------- */

/**
 * 写入器契约：`(ctx, session, title) => { status, reason?, backupPath? }`
 * - `status: 'renamed' | 'skipped' | 'failed'`
 * - 一律先备份，再原子写；写前已存在同名视为 skipped（幂等）。
 */
const WRITERS = {
  codex(ctx, session, title) {
    const file = session.path;
    const entries = safeReadJsonl(file);
    let changed = 0;
    const lines = entries.map((e) => {
      if (e && e.id === session.sessionId) {
        if (e.thread_name === title) return e;
        changed += 1;
        return { ...e, thread_name: title };
      }
      return e;
    });
    if (changed === 0) return { status: 'skipped', reason: '索引中的名称已是目标名称' };
    const backupPath = backupFile(ctx.home, file, ctx.now);
    atomicWrite(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return { status: 'renamed', backupPath };
  },

  kimi(ctx, session, title) {
    const file = path.join(session.path, 'state.json');
    const state = safeJson(file);
    if (state === null) return { status: 'failed', reason: `state.json 不可读：${file}` };
    if (state.title === title && state.isCustomTitle === true) {
      return { status: 'skipped', reason: '会话标题已是目标名称' };
    }
    const backupPath = backupFile(ctx.home, file, ctx.now);
    writeJsonLikeOriginal(file, { ...state, title, isCustomTitle: true });
    return { status: 'renamed', backupPath };
  },

  cursor(ctx, session, title) {
    /* path 是会话目录（meta.json 的父目录）——不要依赖只在内部记录里存在的字段。 */
    const file = path.join(session.path, 'meta.json');
    const meta = safeJson(file);
    if (meta === null) return { status: 'failed', reason: `meta.json 不可读：${file}` };
    if (meta.title === title) return { status: 'skipped', reason: '会话标题已是目标名称' };
    const backupPath = backupFile(ctx.home, file, ctx.now);
    writeJsonLikeOriginal(file, { ...meta, title });
    return { status: 'renamed', backupPath };
  },

  /**
   * grok：权威标题在会话目录的 summary.json（`generated_title` + `session_summary`），
   * 置 `title_is_manual: true` 让自动生成不再覆盖；`session_search.sqlite` 只是派生搜索
   * 索引，写它没用（会被重建）。
   * 注意 grok 自己用 `summary.json.lock` 做锁，建议在 grok 未运行时改名。
   */
  grok(ctx, session, title) {
    const file = session.summaryFile || path.join(session.path, 'summary.json');
    const summary = safeJson(file);
    if (summary === null) return { status: 'failed', reason: `summary.json 不可读：${file}` };
    if (summary.generated_title === title && summary.session_summary === title) {
      return { status: 'skipped', reason: '会话标题已是目标名称' };
    }
    const backupPath = backupFile(ctx.home, file, ctx.now);
    writeJsonLikeOriginal(file, {
      ...summary,
      generated_title: title,
      session_summary: title,
      title_is_manual: true,
    });
    return { status: 'renamed', backupPath };
  },

  /** opencode：`session.title`；其自动命名只覆盖默认标题（`New session - <ISO>`），写非默认名即持久。 */
  opencode(ctx, session, title) {
    const file = session.path;
    let db;
    try {
      db = openWritable(file);
      const row = db.prepare('SELECT id, title FROM session WHERE id = ?').get(session.sessionId);
      if (row === undefined) return { status: 'failed', reason: `会话不存在于 opencode.db：${session.sessionId}` };
      if (row.title === title) return { status: 'skipped', reason: '会话标题已是目标名称' };
      const backupPath = backupRecord(ctx.home, `opencode-session-${session.sessionId}`, row, ctx.now);
      db.prepare('UPDATE session SET title = ? WHERE id = ?').run(title, session.sessionId);
      return { status: 'renamed', backupPath };
    } catch (err) {
      return { status: 'failed', reason: `写入 opencode.db 失败：${String((err && err.message) || err)}` };
    } finally {
      if (db !== undefined) {
        try {
          db.close();
        } catch {
          /* best-effort */
        }
      }
    }
  },

  /** zcode：CLI 会话库的 `session.title`，同时置 `title_source = 'custom'`（schema 允许值）。 */
  zcode(ctx, session, title) {
    if (session.store !== 'cli') {
      return { status: 'unsupported', reason: '桌面 app 的任务索引（tasks-index.sqlite）不是会话表，暂不写入' };
    }
    const file = session.path;
    let db;
    try {
      db = openWritable(file);
      const row = db.prepare('SELECT id, title, title_source FROM session WHERE id = ?').get(session.sessionId);
      if (row === undefined) return { status: 'failed', reason: `会话不存在于 zcode CLI 库：${session.sessionId}` };
      if (row.title === title) return { status: 'skipped', reason: '会话标题已是目标名称' };
      const backupPath = backupRecord(ctx.home, `zcode-session-${session.sessionId}`, row, ctx.now);
      db.prepare('UPDATE session SET title = ?, title_source = ?, time_title_updated = ? WHERE id = ?').run(
        title,
        'custom',
        ctx.now.getTime(),
        session.sessionId
      );
      return { status: 'renamed', backupPath };
    } catch (err) {
      return { status: 'failed', reason: `写入 zcode 会话库失败：${String((err && err.message) || err)}` };
    } finally {
      if (db !== undefined) {
        try {
          db.close();
        } catch {
          /* best-effort */
        }
      }
    }
  },
};

/* --------------------------------- 对外 API ------------------------------ */

/**
 * 列出外部 agent 会话（含统一名称）。
 * @param {{home?: string, dbPath?: string, agentType?: string, limit?: number, since?: string|number,
 *          search?: string, includeArchived?: boolean, taskLimit?: number}} [options]
 */
function listExternalSessions(options = {}) {
  const home = options.home || os.homedir();
  const warnings = [];
  const wanted = normalizeAgentFilter(options.agentType);
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 50;
  const since = toMs(options.since);
  const search = typeof options.search === 'string' && options.search.trim().length > 0 ? options.search.trim().toLowerCase() : null;
  const includeArchived = options.includeArchived === true;
  const taskIndex = buildTaskIndex({ home, dbPath: options.dbPath, limit: options.taskLimit || 500, warnings });

  let raw = [];
  for (const agentType of SUPPORTED_AGENTS) {
    if (wanted.length > 0 && !wanted.includes(agentType)) continue;
    try {
      raw = raw.concat(READERS[agentType](home));
    } catch (err) {
      warnings.push({ code: 'reader_failed', agentType, message: `${agentType} 会话读取失败：${String((err && err.message) || err)}` });
    }
  }

  const sessions = raw.map((session) => {
    const tolerance = TOLERANCE_MS[session.agentType] || DEFAULT_TOLERANCE_MS;
    const dimTask = linkTask(session, taskIndex, tolerance);
    const hasDimTitle = Boolean(dimTask && dimTask.taskTitle);
    const rawIsGeneric = isGenericTitle(session.rawTitle, { cwd: session.cwd, sessionId: session.sessionId });
    /* prompt 只在「需要它来命名」时才读（codex 要开 rollout 文件、opencode 要查表） */
    let prompt = typeof session.prompt === 'string' ? session.prompt : null;
    if (prompt === null && !hasDimTitle && rawIsGeneric && typeof session.promptLoader === 'function') {
      prompt = session.promptLoader();
    }
    const derived = deriveSessionTitle({
      dimTaskTitle: hasDimTitle ? dimTask.taskTitle : undefined,
      rawTitle: session.rawTitle,
      prompt,
      cwd: session.cwd,
      agentType: session.agentType,
      sessionId: session.sessionId,
    });
    return {
      ...session,
      prompt,
      key: `${session.agentType}:${session.sessionId}`,
      title: derived.title,
      titleSource: derived.source,
      genericTitle: rawIsGeneric,
      /* dim 委托（能关联到 dim 任务）还是其它来源（你手动开的 / 别的编排器拉起的）。 */
      source: dimTask ? 'dim' : 'manual',
      delegated: looksDelegated(session.rawTitle) || looksDelegated(prompt),
      displayName: formatDisplayName({ agentType: session.agentType, createdAt: session.createdAt, title: derived.title }),
      dimTask: dimTask ? { taskId: dimTask.taskId, taskTitle: dimTask.taskTitle, confidence: dimTask.confidence, matchedBy: dimTask.matchedBy } : null,
    };
  });

  let filtered = sessions;
  if (!includeArchived) filtered = filtered.filter((s) => s.archived !== true);
  if (since !== null) filtered = filtered.filter((s) => s.createdAt === null || s.createdAt >= since);
  if (search !== null) {
    filtered = filtered.filter((s) =>
      [s.title, s.rawTitle, s.cwd, s.sessionId].some((v) => typeof v === 'string' && v.toLowerCase().includes(search))
    );
  }
  filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const total = filtered.length;
  const page = filtered.slice(0, limit);
  markCollisions(page, filtered);

  return {
    status: page.length === 0 ? 'empty' : 'ok',
    home,
    count: page.length,
    total,
    sessions: page.map(slimSession),
    warnings,
  };
}

/** 标记同 agent 内重名（统一名需要加日期区分），并据此定稿 unifiedName / displayName。 */
function markCollisions(page, all) {
  const counts = new Map();
  for (const s of all) {
    const k = `${s.agentType}\u0000${s.title}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  for (const s of page) {
    s.titleCollision = (counts.get(`${s.agentType}\u0000${s.title}`) || 0) > 1;
    /* 统一名 = 实际写进外部存储的那个名字（来源标记 + 标题 + 重名日期后缀）。 */
    s.unifiedName = formatWritebackTitle({
      title: s.title,
      source: s.source,
      createdAt: s.createdAt,
      collision: s.titleCollision,
    });
    s.displayName = formatDisplayName({ agentType: s.agentType, createdAt: s.createdAt, title: s.unifiedName });
  }
}

function normalizeAgentFilter(agentType) {
  if (Array.isArray(agentType)) return agentType.filter((t) => typeof t === 'string' && t.length > 0);
  if (typeof agentType === 'string' && agentType.trim().length > 0) {
    return agentType
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  return [];
}

/** 给模型/CLI 的精简视图（去掉 prompt 全文等大字段）。 */
function slimSession(s) {
  return {
    key: s.key,
    agentType: s.agentType,
    sessionId: s.sessionId,
    displayName: s.displayName,
    unifiedName: s.unifiedName,
    title: s.title,
    titleSource: s.titleSource,
    rawTitle: s.rawTitle || null,
    genericTitle: s.genericTitle,
    titleCollision: Boolean(s.titleCollision),
    source: s.source,
    delegated: Boolean(s.delegated),
    createdAt: s.createdAt === null ? null : new Date(s.createdAt).toISOString(),
    updatedAt: s.updatedAt === null ? null : new Date(s.updatedAt).toISOString(),
    cwd: s.cwd,
    archived: Boolean(s.archived),
    customTitle: Boolean(s.customTitle),
    store: s.store || null,
    dimTask: s.dimTask,
    writable: Boolean(s.writable),
    path: s.path,
  };
}

/**
 * 改名（默认 dry-run）。只改你显式选中的会话。
 * @param {{home?: string, keys?: string[], sessions?: object[], apply?: boolean, force?: boolean,
 *          titleOverride?: string, now?: Date, agentType?: string, limit?: number}} [options]
 */
function renameExternalSessions(options = {}) {
  const home = options.home || os.homedir();
  const apply = options.apply === true;
  const force = options.force === true;
  const now = options.now || new Date();
  const keys = Array.isArray(options.keys) ? options.keys.filter((k) => typeof k === 'string' && k.length > 0) : null;

  if (keys === null && !Array.isArray(options.sessions)) {
    return {
      status: 'bad_arguments',
      message: '必须显式指定要改名的会话（keys 或 sessions）；本工具不会批量重命名全部会话。',
      results: [],
    };
  }

  const listed = listExternalSessions({ home, dbPath: options.dbPath, agentType: options.agentType, limit: options.limit || 500 });
  const pool = Array.isArray(options.sessions) ? options.sessions : listed.sessions;
  const byKey = new Map(pool.map((s) => [s.key, s]));
  const targets = keys === null ? pool : keys.map((k) => byKey.get(k) || { key: k, missing: true });

  const results = [];
  for (const target of targets) {
    results.push(
      renameOne({
        home,
        now,
        apply,
        force,
        target,
        titleOverride: options.titleOverride,
        sourcePrefix: options.sourcePrefix,
      })
    );
  }
  const renamed = results.filter((r) => r.status === 'renamed').length;
  const planned = results.filter((r) => r.status === 'planned').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const unsupported = results.filter((r) => r.status === 'unsupported').length;
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'not_found').length;

  return {
    status: failed > 0 ? 'partial' : apply ? 'applied' : 'planned',
    dryRun: !apply,
    summary: { total: results.length, renamed, planned, skipped, unsupported, failed },
    backupDir: apply && renamed > 0 ? backupDir(home, now) : null,
    results,
  };
}

function renameOne({ home, now, apply, force, target, titleOverride, sourcePrefix }) {
  if (target.missing) return { key: target.key, status: 'not_found', reason: '会话不存在（key 不匹配任何会话）' };
  if (!target.writable) {
    return {
      key: target.key,
      agentType: target.agentType,
      status: 'unsupported',
      reason: `该会话没有可写目标（${target.agentType} 的这条记录仅作展示）`,
    };
  }
  if (target.customTitle && !force) {
    return {
      key: target.key,
      agentType: target.agentType,
      status: 'skipped',
      reason: '会话标题是你自己设置的（custom title），未加 --force 时不动它',
    };
  }
  const title = normalizeTitle(titleOverride) || formatWritebackTitle({
    title: target.title,
    source: target.source,
    createdAt: target.createdAt,
    collision: Boolean(target.titleCollision),
    prefix: sourcePrefix !== false,
  });
  if (title.length === 0) return { key: target.key, agentType: target.agentType, status: 'skipped', reason: '推导出的名称为空' };

  const base = {
    key: target.key,
    agentType: target.agentType,
    sessionId: target.sessionId,
    previous: target.rawTitle || null,
    next: title,
    path: target.path,
  };
  /* 现状已经等于目标名 → 直接判跳过（预览阶段就能看出来，避免"待改名"却什么都没变） */
  if (normalizeTitle(target.rawTitle) === title) {
    return { ...base, status: 'skipped', reason: '会话名称已是目标名称（无需改动）' };
  }
  const writer = WRITERS[target.agentType];
  if (!writer) {
    return { ...base, status: 'unsupported', reason: `暂不支持写回 ${target.agentType} 的会话标题（先只做展示）` };
  }
  if (!apply) return { ...base, status: 'planned' };

  let ctx = { home, now };
  try {
    const res = writer(ctx, target, title);
    return { ...base, ...res };
  } catch (err) {
    return { ...base, status: 'failed', reason: String((err && err.message) || err) };
  }
}

/**
 * 全自动命名：把「最近 dim 委托产生、且自身标题泛化」的会话改写成统一名。
 *
 * 只做这一件事，边界很硬：
 * - 只处理**能关联到 dim 任务**的会话（`source === 'dim'`），绝不碰你手动开的会话；
 * - 只处理**会话自身标题泛化**的（`Help` / `New session - <ISO>` / 空标题…）；
 *   名称本来就有信息量的不动，你自定义过标题的更不动；
 * - 写前照常备份；任何异常都吞掉（hook 里必须无感）。
 *
 * @param {{home?: string, dbPath?: string, windowMs?: number, max?: number, apply?: boolean,
 *          alreadyNamed?: Set<string>|string[], listLimit?: number, now?: Date}} [options]
 * @returns {{status: string, considered: number, renamed: number, results: object[], named: object[]}}
 */
function autoNameSessions(options = {}) {
  const home = options.home || os.homedir();
  const now = options.now instanceof Date ? options.now : new Date();
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : 2 * 60 * 60 * 1000;
  const max = Number.isFinite(options.max) ? options.max : 5;
  const apply = options.apply !== false;
  const giveUpAfterMs = Number.isFinite(options.giveUpAfterMs) ? options.giveUpAfterMs : 15 * 60 * 1000;
  const alreadyNamed = options.alreadyNamed instanceof Set ? options.alreadyNamed : new Set(options.alreadyNamed || []);

  let runs;
  try {
    runs = listRuns({ home, dbPath: options.dbPath, limit: 100, includeFinished: true });
  } catch (err) {
    return { status: 'db_unavailable', considered: 0, renamed: 0, results: [], named: [] };
  }

  const recent = runs.filter((run) => {
    if (!run.agentType || run.agentType === 'tui_worker' || !run.taskId) return false;
    if (alreadyNamed.has(run.taskId)) return false;
    const ts = taskTimestampMs(run.taskId);
    return ts !== null && now.getTime() - ts <= windowMs && now.getTime() - ts >= 0;
  });
  if (recent.length === 0) return { status: 'ok', considered: 0, renamed: 0, results: [], named: [] };

  /* 只列候选任务涉及的 agent（避免每次 hook 全量扫 6 个 agent） */
  const agents = [...new Set(recent.map((r) => r.agentType))].filter((a) => SUPPORTED_AGENTS.includes(a));
  const listed = [];
  for (const agentType of agents) {
    try {
      const res = listExternalSessions({ home, dbPath: options.dbPath, agentType, limit: options.listLimit || 300 });
      listed.push(...res.sessions);
    } catch {
      /* 单个 agent 读失败不影响其它 */
    }
  }

  const results = [];
  const named = [];
  let renamed = 0;
  for (const run of recent) {
    if (renamed >= max) break;
    const session = listed.find((s) => s.dimTask && s.dimTask.taskId === run.taskId);
    const age = now.getTime() - (taskTimestampMs(run.taskId) || now.getTime());
    if (!session) {
      /* 外部会话还没落盘：窗口内下次再试；太久了就放弃（避免每轮都扫） */
      if (age > giveUpAfterMs) named.push({ taskId: run.taskId, reason: 'session_not_found' });
      continue;
    }
    if (session.customTitle) {
      named.push({ taskId: run.taskId, reason: 'custom_title' });
      continue;
    }
    if (!session.genericTitle) {
      named.push({ taskId: run.taskId, reason: 'title_already_ok' });
      continue;
    }
    const one = renameExternalSessions({
      home,
      dbPath: options.dbPath,
      sessions: [session],
      apply,
    });
    const r = one.results[0] || { status: 'failed' };
    results.push({ taskId: run.taskId, key: session.key, agentType: session.agentType, ...r });
    if (r.status === 'renamed') {
      renamed += 1;
      named.push({ taskId: run.taskId, reason: 'renamed', key: session.key, name: r.next });
    } else if (r.status === 'skipped') {
      named.push({ taskId: run.taskId, reason: 'skipped' });
    } else if (r.status === 'failed' || r.status === 'unsupported') {
      named.push({ taskId: run.taskId, reason: r.status });
    }
  }

  return { status: 'ok', considered: recent.length, renamed, results, named };
}

/**
 * 从备份目录回滚（文件级备份按字节还原；sqlite 行级备份只报告，不自动写库）。
 *
 * 备份文件名是原路径把 `/` 换成 `__` 得到的，因此能反推回原路径。
 * 默认 dry-run，需显式 apply。
 *
 * @param {{home?: string, backupDir?: string, apply?: boolean}} [options]
 */
function restoreBackups(options = {}) {
  const home = options.home || os.homedir();
  const root = path.join(home, '.dimcode', 'ea-extend-backups');
  const apply = options.apply === true;

  let dir = options.backupDir || null;
  if (dir === null) {
    let stamps = [];
    try {
      stamps = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return { status: 'no_backup', message: `没有备份目录：${root}`, results: [] };
    }
    if (stamps.length === 0) return { status: 'no_backup', message: `备份目录为空：${root}`, results: [] };
    dir = path.join(root, stamps[stamps.length - 1]);
  }

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  } catch (err) {
    return { status: 'bad_arguments', message: `备份目录不可读：${String((err && err.message) || err)}`, results: [] };
  }

  const results = [];
  for (const name of files) {
    /* sqlite 行级备份（opencode / zcode）是记录快照，不能按文件还原 */
    if (/^(opencode|zcode)-session-/.test(name)) {
      results.push({
        file: name,
        status: 'manual',
        reason: '这是数据库行级备份（JSON 记录），请按记录里的原值手动改回（或用 rename 指定原名）',
      });
      continue;
    }
    const original = `/${name.replace(/__/g, '/')}`;
    const backupPath = path.join(dir, name);
    let previous = null;
    try {
      previous = JSON.parse(fs.readFileSync(backupPath, 'utf8')).title;
    } catch {
      /* 非 JSON 备份：照样按字节还原 */
    }
    if (!apply) {
      results.push({ file: original, status: 'planned', next: previous });
      continue;
    }
    try {
      const text = fs.readFileSync(backupPath, 'utf8');
      atomicWrite(original, text);
      results.push({ file: original, status: 'restored', next: previous });
    } catch (err) {
      results.push({ file: original, status: 'failed', reason: String((err && err.message) || err) });
    }
  }

  return {
    status: 'ok',
    dryRun: !apply,
    backupDir: dir,
    summary: {
      total: results.length,
      restored: results.filter((r) => r.status === 'restored').length,
      planned: results.filter((r) => r.status === 'planned').length,
      manual: results.filter((r) => r.status === 'manual').length,
      failed: results.filter((r) => r.status === 'failed').length,
    },
    results,
  };
}

module.exports = {
  SUPPORTED_AGENTS,
  TOLERANCE_MS,
  listExternalSessions,
  renameExternalSessions,
  autoNameSessions,
  restoreBackups,
  __internal: { buildTaskIndex, linkTask, READERS, WRITERS, atomicWrite, backupDir },
};
