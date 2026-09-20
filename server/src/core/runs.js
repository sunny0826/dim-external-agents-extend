'use strict';

/**
 * runs 模块（T1.1）：只读 dim 的 `background_tasks`，产出归一化的任务记录。
 *
 * 设计约束（T0.2 结论）：
 * - `node:sqlite` + `readOnly: true`，零第三方依赖；
 * - 打开成功不代表文件可用（非数据库/损坏文件延迟到查询才报错）——查询层必须 try/catch；
 * - 列裁剪：先读 PRAGMA 可用列再拼 SELECT，缺列不崩（schema 漂移容错）。
 *
 * 错误一律抛 `RunsError`（code: 'db_unavailable' | 'query_failed'），由上层决定 UI 语义。
 */

const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class RunsError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'RunsError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** dim 主库默认路径。 */
function defaultDbPath(home = os.homedir()) {
  return path.join(home, '.dimcode', 'v2', 'dimcode.sqlite');
}

const WANTED_COLUMNS = [
  'taskId',
  'sessionId',
  'sourceRunId',
  'sourceToolCallId',
  'toolName',
  'label',
  'status',
  'wakePolicy',
  'outputPath',
  'metadata',
  'startedAt',
  'completedAt',
  'completion',
];

function parseJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function availableColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => r.name));
}

/** 行 → 归一化任务记录。缺列安全（undefined → null）。 */
function rowToRun(row) {
  const meta = parseJson(row.metadata);
  const input = meta && typeof meta.subagentInput === 'object' && meta.subagentInput !== null ? meta.subagentInput : null;
  return {
    taskId: row.taskId ?? null,
    sessionId: row.sessionId ?? null,
    status: row.status ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    agentType: (meta && (meta.externalAgentType || meta.subagentType)) || null,
    agentName: (meta && meta.agentName) || null,
    taskTitle: (meta && meta.taskTitle) || null,
    prompt: input && typeof input.prompt === 'string' ? input.prompt : null,
    providerId: (meta && meta.selectedProviderId) || null,
    modelId: (meta && meta.selectedModelId) || null,
    completion: row.completion ?? null,
    metadata: meta,
  };
}

function withDb(dbPath, fn) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new RunsError('db_unavailable', `cannot open dim database at ${dbPath}: ${err.message}`, err);
  }
  try {
    return fn(db);
  } catch (err) {
    if (err instanceof RunsError) throw err;
    throw new RunsError('query_failed', `query failed on ${dbPath}: ${err.message}`, err);
  } finally {
    try {
      db.close();
    } catch {
      /* close best-effort */
    }
  }
}

function selectClause(db) {
  const have = availableColumns(db, 'background_tasks');
  const cols = WANTED_COLUMNS.filter((c) => have.has(c));
  if (cols.length === 0) {
    throw new RunsError('query_failed', 'background_tasks has none of the expected columns');
  }
  return cols.join(', ');
}

/**
 * 列出 agent 任务（toolName='agent'），最新在前。
 * @param {{home?: string, dbPath?: string, limit?: number, agentType?: string, status?: string, sessionId?: string, includeFinished?: boolean, includeFailed?: boolean}} [options]
 *   includeFinished=false 时在 SQL 层排除已完成/已取消（默认 true，保持低层中性）；
 *   includeFailed=false 时把 failed 也排除（默认 true；面板的「显示失败」开关用它）。
 */
function listRuns(options = {}) {
  const {
    home = os.homedir(),
    dbPath = defaultDbPath(home),
    limit = 50,
    agentType,
    status,
    sessionId,
    includeFinished = true,
    includeFailed = true,
  } = options;

  return withDb(dbPath, (db) => {
    const cols = selectClause(db);
    const where = ["toolName = 'agent'"];
    const params = [];
    if (typeof status === 'string' && status.length > 0) {
      where.push('status = ?');
      params.push(status);
    }
    if (typeof agentType === 'string' && agentType.length > 0) {
      // JSON1 过滤（先 json_valid 防御脏数据）；externalAgentType 优先，subagentType 兜底。
      // 注意：过滤必须在 SQL 层完成，否则会被 LIMIT 截断（曾导致老类型任务查不到）。
      where.push(
        "(json_valid(metadata) AND (json_extract(metadata, '$.externalAgentType') = ? OR json_extract(metadata, '$.subagentType') = ?))"
      );
      params.push(agentType, agentType);
    }
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      where.push('sessionId = ?');
      params.push(sessionId);
    }
    if (includeFinished === false) {
      where.push("status NOT IN ('completed', 'cancelled')");
    }
    /* includeFailed=false：把失败的也当「已结束」排除（面板的「显示失败」开关）。
       默认 true —— 保持低层中性，模型侧行为不变。 */
    if (includeFailed === false) {
      where.push("status != 'failed'");
    }
    params.push(limit);
    const rows = db
      .prepare(`SELECT ${cols} FROM background_tasks WHERE ${where.join(' AND ')} ORDER BY startedAt DESC LIMIT ?`)
      .all(...params);
    return rows.map(rowToRun);
  });
}

/** 按 taskId 取单条任务；不存在返回 null。 */
function getRun(taskId, options = {}) {
  const { home = os.homedir(), dbPath = defaultDbPath(home) } = options;
  return withDb(dbPath, (db) => {
    const cols = selectClause(db);
    const row = db.prepare(`SELECT ${cols} FROM background_tasks WHERE taskId = ? LIMIT 1`).get(taskId);
    return row === undefined ? null : rowToRun(row);
  });
}

/**
 * 按 sourceToolCallId 精确匹配任务（PostToolUse 捕获委托用）。
 * 列缺失（schema 漂移）或无匹配时返回 null。
 */
function findRunByToolCallId(toolCallId, options = {}) {
  const { home = os.homedir(), dbPath = defaultDbPath(home) } = options;
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return null;
  return withDb(dbPath, (db) => {
    if (!availableColumns(db, 'background_tasks').has('sourceToolCallId')) return null;
    const cols = selectClause(db);
    const row = db
      .prepare(`SELECT ${cols} FROM background_tasks WHERE sourceToolCallId = ? ORDER BY startedAt DESC LIMIT 1`)
      .get(toolCallId);
    return row === undefined ? null : rowToRun(row);
  });
}

module.exports = { RunsError, defaultDbPath, listRuns, getRun, findRunByToolCallId };
