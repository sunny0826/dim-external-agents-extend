'use strict';

/**
 * grok 适配器测试。
 *
 * 覆盖：
 * 1. updates.jsonl 各类 sessionUpdate 的归一化（kind / status / 工具名关联）；
 * 2. 无 status 的 tool_call_update（补充描述）不产事件、只计数；
 * 3. 增量语义：cursor = 字节偏移，尾部半行不消费；
 * 4. 显式降级：未知类型 → unknown 事件 + warnings；
 * 5. 真实会话样本（存在则跑，否则跳过）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readEvents } = require('../src/core/adapters/grok');

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 建临时 grok 会话目录并写入 updates.jsonl。 */
function makeSession(records, { withSummary = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-adapter-'));
  if (withSummary) {
    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({
        info: { id: '01a0test', cwd: '/tmp/proj' },
        session_summary: '[dim] 测试会话',
        created_at: '2026-09-19T23:23:36.200000Z',
        updated_at: '2026-09-19T23:30:00.000000Z',
        current_model_id: 'grok-4.6',
        reasoning_effort: 'high',
        agent_name: 'grok-build',
        num_chat_messages: 12,
        title_is_manual: true,
      })
    );
  }
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

function refFor(dir) {
  return { adapter: 'grok', kind: 'dir', path: dir, id: '01a0test' };
}

/** 构造一行 update：默认带毫秒时间戳。 */
function line(update, { ms = 1789860220000, method = 'session/update' } = {}) {
  return { timestamp: Math.floor(ms / 1000), method, params: { sessionId: '01a0test', update }, _meta: { agentTimestampMs: ms } };
}

const SAMPLE = [
  line({ sessionUpdate: 'hook_execution', event_name: 'session_start', runs: [{ name: 'h', status: { status: 'success' } }] }, { ms: 1789860220000, method: '_x.ai/session/update' }),
  line({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '你是执行者。任务：实现 X' } }, { ms: 1789860221000 }),
  line({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先看契约' } }, { ms: 1789860222000 }),
  line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先按契约读齐要求。' } }, { ms: 1789860223000 }),
  line(
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'search_tool',
      rawInput: { query: 'x', limit: 5 },
      _meta: { 'x.ai/tool': { name: 'search_tool', kind: 'search_tool', label: 'Search Tools', namespace: 'grok_build', read_only: false } },
    },
    { ms: 1789860224000 }
  ),
  // 无 status 的补充描述：不产事件
  line({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', kind: 'other', title: 'Search tools: "x"', locations: [], rawInput: { variant: 'SearchTool' } }, { ms: 1789860224100 }),
  // 有 status：tool_result
  line(
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: '{"results":[]}' } }],
    },
    { ms: 1789860225000 }
  ),
  line(
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-2',
      title: 'run_terminal_command',
      rawInput: { variant: 'Bash', command: 'ls' },
      _meta: { 'x.ai/tool': { name: 'run_terminal_command', kind: 'execute', read_only: false } },
    },
    { ms: 1789860226000 }
  ),
  line(
    { sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Error: nope' } }] },
    { ms: 1789860227000 }
  ),
  line({ sessionUpdate: 'plan', entries: [{ content: '实现 A', status: 'completed' }, { content: '实现 B', status: 'pending' }] }, { ms: 1789860228000 }),
  line({ sessionUpdate: 'retry_state', type: 'failed', error_type: 'api', message: 'API error (402)' }, { ms: 1789860229000, method: '_x.ai/session/update' }),
  line(
    {
      sessionUpdate: 'turn_completed',
      stop_reason: 'end_turn',
      elapsed_ms: 12345,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, modelCalls: 3, modelUsage: { 'grok-4.6-build': { inputTokens: 100 } } },
    },
    { ms: 1789860230000, method: '_x.ai/session/update' }
  ),
];

test('grok：updates.jsonl → 归一化事件（meta/notice/think/text/tool_call/tool_result/usage）', () => {
  const dir = makeSession(SAMPLE);
  const res = readEvents(refFor(dir), {});
  const kinds = res.events.map((e) => e.kind);
  assert.deepEqual(
    kinds,
    ['meta', 'notice', 'notice', 'think', 'text', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'notice', 'notice', 'usage'],
    '事件顺序与类型应与 updates.jsonl 一致（无 status 的补充描述不产事件）'
  );
  assert.equal(res.meta.degraded, false);
  assert.deepEqual(res.meta.warnings, []);
  assert.equal(res.meta.adapter, 'grok');
  assert.equal(res.meta.formatVersion, 'grok-updates/1');

  const meta = res.events[0];
  assert.equal(meta.detail.sessionId, '01a0test');
  assert.equal(meta.detail.name, '[dim] 测试会话');
  assert.equal(meta.detail.cwd, '/tmp/proj');
  assert.equal(meta.detail.skippedRefinements, 1, '无 status 的 tool_call_update 应被计数');

  assert.equal(res.meta.model.id, 'grok-4.6');
  assert.equal(res.meta.model.source, 'summary.json');

  const call = res.events[5];
  assert.equal(call.kind, 'tool_call');
  assert.equal(call.name, 'search_tool');
  assert.equal(call.detail.toolCallId, 'call-1');
  assert.deepEqual(call.detail.input, { query: 'x', limit: 5 });
  assert.match(call.ts, ISO_RE);

  const ok = res.events[6];
  assert.equal(ok.kind, 'tool_result');
  assert.equal(ok.name, 'search_tool', '工具名应由 toolCallId 关联回 tool_call');
  assert.equal(ok.status, 'ok');
  assert.match(ok.text, /results/);

  const bad = res.events[8];
  assert.equal(bad.status, 'error');
  assert.equal(bad.name, 'run_terminal_command');

  const usage = res.events[res.events.length - 1];
  assert.equal(usage.kind, 'usage');
  assert.match(usage.text, /in 100 \/ out 20 \/ total 120/);
  assert.equal(usage.detail.stopReason, 'end_turn');
});

test('grok：增量读只消费完整行（尾部半行不推进 cursor）', () => {
  const dir = makeSession(SAMPLE.slice(0, 3));
  const first = readEvents(refFor(dir), {});
  assert.equal(first.events.length, 4); // meta + 3 条
  assert.equal(first.nextCursor, String(fs.statSync(path.join(dir, 'updates.jsonl')).size));

  /* 追加一条完整行 + 一条半行 */
  const file = path.join(dir, 'updates.jsonl');
  const full = JSON.stringify(line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '继续' } }, { ms: 1789860240000 }));
  const half = '{"params":{"update":{"sessionUpdate":"agent_mess';
  fs.appendFileSync(file, full + '\n' + half);

  const second = readEvents(refFor(dir), { cursor: first.nextCursor });
  assert.equal(second.events.length, 1, '只应消费完整的那一行');
  assert.equal(second.events[0].kind, 'text');
  assert.equal(Number(second.nextCursor), fs.statSync(file).size - half.length, 'cursor 停在半行之前');

  /* 半行补全后再读：应恰好读到它 */
  fs.appendFileSync(file, 'age_chunk","content":{"type":"text","text":"补齐"}}}}' + '\n');
  const third = readEvents(refFor(dir), { cursor: second.nextCursor });
  assert.equal(third.events.length, 1);
  assert.equal(third.events[0].kind, 'text');
  assert.match(third.events[0].text, /补齐/);
});

test('grok：未知 sessionUpdate 显式降级为 unknown + warning', () => {
  const dir = makeSession([line({ sessionUpdate: 'brand_new_thing', foo: 1 })]);
  const res = readEvents(refFor(dir), {});
  const unknown = res.events.filter((e) => e.kind === 'unknown');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].name, 'brand_new_thing');
  assert.equal(unknown[0].detail.droppedKind, 'brand_new_thing');
  assert.equal(res.meta.degraded, true);
  assert.equal(res.meta.warnings[0].code, 'unknown_update_type');
});

test('grok：目录里没有 updates.jsonl → 空结果 + updates_missing 警告', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-adapter-empty-'));
  const res = readEvents(refFor(dir), {});
  assert.deepEqual(res.events, []);
  assert.equal(res.meta.warnings[0].code, 'updates_missing');
  assert.equal(res.nextCursor, null);
});

test('grok：真实会话样本（存在则断言结构）', () => {
  const root = path.join(os.homedir(), '.grok', 'sessions');
  const dirs = [];
  try {
    for (const cwd of fs.readdirSync(root)) {
      const p1 = path.join(root, cwd);
      if (!fs.statSync(p1).isDirectory()) continue;
      for (const id of fs.readdirSync(p1)) {
        const p2 = path.join(p1, id);
        const f = path.join(p2, 'updates.jsonl');
        try {
          if (fs.statSync(f).size > 0 && fs.readFileSync(f, 'utf8').includes('"tool_call"')) dirs.push(p2);
        } catch {
          /* 跳过不可读会话 */
        }
      }
      if (dirs.length > 0) break; // 一个 cwd 下找到就够
    }
  } catch {
    /* 本机没有 grok 会话 */
  }
  if (dirs.length === 0) {
    console.log('（跳过：本机没有带工具调用的 grok 会话样本）');
    return;
  }
  const dir = dirs[0];
  const res = readEvents({ adapter: 'grok', kind: 'dir', path: dir, id: path.basename(dir) }, {});
  assert.ok(res.events.length > 0, '真实会话应产出事件');
  assert.equal(res.events[0].kind, 'meta');
  assert.ok(res.events.some((e) => e.kind === 'tool_call'), '真实会话应至少有一次工具调用');
  assert.ok(res.events.some((e) => e.kind === 'tool_result'), '真实会话应至少有一条工具结果');
  assert.ok(res.meta.model && res.meta.model.id.length > 0, '应能读出会话模型');
  for (const ev of res.events) {
    if (ev.ts !== null) assert.match(ev.ts, ISO_RE, `ts 应为 ISO：${ev.ts}`);
  }
});
