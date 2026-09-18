'use strict';

/**
 * CLI（T4.1）测试：以子进程方式调用 server/src/cli.js，覆盖 list / show / tail 与用法错误。
 * 使用独立的临时 home fixture（与 tools.test 同形，测试文件自包含）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const TS = 1789559570749;

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ea-cli-test-'));
}

function makeFixture(home) {
  const dbPath = path.join(home, '.dimcode', 'v2', 'dimcode.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE background_tasks (
    taskId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, sourceRunId TEXT NOT NULL, sourceToolCallId TEXT NOT NULL,
    toolName TEXT NOT NULL, label TEXT, status TEXT NOT NULL, wakePolicy TEXT NOT NULL, outputPath TEXT,
    metadata TEXT, startedAt TEXT NOT NULL, completedAt TEXT, completion TEXT, notificationDeliveredAt TEXT)`);
  const ins = db.prepare(
    'INSERT INTO background_tasks (taskId, sessionId, sourceRunId, sourceToolCallId, toolName, status, wakePolicy, metadata, startedAt, completedAt) VALUES (?,?,?,?,?,?,?,?,?,?)'
  );
  ins.run(
    `task_${TS}_aaa111`,
    's1',
    'r',
    'c',
    'agent',
    'completed',
    'none',
    JSON.stringify({ subagentType: 'kimi', taskTitle: '演示任务 A', subagentInput: { prompt: '实现 GUO-63' } }),
    '2026-09-16T11:52:50.749Z',
    '2026-09-16T12:00:00.000Z'
  );
  ins.run(
    `task_${TS + 1000}_bbb222`,
    's2',
    'r',
    'c',
    'agent',
    'running',
    'none',
    JSON.stringify({ subagentType: 'kimi', taskTitle: '演示任务 B' }),
    '2026-09-16T11:52:51.749Z',
    null
  );
  ins.run(
    `task_${TS + 2000}_ccc333`,
    's3',
    'r',
    'c',
    'agent',
    'completed',
    'none',
    JSON.stringify({ subagentType: 'cursor', taskTitle: '演示任务 C（无会话）' }),
    '2026-09-16T11:52:52.749Z',
    null
  );
  db.close();

  const sessRoot = path.join(home, '.kimi-code', 'sessions', 'wd_x');
  const ev = (obj, t) => JSON.stringify({ type: 'context.append_loop_event', event: obj, time: t });
  const mkSession = (id, createdAt, lines) => {
    const dir = path.join(sessRoot, id);
    fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id, createdAt, lastPrompt: 'x' }));
    fs.writeFileSync(path.join(dir, 'agents', 'main', 'wire.jsonl'), lines.join('\n') + '\n');
    return dir;
  };
  mkSession('session_aaaaaaaa', TS + 500, [
    JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: TS + 500 }),
    ev({ type: 'tool.call', name: 'read_file', arguments: { path: '/x' } }, TS + 600),
    ev({ type: 'tool.result', result: 'ok' }, TS + 700),
    ev({ type: 'content.part', part: { type: 'text', text: 'done' } }, TS + 800),
  ]);
  mkSession('session_bbbbbbbb', TS + 1200, [
    JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: TS + 1200 }),
    ev({ type: 'tool.call', name: 'grep', arguments: { pattern: 'x' } }, TS + 1300),
  ]);
  fs.writeFileSync(
    path.join(home, '.kimi-code', 'session_index.jsonl'),
    [
      JSON.stringify({ sessionId: 'session_aaaaaaaa', sessionDir: path.join(sessRoot, 'session_aaaaaaaa'), workDir: '/w' }),
      JSON.stringify({ sessionId: 'session_bbbbbbbb', sessionDir: path.join(sessRoot, 'session_bbbbbbbb'), workDir: '/w' }),
    ].join('\n') + '\n'
  );
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 15000 });
}

test('list --json：任务数组与计数', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const r = run(['list', '--json', '--home', home]);
  assert.equal(r.status, 0);
  const data = JSON.parse(r.stdout);
  assert.equal(data.status, 'ok');
  assert.equal(data.count, 3);
  assert.equal(data.runs[0].taskId, `task_${TS + 2000}_ccc333`); // 最新在前
});

test('list：人类可读表格', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const r = run(['list', '--home', home]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('TASK'));
  assert.ok(r.stdout.includes('kimi'));
  assert.ok(r.stdout.includes('cursor'));
  assert.ok(r.stdout.includes('演示任务 A'));
});

test('list --type 过滤', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const r = run(['list', '--type', 'kimi', '--json', '--home', home]);
  assert.equal(JSON.parse(r.stdout).count, 2);
});

test('show --json：任务信息 + 事件', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const r = run(['show', `task_${TS}_aaa111`, '--json', '--home', home]);
  assert.equal(r.status, 0);
  const data = JSON.parse(r.stdout);
  assert.equal(data.task.taskId, `task_${TS}_aaa111`);
  assert.equal(data.events.length, 4);
  assert.equal(data.events[0].kind, 'meta');
});

test('show：人类可读输出', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const r = run(['show', `task_${TS}_aaa111`, '--home', home]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('任务'));
  assert.ok(r.stdout.includes('共 4 条'));
  assert.ok(r.stdout.includes('tool_call'));
});

test('show 缺 taskId → 用法错误（exit 2）', () => {
  const r = run(['show']);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('用法'));
});

test('show 不存在 → exit 1 + 错误信息', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const r = run(['show', 'task_0000000000000_x', '--home', home]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('任务不存在'));
});

test('tail 任务不存在 → 立即退出 1', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const r = run(['tail', 'task_0000000000000_x', '--home', home]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('任务不存在'));
});

test('--help → exit 0 + 用法文本', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('用法'));
});

test('无参数 → exit 2 + 用法文本', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.ok(r.stdout.includes('用法'));
});
