'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  listExternalSessions,
  renameExternalSessions,
  autoNameSessions,
  restoreBackups,
} = require('../src/core/sessions');

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ea-sessions-test-'));
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

/** dim 任务库 fixture：taskId 前 13 位是毫秒时间戳（与会话创建时间对齐）。 */
function makeDimDb(home, tasks) {
  const file = path.join(home, '.dimcode', 'v2', 'dimcode.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE background_tasks (
    taskId TEXT PRIMARY KEY, sessionId TEXT, sourceRunId TEXT, sourceToolCallId TEXT,
    toolName TEXT, status TEXT, metadata TEXT, startedAt TEXT
  )`);
  const ins = db.prepare('INSERT INTO background_tasks VALUES (?,?,?,?,?,?,?,?)');
  for (const t of tasks) {
    ins.run(
      `task_${t.ts}_${t.suffix || 'abc123'}`,
      'sess_1',
      'run_1',
      'call_1',
      'agent',
      t.status || 'completed',
      JSON.stringify({ externalAgentType: t.agentType, taskTitle: t.title, subagentInput: { prompt: t.prompt || '' } }),
      iso(t.ts)
    );
  }
  db.close();
  return file;
}

/** codex fixture：session_index.jsonl + 当天 rollout 文件。 */
function makeCodex(home, { id, threadName, createdAt, updatedAt = createdAt, userText }) {
  const indexFile = path.join(home, '.codex', 'session_index.jsonl');
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  fs.appendFileSync(
    indexFile,
    `${JSON.stringify({ id, thread_name: threadName, updated_at: iso(updatedAt) })}\n`
  );
  if (createdAt !== undefined) {
    const d = new Date(createdAt);
    const p2 = (n) => String(n).padStart(2, '0');
    const dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
    const file = path.join(dir, `rollout-${iso(createdAt).replace(/[:.]/g, '-')}-${id}.jsonl`);
    const lines = [JSON.stringify({ type: 'session_meta', payload: { session_id: id, timestamp: iso(createdAt) } })];
    if (userText) {
      lines.push(JSON.stringify({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: userText }] } }));
    }
    write(file, `${lines.join('\n')}\n`);
  }
  return indexFile;
}

/**
 * codex rollout fixture（**不写索引**）：复现 dim 派发会话的真实处境——
 * dim 启动 codex 的方式不写 session_index.jsonl，所以这些会话只在 rollout 树里。
 */
function makeCodexRolloutOnly(home, { id, createdAt, userText, originator = 'dimcode', cwd = '/tmp/proj' }) {
  const d = new Date(createdAt);
  const p2 = (n) => String(n).padStart(2, '0');
  const dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
  const file = path.join(dir, `rollout-${iso(createdAt).replace(/[:.]/g, '-')}-${id}.jsonl`);
  const payload = { session_id: id, timestamp: iso(createdAt), cwd };
  if (originator !== null) payload.originator = originator;
  const lines = [JSON.stringify({ type: 'session_meta', payload })];
  if (userText) {
    lines.push(
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] } })
    );
  }
  write(file, `${lines.join('\n')}\n`);
  return file;
}

/** kimi fixture：session_index.jsonl + 会话目录 state.json。 */
function makeKimi(home, { id, createdAt, title = '', isCustomTitle = false, lastPrompt = '', archived = false }) {
  const dir = path.join(home, '.kimi-code', 'sessions', 'wd_proj_1', id);
  fs.mkdirSync(dir, { recursive: true });
  write(
    path.join(dir, 'state.json'),
    JSON.stringify({ id, createdAt, updatedAt: createdAt, title, isCustomTitle, lastPrompt, archived })
  );
  const indexFile = path.join(home, '.kimi-code', 'session_index.jsonl');
  fs.appendFileSync(indexFile, `${JSON.stringify({ sessionId: id, sessionDir: dir, workDir: '/tmp/proj' })}\n`);
  return dir;
}

/** cursor fixture：acp-sessions/<uuid>/meta.json。 */
function makeCursor(home, { id, cwd = '/tmp/proj', title }) {
  const dir = path.join(home, '.cursor', 'acp-sessions', id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { schemaVersion: 1, cwd };
  if (title !== undefined) meta.title = title;
  write(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return dir;
}

/** grok fixture：搜索索引 sqlite + 会话目录 summary.json。 */
function makeGrok(home, { id, cwd = '/tmp/proj', title = '', content = '', createdAt }) {
  const file = path.join(home, '.grok', 'sessions', 'session_search.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS session_docs (session_id TEXT, cwd TEXT, updated_at INTEGER, title TEXT, content TEXT, content_hash TEXT)');
  db.prepare('INSERT INTO session_docs VALUES (?,?,?,?,?,?)').run(id, cwd, Math.round(createdAt / 1000), title, content, 'h');
  db.close();
  const dir = path.join(home, '.grok', 'sessions', encodeURIComponent(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  write(path.join(dir, 'summary.json'), JSON.stringify({ info: { id, cwd }, session_summary: title, created_at: iso(createdAt), updated_at: iso(createdAt) }));
  return dir;
}

/** opencode fixture：session / message / part 三表（内容在 data JSON 列里）。 */
function makeOpencode(home, { id, title, createdAt, directory = '/tmp/proj', firstUserText }) {
  const file = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
  `);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?)').run(id, 'p1', null, 'curious-circuit', directory, title, createdAt, createdAt);
  if (firstUserText) {
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(`msg_${id}`, id, createdAt, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(`prt_${id}`, `msg_${id}`, id, createdAt, JSON.stringify({ type: 'text', text: firstUserText }));
  }
  db.close();
  return file;
}

/** zcode fixture：CLI 会话库（权威）+ 桌面任务索引（空/仅展示）。 */
function makeZcode(home, { id, title, createdAt, titleSource = 'first_input' }) {
  const file = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT,
    time_created INTEGER, time_updated INTEGER, time_archived INTEGER, title_source TEXT, time_title_updated INTEGER
  )`);
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
    id,
    'p1',
    null,
    'slug',
    '/tmp/proj',
    title,
    createdAt,
    createdAt,
    null,
    titleSource,
    null
  );
  db.close();
  return file;
}

/** zcode 桌面 app 的任务索引（当前 0 行的场景；仅展示，不支持回写）。 */
function makeZcodeDesktop(home, { id, title, createdAt }) {
  const file = path.join(home, '.zcode', 'v2', 'tasks-index.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    workspace_key TEXT, workspace_path TEXT, task_id TEXT, title TEXT, task_status TEXT,
    title_overridden INTEGER, created_at INTEGER, updated_at INTEGER, archived INTEGER, deleted INTEGER
  )`);
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('wk', '/tmp/proj', id, title, 'done', 0, createdAt, createdAt, 0, 0);
  db.close();
  return file;
}

const T0 = Date.parse('2026-09-19T04:31:14.000Z');

/** 一个包含全部 6 个 agent 的标准 fixture。 */
function makeFullHome() {
  const home = mkHome();
  const dimDb = makeDimDb(home, [
    { ts: T0, agentType: 'kimi', title: '修复 GUO-108 审查问题（P0/P1/P2）' },
    { ts: T0 + 3600_000, agentType: 'cursor', title: '审查 PR #121' },
    { ts: T0 + 7200_000, agentType: 'kimi', title: 'custom 会话的 dim 标题' },
  ]);
  makeCodex(home, { id: '01a0b7ee-a483-7a70-835b-78b7f93349e7', threadName: '维护本地 skill', createdAt: T0 });
  makeCodex(home, { id: '01a0b800-0000-7000-8000-000000000001', threadName: 'Help', createdAt: T0 + 60_000, userText: '修复播放器崩溃问题' });
  makeKimi(home, { id: 'session_a2ec3bc2-153b-4452-9471-a02c55c9d136', createdAt: T0, title: '你是实现者', lastPrompt: '随便' });
  makeKimi(home, {
    id: 'session_b0000000-0000-4000-8000-000000000002',
    createdAt: T0 + 7200_000,
    title: '我自己取的名字',
    isCustomTitle: true,
  });
  makeCursor(home, { id: 'a887ba64-5302-4bce-b30c-b8e3ddfb94ba', title: 'Code Review Agent', cwd: '/tmp/proj' });
  makeGrok(home, { id: '01a0a3e0-b3e2-7201-a40f-68518c19c3e8', title: 'tech-events 呈批', createdAt: T0 });
  makeOpencode(home, {
    id: 'ses_f55708c27ffesc7SG7k5MdEPo4',
    title: 'New session - 2026-09-16T14:12:03.160Z',
    createdAt: T0,
    firstUserText: '独立审查 PR #53：SRT/VTT 导出',
  });
  makeZcode(home, { id: 'sess_acc1e1ad-2b5a-4e2e-bd4d-7bff53baf05e', title: 'zcode 会话标题', createdAt: T0 });
  makeZcodeDesktop(home, { id: 'task_z1', title: 'zcode 桌面任务', createdAt: T0 });
  return { home, dimDb };
}

/* ------------------------------ 清单与命名 ------------------------------- */

test('listExternalSessions：列出全部 6 个 agent 的会话并给出统一展示名', () => {
  const { home, dimDb } = makeFullHome();
  const res = listExternalSessions({ home, dbPath: dimDb, limit: 50 });
  const agents = new Set(res.sessions.map((s) => s.agentType));
  for (const a of ['codex', 'kimi', 'cursor', 'grok', 'opencode', 'zcode']) {
    assert.ok(agents.has(a), `缺少 ${a} 的会话`);
  }
  assert.equal(res.status, 'ok');
  assert.ok(res.total >= 8);
  for (const s of res.sessions) {
    assert.match(s.displayName, /^\[[a-z]+\] \d{2}-\d{2} \d{2}:\d{2} · .+/, `展示名格式不对：${s.displayName}`);
    assert.equal(typeof s.key, 'string');
    assert.ok(s.key.startsWith(`${s.agentType}:`));
  }
});

test('命名优先级：dim 任务标题 > 会话自身标题 > prompt > 兜底', () => {
  const { home, dimDb } = makeFullHome();
  const res = listExternalSessions({ home, dbPath: dimDb, limit: 50 });
  const by = (k) => res.sessions.find((s) => s.key === k);

  /* dim 任务标题优先（kimi 会话创建时间与任务时间戳一致） */
  const kimi = by('kimi:session_a2ec3bc2-153b-4452-9471-a02c55c9d136');
  assert.equal(kimi.title, '修复 GUO-108 审查问题（P0/P1/P2）');
  assert.equal(kimi.titleSource, 'dim-task');
  assert.equal(kimi.dimTask.taskId, `task_${T0}_abc123`);

  /* 会话自身标题 */
  const codex = by('codex:01a0b7ee-a483-7a70-835b-78b7f93349e7');
  assert.equal(codex.title, '维护本地 skill');
  assert.equal(codex.titleSource, 'session');

  /* 自身标题泛化（Help）→ 用 rollout 首条 user 消息 */
  const codexHelp = by('codex:01a0b800-0000-7000-8000-000000000001');
  assert.equal(codexHelp.title, '修复播放器崩溃问题');
  assert.equal(codexHelp.titleSource, 'prompt');

  /* 自身标题泛化（New session - ISO）→ 用 opencode 首条 user 消息 */
  const oc = by('opencode:ses_f55708c27ffesc7SG7k5MdEPo4');
  assert.equal(oc.title, '独立审查 PR #53：SRT/VTT 导出');
  assert.equal(oc.titleSource, 'prompt');

  /* grok 自身标题可用 */
  const grok = by('grok:01a0a3e0-b3e2-7201-a40f-68518c19c3e8');
  assert.equal(grok.title, 'tech-events 呈批');
});

test('codex：创建时间取 rollout 的 session_meta，而不是 updated_at', () => {
  const { home, dimDb } = makeFullHome();
  const res = listExternalSessions({ home, dbPath: dimDb, limit: 50 });
  const codex = res.sessions.find((s) => s.key === 'codex:01a0b7ee-a483-7a70-835b-78b7f93349e7');
  assert.equal(codex.createdAt, iso(T0));
  assert.equal(codex.titleSource, 'session');
});

test('codex：索引里没有的 dim 派发会话 → 从 rollout 树补回并关联到 dim 任务', () => {
  const home = mkHome();
  const ts = Date.parse('2026-09-21T06:17:45.226Z');
  const prompt = '实现 Linear GUO-134：左缘裁切原子提交，这段描述是独特的。';
  const dimDb = makeDimDb(home, [{ ts, agentType: 'codex', title: '实现 GUO-134 左缘裁切原子提交', prompt }]);
  const id = '01a0c29d-18c6-79b1-a71f-fdf368a108db';
  /* 只建 rollout、不写索引 —— dim 派发的 codex 会话就是这样（本机 31/31 都不在索引里） */
  makeCodexRolloutOnly(home, { id, createdAt: ts + 5354, userText: prompt });

  const res = listExternalSessions({ home, dbPath: dimDb });
  const s = res.sessions.find((x) => x.sessionId === id);
  assert.ok(s, '索引里没有的 dim 派发会话也必须出现在列表里');
  assert.equal(s.source, 'dim');
  assert.equal(s.dimTask.taskTitle, '实现 GUO-134 左缘裁切原子提交');
  assert.equal(s.indexMissing, true);
  assert.equal(s.title, '实现 GUO-134 左缘裁切原子提交');
  assert.ok(res.warnings.some((w) => w.code === 'codex_index_gap'), '应显式告警索引缺口');
});

test('codex：用户自建会话（originator 非 dimcode）不会被当成 dim 派发补进来', () => {
  const home = mkHome();
  const ts = Date.parse('2026-09-21T06:17:45.226Z');
  const dimDb = makeDimDb(home, []);
  makeCodexRolloutOnly(home, { id: '01a0ffff-0000-7000-8000-000000000001', createdAt: ts, originator: 'Codex Desktop', userText: '手动开的会话' });
  const res = listExternalSessions({ home, dbPath: dimDb });
  assert.equal(res.sessions.filter((s) => s.agentType === 'codex').length, 0, '没有 dim 任务时不应凭空补会话');
});

test('codex：索引里没有的会话 → rename 追加索引条目（而不是报「已是目标名称」）', () => {
  const home = mkHome();
  const ts = Date.parse('2026-09-21T06:17:45.226Z');
  const prompt = '实现 Linear GUO-134：左缘裁切原子提交，这段描述是独特的。';
  const dimDb = makeDimDb(home, [{ ts, agentType: 'codex', title: '实现 GUO-134 左缘裁切原子提交', prompt }]);
  const id = '01a0c29d-18c6-79b1-a71f-fdf368a108db';
  makeCodexRolloutOnly(home, { id, createdAt: ts + 5354, userText: prompt });
  const key = `codex:${id}`;
  /* 真实处境：索引文件存在（codex 一直在写），只是里面没有这条会话 */
  const indexFile = path.join(home, '.codex', 'session_index.jsonl');
  write(indexFile, '');

  const dry = renameExternalSessions({ home, dbPath: dimDb, keys: [key] });
  assert.equal(dry.results[0].status, 'planned', 'dry-run 应显示待改名，而不是 skipped');

  const applied = renameExternalSessions({ home, dbPath: dimDb, keys: [key], apply: true });
  assert.equal(applied.results[0].status, 'renamed');
  assert.equal(applied.results[0].appended, true);

  const lines = fs
    .readFileSync(indexFile, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const added = lines.find((l) => l.id === id);
  assert.ok(added, '索引里应追加该会话的条目');
  assert.match(added.thread_name, /GUO-134/);
  assert.ok(typeof added.updated_at === 'string' && added.updated_at.length > 0);

  /* 再跑一次：这次条目已存在，应该是 skipped（理由才真的成立） */
  const again = renameExternalSessions({ home, dbPath: dimDb, keys: [key], apply: true });
  assert.equal(again.results[0].status, 'skipped');

  /* 追加可回滚 */
  const restored = restoreBackups({ home, apply: true });
  assert.equal(restored.summary.restored, 1);
  const after = fs.readFileSync(indexFile, 'utf8');
  assert.ok(!after.includes(id), '回滚后索引里不应再有追加的条目');
});

test('自定义标题（kimi isCustomTitle）被标记出来', () => {
  const { home, dimDb } = makeFullHome();
  const res = listExternalSessions({ home, dbPath: dimDb, limit: 50 });
  const custom = res.sessions.find((s) => s.sessionId === 'session_b0000000-0000-4000-8000-000000000002');
  assert.equal(custom.customTitle, true);
  /* dim 任务标题仍然优先用于展示（用户自己的标题只在回写时被保护） */
  assert.equal(custom.title, 'custom 会话的 dim 标题');
  assert.equal(custom.titleSource, 'dim-task');
});

test('过滤：agentType / search / since / limit+total', () => {
  const { home, dimDb } = makeFullHome();
  assert.ok(listExternalSessions({ home, dbPath: dimDb, agentType: 'kimi' }).sessions.every((s) => s.agentType === 'kimi'));
  assert.ok(listExternalSessions({ home, dbPath: dimDb, agentType: 'kimi,codex' }).sessions.every((s) => ['kimi', 'codex'].includes(s.agentType)));
  const searched = listExternalSessions({ home, dbPath: dimDb, search: 'SRT' });
  assert.equal(searched.sessions.length, 1);
  const since = listExternalSessions({ home, dbPath: dimDb, since: iso(T0 + 3600_000) });
  assert.ok(since.sessions.every((s) => Date.parse(s.createdAt) >= T0 + 3600_000));
  const limited = listExternalSessions({ home, dbPath: dimDb, limit: 2 });
  assert.equal(limited.count, 2);
  assert.ok(limited.total > 2);
});

test('容错：空 home 不崩、dim 库缺失只给 warning', () => {
  const empty = mkHome();
  const res = listExternalSessions({ home: empty, limit: 10 });
  assert.equal(res.status, 'empty');
  assert.deepEqual(res.sessions, []);
  assert.ok(res.warnings.some((w) => w.code === 'db_unavailable'));
});

/* --------------------------------- 改名 --------------------------------- */

test('rename：默认只出计划（dry-run），不写任何文件', () => {
  const { home, dimDb } = makeFullHome();
  const dir = path.join(home, '.kimi-code', 'sessions', 'wd_proj_1', 'session_a2ec3bc2-153b-4452-9471-a02c55c9d136');
  const before = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
  const plan = renameExternalSessions({ home, dbPath: dimDb, keys: ['kimi:session_a2ec3bc2-153b-4452-9471-a02c55c9d136'] });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.summary.planned, 1);
  assert.equal(plan.summary.renamed, 0);
  assert.equal(plan.results[0].next, '[dim] 修复 GUO-108 审查问题（P0/P1/P2）');
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), before);
});

test('rename：apply 写回 kimi state.json 并留备份，重复 apply 幂等跳过', () => {
  const { home, dimDb } = makeFullHome();
  const key = 'kimi:session_a2ec3bc2-153b-4452-9471-a02c55c9d136';
  const dir = path.join(home, '.kimi-code', 'sessions', 'wd_proj_1', 'session_a2ec3bc2-153b-4452-9471-a02c55c9d136');
  const applied = renameExternalSessions({ home, dbPath: dimDb, keys: [key], apply: true });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.summary.renamed, 1);
  assert.ok(applied.results[0].backupPath && fs.existsSync(applied.results[0].backupPath));
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.equal(state.title, '[dim] 修复 GUO-108 审查问题（P0/P1/P2）');
  assert.equal(state.isCustomTitle, true);
  assert.equal(state.createdAt, T0); // 其它字段保留

  const again = renameExternalSessions({ home, dbPath: dimDb, keys: [key], apply: true });
  assert.equal(again.summary.skipped, 1);
  assert.equal(again.summary.renamed, 0);
});

test('rename：apply 写回 cursor meta.json 且保留其它字段', () => {
  const { home, dimDb } = makeFullHome();
  const key = 'cursor:a887ba64-5302-4bce-b30c-b8e3ddfb94ba';
  const res = renameExternalSessions({ home, dbPath: dimDb, keys: [key], apply: true, titleOverride: '统一命名测试' });
  assert.equal(res.summary.renamed, 1);
  assert.ok(res.results[0].backupPath && fs.existsSync(res.results[0].backupPath));
  const meta = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'acp-sessions', 'a887ba64-5302-4bce-b30c-b8e3ddfb94ba', 'meta.json'), 'utf8'));
  assert.equal(meta.title, '统一命名测试');
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.cwd, '/tmp/proj');
});

test('rename：显式改名会补上来源标记，名称已是目标名时幂等跳过', () => {
  const { home, dimDb } = makeFullHome();
  const key = 'cursor:a887ba64-5302-4bce-b30c-b8e3ddfb94ba';
  /* 第一次：这条会话没有 dim 任务关联 → 来源标记为 [手动] */
  const first = renameExternalSessions({ home, dbPath: dimDb, keys: [key], apply: true });
  assert.equal(first.summary.renamed, 1);
  assert.equal(first.results[0].next, '[手动] Code Review Agent');
  /* 第二次：现状已等于目标名 → 跳过，不产生多余写入 */
  const again = renameExternalSessions({ home, dbPath: dimDb, keys: [key], apply: true });
  assert.equal(again.summary.renamed, 0);
  assert.equal(again.summary.skipped, 1);
  /* sourcePrefix:false 时不加标记 */
  const plain = renameExternalSessions({
    home,
    dbPath: dimDb,
    keys: [key],
    apply: true,
    titleOverride: undefined,
    sourcePrefix: false,
  });
  assert.equal(plain.results[0].next, 'Code Review Agent');
});

test('rename：apply 写回 codex session_index.jsonl 且保留其它行', () => {
  const { home, dimDb } = makeFullHome();
  const res = renameExternalSessions({
    home,
    dbPath: dimDb,
    keys: ['codex:01a0b800-0000-7000-8000-000000000001'],
    apply: true,
  });
  assert.equal(res.summary.renamed, 1);
  const lines = fs
    .readFileSync(path.join(home, '.codex', 'session_index.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines.find((l) => l.id === '01a0b800-0000-7000-8000-000000000001').thread_name, '[手动] 修复播放器崩溃问题');
  assert.equal(lines.find((l) => l.id === '01a0b7ee-a483-7a70-835b-78b7f93349e7').thread_name, '维护本地 skill');
});

test('rename：用户自定义标题默认跳过，force 才改', () => {
  const { home, dimDb } = makeFullHome();
  const key = 'kimi:session_b0000000-0000-4000-8000-000000000002';
  const stateFile = path.join(home, '.kimi-code', 'sessions', 'wd_proj_1', 'session_b0000000-0000-4000-8000-000000000002', 'state.json');
  const skipped = renameExternalSessions({ home, dbPath: dimDb, keys: [key], apply: true });
  assert.equal(skipped.summary.skipped, 1);
  assert.match(skipped.results[0].reason, /自己设置/);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).title, '我自己取的名字');

  const forced = renameExternalSessions({ home, dbPath: dimDb, keys: [key], apply: true, force: true });
  assert.equal(forced.summary.renamed, 1);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).title, '[dim] custom 会话的 dim 标题');
});

test('rename：显式 title 覆盖；未知 key 报 not_found；无 keys 报 bad_arguments', () => {
  const { home, dimDb } = makeFullHome();
  const key = 'codex:01a0b7ee-a483-7a70-835b-78b7f93349e7';
  const res = renameExternalSessions({ home, dbPath: dimDb, keys: [key], apply: true, titleOverride: '统一命名测试' });
  assert.equal(res.summary.renamed, 1);
  assert.equal(res.results[0].next, '统一命名测试');
  const lines = fs
    .readFileSync(path.join(home, '.codex', 'session_index.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(lines.find((l) => l.id === '01a0b7ee-a483-7a70-835b-78b7f93349e7').thread_name, '统一命名测试');

  const missing = renameExternalSessions({ home, dbPath: dimDb, keys: ['kimi:nope'] });
  assert.equal(missing.results[0].status, 'not_found');
  const none = renameExternalSessions({ home, dbPath: dimDb });
  assert.equal(none.status, 'bad_arguments');
});

test('rename：sqlite 型 agent 现在也支持回写（grok summary.json / opencode / zcode）', () => {
  const { home, dimDb } = makeFullHome();

  /* grok：写 summary.json 的 generated_title + session_summary，并置 title_is_manual */
  const grokKey = 'grok:01a0a3e0-b3e2-7201-a40f-68518c19c3e8';
  const grokPlan = renameExternalSessions({ home, dbPath: dimDb, keys: [grokKey], titleOverride: 'grok 统一名称' });
  assert.equal(grokPlan.summary.planned, 1);
  const grokRes = renameExternalSessions({ home, dbPath: dimDb, keys: [grokKey], apply: true, titleOverride: 'grok 统一名称' });
  assert.equal(grokRes.summary.renamed, 1);
  const summaryFile = path.join(home, '.grok', 'sessions', encodeURIComponent('/tmp/proj'), '01a0a3e0-b3e2-7201-a40f-68518c19c3e8', 'summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  assert.equal(summary.generated_title, 'grok 统一名称');
  assert.equal(summary.session_summary, 'grok 统一名称');
  assert.equal(summary.title_is_manual, true);
  assert.equal(summary.created_at, iso(T0)); /* 其它字段保留 */

  /* opencode：UPDATE session.title，备份记录到备份目录 */
  const ocKey = 'opencode:ses_f55708c27ffesc7SG7k5MdEPo4';
  const ocRes = renameExternalSessions({ home, dbPath: dimDb, keys: [ocKey], apply: true });
  assert.equal(ocRes.summary.renamed, 1);
  assert.ok(ocRes.results[0].backupPath && fs.existsSync(ocRes.results[0].backupPath));
  const ocDb = new DatabaseSync(path.join(home, '.local', 'share', 'opencode', 'opencode.db'), { readOnly: true });
  assert.equal(ocDb.prepare('SELECT title FROM session WHERE id = ?').get('ses_f55708c27ffesc7SG7k5MdEPo4').title, '[手动] 独立审查 PR #53：SRT/VTT 导出');
  ocDb.close();

  /* zcode：UPDATE session.title + title_source='custom' */
  const zKey = 'zcode:sess_acc1e1ad-2b5a-4e2e-bd4d-7bff53baf05e';
  const zRes = renameExternalSessions({ home, dbPath: dimDb, keys: [zKey], apply: true, titleOverride: 'zcode 统一名称' });
  assert.equal(zRes.summary.renamed, 1);
  const zDb = new DatabaseSync(path.join(home, '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true });
  const zRow = zDb.prepare('SELECT title, title_source FROM session WHERE id = ?').get('sess_acc1e1ad-2b5a-4e2e-bd4d-7bff53baf05e');
  assert.equal(zRow.title, 'zcode 统一名称');
  assert.equal(zRow.title_source, 'custom');
  zDb.close();
});

test('rename：zcode 桌面任务索引不是会话表 → 明确 unsupported', () => {
  const { home, dimDb } = makeFullHome();
  const res = renameExternalSessions({ home, dbPath: dimDb, keys: ['zcode:task_z1'], apply: true });
  assert.equal(res.summary.unsupported, 1);
  assert.match(res.results[0].reason, /仅作展示/);
});

test('rename：同 agent 内重名时回写名追加日期', () => {
  const home = mkHome();
  const dimDb = makeDimDb(home, []);
  makeKimi(home, { id: 'session_c0000000-0000-4000-8000-00000000000a', createdAt: T0, title: 'New session' });
  makeKimi(home, { id: 'session_c0000000-0000-4000-8000-00000000000b', createdAt: T0 + 86400_000, title: 'New session' });
  const listed = listExternalSessions({ home, dbPath: dimDb });
  assert.equal(listed.sessions.length, 2);
  const plan = renameExternalSessions({ home, dbPath: dimDb, keys: listed.sessions.map((s) => s.key) });
  assert.equal(plan.summary.planned, 2);
  assert.notEqual(plan.results[0].next, plan.results[1].next, '重名会话应被日期区分');
  for (const r of plan.results) assert.match(r.next, /未命名会话|New session/);
});

/* ------------------------- 来源标记与全自动命名 -------------------------- */

test('listExternalSessions：标出来源（dim 委托 / 其它）与统一名', () => {
  const { home, dimDb } = makeFullHome();
  const res = listExternalSessions({ home, dbPath: dimDb, limit: 50 });
  const kimi = res.sessions.find((s) => s.key === 'kimi:session_a2ec3bc2-153b-4452-9471-a02c55c9d136');
  assert.equal(kimi.source, 'dim');
  assert.equal(kimi.unifiedName, '[dim] 修复 GUO-108 审查问题（P0/P1/P2）');
  /* 展示名里的时间是本地时区渲染的 —— 只断言格式，别把测试绑死在某个时区 */
  assert.match(kimi.displayName, /^\[kimi\] \d{2}-\d{2} \d{2}:\d{2} · \[dim\] 修复 GUO-108 审查问题（P0\/P1\/P2）$/);

  const codex = res.sessions.find((s) => s.key === 'codex:01a0b7ee-a483-7a70-835b-78b7f93349e7');
  assert.equal(codex.source, 'manual');
  assert.equal(codex.unifiedName, '[手动] 维护本地 skill');
  assert.match(codex.displayName, /^\[codex\] \d{2}-\d{2} \d{2}:\d{2} · \[手动\] 维护本地 skill$/);
});

test('listExternalSessions：delegated 标出「由某个编排器拉起」（用于解释非 dim 来源）', () => {
  const home = mkHome();
  const dimDb = makeDimDb(home, []);
  makeKimi(home, {
    id: 'session_d0000000-0000-4000-8000-00000000000d',
    createdAt: T0,
    title: 'You are an agent handling a delegated task. Focus on the task.',
  });
  const res = listExternalSessions({ home, dbPath: dimDb });
  const s = res.sessions[0];
  assert.equal(s.source, 'manual', '没有 dim 任务关联 → 来源是「其它」');
  assert.equal(s.delegated, true, '但能识别出这是被委托拉起的会话');
});

test('autoNameSessions：只改「dim 委托 + 原标题泛化」，dry-run 不写入', () => {
  const { home, dimDb } = makeFullHome();
  const stateFile = path.join(
    home,
    '.kimi-code',
    'sessions',
    'wd_proj_1',
    'session_a2ec3bc2-153b-4452-9471-a02c55c9d136',
    'state.json'
  );
  const before = fs.readFileSync(stateFile, 'utf8');
  const now = new Date(T0 + 5 * 60 * 1000); // 任务时间戳 + 5 分钟（窗口内）

  const dry = autoNameSessions({ home, dbPath: dimDb, apply: false, now });
  assert.equal(dry.renamed, 0);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.ok(dry.results.some((r) => r.status === 'planned' && r.key.startsWith('kimi:')));

  const applied = autoNameSessions({ home, dbPath: dimDb, now });
  assert.equal(applied.renamed, 1);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).title, '[dim] 修复 GUO-108 审查问题（P0/P1/P2）');
  /* 名称已够好 / 无 dim 关联的会话不动 */
  const cursor = JSON.parse(
    fs.readFileSync(path.join(home, '.cursor', 'acp-sessions', 'a887ba64-5302-4bce-b30c-b8e3ddfb94ba', 'meta.json'), 'utf8')
  );
  assert.equal(cursor.title, 'Code Review Agent');
});

test('autoNameSessions：alreadyNamed 里的任务不再处理；窗口外不回溯', () => {
  const { home, dimDb } = makeFullHome();
  const key = 'kimi:session_a2ec3bc2-153b-4452-9471-a02c55c9d136';
  const now = new Date(T0 + 5 * 60 * 1000);
  const first = autoNameSessions({ home, dbPath: dimDb, apply: false, now });
  const taskIds = first.results.map((r) => r.taskId);
  assert.ok(taskIds.length > 0);

  const skipped = autoNameSessions({ home, dbPath: dimDb, apply: false, now, alreadyNamed: new Set(taskIds) });
  assert.equal(skipped.considered, 0, '已处理过的任务不再考察');

  const old = autoNameSessions({ home, dbPath: dimDb, apply: false, now: new Date(T0 + 5 * 60 * 60 * 1000) });
  assert.equal(old.considered, 0, '超出窗口的老任务不回溯');
  assert.ok(key.length > 0);
});

/* ------------------------------- 排版与回滚 ------------------------------- */

test('rename：保持原文件排版（压缩单行仍是单行，不重排用户的文件）', () => {
  const { home, dimDb } = makeFullHome();
  const stateFile = path.join(
    home,
    '.kimi-code',
    'sessions',
    'wd_proj_1',
    'session_a2ec3bc2-153b-4452-9471-a02c55c9d136',
    'state.json'
  );
  assert.ok(!fs.readFileSync(stateFile, 'utf8').includes('\n'), 'fixture 原文件是压缩单行');
  renameExternalSessions({ home, dbPath: dimDb, keys: ['kimi:session_a2ec3bc2-153b-4452-9471-a02c55c9d136'], apply: true });
  const after = fs.readFileSync(stateFile, 'utf8');
  assert.ok(!after.includes('\n'), '改名后仍是单行');
  assert.equal(JSON.parse(after).title, '[dim] 修复 GUO-108 审查问题（P0/P1/P2）');
});

test('restore：默认只预览；apply 后按备份字节还原', () => {
  const { home, dimDb } = makeFullHome();
  const key = 'kimi:session_a2ec3bc2-153b-4452-9471-a02c55c9d136';
  const stateFile = path.join(
    home,
    '.kimi-code',
    'sessions',
    'wd_proj_1',
    'session_a2ec3bc2-153b-4452-9471-a02c55c9d136',
    'state.json'
  );
  const original = fs.readFileSync(stateFile, 'utf8');
  const renamed = renameExternalSessions({ home, dbPath: dimDb, keys: [key], apply: true });
  assert.equal(renamed.summary.renamed, 1);
  assert.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).title.startsWith('[dim] '));

  const preview = restoreBackups({ home });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.summary.planned, 1);
  assert.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).title.startsWith('[dim] '), '预览不写入');

  const applied = restoreBackups({ home, apply: true });
  assert.equal(applied.summary.restored, 1);
  assert.equal(fs.readFileSync(stateFile, 'utf8'), original, '按备份字节还原');
});

test('restore：数据库行级备份只报告不自动写库；无备份时给出明确状态', () => {
  const home = mkHome();
  const dir = path.join(home, '.dimcode', 'ea-extend-backups', '20260919-010203');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opencode-session-ses_x.json'), `${JSON.stringify({ id: 'ses_x', title: '旧名' })}\n`);
  const res = restoreBackups({ home, apply: true });
  assert.equal(res.summary.manual, 1);
  assert.match(res.results[0].reason, /行级备份/);

  const empty = mkHome();
  const none = restoreBackups({ home: empty });
  assert.equal(none.status, 'no_backup');
});
