'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { listAgentRuns, readAgentRun } = require('../src/tools');

// 隔离：默认指向不存在的活跃会话文件（避免读到真实环境的 hook 残留）
process.env.EA_EXT_ACTIVE_SESSION = path.join(os.tmpdir(), 'ea-tools-test-no-active.json');

const TS = 1789559570749; // taskId 时间戳基准

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ea-tools-test-'));
}

/**
 * 构造 fixture：
 * - dim db：3 条 agent 任务（kimi completed / kimi running / cursor completed 无会话）
 * - kimi 会话：session_aaaaaaaa（wire 干净，4 事件）、session_bbbbbbbb（wire 干净，2 事件）
 */
function makeFixture(home) {
  const dbPath = path.join(home, 'dimcode.sqlite');
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
    JSON.stringify({
      subagentType: 'kimi',
      taskTitle: 'GUO-63 相关任务',
      subagentInput: { prompt: '实现 GUO-63' },
      selectedProviderId: 'kimi',
      selectedModelId: 'kimi-code/k3',
    }),
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
    JSON.stringify({ subagentType: 'kimi', taskTitle: '运行中的任务' }),
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
    JSON.stringify({ subagentType: 'cursor', taskTitle: '无会话的 cursor 任务', selectedProviderId: 'cursor', selectedModelId: 'grok-4.6' }),
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
    JSON.stringify({ type: 'config.update', agentId: 'main', modelAlias: 'kimi-code/k3', time: TS + 550 }),
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
  return { dbPath };
}

test('list_agent_runs：返回摘要、支持过滤', () => {
  const home = mkTmpHome();
  const { dbPath } = makeFixture(home);
  const all = JSON.parse(listAgentRuns({}, { home, dbPath }).text);
  assert.equal(all.status, 'ok');
  assert.equal(all.count, 3);
  assert.equal(all.runs[0].taskId, `task_${TS + 2000}_ccc333`); // startedAt 倒序
  assert.equal(all.runs[0].agentType, 'cursor');
  assert.equal(all.runs[0].model, 'grok-4.6'); // dim 派发时选择的模型
  assert.equal(all.runs[0].promptHead, null);
  assert.equal(all.runs[2].model, 'kimi-code/k3');
  assert.equal(all.runs[1].model, null); // metadata 未带模型 → null

  const kimi = JSON.parse(listAgentRuns({ agentType: 'kimi' }, { home, dbPath }).text);
  assert.equal(kimi.count, 2);
  const running = JSON.parse(listAgentRuns({ status: 'running' }, { home, dbPath }).text);
  assert.equal(running.count, 1);
  assert.equal(running.runs[0].taskId, `task_${TS + 1000}_bbb222`);
});

test('list_agent_runs：空库 → empty', () => {
  const home = mkTmpHome();
  const dbPath = path.join(home, 'dimcode.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE background_tasks (taskId TEXT, toolName TEXT, status TEXT, startedAt TEXT)');
  db.close();
  const res = JSON.parse(listAgentRuns({}, { home, dbPath }).text);
  assert.equal(res.status, 'empty');
  assert.equal(res.count, 0);
});

test('list_agent_runs：库不存在 → db_unavailable + isError', () => {
  const home = mkTmpHome();
  const res = listAgentRuns({}, { home, dbPath: path.join(home, 'missing.sqlite') });
  const payload = JSON.parse(res.text);
  assert.equal(payload.status, 'db_unavailable');
  assert.equal(res.isError, true);
});

test('read_agent_run：task_not_found', () => {
  const home = mkTmpHome();
  const { dbPath } = makeFixture(home);
  const res = readAgentRun({ taskId: 'task_0000000000000_x' }, { home, dbPath });
  assert.equal(JSON.parse(res.text).status, 'task_not_found');
  assert.equal(res.isError, false);
});

test('read_agent_run：bad_arguments（缺 taskId）', () => {
  const home = mkTmpHome();
  const res = readAgentRun({}, { home });
  assert.equal(JSON.parse(res.text).status, 'bad_arguments');
  assert.equal(res.isError, true);
});

test('read_agent_run：no_log（任务存在但无对应会话）', () => {
  const home = mkTmpHome();
  const { dbPath } = makeFixture(home);
  const res = readAgentRun({ taskId: `task_${TS + 2000}_ccc333` }, { home, dbPath });
  const payload = JSON.parse(res.text);
  assert.equal(payload.status, 'no_log');
  assert.equal(payload.agentType, 'cursor');
  assert.equal(res.isError, false);
});

test('read_agent_run：正常读取（ok）+ 游标分页 + 会话模型', () => {
  const home = mkTmpHome();
  const { dbPath } = makeFixture(home);
  const taskId = `task_${TS}_aaa111`;

  const page1 = JSON.parse(readAgentRun({ taskId, limit: 2 }, { home, dbPath }).text);
  assert.equal(page1.status, 'ok');
  assert.equal(page1.total, 5); // meta + config.update + tool_call + tool_result + text
  assert.equal(page1.events.length, 2);
  assert.equal(page1.nextCursor, '2');
  assert.equal(page1.session.adapter, 'kimi');
  /* 会话实际模型（来自 wire 的 config.update）；与 dim 侧 task.model 并存 */
  assert.deepEqual(page1.session.model, { id: 'kimi-code/k3', provider: null, source: 'config.update' });
  assert.equal(page1.task.model, 'kimi-code/k3');
  assert.ok(page1.events[0].kind === 'meta');
  assert.equal(page1.events[0].raw, undefined); // 事件瘦身：raw 不返回

  const kinds1 = page1.events.map((e) => e.kind);
  assert.ok(kinds1.includes('meta'));
  assert.ok(kinds1.includes('tool_call') || kinds1.includes('notice'));

  const page2 = JSON.parse(readAgentRun({ taskId, cursor: page1.nextCursor, limit: 3 }, { home, dbPath }).text);
  assert.equal(page2.events.length, 3);
  assert.equal(page2.nextCursor, null);
  const kinds2 = page2.events.map((e) => e.kind);
  assert.ok(kinds2.some((k) => k === 'tool_result' || k === 'text'));
});

test('read_agent_run：degraded 标记（wire 含未知类型）', () => {
  const home = mkTmpHome();
  const { dbPath } = makeFixture(home);
  fs.appendFileSync(
    path.join(home, '.kimi-code', 'sessions', 'wd_x', 'session_aaaaaaaa', 'agents', 'main', 'wire.jsonl'),
    JSON.stringify({ type: 'totally.unknown.type', time: TS + 900 }) + '\n'
  );
  const payload = JSON.parse(readAgentRun({ taskId: `task_${TS}_aaa111` }, { home, dbPath }).text);
  assert.equal(payload.status, 'degraded');
  assert.equal(payload.meta.degraded, true);
  assert.ok(payload.meta.warnings.length >= 1);
});

test('read_agent_run：running 标记与 hint', () => {
  const home = mkTmpHome();
  const { dbPath } = makeFixture(home);
  const payload = JSON.parse(readAgentRun({ taskId: `task_${TS + 1000}_bbb222` }, { home, dbPath }).text);
  assert.equal(payload.status, 'running');
  assert.ok(typeof payload.hint === 'string' && payload.hint.length > 0);
  assert.equal(payload.events.length, 2);
});

test('list_agent_runs：scope=session 按活跃会话过滤；scope=all 全量', () => {
  const home = mkTmpHome();
  const { dbPath } = makeFixture(home);
  const activeFile = path.join(mkTmpHome(), 'active.json');
  fs.writeFileSync(activeFile, JSON.stringify({ sessionId: 's2' }));
  const prev = process.env.EA_EXT_ACTIVE_SESSION;
  process.env.EA_EXT_ACTIVE_SESSION = activeFile;
  try {
    const scoped = JSON.parse(listAgentRuns({}, { home, dbPath }).text);
    assert.equal(scoped.scope, 'session');
    assert.equal(scoped.sessionId, 's2');
    assert.equal(scoped.count, 1);
    assert.equal(scoped.runs[0].taskId, `task_${TS + 1000}_bbb222`);

    const all = JSON.parse(listAgentRuns({ scope: 'all' }, { home, dbPath }).text);
    assert.equal(all.scope, 'all');
    assert.equal(all.count, 3);
  } finally {
    if (prev === undefined) delete process.env.EA_EXT_ACTIVE_SESSION;
    else process.env.EA_EXT_ACTIVE_SESSION = prev;
  }
});

test('list_agent_runs：无活跃会话记录时回退为 all', () => {
  const home = mkTmpHome();
  const { dbPath } = makeFixture(home);
  const prev = process.env.EA_EXT_ACTIVE_SESSION;
  process.env.EA_EXT_ACTIVE_SESSION = path.join(home, 'no-such-active.json');
  try {
    const res = JSON.parse(listAgentRuns({}, { home, dbPath }).text);
    assert.equal(res.scope, 'all');
    assert.equal(res.sessionId, null);
    assert.equal(res.count, 3);
  } finally {
    if (prev === undefined) delete process.env.EA_EXT_ACTIVE_SESSION;
    else process.env.EA_EXT_ACTIVE_SESSION = prev;
  }
});

test('list_agent_runs：includeFinished=false 隐藏已完成/已取消', () => {
  const home = mkTmpHome();
  const { dbPath } = makeFixture(home);
  const prev = process.env.EA_EXT_ACTIVE_SESSION;
  process.env.EA_EXT_ACTIVE_SESSION = path.join(home, 'no-such-active.json'); // scope 回退 all
  try {
    const active = JSON.parse(listAgentRuns({ includeFinished: false }, { home, dbPath }).text);
    assert.equal(active.count, 1);
    assert.equal(active.runs[0].taskId, `task_${TS + 1000}_bbb222`); // 仅剩 running

    const all = JSON.parse(listAgentRuns({}, { home, dbPath }).text);
    assert.equal(all.count, 3); // 默认仍含全部（模型侧行为不变）
  } finally {
    if (prev === undefined) delete process.env.EA_EXT_ACTIVE_SESSION;
    else process.env.EA_EXT_ACTIVE_SESSION = prev;
  }
});
