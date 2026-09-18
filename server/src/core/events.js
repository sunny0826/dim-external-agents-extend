'use strict';

/**
 * 统一事件模型（T1.6）。
 *
 * 所有适配器把各自的数据格式（kimi wire.jsonl / cursor store.db / codex rollout.jsonl）
 * 归一化为这里定义的事件结构；无法识别的内容显式降级为 `unknown` 事件并写入 warnings
 * （degraded 标记由 makeReadResult 汇总）。
 *
 * 字段约定：
 * - seq:    输出序号（跨增量批次由调用方传入起始值）
 * - ts:     ISO 8601 字符串或 null（适配器负责把毫秒数/本地时间转成 ISO）
 * - kind:   EVENT_KINDS 之一
 * - name:   工具名 / 步骤名 / 角色等短标识（可为 null）
 * - status: 'ok' | 'error' | null
 * - text:   人类可读的主要内容（可为 null）
 * - detail: 结构化细节（可为 null；widget 用于折叠展示）
 * - raw:    原始记录（可为 null；调试与后续扩展用）
 */

const EVENT_KINDS = Object.freeze([
  'meta', // 会话/运行元信息
  'step', // 步骤边界（detail.phase: 'begin' | 'end'）
  'tool_call',
  'tool_result',
  'text', // 模型输出文本
  'think', // 思考内容
  'llm', // LLM 请求/响应级事件
  'usage', // token/用量统计
  'notice', // 其它通知（prompt 接收、插件事件等）
  'unknown', // 无法识别（降级）
]);

const KIND_SET = new Set(EVENT_KINDS);

/** 把毫秒数或 ISO 字符串转为 ISO 字符串；无效值返回 null。 */
function toIso(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** 创建一条规范化事件。非法 kind 降级为 'unknown' 并保留原值。 */
function makeEvent(partial = {}) {
  const kind = KIND_SET.has(partial.kind) ? partial.kind : 'unknown';
  const ev = {
    seq: Number.isInteger(partial.seq) ? partial.seq : 0,
    ts: toIso(partial.ts === undefined ? null : partial.ts),
    kind,
    name: partial.name === undefined ? null : partial.name,
    status: partial.status === 'ok' || partial.status === 'error' ? partial.status : null,
    text: typeof partial.text === 'string' ? partial.text : null,
    detail: partial.detail && typeof partial.detail === 'object' ? partial.detail : null,
    raw: partial.raw && typeof partial.raw === 'object' ? partial.raw : null,
  };
  if (kind === 'unknown' && partial.kind !== 'unknown') {
    // 降级来源必须显式：字符串但不在枚举 / 非字符串 / 缺失，均记录原值
    ev.detail = { ...(ev.detail || {}), droppedKind: partial.kind === undefined ? null : partial.kind };
  }
  return ev;
}

/** 构造 warning 记录（供 meta.warnings 使用）。 */
function warning(code, message, extra = {}) {
  return { code, message, ...extra };
}

/** 包装一次读取的结果：事件数组 + 增量游标 + 降级元信息。 */
function makeReadResult(events, { nextCursor = null, adapter = 'unknown', formatVersion = null, warnings = [] } = {}) {
  return {
    events,
    nextCursor,
    meta: {
      adapter,
      formatVersion,
      degraded: warnings.length > 0,
      warnings,
    },
  };
}

module.exports = {
  EVENT_KINDS,
  toIso,
  makeEvent,
  makeReadResult,
  warning,
};
