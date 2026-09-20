'use strict';

/**
 * pi 适配器测试。
 *
 * 覆盖：
 * 1. 各类记录 → 统一事件（session/meta、model_change、thinking_level_change、custom、
 *    message 的 user/assistant/toolResult/system 四种 role）；
 * 2. 追加式字节偏移游标：尾部半行不消费、增量只给新增行；
 * 3. 大字段剥离：image part 的 base64（assistant 与 toolResult 两处）、toolResult.details 只留预览；
 * 4. 显式降级：未知记录类型 / 未知 content part → unknown + warning；空白文本不产事件；
 * 5. 错误路径：文件不存在、cursor 非法 / 越界、超长行、坏行。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readEvents } = require('../src/core/adapters/pi');

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 建临时会话文件（真实文件名形态：<ISO>_<uuid>.jsonl）。 */
function makeSession(lines, { name = '2026-09-20T02-54-16-805Z_01a0bcbc-5ee5-77bf-8297-21fcb4b2db4a.jsonl' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-adapter-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.length === 0 ? '' : lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, file };
}

function refFor(file) {
  return { adapter: 'pi', kind: 'file', path: file, id: '01a0bcbc-5ee5-77bf-8297-21fcb4b2db4a' };
}

const HEADER = { type: 'session', version: 3, id: '01a0bcbc-5ee5-77bf-8297-21fcb4b2db4a', timestamp: '2026-09-20T02:54:16.805Z', cwd: '/tmp/proj' };

/** 一个完整回合：user → assistant(thinking+text+toolCall) → toolResult → assistant(text)。 */
function fullSession() {
  return [
    HEADER,
    { type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-09-20T02:54:16.900Z', provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
    { type: 'thinking_level_change', id: 't1', parentId: 'm1', timestamp: '2026-09-20T02:54:16.901Z', thinkingLevel: 'high' },
    {
      type: 'message',
      id: 'u1',
      parentId: 't1',
      timestamp: '2026-09-20T02:54:17.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '你是实现者。任务：实现 M2-05。' }], timestamp: 1789872857000 },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      timestamp: '2026-09-20T02:54:18.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先读契约', thinkingSignature: 'reasoning_content' },
          { type: 'text', text: '我来读取文件。' },
          { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '/tmp/proj/a.ts' } },
        ],
        api: 'openai-completions',
        provider: 'opencode-go',
        model: 'deepseek-v4-flash',
        usage: { input: 7691, output: 112, cacheRead: 6912, cacheWrite: 0, reasoning: 14, totalTokens: 14715, cost: { total: 0.0005637268 } },
        stopReason: 'toolUse',
        rawStopReason: 'tool_calls',
        responseId: 'r1',
        timestamp: 1789872858000,
      },
    },
    {
      type: 'message',
      id: 'r1',
      parentId: 'a1',
      timestamp: '2026-09-20T02:54:19.000Z',
      message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'read', content: [{ type: 'text', text: 'file body' }], isError: false, timestamp: 1789872859000 },
    },
    {
      type: 'message',
      id: 'a2',
      parentId: 'r1',
      timestamp: '2026-09-20T02:54:20.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '已完成。' }],
        api: 'openai-completions',
        provider: 'opencode-go',
        model: 'deepseek-v4-flash',
        usage: { input: 100, output: 20, reasoning: 5, cost: { total: 0.001 } },
        stopReason: 'stop',
        rawStopReason: 'completed',
        timestamp: 1789872860000,
      },
    },
  ];
}

test('pi：完整会话的 JSONL → 事件映射', () => {
  const { file } = makeSession(fullSession());
  const r = readEvents(refFor(file));

  assert.equal(r.meta.adapter, 'pi');
  assert.equal(r.meta.degraded, false);
  assert.deepEqual(r.meta.warnings, []);
  assert.equal(r.meta.model.id, 'deepseek-v4-flash');
  assert.equal(r.meta.model.provider, 'opencode-go');

  assert.deepEqual(
    r.events.map((e) => `${e.kind}/${e.name}`),
    [
      'meta/metadata',
      'notice/model_change',
      'notice/thinking_level',
      'notice/user_message',
      'think/thinking',
      'text/assistant',
      'tool_call/read',
      'usage/usage.message',
      'tool_result/read',
      'text/assistant',
      'usage/usage.message',
    ]
  );
  assert.deepEqual(r.events.map((e) => e.seq), r.events.map((_, i) => i));

  const meta = r.events[0];
  assert.equal(meta.detail.sessionId, '01a0bcbc-5ee5-77bf-8297-21fcb4b2db4a');
  assert.equal(meta.detail.cwd, '/tmp/proj');
  assert.equal(meta.detail.version, 3);
  assert.equal(meta.detail.createdAt, '2026-09-20T02:54:16.805Z');

  assert.equal(r.events[1].text, 'opencode-go/deepseek-v4-flash');
  assert.equal(r.events[2].text, 'high');
  assert.equal(r.events[3].text, '你是实现者。任务：实现 M2-05。');
  assert.equal(r.events[4].text, '先读契约');

  const call = r.events[6];
  assert.equal(call.name, 'read');
  assert.equal(call.detail.toolCallId, 'call_1');
  assert.deepEqual(call.detail.args, { path: '/tmp/proj/a.ts' });

  const usage = r.events[7];
  assert.match(usage.text, /7691 in \/ 112 out \/ 14 reasoning \/ 6912 cache read/);
  assert.equal(usage.detail.stopReason, 'toolUse');
  assert.equal(usage.detail.rawStopReason, 'tool_calls');

  const result = r.events[8];
  assert.equal(result.kind, 'tool_result');
  assert.equal(result.status, 'ok');
  assert.equal(result.text, 'file body');
  assert.equal(result.detail.toolCallId, 'call_1');

  assert.equal(r.events.every((e) => e.ts === null || ISO_RE.test(e.ts)), true, 'ts 应为 ISO 或 null');
});

test('pi：追加式字节偏移游标——尾部半行不消费，增量只给新增行', () => {
  const { file } = makeSession(fullSession().slice(0, 4));
  const first = readEvents(refFor(file));
  assert.equal(first.events.length, 4, 'meta + model_change + thinking_level + user');
  assert.ok(first.nextCursor);
  assert.equal(Number(first.nextCursor), fs.statSync(file).size, '游标应停在已消费的完整行末尾');

  // 追加一行完整 + 一行半行（无换行）
  fs.appendFileSync(file, JSON.stringify(fullSession()[4]) + '\n');
  const sizeAfterComplete = fs.statSync(file).size;
  fs.appendFileSync(file, '{"type":"message","id":"half"');

  const second = readEvents(refFor(file), { cursor: first.nextCursor });
  assert.deepEqual(
    second.events.map((e) => e.kind),
    ['think', 'text', 'tool_call', 'usage'],
    '只应输出新追加的那一行（半行留给下次）'
  );
  assert.equal(Number(second.nextCursor), sizeAfterComplete, '游标不得越过未完成的半行');
  assert.equal(second.events.some((e) => e.kind === 'meta'), false, '增量批次不重复 meta');
});

test('pi：尾部半行补全后能正常解析（游标不丢行）', () => {
  const { file } = makeSession([HEADER]);
  const first = readEvents(refFor(file));
  assert.equal(first.events.length, 1); // 仅 meta

  const record = { type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-20T02:54:17.000Z', message: { role: 'user', content: [{ type: 'text', text: '补全测试' }] } };
  const json = JSON.stringify(record);
  fs.appendFileSync(file, json.slice(0, 30)); // 半行
  const mid = readEvents(refFor(file), { cursor: first.nextCursor });
  assert.deepEqual(mid.events, [], '半行不产出事件');
  assert.equal(mid.nextCursor, first.nextCursor, '游标不动');

  fs.appendFileSync(file, json.slice(30) + '\n');
  const done = readEvents(refFor(file), { cursor: mid.nextCursor });
  assert.equal(done.events.length, 1);
  assert.equal(done.events[0].kind, 'notice');
  assert.equal(done.events[0].name, 'user_message');
  assert.equal(done.events[0].text, '补全测试');
});

test('pi：image part 的 base64 在 assistant 与 toolResult 两处都不进入事件', () => {
  const bigBase64 = 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(4000);
  const { file } = makeSession([
    HEADER,
    {
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: '2026-09-20T02:54:18.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'image', data: bigBase64, mimeType: 'image/png' },
          { type: 'text', text: '看这张图' },
        ],
        provider: 'opencode-go',
        model: 'm',
        usage: { input: 1, output: 1 },
        stopReason: 'stop',
      },
    },
    {
      type: 'message',
      id: 'r1',
      parentId: 'a1',
      timestamp: '2026-09-20T02:54:19.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'read',
        content: [
          { type: 'text', text: 'screenshot saved' },
          { type: 'image', data: bigBase64, mimeType: 'image/png' },
        ],
        isError: false,
      },
    },
  ]);
  const r = readEvents(refFor(file));
  const json = JSON.stringify(r.events);
  assert.equal(json.includes(bigBase64.slice(0, 60)), false, 'base64 不得出现在任何事件字段里');

  const imageNotice = r.events.find((e) => e.name === 'image');
  assert.ok(imageNotice);
  assert.equal(imageNotice.text, 'image/png');
  assert.equal(imageNotice.detail.base64Length, bigBase64.length);

  const result = r.events.find((e) => e.kind === 'tool_result');
  assert.equal(result.detail.imageParts, 1);
  assert.equal(result.detail.imageBase64Length, bigBase64.length);
  assert.match(result.text, /screenshot saved/);
  assert.match(result.text, /\[image: image\/png\]/, '工具返回的图片应以占位符呈现');
});

test('pi：toolResult.details（Python repr）只留截断预览', () => {
  const details = "{'truncation': {'content': '" + 'X'.repeat(5000) + "'}}";
  const { file } = makeSession([
    HEADER,
    {
      type: 'message',
      id: 'r1',
      parentId: null,
      timestamp: '2026-09-20T02:54:19.000Z',
      message: { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, details },
    },
  ]);
  const r = readEvents(refFor(file));
  const result = r.events.find((e) => e.kind === 'tool_result');
  assert.equal(result.detail.detailsLength, details.length);
  assert.equal(result.detail.detailsTruncated, true);
  assert.equal(result.detail.detailsPreview.length, 200);
  assert.equal(JSON.stringify(r.events).includes('X'.repeat(300)), false, 'details 正文不得整段进入事件');
});

test('pi：错误回合（errorMessage）与失败的 toolResult', () => {
  const { file } = makeSession([
    HEADER,
    {
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: '2026-09-20T02:54:18.000Z',
      message: {
        role: 'assistant',
        content: [],
        provider: 'xai',
        model: 'grok-4.6',
        usage: { input: 0, output: 0 },
        stopReason: 'error',
        errorMessage: 'Connection error.',
      },
    },
    {
      type: 'message',
      id: 'r1',
      parentId: 'a1',
      timestamp: '2026-09-20T02:54:19.000Z',
      message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'exit 1' }], isError: true },
    },
  ]);
  const r = readEvents(refFor(file));
  const err = r.events.find((e) => e.name === 'error');
  assert.equal(err.status, 'error');
  assert.equal(err.text, 'Connection error.');
  assert.equal(err.detail.stopReason, 'error');

  const failed = r.events.find((e) => e.kind === 'tool_result');
  assert.equal(failed.status, 'error');
  assert.equal(failed.text, 'exit 1');
});

test('pi：system role、custom 记录、空白文本与未知类型', () => {
  const { file } = makeSession([
    HEADER,
    {
      type: 'message',
      id: 's1',
      parentId: null,
      timestamp: '2026-09-20T02:54:19.000Z',
      message: { role: 'system', content: '', sections: { preamble: 'You are an expert coding assistant operating inside pi.' } },
    },
    { type: 'custom', customType: 'web-search-results', data: { id: 'x', urlMetadata: [] } },
    { type: 'brand-new-record', timestamp: '2026-09-20T02:54:20.000Z' },
    {
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: '2026-09-20T02:54:21.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '   ' }, { type: 'weird-part', v: 1 }], provider: 'p', model: 'm' },
    },
  ]);
  const r = readEvents(refFor(file));

  const sys = r.events.find((e) => e.name === 'system');
  assert.match(sys.text, /expert coding assistant/);
  assert.deepEqual(sys.detail.sectionKeys, ['preamble']);

  assert.equal(r.events.find((e) => e.name === 'custom:web-search-results').text, 'web-search-results');

  const unknown = r.events.filter((e) => e.kind === 'unknown');
  assert.equal(unknown.length, 2, '未知记录类型 + 未知 part 类型');
  assert.deepEqual(unknown[0].detail.droppedKind, 'brand-new-record');
  assert.deepEqual(unknown[1].detail.droppedKind, 'weird-part');

  assert.equal(r.events.some((e) => e.kind === 'text'), false, '纯空白文本不产事件');
  assert.equal(r.meta.degraded, true);
  const codes = r.meta.warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ['unknown_part_type', 'unknown_record_type']);
});

test('pi：错误路径（文件不存在 / cursor 非法 / cursor 越界 / 坏行）', () => {
  const missing = readEvents({ adapter: 'pi', kind: 'file', path: '/nonexistent/session.jsonl' });
  assert.deepEqual(missing.events, []);
  assert.equal(missing.meta.warnings[0].code, 'session_missing');

  const { file } = makeSession(fullSession());
  const badCursor = readEvents(refFor(file), { cursor: 'abc' });
  assert.equal(badCursor.meta.warnings[0].code, 'invalid_cursor');
  assert.ok(badCursor.events.length > 0, '游标非法时退化为从头读取');

  const beyond = readEvents(refFor(file), { cursor: String(fs.statSync(file).size + 9999) });
  assert.equal(beyond.meta.warnings[0].code, 'cursor_beyond_eof');
  assert.ok(beyond.events.length > 0);

  const { file: brokenFile } = makeSession([HEADER]);
  fs.appendFileSync(brokenFile, '{not json at all}\n');
  const broken = readEvents(refFor(brokenFile), { cursor: String(0) });
  const unknown = broken.events.find((e) => e.kind === 'unknown');
  assert.equal(unknown.detail.reason, 'parse_error');

  assert.equal(readEvents({ adapter: 'pi' }).meta.warnings[0].code, 'invalid_ref');
});
