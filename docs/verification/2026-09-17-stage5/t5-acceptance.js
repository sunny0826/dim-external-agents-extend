#!/usr/bin/env node
'use strict';

/**
 * 阶段 5 验收脚本：T5.1 样本对照（3 任务 × 3 agent）+ T5.3 边界场景。
 * 运行：mise exec -- node docs/verification/2026-09-17-stage5/t5-acceptance.js
 * 输出：stdout JSON，同时落盘到同目录 t5-acceptance-output.json。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listRuns } = require('../../../server/src/core/runs');
const { mapRunToSession } = require('../../../server/src/core/mapping');
const { readSessionEvents } = require('../../../server/src/core/adapters');

const OUT = path.join(__dirname, 't5-acceptance-output.json');
const result = { generatedAt: new Date().toISOString(), t51: [], t53: [] };

function summarize(res) {
  const kinds = {};
  let toolCall = 0;
  let toolResult = 0;
  let toolError = 0;
  for (const ev of res.events) {
    kinds[ev.kind] = (kinds[ev.kind] || 0) + 1;
    if (ev.kind === 'tool_call') toolCall += 1;
    if (ev.kind === 'tool_result') {
      toolResult += 1;
      if (ev.status === 'error') toolError += 1;
    }
  }
  return {
    events: res.events.length,
    kinds,
    toolCall,
    toolResult,
    toolError,
    degraded: res.meta.degraded,
    warnings: res.meta.warnings.length,
    formatVersion: res.meta.formatVersion,
  };
}

/* ---------- T5.1 样本对照 ---------- */
for (const agentType of ['kimi', 'cursor', 'codex']) {
  const runs = listRuns({ agentType, limit: 4 });
  for (const run of runs) {
    const row = { agentType, taskId: run.taskId, status: run.status };
    try {
      const m = mapRunToSession(run);
      row.mapping = { status: m.status, matchedBy: m.matchedBy, confidence: m.confidence };
      if (m.status === 'matched') {
        const t0 = Date.now();
        const res = readSessionEvents(m.ref, { cursor: null });
        row.readMs = Date.now() - t0;
        row.summary = summarize(res);
      }
    } catch (err) {
      row.error = String((err && err.message) || err);
    }
    result.t51.push(row);
  }
}

/* ---------- T5.3 边界 ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-edge-'));

// 1) 空会话文件
try {
  const dir = path.join(tmp, 'empty-sess', 'agents', 'main');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wire.jsonl'), '');
  const res = readSessionEvents({ adapter: 'kimi', kind: 'dir', path: path.join(tmp, 'empty-sess') });
  result.t53.push({ case: 'empty-wire', events: res.events.length, degraded: res.meta.degraded, nextCursor: res.nextCursor });
} catch (err) {
  result.t53.push({ case: 'empty-wire', error: String((err && err.message) || err) });
}

// 2) 格式漂移：复制真实样本前 300 行 + 注入 4 种异常
try {
  const sampleWire = path.join(
    os.homedir(),
    '.kimi-code',
    'sessions',
    'wd_project-v_2138e21490eb',
    'session_66159b01-bde9-4f73-9bd1-82ae12e0b22e',
    'agents',
    'main',
    'wire.jsonl'
  );
  const copyDir = path.join(tmp, 'drift-sess', 'agents', 'main');
  fs.mkdirSync(copyDir, { recursive: true });
  const lines = fs
    .readFileSync(sampleWire, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(0, 300);
  lines.push('{"type":"future.unknown.kind","time":1234567890,"payload":{"x":1}}'); // 未知顶层
  lines.push('{"type":"context.append_loop_event","event":{"type":"tool.new_kind","weird":true}}'); // 未知内层
  lines.push('this is not json at all'); // 坏行
  lines.push('{"type":"context.append_loop_event"}'); // 缺 event
  fs.writeFileSync(path.join(copyDir, 'wire.jsonl'), lines.join('\n') + '\n');
  const res = readSessionEvents({ adapter: 'kimi', kind: 'dir', path: path.join(tmp, 'drift-sess') });
  const s = summarize(res);
  result.t53.push({
    case: 'format-drift',
    sourceLines: 300,
    injected: 4,
    ...s,
    warningCodes: [...new Set(res.meta.warnings.map((w) => w.code))],
  });
} catch (err) {
  result.t53.push({ case: 'format-drift', error: String((err && err.message) || err) });
}

// 3) 大文件：kimi 最大 wire
try {
  const kRoot = path.join(os.homedir(), '.kimi-code', 'sessions');
  let maxK = { size: 0, file: null };
  for (const d1 of fs.readdirSync(kRoot)) {
    let subs = [];
    try {
      subs = fs.readdirSync(path.join(kRoot, d1));
    } catch {
      continue;
    }
    for (const d2 of subs) {
      const wire = path.join(kRoot, d1, d2, 'agents', 'main', 'wire.jsonl');
      try {
        const st = fs.statSync(wire);
        if (st.size > maxK.size) maxK = { size: st.size, file: wire };
      } catch {
        /* skip */
      }
    }
  }
  if (maxK.file) {
    const sessionDir = path.dirname(path.dirname(path.dirname(maxK.file)));
    const t0 = Date.now();
    const res = readSessionEvents({ adapter: 'kimi', kind: 'dir', path: sessionDir });
    result.t53.push({
      case: 'big-kimi-wire',
      fileSizeMB: Number((maxK.size / 1048576).toFixed(1)),
      readMs: Date.now() - t0,
      events: res.events.length,
      degraded: res.meta.degraded,
    });
  }
} catch (err) {
  result.t53.push({ case: 'big-kimi-wire', error: String((err && err.message) || err) });
}

// 4) 大文件：codex 最大 rollout
try {
  const cRoot = path.join(os.homedir(), '.codex', 'sessions');
  let maxC = { size: 0, file: null };
  for (const y of fs.readdirSync(cRoot)) {
    let months = [];
    try {
      months = fs.readdirSync(path.join(cRoot, y));
    } catch {
      continue;
    }
    for (const mo of months) {
      let days = [];
      try {
        days = fs.readdirSync(path.join(cRoot, y, mo));
      } catch {
        continue;
      }
      for (const d of days) {
        let files = [];
        try {
          files = fs.readdirSync(path.join(cRoot, y, mo, d));
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const full = path.join(cRoot, y, mo, d, f);
          try {
            const st = fs.statSync(full);
            if (st.size > maxC.size) maxC = { size: st.size, file: full };
          } catch {
            /* skip */
          }
        }
      }
    }
  }
  if (maxC.file) {
    const t0 = Date.now();
    const res = readSessionEvents({ adapter: 'codex', kind: 'file', path: maxC.file });
    result.t53.push({
      case: 'big-codex-rollout',
      fileSizeMB: Number((maxC.size / 1048576).toFixed(1)),
      readMs: Date.now() - t0,
      events: res.events.length,
      degraded: res.meta.degraded,
    });
  }
} catch (err) {
  result.t53.push({ case: 'big-codex-rollout', error: String((err && err.message) || err) });
}

// 5) 并发锁：dim 库活跃写入期间连续只读 20 次
try {
  let ok = 0;
  let failed = 0;
  const t0 = Date.now();
  for (let i = 0; i < 20; i += 1) {
    try {
      listRuns({ limit: 5 });
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  result.t53.push({ case: 'concurrent-reads', runs: 20, ok, failed, totalMs: Date.now() - t0 });
} catch (err) {
  result.t53.push({ case: 'concurrent-reads', error: String((err && err.message) || err) });
}

fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
