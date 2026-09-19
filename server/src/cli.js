#!/usr/bin/env node
'use strict';

/**
 * external-agents-extend CLI（T4.1）。
 *
 *   dim-external-agents-extend list  [--type <agent>] [--status <s>] [--limit N] [--json]
 *   dim-external-agents-extend show  <taskId> [--limit N] [--json]
 *   dim-external-agents-extend tail  <taskId> [--interval <ms>]
 *
 * 复用 server 侧 core/tools 逻辑（含四类语义），输出为人类可读；--json 便于脚本消费。
 * 零第三方依赖；日志读取全部本机完成。
 */

const os = require('node:os');
const { listAgentRuns, readAgentRun } = require('./tools');

const USAGE = `external-agents-extend — 查看外部 agent 委托任务的执行日志

用法：
  dim-external-agents-extend list  [--type <agent>] [--status <s>] [--limit N] [--json]
  dim-external-agents-extend show  <taskId> [--limit N] [--json]
  dim-external-agents-extend tail  <taskId> [--interval <ms>]

选项：
  --type <agent>    过滤 agent 类型（kimi / cursor / codex / ...）
  --status <s>      过滤状态（running / completed / failed / cancelled）
  --limit N         条数上限（list 默认 20；show 默认 100）
  --interval <ms>   tail 轮询间隔（默认 2000，最小 500）
  --json            以 JSON 输出（脚本可解析）
  --home <dir>      覆盖用户主目录（测试用）
  --help            显示本帮助

示例：
  dim-external-agents-extend list --type kimi --limit 5
  dim-external-agents-extend show task_1789559570749_9kvwq6
  dim-external-agents-extend tail task_1789620769595_mugj1d --interval 2000`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--limit') opts.limit = Number(argv[(i += 1)]);
    else if (a === '--type') opts.agentType = argv[(i += 1)];
    else if (a === '--status') opts.status = argv[(i += 1)];
    else if (a === '--interval') opts.interval = Number(argv[(i += 1)]);
    else if (a === '--home') opts.home = argv[(i += 1)];
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

function deps(opts) {
  return opts.home !== undefined ? { home: opts.home } : {};
}

function clip(s, n) {
  const str = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function padEnd(s, n) {
  const str = String(s === undefined || s === null ? '' : s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function fmtClock(iso) {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toTimeString().slice(0, 8);
}

function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function printEvent(ev) {
  const time = fmtClock(ev.ts);
  const kind = padEnd(clip(ev.kind || '?', 12), 12);
  const name = padEnd(clip(ev.name || '', 22), 22);
  const text = clip(ev.text || '', 90);
  const err = ev.status === 'error' ? ' [error]' : '';
  console.log(`  #${padEnd(String(ev.seq), 5)} ${time}  ${kind} ${name} ${text}${err}`);
}

function cmdList(opts) {
  // CLI 不属于任何 dim 会话：列表默认展示全部（scope=all），避免被「活跃会话」过滤为空
  const res = listAgentRuns(
    { limit: opts.limit, agentType: opts.agentType, status: opts.status, scope: 'all' },
    deps(opts)
  );
  const data = JSON.parse(res.text);
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return res.isError ? 1 : 0;
  }
  if (data.status === 'db_unavailable') {
    console.error(`错误：${data.message}`);
    return 1;
  }
  if (!data.runs || data.runs.length === 0) {
    console.log('没有找到任务。');
    return 0;
  }
  console.log(
    [padEnd('TASK', 32), padEnd('AGENT', 8), padEnd('STATUS', 10), padEnd('STARTED', 13), 'TITLE'].join(' ')
  );
  for (const r of data.runs) {
    console.log(
      [
        padEnd(clip(r.taskId, 32), 32),
        padEnd(clip(r.agentType || '-', 8), 8),
        padEnd(clip(r.status || '-', 10), 10),
        padEnd(fmtDateTime(r.startedAt), 13),
        clip(r.taskTitle || '', 60),
      ].join(' ')
    );
  }
  return 0;
}

function collectEvents(opts, taskId, pageLimit, maxEvents) {
  let cursor = '0';
  let first = null;
  const events = [];
  for (;;) {
    const res = readAgentRun({ taskId, cursor, limit: pageLimit }, deps(opts));
    const data = JSON.parse(res.text);
    if (first === null) first = data;
    if (data.status === 'task_not_found' || data.status === 'no_log') return { first: data, events };
    events.push(...(data.events || []));
    if (events.length >= maxEvents) break;
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return { first, events };
}

function cmdShow(opts) {
  const taskId = opts._[0];
  if (!taskId) {
    console.error('用法：dim-external-agents-extend show <taskId>');
    return 2;
  }
  const maxEvents = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 100;
  const { first, events } = collectEvents(opts, taskId, 200, maxEvents);

  if (first.status === 'task_not_found') {
    console.error(`任务不存在：${taskId}`);
    return 1;
  }
  if (first.status === 'no_log') {
    console.error(`没有可读日志：${first.reason || '未知原因'}`);
    return 1;
  }
  if (first.status === 'db_unavailable') {
    console.error(`错误：${first.message || 'dim 数据库不可读'}`);
    return 1;
  }
  const page = events.slice(0, maxEvents);
  if (opts.json) {
    console.log(JSON.stringify({ ...first, events: page }, null, 2));
    return 0;
  }
  const t = first.task || {};
  console.log(`任务    ${t.taskId}`);
  console.log(`类型    ${t.agentType || '-'}${t.agentName ? ' · ' + t.agentName : ''} · ${t.status}`);
  if (t.taskTitle) console.log(`标题    ${t.taskTitle}`);
  console.log(`时间    ${t.startedAt || '-'} → ${t.completedAt || '（未结束）'}`);
  /* 模型：优先会话实际使用（session.model），回退 dim 派发时选择（task.model）。 */
  const actualModel = first.session && first.session.model && first.session.model.id ? first.session.model.id : null;
  const model = actualModel || t.model || null;
  if (model) console.log(`模型    ${model}${actualModel ? '（会话实际）' : '（派发时选择）'}`);
  if (first.session) {
    console.log(`会话    ${first.session.adapter} · ${first.session.matchedBy} · ${first.session.confidence}`);
  }
  console.log(`事件    共 ${first.total} 条，显示前 ${page.length} 条${first.total > page.length ? '（--limit 调整）' : ''}`);
  if (first.meta && first.meta.degraded) {
    console.log(`降级    ${(first.meta.warnings || []).map((w) => w.code).join(', ')}`);
  }
  console.log('');
  for (const ev of page) printEvent(ev);
  return 0;
}

function cmdTail(opts) {
  const taskId = opts._[0];
  if (!taskId) {
    console.error('用法：dim-external-agents-extend tail <taskId>');
    return 2;
  }
  const interval = Number.isFinite(opts.interval) && opts.interval >= 500 ? opts.interval : 2000;
  let consumed = 0;
  console.log(`跟随 ${taskId}（Ctrl-C 退出，间隔 ${interval}ms）…`);

  const tick = () => {
    const res = readAgentRun({ taskId, cursor: String(consumed), limit: 200 }, deps(opts));
    const data = JSON.parse(res.text);
    if (data.status === 'task_not_found') {
      console.error('停止：任务不存在。');
      process.exit(1);
    }
    if (data.status === 'no_log') {
      console.error(`停止：没有可读日志（${data.reason || '未知原因'}）。`);
      process.exit(1);
    }
    if (data.status === 'db_unavailable') {
      console.error(`停止：${data.message || 'dim 数据库不可读'}`);
      process.exit(1);
    }
    const evs = data.events || [];
    for (const ev of evs) printEvent(ev);
    consumed = Number(data.cursor || '0') + evs.length;
    if (data.status !== 'running' && evs.length === 0 && (data.nextCursor === null || data.nextCursor === undefined)) {
      console.log(`任务已结束（${(data.task && data.task.status) || '?'}），共 ${consumed} 条事件。`);
      process.exit(0);
    }
  };

  tick();
  const timer = setInterval(tick, interval);
  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('\n已退出。');
    process.exit(0);
  });
  return undefined; // 保持进程存活
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || opts._.length === 0) {
    console.log(USAGE);
    return opts.help ? 0 : 2;
  }
  const cmd = opts._.shift();
  if (cmd === 'list') return cmdList(opts);
  if (cmd === 'show') return cmdShow(opts);
  if (cmd === 'tail') return cmdTail(opts);
  console.error(`未知命令：${cmd}\n`);
  console.log(USAGE);
  return 2;
}

const code = main();
if (code !== undefined) process.exitCode = code;
