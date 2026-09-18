'use strict';
/**
 * hooks/context.js 测试（UserPromptSubmit hook）：
 * - 有运行中外部任务 → 输出状态摘要（含 taskId 与展示工具提示）
 * - 无运行中任务（仅 completed）→ 输出为空
 * - tui_worker 不计入
 * - DB 不可用 → 静默（空输出、退出 0）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const SCRIPT = path.join(__dirname, '..', '..', 'hooks', 'context.js');

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
    'INSERT INTO background_tasks (taskId, toolName, status, metadata, startedAt) VALUES (?, ?, ?, ?, ?)'
  );
  for (const r of taskRows) {
    stmt.run(
      r.taskId,
      r.toolName || 'agent',
      r.status,
      r.metadata === undefined ? null : JSON.stringify(r.metadata),
      r.startedAt === undefined ? Date.now() : r.startedAt
    );
  }
  db.close();
  return dbPath;
}

function runHook(dbPath, opts) {
  return execFileSync(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      DIM_EXT_HOOK_DB: dbPath,
      HOME: '/nonexistent-home-for-hook-test',
      EA_EXT_ACTIVE_SESSION:
        (opts && opts.activeSessionPath) || path.join(os.tmpdir(), 'ea-test-active-session.json'),
    },
    ...(opts && opts.stdin !== undefined ? { input: opts.stdin } : {}),
    encoding: 'utf8',
  });
}

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

test('hook：仅 completed 任务 → 无输出（零打扰）', () => {
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

// ===== on-stop.js（Stop hook：启动后自动展示）测试 =====

const STOP_SCRIPT = path.join(__dirname, '..', '..', 'hooks', 'on-stop.js');

function makeStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ea-stop-state-')), 'state.json');
}

function runStop(dbPath, stdinObj, statePath, opts) {
  try {
    const stdout = execFileSync(process.execPath, [STOP_SCRIPT], {
      env: {
        ...process.env,
        DIM_EXT_HOOK_DB: dbPath,
        EA_EXT_HOOK_STATE: statePath,
        HOME: '/nonexistent-home-for-hook-test',
        EA_EXT_ACTIVE_SESSION:
          (opts && opts.activeSessionPath) || path.join(os.tmpdir(), 'ea-test-active-session.json'),
      },
      input: JSON.stringify(stdinObj || {}),
      encoding: 'utf8',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

test('on-stop：新启动任务 → block（exit 2）并提示打开日志面板', () => {
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
