#!/usr/bin/env node
'use strict';

/**
 * T5.2 近实时观测：等待并跟踪最新的 kimi running 任务，每 2s 快照一次事件数，
 * 任务完结（或超时）后输出时间线，并给出「单调性 / seq 连续性」判定。
 *
 * 运行：mise exec -- node docs/verification/2026-09-17-stage5/t5-realtime-watch.js
 */

const { listRuns } = require('../../../server/src/core/runs');
const { mapRunToSession } = require('../../../server/src/core/mapping');
const { readSessionEvents } = require('../../../server/src/core/adapters');

const MAX_WAIT_MS = 300000;
const TICK_MS = 2000;
const started = Date.now();

const timeline = [];
let taskId = null;
let sessionRef = null;
let lastCount = -1;
let monotonic = true;
let seqContinuous = true;

function tick() {
  if (Date.now() - started > MAX_WAIT_MS) {
    finish('timeout', null);
    return;
  }

  let run = null;
  try {
    if (taskId !== null) {
      run = listRuns({ agentType: 'kimi', limit: 8 }).find((r) => r.taskId === taskId) || null;
    } else {
      run = listRuns({ agentType: 'kimi', limit: 8 }).find((r) => r.status === 'running') || null;
    }
  } catch (err) {
    console.log(`（查询失败：${String((err && err.message) || err)}）`);
    return;
  }

  if (taskId === null) {
    if (run === null) return; // 等待新任务出现
    taskId = run.taskId;
    const m = mapRunToSession(run);
    if (m.status !== 'matched') {
      return; // 会话尚未就绪，下个 tick 再看
    }
    sessionRef = m.ref;
    console.log(`发现 running 任务：${taskId}（会话 ${m.matchedBy}/${m.confidence}）`);
  }

  if (sessionRef !== null) {
    const res = readSessionEvents(sessionRef, { cursor: null });
    const evs = res.events;
    const delta = lastCount < 0 ? evs.length : evs.length - lastCount;
    if (lastCount >= 0 && evs.length < lastCount) monotonic = false;
    for (let i = 0; i < evs.length; i += 1) {
      if (evs[i].seq !== i) {
        seqContinuous = false;
        break;
      }
    }
    timeline.push({ tMs: Date.now() - started, events: evs.length, delta });
    console.log(`t=${((Date.now() - started) / 1000).toFixed(1)}s events=${evs.length} delta=${delta}`);
    lastCount = evs.length;
  }

  if (run !== null && run.status !== 'running') {
    finish('finished', run.status);
  }
}

function finish(reason, status) {
  clearInterval(timer);
  const out = {
    taskId,
    reason,
    finalStatus: status,
    monotonic,
    seqContinuous,
    snapshots: timeline.length,
    firstSeenEvents: timeline.length > 0 ? timeline[0].events : null,
    lastEvents: timeline.length > 0 ? timeline[timeline.length - 1].events : null,
    timeline,
  };
  console.log('=== 结果 ===');
  console.log(JSON.stringify(out, null, 1));
  process.exit(reason === 'timeout' ? 2 : 0);
}

console.log('等待 kimi running 任务出现（最多 300s）…');
const timer = setInterval(tick, TICK_MS);
tick();
