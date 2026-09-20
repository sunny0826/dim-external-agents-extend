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

/* ------------------------- sessions / rename（T-N4） ------------------------ */

test('sessions --json：会话清单带统一展示名与 key', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const r = run(['sessions', '--json', '--home', home]);
  assert.equal(r.status, 0);
  const data = JSON.parse(r.stdout);
  assert.equal(data.count, 2);
  for (const s of data.sessions) {
    assert.match(s.displayName, /^\[kimi\] \d{2}-\d{2} \d{2}:\d{2} · .+/);
    assert.ok(s.key.startsWith('kimi:'));
  }
  /* kimi 会话创建时间与 dim 任务时间戳对齐 → 用 dim 任务标题命名 */
  const titles = data.sessions.map((s) => s.title).sort();
  assert.deepEqual(titles, ['演示任务 A', '演示任务 B']);
});

test('sessions：人类可读输出含表头与 key', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const r = run(['sessions', '--type', 'kimi', '--limit', '1', '--home', home]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('AGENT'));
  assert.ok(r.stdout.includes('kimi:session_'));
  assert.ok(r.stdout.includes('演示任务 B')); /* limit=1 → 只显示最新（TS+1200） */
});

test('sessions：空 home 不报错，输出空态', () => {
  const home = mkTmpHome();
  const r = run(['sessions', '--home', home]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('没有找到会话'));
});

test('rename：缺 --keys → 用法错误（exit 2）', () => {
  const r = run(['rename']);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('用法'));
});

test('rename：默认预览不写入，--apply 才写并留备份', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const key = 'kimi:session_aaaaaaaa';
  const stateFile = path.join(home, '.kimi-code', 'sessions', 'wd_x', 'session_aaaaaaaa', 'state.json');
  const before = fs.readFileSync(stateFile, 'utf8');

  const preview = run(['rename', '--keys', key, '--home', home]);
  assert.equal(preview.status, 0);
  assert.ok(preview.stdout.includes('待改名'));
  assert.ok(preview.stdout.includes('演示任务 A'));
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);

  const applied = run(['rename', '--keys', key, '--apply', '--home', home]);
  assert.equal(applied.status, 0);
  assert.ok(applied.stdout.includes('已改名'));
  assert.ok(applied.stdout.includes('备份'));
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.title, '[dim] 演示任务 A');
  assert.equal(state.isCustomTitle, true);
});

test('rename：未知 key → exit 1 并说明未找到', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const r = run(['rename', '--keys', 'kimi:nope', '--home', home]);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes('未找到'));
});

/* ---------------------------- autoname（T-N5） ---------------------------- */

test('autoname --dry-run：只预览，不改任何文件', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const stateFile = path.join(home, '.kimi-code', 'sessions', 'wd_x', 'session_aaaaaaaa', 'state.json');
  const before = fs.readFileSync(stateFile, 'utf8');
  const r = run(['autoname', '--window', '100000', '--dry-run', '--home', home]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('待改名'));
  assert.ok(r.stdout.includes('[dim] 演示任务 A'));
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
});

test('autoname：默认写入，把泛化标题改成统一名', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const stateFile = path.join(home, '.kimi-code', 'sessions', 'wd_x', 'session_aaaaaaaa', 'state.json');
  const r = run(['autoname', '--window', '100000', '--home', home]);
  assert.equal(r.status, 0);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.title, '[dim] 演示任务 A');
});

test('autoname --json：机器可读输出', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const r = run(['autoname', '--window', '100000', '--dry-run', '--json', '--home', home]);
  assert.equal(r.status, 0);
  const data = JSON.parse(r.stdout);
  assert.equal(data.dryRun, true);
  assert.ok(data.considered >= 1);
});

test('autoname --enable / --disable：写配置文件开关（默认关闭）', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const cfg = path.join(home, '.dimcode', 'ea-extend-config.json');

  const on = run(['autoname', '--enable', '--home', home]);
  assert.equal(on.status, 0);
  assert.ok(on.stdout.includes('已开启'));
  assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).autoName, true);

  const listed = run(['autoname', '--window', '100000', '--dry-run', '--home', home]);
  assert.ok(listed.stdout.includes('自动命名：已开启'));

  const off = run(['autoname', '--disable', '--home', home]);
  assert.equal(off.status, 0);
  assert.ok(off.stdout.includes('已关闭'));
  assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).autoName, false);
});

test('autoname：默认关闭时提示如何开启，但显式回填仍然生效', () => {
  const home = mkTmpHome();
  makeFixture(home);
  const stateFile = path.join(home, '.kimi-code', 'sessions', 'wd_x', 'session_aaaaaaaa', 'state.json');
  const r = run(['autoname', '--window', '100000', '--home', home]);
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('已关闭（默认）'));
  assert.ok(r.stdout.includes('autoname --enable'));
  /* 显式回填不受开关影响（这是用户主动执行的动作） */
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).title, '[dim] 演示任务 A');
});
