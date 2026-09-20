'use strict';

/**
 * grok 适配器（T1.x）。
 *
 * 数据源：`<session dir>/updates.jsonl` —— grok CLI 的 ACP 风格会话更新流，
 * 每行 `{ timestamp(秒) | _meta.agentTimestampMs(毫秒), method, params.update }`，
 * 追加写；另有 `summary.json` 提供会话元信息与当前模型。
 *
 * 与 kimi/codex 一致的增量语义：cursor 是 updates.jsonl 的**字节偏移**，
 * 只消费以换行结尾的完整行（运行中的会话尾部半行留给下次），单行超上限时不推进 cursor。
 *
 * 事件映射（sessionUpdate → kind）：
 *   hook_execution        → notice(hook)
 *   user_message_chunk    → notice(user_message)
 *   agent_thought_chunk   → think
 *   agent_message_chunk   → text
 *   tool_call             → tool_call（detail = rawInput + 工具元信息）
 *   tool_call_update      → 有 status 时 tool_result；无 status 的是同一调用的补充描述，跳过并计数
 *   plan                  → notice(plan)（detail.entries）
 *   retry_state           → notice(retry)，失败时为 status=error
 *   task_backgrounded / task_completed / background_tasks → notice（后台任务）
 *   turn_completed        → usage（token/耗时；模型名也从这里兜底）
 *   其它                   → unknown + warning（显式降级，不静默丢数据）
 */

const fs = require('node:fs');
const path = require('node:path');
const { toIso, makeEvent, makeReadResult, modelHint, warning } = require('../events');

const ADAPTER = 'grok';
const FORMAT_VERSION = 'grok-updates/1';

const MAX_TEXT = 4000; // 单条事件 text 主体上限（超出截断并在 detail.truncated 标注）
const MAX_LINE_BYTES = 1024 * 1024; // 单行硬上限（防御异常数据）
const MAX_LINES_PER_CALL = 2000; // 单次调用消费行数上限
const MAX_SUMMARY_TEXT = 160; // 一行摘要长度

/** 截断文本并显式记录原始长度。 */
function capText(text, detail) {
  if (typeof text !== 'string') return null;
  if (text.length <= MAX_TEXT) return text;
  if (detail) {
    detail.truncated = true;
    detail.originalLength = text.length;
  }
  return text.slice(0, MAX_TEXT);
}

/** 一行摘要：折叠空白 + 截断（用于 notice / tool_call 的 text）。 */
function oneLine(text) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length <= MAX_SUMMARY_TEXT ? flat : flat.slice(0, MAX_SUMMARY_TEXT) + '…';
}

/** ACP content（数组 / 单个对象 / 字符串）→ 文本（取所有 text 片段拼接）。 */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      const inner = textOfContent(item);
      if (inner !== null) parts.push(inner);
    }
    return parts.length === 0 ? null : parts.join('\n');
  }
  if (content && typeof content === 'object') {
    // { type: 'content', content: { type: 'text', text } } 与 { type: 'text', text } 两种形态
    if (typeof content.text === 'string') return content.text;
    if (content.content !== undefined) return textOfContent(content.content);
  }
  return null;
}

/** tool_call_update 的 rawOutput → 文本（各工具形态不一，逐层兜底）。 */
function textOfRawOutput(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw;
  if (typeof raw !== 'object') return null;
  for (const key of ['content', 'Content', 'output', 'text']) {
    const v = raw[key];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const inner = textOfRawOutput(v);
      if (inner !== null) return inner;
    }
  }
  return null;
}

/** 行内时间戳：优先毫秒级的 agentTimestampMs，其次秒级 timestamp。 */
function tsOf(record) {
  const meta = record && record._meta;
  if (meta && Number.isFinite(meta.agentTimestampMs)) return toIso(meta.agentTimestampMs);
  const secs = record && record.timestamp;
  if (Number.isFinite(secs)) return toIso(secs * 1000);
  return null;
}

/** 会话元信息（summary.json）；不可读返回 null。 */
function readSummary(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 工具显示名：优先 x.ai/tool.name，其次 tool_call 的 title，最后 'tool'。 */
function toolNameOf(update) {
  const meta = update && update._meta;
  const tool = meta && meta['x.ai/tool'];
  if (tool && typeof tool.name === 'string' && tool.name.length > 0) return tool.name;
  if (typeof update.title === 'string' && update.title.length > 0) return update.title;
  return 'tool';
}

/**
 * 单行 update → 事件数组（0 或 1 条）。
 * ctx 累积跨行的状态：toolCallId → 工具名、未知类型计数、模型名。
 */
function eventsOfUpdate(record, ctx) {
  const params = record && record.params;
  const update = params && params.update;
  if (!update || typeof update !== 'object') {
    ctx.unknownTypes.add('<缺少 params.update>');
    return [
      makeEvent({
        ts: tsOf(record),
        kind: 'unknown',
        detail: { reason: 'missing_update', droppedKind: null },
        raw: record,
      }),
    ];
  }
  const sub = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : null;
  const ts = tsOf(record);

  switch (sub) {
    case 'hook_execution': {
      const runs = Array.isArray(update.runs) ? update.runs : [];
      return [
        makeEvent({
          ts,
          kind: 'notice',
          name: 'hook',
          text: oneLine(`${update.event_name || 'hook'}${runs.length > 0 ? ` · ${runs.length} 个 hook` : ''}`),
          detail: { eventName: update.event_name || null, runs },
          raw: record,
        }),
      ];
    }

    case 'user_message_chunk': {
      const detail = { source: 'user_message_chunk' };
      return [
        makeEvent({
          ts,
          kind: 'notice',
          name: 'user_message',
          text: capText(textOfContent(update.content), detail),
          detail,
          raw: record,
        }),
      ];
    }

    case 'agent_thought_chunk': {
      const detail = { source: 'agent_thought_chunk' };
      return [makeEvent({ ts, kind: 'think', name: 'grok', text: capText(textOfContent(update.content), detail), detail, raw: record })];
    }

    case 'agent_message_chunk': {
      const detail = { source: 'agent_message_chunk' };
      return [
        makeEvent({ ts, kind: 'text', name: 'assistant', text: capText(textOfContent(update.content), detail), detail, raw: record }),
      ];
    }

    case 'tool_call': {
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : null;
      const name = toolNameOf(update);
      if (callId !== null) ctx.toolNames.set(callId, name);
      const tool = (update._meta && update._meta['x.ai/tool']) || null;
      const detail = {
        source: 'tool_call',
        toolCallId: callId,
        kind: (tool && tool.kind) || update.kind || null,
        label: (tool && tool.label) || null,
        namespace: (tool && tool.namespace) || null,
        readOnly: tool ? Boolean(tool.read_only) : null,
        input: update.rawInput === undefined ? null : update.rawInput,
      };
      const summary = oneLine(
        typeof detail.input === 'string' ? detail.input : JSON.stringify(detail.input === undefined ? null : detail.input)
      );
      return [makeEvent({ ts, kind: 'tool_call', name, text: summary, detail, raw: record })];
    }

    case 'tool_call_update': {
      // 无 status 的是同一调用的补充描述（标题/位置/意图），不产事件，只计数。
      if (typeof update.status !== 'string' || update.status.length === 0) {
        ctx.skippedRefinements += 1;
        return [];
      }
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : null;
      const name = (callId !== null && ctx.toolNames.get(callId)) || update.title || 'tool';
      const text = textOfContent(update.content) || textOfRawOutput(update.rawOutput);
      const detail = {
        source: 'tool_call_update',
        toolCallId: callId,
        status: update.status,
        title: typeof update.title === 'string' ? update.title : null,
        kind: typeof update.kind === 'string' ? update.kind : null,
        locations: Array.isArray(update.locations) && update.locations.length > 0 ? update.locations : null,
      };
      return [
        makeEvent({
          ts,
          kind: 'tool_result',
          name,
          status: update.status === 'completed' ? 'ok' : 'error',
          text: capText(text, detail),
          detail,
          raw: record,
        }),
      ];
    }

    case 'plan': {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      const done = entries.filter((e) => e && e.status === 'completed').length;
      return [
        makeEvent({
          ts,
          kind: 'notice',
          name: 'plan',
          text: oneLine(`${done}/${entries.length} 项完成${entries.length > 0 ? '：' + entries.map((e) => (e && e.content) || '').join('；') : ''}`),
          detail: { entries },
          raw: record,
        }),
      ];
    }

    case 'retry_state': {
      const failed = update.type === 'failed';
      return [
        makeEvent({
          ts,
          kind: 'notice',
          name: 'retry',
          status: failed ? 'error' : null,
          text: oneLine(`${update.type || 'retry'}${update.error_type ? ' · ' + update.error_type : ''}${update.message ? ' · ' + update.message : ''}`),
          detail: { type: update.type || null, errorType: update.error_type || null, message: update.message || null },
          raw: record,
        }),
      ];
    }

    case 'task_backgrounded':
    case 'task_completed': {
      const snap = update.task_snapshot && typeof update.task_snapshot === 'object' ? update.task_snapshot : null;
      const command = update.command || (snap && snap.command) || null;
      const detail = {
        taskId: update.task_id || (snap && snap.task_id) || null,
        toolCallId: update.tool_call_id || null,
        outputFile: update.output_file || null,
        cwd: update.cwd || (snap && snap.cwd) || null,
        command: typeof command === 'string' ? command : null,
        exitCode: (snap && snap.exit_code !== undefined && snap.exit_code) || null,
      };
      return [
        makeEvent({
          ts,
          kind: 'notice',
          name: sub,
          text: oneLine(update.description || command),
          detail,
          raw: record,
        }),
      ];
    }

    case 'background_tasks': {
      const tasks = Array.isArray(update.tasks) ? update.tasks : [];
      return [
        makeEvent({
          ts,
          kind: 'notice',
          name: 'background_tasks',
          text: oneLine(`${tasks.length} 个后台任务`),
          detail: {
            count: tasks.length,
            tasks: tasks.map((t) => ({
              taskId: (t && t.task_id) || null,
              status: (t && t.status) || null,
              command: oneLine(t && t.command),
            })),
          },
          raw: record,
        }),
      ];
    }

    case 'turn_completed': {
      const usage = update.usage && typeof update.usage === 'object' ? update.usage : null;
      const modelIds = usage && usage.modelUsage && typeof usage.modelUsage === 'object' ? Object.keys(usage.modelUsage) : [];
      if (ctx.model === null && modelIds.length > 0) ctx.model = modelHint(modelIds[0], { source: 'turn_completed.usage.modelUsage' });
      const summary = usage
        ? `in ${usage.inputTokens ?? '?'} / out ${usage.outputTokens ?? '?'} / total ${usage.totalTokens ?? '?'} · ${usage.modelCalls ?? '?'} 次模型调用`
        : oneLine(`${update.stop_reason || 'turn completed'}`);
      return [
        makeEvent({
          ts,
          kind: 'usage',
          name: 'turn_completed',
          text: oneLine(summary),
          detail: {
            stopReason: update.stop_reason || null,
            elapsedMs: Number.isFinite(update.elapsed_ms) ? update.elapsed_ms : null,
            usage,
          },
          raw: record,
        }),
      ];
    }

    default: {
      const key = sub === null ? '<缺少 sessionUpdate>' : sub;
      ctx.unknownTypes.add(key);
      return [
        makeEvent({
          ts,
          kind: 'unknown',
          name: key,
          detail: { reason: 'unknown_update_type', droppedKind: key },
          raw: record,
        }),
      ];
    }
  }
}

/**
 * 读取 grok 会话事件。
 * @param {{adapter?: string, kind?: string, path?: string, id?: string}} ref 会话引用（path = 会话目录）
 * @param {{cursor?: string, maxLines?: number}} [options]
 */
function readEvents(ref, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxLines = Number.isInteger(opts.maxLines) && opts.maxLines > 0 ? opts.maxLines : MAX_LINES_PER_CALL;
  const warnings = [];
  const dir = ref && typeof ref.path === 'string' && ref.path.length > 0 ? ref.path : null;
  if (dir === null) {
    warnings.push(warning('invalid_ref', '会话引用缺少 path 字段，无法读取 grok 会话目录'));
    return makeReadResult([], { nextCursor: null, adapter: ADAPTER, formatVersion: null, warnings });
  }
  const file = path.join(dir, 'updates.jsonl');
  const summary = readSummary(dir);
  const model = summary && typeof summary.current_model_id === 'string' ? modelHint(summary.current_model_id, { source: 'summary.json' }) : null;

  let offset = 0;
  if (opts.cursor !== undefined && opts.cursor !== null && opts.cursor !== '') {
    const parsed = Number(opts.cursor);
    if (Number.isInteger(parsed) && parsed >= 0) offset = parsed;
    else
      warnings.push(
        warning('invalid_cursor', `cursor 不是合法的字节偏移，已按从头读取处理：${String(opts.cursor)}`, { cursor: String(opts.cursor) })
      );
  }

  const ctx = {
    toolNames: new Map(),
    unknownTypes: new Set(),
    skippedRefinements: 0,
    model,
  };

  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    warnings.push(
      warning('updates_missing', `无法读取 ${file}：${String((err && err.message) || err)}`, { file })
    );
    return makeReadResult([], { nextCursor: null, adapter: ADAPTER, formatVersion: FORMAT_VERSION, warnings, model });
  }

  let events = [];
  try {
    const size = fs.fstatSync(fd).size;
    let start = offset;
    if (start > size) {
      warnings.push(
        warning('cursor_beyond_eof', `cursor ${start} 超出文件大小 ${size}（文件被截断或重写），已从头读取`, { cursor: start, size })
      );
      start = 0;
    }
    const window = Math.max(size - start, 0);
    const buf = Buffer.alloc(Math.min(window, MAX_LINE_BYTES * 4));
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    const chunk = buf.subarray(0, read);

    let pos = 0;
    let consumed = 0;
    while (pos < chunk.length) {
      const nl = chunk.indexOf(0x0a, pos);
      if (nl < 0) break; // 尾部半行：留给下次
      if (events.length >= maxLines) break;
      const lineStart = start + pos;
      const raw = chunk.subarray(pos, nl).toString('utf8').trim();
      pos = nl + 1;
      consumed = pos;
      if (raw.length === 0) continue;
      if (Buffer.byteLength(raw, 'utf8') > MAX_LINE_BYTES) {
        warnings.push(warning('line_too_long', `第 ${lineStart} 字节起存在超长行，已跳过`, { byteOffset: lineStart }));
        continue;
      }
      let record;
      try {
        record = JSON.parse(raw);
      } catch {
        events.push(
          makeEvent({
            ts: null,
            kind: 'unknown',
            detail: { reason: 'parse_error', byteOffset: lineStart },
            raw: { preview: raw.slice(0, 200) },
          })
        );
        continue;
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        events.push(
          makeEvent({
            ts: null,
            kind: 'unknown',
            detail: { reason: 'non_object_record', byteOffset: lineStart },
            raw: { preview: raw.slice(0, 200) },
          })
        );
        continue;
      }
      for (const ev of eventsOfUpdate(record, ctx)) events.push(ev);
    }

    const nextCursor = start + consumed;
    if (ctx.unknownTypes.size > 0) {
      warnings.push(
        warning('unknown_update_type', `出现未识别的 sessionUpdate 类型：${[...ctx.unknownTypes].join(', ')}`, {
          types: [...ctx.unknownTypes],
        })
      );
    }

    // 元信息事件只在首次读取时给出（增量读不重复）。
    if (offset === 0) {
      const info = summary && summary.info && typeof summary.info === 'object' ? summary.info : null;
      const detail = {
        adapter: ADAPTER,
        formatVersion: FORMAT_VERSION,
        sessionId: (info && info.id) || ref.id || null,
        name: (summary && (summary.session_summary || summary.generated_title)) || null,
        cwd: (info && info.cwd) || null,
        createdAt: toIso(summary && summary.created_at),
        updatedAt: toIso(summary && summary.updated_at),
        modelId: (summary && summary.current_model_id) || null,
        reasoningEffort: (summary && summary.reasoning_effort) || null,
        agentName: (summary && summary.agent_name) || null,
        sandboxProfile: (summary && summary.sandbox_profile) || null,
        numChatMessages: Number.isFinite(summary && summary.num_chat_messages) ? summary.num_chat_messages : null,
        titleIsManual: summary ? Boolean(summary.title_is_manual) : null,
        skippedRefinements: ctx.skippedRefinements,
      };
      events.unshift(makeEvent({ kind: 'meta', name: 'metadata', text: detail.name, detail }));
    }

    events.forEach((ev, i) => {
      ev.seq = i;
    });

    return makeReadResult(events, {
      nextCursor: String(nextCursor),
      adapter: ADAPTER,
      formatVersion: FORMAT_VERSION,
      warnings,
      model: ctx.model,
    });
  } catch (err) {
    warnings.push(warning('read_failed', `读取 ${file} 失败：${String((err && err.message) || err)}`, { file }));
    return makeReadResult([], { nextCursor: String(offset), adapter: ADAPTER, formatVersion: FORMAT_VERSION, warnings, model });
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}

module.exports = { readEvents, FORMAT_VERSION };
