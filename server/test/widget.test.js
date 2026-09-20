'use strict';

/**
 * widget 逻辑测试：用极简 DOM/宿主 stub 跑 log.html 内的脚本，
 * 断言与宿主的消息序列（握手 → 工具调用 → 渲染 → 轮询）。
 *
 * 注意：stub 会覆盖全局 window/document，且不恢复——本文件内的每个用例
 * 各自重新 boot（node --test 每文件独立进程，不会污染其它测试文件）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function makeEl(tag) {
  return {
    tagName: tag,
    children: [],
    className: '',
    textContent: '',
    title: '',
    style: {},
    checked: true,
    hidden: false,
    scrollHeight: 100,
    scrollTop: 0,
    clientHeight: 100,
    parentElement: null,
    classList: {
      _set: {},
      add(c) { this._set[c] = true; },
      remove(c) { delete this._set[c]; },
      toggle(c, force) {
        const on = force === undefined ? !this._set[c] : Boolean(force);
        if (on) this._set[c] = true;
        else delete this._set[c];
        return on;
      },
      contains(c) { return Boolean(this._set[c]); },
    },
    appendChild(c) {
      this.children.push(c);
      c.parentElement = this;
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentElement = null;
      return c;
    },
    addEventListener(type, fn) {
      this._ls = this._ls || {};
      this._ls[type] = fn;
    },
    setAttribute(k, v) {
      this[k] = v;
    },
    removeAttribute(k) {
      delete this[k];
    },
    contains(el) {
      if (el === this) return true;
      return (this.children || []).some((c) => c === el || (c.contains && c.contains(el)));
    },
  };
}

function bootWidget() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'widget', 'log.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, 'widget 内应有一个 <script> 块');
  const script = m[1];

  const posted = [];
  const elements = {};
  const listeners = {};
  const intervals = [];

  global.window = {
    parent: {
      postMessage: (msg) => {
        posted.push(msg);
      },
    },
    addEventListener: (type, fn) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
  };
  global.document = {
    hidden: false,
    body: makeEl('body'),
    createElement: makeEl,
    getElementById: (id) => (elements[id] = elements[id] || makeEl('div')),
  };
  global.setInterval = (fn, ms) => {
    intervals.push({ fn, ms });
    return intervals.length;
  };
  global.clearInterval = () => {};

  // eslint-disable-next-line no-eval
  eval(script);

  return {
    posted,
    elements,
    intervals,
    dispatch(msg) {
      (listeners.message || []).forEach((fn) => fn({ data: msg }));
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 4) {
  for (let i = 0; i < n; i += 1) await tick();
}

/** 递归收集 stub 元素的文本（避免 JSON.stringify 的循环引用）。 */
function collectText(el) {
  let out = el.textContent || '';
  (el.children || []).forEach((c) => {
    out += ' ' + collectText(c);
  });
  return out;
}

/** 递归查找第一个指定 tag 的元素。 */
function findByTag(el, tag) {
  if (String(el.tagName || '').toLowerCase() === tag) return el;
  for (const c of el.children || []) {
    const hit = findByTag(c, tag);
    if (hit) return hit;
  }
  return null;
}

/** 收集指定 tag 的全部元素。 */
function collectByTag(el, tag, out = []) {
  if (String(el.tagName || '').toLowerCase() === tag) out.push(el);
  for (const c of el.children || []) collectByTag(c, tag, out);
  return out;
}

/** 收集 class 含 cls 的全部元素（空格分隔匹配，非子串）。 */
function findByClass(el, cls, out = []) {
  if (String(el.className || '').split(/\s+/).includes(cls)) out.push(el);
  for (const c of el.children || []) findByClass(c, cls, out);
  return out;
}

function toolResult(id, payload) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } };
}

/** 点击列表中的第一个 run 条目（新交互：点击才进入日志页）。 */
function clickFirstRun(w) {
  const items = w.elements.runs.children.filter((c) => c.className.indexOf('run') >= 0);
  assert.ok(items.length >= 1, '列表应有可点击的 run 条目');
  items[0]._ls.click();
}

test('widget：握手消息序列（initialize → initialized → list_agent_runs）', async () => {
  const w = bootWidget();
  assert.equal(w.posted.length, 1);
  assert.equal(w.posted[0].method, 'ui/initialize');
  assert.equal(w.posted[0].params.protocolVersion, '2026-01-26');
  assert.equal(w.posted[0].params.appInfo.name, 'external-agents-extend');

  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();

  assert.equal(w.posted[1].method, 'ui/notifications/initialized');
  assert.equal(w.posted[2].method, 'tools/call');
  assert.equal(w.posted[2].params.name, 'list_agent_runs');
});

test('widget：任务列表 → 点击进入日志页 → 读取事件 → 渲染 + 启动轮询', async () => {
  const w = bootWidget();
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();

  const listCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  assert.ok(listCall, '应调用 list_agent_runs');
  w.dispatch(
    toolResult(listCall.id, {
      status: 'ok',
      count: 1,
      runs: [{ taskId: 'task_1abc', agentType: 'kimi', status: 'running', taskTitle: '演示任务', startedAt: '2026-09-17T00:00:00.000Z' }],
    })
  );
  await settle();

  // 新交互：默认停在列表页，点击任务才进入日志页并读取事件
  assert.equal(
    w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run'),
    undefined,
    '列表页不应自动读取事件'
  );
  clickFirstRun(w);
  await settle();
  const readCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run');
  assert.ok(readCall, '点击任务后应调用 read_agent_run');
  assert.equal(readCall.params.arguments.taskId, 'task_1abc');
  assert.equal(readCall.params.arguments.cursor, '0');

  w.dispatch(
    toolResult(readCall.id, {
      status: 'running',
      taskId: 'task_1abc',
      cursor: '0',
      nextCursor: null,
      total: 1,
      events: [
        { seq: 0, ts: '2026-09-17T00:00:01.000Z', kind: 'tool_call', name: 'read_file', status: null, text: '读取文件', detail: { path: '/x' } },
      ],
      meta: { degraded: false, warnings: [] },
    })
  );
  await settle();

  assert.ok(w.elements.events.children.length >= 1, '事件区应有渲染节点');
  assert.ok(
    w.intervals.some((it) => it.ms === 2000),
    'running 任务应启动 2s 轮询'
  );
});

test('widget：no_log 状态 → 显示原因且停止轮询', async () => {
  const w = bootWidget();
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();

  const listCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  w.dispatch(
    toolResult(listCall.id, {
      status: 'ok',
      count: 1,
      runs: [{ taskId: 'task_x', agentType: 'cursor', status: 'completed', taskTitle: 'X', startedAt: null }],
    })
  );
  await settle();
  clickFirstRun(w);
  await settle();

  const readCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run');
  w.dispatch(toolResult(readCall.id, { status: 'no_log', taskId: 'task_x', reason: '会话已被清理' }));
  await settle();

  const dump = collectText(w.elements.events);
  assert.ok(dump.includes('没有可读日志') && dump.includes('会话已被清理'), '应展示 no_log 原因');
});

test('widget：历史任务读尽 → 不启动轮询', async () => {
  const w = bootWidget();
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();

  const listCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  w.dispatch(
    toolResult(listCall.id, {
      status: 'ok',
      count: 1,
      runs: [{ taskId: 'task_hist', agentType: 'kimi', status: 'completed', taskTitle: '历史任务', startedAt: '2026-09-16T00:00:00.000Z' }],
    })
  );
  await settle();
  clickFirstRun(w);
  await settle();

  const readCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run');
  w.dispatch(
    toolResult(readCall.id, {
      status: 'ok',
      taskId: 'task_hist',
      cursor: '0',
      nextCursor: null,
      total: 1,
      events: [{ seq: 0, ts: null, kind: 'meta', name: null, status: null, text: null, detail: null }],
      meta: { degraded: false, warnings: [] },
    })
  );
  await settle();

  assert.equal(w.intervals.length, 0, '历史任务读尽后不应有轮询 timer');
});

test('widget：inline 卡片模式 → 列表 + 点击条目 → 请求全屏 → 进入日志视图', async () => {
  const w = bootWidget();
  // initialize result 带 hostContext.displayMode = 'inline'
  w.dispatch({
    jsonrpc: '2.0',
    id: 1,
    result: { protocolVersion: '2026-01-26', hostContext: { displayMode: 'inline' } },
  });
  await settle();

  // inline：只加载列表，不应自动读取事件
  const listCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  assert.ok(listCall, 'inline 卡片应加载任务列表');
  assert.equal(
    w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run'),
    undefined,
    'inline 卡片不应自动加载事件'
  );

  w.dispatch(
    toolResult(listCall.id, {
      status: 'ok',
      count: 2,
      runs: [
        { taskId: 'task_aaa', agentType: 'kimi', status: 'running', taskTitle: '任务 A', startedAt: '2026-09-17T00:00:00.000Z' },
        { taskId: 'task_bbb', agentType: 'cursor', status: 'completed', taskTitle: '任务 B', startedAt: '2026-09-17T00:00:00.000Z' },
      ],
    })
  );
  await settle();

  // 卡片应上报尺寸（时间线渲染所需）
  assert.ok(
    w.posted.some((x) => x.method === 'ui/notifications/size-changed' && x.params && typeof x.params.height === 'number'),
    'inline 卡片应上报高度'
  );

  // 点击第二个条目（task_bbb）
  const cardItems = w.elements.runs.children.filter((c) => c.className.indexOf('run') >= 0);
  assert.ok(cardItems.length >= 2, '卡片应渲染任务条目');
  cardItems[1]._ls.click();
  await settle();

  // 应请求切换到 fullscreen
  const dmReq = w.posted.find((x) => x.method === 'ui/request-display-mode');
  assert.ok(dmReq, '点击条目应请求切换显示模式');
  assert.equal(dmReq.params.mode, 'fullscreen');

  // 模拟宿主同意切换
  w.dispatch({ jsonrpc: '2.0', id: dmReq.id, result: { mode: 'fullscreen' } });
  await settle();

  // 切全屏后应加载所点任务的事件
  const readCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run');
  assert.ok(readCall, '切全屏后应加载事件');
  assert.equal(readCall.params.arguments.taskId, 'task_bbb');
});

/** 进入日志页并投递一个 text 事件（Markdown 正文）。 */
async function openLogWithText(w, md) {
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();
  const listCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  w.dispatch(
    toolResult(listCall.id, {
      status: 'ok',
      count: 1,
      runs: [
        {
          taskId: 'task_md',
          agentType: 'kimi',
          status: 'completed',
          taskTitle: '表格任务',
          startedAt: '2026-09-17T00:00:00.000Z',
          model: 'kimi-code/k3',
        },
      ],
    })
  );
  await settle();
  clickFirstRun(w);
  await settle();
  const readCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run');
  w.dispatch(
    toolResult(readCall.id, {
      status: 'ok',
      taskId: 'task_md',
      cursor: '0',
      nextCursor: null,
      total: 1,
      events: [{ seq: 0, ts: null, kind: 'text', name: 'assistant', status: null, text: md, detail: null }],
      meta: { degraded: false, warnings: [] },
      session: {
        adapter: 'kimi',
        matchedBy: 'timestamp',
        confidence: 'medium',
        model: { id: 'kimi-code/k3', provider: 'openai', source: 'llm.request' },
      },
    })
  );
  await settle();
}

test('widget：Markdown 表格渲染为 table 结构（表头/对齐/行内标记/不吞后续段落）', async () => {
  const w = bootWidget();
  const md = [
    '结果如下：',
    '',
    '| 文件 | 状态 | 说明 |',
    '| :--- | :---: | ---: |',
    '| a.js | 通过 | `ok` |',
    '| b.js | 失败 | **检查** |',
    '',
    '结尾段落。',
  ].join('\n');
  await openLogWithText(w, md);

  const table = findByTag(w.elements.events, 'table');
  assert.ok(table, '应渲染出 table 元素');
  assert.ok(findByTag(table, 'thead'), '应有 thead');
  assert.ok(findByTag(table, 'tbody'), '应有 tbody');

  const ths = collectByTag(table, 'th');
  assert.equal(ths.length, 3, '表头应有 3 列');
  assert.deepEqual(
    ths.map((el) => collectText(el).trim()),
    ['文件', '状态', '说明']
  );
  // 分隔行对齐 → class
  assert.equal(ths[0].className, 'a-left');
  assert.equal(ths[1].className, 'a-center');
  assert.equal(ths[2].className, 'a-right');

  const trs = collectByTag(table, 'tbody')[0].children;
  assert.equal(trs.length, 2, '应有 2 行数据');
  const tds1 = collectByTag(trs[0], 'td');
  assert.equal(tds1.length, 3);
  assert.equal(collectText(tds1[0]).trim(), 'a.js');
  assert.equal(tds1[0].className, 'a-left');
  assert.equal(tds1[2].className, 'a-right');
  // 行内标记：`code` 与 **bold**
  assert.ok(collectByTag(tds1[2], 'code').length === 1, '单元格内应渲染行内 code');
  const tds2 = collectByTag(trs[1], 'td');
  assert.ok(collectByTag(tds2[2], 'strong').length === 1, '单元格内应渲染 strong');

  // 表格后的段落仍应渲染（表格不吞后续内容）
  const dump = collectText(w.elements.events);
  assert.ok(dump.includes('结尾段落。'), '表格后段落应保留');
  assert.ok(dump.includes('结果如下：'), '表格前段落应保留');
});

test('widget：模型 chip —— 列表显示派发模型，日志头优先显示会话实际模型', async () => {
  const w = bootWidget();
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();
  const listCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  w.dispatch(
    toolResult(listCall.id, {
      status: 'ok',
      count: 2,
      runs: [
        { taskId: 'task_m1', agentType: 'kimi', status: 'completed', taskTitle: 'K', startedAt: '2026-09-17T00:00:00.000Z', model: 'kimi-code/k3' },
        { taskId: 'task_m2', agentType: 'codex', status: 'completed', taskTitle: 'C', startedAt: '2026-09-17T00:00:00.000Z', model: 'default' },
      ],
    })
  );
  await settle();

  const chips = collectByTag(w.elements.runs, 'span').filter((el) => el.className === 'model');
  assert.equal(chips.length, 2, '每个任务应有一个模型 chip');
  assert.deepEqual(
    chips.map((el) => el.textContent),
    ['kimi-code/k3', '默认']
  );

  // 点击第一个任务：读取响应带会话实际模型 → 日志头显示实际模型
  clickFirstRun(w);
  await settle();
  const readCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run');
  w.dispatch(
    toolResult(readCall.id, {
      status: 'ok',
      taskId: 'task_m1',
      cursor: '0',
      nextCursor: null,
      total: 0,
      events: [],
      meta: { degraded: false, warnings: [] },
      session: {
        adapter: 'kimi',
        matchedBy: 'timestamp',
        confidence: 'medium',
        model: { id: 'kimi-code/k3-256k', provider: 'openai', source: 'llm.request' },
      },
    })
  );
  await settle();
  assert.equal(w.elements.lhModel.textContent, 'kimi-code/k3-256k');
  assert.ok(!w.elements.lhModel.classList.contains('hidden'), '有模型时不应隐藏');

  // 切换到第二个任务（无 session.model）→ 回退到派发模型，'default' 显示为「默认」
  const cardItems = w.elements.runs.children.filter((c) => c.className.indexOf('run') >= 0);
  cardItems[1]._ls.click();
  await settle();
  const readCall2 = w.posted.filter((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run').pop();
  w.dispatch(
    toolResult(readCall2.id, {
      status: 'ok',
      taskId: 'task_m2',
      cursor: '0',
      nextCursor: null,
      total: 0,
      events: [],
      meta: { degraded: false, warnings: [] },
      session: { adapter: 'codex', matchedBy: 'timestamp', confidence: 'medium', model: null },
    })
  );
  await settle();
  assert.equal(w.elements.lhModel.textContent, '默认');
});

test('widget：agentName —— 列表 badge 与日志详情页头部显示 dim 起的名字，无名字时不渲染', async () => {
  const w = bootWidget();
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();
  const listCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  w.dispatch(
    toolResult(listCall.id, {
      status: 'ok',
      count: 2,
      runs: [
        { taskId: 'task_n1', agentType: 'codex', agentName: '林澈', status: 'running', taskTitle: '波形合并', startedAt: '2026-09-20T06:14:59.000Z' },
        { taskId: 'task_n2', agentType: 'kimi', status: 'completed', taskTitle: '没有名字的任务', startedAt: '2026-09-20T05:58:20.000Z' },
      ],
    })
  );
  await settle();

  const nameChips = collectByTag(w.elements.runs, 'span').filter((el) => el.className === 'badge-name');
  assert.equal(nameChips.length, 1, '只有带 agentName 的任务才渲染名字');
  assert.equal(nameChips[0].textContent, '林澈');
  assert.match(nameChips[0].title, /林澈/, '名字应带 tooltip 说明来源');

  // 点击带名字的任务 → 日志头显示名字
  clickFirstRun(w);
  await settle();
  const readCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run');
  w.dispatch(
    toolResult(readCall.id, {
      status: 'ok',
      taskId: 'task_n1',
      cursor: '0',
      nextCursor: null,
      total: 0,
      events: [],
      meta: { degraded: false, warnings: [] },
      session: null,
    })
  );
  await settle();
  assert.equal(w.elements.lhName.textContent, '林澈');
  assert.ok(!w.elements.lhName.classList.contains('hidden'), '有名字时不应隐藏');

  // 切到无名字的任务 → 日志头整块隐藏（不占 flex gap）
  const cardItems = w.elements.runs.children.filter((c) => c.className.indexOf('run') >= 0);
  cardItems[1]._ls.click();
  await settle();
  const readCall2 = w.posted.filter((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run').pop();
  w.dispatch(
    toolResult(readCall2.id, {
      status: 'ok',
      taskId: 'task_n2',
      cursor: '0',
      nextCursor: null,
      total: 0,
      events: [],
      meta: { degraded: false, warnings: [] },
      session: null,
    })
  );
  await settle();
  assert.equal(w.elements.lhName.textContent, '');
  assert.ok(w.elements.lhName.classList.contains('hidden'), '无名字时应隐藏');
});

/* ===== 自动命名开关（默认关闭）===== */

test('widget：fullscreen 启动会读设置，并把「自动命名」开关反映为真实状态', async () => {
  const w = bootWidget();
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();

  const getCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'get_settings');
  assert.ok(getCall, 'fullscreen 启动应调用 get_settings');
  w.dispatch(toolResult(getCall.id, { status: 'ok', autoName: { enabled: true, source: 'config', configPath: '/x' } }));
  await settle();
  assert.equal(w.elements.autoName.checked, true, '设置里开启 → 开关应为选中');

  const w2 = bootWidget();
  w2.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();
  const getCall2 = w2.posted.find((x) => x.method === 'tools/call' && x.params.name === 'get_settings');
  w2.dispatch(toolResult(getCall2.id, { status: 'ok', autoName: { enabled: false, source: 'default' } }));
  await settle();
  assert.equal(w2.elements.autoName.checked, false, '默认关闭 → 开关应为未选中');
});

test('widget：切换开关 → 调用 set_auto_name 并采用返回状态', async () => {
  const w = bootWidget();
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();
  const getCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'get_settings');
  w.dispatch(toolResult(getCall.id, { status: 'ok', autoName: { enabled: false, source: 'default' } }));
  await settle();

  w.elements.autoName.checked = true;
  w.elements.autoName._ls.change();
  await settle();
  const setCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'set_auto_name');
  assert.ok(setCall, '切换后应调用 set_auto_name');
  assert.equal(setCall.params.arguments.enabled, true);

  w.dispatch(toolResult(setCall.id, { status: 'ok', autoName: { enabled: true, source: 'config' } }));
  await settle();
  assert.equal(w.elements.autoName.checked, true);
  assert.match(w.elements.statusText.textContent, /已开启/);
});

test('widget：写入失败时开关回到原状态，不假装成功', async () => {
  const w = bootWidget();
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();
  const getCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'get_settings');
  w.dispatch(toolResult(getCall.id, { status: 'ok', autoName: { enabled: false, source: 'default' } }));
  await settle();

  w.elements.autoName.checked = true;
  w.elements.autoName._ls.change();
  await settle();
  const setCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'set_auto_name');
  w.dispatch(toolResult(setCall.id, { status: 'write_failed', message: '磁盘只读' }));
  await settle();
  assert.equal(w.elements.autoName.checked, false, '写失败 → 回到关闭');
  assert.match(w.elements.statusText.textContent, /未保存/);
});

test('widget：服务端回退为全部会话时，勾选「全部会话」并显示原因（不再静默为空）', async () => {
  const w = bootWidget();
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();
  const listCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  w.dispatch(
    toolResult(listCall.id, {
      status: 'ok',
      scope: 'all',
      sessionId: 'sess_mine',
      scopeFallback: { from: 'sess_mine', reason: '本会话没有外部 Agent 任务，已回退为全部会话（含其它 dim 会话）' },
      count: 1,
      runs: [{ taskId: 'task_1789824567432_zanjgj', sessionId: 'sess_other', agentType: 'kimi', status: 'running', taskTitle: '实现 GUO-109' }],
    })
  );
  await settle();
  assert.equal(w.elements.allRuns.checked, true, '应勾选「全部会话」');
  assert.match(w.elements.scopeBadge.textContent, /全部会话（本会话无任务）/);
  assert.match(collectText(w.elements.runs), /本会话没有外部 Agent 任务/, '列表里应显示回退原因');
  assert.match(collectText(w.elements.runs), /实现 GUO-109/, '应显示别的会话里运行中的任务');
});

test('widget：自动命名开关与筛选都是「列表页控件」——详情页与 inline 卡片都不显示', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'widget', 'log.html'), 'utf8');
  assert.match(html, /<div class="switch-wrap" id="autoNameWrap">/, '开关应是独立容器，不再复用 follow/scope 类');
  assert.match(html, /<span class="tip" id="autoNameTip" role="tooltip"><\/span>/, '开关要有 hover 提示容器');
  assert.match(
    html,
    /body\.view-log \.filter, body\.view-log \.switch-wrap \{ display: none; \}/,
    '日志详情页应隐藏筛选与开关'
  );
  assert.match(
    html,
    /body\.inline-card \.filter, body\.inline-card \.switch-wrap \{ display: none; \}/,
    'inline 卡片应隐藏筛选与开关'
  );
});

test('widget：「跟随」是开关样式，且只在日志详情页显示', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'widget', 'log.html'), 'utf8');
  assert.match(
    html,
    /<label class="switch" for="follow" id="followSwitch" title="[^"]*">/,
    '跟随应复用开关样式（label.switch），而不是普通 checkbox'
  );
  assert.match(
    html,
    /id="followSwitch"[\s\S]{0,220}?<input type="checkbox" id="follow" checked>[\s\S]{0,220}?<span class="switch-track"><span class="switch-knob"><\/span><\/span>/,
    '跟随开关应有轨道 + 滑块结构'
  );
  assert.ok(!/label\.follow/.test(html), '不应残留 label.follow 的样式或标记');
  assert.match(html, /body\.view-list #followSwitch \{ display: none; \}/, '列表页不显示跟随（它是日志页控件）');
  assert.match(html, /body\.inline-card #followSwitch \{ display: none; \}/, 'inline 卡片不显示跟随');
});

test('widget：开关与筛选的包裹层必须是 flex 容器（否则整组会高出相邻控件约 2px）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'widget', 'log.html'), 'utf8');
  // 包裹层若是默认 block，里面的 inline-flex 子元素按基线排版、贴在该行顶部，
  // 底部留下 strut 的下伸空间，导致开关/筛选比标题、徽标、刷新按钮高出约 2px。
  for (const [sel, child] of [
    ['.switch-wrap', 'label.switch'],
    ['.filter', 'button.filter-btn'],
  ]) {
    const rule = new RegExp(`\\${sel} \\{[^}]*\\}`);
    const found = html.match(rule);
    assert.ok(found, `应有 ${sel} 的样式规则`);
    assert.match(found[0], /display: flex/, `${sel} 必须是 flex 容器，否则 ${child} 会贴顶、整组偏高`);
    assert.match(found[0], /align-items: center/, `${sel} 需要 align-items: center 才能让 ${child} 垂直居中`);
  }
});

test('widget：筛选集成到一个组件里（按钮 + 面板，三项条件）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'widget', 'log.html'), 'utf8');
  assert.match(html, /<button class="filter-btn" id="filterBtn"/, '应有筛选按钮');
  assert.match(html, /<div class="filter-menu" id="filterMenu" role="menu" hidden>/, '菜单默认收起');
  /* 状态多选：覆盖全部状态（运行中/已完成/已取消/失败）+ 范围（全部会话） */
  for (const id of ['stRunning', 'stCompleted', 'stCancelled', 'stFailed', 'allRuns']) {
    assert.ok(html.includes(`id="${id}"`), `菜单里应有 ${id}`);
  }
  assert.ok(!/<label class="scope">/.test(html), '旧的散落 checkbox 不应残留');
});

/* ===== 筛选组件交互 / includeFailed / 详情页 logo ===== */

test('widget：筛选按钮开合、角标计数、并驱动 statuses 参数（覆盖全部状态）', async () => {
  const w = bootWidget();
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();

  /* 默认：菜单收起、无角标 */
  assert.equal(w.elements.filterMenu.hidden, true);
  assert.equal(w.elements.filterBadge.hidden, true);
  const first = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  assert.deepEqual(first.params.arguments.statuses, ['running'], '默认只看运行中');

  /* 打开菜单 */
  w.elements.filterBtn._ls.click();
  assert.equal(w.elements.filterMenu.hidden, false);
  assert.equal(w.elements.filterBtn['aria-expanded'], 'true');

  /* 勾选「失败」→ 角标 1、重新拉取且 statuses 带上 failed */
  w.elements.stFailed.checked = true;
  w.elements.stFailed._ls.change();
  await settle();
  assert.equal(w.elements.filterBadge.textContent, '1');
  assert.equal(w.elements.filterBadge.hidden, false);
  const calls = w.posted.filter((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  assert.deepEqual(calls[calls.length - 1].params.arguments.statuses, ['running', 'failed']);

  /* 四个状态全勾 → 角标 3（默认勾选的运行中不算「非默认」） */
  for (const id of ['stCompleted', 'stCancelled']) {
    w.elements[id].checked = true;
    w.elements[id]._ls.change();
  }
  await settle();
  assert.equal(w.elements.filterBadge.textContent, '3');
  const all = w.posted.filter((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  assert.deepEqual(all[all.length - 1].params.arguments.statuses, ['running', 'completed', 'cancelled', 'failed']);

  /* 再勾「全部会话」→ 角标 4（三个非默认状态 + 范围）、scope=all */
  w.elements.allRuns.checked = true;
  w.elements.allRuns._ls.change();
  await settle();
  assert.equal(w.elements.filterBadge.textContent, '4');
  assert.match(w.elements.filterBtn.title, /全部会话/);
  const calls2 = w.posted.filter((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  assert.equal(calls2[calls2.length - 1].params.arguments.scope, 'all');

  /* 全部取消勾选 → statuses 传空数组（服务端视为不按状态筛）且「运行中」不再勾选计 1 */
  for (const id of ['stRunning', 'stCompleted', 'stCancelled', 'stFailed']) {
    w.elements[id].checked = false;
    w.elements[id]._ls.change();
  }
  await settle();
  const empty = w.posted.filter((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  assert.deepEqual(empty[empty.length - 1].params.arguments.statuses, []);
  assert.match(w.elements.filterBtn.title, /全部状态/);
});

test('widget：日志详情页头部显示对应 Agent 的 logo（无图标时隐藏）', async () => {
  const w = bootWidget();
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();
  const listCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  w.dispatch(
    toolResult(listCall.id, {
      status: 'ok',
      count: 2,
      runs: [
        { taskId: 'task_kimi', agentType: 'kimi', status: 'running', taskTitle: 'Kimi 任务' },
        { taskId: 'task_unknown', agentType: 'unknownagent', status: 'running', taskTitle: '未知 agent' },
      ],
    })
  );
  await settle();

  /* 选中 kimi → logo 出现且是内联图标 */
  clickFirstRun(w);
  await settle();
  assert.equal(w.elements.lhLogo.hidden, false);
  assert.match(String(w.elements.lhLogo.src), /^data:image\//);
  assert.match(w.elements.lhLogo.alt, /kimi/);

  /* 选中未知 agent → logo 隐藏 */
  const items = w.elements.runs.children.filter((c) => c.className.indexOf('run') >= 0);
  items[1]._ls.click();
  await settle();
  assert.equal(w.elements.lhLogo.hidden, true);
});

/* ===== 轨迹折叠（默认折叠为一行统计摘要，Agent 正文保持可见） ===== */

const tsAt = (n) => '2026-09-20T00:00:0' + n + '.000Z';

/** 进入日志页并推入一批事件（轨迹折叠用例共用）。 */
async function openLogWithEvents(w, events, readStatus = 'ok') {
  w.dispatch({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26' } });
  await settle();
  const listCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'list_agent_runs');
  w.dispatch(
    toolResult(listCall.id, {
      status: 'ok',
      count: 1,
      runs: [{ taskId: 'task_fold', agentType: 'kimi', status: 'running', taskTitle: '折叠演示', startedAt: null }],
    })
  );
  await settle();
  clickFirstRun(w);
  await settle();
  const readCall = w.posted.find((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run');
  w.dispatch(
    toolResult(readCall.id, {
      status: readStatus,
      taskId: 'task_fold',
      cursor: '0',
      nextCursor: null,
      total: events.length,
      events,
      meta: { degraded: false, warnings: [] },
    })
  );
  await settle();
  return readCall;
}

/** 轨迹段展开体（rail）数量。 */
function trailBodies(w) {
  return findByClass(w.elements.events, 'ev-body').length;
}

/** 轨迹摘要行（含 .ev-sum 的那一行的 head 元素）。 */
function trailHead(w) {
  const sum = findByClass(w.elements.events, 'ev-sum')[0];
  return sum ? sum.parentElement : null;
}

test('widget：轨迹默认折叠为一行统计摘要，Agent 正文保持可见', async () => {
  const w = bootWidget();
  await openLogWithEvents(w, [
    { seq: 0, ts: tsAt(1), kind: 'think', name: null, status: null, text: '先看代码' },
    { seq: 1, ts: tsAt(2), kind: 'tool_call', name: 'read_file', status: null, text: '读取 a.js', detail: { path: 'a.js' } },
    { seq: 2, ts: tsAt(3), kind: 'tool_call', name: 'apply_patch', status: null, text: '改 a.js', detail: { path: 'a.js' } },
    { seq: 3, ts: tsAt(4), kind: 'tool_call', name: 'run_command', status: null, text: '跑测试', detail: { command: 'npm test' } },
    { seq: 4, ts: tsAt(5), kind: 'tool_result', name: 'run_command', status: null, text: '全部通过' },
    { seq: 5, ts: tsAt(6), kind: 'text', name: null, status: null, text: '已完成修改。' },
  ]);

  const sums = findByClass(w.elements.events, 'ev-sum');
  assert.equal(sums.length, 1, '非文本事件应折叠为一行摘要');
  assert.equal(sums[0].textContent, '思考1轮 · 读1次文件、改1次文件、执行1次命令');

  /* 默认折叠：不渲染任何明细行 */
  assert.equal(trailBodies(w), 0, '默认应折叠，不渲染明细');
  const folded = collectText(w.elements.events);
  assert.ok(folded.includes('已完成修改。'), 'Agent 正文应直接可见');
  assert.ok(!folded.includes('先看代码'), '折叠态不应出现思考内容');
  assert.ok(!folded.includes('全部通过'), '折叠态不应出现工具结果');

  /* 点击整行 → 展开明细（思考 / 工具调用 / 结果） */
  trailHead(w)._ls.click();
  assert.equal(trailBodies(w), 1, '展开后应出现明细 rail');
  const opened = collectText(w.elements.events);
  assert.ok(opened.includes('先看代码'), '展开后应能看到思考行');
  assert.ok(opened.includes('读取') && opened.includes('全部通过'), '展开后应能看到工具调用与结果行');
});

test('widget：折叠段内有失败调用时，摘要行标红', async () => {
  const w = bootWidget();
  await openLogWithEvents(w, [
    { seq: 0, ts: tsAt(1), kind: 'tool_call', name: 'run_command', status: null, text: '跑测试', detail: { command: 'npm test' } },
    { seq: 1, ts: tsAt(2), kind: 'tool_result', name: 'run_command', status: 'error', text: '失败' },
  ]);

  const sums = findByClass(w.elements.events, 'ev-sum');
  assert.equal(sums.length, 1);
  assert.ok(trailHead(w).parentElement.classList.contains('error'), '失败调用应在折叠态即可察觉');
});

test('widget：轮询重建后保持轨迹段的展开状态，摘要随新事件更新', async () => {
  const w = bootWidget();
  await openLogWithEvents(
    w,
    [{ seq: 0, ts: tsAt(1), kind: 'tool_call', name: 'read_file', status: null, text: '读取', detail: { path: 'a.js' } }],
    'running'
  );

  findByClass(w.elements.events, 'ev-sum')[0].parentElement._ls.click();
  assert.equal(trailBodies(w), 1, '展开后应出现明细');

  /* 触发一次轮询增量：新事件追加到同一段 → 重建后仍应展开 */
  const timer = w.intervals.filter((it) => it.ms === 2000).pop();
  assert.ok(timer, '运行中任务应有 2s 轮询');
  timer.fn();
  await settle();
  const pollCall = w.posted.filter((x) => x.method === 'tools/call' && x.params.name === 'read_agent_run').pop();
  w.elements.events.children.length = 0; // stub 不实现 textContent='' 的节点清理，这里手动模拟重建
  w.dispatch(
    toolResult(pollCall.id, {
      status: 'running',
      taskId: 'task_fold',
      cursor: '1',
      nextCursor: null,
      total: 2,
      events: [{ seq: 1, ts: tsAt(2), kind: 'tool_call', name: 'run_command', status: null, text: '跑测试', detail: { command: 'npm test' } }],
      meta: { degraded: false, warnings: [] },
    })
  );
  await settle();

  assert.equal(trailBodies(w), 1, '轮询重建后应保持展开');
  assert.equal(findByClass(w.elements.events, 'ev-sum')[0].textContent, '读1次文件、执行1次命令');
});
