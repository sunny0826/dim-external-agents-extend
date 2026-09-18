#!/usr/bin/env node
/**
 * 阶段 1 冒烟：runs → mapping → adapter 全链路（真实数据，只读）。
 * 运行：mise exec -- node docs/verification/2026-09-17-stage1/t1-smoke.js [agentType]
 *
 * 输出：任务匹配统计 + 每适配器的事件数与 kind 分布 + 降级/警告摘要。
 */
'use strict';

const { listRuns } = require('../../../server/src/core/runs');
const { mapRunToSession } = require('../../../server/src/core/mapping');
const { readSessionEvents } = require('../../../server/src/core/adapters');

const MAX_PER_ADAPTER = 5;

const filter = process.argv[2] || undefined;
const runs = listRuns({ limit: 120, agentType: filter });

const perAdapter = {};
let matched = 0;
let unmatched = 0;
let unsupported = 0;
let readRuns = 0;
const unmatchedSamples = [];

for (const run of runs) {
  const m = mapRunToSession(run);
  if (m.status !== 'matched') {
    if (m.status === 'unmatched') {
      unmatched += 1;
      if (unmatchedSamples.length < 5) unmatchedSamples.push(run.taskId);
    } else {
      unsupported += 1;
    }
    continue;
  }
  matched += 1;
  const agg = (perAdapter[m.ref.adapter] = perAdapter[m.ref.adapter] || {
    runs: 0,
    events: 0,
    degradedRuns: 0,
    kinds: {},
    warnings: [],
  });
  if (agg.runs >= MAX_PER_ADAPTER) continue;
  let res;
  try {
    res = readSessionEvents(m.ref, { cursor: null });
  } catch (err) {
    agg.warnings.push(`task ${run.taskId}: ${String((err && err.message) || err)}`);
    continue;
  }
  readRuns += 1;
  agg.runs += 1;
  agg.events += res.events.length;
  if (res.meta.degraded) agg.degradedRuns += 1;
  for (const w of res.meta.warnings) {
    if (agg.warnings.length < 8) agg.warnings.push(`${w.code}: ${String(w.message).slice(0, 80)}`);
  }
  for (const ev of res.events) agg.kinds[ev.kind] = (agg.kinds[ev.kind] || 0) + 1;
}

console.log(
  JSON.stringify(
    {
      filter: filter || null,
      total: runs.length,
      matched,
      unmatched,
      unsupported,
      readRuns,
      perAdapter,
      unmatchedSamples,
    },
    null,
    2
  )
);
