'use strict';
/**
 * hooks 测试：
 * - context.js（UserPromptSubmit）：运行中状态注入、完成/失败补报、本会话过滤、零打扰、DB 静默
 * - on-post-tool.js（PostToolUse）：create_external 捕获（精确 / 兜底 / 静默）
 * - on-stop.js（Stop）：delegated 优先提醒、本会话过滤、去重、防循环、DB 兜底
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const SCRIPT = path.join(__dirname, '..', '..', 'hooks', 'context.js');
const STOP_SCRIPT = path.join(__dirname, '..', '..', 'hooks', 'on-stop.js');
const POST_SCRIPT = path.join(__dirname, '..', '..', 'hooks', 'on-post-tool.js');

function makeDb(taskRows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-hook-'));
  const dbPath = path.join(dir, 'dimcode.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE background_tasks (
    taskId TEXT PRIMARY KEY, sessionId TEXT, sourceRunId TEXT, sourceToolCallId TEXT,
    toolName TEXT, label TEXT, status TEXT, wakePolicy TEXT, outputPath TEXT,
    metadata TEXT, startedAt INTEGER, completedAt INTEGER, completion TEXT, notificationDeliveredAt INTEGER
  )`);
  const stmt = db.prepare(
    'INSERT INTO background_tasks (taskId, sessionId, sourceToolCallId, toolName, status, metadata, startedAt, completedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const r of taskRows) {
    stmt.run(
      r.taskId,
      r.sessionId === undefined ? null : r.sessionId,
      r.sourceToolCallId === undefined ? null : r.sourceToolCallId,
      r.toolName || 'agent',
      r.status,
      r.metadata === undefined ? null : JSON.stringify(r.metadata),
      r.startedAt === undefined ? Date.now() : r.startedAt,
      r.completedAt === undefined ? null : r.completedAt
    );
  }
  db.close();
  return dbPath;
}

function tmpPath(prefix, file) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), file);
}

function runHook(dbPath, opts) {
  const o = opts || {};
  return execFileSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      DIM_EXT_HOOK_DB: dbPath,
      HOME: o.home || '/nonexistent-home-for-hook-test',
      EA_EXT_FINISHED_STATE: o.finishedStatePath || tmpPath('ea-fin-', 'finished.json'),
      EA_EXT_ACTIVE_SESSION: o.activeSessionPath || path.join(os.tmpdir(), 'ea-test-active-session.json'),
      /* 自动命名：隔离状态文件并关掉节流，避免测试互相干扰 */
      EA_EXT_AUTONAME_STATE: o.autonameStatePath || tmpPath('ea-autoname-', 'auto-named.json'),
      EA_EXT_AUTONAME_THROTTLE_MS: '0',
      ...(o.env || {}),
    },
    ...(o.stdin !== undefined ? { input: o.stdin } : {}),
    encoding: 'utf8',
  });
}

// ===== context.js（UserPromptSubmit）=====

test('hook：有运行中外部任务 → 注入状态行（含 taskId 与展示提示）', () => {
  const dbPath = makeDb([
    {
      taskId: 'task_1789629813131_hefp25',
      status: 'running',
      metadata: { externalAgentType: 'cursor', taskTitle: 'M3-06 复验：完整流程与退出条件' },
      startedAt: Date.now() - 4 * 60 * 1000,
    },
  ]);
  const out = runHook(dbPath);
  assert.ok(out.includes('[外部 Agent 状态]'), '应输出状态头');
  assert.ok(out.includes('1 个外部 Agent 任务运行中'), '应包含数量');
  assert.ok(out.includes('cursor'), '应包含 agent 类型');
  assert.ok(out.includes('task_1789629813131_hefp25'), '应包含 taskId');
  assert.ok(out.includes('已运行 4 分钟'), '应包含运行时长');
  assert.ok(out.includes('open_agent_run_log'), '应包含查看日志指引');
});

test('hook：仅 completed 且无完成时间 → 无输出（零打扰）', () => {
  const dbPath = makeDb([
    { taskId: 'task_done_1', status: 'completed', metadata: { externalAgentType: 'kimi', taskTitle: '完成的任务' } },
  ]);
  assert.equal(runHook(dbPath), '');
});

test('hook：tui_worker 不计入', () => {
  const dbPath = makeDb([
    { taskId: 'task_tui_1', status: 'running', metadata: { subagentType: 'tui_worker', taskTitle: '内部 worker' } },
  ]);
  assert.equal(runHook(dbPath), '');
});

test('hook：DB 不可用 → 静默且退出码 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-hook-missing-'));
  const out = runHook(path.join(dir, 'no-such.sqlite'));
  assert.equal(out, '');
});

test('hook：multi 任务 → 数量与多行条目', () => {
  const dbPath = makeDb([
    { taskId: 'task_m1', status: 'running', metadata: { externalAgentType: 'kimi', taskTitle: '任务一' }, startedAt: Date.now() - 61 * 60 * 1000 },
    { taskId: 'task_m2', status: 'running', metadata: { subagentType: 'codex', taskTitle: '任务二' } },
  ]);
  const out = runHook(dbPath);
  assert.ok(out.includes('2 个外部 Agent 任务运行中'));
  assert.ok(out.includes('task_m1') && out.includes('task_m2'));
  assert.ok(out.includes('已运行 1 小时 1 分钟'), '小时级时长格式');
});

test('hook：完成补报 —— 窗口内 completed 注入「已完成」', () => {
  const dbPath = makeDb([
    {
      taskId: 'task_fin_1',
      status: 'completed',
      metadata: { externalAgentType: 'kimi', taskTitle: '完成的任务' },
      startedAt: Date.now() - 60 * 60 * 1000,
      completedAt: Date.now() - 30 * 60 * 1000,
    },
  ]);
  const out = runHook(dbPath);
  assert.ok(out.includes('[外部 Agent 完成]'), '应输出完成补报头');
  assert.ok(out.includes('task_fin_1'), '应包含 taskId');
  assert.ok(out.includes('已完成'), '应带已完成标签');
});

test('hook：完成补报 —— failed 显示「失败」', () => {
  const dbPath = makeDb([
    {
      taskId: 'task_fin_fail',
      status: 'failed',
      metadata: { externalAgentType: 'cursor', taskTitle: '失败的任务' },
      startedAt: Date.now() - 60 * 60 * 1000,
      completedAt: Date.now() - 10 * 60 * 1000,
    },
  ]);
  const out = runHook(dbPath);
  assert.ok(out.includes('[外部 Agent 完成]'));
  assert.ok(out.includes('task_fin_fail'));
  assert.ok(out.includes('失败'));
});

test('hook：完成补报去重 —— 同一状态文件第二次不重复', () => {
  const dbPath = makeDb([
    {
      taskId: 'task_fin_dedup',
      status: 'completed',
      metadata: { externalAgentType: 'kimi', taskTitle: '去重任务' },
      completedAt: Date.now() - 10 * 60 * 1000,
    },
  ]);
  const finishedStatePath = tmpPath('ea-fin-dedup-', 'finished.json');
  assert.ok(runHook(dbPath, { finishedStatePath }).includes('task_fin_dedup'), '首次应补报');
  assert.equal(runHook(dbPath, { finishedStatePath }), '', '再次应无输出');
});

test('hook：完成补报 —— 超窗（4 小时前结束）不补报', () => {
  const dbPath = makeDb([
    {
      taskId: 'task_fin_old',
      status: 'completed',
      metadata: { externalAgentType: 'kimi', taskTitle: '很久前完成' },
      completedAt: Date.now() - 5 * 60 * 60 * 1000,
    },
  ]);
  assert.equal(runHook(dbPath), '');
});

test('hook：完成补报 —— 超过 3 条时只列出 3 条并提示未列出数量', () => {
  const rows = [];
  for (let i = 0; i < 5; i += 1) {
    rows.push({
      taskId: `task_many_${i}`,
      status: 'completed',
      metadata: { externalAgentType: 'kimi', taskTitle: `任务${i}` },
      completedAt: Date.now() - (i + 1) * 60 * 1000,
    });
  }
  const out = runHook(makeDb(rows));
  assert.ok(out.includes('另有 2 个未列出'), '应提示未列出数量');
  const listed = out.split('\n').filter((l) => l.startsWith('- ') && l.includes('task_many_'));
  assert.equal(listed.length, 3, '最多列出 3 条');
});

test('hook：本会话过滤 —— 其他会话的任务不注入', () => {
  const dbPath = makeDb([
    {
      taskId: 'task_other_sess',
      sessionId: 'sess_B',
      status: 'running',
      metadata: { externalAgentType: 'kimi', taskTitle: '别会话的任务' },
      startedAt: Date.now(),
    },
    {
      taskId: 'task_other_done',
      sessionId: 'sess_B',
      status: 'completed',
      metadata: { externalAgentType: 'kimi', taskTitle: '别会话完成的任务' },
      completedAt: Date.now() - 5 * 60 * 1000,
    },
  ]);
  const out = runHook(dbPath, { stdin: JSON.stringify({ session_id: 'sess_A' }) });
  assert.equal(out, '', '其他会话的任务不应注入');
});

test('hook：本会话匹配 → 正常注入（snake_case stdin）', () => {
  const dbPath = makeDb([
    {
      taskId: 'task_mine_sess',
      sessionId: 'sess_A',
      status: 'running',
      metadata: { externalAgentType: 'kimi', taskTitle: '本会话任务' },
      startedAt: Date.now(),
    },
  ]);
  const out = runHook(dbPath, { stdin: JSON.stringify({ session_id: 'sess_A' }) });
  assert.ok(out.includes('task_mine_sess'));
});

// ===== on-stop.js（Stop hook）=====

function makeStatePath() {
  return tmpPath('ea-stop-state-', 'state.json');
}

function runStop(dbPath, stdinObj, statePath, opts) {
  const o = opts || {};
  try {
    const stdout = execFileSync(process.execPath, [STOP_SCRIPT], {
      env: {
        ...process.env,
        DIM_EXT_HOOK_DB: dbPath,
        EA_EXT_HOOK_STATE: statePath,
        EA_EXT_DELEGATED_STATE: o.delegatedStatePath || tmpPath('ea-deleg-', 'delegated.json'),
        HOME: o.home || '/nonexistent-home-for-hook-test',
        EA_EXT_ACTIVE_SESSION: o.activeSessionPath || path.join(os.tmpdir(), 'ea-test-active-session.json'),
        EA_EXT_AUTONAME_STATE: o.autonameStatePath || tmpPath('ea-autoname-', 'auto-named.json'),
        EA_EXT_AUTONAME_THROTTLE_MS: '0',
        ...(o.env || {}),
      },
      input: JSON.stringify(stdinObj || {}),
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('on-stop：新启动任务（DB 兜底）→ block（exit 2）并提示打开日志面板', () => {
  const dbPath = makeDb([
    {
      taskId: 'task_new1',
      status: 'running',
      metadata: { externalAgentType: 'kimi', taskTitle: '新启动任务' },
      startedAt: Date.now() - 30 * 1000,
    },
  ]);
  const r = runStop(dbPath, { stop_hook_active: false }, makeStatePath());
  assert.equal(r.code, 2, '应阻止结束并让模型补一轮');
  assert.ok(r.stderr.includes('task_new1'), 'stderr 应包含 taskId');
  assert.ok(r.stderr.includes('open_agent_run_log'), 'stderr 应指引打开日志面板');
});

test('on-stop：同一任务第二次 → 放行（去重）', () => {
  const dbPath = makeDb([
    { taskId: 'task_dedup', status: 'running', metadata: { externalAgentType: 'cursor', taskTitle: '去重任务' }, startedAt: Date.now() },
  ]);
  const statePath = makeStatePath();
  assert.equal(runStop(dbPath, {}, statePath).code, 2, '首次应 block');
  assert.equal(runStop(dbPath, {}, statePath).code, 0, '再次应放行（不重复打扰）');
});

test('on-stop：stop_hook_active=true → 放行（防循环）', () => {
  const dbPath = makeDb([
    { taskId: 'task_loop', status: 'running', metadata: { externalAgentType: 'kimi', taskTitle: '循环防护' }, startedAt: Date.now() },
  ]);
  assert.equal(runStop(dbPath, { stop_hook_active: true }, makeStatePath()).code, 0);
});

test('on-stop：超窗旧任务 → 放行', () => {
  const dbPath = makeDb([
    {
      taskId: 'task_old',
      status: 'running',
      metadata: { externalAgentType: 'codex', taskTitle: '很久前启动' },
      startedAt: Date.now() - 30 * 60 * 1000,
    },
  ]);
  assert.equal(runStop(dbPath, {}, makeStatePath()).code, 0);
});

test('on-stop：DB 不可用 → 放行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-stop-missing-'));
  assert.equal(runStop(path.join(dir, 'no-such.sqlite'), {}, makeStatePath()).code, 0);
});

test('on-stop：delegated 条目（本会话）→ block，不依赖 DB 中的 running 状态', () => {
  const dbPath = makeDb([]); // DB 里没有任何 running 任务
  const delegatedPath = tmpPath('ea-deleg-cap-', 'delegated.json');
  fs.writeFileSync(
    delegatedPath,
    JSON.stringify({
      pending: [
        { taskId: 'task_cap_x', agentType: 'kimi', taskTitle: '捕获的新任务', sessionId: 'sess_A', capturedAt: Date.now() },
      ],
    })
  );
  const r = runStop(dbPath, { session_id: 'sess_A' }, makeStatePath(), { delegatedStatePath: delegatedPath });
  assert.equal(r.code, 2, '应基于捕获记录 block');
  assert.ok(r.stderr.includes('task_cap_x'));
});

test('on-stop：delegated 条目属于其他会话 → 放行（防串场）', () => {
  const dbPath = makeDb([]);
  const delegatedPath = tmpPath('ea-deleg-other-', 'delegated.json');
  fs.writeFileSync(
    delegatedPath,
    JSON.stringify({
      pending: [
        { taskId: 'task_cap_y', agentType: 'kimi', taskTitle: '别会话任务', sessionId: 'sess_B', capturedAt: Date.now() },
      ],
    })
  );
  const r = runStop(dbPath, { session_id: 'sess_A' }, makeStatePath(), { delegatedStatePath: delegatedPath });
  assert.equal(r.code, 0, '不应在错误会话提醒');
});

test('on-stop：delegated 提醒后移除条目（第二次放行）', () => {
  const dbPath = makeDb([]);
  const delegatedPath = tmpPath('ea-deleg-remove-', 'delegated.json');
  fs.writeFileSync(
    delegatedPath,
    JSON.stringify({
      pending: [
        { taskId: 'task_cap_rm', agentType: 'cursor', taskTitle: '提醒后移除', sessionId: 'sess_A', capturedAt: Date.now() },
      ],
    })
  );
  const statePath = makeStatePath();
  assert.equal(
    runStop(dbPath, { session_id: 'sess_A' }, statePath, { delegatedStatePath: delegatedPath }).code,
    2,
    '首次应 block'
  );
  assert.equal(
    runStop(dbPath, { session_id: 'sess_A' }, statePath, { delegatedStatePath: delegatedPath }).code,
    0,
    '再次应放行'
  );
  const state = JSON.parse(fs.readFileSync(delegatedPath, 'utf8'));
  assert.equal(state.pending.length, 0, '提醒后条目应被移除');
});

test('on-stop：delegated 优先于 DB 兜底（不同时提醒）', () => {
  const dbPath = makeDb([
    { taskId: 'task_db_fallback', status: 'running', metadata: { externalAgentType: 'cursor', taskTitle: '兜底任务' }, startedAt: Date.now() },
  ]);
  const delegatedPath = tmpPath('ea-deleg-priority-', 'delegated.json');
  fs.writeFileSync(
    delegatedPath,
    JSON.stringify({
      pending: [
        { taskId: 'task_cap_z', agentType: 'kimi', taskTitle: '捕获任务', sessionId: null, capturedAt: Date.now() },
      ],
    })
  );
  const r = runStop(dbPath, {}, makeStatePath(), { delegatedStatePath: delegatedPath });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes('task_cap_z'));
  assert.ok(!r.stderr.includes('task_db_fallback'), '不应同时提醒 DB 兜底任务');
});

test('on-stop：delegated 过期条目 → 忽略', () => {
  const dbPath = makeDb([]);
  const delegatedPath = tmpPath('ea-deleg-stale-', 'delegated.json');
  fs.writeFileSync(
    delegatedPath,
    JSON.stringify({
      pending: [
        { taskId: 'task_stale', agentType: 'kimi', taskTitle: '过期条目', sessionId: null, capturedAt: Date.now() - 2 * 60 * 60 * 1000 },
      ],
    })
  );
  assert.equal(runStop(dbPath, {}, makeStatePath(), { delegatedStatePath: delegatedPath }).code, 0);
});

// ===== on-post-tool.js（PostToolUse）=====

function runPostTool(dbPath, stdinObj, delegatedPath) {
  try {
    const stdout = execFileSync(process.execPath, [POST_SCRIPT], {
      env: {
        ...process.env,
        DIM_EXT_HOOK_DB: dbPath,
        EA_EXT_DELEGATED_STATE: delegatedPath,
        HOME: '/nonexistent-home-for-hook-test',
        EA_EXT_ACTIVE_SESSION: path.join(os.tmpdir(), 'ea-test-active-session.json'),
      },
      input: JSON.stringify(stdinObj || {}),
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function readDelegated(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('on-post-tool：create_external 精确命中 → 写入 delegated（含 taskId）且无输出', () => {
  const dbPath = makeDb([
    {
      taskId: 'task_cap_1',
      sessionId: 'sess_A',
      sourceToolCallId: 'call_cap_1',
      status: 'running',
      metadata: { externalAgentType: 'kimi', taskTitle: '捕获任务' },
      startedAt: Date.now(),
    },
  ]);
  const delegatedPath = tmpPath('ea-post-cap-', 'delegated.json');
  const r = runPostTool(
    dbPath,
    {
      hook_event_name: 'PostToolUse',
      session_id: 'sess_A',
      tool_name: 'agent',
      tool_use_id: 'call_cap_1',
      tool_input: { action: 'create_external', agentType: 'kimi', taskTitle: '捕获任务' },
    },
    delegatedPath
  );
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '', 'hook 不应输出任何内容（避免被当作注入）');
  const state = readDelegated(delegatedPath);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].taskId, 'task_cap_1');
  assert.equal(state.pending[0].agentType, 'kimi');
  assert.equal(state.pending[0].sessionId, 'sess_A');
});

test('on-post-tool：非 agent 工具 → 不写入', () => {
  const dbPath = makeDb([]);
  const delegatedPath = tmpPath('ea-post-skip-', 'delegated.json');
  const r = runPostTool(
    dbPath,
    { session_id: 'sess_A', tool_name: 'exec', tool_use_id: 'call_x', tool_input: { action: 'create_external' } },
    delegatedPath
  );
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(delegatedPath), false, '不应创建状态文件');
});

test('on-post-tool：agent 但 action 非 create_external → 不写入', () => {
  const dbPath = makeDb([]);
  const delegatedPath = tmpPath('ea-post-skip2-', 'delegated.json');
  runPostTool(
    dbPath,
    { session_id: 'sess_A', tool_name: 'agent', tool_use_id: 'call_x', tool_input: { action: 'list' } },
    delegatedPath
  );
  assert.equal(fs.existsSync(delegatedPath), false);
});

test('on-post-tool：tool_use_id 无命中 → 本会话时间窗兜底记录', () => {
  const dbPath = makeDb([
    {
      taskId: 'task_recent',
      sessionId: 'sess_A',
      sourceToolCallId: 'call_other',
      status: 'running',
      metadata: { externalAgentType: 'cursor', taskTitle: '刚启动的任务' },
      startedAt: Date.now() - 10 * 1000,
    },
  ]);
  const delegatedPath = tmpPath('ea-post-fallback-', 'delegated.json');
  runPostTool(
    dbPath,
    {
      session_id: 'sess_A',
      tool_name: 'agent',
      tool_use_id: 'call_missing',
      tool_input: { action: 'create_external', agentType: 'cursor', taskTitle: '刚启动的任务' },
    },
    delegatedPath
  );
  const state = readDelegated(delegatedPath);
  assert.equal(state.pending.length, 1);
  assert.equal(state.pending[0].taskId, 'task_recent', '应兜底匹配到本会话最新任务');
});

test('on-post-tool：重复捕获同一委托 → 去重', () => {
  const dbPath = makeDb([
    {
      taskId: 'task_dup_cap',
      sessionId: 'sess_A',
      sourceToolCallId: 'call_dup',
      status: 'running',
      metadata: { externalAgentType: 'kimi', taskTitle: '重复捕获' },
      startedAt: Date.now(),
    },
  ]);
  const delegatedPath = tmpPath('ea-post-dup-', 'delegated.json');
  const stdin = {
    session_id: 'sess_A',
    tool_name: 'agent',
    tool_use_id: 'call_dup',
    tool_input: { action: 'create_external', agentType: 'kimi' },
  };
  runPostTool(dbPath, stdin, delegatedPath);
  runPostTool(dbPath, stdin, delegatedPath);
  const state = readDelegated(delegatedPath);
  assert.equal(state.pending.length, 1, '同一任务不应重复记录');
});

test('on-post-tool：DB 不可用 → 静默且记录基本信息', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-post-missing-'));
  const delegatedPath = tmpPath('ea-post-degrade-', 'delegated.json');
  const r = runPostTool(
    path.join(dir, 'no-such.sqlite'),
    {
      session_id: 'sess_A',
      tool_name: 'agent',
      tool_use_id: 'call_x',
      tool_input: { action: 'create_external', agentType: 'zcode', taskTitle: '无库任务' },
    },
    delegatedPath
  );
  assert.equal(r.code, 0, '应静默退出');
  const state = readDelegated(delegatedPath);
  assert.equal(state.pending[0].agentType, 'zcode');
  assert.equal(state.pending[0].taskId, null);
});

// ===== 活跃会话记录 =====

test('hook：UserPromptSubmit 记录活跃会话（供列表默认按本会话过滤）', () => {
  const dbPath = makeDb([]);
  const activeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ea-act-')), 'active.json');
  runHook(dbPath, {
    activeSessionPath: activeFile,
    stdin: JSON.stringify({ sessionId: 'sess_hook_1' }),
  });
  const saved = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
  assert.equal(saved.sessionId, 'sess_hook_1');
});

test('on-stop：记录活跃会话', () => {
  const dbPath = makeDb([]);
  const activeFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ea-act-')), 'active.json');
  runStop(dbPath, { sessionId: 'sess_hook_2' }, makeStatePath(), { activeSessionPath: activeFile });
  const saved = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
  assert.equal(saved.sessionId, 'sess_hook_2');
});

// ===== 全自动会话命名（hooks/auto-name.js）=====

/** kimi 会话 fixture：会话创建时间与 dim 任务时间戳对齐即为「dim 委托」。 */
function makeKimiSession(home, { id, createdAt, title, isCustomTitle = false }) {
  const dir = path.join(home, '.kimi-code', 'sessions', 'wd_x', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ id, createdAt, updatedAt: createdAt, title, isCustomTitle, lastPrompt: '' })
  );
  fs.appendFileSync(
    path.join(home, '.kimi-code', 'session_index.jsonl'),
    `${JSON.stringify({ sessionId: id, sessionDir: dir, workDir: '/tmp/proj' })}\n`
  );
  return file;
}

function readTitle(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).title;
}

test('hook：自动命名默认关闭（opt-in）——不改任何会话', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-autoname-'));
  const ts = Date.now() - 60 * 1000;
  const stateFile = makeKimiSession(home, { id: 'session_default_off', createdAt: ts, title: 'New session' });
  const dbPath = makeDb([
    {
      taskId: `task_${ts}_defoff`,
      status: 'running',
      metadata: { externalAgentType: 'kimi', taskTitle: 'M9-06 默认关闭' },
      startedAt: ts,
    },
  ]);
  runHook(dbPath, { home });
  assert.equal(readTitle(stateFile), 'New session', '默认关闭 → 不自动改名');
});

test('hook：配置文件 autoName=true 时开启（桌面端唯一可靠的开启方式）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-autoname-'));
  const cfgDir = path.join(home, '.dimcode');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'ea-extend-config.json'), JSON.stringify({ autoName: true }));
  const ts = Date.now() - 60 * 1000;
  const stateFile = makeKimiSession(home, { id: 'session_cfg_on', createdAt: ts, title: 'New session' });
  const dbPath = makeDb([
    {
      taskId: `task_${ts}_cfgon0`,
      status: 'running',
      metadata: { externalAgentType: 'kimi', taskTitle: 'M9-07 配置开启' },
      startedAt: ts,
    },
  ]);
  runHook(dbPath, { home });
  assert.equal(readTitle(stateFile), '[dim] M9-07 配置开启');
});

test('hook：全自动把 dim 委托会话的泛化标题改成统一名（带 [dim] 标记）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-autoname-'));
  const ts = Date.now() - 60 * 1000;
  const stateFile = makeKimiSession(home, { id: 'session_auto1', createdAt: ts, title: 'New session' });
  const dbPath = makeDb([
    {
      taskId: `task_${ts}_auto1`,
      status: 'running',
      metadata: { externalAgentType: 'kimi', taskTitle: '实现 M9-01 自动命名' },
      startedAt: ts,
    },
  ]);

  const out = runHook(dbPath, { home, env: { EA_EXT_AUTO_NAME: 'on' } });
  assert.equal(readTitle(stateFile), '[dim] 实现 M9-01 自动命名');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).isCustomTitle, true);
  assert.ok(!out.includes('[dim] '), '改名结果不应出现在 hook 的会话输出里（静默）');
});

test('hook：全自动只动「泛化标题的 dim 委托会话」——名称已够好 / 自定义标题 / 非 dim 委托都不动', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-autoname-'));
  const ts = Date.now() - 60 * 1000;
  const okFile = makeKimiSession(home, { id: 'session_ok', createdAt: ts, title: '实现 M9-02 时间轴' });
  const customFile = makeKimiSession(home, {
    id: 'session_custom',
    createdAt: ts + 1000,
    title: 'New session',
    isCustomTitle: true,
  });
  const manualFile = makeKimiSession(home, { id: 'session_manual', createdAt: ts + 900_000, title: 'Help' });
  const dbPath = makeDb([
    {
      taskId: `task_${ts}_ok0000`,
      status: 'completed',
      metadata: { externalAgentType: 'kimi', taskTitle: '实现 M9-02 时间轴' },
      startedAt: ts,
    },
    {
      taskId: `task_${ts + 1000}_cus000`,
      status: 'completed',
      metadata: { externalAgentType: 'kimi', taskTitle: 'M9-03 自定义标题保护' },
      startedAt: ts + 1000,
    },
  ]);

  runHook(dbPath, { home, env: { EA_EXT_AUTO_NAME: 'on' } });
  assert.equal(readTitle(okFile), '实现 M9-02 时间轴', '名称已够好 → 不动');
  assert.equal(readTitle(customFile), 'New session', '你自定义过标题 → 不动');
  assert.equal(readTitle(manualFile), 'Help', '非 dim 委托（没有对应任务）→ 不动');
});

test('hook：EA_EXT_AUTO_NAME=off 时完全不改名', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-autoname-'));
  const ts = Date.now() - 60 * 1000;
  const stateFile = makeKimiSession(home, { id: 'session_off', createdAt: ts, title: 'New session' });
  const dbPath = makeDb([
    {
      taskId: `task_${ts}_off000`,
      status: 'running',
      metadata: { externalAgentType: 'kimi', taskTitle: 'M9-04 关闭开关' },
      startedAt: ts,
    },
  ]);

  runHook(dbPath, { home, env: { EA_EXT_AUTO_NAME: 'off' } });
  assert.equal(readTitle(stateFile), 'New session');
});

test('hook：窗口外的老任务不回溯改名', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-autoname-'));
  const ts = Date.now() - 5 * 60 * 60 * 1000; // 5 小时前
  const stateFile = makeKimiSession(home, { id: 'session_old', createdAt: ts, title: 'New session' });
  const dbPath = makeDb([
    {
      taskId: `task_${ts}_old000`,
      status: 'completed',
      metadata: { externalAgentType: 'kimi', taskTitle: 'M9-05 老任务' },
      startedAt: ts,
    },
  ]);

  runHook(dbPath, { home, env: { EA_EXT_AUTO_NAME: 'on' } });
  assert.equal(readTitle(stateFile), 'New session', '超出 2 小时窗口 → 不回溯');
});
