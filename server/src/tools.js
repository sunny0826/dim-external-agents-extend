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
const { autoNameStatus, writeSettings } = require('./core/settings');
const {
  listExternalSessions,
  renameExternalSessions,
  autoNameSessions,
  restoreBackups,
  SUPPORTED_AGENTS,
} = require('./core/sessions');

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

/** 终态：completed / cancelled / failed 都算「已结束」，不构成「别处还有在跑的任务」。 */
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);

function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function json(payload) {
  return JSON.stringify(payload, null, 1);
}

const ACTIVE_SESSION_FILE = 'ea-extend-active-session.json';

/** hook 写入的「最近活跃 dim 会话」文件路径（与 core/active-session.js 保持一致）。 */
function activeSessionPath() {
  return process.env.EA_EXT_ACTIVE_SESSION || path.join(os.tmpdir(), ACTIVE_SESSION_FILE);
}

/**
 * 读最近活跃的 dim 会话 id；无记录返回 null（此时列表回退为全部）。
 * 兼容两种格式：新 `{ sessions: { <sid>: <at> } }`（取最新的一条）与旧 `{ sessionId }`。
 */
function readActiveSession() {
  try {
    const parsed = JSON.parse(fs.readFileSync(activeSessionPath(), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return null;
    if (parsed.sessions !== null && typeof parsed.sessions === 'object') {
      let best = null;
      let bestAt = -1;
      for (const [sid, at] of Object.entries(parsed.sessions)) {
        const t = Number(at);
        if (typeof sid === 'string' && sid.length > 0 && Number.isFinite(t) && t >= bestAt) {
          best = sid;
          bestAt = t;
        }
      }
      if (best !== null) return best;
    }
    return typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0 ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

/** 给模型看的任务摘要（不含 prompt 全文等大字段）。 */
function summarizeRun(run) {
  return {
    taskId: run.taskId,
    /* 任务属于哪个 dim 会话 —— 回退到「全部会话」时靠它区分来源 */
    sessionId: run.sessionId || null,
    agentType: run.agentType,
    agentName: run.agentName,
    status: run.status,
    taskTitle: run.taskTitle,
    /* dim 派发时选择的模型（如 kimi-code/k3、grok-4.6；codex 常为 'default'）。 */
    model: run.modelId || null,
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

/**
 * T2.1 list_agent_runs
 *
 * 会话解析顺序：显式 `sessionId` → 最近活跃会话（hook 写入）→ 全部。
 * **兜底不静默**：解析到的会话没有任务时，自动回退为全部会话并带上 `scopeFallback`，
 * 避免「别的会话有外部 Agent 在跑，但这里显示空」这种看起来像没被识别的情况。
 */
function listAgentRuns(args = {}, deps = {}) {
  const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const explicitSession = typeof args.sessionId === 'string' && args.sessionId.length > 0 ? args.sessionId : null;
  /* scope=session（默认）：只列「本会话」委托的任务；无法确定会话时回退全部。 */
  const activeSession = explicitSession || (args.scope === 'all' ? null : readActiveSession());
  /* includeFinished 默认 true（模型侧行为不变）；面板传 false 以隐藏已完成/已取消。
     includeFailed 同理：面板的「显示失败」不勾选时传 false，把失败任务也当历史隐藏。 */
  const includeFinished = args.includeFinished !== false;
  const includeFailed = args.includeFailed !== false;
  const query = (sessionId) =>
    listRuns({
      home: deps.home !== undefined ? deps.home : os.homedir(),
      dbPath: deps.dbPath,
      limit,
      agentType: typeof args.agentType === 'string' && args.agentType.length > 0 ? args.agentType : undefined,
      status: typeof args.status === 'string' && args.status.length > 0 ? args.status : undefined,
      /* statuses：面板的状态多选（覆盖全部状态）；空数组 = 不按状态筛选。 */
      statuses: Array.isArray(args.statuses) ? args.statuses : undefined,
      sessionId: sessionId || undefined,
      includeFinished,
      includeFailed,
    });

  try {
    let runs = query(activeSession);
    let scope = activeSession ? 'session' : 'all';
    let scopeFallback = null;
    if (activeSession !== null && runs.length === 0) {
      const all = query(null);
      /* 回退的本意是「别的会话正在跑的任务别被藏起来」，不是把历史倒出来：
         只有别处确实还有活动（非终态）任务时才回退，否则保持本会话空态。 */
      const activeElsewhere = all.filter((r) => !TERMINAL_STATUSES.has(r.status));
      if (activeElsewhere.length > 0) {
        runs = all;
        scope = 'all';
        scopeFallback = {
          from: activeSession,
          activeCount: activeElsewhere.length,
          reason: `本会话没有外部 Agent 任务，但其它 dim 会话有 ${activeElsewhere.length} 个正在运行，已回退为全部会话`,
        };
      }
    }
    return {
      text: json({
        status: runs.length === 0 ? 'empty' : 'ok',
        scope,
        sessionId: activeSession || null,
        ...(scopeFallback === null ? {} : { scopeFallback }),
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
        /* 会话日志里实际使用的模型（各适配器从自身格式提取；未知为 null）。 */
        model: (read.meta && read.meta.model) || null,
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

/**
 * T-N2 list_external_sessions —— 列出外部 agent 自己的会话（含统一格式化名称）。
 *
 * 与 list_agent_runs 的区别：本工具看的是「各 agent 自己存的所有会话」
 * （含用户手动开的），名称统一为 `[codex] 09-19 20:31 · 修复 GUO-108 审查问题`。
 */
function listExternalSessionsTool(args = {}, deps = {}) {
  const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  try {
    const result = listExternalSessions({
      home: deps.home !== undefined ? deps.home : os.homedir(),
      dbPath: deps.dbPath,
      agentType: typeof args.agentType === 'string' ? args.agentType : undefined,
      limit,
      since: args.since,
      search: typeof args.search === 'string' ? args.search : undefined,
      includeArchived: args.includeArchived === true,
    });
    return { text: json(result), isError: false };
  } catch (err) {
    return {
      text: json({
        status: 'scan_failed',
        message: String((err && err.message) || err),
      }),
      isError: true,
    };
  }
}

/**
 * T-N3 rename_external_sessions —— 把统一名称写回各 agent 自己的会话存储。
 *
 * 安全约束（不可绕过）：
 * - 必须显式给出 `keys`（来自 list_external_sessions），不做「全部重命名」；
 * - `apply` 默认 false（只出计划）；真正写入前会先备份到 ~/.dimcode/ea-extend-backups/；
 * - 用户自己设过标题的会话（kimi isCustomTitle / zcode title_overridden）默认跳过，需 force。
 */
function renameExternalSessionsTool(args = {}, deps = {}) {
  const keys = Array.isArray(args.keys)
    ? args.keys.filter((k) => typeof k === 'string' && k.length > 0)
    : typeof args.keys === 'string' && args.keys.length > 0
      ? [args.keys]
      : null;
  if (keys === null || keys.length === 0) {
    return {
      text: json({
        status: 'bad_arguments',
        message: 'keys 必填：先调用 list_external_sessions 拿到要改名的会话 key（本工具不做全量重命名）。',
      }),
      isError: true,
    };
  }
  try {
    const result = renameExternalSessions({
      home: deps.home !== undefined ? deps.home : os.homedir(),
      dbPath: deps.dbPath,
      keys,
      apply: args.apply === true,
      force: args.force === true,
      titleOverride: typeof args.title === 'string' ? args.title : undefined,
      sourcePrefix: args.sourcePrefix,
      agentType: typeof args.agentType === 'string' ? args.agentType : undefined,
    });
    return { text: json(result), isError: false };
  } catch (err) {
    return { text: json({ status: 'rename_failed', message: String((err && err.message) || err) }), isError: true };
  }
}

/**
 * T-N4 auto_name_sessions —— 批量把「dim 委托产生且原标题泛化」的会话改成统一名。
 *
 * 与 hook 的关系：hook 会在委托后自动处理新任务（窗口 2 小时）；本工具用于
 * **显式回填**（更宽的窗口、更大的批量），默认仍然只出计划。
 */
function autoNameSessionsTool(args = {}, deps = {}) {
  const windowMinutes = Number.isFinite(Number(args.windowMinutes)) && Number(args.windowMinutes) > 0 ? Number(args.windowMinutes) : 120;
  const max = clampLimit(args.max, 20, MAX_LIST_LIMIT);
  try {
    const result = autoNameSessions({
      home: deps.home !== undefined ? deps.home : os.homedir(),
      dbPath: deps.dbPath,
      windowMs: windowMinutes * 60 * 1000,
      max,
      apply: args.apply === true,
    });
    return {
      text: json({
        status: result.status,
        ...(result.status === 'db_unavailable' ? { message: 'dim 任务库不可读，无法判断哪些会话由 dim 委托产生' } : null),
        /* 自动命名默认关闭（opt-in）；本工具是显式回填，不受开关影响。 */
        autoName: autoNameStatus(deps.home !== undefined ? deps.home : os.homedir()),
        dryRun: args.apply !== true,
        windowMinutes,
        considered: result.considered,
        renamed: result.renamed,
        results: result.results,
        skippedReasons: (result.named || []).filter((n) => n.reason !== 'renamed').map((n) => ({ taskId: n.taskId, reason: n.reason })),
      }),
      isError: result.status === 'db_unavailable',
    };
  } catch (err) {
    return { text: json({ status: 'auto_name_failed', message: String((err && err.message) || err) }), isError: true };
  }
}

/**
 * T-N6 restore_backups —— 从备份目录回滚改名（文件级按字节还原）。
 * 默认 dry-run；数据库行级备份只报告、不自动写库。
 */
function restoreBackupsTool(args = {}, deps = {}) {
  try {
    const result = restoreBackups({
      home: deps.home !== undefined ? deps.home : os.homedir(),
      backupDir: typeof args.backupDir === 'string' && args.backupDir.length > 0 ? args.backupDir : undefined,
      apply: args.apply === true,
    });
    return { text: json(result), isError: result.status === 'bad_arguments' };
  } catch (err) {
    return { text: json({ status: 'restore_failed', message: String((err && err.message) || err) }), isError: true };
  }
}

/**
 * T-N7 get_settings / set_auto_name —— 自动命名开关（桌面端面板与对话都走这两个工具）。
 *
 * 默认关闭；开启后 hook 才会在 dim 委托后自动改写外部会话名。
 */
function getSettingsTool(args = {}, deps = {}) {
  const home = deps.home !== undefined ? deps.home : os.homedir();
  return {
    text: json({
      status: 'ok',
      autoName: autoNameStatus(home),
      hint:
        'autoName.enabled=false 时 hook 不会自动改名；用 set_auto_name 开启（只影响新委托，不回溯历史）。',
    }),
    isError: false,
  };
}

function setAutoNameTool(args = {}, deps = {}) {
  const home = deps.home !== undefined ? deps.home : os.homedir();
  if (typeof args.enabled !== 'boolean') {
    return {
      text: json({ status: 'bad_arguments', message: 'enabled 必须是布尔值（true 开启 / false 关闭）' }),
      isError: true,
    };
  }
  try {
    writeSettings(home, { autoName: args.enabled });
    return {
      text: json({
        status: 'ok',
        autoName: autoNameStatus(home),
        message: args.enabled
          ? '已开启：dim 之后每次委托外部 Agent，hook 会自动把该会话的泛化标题改成统一名（只动 dim 委托、只动泛化标题、写前备份）。不回溯历史，历史可用 auto_name_sessions 回填。'
          : '已关闭：hook 不再自动改写会话名；手动 rename / autoname 仍可用。',
      }),
      isError: false,
    };
  } catch (err) {
    return { text: json({ status: 'write_failed', message: String((err && err.message) || err) }), isError: true };
  }
}

const TOOL_DEFINITIONS = [
  {
    name: 'list_agent_runs',
    description:
      'List delegated external-agent runs (kimi / cursor / codex / ...) recorded by dim background tasks. Returns taskId, agent type, status, title, the model selected at delegation time and timestamps. Use a returned taskId with read_agent_run to inspect that run\u2019s execution log.',
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
        statuses: {
          type: 'array',
          items: { type: 'string', enum: ['running', 'completed', 'failed', 'cancelled'] },
          description:
            'Filter by several statuses at once (the log panel uses this for its per-status filter). An empty array means no status filter.',
        },
        sessionId: {
          type: 'string',
          description:
            'Target a specific dim session (e.g. sess_1789815375220_xj6kk13bpc). Use this when the user names a session, or when the default session resolution looks wrong.',
        },
        scope: {
          type: 'string',
          enum: ['session', 'all'],
          description:
            'session (default): only runs delegated by the current dim session; all: every historical run. When the resolved session has no runs the result falls back to all and sets scopeFallback.',
        },
        includeFinished: {
          type: 'boolean',
          description:
            'Include finished runs (completed / cancelled). Default true; the log panel passes false to hide them.',
        },
        includeFailed: {
          type: 'boolean',
          description:
            'Include failed runs. Default true; the log panel passes false when its "show failed" filter is off, so failures count as history too.',
        },
      },
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
  {
    name: 'read_agent_run',
    description:
      'Read normalized execution-log events for one delegated external-agent run (tool calls, tool results, assistant text, reasoning, usage, steps...). Paginated: call again with the returned nextCursor to continue. The status field explains business states: ok / running (log may be incomplete; poll with cursor) / degraded (format fell back, see meta.warnings) / no_log / task_not_found. session.model reports the model actually used in the external session (when detectable).',
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
  {
    name: 'list_external_sessions',
    description:
      'List the external agents\u2019 own sessions (codex / kimi / cursor / grok / opencode / zcode) with a unified display name, e.g. "[codex] 09-19 20:31 \u00b7 Fix GUO-108 review issues". Use this when the user complains that external-agent session names are messy or hard to tell apart, or wants to see all sessions of an agent. Naming priority: dim task title > the session\u2019s own title > first prompt line > fallback. Each entry carries key (stable id used by rename_external_sessions), agentType, titleSource, rawTitle, dimTask, customTitle, writable.',
    inputSchema: {
      type: 'object',
      properties: {
        agentType: {
          type: 'string',
          description: `Filter by agent type, comma separated (${SUPPORTED_AGENTS.join(' / ')}). Omit for all.`,
        },
        limit: { type: 'number', description: `Max sessions to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT})` },
        since: { type: 'string', description: 'Only sessions created at/after this time (ISO 8601 or epoch ms)' },
        search: { type: 'string', description: 'Substring filter over title / raw title / cwd / session id' },
        includeArchived: { type: 'boolean', description: 'Include archived sessions (default false)' },
      },
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
  {
    name: 'rename_external_sessions',
    description:
      'Rename external-agent sessions so their own CLI session pickers show the unified name. Writes back into each agent\u2019s own store (codex session_index.jsonl / kimi state.json / cursor meta.json). Requires explicit keys from list_external_sessions \u2014 there is no "rename everything". Dry-run by default: call with apply=false first to preview, then apply=true to write (a backup is taken first). Sessions whose title the user set manually are skipped unless force=true.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Session keys from list_external_sessions, e.g. ["codex:01a0b7ee-...", "kimi:session_a2ec..."]',
        },
        apply: { type: 'boolean', description: 'false (default) = preview only; true = actually write the new titles' },
        title: { type: 'string', description: 'Optional explicit title to write (defaults to the unified derived name)' },
        force: { type: 'boolean', description: 'Also rename sessions whose title the user set manually (default false)' },
        sourcePrefix: {
          type: 'boolean',
          description: 'Prefix the unified name with its source: [dim] for dim-delegated sessions, [手动] otherwise (default true)',
        },
        agentType: { type: 'string', description: 'Optional agent filter used when resolving keys' },
      },
      required: ['keys'],
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
  {
    name: 'auto_name_sessions',
    description:
      'Backfill the unified name for sessions that dim delegated and whose own title is generic (Help / "New session - <ISO>" / empty). New delegations are already handled automatically by a hook, so use this only to backfill a wider window. Never touches sessions you created yourself, and never touches titles you set manually. Dry-run by default: preview, then call again with apply=true to write.',
    inputSchema: {
      type: 'object',
      properties: {
        windowMinutes: { type: 'number', description: 'Only consider tasks delegated within the last N minutes (default 120)' },
        max: { type: 'number', description: `Max sessions to rename in one call (default 20, max ${MAX_LIST_LIMIT})` },
        apply: { type: 'boolean', description: 'false (default) = preview only; true = write (backup first)' },
      },
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
  {
    name: 'restore_backups',
    description:
      'Roll back session renames from a backup directory (~/.dimcode/ea-extend-backups/<timestamp>/, newest by default). File-based backups (codex / kimi / cursor / grok) are restored byte-for-byte; database row backups (opencode / zcode) are only reported, since they are record snapshots rather than files. Dry-run by default.',
    inputSchema: {
      type: 'object',
      properties: {
        backupDir: { type: 'string', description: 'Backup directory to restore from (defaults to the newest one)' },
        apply: { type: 'boolean', description: 'false (default) = preview only; true = actually restore' },
      },
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
  {
    name: 'get_settings',
    description:
      'Read plugin settings, currently the automatic session-naming switch (autoName): whether it is enabled, whether that comes from the env var / config file / default, and the config file path. Automatic naming is off by default.',
    inputSchema: { type: 'object', properties: {} },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
  {
    name: 'set_auto_name',
    description:
      'Turn automatic session naming on or off (writes ~/.dimcode/ea-extend-config.json). When on, a hook renames the external session right after dim delegates \u2014 only sessions traced to a dim task, only generic titles, only the last 2 hours, backup before write. Off by default. Affects new delegations only; use auto_name_sessions to backfill history.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true = enable automatic naming, false = disable' },
      },
      required: ['enabled'],
    },
    _meta: { ui: { visibility: ['model', 'app'] } },
  },
];

const DATA_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((t) => t.name));

/** 分发数据工具调用；非数据工具返回 null（由 server 层走自己的分支）。 */
function callDataTool(name, args, deps) {
  if (name === 'list_agent_runs') return listAgentRuns(args || {}, deps);
  if (name === 'read_agent_run') return readAgentRun(args || {}, deps);
  if (name === 'list_external_sessions') return listExternalSessionsTool(args || {}, deps);
  if (name === 'rename_external_sessions') return renameExternalSessionsTool(args || {}, deps);
  if (name === 'auto_name_sessions') return autoNameSessionsTool(args || {}, deps);
  if (name === 'restore_backups') return restoreBackupsTool(args || {}, deps);
  if (name === 'get_settings') return getSettingsTool(args || {}, deps);
  if (name === 'set_auto_name') return setAutoNameTool(args || {}, deps);
  return null;
}

module.exports = {
  TOOL_DEFINITIONS,
  DATA_TOOL_NAMES,
  callDataTool,
  listAgentRuns,
  readAgentRun,
  listExternalSessionsTool,
  renameExternalSessionsTool,
  autoNameSessionsTool,
  restoreBackupsTool,
  getSettingsTool,
  setAutoNameTool,
};
