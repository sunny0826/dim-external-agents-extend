'use strict';

/**
 * opencode 适配器测试。
 *
 * 覆盖：
 * 1. part 类型到统一事件的映射（user_message / think / text / tool_call+tool_result / step / usage / patch / compaction / file）；
 * 2. **稳定边界**：进行中的 step（最后一条 step 标记之后）不输出中间态；
 * 3. 增量语义：(time_created, id) 复合游标，step 结束推进边界后第二批只给新增 part；
 * 4. file part 的内联 base64 绝不进入事件；
 * 5. 显式降级：未知 part 类型 → unknown + warning；空文本 part 不产事件；
 * 6. 错误路径：会话不存在 / 库不可读 / 游标非法；
 * 7. 模型提示：message.modelID 优先，session.model 兜底。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { readEvents } = require('../src/core/adapters/opencode');

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * 建一个最小 opencode 库（session / message / part 三张表，列与真实库一致）。
 * messages: [{ id, role, extra, parts: [{ id, data, t }] }]（t = time_created，缺省自动递增）
 */
function buildDb({
  sessionId = 'ses_test',
  title = '[dim] 测试会话',
  directory = '/tmp/proj',
  agent = 'build',
  sessionModel = null,
  createdAt = 1789860220000,
  messages = [],
  insertSession = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-adapter-'));
  const dbFile = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '', parent_id TEXT,
      slug TEXT NOT NULL DEFAULT '', directory TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '',
      agent TEXT, model TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);
  if (insertSession) {
    db.prepare(
      'INSERT INTO session (id, title, directory, agent, model, time_created, time_updated) VALUES (?,?,?,?,?,?,?)'
    ).run(sessionId, title, directory, agent, sessionModel, createdAt, createdAt);
  }
  const insMsg = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)'
  );
  const insPart = db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)'
  );
  let clock = createdAt;
  for (const msg of messages) {
    const msgData = { role: msg.role, ...(msg.extra || {}) };
    insMsg.run(msg.id, sessionId, clock, clock, JSON.stringify(msgData));
    for (const p of msg.parts || []) {
      clock += 1000;
      const t = Number.isFinite(p.t) ? p.t : clock;
      insPart.run(p.id, msg.id, sessionId, t, Number.isFinite(p.updated) ? p.updated : t, JSON.stringify(p.data));
    }
  }
  db.close();
  return { dbFile, dir };
}

function refFor(dbFile, id = 'ses_test') {
  return { adapter: 'opencode', kind: 'db', path: dbFile, id };
}

/** 一个「两个 step 都已完成」的完整会话。 */
function completeSession() {
  return {
    messages: [
      {
        id: 'msg_u1',
        role: 'user',
        parts: [{ id: 'prt_001', data: { type: 'text', text: '你是实现者。任务：实现 M2-05。' } }],
      },
      {
        id: 'msg_a1',
        role: 'assistant',
        extra: { modelID: 'kimi-k3', providerID: 'opencode-go' },
        parts: [
          { id: 'prt_002', data: { type: 'step-start', snapshot: 'abc' } },
          { id: 'prt_003', data: { type: 'reasoning', text: '先读契约', time: { start: 1789860221000, end: 1789860223000 } } },
          {
            id: 'prt_004',
            data: {
              type: 'tool',
              tool: 'read',
              callID: 'call_1',
              state: {
                status: 'completed',
                input: { filePath: '/tmp/proj/a.ts' },
                output: 'file body',
                time: { start: 1789860224000, end: 1789860225000 },
              },
            },
          },
          { id: 'prt_005', data: { type: 'text', text: '已完成读取。' } },
          {
            id: 'prt_006',
            data: { type: 'step-finish', reason: 'tool-calls', cost: 0.05, tokens: { input: 100, output: 20, reasoning: 5 } },
          },
        ],
      },
    ],
  };
}

test('opencode：完整会话的 part → 事件映射', () => {
  const { dbFile } = buildDb(completeSession());
  const r = readEvents(refFor(dbFile));

  assert.equal(r.meta.adapter, 'opencode');
  assert.equal(r.meta.degraded, false);
  assert.equal(r.meta.model.id, 'kimi-k3');
  assert.equal(r.meta.model.provider, 'opencode-go');

  assert.deepEqual(
    r.events.map((e) => e.kind),
    ['meta', 'notice', 'step', 'think', 'tool_call', 'tool_result', 'text', 'step', 'usage']
  );
  assert.deepEqual(
    r.events.map((e) => e.seq),
    [0, 1, 2, 3, 4, 5, 6, 7, 8]
  );

  const meta = r.events[0];
  assert.equal(meta.detail.sessionId, 'ses_test');
  assert.equal(meta.detail.title, '[dim] 测试会话');
  assert.equal(meta.detail.cwd, '/tmp/proj');
  assert.equal(meta.detail.counts.tool, 1);

  const prompt = r.events[1];
  assert.equal(prompt.name, 'user_message');
  assert.equal(prompt.text, '你是实现者。任务：实现 M2-05。');

  const call = r.events[4];
  assert.equal(call.name, 'read');
  assert.equal(call.detail.toolCallId, 'call_1');
  assert.deepEqual(call.detail.args, { filePath: '/tmp/proj/a.ts' });

  const result = r.events[5];
  assert.equal(result.kind, 'tool_result');
  assert.equal(result.status, 'ok');
  assert.equal(result.text, 'file body');
  assert.equal(result.detail.toolCallId, 'call_1');

  const stepEnd = r.events[7];
  assert.equal(stepEnd.name, 'step.end');
  assert.equal(stepEnd.detail.phase, 'end');
  assert.equal(stepEnd.detail.finishReason, 'tool-calls');
  assert.equal(stepEnd.status, 'ok');

  const usage = r.events[8];
  assert.equal(usage.name, 'usage.step');
  assert.match(usage.text, /100 in \/ 20 out \/ 5 reasoning/);
  assert.equal(usage.detail.cost, 0.05);

  assert.equal(r.events.every((e) => e.ts === null || ISO_RE.test(e.ts)), true, 'ts 应为 ISO 或 null');
});

test('opencode：进行中的 step 不输出中间态（稳定边界 = 最后一条 step 标记）', () => {
  const { dbFile } = buildDb({
    messages: [
      { id: 'msg_u1', role: 'user', parts: [{ id: 'prt_001', data: { type: 'text', text: '任务 prompt' } }] },
      {
        id: 'msg_a1',
        role: 'assistant',
        parts: [
          { id: 'prt_002', data: { type: 'step-start' } },
          { id: 'prt_003', data: { type: 'reasoning', text: '第一步思考' } },
          { id: 'prt_004', data: { type: 'step-finish', reason: 'tool-calls' } },
          { id: 'prt_005', data: { type: 'step-start' } },
          // 进行中的 step：流式文本可能仍在被改写，本批不输出
          { id: 'prt_006', data: { type: 'text', text: '正在生成中……' } },
          { id: 'prt_007', data: { type: 'tool', tool: 'bash', callID: 'call_9', state: { status: 'running' } } },
        ],
      },
    ],
  });
  const r = readEvents(refFor(dbFile));

  assert.deepEqual(
    r.events.map((e) => e.kind),
    ['meta', 'notice', 'step', 'think', 'step', 'step']
  );
  assert.equal(
    r.events.some((e) => e.text === '正在生成中……'),
    false,
    '进行中 step 的文本不应输出'
  );
  assert.equal(r.events.some((e) => e.kind === 'tool_call'), false, '进行中的工具调用不输出');
  // 游标停在最后一条已输出的 part（第二个 step-start，t = createdAt + 5000），而不是整个会话末尾
  assert.deepEqual(JSON.parse(r.nextCursor), { v: 1, t: 1789860225000, id: 'prt_005' });
});

test('opencode：step 结束后边界推进，第二批只给新增 part（游标不重复不遗漏）', () => {
  const built = buildDb({
    messages: [
      { id: 'msg_u1', role: 'user', parts: [{ id: 'prt_001', data: { type: 'text', text: '任务 prompt' } }] },
      {
        id: 'msg_a1',
        role: 'assistant',
        parts: [
          { id: 'prt_002', data: { type: 'step-start' } },
          { id: 'prt_003', data: { type: 'reasoning', text: '第一步' } },
          { id: 'prt_004', data: { type: 'step-finish', reason: 'tool-calls' } },
          { id: 'prt_005', data: { type: 'step-start' } },
          { id: 'prt_006', data: { type: 'text', text: '进行中' } },
        ],
      },
    ],
  });

  const first = readEvents(refFor(built.dbFile));
  assert.equal(first.events.some((e) => e.text === '进行中'), false);
  assert.ok(first.nextCursor, '应给出可续读游标');

  // step 结束：补一条 step-finish，边界随之推进
  const db = new DatabaseSync(built.dbFile);
  db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)'
  ).run('prt_007', 'msg_a1', 'ses_test', 1789860229000, 1789860229000, JSON.stringify({ type: 'step-finish', reason: 'stop' }));
  db.close();

  const second = readEvents(refFor(built.dbFile), { cursor: first.nextCursor });
  assert.deepEqual(
    second.events.map((e) => e.kind),
    ['text', 'step'],
    '只应输出新稳定的 part，不重复第一批'
  );
  assert.equal(second.events[0].text, '进行中');
  assert.equal(second.events[1].detail.finishReason, 'stop');
  assert.equal(second.events.some((e) => e.kind === 'meta'), false, '增量批次不重复 meta');

  // 再读一次：没有新 part → 无事件，但游标保持（调用方可继续轮询）
  const third = readEvents(refFor(built.dbFile), { cursor: second.nextCursor });
  assert.deepEqual(third.events, []);
  assert.equal(third.nextCursor, second.nextCursor);
});

test('opencode：file part 的内联 base64 不进入事件', () => {
  const big = 'data:image/png;base64,' + 'A'.repeat(5000);
  const { dbFile } = buildDb({
    messages: [
      {
        id: 'msg_a1',
        role: 'assistant',
        parts: [
          { id: 'prt_001', data: { type: 'file', mime: 'image/png', filename: 'clipboard', url: big } },
          { id: 'prt_002', data: { type: 'step-start' } },
        ],
      },
    ],
  });
  const r = readEvents(refFor(dbFile));
  const fileEvent = r.events.find((e) => e.name === 'file');
  assert.ok(fileEvent);
  assert.equal(fileEvent.text, 'clipboard');
  assert.equal(fileEvent.detail.mime, 'image/png');
  assert.equal(fileEvent.detail.inline, true);
  const serialized = JSON.stringify(r.events);
  assert.equal(serialized.includes('data:image/png;base64'), false, 'base64 不得出现在任何事件字段里');
});

test('opencode：patch / compaction / 空文本 / 未知类型', () => {
  const { dbFile } = buildDb({
    messages: [
      {
        id: 'msg_a1',
        role: 'assistant',
        parts: [
          { id: 'prt_001', data: { type: 'patch', hash: 'deadbeef', files: ['/a/b/One.tsx', '/a/b/Two.tsx'] } },
          { id: 'prt_002', data: { type: 'compaction', auto: true } },
          { id: 'prt_003', data: { type: 'text', text: '   ' } },
          { id: 'prt_004', data: { type: 'brand-new-part', payload: 1 } },
          { id: 'prt_005', data: { type: 'step-start' } },
        ],
      },
    ],
  });
  const r = readEvents(refFor(dbFile));

  const patch = r.events.find((e) => e.name === 'patch');
  assert.equal(patch.text, 'One.tsx, Two.tsx');
  assert.equal(patch.detail.fileCount, 2);

  const compaction = r.events.find((e) => e.name === 'compaction');
  assert.equal(compaction.text, 'auto compaction');

  assert.equal(r.events.some((e) => e.kind === 'text'), false, '纯空白文本不产事件');

  const unknown = r.events.find((e) => e.kind === 'unknown');
  assert.equal(unknown.detail.droppedKind, 'brand-new-part');
  assert.equal(r.meta.degraded, true);
  assert.equal(r.meta.warnings[0].code, 'unknown_part_type');
  assert.match(r.meta.warnings[0].message, /brand-new-part/);
});

test('opencode：tool 失败与进行中的工具', () => {
  const { dbFile } = buildDb({
    messages: [
      {
        id: 'msg_a1',
        role: 'assistant',
        parts: [
          {
            id: 'prt_001',
            data: {
              type: 'tool',
              tool: 'read',
              callID: 'call_err',
              state: { status: 'error', input: { filePath: '/nope' }, error: 'File not found: /nope' },
            },
          },
          { id: 'prt_002', data: { type: 'step-finish', reason: 'tool-calls' } },
        ],
      },
    ],
  });
  const r = readEvents(refFor(dbFile));
  const result = r.events.find((e) => e.kind === 'tool_result');
  assert.equal(result.status, 'error');
  assert.equal(result.text, 'File not found: /nope');

  // 进行中的工具：只给 tool_call，并显式提示"尚无结果"
  const running = buildDb({
    messages: [
      {
        id: 'msg_a1',
        role: 'assistant',
        parts: [
          { id: 'prt_001', data: { type: 'tool', tool: 'bash', callID: 'call_run', state: { status: 'running', input: { command: 'sleep 30' } } } },
          { id: 'prt_002', data: { type: 'step-start' } },
        ],
      },
    ],
  });
  const r2 = readEvents(refFor(running.dbFile));
  const call = r2.events.find((e) => e.kind === 'tool_call');
  assert.equal(call.name, 'bash');
  assert.equal(r2.events.some((e) => e.kind === 'tool_result'), false);
  assert.equal(r2.meta.warnings[0].code, 'tool_in_flight');
});

test('opencode：模型提示 message 优先、session.model 兜底', () => {
  const withMessage = buildDb(completeSession());
  assert.equal(readEvents(refFor(withMessage.dbFile)).meta.model.id, 'kimi-k3');

  const sessionOnly = buildDb({
    sessionModel: JSON.stringify({ id: 'grok-4.6', providerID: 'opencode-go', variant: 'max' }),
    messages: [
      { id: 'msg_a1', role: 'assistant', parts: [{ id: 'prt_001', data: { type: 'step-start' } }] },
    ],
  });
  const m = readEvents(refFor(sessionOnly.dbFile)).meta.model;
  assert.equal(m.id, 'grok-4.6');
  assert.equal(m.provider, 'opencode-go');
  assert.equal(m.source, 'session');
});

test('opencode：错误路径（会话不存在 / 库不可读 / 游标非法 / ref 缺字段）', () => {
  const empty = buildDb({ insertSession: false });
  const missing = readEvents(refFor(empty.dbFile));
  assert.deepEqual(missing.events, []);
  assert.equal(missing.meta.warnings[0].code, 'session_not_found');

  const broken = buildDb({});
  fs.writeFileSync(broken.dbFile, 'not a sqlite file at all');
  const bad = readEvents(refFor(broken.dbFile));
  assert.equal(bad.meta.warnings[0].code, 'db_unreadable');

  const ok = buildDb(completeSession());
  const invalid = readEvents(refFor(ok.dbFile), { cursor: 'not-json' });
  assert.equal(invalid.meta.warnings[0].code, 'cursor_invalid');
  assert.ok(invalid.events.length > 0, '游标非法时应退化为整表读取而不是空结果');

  assert.equal(readEvents({ adapter: 'opencode' }).meta.warnings[0].code, 'bad_ref');
  assert.equal(readEvents({ adapter: 'opencode', path: '/x' }).meta.warnings[0].code, 'bad_ref');
});

test('opencode：空会话给出「从头开始」的游标而不是 null（运行中任务需继续轮询）', () => {
  const { dbFile } = buildDb({ messages: [] });
  const r = readEvents(refFor(dbFile));
  assert.deepEqual(JSON.parse(r.nextCursor), { v: 1, t: 0, id: '' });
});
