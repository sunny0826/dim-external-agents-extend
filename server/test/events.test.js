'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEvent, makeReadResult, toIso, warning } = require('../src/core/events');

test('toIso：毫秒数、ISO 字符串与无效值', () => {
  assert.equal(toIso(1789559571387), '2026-09-16T11:52:51.387Z');
  assert.equal(toIso('2026-09-16T11:52:51.387Z'), '2026-09-16T11:52:51.387Z');
  assert.equal(toIso(null), null);
  assert.equal(toIso(undefined), null);
  assert.equal(toIso('nonsense'), null);
  assert.equal(toIso(NaN), null);
  assert.equal(toIso({}), null);
});

test('makeEvent：字段规范化与默认值', () => {
  const ev = makeEvent({ seq: 3, ts: 1789559571387, kind: 'tool_call', name: 'read', status: 'ok', text: 'hi' });
  assert.deepEqual(ev, {
    seq: 3,
    ts: '2026-09-16T11:52:51.387Z',
    kind: 'tool_call',
    name: 'read',
    status: 'ok',
    text: 'hi',
    detail: null,
    raw: null,
  });
});

test('makeEvent：默认值（无参，kind 缺失按降级记录）', () => {
  const ev = makeEvent();
  assert.deepEqual(ev, {
    seq: 0,
    ts: null,
    kind: 'unknown',
    name: null,
    status: null,
    text: null,
    detail: { droppedKind: null },
    raw: null,
  });
});

test('makeEvent：非法 kind 降级为 unknown 且保留原值', () => {
  const ev = makeEvent({ kind: 'bogus' });
  assert.equal(ev.kind, 'unknown');
  assert.equal(ev.detail.droppedKind, 'bogus');
});

test('makeEvent：非字符串 kind 也记录', () => {
  const ev = makeEvent({ kind: 42, detail: { note: 'x' } });
  assert.equal(ev.kind, 'unknown');
  assert.equal(ev.detail.droppedKind, 42);
  assert.equal(ev.detail.note, 'x');
});

test('makeEvent：非法 status 归 null；非对象 detail/raw 归 null', () => {
  const ev = makeEvent({ kind: 'text', status: 'weird', detail: 'not-an-object', raw: 7 });
  assert.equal(ev.status, null);
  assert.equal(ev.detail, null);
  assert.equal(ev.raw, null);
});

test('makeReadResult：degraded 与 warnings 联动、nextCursor 透传', () => {
  const ok = makeReadResult([], { adapter: 'kimi', formatVersion: '1.5' });
  assert.equal(ok.meta.degraded, false);
  assert.deepEqual(ok.meta.warnings, []);
  assert.equal(ok.meta.adapter, 'kimi');
  assert.equal(ok.meta.formatVersion, '1.5');
  assert.equal(ok.nextCursor, null);

  const degraded = makeReadResult([], { adapter: 'codex', warnings: [warning('unknown_type', 'x')] });
  assert.equal(degraded.meta.degraded, true);
  assert.equal(degraded.meta.warnings[0].code, 'unknown_type');
});

test('warning：结构', () => {
  const w = warning('a_code', 'a message', { line: 3 });
  assert.deepEqual(w, { code: 'a_code', message: 'a message', line: 3 });
});
