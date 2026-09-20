'use strict';

/**
 * 适配器分发表：按 ref.adapter 路由到具体适配器读取事件。
 *
 * 契约：每个适配器模块导出 `readEvents(ref, { cursor } = {})` →
 * `makeReadResult(events, { nextCursor, adapter, formatVersion, warnings })`。
 * 使用惰性 require：单个适配器加载失败不影响其它适配器与 server 启动；
 * 所有异常（未知适配器 / 加载失败 / 读取失败）统一转为 warnings，不向上抛。
 */

const { makeReadResult, warning } = require('../events');

const LOADERS = {
  kimi: () => require('./kimi'),
  cursor: () => require('./cursor'),
  codex: () => require('./codex'),
  grok: () => require('./grok'),
  opencode: () => require('./opencode'),
};

/** 读取会话事件（容错包装）。 */
function readSessionEvents(ref, options = {}) {
  const adapter = ref && typeof ref.adapter === 'string' ? ref.adapter : null;
  const loader = adapter ? LOADERS[adapter] : undefined;
  if (!loader) {
    return makeReadResult([], {
      adapter: adapter || 'unknown',
      warnings: [warning('unsupported_adapter', `不支持的适配器：${String(adapter)}`)],
    });
  }
  let mod;
  try {
    mod = loader();
  } catch (err) {
    return makeReadResult([], {
      adapter,
      warnings: [warning('adapter_load_failed', `适配器加载失败：${String((err && err.message) || err)}`)],
    });
  }
  try {
    return mod.readEvents(ref, options);
  } catch (err) {
    return makeReadResult([], {
      adapter,
      warnings: [warning('adapter_failed', `适配器读取失败：${String((err && err.message) || err)}`)],
    });
  }
}

module.exports = { readSessionEvents, ADAPTER_NAMES: Object.keys(LOADERS) };
