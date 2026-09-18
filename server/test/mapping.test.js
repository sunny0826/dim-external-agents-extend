'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mapRunToSession, taskTimestampMs } = require('../src/core/mapping');

function mkTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ea-mapping-test-'));
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function mkKimiSession(sessRoot, id, createdAt, lastPrompt) {
  const dir = path.join(sessRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ id, createdAt, lastPrompt }));
  return dir;
}

test('taskTimestampMs：解析与失败', () => {
  assert.equal(taskTimestampMs('task_1789559570749_9kvwq6'), 1789559570749);
  assert.equal(taskTimestampMs('task_bad_x'), null);
  assert.equal(taskTimestampMs(null), null);
});

test('kimi：token 消歧优先于 delta（并行任务场景，候选 delta 仅差 1ms）', () => {
  const home = mkTmpHome();
  const ts = 1789559570749;
  const sessRoot = path.join(home, '.kimi-code', 'sessions', 'wd_x');
  const idA = 'session_aaaaaaaa-0000';
  const idB = 'session_bbbbbbbb-1111';
  const dirA = mkKimiSession(sessRoot, idA, ts + 578, '……任务 GUO-62 的上下文……');
  const dirB = mkKimiSession(sessRoot, idB, ts + 579, '……任务 GUO-63 的上下文……');
  writeJsonl(path.join(home, '.kimi-code', 'session_index.jsonl'), [
    { sessionId: idA, sessionDir: dirA, workDir: '/w' },
    { sessionId: idB, sessionDir: dirB, workDir: '/w' },
  ]);
  const run = {
    taskId: `task_${ts}_abc123`,
    agentType: 'kimi',
    taskTitle: 'Kimi 实现 GUO-63（x）',
    prompt: '你负责实现 Linear Issue **GUO-63**。',
  };
  const m = mapRunToSession(run, { home });
  assert.equal(m.status, 'matched');
  assert.equal(m.matchedBy, 'timestamp+token');
  assert.equal(m.confidence, 'high');
  assert.equal(m.ref.id, idB); // 应选含 GUO-63 的会话，而不是 delta 更小的 idA
});

test('kimi：无 token 命中时按 delta 取最接近，并保留歧义警告', () => {
  const home = mkTmpHome();
  const ts = 1789559570749;
  const sessRoot = path.join(home, '.kimi-code', 'sessions', 'wd_x');
  const dirA = mkKimiSession(sessRoot, 'session_aaaaaaaa', ts + 578, 'no tokens here');
  const dirB = mkKimiSession(sessRoot, 'session_bbbbbbbb', ts + 579, 'no tokens either');
  writeJsonl(path.join(home, '.kimi-code', 'session_index.jsonl'), [
    { sessionId: 'session_aaaaaaaa', sessionDir: dirA },
    { sessionId: 'session_bbbbbbbb', sessionDir: dirB },
  ]);
  const run = { taskId: `task_${ts}_abc123`, agentType: 'kimi', taskTitle: '无编号任务', prompt: '没有 ID 的任务' };
  const m = mapRunToSession(run, { home });
  assert.equal(m.status, 'matched');
  assert.equal(m.matchedBy, 'timestamp');
  assert.equal(m.confidence, 'low');
  assert.equal(m.warnings[0].code, 'ambiguous_candidates');
  assert.equal(m.ref.id, 'session_aaaaaaaa');
});

test('kimi：无匹配 → unmatched', () => {
  const home = mkTmpHome();
  fs.mkdirSync(path.join(home, '.kimi-code'), { recursive: true });
  writeJsonl(path.join(home, '.kimi-code', 'session_index.jsonl'), []);
  const m = mapRunToSession({ taskId: 'task_1789559570749_zzz', agentType: 'kimi' }, { home });
  assert.equal(m.status, 'unmatched');
  assert.equal(m.ref, null);
});

test('cursor：目录 birthtime 在容差内匹配', () => {
  const home = mkTmpHome();
  const root = path.join(home, '.cursor', 'acp-sessions');
  const dir = path.join(root, 'uuid-1234-5678');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ cwd: '/w', title: 'T' }));
  const now = Date.now(); // 目录刚创建，delta ≈ 0
  const run = { taskId: `task_${now}_xyz789`, agentType: 'cursor' };
  const m = mapRunToSession(run, { home });
  assert.equal(m.status, 'matched');
  assert.equal(m.ref.adapter, 'cursor');
  assert.equal(m.ref.id, 'uuid-1234-5678');
});

test('cursor：窗口外（1 小时差）→ unmatched', () => {
  const home = mkTmpHome();
  const root = path.join(home, '.cursor', 'acp-sessions');
  fs.mkdirSync(path.join(root, 'uuid-old'), { recursive: true });
  const run = { taskId: `task_${Date.now() - 3600000}_old000`, agentType: 'cursor' };
  const m = mapRunToSession(run, { home });
  assert.equal(m.status, 'unmatched');
});

test('codex：rollout 首行 session_meta 匹配', () => {
  const home = mkTmpHome();
  const iso = '2026-09-17T05:00:00.500Z';
  const ts = Date.parse('2026-09-17T05:00:00.000Z');
  const d = new Date(ts);
  const dir = path.join(
    home,
    '.codex',
    'sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'rollout-2026-09-17T13-00-00-abc.jsonl'),
    JSON.stringify({ timestamp: iso, ordinal: 0, type: 'session_meta', payload: { session_id: 'sid-1', cwd: '/w', timestamp: iso } }) + '\n'
  );
  const run = { taskId: `task_${ts}_cdx001`, agentType: 'codex' };
  const m = mapRunToSession(run, { home });
  assert.equal(m.status, 'matched');
  assert.equal(m.ref.adapter, 'codex');
  assert.equal(m.ref.id, 'sid-1');
});

test('unsupported：不支持的 agent 类型', () => {
  const home = mkTmpHome();
  const m = mapRunToSession({ taskId: 'task_1789616533081_081muy', agentType: 'grok' }, { home });
  assert.equal(m.status, 'unsupported');
  assert.equal(m.warnings[0].code, 'unsupported_agent');
});

test('unsupported：缺少 agentType', () => {
  const m = mapRunToSession({ taskId: 'task_1789616533081_081muy' });
  assert.equal(m.status, 'unsupported');
  assert.equal(m.warnings[0].code, 'no_agent_type');
});
