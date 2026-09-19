'use strict';

/**
 * codex 适配器测试（T1.5）。
 *
 * 覆盖：
 *  - 真实 rollout 样本的结构断言（meta 事件、非 meta 事件、ISO 时间戳、seq、formatVersion）；
 *  - 增量读边界：整行推进 cursor、半行（含 UTF-8 多字节截断）不推进、补齐后才出事件、seq 每次从 0 起；
 *  - 降级：坏行 / 未识别顶层类型 / 未识别二级类型 → unknown + warning，且不影响后续行；
 *  - 体积：超长文本截断并标注，大字段（base_instructions）不入事件；
 *  - 去重：exec 工具调用 ↔ CommandExecution、McpToolCall ↔ function_call、用量双份记录；
 *  - 容错：缺失文件、非法 ref、非法 cursor、cursor 越过 EOF、maxLines 分批无重复无丢失。
 *
 * 真实样本不存在时只跳过「真实样本」用例（其余用例使用临时 JSONL，不依赖本机数据）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readEvents } = require('../src/core/adapters/codex');
const { EVENT_KINDS } = require('../src/core/events');

/* ------------------------------ 测试工具 -------------------------------- */

function makeTempFile(t, content = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-adapter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout-test.jsonl');
  fs.writeFileSync(file, content);
  return file;
}

/** 一行 JSONL（带换行）。 */
function line(obj) {
  return `${JSON.stringify(obj)}\n`;
}

function rec(type, payload, extra = {}) {
  return { timestamp: '2026-09-16T01:00:00.000Z', ordinal: 0, type, payload, ...extra };
}

function sessionMetaLine(extraPayload = {}) {
  return line(
    rec('session_meta', {
      session_id: 'sess-1',
      id: 'sess-1',
      timestamp: '2026-09-16T01:00:00.000Z',
      cwd: '/tmp/ws',
      originator: 'dimcode',
      cli_version: '0.154.0-alpha.6.2',
      source: 'vscode',
      ...extraPayload,
    })
  );
}

function read(file, options) {
  return readEvents({ adapter: 'codex', kind: 'file', path: file, id: 'sess-1' }, options);
}

function kinds(events) {
  return events.map((e) => `${e.kind}/${e.name === null ? '-' : e.name}`);
}

/* --------------------------- 真实样本定位 ------------------------------- */

function pickRollout(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.size < 1024 || st.size > 4 * 1024 * 1024) continue;
    if (best === null || st.size < best.size) best = { file: full, size: st.size };
  }
  return best === null ? null : best.file;
}

/** 找一个真实的 rollout 样本：优先已知日期目录，再按年月日倒序探测。 */
function findRealRollout() {
  const base = path.join(os.homedir(), '.codex', 'sessions');
  for (const dir of [path.join(base, '2026', '09', '16'), path.join(base, '2026', '09', '13')]) {
    const hit = pickRollout(dir);
    if (hit !== null) return hit;
  }
  let years;
  try {
    years = fs.readdirSync(base).filter((n) => /^\d{4}$/.test(n)).sort().reverse();
  } catch {
    return null;
  }
  for (const year of years.slice(0, 2)) {
    let months;
    try {
      months = fs.readdirSync(path.join(base, year)).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
    } catch {
      continue;
    }
    for (const month of months.slice(0, 4)) {
      let days;
      try {
        days = fs.readdirSync(path.join(base, year, month)).filter((n) => /^\d{2}$/.test(n)).sort().reverse();
      } catch {
        continue;
      }
      for (const day of days.slice(0, 5)) {
        const hit = pickRollout(path.join(base, year, month, day));
        if (hit !== null) return hit;
      }
    }
  }
  return null;
}

/* ------------------------------- 用例 ----------------------------------- */

test('真实样本：meta 事件 + 非 meta 事件 + ISO 时间戳 + formatVersion', (t) => {
  const file = findRealRollout();
  if (file === null) {
    t.skip('本机没有可用的 codex rollout 样本');
    return;
  }
  const raw = fs.readFileSync(file, 'utf8');
  const lineCount = raw.split('\n').filter((l) => l.trim().length > 0).length;
  const res = read(file);

  assert.equal(res.meta.adapter, 'codex');
  assert.ok(res.events.length > 0, '样本应产出事件');

  const metas = res.events.filter((e) => e.kind === 'meta');
  assert.equal(metas.length, 1, '首行 session_meta 应产出唯一 meta 事件');
  assert.equal(metas[0].name, 'session');

  const others = res.events.filter((e) => e.kind !== 'meta');
  assert.ok(others.length >= 1, '应至少有一个非 meta 事件');

  res.events.forEach((ev, i) => {
    assert.equal(ev.seq, i, 'seq 应在单次调用内从 0 递增');
    assert.ok(EVENT_KINDS.includes(ev.kind), `kind 必须是统一事件类型：${ev.kind}`);
    if (ev.ts !== null) assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });
  assert.ok(res.events.some((e) => e.ts !== null), '样本事件应带 ISO 时间戳');

  assert.equal(res.meta.formatVersion, metas[0].detail.cliVersion);
  assert.equal(res.meta.degraded, res.meta.warnings.length > 0);
  if (lineCount <= 1000) {
    assert.equal(res.nextCursor, String(fs.statSync(file).size), '整文件读完时 cursor 指向文件末尾');
  }

  // 再次调用（cursor 已在末尾）不应重复产出
  const again = read(file, { cursor: res.nextCursor });
  assert.equal(again.events.length, 0);
  assert.equal(again.nextCursor, res.nextCursor);
});

test('增量读：整行推进 cursor，半行（含 UTF-8 多字节截断）不推进', (t) => {
  const file = makeTempFile(t);
  const l1 = sessionMetaLine();
  const l2 = line(rec('event_msg', { type: 'task_started', turn_id: 'turn-1', model_context_window: 258400 }));
  fs.appendFileSync(file, l1 + l2);

  const first = read(file);
  assert.deepEqual(kinds(first.events), ['meta/session', 'step/turn']);
  assert.equal(first.events[0].detail.phase, undefined);
  assert.equal(first.events[1].detail.phase, 'begin');
  assert.equal(first.nextCursor, String(Buffer.byteLength(l1 + l2)));

  const noChange = read(file, { cursor: first.nextCursor });
  assert.equal(noChange.events.length, 0);
  assert.equal(noChange.nextCursor, first.nextCursor);

  // 追加半行（在 UTF-8 多字节字符中间切断）：不得消费
  const l3 = line(
    rec('response_item', {
      type: 'message',
      id: 'msg-1',
      role: 'assistant',
      content: [{ type: 'output_text', text: '电量提示已接入，稍后验证。' }],
    })
  );
  const l3buf = Buffer.from(l3, 'utf8');
  const cut = l3buf.indexOf(Buffer.from('电', 'utf8')) + 1; // 落在「电」字中间
  fs.appendFileSync(file, l3buf.subarray(0, cut));

  const half = read(file, { cursor: first.nextCursor });
  assert.equal(half.events.length, 0, '半行不应产出事件');
  assert.equal(half.nextCursor, first.nextCursor, '半行不应推进 cursor');

  // 补齐剩余字节：这一次才产出事件，且 seq 从 0 重新开始
  fs.appendFileSync(file, l3buf.subarray(cut));
  const rest = read(file, { cursor: first.nextCursor });
  assert.deepEqual(kinds(rest.events), ['text/assistant']);
  assert.equal(rest.events[0].seq, 0);
  assert.equal(rest.events[0].text, '电量提示已接入，稍后验证。');
  assert.equal(rest.nextCursor, String(fs.statSync(file).size));

  const done = read(file, { cursor: rest.nextCursor });
  assert.equal(done.events.length, 0);
  assert.equal(done.nextCursor, rest.nextCursor);
});

test('降级：坏行 → unknown + warning，且不阻塞后续行', (t) => {
  const file = makeTempFile(t, `${sessionMetaLine()}{"broken":\n${line(rec('event_msg', { type: 'task_started', turn_id: 't1' }))}`);
  const res = read(file);
  assert.deepEqual(kinds(res.events), ['meta/session', 'unknown/invalid_json', 'step/turn']);
  const w = res.meta.warnings.find((x) => x.code === 'malformed_line');
  assert.ok(w, '坏行必须产生 malformed_line warning');
  assert.equal(res.meta.degraded, true);
  assert.equal(res.nextCursor, String(fs.statSync(file).size), '坏行也被消费（否则会永远卡住）');
  const bad = res.events[1];
  assert.equal(bad.kind, 'unknown');
  assert.ok(bad.text.includes('broken'));
});

test('降级：未识别的顶层类型与二级类型 → unknown + 对应 warning', (t) => {
  const file = makeTempFile(
    t,
    sessionMetaLine() +
      line(rec('brand_new_top', { a: 1 })) +
      line(rec('response_item', { type: 'brand_new_item' })) +
      line(rec('event_msg', { type: 'brand_new_msg' })) +
      line(rec('event_msg', { type: 'item_completed', item: { type: 'BrandNewItem', id: 'x' } })) +
      line(rec('response_item', {})) +
      line(rec('event_msg', {}))
  );
  const res = read(file);
  const unknownEvents = res.events.filter((e) => e.kind === 'unknown');
  assert.equal(unknownEvents.length, 6);
  const codes = res.meta.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, [
    'missing_type',
    'missing_type',
    'unknown_event_type',
    'unknown_item_type',
    'unknown_response_item',
    'unknown_top_type',
  ]);
  assert.equal(res.meta.degraded, true);
});

test('体积：超长文本截断并标注，base_instructions 不入事件', (t) => {
  const longText = 'x'.repeat(12000);
  const longInstructions = 'You are a coding agent. '.repeat(2000);
  const longInput = `text(await tools.exec_command({cmd:"echo ${'y'.repeat(5000)}"}));`;
  const file = makeTempFile(
    t,
    sessionMetaLine({ base_instructions: { text: longInstructions } }) +
      line(rec('response_item', { type: 'message', id: 'msg-1', role: 'assistant', content: [{ type: 'output_text', text: longText }] })) +
      line(rec('response_item', { type: 'custom_tool_call', id: 'ctc-1', call_id: 'call-1', name: 'exec', input: longInput }))
  );
  const res = read(file);
  const meta = res.events.find((e) => e.kind === 'meta');
  assert.equal(meta.detail.baseInstructionsChars, longInstructions.length);
  assert.ok(!JSON.stringify(meta).includes(longInstructions.slice(0, 100)), 'base_instructions 正文不得进入事件');

  const text = res.events.find((e) => e.kind === 'text');
  assert.equal(text.detail.truncated, true);
  assert.equal(text.detail.textLength, longText.length);
  assert.ok(text.text.length < longText.length);
  assert.ok(text.text.endsWith('…'));

  const call = res.events.find((e) => e.kind === 'tool_call');
  assert.equal(call.detail.inputTruncated, true);
  assert.equal(call.detail.inputLength, longInput.length);
});

test('映射：消息/推理/步骤/工具调用与结果（含退出码判定）', (t) => {
  const file = makeTempFile(
    t,
    sessionMetaLine() +
      line(rec('event_msg', { type: 'task_started', turn_id: 'turn-1' })) +
      line(rec('response_item', { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: '你好' }] })) +
      line(rec('response_item', { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: '先看目录' }], encrypted_content: 'zzz' })) +
      line(rec('response_item', { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: '开始检查' }] })) +
      line(rec('response_item', { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: '{"cmd":"ls -la"}' })) +
      line(rec('response_item', { type: 'function_call_output', call_id: 'call-1', output: 'Chunk ID: 1\nProcess exited with code 0\nOutput:\nok' })) +
      line(rec('response_item', { type: 'function_call', name: 'exec_command', call_id: 'call-2', arguments: '{"cmd":"false"}' })) +
      line(rec('response_item', { type: 'function_call_output', call_id: 'call-2', output: 'Process exited with code 1\nOutput:\n' })) +
      line(rec('event_msg', { type: 'task_complete', turn_id: 'turn-1', last_agent_message: '完成了', duration_ms: 1000 }))
  );
  const res = read(file);
  assert.deepEqual(kinds(res.events), [
    'meta/session',
    'step/turn',
    'notice/user_message',
    'think/reasoning',
    'text/assistant',
    'tool_call/exec_command',
    'tool_result/exec_command',
    'tool_call/exec_command',
    'tool_result/exec_command',
    'step/turn',
  ]);
  const think = res.events.find((e) => e.kind === 'think');
  assert.equal(think.text, '先看目录');
  assert.equal(think.detail.encrypted, true);

  const calls = res.events.filter((e) => e.kind === 'tool_call');
  assert.equal(calls[0].text, 'ls -la');
  assert.equal(calls[0].detail.callId, 'call-1');

  const results = res.events.filter((e) => e.kind === 'tool_result');
  assert.equal(results[0].name, 'exec_command', '结果事件应按 callId 补上工具名');
  assert.equal(results[0].status, 'ok');
  assert.equal(results[0].detail.exitCode, 0);
  assert.equal(results[1].status, 'error');
  assert.equal(results[1].detail.exitCode, 1);

  const end = res.events[res.events.length - 1];
  assert.equal(end.detail.phase, 'end');
  assert.equal(end.status, 'ok');
  assert.equal(end.text, '完成了');
});

test('会话模型：turn_context 提取，thread_settings 覆盖并可补 provider', (t) => {
  const file = makeTempFile(
    t,
    sessionMetaLine() +
      line(rec('turn_context', { turn_id: 'turn-1', model: 'gpt-6-astra' })) +
      line(
        rec('event_msg', {
          type: 'thread_settings_applied',
          thread_settings: { model: 'gpt-6-mini', model_provider_id: 'custom' },
        })
      )
  );
  const res = read(file);
  assert.deepEqual(res.meta.model, {
    id: 'gpt-6-mini',
    provider: 'custom',
    source: 'event_msg/thread_settings_applied',
  });

  // 仅 turn_context（无 provider）时也应有模型，provider 为 null
  const onlyTurn = makeTempFile(
    t,
    sessionMetaLine() + line(rec('turn_context', { turn_id: 'turn-1', model: 'gpt-6-astra' }))
  );
  assert.deepEqual(read(onlyTurn).meta.model, { id: 'gpt-6-astra', provider: null, source: 'turn_context' });

  // 无模型信息 → null
  const none = makeTempFile(t, sessionMetaLine());
  assert.equal(read(none).meta.model, null);
});

test('去重：exec 工具调用 ↔ CommandExecution（id 不同、命令相同）', (t) => {
  const file = makeTempFile(
    t,
    sessionMetaLine() +
      line(rec('response_item', { type: 'custom_tool_call', id: 'ctc-1', call_id: 'call-1', name: 'exec', status: 'completed', input: 'text(await tools.exec_command({cmd:"ls -la /tmp"}));' })) +
      line(rec('response_item', { type: 'custom_tool_call_output', id: 'ctco-1', call_id: 'call-1', output: [{ type: 'input_text', text: 'Script completed\nOutput:\n{"exit_code":0,"output":"ok"}' }] })) +
      line(rec('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-uuid-1', command: ['/bin/zsh', '-lc', 'ls -la /tmp'], status: 'completed', stdout: 'ok', exit_code: 0 } })) +
      line(rec('event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-uuid-2', command: ['/bin/zsh', '-lc', 'git status --short'], status: 'completed', stdout: 'clean', exit_code: 0 } }))
  );
  const res = read(file);
  const calls = res.events.filter((e) => e.kind === 'tool_call');
  const results = res.events.filter((e) => e.kind === 'tool_result');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'ls -la /tmp');
  // 第二条 CommandExecution 没有对应的 response_item 孪生 → 必须保留（宁可多一条，也不能丢）
  assert.equal(results.length, 2);
  assert.ok(results.every((e) => e.name === 'exec'));
  assert.equal(results[1].detail.source, 'event_msg/item_completed/CommandExecution');
  assert.equal(results[1].detail.command, 'git status --short');
  assert.equal(results[1].status, 'ok');
  // 第一条（有孪生）不得作为 item 事件出现
  assert.ok(!res.events.some((e) => e.detail && e.detail.source === 'event_msg/item_completed/CommandExecution' && e.detail.command === 'ls -la /tmp'));
});

test('去重：McpToolCall ↔ function_call(call_id 相同)', (t) => {
  const file = makeTempFile(
    t,
    sessionMetaLine() +
      line(rec('response_item', { type: 'function_call', name: 'js', namespace: 'mcp__node_repl', call_id: 'call-mcp', arguments: '{"code":"1+1"}' })) +
      line(rec('response_item', { type: 'function_call_output', call_id: 'call-mcp', output: '2' })) +
      line(rec('event_msg', { type: 'item_completed', item: { type: 'McpToolCall', id: 'call-mcp', server: 'node_repl', tool: 'js', status: 'completed', arguments: { code: '1+1' }, result: { ok: true }, duration: 12 } }))
  );
  const res = read(file);
  const calls = res.events.filter((e) => e.kind === 'tool_call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'mcp__node_repl/js');
  assert.equal(res.events.filter((e) => e.kind === 'tool_result').length, 1);
  assert.ok(!res.events.some((e) => e.detail && e.detail.source === 'event_msg/item_completed/McpToolCall'));
});

test('去重：用量双份记录（token_usage_record 与 event_msg/token_count）只保留一条', (t) => {
  const usage = { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, total_tokens: 120 };
  const file = makeTempFile(
    t,
    sessionMetaLine() +
      line(rec('token_usage_record', { turn_id: 'turn-1', response_id: 'resp-1', usage })) +
      line(rec('event_msg', { type: 'token_count', info: { last_token_usage: usage, model_context_window: 258400 } })) +
      line(rec('token_usage_record', { turn_id: 'turn-1', response_id: 'resp-2', usage: { ...usage, total_tokens: 200, output_tokens: 100 } }))
  );
  const res = read(file);
  const usages = res.events.filter((e) => e.kind === 'usage');
  assert.equal(usages.length, 2);
  assert.equal(usages[0].name, 'response_usage');
  assert.equal(usages[0].detail.totalTokens, 120);
  assert.equal(usages[1].detail.totalTokens, 200);
  assert.match(usages[0].text, /输入 100/);
});

test('容错：缺失文件 / 非法 ref / 非法 cursor / cursor 越过 EOF', (t) => {
  const missing = read(path.join(os.tmpdir(), 'codex-adapter-not-exists', 'rollout-x.jsonl'));
  assert.deepEqual(missing.events, []);
  assert.equal(missing.meta.warnings[0].code, 'rollout_unreadable');
  assert.equal(missing.nextCursor, '0');

  const noPath = readEvents({ adapter: 'codex' });
  assert.equal(noPath.meta.warnings[0].code, 'invalid_ref');
  assert.equal(noPath.nextCursor, null);

  const file = makeTempFile(t, sessionMetaLine());
  const size = fs.statSync(file).size;

  const badCursor = read(file, { cursor: 'abc' });
  assert.equal(badCursor.meta.warnings[0].code, 'invalid_cursor');
  assert.equal(badCursor.nextCursor, String(size));

  const beyond = read(file, { cursor: String(size + 500) });
  assert.ok(beyond.meta.warnings.some((w) => w.code === 'cursor_beyond_eof'));
  assert.deepEqual(kinds(beyond.events), ['meta/session'], '越过 EOF 应从文件头重读');

  const nullCursor = read(file, { cursor: null });
  assert.deepEqual(kinds(nullCursor.events), ['meta/session']);
});

test('分批：maxLines 限制单次行数，续读无重复无丢失', (t) => {
  const lines = [sessionMetaLine()];
  for (let i = 0; i < 9; i += 1) {
    lines.push(
      line(
        rec(
          'response_item',
          {
            type: 'message',
            id: `m${i}`,
            role: 'assistant',
            content: [{ type: 'output_text', text: `片段 ${i}` }],
          },
          { ordinal: i + 1 }
        )
      )
    );
  }
  const file = makeTempFile(t, lines.join(''));

  const all = read(file);
  assert.equal(all.events.length, 10);

  let cursor = null;
  const collected = [];
  for (let guard = 0; guard < 20; guard += 1) {
    const res = read(file, { cursor, maxLines: 3 });
    collected.push(...res.events);
    if (res.nextCursor === cursor) break;
    cursor = res.nextCursor;
  }
  assert.equal(cursor, String(fs.statSync(file).size));
  assert.equal(collected.length, 10);
  assert.deepEqual(
    collected.map((e) => e.text),
    all.events.map((e) => e.text)
  );
  assert.deepEqual(
    collected.map((e) => e.kind),
    all.events.map((e) => e.kind)
  );
});
