'use strict';

/**
 * MCP 数据工具实现（T2.1 / T2.2 / T2.3）。
 *
 * - list_agent_runs：列出外部 agent 委托任务（来源：dim background_tasks）
 * - read_agent_run：读取指定任务的归一化执行日志事件（游标分页）
 *
 * 错误/空态语义（T2.3）——统一返回 JSON 文本，`status` 字段承载业务状态：
 *   ok / empty        正常（empty = 列表无结果）
 *   task_not_found    任务不存在
 *   no_log            任务存在但没有可读的外部会话日志（reason 说明原因）
 *   degraded          读取成功但存在格式降级（meta.degraded + warnings）
 *   running           任务仍在运行（日志可能不完整，可用同一 cursor 增量轮询）
 *   db_unavailable    系统故障（dim 数据库不可读）→ 对应 isError: true
 *
 * 返回 `{ text, isError }`，由 MCP server 层直接映射为 tools/call 响应。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listRuns, getRun } = require('./core/runs');
const { mapRunToSession } = require('./core/mapping');
const { readSessionEvents } = require('./core/adapters');

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function json(payload) {
  return JSON.stringify(payload, null, 1);
}

const ACTIVE_SESSION_FILE = 'ea-extend-active-session.json';

/** hook 写入的「当前活跃 dim 会话」文件路径（与 hooks/active-session.js 保持一致）。 */
function activeSessionPath() {
  return process.env.EA_EXT_ACTIVE_SESSION || path.join(os.tmpdir(), ACTIVE_SESSION_FILE);
}

/** 读当前活跃 dim 会话 id；无记录返回 null（此时列表回退为全部）。 */
function readActiveSession() {
  try {
    const parsed = JSON.parse(fs.readFileSync(activeSessionPath(), 'utf8'));
    return typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0 ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

/** 给模型看的任务摘要（不含 prompt 全文等大字段）。 */
function summarizeRun(run) {
  return {
    taskId: run.taskId,
    agentType: run.agentType,
    agentName: run.agentName,
    status: run.status,
    taskTitle: run.taskTitle,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    promptHead: run.prompt ? run.prompt.slice(0, 200) : null,
  };
}

/** 事件瘦身：去掉 raw（体积最大、调试用途）。 */
function slimEvent(ev) {
  const { raw, ...rest } = ev;
  return rest;
}

/** T2.1 list_agent_runs */
function listAgentRuns(args = {}, deps = {}) {
  const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  /* scope=session（默认）：只列「当前活跃 dim 会话」委托的任务；无法确定会话时回退全部。 */
  const activeSession = args.scope === 'all' ? null : readActiveSession();
  const effectiveScope = activeSession ? 'session' : 'all';
  /* includeFinished 默认 true（模型侧行为不变）；面板传 false 以隐藏已完成/已取消。 */
  const includeFinished = args.includeFinished !== false;
  try {
    const runs = listRuns({
      home: deps.home !== undefined ? deps.home : os.homedir(),
      dbPath: deps.dbPath,
      limit,
      agentType: typeof args.agentType === 'string' && args.agentType.length > 0 ? args.agentType : undefined,
      status: typeof args.status === 'string' && args.status.length > 0 ? args.status : undefined,
      sessionId: activeSession || undefined,
      includeFinished,
    });
    return {
      text: json({
        status: runs.length === 0 ? 'empty' : 'ok',
        scope: effectiveScope,
        sessionId: activeSession || null,
        count: runs.length,
        runs: runs.map(summarizeRun),
      }),
      isError: false,
    };
  } catch (err) {
    return {
      text: json({
        status: 'db_unavailable',
        code: err && err.code ? err.code : undefined,
        message: String((err && err.message) || err),
      }),
      isError: true,
    };
  }
}

/** T2.2 read_agent_run */
function readAgentRun(args = {}, deps = {}) {
  const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
  if (taskId.length === 0) {
    return { text: json({ status: 'bad_arguments', message: 'taskId 必填' }), isError: true };
  }
  const limit = clampLimit(args.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const parsedCursor = Number.parseInt(args.cursor === undefined || args.cursor === null ? '0' : String(args.cursor), 10);
  const start = Number.isFinite(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  const home = deps.home !== undefined ? deps.home : os.homedir();

  let run;
  try {
    run = getRun(taskId, { home, dbPath: deps.dbPath });
  } catch (err) {
    return {
      text: json({
        status: 'db_unavailable',
        code: err && err.code ? err.code : undefined,
        message: String((err && err.message) || err),
      }),
      isError: true,
    };
  }
  if (!run) {
    return { text: json({ status: 'task_not_found', taskId }), isError: false };
  }

  let mapping;
  try {
    mapping = mapRunToSession(run, { home });
  } catch (err) {
    mapping = { status: 'unmatched', ref: null, warnings: [{ code: 'mapping_failed', message: String((err && err.message) || err) }] };
  }
  if (mapping.status !== 'matched') {
    const reason =
      mapping.status === 'unsupported'
        ? (mapping.warnings[0] && mapping.warnings[0].message) || '不支持的 agent 类型'
        : '未找到对应的外部会话（可能已被清理）';
    return {
      text: json({
        status: 'no_log',
        taskId,
        agentType: run.agentType,
        reason,
        task: summarizeRun(run),
      }),
      isError: false,
    };
  }

  let read;
  try {
    const reader = deps.readSessionEvents || readSessionEvents;
    read = reader(mapping.ref, { cursor: null });
  } catch (err) {
    return {
      text: json({ status: 'no_log', taskId, reason: `读取会话日志失败：${String((err && err.message) || err)}` }),
      isError: false,
    };
  }

  const events = Array.isArray(read.events) ? read.events : [];
  const page = events.slice(start, start + limit).map(slimEvent);
  const consumed = start + page.length;
  const nextCursor = consumed < events.length ? String(consumed) : null;
  const baseStatus = read.meta && read.meta.degraded ? 'degraded' : run.status === 'running' ? 'running' : 'ok';

  return {
    text: json({
      status: baseStatus,
      taskId,
      task: summarizeRun(run),
      session: {
        adapter: mapping.ref.adapter,
        matchedBy: mapping.matchedBy,
        confidence: mapping.confidence,
      },
      total: events.length,
      cursor: String(start),
      nextCursor,
      hint:
        baseStatus === 'running'
          ? '任务仍在运行，日志可能不完整；稍后用上次的 nextCursor 再调用本工具可读取增量事件。'
          : undefined,
      events: page,
      meta: read.meta,
    }),
    isError: false,
  };
}

const TOOL_DEFINITIONS = [
  {
    name: 'list_agent_runs',
    description:
      'List delegated external-agent runs (kimi / cursor / codex / ...) recorded by dim background tasks. Returns taskId, agent type, status, title and timestamps. Use a returned taskId with read_agent_run to inspect that run\u2019s execution log.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `Max runs to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT})` },
        agentType: { type: 'string', description: 'Filter by external agent type, e.g. kimi, cursor, codex' },
        status: {
          type: 'string',
          enum: ['running', 'completed', 'failed', 'cancelled'],
          description: 'Filter by task status',
        },
        scope: {
          type: 'string',
          enum: ['session', 'all'],
          description:
            'session (default): only runs delegated by the current dim session; all: every historical run.',
        },
        includeFinished: {
          type: 'boolean',
          description:
            'Include finished runs (completed / cancelled). Default true; the log panel passes false to hide them.',
        },
      },
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
  {
    name: 'read_agent_run',
    description:
      'Read normalized execution-log events for one delegated external-agent run (tool calls, tool results, assistant text, reasoning, usage, steps...). Paginated: call again with the returned nextCursor to continue. The status field explains business states: ok / running (log may be incomplete; poll with cursor) / degraded (format fell back, see meta.warnings) / no_log / task_not_found.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id from list_agent_runs, e.g. task_1789559570749_9kvwq6' },
        cursor: { type: 'string', description: 'Opaque pagination cursor from a previous call (default "0")' },
        limit: { type: 'number', description: `Max events per page (default ${DEFAULT_PAGE_LIMIT}, max ${MAX_PAGE_LIMIT})` },
      },
      required: ['taskId'],
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
];

const DATA_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.name));

/** 分发数据工具调用；非数据工具返回 null（由 server 层走自己的分支）。 */
function callDataTool(name, args, deps) {
  if (name === 'list_agent_runs') return listAgentRuns(args || {}, deps);
  if (name === 'read_agent_run') return readAgentRun(args || {}, deps);
  return null;
}

module.exports = { TOOL_DEFINITIONS, DATA_TOOL_NAMES, callDataTool, listAgentRuns, readAgentRun };
