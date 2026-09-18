'use strict';

/**
 * kimi 适配器测试（T1.3）。
 *
 * 覆盖：
 * 1. 真实会话样本 wire.jsonl 的结构断言（kind 覆盖、ts 为 ISO、formatVersion）；
 * 2. 增量读语义：只消费完整行（末尾半行不推进 offset，也不产生事件）；
 * 3. 未知数据的显式降级（unknown 事件 + warnings + raw）。
 *
 * 样本不存在时第 1 组自动跳过，其余用例只依赖临时构造的 JSONL。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readEvents } = require('../src/core/adapters/kimi');

const SAMPLE_DIR = path.join(
  os.homedir(),
  '.kimi-code/sessions/wd_project-v_2138e21490eb/session_c46bdf25-aaa0-472a-be7c-22500046b20a'
);
const SAMPLE_WIRE = path.join(SAMPLE_DIR, 'agents/main/wire.jsonl');
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function refFor(dir) {
  return { adapter: 'kimi', kind: 'dir', path: dir, id: 'session_test' };
}

/** 建临时会话目录：<root>/session_test/agents/main/wire.jsonl。 */
function makeTempSession() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-adapter-'));
  const dir = path.join(root, 'session_test');
  fs.mkdirSync(path.join(dir, 'agents', 'main'), { recursive: true });
  return { root, dir, wire: path.join(dir, 'agents', 'main', 'wire.jsonl') };
}

/** 一行 wire JSONL（带换行）。 */
function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

function loopLine(event, time) {
  return line({ type: 'context.append_loop_event', agentId: 'main', event, time });
}

function toolCallLine(toolCallId, name, filePath, time) {
  return loopLine(
    {
      type: 'tool.call',
      uuid: `uuid-${toolCallId}`,
      turnId: '0',
      step: 1,
      toolCallId,
      name,
      args: { path: filePath },
      display: { kind: 'file_io', operation: 'read', path: filePath },
    },
    time
  );
}

function toolResultLine(toolCallId, output, time) {
  return loopLine({ type: 'tool.result', toolCallId, result: { output } }, time);
}

test('真实样本：事件结构与映射', (t) => {
  if (!fs.existsSync(SAMPLE_WIRE)) {
    t.skip(`样本不存在：${SAMPLE_WIRE}`);
    return;
  }

  const ref = { adapter: 'kimi', kind: 'dir', path: SAMPLE_DIR, id: 'session_c46bdf25' };
  const { events, nextCursor, meta } = readEvents(ref);

  // 事件与元信息
  assert.ok(events.length > 0, '应产出事件');
  assert.equal(meta.adapter, 'kimi');
  assert.equal(meta.formatVersion, '1.5');
  assert.equal(meta.degraded, false, '真实样本不应有降级');
  assert.deepEqual(meta.warnings, []);

  // seq 在单次调用内从 0 连续递增
  events.forEach((event, index) => assert.equal(event.seq, index));

  // ts 一律为 ISO 字符串（样本中的毫秒数都被转换）
  for (const event of events) {
    assert.ok(event.ts === null || ISO_RE.test(event.ts), `非法 ts: ${event.ts}`);
  }

  // kind 覆盖
  const kinds = new Set(events.map((event) => event.kind));
  for (const kind of ['meta', 'step', 'tool_call', 'tool_result', 'think', 'text', 'llm', 'usage', 'notice']) {
    assert.ok(kinds.has(kind), `缺少 kind: ${kind}`);
  }

  // meta 事件
  const metaEvent = events.find((event) => event.kind === 'meta');
  assert.equal(metaEvent.name, 'metadata');
  assert.equal(metaEvent.detail.protocolVersion, '1.5');
  assert.ok(ISO_RE.test(metaEvent.detail.createdAt));

  // step.begin / step.end
  const stepBegin = events.find((event) => event.kind === 'step' && event.detail.phase === 'begin');
  assert.ok(stepBegin, '应存在 step.begin');
  assert.equal(typeof stepBegin.detail.step, 'number');
  const stepEnd = events.find((event) => event.kind === 'step' && event.detail.phase === 'end');
  assert.ok(stepEnd, '应存在 step.end');
  assert.equal(typeof stepEnd.detail.finishReason, 'string');
  assert.ok(['ok', 'error'].includes(stepEnd.status));

  // tool.call：工具名 + 结构化参数
  const call = events.find((event) => event.kind === 'tool_call' && event.name === 'Read');
  assert.ok(call, '应存在 Read 工具调用');
  assert.equal(typeof call.detail.args.path, 'string');
  assert.match(call.detail.toolCallId, /^tool_/);
  assert.equal(typeof call.text, 'string');

  // tool.result：错误状态 + 同批次关联到工具名
  const errored = events.find((event) => event.kind === 'tool_result' && event.status === 'error');
  assert.ok(errored, '样本中应存在失败的 tool.result');
  assert.equal(errored.detail.isError, true);
  assert.equal(errored.name, 'Read', 'tool.result 应由同批次 tool.call 关联出工具名');
  assert.equal(typeof errored.text, 'string');

  // think / text 内容
  assert.ok(events.some((event) => event.kind === 'think' && typeof event.text === 'string' && event.text.length > 0));
  assert.ok(events.some((event) => event.kind === 'text' && typeof event.text === 'string' && event.text.length > 0));

  // llm / usage
  assert.ok(events.some((event) => event.kind === 'llm' && event.detail.modelAlias === 'kimi-code/k3'));
  assert.ok(events.some((event) => event.kind === 'usage' && typeof event.detail.tokens === 'number'));

  // 超长内容被裁剪并标注（样本里有大参数/大输出）
  assert.ok(
    events.some((event) => event.detail && (event.detail.argsTruncated === true || event.detail.truncated === true)),
    '应存在被裁剪并标注的事件'
  );

  // 读完整个文件：cursor 停在文件末尾；再读不产生新事件
  assert.equal(Number(nextCursor), fs.statSync(SAMPLE_WIRE).size);
  const again = readEvents(ref, { cursor: nextCursor });
  assert.equal(again.events.length, 0, 'cursor 到末尾后不应再产出事件');
  assert.equal(Number(again.nextCursor), Number(nextCursor));
  assert.equal(again.meta.formatVersion, '1.5', '增量读也应探测到 formatVersion');
});

test('增量读：只消费完整行，末尾半行不推进 offset', (t) => {
  const { root, dir, wire } = makeTempSession();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ref = refFor(dir);

  // 第 1 批：2 整行
  fs.writeFileSync(wire, line({ type: 'metadata', protocol_version: '1.5', created_at: 1789559571387 }));
  fs.appendFileSync(wire, toolCallLine('tool_1', 'Read', 'src/a.ts', 1789559572000));

  const first = readEvents(ref);
  assert.equal(first.events.length, 2);
  assert.deepEqual(
    first.events.map((event) => event.kind),
    ['meta', 'tool_call']
  );
  assert.equal(first.events[0].detail.protocolVersion, '1.5');
  assert.equal(first.events[1].name, 'Read');
  assert.equal(first.events[1].detail.argKeys.join(','), 'path');
  const sizeAfterFirst = fs.statSync(wire).size;
  assert.equal(Number(first.nextCursor), sizeAfterFirst);
  assert.equal(first.meta.degraded, false);

  // 第 2 批：1 整行 + 半行（无结尾换行）
  const resultLine = toolResultLine('tool_1', 'second-output', 1789559573000);
  const halfLine = toolResultLine('tool_2', 'half', 1789559574000);
  const halfCut = Math.floor(halfLine.length / 2);
  fs.appendFileSync(wire, resultLine + halfLine.slice(0, halfCut));

  const second = readEvents(ref, { cursor: first.nextCursor });
  assert.equal(second.events.length, 1, '半行不得产出事件');
  assert.equal(second.events[0].kind, 'tool_result');
  assert.equal(second.events[0].text, 'second-output');
  assert.equal(second.events[0].detail.toolCallId, 'tool_1');
  assert.equal(second.events[0].status, 'ok');
  assert.equal(Number(second.nextCursor), sizeAfterFirst + Buffer.byteLength(resultLine), 'offset 应停在整行结尾');

  // 半行未变时重复读：无新事件，offset 不动
  const repeat = readEvents(ref, { cursor: second.nextCursor });
  assert.equal(repeat.events.length, 0);
  assert.equal(Number(repeat.nextCursor), Number(second.nextCursor));

  // 补齐半行 + 换行后再读：拿到第 3 个事件
  fs.appendFileSync(wire, `${halfLine.slice(halfCut)}`);
  const third = readEvents(ref, { cursor: second.nextCursor });
  assert.equal(third.events.length, 1, '补齐后应只多出 1 个事件');
  assert.equal(third.events[0].kind, 'tool_result');
  assert.equal(third.events[0].text, 'half');
  assert.equal(third.events[0].detail.toolCallId, 'tool_2');
  assert.equal(Number(third.nextCursor), fs.statSync(wire).size);
  // 跨批次不保留 tool.call 关联，name 为 null（已知行为）
  assert.equal(third.events[0].name, null);
  assert.equal(third.events[0].detail.nameResolved, false);

  // 顺序读的第三批同样不重复
  const fourth = readEvents(ref, { cursor: third.nextCursor });
  assert.equal(fourth.events.length, 0);
});

test('真实样本：分 5 批增量读与整体读的事件序列一致', (t) => {
  if (!fs.existsSync(SAMPLE_WIRE)) {
    t.skip(`样本不存在：${SAMPLE_WIRE}`);
    return;
  }
  const { root, dir, wire } = makeTempSession();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const full = fs.readFileSync(SAMPLE_WIRE);
  const ref = refFor(dir);
  const step = Math.floor(full.length / 5);

  let incremental = [];
  let cursor = null;
  for (let i = 0; i < 5; i += 1) {
    // 切割点故意落在行中间（+7 字节），模拟文件正在被写
    const end = i === 4 ? full.length : Math.min(full.length, (i + 1) * step + 7);
    fs.writeFileSync(wire, full.subarray(0, end));
    const chunk = readEvents(ref, { cursor });
    assert.equal(chunk.meta.degraded, false, `第 ${i} 批不应降级`);
    incremental = incremental.concat(chunk.events);
    cursor = chunk.nextCursor;
    if (end < full.length) {
      const repeat = readEvents(ref, { cursor });
      assert.equal(repeat.events.length, 0, '未闭合的半行不得产出事件');
      assert.equal(Number(repeat.nextCursor), Number(cursor));
    }
  }

  const whole = readEvents(ref, { cursor: null }).events;
  assert.equal(incremental.length, whole.length);
  assert.equal(Number(cursor), full.length);

  const key = (event) => [event.kind, event.status, event.ts, event.text === null ? '' : event.text].join('\u0000');
  assert.deepEqual(incremental.map(key), whole.map(key), '除 name 外字段应与整体读一致');

  // 唯一允许的差异：跨批次的 tool_result 关联不到工具名
  const nameDiffs = incremental.filter((event, index) => event.name !== whole[index].name);
  for (const event of nameDiffs) {
    assert.equal(event.kind, 'tool_result');
    assert.equal(event.name, null);
    assert.equal(event.detail.nameResolved, false);
  }
});

test('未知数据显式降级：unknown 事件 + warnings + raw', (t) => {
  const { root, dir, wire } = makeTempSession();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ref = refFor(dir);

  fs.writeFileSync(wire, line({ type: 'metadata', protocol_version: '1.5', created_at: 1789559571387 }));
  fs.appendFileSync(wire, line({ type: 'future.thing', agentId: 'main', time: 1789559572000 }));
  fs.appendFileSync(wire, loopLine({ type: 'brand.new.inner', turnId: '0', step: 1 }, 1789559573000));
  fs.appendFileSync(wire, loopLine({ type: 'content.part', part: { type: 'audio' } }, 1789559573500));
  fs.appendFileSync(wire, '{"type":"metadata","broken\n');
  fs.appendFileSync(wire, '\n'); // 空行应被跳过，不产生事件

  const { events, meta } = readEvents(ref);
  assert.equal(events.length, 5, 'meta + 4 条降级（空行跳过）');

  const unknown = events.filter((event) => event.kind === 'unknown');
  assert.equal(unknown.length, 4);
  for (const event of unknown) {
    assert.ok(event.raw && typeof event.raw.line === 'string', '降级事件应保留原始行');
  }
  assert.equal(events[1].detail.topType, 'future.thing');
  assert.equal(events[2].detail.eventType, 'brand.new.inner');
  assert.equal(events[3].detail.partType, 'audio');
  assert.equal(events[4].detail.reason, 'malformed_line');

  assert.equal(meta.degraded, true);
  const codes = meta.warnings.map((w) => w.code);
  for (const code of ['unknown_top_type', 'unknown_event_type', 'unknown_part_type', 'malformed_line']) {
    assert.ok(codes.includes(code), `缺少 warning code: ${code}`);
  }
});

test('损坏引用与异常 cursor：降级但不抛异常', (t) => {
  assert.doesNotThrow(() => readEvents(null));
  const noRef = readEvents(undefined);
  assert.deepEqual(noRef.events, []);
  assert.equal(noRef.meta.warnings[0].code, 'invalid_ref');

  const missing = readEvents({ adapter: 'kimi', kind: 'dir', path: path.join(os.tmpdir(), 'kimi-adapter-missing-dir') });
  assert.deepEqual(missing.events, []);
  assert.equal(missing.meta.degraded, true);
  assert.ok(['wire_missing', 'invalid_ref'].includes(missing.meta.warnings[0].code));

  const { root, dir, wire } = makeTempSession();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(wire, toolCallLine('tool_9', 'Bash', 'x.sh', 1789559572000));

  // 非法 cursor → 从头读 + warning
  const badCursor = readEvents(refFor(dir), { cursor: 'not-a-number' });
  assert.equal(badCursor.events.length, 1);
  assert.ok(badCursor.meta.warnings.some((w) => w.code === 'invalid_cursor'));

  // cursor 超出文件大小（文件被截断/重写）→ 复位到 0 + warning
  const beyond = readEvents(refFor(dir), { cursor: String(fs.statSync(wire).size + 1000) });
  assert.equal(beyond.events.length, 1);
  assert.ok(beyond.meta.warnings.some((w) => w.code === 'cursor_beyond_eof'));

  // 非法 JSON 行 + 未知类型不应让 readEvents 抛错
  fs.appendFileSync(wire, 'not json at all\n');
  const mixed = readEvents(refFor(dir));
  assert.equal(mixed.events.length, 2);
  assert.equal(mixed.events[1].kind, 'unknown');
});

test('扩展顶层类型：真实会话出现的事件不下沉为 unknown', (t) => {
  const { root, dir, wire } = makeTempSession();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const rows = [
    { type: 'metadata', protocol_version: '1.5', created_at: 1789559571387 },
    { type: 'agent.turn.started', turnId: 0, queueItemId: 'msg_1', time: 1789559572000, kind: 'event' },
    {
      type: 'agent.message.appended',
      kind: 'event',
      time: 1789559572100,
      message: {
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        meta: { source: 'input', promptId: 'msg_1', origin: { kind: 'user' } },
      },
    },
    { type: 'token_counting.turn_recorded', agentId: 'main', turnId: 0, length: 9, tokens: 41850, time: 1789559572200 },
    { type: 'plan.revision', id: 'plan-1', version: 2, path: 'plan/v2.md', sha256: 'abc', bytes: 6236, time: 1789559572300 },
    { type: 'staleGuard.recorded', path: '/tmp/x.js', mtimeMs: 1788158934198.8125, time: 1789559572400 },
    {
      type: 'prompt.completed',
      agentId: 'main',
      promptId: 'msg_1',
      finishedAt: '2026-09-15T13:14:56.754Z',
      reason: 'completed',
      time: 1789559572500,
    },
    { type: 'agent.turn.ended', turnId: 0, outcome: 'done', time: 1789559572600, kind: 'event' },
    { type: 'task.waitDelivered', agentId: 'main', keys: ['bash-1\u0000completed'], time: 1789559572700 },
    { type: 'plan_mode.enter', id: 'plan-1', time: 1789559572800 },
  ];
  fs.writeFileSync(wire, rows.map(line).join(''));

  const { events, meta } = readEvents(refFor(dir));
  assert.equal(events.length, rows.length);
  assert.equal(meta.degraded, false, '已覆盖类型不应产生降级');
  assert.deepEqual(meta.warnings, []);
  assert.ok(!events.some((event) => event.kind === 'unknown'));

  const byName = new Map(events.map((event) => [event.name, event]));
  assert.equal(byName.get('agent.message.appended').text, 'hello');
  assert.equal(byName.get('agent.message.appended').detail.role, 'user');
  assert.equal(byName.get('token_counting.turn_recorded').kind, 'usage');
  assert.equal(byName.get('token_counting.turn_recorded').text, '41850 tokens');
  assert.equal(byName.get('agent.turn.ended').status, 'ok');
  assert.equal(byName.get('plan.revision').text, 'plan plan-1 v2');
  assert.equal(byName.get('staleGuard.recorded').text, '/tmp/x.js');
  assert.ok(ISO_RE.test(byName.get('staleGuard.recorded').detail.mtime));
  assert.equal(byName.get('agent.turn.started').detail.turnId, 0);
  assert.equal(byName.get('plan_mode.enter').kind, 'notice');
  assert.equal(byName.get('task.waitDelivered').detail.keys.length, 1);
});
