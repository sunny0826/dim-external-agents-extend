'use strict';

/**
 * cursor 适配器测试（T1.4）。
 *
 * 覆盖两类用例：
 * A. **合成 store.db**（可控、可复现）：用最小 protobuf 写入器 + sha256 内容寻址，
 *    构造与真实会话同形的库，验证顺序恢复、事件归一化、tool 状态、游标（tail / reset /
 *    invalid）、以及各类降级路径（meta 缺失、root 缺失、无快照、库损坏、ref 非法）。
 * B. **真实样本**（本机 `~/.cursor/acp-sessions/*`，只读）：断言能产出完整事件数组、
 *    meta.adapter === 'cursor'、不崩；无样本时自动跳过（CI/其它机器友好）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { readEvents } = require('../src/core/adapters/cursor');
const { EVENT_KINDS } = require('../src/core/events');

const KIND_SET = new Set(EVENT_KINDS);
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-adapter-test-'));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/* --------------------------- 合成库写入工具 --------------------------- */

function varint(n) {
  const out = [];
  let v = BigInt(n);
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

/** protobuf: 一个 length-delimited 字段（field# + len + payload）。 */
function ld(field, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([varint((field << 3) | 2), varint(buf.length), buf]);
}

/** protobuf: 一个 varint 字段。 */
function vint(field, value) {
  return Buffer.concat([varint(field << 3), varint(value)]);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

/** 快照 blob：field#1 = 有序消息列表，field#3 = 计划项，field#5 = 用量，field#9 = cwd。 */
function buildSnapshot({ messageIds, planIds = [], usage = null, cwd = null }) {
  const parts = messageIds.map((id) => ld(1, Buffer.from(id, 'hex')));
  for (const id of planIds) parts.push(ld(3, Buffer.from(id, 'hex')));
  if (usage) parts.push(ld(5, usage));
  if (cwd) parts.push(ld(9, Buffer.from(cwd, 'utf8')));
  return Buffer.concat(parts);
}

/** 计划项节点：{#1 id, #2 content, #3 statusRaw, #4 createdMs, #5 updatedMs}。 */
function buildPlanItem({ id, content, statusRaw = 3, createdMs = 1000, updatedMs = 2000 }) {
  return Buffer.concat([
    ld(1, Buffer.from(String(id), 'utf8')),
    ld(2, Buffer.from(content, 'utf8')),
    vint(3, statusRaw),
    vint(4, createdMs),
    vint(5, updatedMs),
  ]);
}

function buildUsage({ used, limit, entries }) {
  const parts = [vint(1, used), vint(2, limit)];
  for (const e of entries) {
    parts.push(
      ld(3, Buffer.concat([ld(1, Buffer.from(e.id, 'utf8')), ld(2, Buffer.from(e.label, 'utf8')), vint(3, e.a), vint(4, e.b)]))
    );
  }
  return Buffer.concat(parts);
}

/**
 * 写一个与真实 cursor 会话同形的 store.db。
 * blobs 内容寻址：id = sha256(data)，与真实库一致（适配器不校验 hash，但保持一致便于对照）。
 */
function writeStore(dir, { messages, snapshot, extraBlobs = [], snapshotId = null, metaValue }) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'store.db'));
  db.exec('create table blobs (id text primary key, data blob)');
  db.exec('create table meta (key text primary key, value text)');
  const insertBlob = db.prepare('insert into blobs (id, data) values (?, ?)');
  const ids = [];
  for (const msg of messages) {
    const data = Buffer.from(JSON.stringify(msg), 'utf8');
    const id = sha256(data).toString('hex');
    insertBlob.run(id, data);
    ids.push(id);
  }
  for (const blob of extraBlobs) insertBlob.run(blob.id, blob.data);

  const snapshotBuf = typeof snapshot === 'function' ? snapshot(ids) : snapshot;
  const snapId = snapshotBuf ? snapshotId || sha256(snapshotBuf).toString('hex') : null;
  if (snapshotBuf) insertBlob.run(snapId, snapshotBuf);

  const meta = metaValue === undefined ? JSON.stringify({ agentId: 'synthetic', latestRootBlobId: snapId, name: 'Synthetic Session' }) : metaValue;
  if (meta !== null) {
    const insertMeta = db.prepare('insert into meta (key, value) values (?, ?)');
    insertMeta.run('0', typeof meta === 'string' ? Buffer.from(meta, 'utf8').toString('hex') : JSON.stringify(meta).toString('hex'));
  }
  db.close();
  return { dir, ids, snapshotId: snapId };
}

const assistantMsg = (parts, id = 'msg_1') => ({
  role: 'assistant',
  content: parts,
  id,
  providerOptions: { cursor: { modelProviderMessageId: id } },
});

const toolMsg = (toolCallId, toolName, result, { isError = false, errorMessages } = {}) => ({
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId, toolName, result }],
  id: toolCallId,
  providerOptions: {
    cursor: {
      highLevelToolCallResult: {
        output: isError ? { error: { message: String(result) } } : { success: { content: String(result) } },
        isError,
        ...(errorMessages === undefined ? {} : { rawErrorMessages: errorMessages }),
      },
    },
  },
});

const kindsOf = (events) => events.map((e) => e.kind);
const refOf = (dir) => ({ adapter: 'cursor', kind: 'dir', path: dir, id: path.basename(dir) });

test('合成会话：顺序恢复 + 事件归一化（无降级）', () => {
  const dir = makeTempDir();
  const messages = [
    { role: 'system', content: 'You are an agent handling a delegated task.' },
    { role: 'user', content: '<user_info>\nOS Version: darwin\nWorkspace Path: /tmp/x' },
    { role: 'user', content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>do the thing</user_query>' }] },
    assistantMsg([
      { type: 'reasoning', text: '', signature: 'encrypted', providerOptions: { cursor: { modelName: 'cursor-grok-4.6' } } },
      { type: 'text', text: 'working on it' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'Read', args: { path: '/tmp/a' } },
    ]),
    toolMsg('call-1', 'Read', 'file contents'),
    assistantMsg([{ type: 'tool-call', toolCallId: 'call-2', toolName: 'Shell', args: { command: 'false' } }], 'msg_2'),
    toolMsg('call-2', 'Shell', 'boom', { isError: true, errorMessages: 'exit 1' }),
    assistantMsg([{ type: 'text', text: 'done' }], 'msg_3'),
  ];
  const store = writeStore(dir, {
    messages,
    snapshot: (ids) =>
      buildSnapshot({
        messageIds: ids,
        cwd: 'file:///tmp/workspace',
        usage: buildUsage({ used: 10, limit: 100, entries: [{ id: 'tools', label: 'Tool definitions', a: 20, b: 60 }] }),
      }),
  });
  const result = readEvents(refOf(dir));

  assert.equal(result.meta.adapter, 'cursor');
  assert.equal(result.meta.degraded, false, `不应有 warning：${JSON.stringify(result.meta.warnings)}`);
  assert.deepEqual(kindsOf(result.events), [
    'meta',
    'notice',
    'notice',
    'text',
    'text',
    'tool_call',
    'tool_result',
    'tool_call',
    'tool_result',
    'text',
  ]);
  for (const ev of result.events) {
    assert.equal(typeof ev.seq, 'number');
    assert.ok(KIND_SET.has(ev.kind), `非法 kind: ${ev.kind}`);
    assert.ok(ev.ts === null || typeof ev.ts === 'string', '消息无时间戳应为 null');
  }
  // seq 为批次内 0..n-1
  result.events.forEach((ev, i) => assert.equal(ev.seq, i));

  const [sys, info, user, aText, call1, res1, call2, res2, aDone] = result.events.slice(1);
  assert.equal(sys.name, 'system');
  assert.equal(info.name, 'user_info');
  assert.equal(user.name, 'user');
  assert.equal(user.detail.userQuery, 'do the thing');
  assert.equal(aText.name, 'assistant');
  assert.equal(aText.detail.model, 'cursor-grok-4.6');
  assert.equal(call1.kind, 'tool_call');
  assert.equal(call1.name, 'Read');
  assert.deepEqual(call1.detail.args, { path: '/tmp/a' });
  assert.equal(res1.name, 'Read');
  assert.equal(res1.status, 'ok');
  assert.equal(res1.text, 'file contents');
  assert.equal(res2.status, 'error');
  assert.equal(res2.detail.isError, true);
  assert.equal(res2.detail.rawErrorMessages, 'exit 1');
  assert.equal(aDone.text, 'done');

  // 顺序：detail.index 严格递增，且等于消息在有序列表中的下标
  const indexes = result.events.filter((e) => e.kind !== 'meta').map((e) => e.detail.index);
  for (let i = 1; i < indexes.length; i += 1) assert.ok(indexes[i] >= indexes[i - 1]);

  // 元信息：来源、计数、被加密的 reasoning 计数、计划、用量、cwd
  const meta = result.events[0];
  assert.equal(meta.detail.orderSource, 'snapshot-field-1');
  assert.equal(meta.detail.orderRecovered, true);
  assert.equal(meta.detail.messageCount, messages.length);
  assert.deepEqual(meta.detail.counts, { system: 1, user: 2, assistant: 3, tool: 2 });
  assert.equal(meta.detail.reasoningRedacted, 1);
  assert.equal(meta.detail.cwd, '/tmp/workspace');
  assert.equal(meta.detail.usage.used, 10);
  assert.equal(meta.detail.usage.limit, 100);
  assert.equal(meta.detail.usage.entries[0].label, 'Tool definitions');

  // nextCursor：opaque JSON，lastId = 列表最后一条消息
  const cursor = JSON.parse(result.nextCursor);
  assert.equal(cursor.v, 1);
  assert.equal(cursor.lastId, store.ids[store.ids.length - 1]);

  // tail 读取：静态库 → 无新事件，游标原样返回
  const tail = readEvents(refOf(dir), { cursor: result.nextCursor });
  assert.deepEqual(tail.events, []);
  assert.equal(tail.nextCursor, result.nextCursor);
  assert.equal(tail.meta.degraded, false);

  // cursor_reset：lastId 不在列表中 → 整表重读 + 显式告警
  const reset = readEvents(refOf(dir), { cursor: JSON.stringify({ v: 1, rootId: null, lastId: 'ff'.repeat(32) }) });
  assert.equal(reset.events.length, result.events.length);
  assert.equal(reset.events[0].kind, 'meta');
  assert.deepEqual(
    reset.meta.warnings.map((w) => w.code),
    ['cursor_reset']
  );
  assert.equal(reset.meta.degraded, true);

  // cursor_invalid：非法 opaque 值 → 整表重读 + 告警（不抛错）
  const invalid = readEvents(refOf(dir), { cursor: '{"offset":3}' });
  assert.equal(invalid.events[0].kind, 'meta');
  assert.deepEqual(
    invalid.meta.warnings.map((w) => w.code),
    ['cursor_invalid']
  );
});

test('会话模型：assistant 消息的 modelName 提取（后者覆盖前者）', () => {
  const dir = makeTempDir();
  const messages = [
    assistantMsg([{ type: 'text', text: 'one', providerOptions: { cursor: { modelName: 'cursor-grok-4.6-high' } } }], 'msg_1'),
    assistantMsg(
      [{ type: 'text', text: 'two', providerOptions: { cursor: { modelName: 'cursor-grok-4.6-high-fast' } } }],
      'msg_2'
    ),
  ];
  writeStore(dir, { messages, snapshot: (ids) => buildSnapshot({ messageIds: ids }) });
  const res = readEvents(refOf(dir));
  assert.deepEqual(res.meta.model, { id: 'cursor-grok-4.6-high-fast', provider: null, source: 'assistant' });
});

test('会话模型：无 assistant 消息 → null', () => {
  const dir = makeTempDir();
  writeStore(dir, {
    messages: [{ role: 'system', content: 'sys' }],
    snapshot: (ids) => buildSnapshot({ messageIds: ids }),
  });
  const res = readEvents(refOf(dir));
  assert.equal(res.meta.model, null);
});

test('增量 tail：新消息追加后只产出新增条目', () => {
  const dir = makeTempDir();
  const first = [
    { role: 'system', content: 'sys' },
    assistantMsg([{ type: 'text', text: 'one' }], 'm1'),
  ];
  writeStore(dir, { messages: first, snapshot: (ids) => buildSnapshot({ messageIds: ids }) });
  const initial = readEvents(refOf(dir));
  const before = initial.events.length;

  // 追加一条消息并重写快照（真实场景：cursor 每次追加都会换新的 rootBlobId）
  const all = [...first, assistantMsg([{ type: 'text', text: 'two' }], 'm2')];
  fs.rmSync(path.join(dir, 'store.db'), { force: true });
  writeStore(dir, { messages: all, snapshot: (ids) => buildSnapshot({ messageIds: ids }) });

  const tail = readEvents(refOf(dir), { cursor: initial.nextCursor });
  assert.ok(tail.events.length > 0, '应产出新增事件');
  assert.equal(tail.meta.degraded, false);
  assert.ok(!tail.events.some((e) => e.kind === 'meta'), 'tail 读取不应重复 meta 事件');
  assert.equal(tail.events[tail.events.length - 1].text, 'two');
  assert.ok(tail.events[0].detail.index >= before - 1, 'tail 起点应在已读条目之后');
});

test('未知 part 类型 / 未知角色：显式 unknown + warning（degraded）', () => {
  const dir = makeTempDir();
  writeStore(dir, {
    messages: [
      { role: 'system', content: 'sys' },
      assistantMsg([{ type: 'text', text: 'ok' }, { type: 'weird-part', foo: 1 }], 'm1'),
      { role: 'developer', content: 'unexpected role' },
    ],
    snapshot: (ids) => buildSnapshot({ messageIds: ids }),
  });
  const result = readEvents(refOf(dir));
  assert.equal(result.meta.degraded, true);
  const codes = result.meta.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ['unknown_part_type', 'unknown_role']);
  const unknown = result.events.filter((e) => e.kind === 'unknown');
  assert.equal(unknown.length, 2);
  assert.ok(unknown.every((e) => e.raw && e.raw.blobId), 'unknown 事件应保留可回查的原始线索');
});

test('meta 不可用 / latestRootBlobId 为空：走 root_missing 兜底但仍按快照顺序输出', () => {
  const dir = makeTempDir();
  writeStore(dir, {
    messages: [
      { role: 'system', content: 'sys' },
      assistantMsg([{ type: 'text', text: 'hello' }], 'm1'),
    ],
    snapshot: (ids) => buildSnapshot({ messageIds: ids }),
    metaValue: { agentId: 'x', latestRootBlobId: '', name: 'aborted' },
  });
  const result = readEvents(refOf(dir));
  assert.deepEqual(
    result.meta.warnings.map((w) => w.code),
    ['root_missing']
  );
  assert.equal(result.meta.degraded, true);
  assert.equal(result.events[0].detail.orderSource, 'largest-snapshot');
  assert.deepEqual(kindsOf(result.events), ['meta', 'notice', 'text']);
  assert.equal(result.events[2].text, 'hello');
});

test('meta 表缺失：meta_unreadable + 兜底快照顺序', () => {
  const dir = makeTempDir();
  writeStore(dir, {
    messages: [{ role: 'system', content: 'sys' }],
    snapshot: (ids) => buildSnapshot({ messageIds: ids }),
    metaValue: null,
  });
  const result = readEvents(refOf(dir));
  assert.ok(result.meta.warnings.some((w) => w.code === 'meta_unreadable'));
  assert.ok(result.meta.warnings.some((w) => w.code === 'root_missing'));
  assert.equal(result.events.length, 2, 'meta 事件 + system 消息');
});

test('无快照：显式 order_unrecovered，降级为 rowid 集合视图', () => {
  const dir = makeTempDir();
  writeStore(dir, {
    messages: [
      { role: 'system', content: 'sys' },
      assistantMsg([{ type: 'text', text: 'first' }], 'm1'),
      assistantMsg([{ type: 'text', text: 'second' }], 'm2'),
    ],
    snapshot: null,
    metaValue: null,
  });
  const result = readEvents(refOf(dir));
  assert.deepEqual(
    result.meta.warnings.map((w) => w.code),
    ['meta_unreadable', 'order_unrecovered']
  );
  assert.equal(result.meta.degraded, true);
  assert.equal(result.events[0].detail.orderSource, 'rowid');
  assert.equal(result.events[0].detail.orderRecovered, false);
  assert.deepEqual(kindsOf(result.events), ['meta', 'notice', 'text', 'text']);
  assert.deepEqual(
    result.events.slice(1).map((e) => e.text),
    ['sys', 'first', 'second'],
    'rowid 升序 ≈ 首次写入顺序'
  );
});

test('损坏 / 非数据库 / 空库：不抛未捕获异常，返回明确 warning + 空结果', () => {
  // 非 SQLite 文件：open 成功、查询才报错（repo 已知行为）
  const bogus = makeTempDir();
  fs.writeFileSync(path.join(bogus, 'store.db'), 'this is not a sqlite database\n');
  const r1 = readEvents(refOf(bogus));
  assert.deepEqual(r1.events, []);
  assert.equal(r1.nextCursor, null);
  assert.equal(r1.meta.adapter, 'cursor');
  assert.equal(r1.meta.degraded, true);
  assert.ok(r1.meta.warnings.length > 0);

  // 零字节库
  const empty = makeTempDir();
  fs.writeFileSync(path.join(empty, 'store.db'), '');
  const r2 = readEvents(refOf(empty));
  assert.deepEqual(r2.events, []);
  assert.ok(r2.meta.warnings.some((w) => w.code === 'meta_unreadable'));
  assert.ok(r2.meta.warnings.some((w) => w.code === 'order_unrecovered'));

  // store.db 不存在（mapping 按目录 birthtime 匹配，可能给出空目录）
  const noStore = makeTempDir();
  const r3 = readEvents(refOf(noStore));
  assert.deepEqual(r3.events, []);
  assert.deepEqual(
    r3.meta.warnings.map((w) => w.code),
    ['store_missing']
  );

  // ref 非法
  const r4 = readEvents({ adapter: 'cursor', kind: 'dir', path: null });
  assert.deepEqual(r4.events, []);
  assert.deepEqual(
    r4.meta.warnings.map((w) => w.code),
    ['bad_ref']
  );
  const r5 = readEvents();
  assert.equal(r5.meta.warnings[0].code, 'bad_ref');
});

test('真实样本：本机 cursor 会话可读出有序事件（无样本时跳过）', (t) => {
  const root = path.join(os.homedir(), '.cursor', 'acp-sessions');
  let candidates = [];
  try {
    candidates = fs
      .readdirSync(root)
      .map((name) => {
        const full = path.join(root, name);
        const dbFile = path.join(full, 'store.db');
        let mtime = 0;
        try {
          if (fs.statSync(dbFile).isFile()) mtime = fs.statSync(dbFile).mtimeMs;
        } catch {
          return null;
        }
        return { full, name, mtime };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 12);
  } catch {
    candidates = [];
  }
  if (candidates.length === 0) {
    t.skip('本机没有 cursor 会话样本');
    return;
  }

  let result = null;
  let used = null;
  for (const c of candidates) {
    const r = readEvents({ adapter: 'cursor', kind: 'dir', path: c.full, id: c.name });
    if (r.events.length > 4) {
      result = r;
      used = c;
      break;
    }
  }
  if (result === null) {
    t.skip('样本会话均无可读消息');
    return;
  }

  assert.equal(result.meta.adapter, 'cursor');
  assert.equal(typeof result.meta.formatVersion, 'string');
  assert.ok(result.events.length > 4, `${used.name}: 事件数 ${result.events.length}`);
  assert.equal(result.events[0].kind, 'meta');
  assert.equal(result.events[0].detail.orderSource, 'snapshot-field-1', '真实样本应走快照 field#1 顺序路径');
  assert.equal(result.events[0].detail.orderRecovered, true);
  assert.equal(result.meta.degraded, false, `真实样本不应降级：${JSON.stringify(result.meta.warnings)}`);

  for (const ev of result.events) {
    assert.ok(KIND_SET.has(ev.kind), `非法 kind: ${ev.kind}`);
    assert.equal(typeof ev.seq, 'number');
    assert.ok(ev.ts === null || typeof ev.ts === 'string');
  }
  const kinds = new Set(kindsOf(result.events));
  assert.ok(kinds.has('tool_call') && kinds.has('tool_result'), '应有工具调用与结果');

  // tool_result 的 toolCallId 必须由更早的 tool_call 引入（顺序的因果校验）
  const seen = new Set();
  let checked = 0;
  for (const ev of result.events) {
    if (ev.kind === 'tool_call' && ev.detail && ev.detail.toolCallId) seen.add(ev.detail.toolCallId);
    if (ev.kind === 'tool_result' && ev.detail && ev.detail.toolCallId) {
      assert.ok(seen.has(ev.detail.toolCallId), `结果 ${ev.detail.toolCallId} 出现在其调用之前`);
      checked += 1;
    }
  }
  assert.ok(checked > 0, '应校验到 tool 结果');

  const counts = result.events[0].detail.counts;
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(sum, result.events[0].detail.messageCount, 'counts 应与列表长度一致');

  const cursor = JSON.parse(result.nextCursor);
  assert.equal(cursor.v, 1);
  assert.match(cursor.lastId, /^[0-9a-f]{64}$/);

  // tail 读取不得重复已读条目（样本可能正在被 cursor 写入，故只做单调性断言）
  const tail = readEvents({ adapter: 'cursor', kind: 'dir', path: used.full, id: used.name }, { cursor: result.nextCursor });
  assert.ok(!tail.events.some((e) => e.kind === 'meta'), 'tail 不应重复 meta');
  const lastIndex = result.events[result.events.length - 1].detail.index;
  for (const ev of tail.events) assert.ok(ev.detail.index > lastIndex, 'tail 条目应严格晚于已读条目');
}, { concurrency: false });

test('cursor：<timestamp> 解析为事件 ts，展示文本去除注入标记', () => {
  const dir = makeTempDir();
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: '<timestamp>Friday, Sep 18, 2026, 9:55 AM (UTC+8)</timestamp>\n<user_query>do the thing</user_query>' }],
    },
  ];
  writeStore(dir, { messages, snapshot: (ids) => buildSnapshot({ messageIds: ids }) });

  const result = readEvents(refOf(dir));
  const user = result.events.find((e) => e.kind === 'text' && e.name === 'user');
  assert.ok(user, '应产出 user text 事件');
  assert.equal(user.ts, '2026-09-18T01:55:00.000Z', 'UTC+8 的 9:55 AM 应换算为 01:55Z');
  assert.equal(user.text, 'do the thing', '展示文本应去除 <timestamp>/<user_query> 标记');
  assert.equal(user.detail.userQuery, 'do the thing');
});

test('cursor：<timestamp> 无法解析时 ts 保持 null（不误报时间）', () => {
  const dir = makeTempDir();
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>x</user_query>' }] },
  ];
  writeStore(dir, { messages, snapshot: (ids) => buildSnapshot({ messageIds: ids }) });

  const result = readEvents(refOf(dir));
  const user = result.events.find((e) => e.kind === 'text' && e.name === 'user');
  assert.ok(user);
  assert.equal(user.ts, null);
  assert.equal(user.text, 'x');
});

