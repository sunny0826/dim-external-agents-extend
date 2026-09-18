'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { listRuns, getRun, RunsError, defaultDbPath } = require('../src/core/runs');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ea-runs-test-'));
}

/** 构造与真实 dim 库同形的 fixture（含 agent/exec 两类任务）。 */
function makeFixtureDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE background_tasks (
    taskId TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    sourceRunId TEXT NOT NULL,
    sourceToolCallId TEXT NOT NULL,
    toolName TEXT NOT NULL,
    label TEXT,
    status TEXT NOT NULL,
    wakePolicy TEXT NOT NULL,
    outputPath TEXT,
    metadata TEXT,
    startedAt TEXT NOT NULL,
    completedAt TEXT,
    completion TEXT,
    notificationDeliveredAt TEXT
  )`);
  const ins = db.prepare(
    'INSERT INTO background_tasks (taskId, sessionId, sourceRunId, sourceToolCallId, toolName, status, wakePolicy, metadata, startedAt, completion) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  ins.run(
    'task_1789559570749_9kvwq6',
    's1',
    'r1',
    'c1',
    'agent',
    'completed',
    'none',
    JSON.stringify({ subagentType: 'kimi', subagentInput: { prompt: 'p1' }, taskTitle: 't1' }),
    '2026-09-16T11:52:50.749Z',
    'done'
  );
  ins.run(
    'task_1789616533081_081muy',
    's2',
    'r2',
    'c2',
    'agent',
    'running',
    'none',
    JSON.stringify({ subagentType: 'cursor', taskTitle: 't2' }),
    '2026-09-17T03:42:13.081Z',
    null
  );
  ins.run('task_1789000000000_exec0', 's3', 'r3', 'c3', 'exec', 'completed', 'none', null, '2026-09-17T04:00:00.000Z', null);
  db.close();
}

test('defaultDbPath：默认与自定义 home', () => {
  assert.equal(defaultDbPath('/home/u'), path.join('/home/u', '.dimcode', 'v2', 'dimcode.sqlite'));
});

test('listRuns：只返回 agent 任务，按 startedAt 倒序，解析 metadata', () => {
  const dir = mkTmpDir();
  const dbPath = path.join(dir, 'dimcode.sqlite');
  makeFixtureDb(dbPath);
  const runs = listRuns({ dbPath });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].taskId, 'task_1789616533081_081muy'); // startedAt 更晚
  assert.equal(runs[0].agentType, 'cursor');
  assert.equal(runs[0].status, 'running');
  assert.equal(runs[1].agentType, 'kimi');
  assert.equal(runs[1].prompt, 'p1');
  assert.equal(runs[1].taskTitle, 't1');
  assert.equal(runs[1].completion, 'done');
});

test('listRuns：agentType / status 过滤（SQL 层 JSON1）', () => {
  const dir = mkTmpDir();
  const dbPath = path.join(dir, 'dimcode.sqlite');
  makeFixtureDb(dbPath);
  assert.equal(listRuns({ dbPath, agentType: 'kimi' }).length, 1);
  assert.equal(listRuns({ dbPath, agentType: 'cursor' }).length, 1);
  assert.equal(listRuns({ dbPath, agentType: 'grok' }).length, 0);
  assert.equal(listRuns({ dbPath, status: 'running' }).length, 1);
  assert.equal(listRuns({ dbPath, agentType: 'cursor', status: 'completed' }).length, 0);
  assert.equal(listRuns({ dbPath, limit: 1 }).length, 1);
});

test('getRun：命中与缺失', () => {
  const dir = mkTmpDir();
  const dbPath = path.join(dir, 'dimcode.sqlite');
  makeFixtureDb(dbPath);
  const run = getRun('task_1789559570749_9kvwq6', { dbPath });
  assert.equal(run.agentType, 'kimi');
  assert.equal(run.taskTitle, 't1');
  assert.equal(getRun('task_missing', { dbPath }), null);
});

test('容错：数据库不存在 → db_unavailable 且不创建文件', () => {
  const dir = mkTmpDir();
  const dbPath = path.join(dir, 'missing.sqlite');
  assert.throws(
    () => listRuns({ dbPath }),
    (err) => err instanceof RunsError && err.code === 'db_unavailable'
  );
  assert.equal(fs.existsSync(dbPath), false);
});

test('容错：非数据库文件 → query_failed（打开成功但查询报错）', () => {
  const dir = mkTmpDir();
  const dbPath = path.join(dir, 'not-a-db.sqlite');
  fs.writeFileSync(dbPath, 'hello, not a sqlite file');
  assert.throws(
    () => listRuns({ dbPath }),
    (err) => err instanceof RunsError && err.code === 'query_failed'
  );
});

test('容错：缺列的表（schema 漂移）不崩，缺失字段为 null', () => {
  const dir = mkTmpDir();
  const dbPath = path.join(dir, 'narrow.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE background_tasks (taskId TEXT, toolName TEXT, status TEXT, startedAt TEXT)');
  db.prepare('INSERT INTO background_tasks VALUES (?,?,?,?)').run(
    'task_1789559570749_narrow',
    'agent',
    'completed',
    '2026-09-17T00:00:00.000Z'
  );
  db.close();
  const runs = listRuns({ dbPath });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].taskId, 'task_1789559570749_narrow');
  assert.equal(runs[0].sessionId, null); // 列缺失
  assert.equal(runs[0].agentType, null); // metadata 列缺失
});
