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
const {
  listAgentRuns,
  readAgentRun,
  listExternalSessionsTool,
  renameExternalSessionsTool,
  autoNameSessionsTool,
  restoreBackupsTool,
} = require('./tools');

const USAGE = `external-agents-extend — 查看外部 agent 委托任务的执行日志与会话名称

用法：
  dim-external-agents-extend list    [--type <agent>] [--status <s>] [--limit N] [--json]
  dim-external-agents-extend show    <taskId> [--limit N] [--json]
  dim-external-agents-extend tail    <taskId> [--interval <ms>]
  dim-external-agents-extend sessions [--type <agent>] [--limit N] [--since <iso>] [--search <kw>] [--all] [--json]
  dim-external-agents-extend rename  --keys <k1,k2> [--title <name>] [--apply] [--force] [--json]
  dim-external-agents-extend autoname [--window <min>] [--max N] [--dry-run] [--json]
  dim-external-agents-extend autoname --enable | --disable   # 开关「委托后自动统一会话名」（默认关闭）
  dim-external-agents-extend restore  [--backup <dir>] [--apply] [--json]

选项：
  --type <agent>    过滤 agent 类型（kimi / cursor / codex / grok / opencode / zcode，可逗号分隔）
  --status <s>      过滤状态（running / completed / failed / cancelled）
  --limit N         条数上限（list / sessions 默认 20；show 默认 100）
  --interval <ms>   tail 轮询间隔（默认 2000，最小 500）
  --since <iso>     sessions：只看该时间之后创建的会话（ISO 8601）
  --search <kw>     sessions：按名称 / 原始标题 / 工作目录 / 会话 id 过滤
  --all             sessions：包含已归档会话
  --keys <k1,k2>    rename：要改名的会话 key（来自 sessions 输出）
  --title <name>    rename：指定写入的名称（默认用统一推导名）
  --apply           rename：真正写入（默认只预览；写入前会备份）
  --force           rename：连你自己手动设过标题的会话一起改
  --window <min>    autoname：只看最近 N 分钟内委托的任务（默认 120）
  --max N           autoname：单次最多改几个（默认 20）
  --dry-run         autoname：只预览不改（hook 里的自动改名默认会真写）
  --backup <dir>    restore：指定备份目录（默认取 ~/.dimcode/ea-extend-backups 下最新一个）
  --enable/--disable  autoname：开启/关闭「委托后自动统一会话名」（写 ~/.dimcode/ea-extend-config.json）
  --json            以 JSON 输出（脚本可解析）
  --home <dir>      覆盖用户主目录（测试用）
  --help            显示本帮助

示例：
  dim-external-agents-extend list --type kimi --limit 5
  dim-external-agents-extend show task_1789559570749_9kvwq6
  dim-external-agents-extend sessions --type codex --limit 20
  dim-external-agents-extend rename --keys codex:01a0b7ee-a483-7a70-835b-78b7f93349e7
  dim-external-agents-extend autoname --window 1440 --dry-run
  dim-external-agents-extend autoname --enable  # 打开自动命名（默认关闭）
  dim-external-agents-extend restore            # 预览回滚（默认最新备份）
  dim-external-agents-extend restore --apply    # 真正回滚`;

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
    else if (a === '--since') opts.since = argv[(i += 1)];
    else if (a === '--search') opts.search = argv[(i += 1)];
    else if (a === '--window') opts.window = Number(argv[(i += 1)]);
    else if (a === '--max') opts.max = Number(argv[(i += 1)]);
    else if (a === '--keys') opts.keys = String(argv[(i += 1)] || '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    else if (a === '--title') opts.title = argv[(i += 1)];
    else if (a === '--apply') opts.apply = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--backup') opts.backup = argv[(i += 1)];
    else if (a === '--enable') opts.enable = true;
    else if (a === '--disable') opts.disable = true;
    else if (a === '--all') opts.all = true;
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

function cmdSessions(opts) {
  const res = listExternalSessionsTool(
    {
      limit: opts.limit,
      agentType: opts.agentType,
      since: opts.since,
      search: opts.search,
      includeArchived: opts.all === true,
    },
    deps(opts)
  );
  const data = JSON.parse(res.text);
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return res.isError ? 1 : 0;
  }
  if (res.isError) {
    console.error(`错误：${data.message}`);
    return 1;
  }
  if (!data.sessions || data.sessions.length === 0) {
    console.log('没有找到会话。');
    return 0;
  }
  console.log([padEnd('AGENT', 9), padEnd('TIME', 12), padEnd('SOURCE', 9), 'NAME  (KEY)'].join(' '));
  for (const s of data.sessions) {
    const name = clip(s.unifiedName || s.title, 46) + (s.customTitle ? '  [你自定义过]' : '');
    console.log(
      [
        padEnd(clip(s.agentType, 9), 9),
        padEnd(fmtDateTime(s.createdAt), 12),
        padEnd(clip(s.titleSource || '-', 9), 9),
        padEnd(name, 50),
        s.key,
      ].join(' ')
    );
  }
  console.log(`\n共 ${data.total} 个会话，显示 ${data.count} 个（--limit / --type / --since 调整）。`);
  for (const w of data.warnings || []) console.log(`警告：${w.message}`);
  return 0;
}

function cmdRename(opts) {
  if (!opts.keys || opts.keys.length === 0) {
    console.error('用法：dim-external-agents-extend rename --keys <k1,k2> [--title <name>] [--apply]');
    return 2;
  }
  const res = renameExternalSessionsTool(
    {
      keys: opts.keys,
      title: opts.title,
      apply: opts.apply === true,
      force: opts.force === true,
      agentType: opts.agentType,
      limit: opts.limit,
    },
    deps(opts)
  );
  const data = JSON.parse(res.text);
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return res.isError ? 1 : 0;
  }
  if (res.isError) {
    console.error(`错误：${data.message}`);
    return 1;
  }
  for (const r of data.results || []) {
    const tag = { renamed: '已改名', planned: '待改名', skipped: '跳过', unsupported: '不支持', failed: '失败', not_found: '未找到' }[r.status] || r.status;
    console.log(`${tag}  ${r.key}`);
    if (r.previous !== undefined) console.log(`      原名  ${clip(r.previous, 70) || '（空）'}`);
    if (r.next !== undefined) console.log(`      新名  ${clip(r.next, 70)}`);
    if (r.reason) console.log(`      说明  ${r.reason}`);
    if (r.backupPath) console.log(`      备份  ${r.backupPath}`);
  }
  const s = data.summary || {};
  console.log(
    `\n${data.dryRun ? '预览（未写入）' : '已写入'}：共 ${s.total} 项，改名 ${s.renamed}，待改名 ${s.planned}，跳过 ${s.skipped}，不支持 ${s.unsupported}，失败 ${s.failed}。`
  );
  if (data.dryRun) console.log('确认无误后加 --apply 真正写入（写入前会自动备份）。');
  if (data.backupDir) console.log(`备份目录：${data.backupDir}`);
  return s.failed > 0 ? 1 : 0;
}

function cmdAutoname(opts) {
  const home = opts.home !== undefined ? opts.home : os.homedir();
  /* 开关：默认关闭；`autoname --enable/--disable` 写配置文件（桌面端唯一可靠的方式） */
  if (opts.enable === true || opts.disable === true) {
    const { writeSettings } = require('./core/settings');
    const { file } = writeSettings(home, { autoName: opts.enable === true });
    console.log(`${opts.enable === true ? '已开启' : '已关闭'}「委托后自动统一会话名」：${file}`);
    console.log(
      opts.enable === true
        ? '之后 dim 每次委托外部 Agent，hook 会自动把该会话的泛化标题改写成统一名（只动 dim 委托、只动泛化标题、写前备份）。'
        : 'hook 不再自动改写任何会话名；手动 `rename` / `autoname` 仍可用。'
    );
    return 0;
  }

  const res = autoNameSessionsTool(
    {
      windowMinutes: Number.isFinite(opts.window) ? opts.window : undefined,
      max: Number.isFinite(opts.max) ? opts.max : undefined,
      apply: opts.dryRun !== true && opts.apply !== false,
    },
    deps(opts)
  );
  const data = JSON.parse(res.text);
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return res.isError ? 1 : 0;
  }
  if (res.isError) {
    console.error(`错误：${data.message}`);
    return 1;
  }
  const sw = data.autoName || {};
  console.log(
    `自动命名：${sw.enabled ? '已开启' : '已关闭（默认）'}${sw.enabled ? `（来源：${sw.source}）` : `，用 autoname --enable 开启（${sw.configPath || ''}）`}`
  );
  if (!data.results || data.results.length === 0) {
    console.log(`窗口内没有需要改名的会话（考察 ${data.considered || 0} 个最近委托任务）。`);
  } else {
    for (const r of data.results) {
      const tag = { renamed: '已改名', planned: '待改名', skipped: '跳过', unsupported: '不支持', failed: '失败' }[r.status] || r.status;
      console.log(`${tag}  ${r.key}`);
      if (r.previous !== undefined) console.log(`      原名  ${clip(r.previous, 70) || '（空）'}`);
      if (r.next !== undefined) console.log(`      新名  ${clip(r.next, 70)}`);
      if (r.reason) console.log(`      说明  ${r.reason}`);
      if (r.backupPath) console.log(`      备份  ${r.backupPath}`);
    }
  }
  console.log(
    `\n${data.dryRun ? '预览（未写入）' : '已写入'}：考察 ${data.considered} 个任务，改名 ${data.renamed}，其余为名称已够好 / 自定义标题 / 会话未落盘。`
  );
  return 0;
}

function cmdRestore(opts) {
  const res = restoreBackupsTool({ backupDir: opts.backup, apply: opts.apply === true }, deps(opts));
  const data = JSON.parse(res.text);
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return res.isError ? 1 : 0;
  }
  if (res.isError) {
    console.error(`错误：${data.message}`);
    return 1;
  }
  if (data.status === 'no_backup') {
    console.log(data.message);
    return 0;
  }
  console.log(`备份目录  ${data.backupDir}`);
  for (const r of data.results || []) {
    const tag = { restored: '已还原', planned: '待还原', manual: '需手动', failed: '失败' }[r.status] || r.status;
    console.log(`${tag}  ${r.file}`);
    if (r.next !== undefined && r.next !== null) console.log(`      将恢复为  ${clip(r.next, 70)}`);
    if (r.reason) console.log(`      说明  ${r.reason}`);
  }
  const s = data.summary || {};
  console.log(
    `\n${data.dryRun ? '预览（未写入）' : '已还原'}：共 ${s.total} 项，还原 ${s.restored}，待还原 ${s.planned}，需手动 ${s.manual}，失败 ${s.failed}。`
  );
  if (data.dryRun) console.log('确认无误后加 --apply 真正还原（按备份字节写回）。');
  return s.failed > 0 ? 1 : 0;
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
  if (cmd === 'sessions') return cmdSessions(opts);
  if (cmd === 'rename') return cmdRename(opts);
  if (cmd === 'autoname') return cmdAutoname(opts);
  if (cmd === 'restore') return cmdRestore(opts);
  console.error(`未知命令：${cmd}\n`);
  console.log(USAGE);
  return 2;
}

const code = main();
if (code !== undefined) process.exitCode = code;
