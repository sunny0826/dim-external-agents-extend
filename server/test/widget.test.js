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
