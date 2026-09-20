'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { listAgentRuns, readAgentRun, callDataTool } = require('../src/tools');

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

/* ===== 设置开关（get_settings / set_auto_name）===== */

test('get_settings / set_auto_name：默认关闭，可开关，写入配置文件', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-tools-settings-'));
  const initial = JSON.parse(callDataTool('get_settings', {}, { home }).text);
  assert.equal(initial.status, 'ok');
  assert.equal(initial.autoName.enabled, false);
  assert.equal(initial.autoName.source, 'default');

  const on = JSON.parse(callDataTool('set_auto_name', { enabled: true }, { home }).text);
  assert.equal(on.status, 'ok');
  assert.equal(on.autoName.enabled, true);
  assert.equal(on.autoName.source, 'config');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.dimcode', 'ea-extend-config.json'), 'utf8')).autoName, true);

  const off = JSON.parse(callDataTool('set_auto_name', { enabled: false }, { home }).text);
  assert.equal(off.autoName.enabled, false);
});

test('set_auto_name：缺少 enabled 布尔值 → bad_arguments（isError）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-tools-settings-'));
  const res = callDataTool('set_auto_name', {}, { home });
  assert.equal(res.isError, true);
  assert.equal(JSON.parse(res.text).status, 'bad_arguments');
  assert.equal(fs.existsSync(path.join(home, '.dimcode', 'ea-extend-config.json')), false, '不写文件');
});

/* ===== 会话解析与兜底（「有任务在跑但没被识别」）===== */

/** 构造两个会话各有任务的最小 fixture。 */
function makeTwoSessionDb(dir) {
  const dbPath = path.join(dir, 'dimcode.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE background_tasks (
    taskId TEXT PRIMARY KEY, sessionId TEXT, sourceRunId TEXT, sourceToolCallId TEXT,
    toolName TEXT, label TEXT, status TEXT, wakePolicy TEXT, outputPath TEXT,
    metadata TEXT, startedAt TEXT, completedAt TEXT, completion TEXT, notificationDeliveredAt TEXT
  )`);
  const ins = db.prepare(
    'INSERT INTO background_tasks (taskId, sessionId, toolName, status, metadata, startedAt) VALUES (?,?,?,?,?,?)'
  );
  ins.run('task_1789824567432_zanjgj', 'sess_other', 'agent', 'running', JSON.stringify({ externalAgentType: 'kimi', taskTitle: '实现 GUO-109 字幕编辑调整与删除' }), '2026-09-19T13:29:27.432Z');
  ins.run('task_1789822936516_8sh2ww', 'sess_mine', 'agent', 'completed', JSON.stringify({ externalAgentType: 'cursor', taskTitle: '本会话已完成的任务' }), '2026-09-19T12:08:56.516Z');
  db.close();
  return dbPath;
}

function writeActiveSessionFile(sessions) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ea-active-')), 'active.json');
  fs.writeFileSync(file, JSON.stringify({ sessions, updatedAt: Date.now() }));
  return file;
}

test('list_agent_runs：本会话没有任务时回退为全部会话，并明确标注（不再静默为空）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-two-sess-'));
  const dbPath = makeTwoSessionDb(dir);
  const saved = process.env.EA_EXT_ACTIVE_SESSION;
  process.env.EA_EXT_ACTIVE_SESSION = writeActiveSessionFile({ sess_mine: Date.now(), sess_other: Date.now() - 1000 });
  try {
    /* 活跃会话是 sess_mine，但它只有已完成任务 → 默认隐藏已结束时为空 */
    const res = JSON.parse(listAgentRuns({ limit: 10, includeFinished: false }, { dbPath }).text);
    assert.equal(res.scope, 'all', '应回退为全部会话');
    assert.ok(res.scopeFallback, '应带 scopeFallback 说明');
    assert.equal(res.scopeFallback.from, 'sess_mine');
    assert.equal(res.count, 1);
    assert.equal(res.runs[0].taskId, 'task_1789824567432_zanjgj');
    assert.equal(res.runs[0].sessionId, 'sess_other', '每条任务带 sessionId，便于区分来源');
  } finally {
    if (saved === undefined) delete process.env.EA_EXT_ACTIVE_SESSION;
    else process.env.EA_EXT_ACTIVE_SESSION = saved;
  }
});

test('list_agent_runs：显式 sessionId 优先，且本会话有任务时不做回退', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-two-sess-'));
  const dbPath = makeTwoSessionDb(dir);
  const saved = process.env.EA_EXT_ACTIVE_SESSION;
  process.env.EA_EXT_ACTIVE_SESSION = writeActiveSessionFile({ sess_mine: Date.now() });
  try {
    /* 显式指定另一个会话 */
    const other = JSON.parse(listAgentRuns({ sessionId: 'sess_other', limit: 10 }, { dbPath }).text);
    assert.equal(other.sessionId, 'sess_other');
    assert.equal(other.count, 1);
    assert.equal(other.runs[0].sessionId, 'sess_other');
    assert.equal(other.scopeFallback, undefined);

    /* 本会话有任务（含已结束）→ 不回退 */
    const mine = JSON.parse(listAgentRuns({ limit: 10 }, { dbPath }).text);
    assert.equal(mine.scope, 'session');
    assert.equal(mine.scopeFallback, undefined);
    assert.equal(mine.runs[0].sessionId, 'sess_mine');
  } finally {
    if (saved === undefined) delete process.env.EA_EXT_ACTIVE_SESSION;
    else process.env.EA_EXT_ACTIVE_SESSION = saved;
  }
});

test('list_agent_runs：回退只在「别处确实有在跑的任务」时发生，不把历史失败倒出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-fallback-scope-'));
  const dbPath = path.join(dir, 'dimcode.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE background_tasks (
    taskId TEXT PRIMARY KEY, sessionId TEXT, sourceRunId TEXT, sourceToolCallId TEXT,
    toolName TEXT, label TEXT, status TEXT, wakePolicy TEXT, outputPath TEXT,
    metadata TEXT, startedAt TEXT, completedAt TEXT, completion TEXT, notificationDeliveredAt TEXT
  )`);
  const ins = db.prepare(
    'INSERT INTO background_tasks (taskId, sessionId, toolName, status, metadata, startedAt) VALUES (?,?,?,?,?,?)'
  );
  ins.run('task_1789820000000_old000', 'sess_other', 'agent', 'failed', JSON.stringify({ externalAgentType: 'kimi', taskTitle: '历史失败任务' }), '2026-09-16T00:00:00.000Z');
  db.close();

  const saved = process.env.EA_EXT_ACTIVE_SESSION;
  process.env.EA_EXT_ACTIVE_SESSION = writeActiveSessionFile({ sess_mine: Date.now() });
  try {
    /* 别处只有历史失败（终态）→ 不回退，保持本会话空态 */
    const quiet = JSON.parse(listAgentRuns({ limit: 10, includeFinished: false }, { dbPath }).text);
    assert.equal(quiet.status, 'empty');
    assert.equal(quiet.scope, 'session', '不应因为历史失败就回退');
    assert.equal(quiet.scopeFallback, undefined);

    /* 别处有正在运行的任务 → 回退，并说明有几个在跑 */
    const db2 = new DatabaseSync(dbPath);
    db2
      .prepare('INSERT INTO background_tasks (taskId, sessionId, toolName, status, metadata, startedAt) VALUES (?,?,?,?,?,?)')
      .run('task_1789829000000_run000', 'sess_other', 'agent', 'running', JSON.stringify({ externalAgentType: 'kimi', taskTitle: '正在跑的任务' }), '2026-09-19T13:29:27.432Z');
    db2.close();

    const busy = JSON.parse(listAgentRuns({ limit: 10, includeFinished: false }, { dbPath }).text);
    assert.equal(busy.scope, 'all');
    assert.equal(busy.scopeFallback.activeCount, 1);
    assert.match(busy.scopeFallback.reason, /有 1 个正在运行/);
    assert.ok(busy.runs.some((r) => r.taskId === 'task_1789829000000_run000'));
  } finally {
    if (saved === undefined) delete process.env.EA_EXT_ACTIVE_SESSION;
    else process.env.EA_EXT_ACTIVE_SESSION = saved;
  }
});
