'use strict';

/**
 * kimi 适配器（T1.3）。
 *
 * 数据源：`<ref.path>/agents/main/wire.jsonl`（kimi wire 协议，实测 protocol_version 1.5）。
 *
 * 结构要点（实测样本 + 25 个历史会话核对）：
 * - 两层信封：顶层 `type`（metadata / llm.request / usage.record / context.append_loop_event / …），
 *   工具调用与文本在**内层** `context.append_loop_event.event`：
 *   `event.type` ∈ step.begin | step.end | tool.call | tool.result | content.part{think|text}；
 * - 时间字段（`time` / `created_at`）是毫秒数，统一经 events.toIso 转 ISO；
 * - 无法识别的顶层 type / 内层 event.type / part.type 一律降级为 unknown 事件并写入 warnings
 *   （降级必须显式）。降级事件保留 raw 便于诊断；已知类型只通过 detail 表达，避免事件体积翻倍。
 *
 * 增量读契约：
 * - `cursor` 是「已消费字节数」（字符串化数字；null / 空串 / 缺省表示从头）；
 * - 只消费以换行结尾的完整行：文件末尾没有换行时**不推进 offset**，下次从该行开头重读
 *   （末尾半行是文件正在被写的正常状态，因此不产生 warning，避免每轮轮询都 degraded）；
 * - `nextCursor` 以字符串返回，可直接回传给下一次 readEvents；
 * - cursor 超出文件大小（文件被截断/重写）时复位到 0 并显式告警。
 */

const fs = require('node:fs');
const path = require('node:path');
const { toIso, makeEvent, makeReadResult, modelHint, warning } = require('../events');

const ADAPTER = 'kimi';
const WIRE_RELATIVE = path.join('agents', 'main', 'wire.jsonl');

const MAX_TEXT = 8000; // 单条事件的 text 主体上限（超出截断并在 detail 标注）
const MAX_RAW_LINE = 2000; // 降级事件保留的原始行上限
const MAX_ARG_STRING = 300; // 单个工具参数值上限
const MAX_ARGS_JSON = 1500; // 工具参数整体序列化上限
const MAX_LIST = 20; // 列表字段保留条数
const MAX_WARNINGS_PER_CODE = 10; // 同类 warning 上限（坏数据不能撑爆 warnings）
const PROTOCOL_HEAD_BYTES = 4096; // 读文件头探测 protocol_version 的字节数

/** step.end 中代表失败的 finishReason。 */
const ERROR_FINISH_REASONS = new Set(['error', 'failed', 'aborted', 'canceled', 'cancelled', 'timeout']);

const USAGE_LABELS = {
  inputOther: 'in',
  output: 'out',
  inputCacheRead: 'cache-read',
  inputCacheCreation: 'cache-write',
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 去掉 undefined 字段（保留 null，null 有时是有意义的「无值」）。 */
function compact(obj) {
  const out = {};
  for (const key of Object.keys(obj)) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/** 文本截断：返回 { text, truncated, length }；非字符串 → text=null。 */
function clipText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return { text: null, truncated: false, length: 0 };
  if (value.length <= max) return { text: value, truncated: false, length: value.length };
  return { text: value.slice(0, max), truncated: true, length: value.length };
}

/** 递归裁剪值：长字符串/长列表截断；state.truncated 记录是否发生裁剪。 */
function clipValue(value, maxStr, depth, state) {
  if (typeof value === 'string') {
    if (value.length > maxStr) {
      state.truncated = true;
      return `${value.slice(0, maxStr)}…[+${value.length - maxStr}]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (depth >= 4) {
      state.truncated = true;
      return `[array(${value.length})]`;
    }
    const head = value.slice(0, MAX_LIST).map((item) => clipValue(item, maxStr, depth + 1, state));
    if (value.length > MAX_LIST) {
      state.truncated = true;
      head.push(`…+${value.length - MAX_LIST}`);
    }
    return head;
  }
  if (value && typeof value === 'object') {
    if (depth >= 4) {
      state.truncated = true;
      return '[object]';
    }
    const keys = Object.keys(value);
    const out = {};
    for (const key of keys.slice(0, 30)) out[key] = clipValue(value[key], maxStr, depth + 1, state);
    if (keys.length > 30) state.truncated = true;
    return out;
  }
  return value;
}

/** 工具参数 → { args, argsTruncated, argKeys }。 */
function summarizeArgs(args) {
  if (args === undefined || args === null) return { args: null, argsTruncated: false, argKeys: [] };
  const argKeys = typeof args === 'object' ? Object.keys(args) : [];
  if (typeof args !== 'object') return { args: { note: typeof args }, argsTruncated: false, argKeys };
  const state = { truncated: false };
  const clipped = clipValue(args, MAX_ARG_STRING, 0, state);
  let json;
  try {
    json = JSON.stringify(clipped);
  } catch {
    json = null;
  }
  if (typeof json !== 'string') {
    return { args: { note: 'unserializable args', keys: argKeys.slice(0, MAX_LIST) }, argsTruncated: true, argKeys };
  }
  if (json.length > MAX_ARGS_JSON) {
    return {
      args: { preview: json.slice(0, MAX_ARGS_JSON), keys: argKeys.slice(0, MAX_LIST) },
      argsTruncated: true,
      argKeys,
    };
  }
  return { args: clipped, argsTruncated: state.truncated, argKeys };
}

/** usage 对象 → 一行摘要（未知键兜底）。 */
function usageText(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const parts = [];
  for (const [key, label] of Object.entries(USAGE_LABELS)) {
    if (typeof usage[key] === 'number') parts.push(`${label} ${usage[key]}`);
  }
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === 'number') parts.push(`${key} ${value}`);
    }
  }
  return parts.length > 0 ? parts.join(' / ') : null;
}

/** 从 input 数组（turn.prompt / turn.steer）取文本。 */
function textFromInput(input) {
  if (!Array.isArray(input)) return null;
  const parts = [];
  for (const item of input) {
    if (item && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** 从 content（字符串或 content-parts 数组）取文本。 */
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const item of content) {
    if (item && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** 后台任务状态 → 事件 status。 */
function taskStatus(info) {
  if (!info || typeof info !== 'object') return null;
  const status = info.status;
  if (status === 'failed' || status === 'error' || status === 'killed' || status === 'timeout') return 'error';
  if (typeof info.exitCode === 'number' && info.exitCode !== 0) return 'error';
  if (status === 'running' || status === 'completed' || status === 'exited') return 'ok';
  return null;
}

/** warning 收集器：同类告警超过上限后只追加一条汇总，避免坏数据产生海量告警。 */
function createWarner(sink) {
  const counts = new Map();
  const capped = new Set();
  return function warn(code, message, extra = {}) {
    const n = (counts.get(code) || 0) + 1;
    counts.set(code, n);
    if (n <= MAX_WARNINGS_PER_CODE) {
      sink.push(warning(code, message, extra));
      return;
    }
    if (!capped.has(code)) {
      capped.add(code);
      sink.push(
        warning('warning_cap_reached', `同类告警（${code}）超过 ${MAX_WARNINGS_PER_CODE} 条，后续已省略`, {
          code,
          suppressedAfter: MAX_WARNINGS_PER_CODE,
        })
      );
    }
  };
}

/** 降级事件：unknown + 原文（截断）保留在 raw。 */
function unknownEvent({ ts, detail, line }) {
  return makeEvent({
    seq: 0,
    ts,
    kind: 'unknown',
    name: null,
    text: null,
    detail: compact(detail || {}),
    raw: line === undefined ? null : { line: clipText(line, MAX_RAW_LINE).text },
  });
}

// ---------------------------------------------------------------------------
// 事件映射：内层 loop event（context.append_loop_event.event）
// ---------------------------------------------------------------------------

function mapLoopEvent(record, ts, line, ctx) {
  const inner = record.event;
  if (!inner || typeof inner !== 'object') {
    ctx.warn('malformed_loop_event', 'context.append_loop_event 缺少 event 对象，已降级为 unknown', {});
    return unknownEvent({ ts, detail: { topType: 'context.append_loop_event', reason: 'malformed_loop_event' }, line });
  }

  const type = inner.type;
  const base = {
    turnId: inner.turnId === undefined ? null : inner.turnId,
    step: inner.step === undefined ? null : inner.step,
    uuid: inner.uuid === undefined ? null : inner.uuid,
  };

  switch (type) {
    case 'step.begin':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'step',
        name: 'step.begin',
        status: null,
        text: `step ${inner.step ?? '?'} begin`,
        detail: compact({ phase: 'begin', ...base }),
      });

    case 'step.end': {
      const finishReason = typeof inner.finishReason === 'string' ? inner.finishReason : null;
      const status = finishReason === null ? null : ERROR_FINISH_REASONS.has(finishReason) ? 'error' : 'ok';
      return makeEvent({
        seq: 0,
        ts,
        kind: 'step',
        name: 'step.end',
        status,
        text: `step ${inner.step ?? '?'} end${finishReason === null ? '' : ` (${finishReason})`}`,
        detail: compact({
          phase: 'end',
          ...base,
          finishReason,
          providerFinishReason: inner.providerFinishReason,
          rawFinishReason: inner.rawFinishReason,
          messageId: inner.messageId,
          usage: inner.usage && typeof inner.usage === 'object' ? inner.usage : null,
          usageSummary: usageText(inner.usage),
          llmFirstTokenLatencyMs: inner.llmFirstTokenLatencyMs,
          llmStreamDurationMs: inner.llmStreamDurationMs,
        }),
      });
    }

    case 'tool.call': {
      const summary = summarizeArgs(inner.args);
      const display = inner.display && typeof inner.display === 'object' ? inner.display : null;
      const args = summary.args && typeof summary.args === 'object' ? summary.args : null;
      const hint =
        (display && typeof display.path === 'string' && display.path) ||
        (args && typeof args.command === 'string' && args.command) ||
        (args && typeof args.path === 'string' && args.path) ||
        (args && typeof args.query === 'string' && args.query) ||
        null;
      const name = typeof inner.name === 'string' ? inner.name : null;
      if (name !== null && typeof inner.toolCallId === 'string') ctx.toolNames.set(inner.toolCallId, name);
      return makeEvent({
        seq: 0,
        ts,
        kind: 'tool_call',
        name,
        status: null,
        text: name === null ? null : hint === null ? name : `${name}: ${clipText(String(hint), 200).text}`,
        detail: compact({
          ...base,
          toolCallId: inner.toolCallId,
          stepUuid: inner.stepUuid,
          args: summary.args,
          argsTruncated: summary.argsTruncated,
          argKeys: summary.argKeys.slice(0, MAX_LIST),
          display,
        }),
      });
    }

    case 'tool.result': {
      const result = inner.result && typeof inner.result === 'object' ? inner.result : null;
      const output = result === null ? undefined : result.output;
      let clipped = { text: null, truncated: false, length: 0 };
      let outputType = null;
      if (typeof output === 'string') {
        clipped = clipText(output, MAX_TEXT);
        outputType = 'string';
      } else if (output !== undefined && output !== null) {
        outputType = Array.isArray(output) ? 'array' : typeof output;
        let json;
        try {
          json = JSON.stringify(output);
        } catch {
          json = String(output);
        }
        clipped = clipText(json, MAX_TEXT);
      }
      const note = result !== null && typeof result.note === 'string' ? clipText(result.note, 500) : null;
      const toolCallId = typeof inner.toolCallId === 'string' ? inner.toolCallId : null;
      const isError = Boolean(result !== null && result.isError);
      const resolvedName = toolCallId === null ? null : ctx.toolNames.get(toolCallId) || null;
      return makeEvent({
        seq: 0,
        ts,
        kind: 'tool_result',
        // name 依赖同批次里出现过的 tool.call：增量批次跨文件边界时可能为 null
        // （此时 nameResolved=false，上层可用 detail.toolCallId 与更早批次的 tool_call 关联）
        name: resolvedName,
        status: isError ? 'error' : 'ok',
        text: clipped.text,
        detail: compact({
          toolCallId,
          nameResolved: toolCallId === null ? undefined : resolvedName !== null,
          parentUuid: inner.parentUuid,
          isError,
          outputType,
          outputLength: clipped.length,
          truncated: clipped.truncated || undefined,
          note: note === null ? null : note.text,
          noteTruncated: note === null ? undefined : note.truncated || undefined,
          hasResult: result !== null,
        }),
      });
    }

    case 'content.part': {
      const part = inner.part;
      if (!part || typeof part !== 'object') {
        ctx.warn('malformed_content_part', 'content.part 缺少 part 对象，已降级为 unknown', {});
        return unknownEvent({
          ts,
          detail: { topType: 'context.append_loop_event', eventType: type, reason: 'malformed_content_part' },
          line,
        });
      }
      const partType = part.type;
      if (partType === 'think' || partType === 'text') {
        const clipped = clipText(partType === 'think' ? part.think : part.text, MAX_TEXT);
        return makeEvent({
          seq: 0,
          ts,
          kind: partType === 'think' ? 'think' : 'text',
          name: null,
          status: null,
          text: clipped.text,
          detail: compact({
            partType,
            ...base,
            stepUuid: inner.stepUuid,
            fullLength: clipped.truncated ? clipped.length : undefined,
            truncated: clipped.truncated || undefined,
          }),
        });
      }
      ctx.warn('unknown_part_type', `无法识别的 content.part 类型：${String(partType)}`, {
        partType: String(partType),
      });
      return unknownEvent({
        ts,
        detail: {
          topType: 'context.append_loop_event',
          eventType: type,
          partType: partType === undefined ? null : String(partType),
        },
        line,
      });
    }

    default:
      ctx.warn('unknown_event_type', `无法识别的 loop event 类型：${String(type)}`, { eventType: String(type) });
      return unknownEvent({
        ts,
        detail: { topType: 'context.append_loop_event', eventType: type === undefined ? null : String(type) },
        line,
      });
  }
}

// ---------------------------------------------------------------------------
// 事件映射：顶层类型
// ---------------------------------------------------------------------------

/**
 * 记录会话实际使用的模型（后者覆盖前者：模型可在会话中被切换）。
 * modelAlias 是更完整的标识（如 kimi-code/k3）；短名 model（如 k3）仅在
 * 从未见过 alias 时兜底，避免把已拿到的完整标识降级。
 */
function noteModel(ctx, record, source) {
  const alias =
    typeof record.modelAlias === 'string' && record.modelAlias.length > 0 ? record.modelAlias : null;
  const provider = typeof record.provider === 'string' && record.provider.length > 0 ? record.provider : null;
  if (alias !== null) {
    const prev = ctx.model;
    ctx.model = modelHint(alias, { provider: provider || (prev ? prev.provider : null), source });
    return;
  }
  if (ctx.model !== null) {
    if (provider !== null && ctx.model.provider === null) ctx.model.provider = provider;
    return;
  }
  const short = typeof record.model === 'string' && record.model.length > 0 ? record.model : null;
  if (short !== null) ctx.model = modelHint(short, { provider, source });
}

function mapTopLevel(type, record, ts, line, ctx) {
  switch (type) {
    case 'metadata': {
      const protocolVersion = typeof record.protocol_version === 'string' ? record.protocol_version : null;
      if (protocolVersion !== null) ctx.formatVersion = protocolVersion;
      return makeEvent({
        seq: 0,
        ts,
        kind: 'meta',
        name: 'metadata',
        status: null,
        text: protocolVersion === null ? 'kimi wire metadata' : `kimi wire protocol ${protocolVersion}`,
        detail: compact({ protocolVersion, createdAt: toIso(record.created_at) }),
      });
    }

    case 'llm.request':
      noteModel(ctx, record, 'llm.request');
      return makeEvent({
        seq: 0,
        ts,
        kind: 'llm',
        name: 'llm.request',
        status: null,
        text: `${record.modelAlias || record.model || '(unknown model)'}${record.provider ? ` via ${record.provider}` : ''}`,
        detail: compact({
          agentId: record.agentId,
          requestKind: record.kind,
          provider: record.provider,
          model: record.model,
          modelAlias: record.modelAlias,
          thinkingEffort: record.thinkingEffort,
          maxTokens: record.maxTokens,
          messageCount: record.messageCount,
          turnStep: record.turnStep,
          toolSelect: record.toolSelect,
        }),
      });

    case 'llm.tools_snapshot': {
      const tools = Array.isArray(record.tools) ? record.tools : null;
      return makeEvent({
        seq: 0,
        ts,
        kind: 'llm',
        name: 'llm.tools_snapshot',
        status: null,
        text: tools === null ? 'tools snapshot' : `${tools.length} tools`,
        detail: compact({
          agentId: record.agentId,
          hash: record.hash,
          toolCount: tools === null ? null : tools.length,
          toolNames:
            tools === null
              ? null
              : tools.map((t) => (t && typeof t.name === 'string' ? t.name : null)).filter(Boolean).slice(0, MAX_LIST),
        }),
      });
    }

    case 'usage.record': {
      noteModel(ctx, record, 'usage.record');
      const summary = usageText(record.usage);
      return makeEvent({
        seq: 0,
        ts,
        kind: 'usage',
        name: 'usage.record',
        status: null,
        text: summary === null ? null : `${record.model || 'usage'}: ${summary}`,
        detail: compact({
          agentId: record.agentId,
          model: record.model,
          usageScope: record.usageScope,
          usage: record.usage && typeof record.usage === 'object' ? record.usage : null,
        }),
      });
    }

    case 'token_counting.measured':
    case 'token_counting.turn_recorded':
    case 'token_counting.truncated':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'usage',
        name: type,
        status: null,
        text: typeof record.tokens === 'number' ? `${record.tokens} tokens` : null,
        detail: compact({
          agentId: record.agentId,
          tokens: record.tokens,
          length: record.length,
          turnId: record.turnId,
        }),
      });

    case 'context.append_loop_event':
      return mapLoopEvent(record, ts, line, ctx);

    case 'context.append_message': {
      const message = record.message && typeof record.message === 'object' ? record.message : null;
      const clipped = clipText(message === null ? null : textFromContent(message.content), MAX_TEXT);
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'context.append_message',
        status: null,
        text: clipped.text,
        detail: compact({
          role: message === null ? null : message.role,
          origin: message !== null && message.origin && typeof message.origin === 'object' ? message.origin : null,
          messageId: message === null ? null : message.id,
          fullLength: clipped.truncated ? clipped.length : undefined,
          truncated: clipped.truncated || undefined,
        }),
      });
    }

    case 'turn.prompt':
    case 'turn.steer': {
      const clipped = clipText(textFromInput(record.input), MAX_TEXT);
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: type,
        status: null,
        text: clipped.text,
        detail: compact({
          agentId: record.agentId,
          promptId: record.promptId,
          origin: record.origin && typeof record.origin === 'object' ? record.origin : null,
          fullLength: clipped.truncated ? clipped.length : undefined,
          truncated: clipped.truncated || undefined,
        }),
      });
    }

    case 'prompt.accepted': {
      const clipped = clipText(textFromContent(record.content), MAX_TEXT);
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'prompt.accepted',
        status: null,
        text: clipped.text,
        detail: compact({
          agentId: record.agentId,
          promptId: record.promptId,
          fullLength: clipped.truncated ? clipped.length : undefined,
          truncated: clipped.truncated || undefined,
        }),
      });
    }

    case 'plugin.session_start': {
      const content = typeof record.content === 'string' ? record.content : null;
      const clipped = clipText(content, MAX_TEXT);
      const match = content === null ? null : /plugin_session_start\s+plugin="([^"]+)"/.exec(content);
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'plugin.session_start',
        status: null,
        text: clipped.text,
        detail: compact({
          agentId: record.agentId,
          plugin: match === null ? null : match[1],
          fullLength: clipped.truncated ? clipped.length : undefined,
          truncated: clipped.truncated || undefined,
        }),
      });
    }

    case 'runtime.set_binding':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'runtime.set_binding',
        status: null,
        text: `runtime ${record.runtimeId || '?'}${record.workspaceId ? ` @ ${record.workspaceId}` : ''}`,
        detail: compact({ agentId: record.agentId, workspaceId: record.workspaceId, runtimeId: record.runtimeId }),
      });

    case 'config.update':
      noteModel(ctx, record, 'config.update');
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'config.update',
        status: null,
        text: record.modelAlias === undefined ? null : `model ${record.modelAlias}`,
        detail: compact({
          agentId: record.agentId,
          modelAlias: record.modelAlias,
          thinkingEffort: record.thinkingEffort,
          profileName: record.profileName,
          subagentNames: Array.isArray(record.subagentNames) ? record.subagentNames.slice(0, MAX_LIST) : null,
          systemPromptLength: typeof record.systemPrompt === 'string' ? record.systemPrompt.length : null,
        }),
      });

    case 'profile.bind': {
      noteModel(ctx, record, 'profile.bind');
      const disclosure =
        record.environmentDisclosure && typeof record.environmentDisclosure === 'object'
          ? record.environmentDisclosure
          : null;
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'profile.bind',
        status: null,
        text: record.modelAlias === undefined ? null : `profile ${record.profileName || '?'} · ${record.modelAlias}`,
        detail: compact({
          agentId: record.agentId,
          profileName: record.profileName,
          modelAlias: record.modelAlias,
          thinkingEffort: record.thinkingEffort,
          cwd: disclosure === null ? null : disclosure.cwd,
          agentsMdPaths: Array.isArray(record.agentsMdPaths) ? record.agentsMdPaths.slice(0, MAX_LIST) : null,
          activeToolCount: Array.isArray(record.activeToolNames) ? record.activeToolNames.length : null,
          disallowedTools: Array.isArray(record.disallowedTools) ? record.disallowedTools.slice(0, MAX_LIST) : null,
          subagents: Array.isArray(record.subagents) ? record.subagents.slice(0, MAX_LIST) : null,
          systemPromptLength: typeof record.systemPrompt === 'string' ? record.systemPrompt.length : null,
        }),
      });
    }

    case 'permission.set_mode':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'permission.set_mode',
        status: null,
        text: `permission mode: ${record.mode || '?'}`,
        detail: compact({ agentId: record.agentId, mode: record.mode }),
      });

    case 'permission.record_approval_result': {
      const result = record.result && typeof record.result === 'object' ? record.result : null;
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'permission.record_approval_result',
        status: null,
        text: typeof record.action === 'string' ? clipText(record.action, 300).text : null,
        detail: compact({
          turnId: record.turnId,
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          action: typeof record.action === 'string' ? clipText(record.action, 1000).text : null,
          decision: result === null ? null : result.decision,
          selectedLabel: result === null ? null : result.selectedLabel,
        }),
      });
    }

    case 'mcp.tools_discovered': {
      const tools = Array.isArray(record.tools) ? record.tools : null;
      const enabled = Array.isArray(record.enabledNames) ? record.enabledNames : null;
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'mcp.tools_discovered',
        status: null,
        text: `${record.serverName || 'mcp'}: ${tools === null ? '?' : tools.length} tools${
          enabled === null ? '' : ` (${enabled.length} enabled)`
        }`,
        detail: compact({
          agentId: record.agentId,
          serverName: record.serverName,
          hash: record.hash,
          toolCount: tools === null ? null : tools.length,
          enabledCount: enabled === null ? null : enabled.length,
          enabledNames: enabled === null ? null : enabled.slice(0, MAX_LIST),
        }),
      });
    }

    case 'tools.set_active_tools': {
      const names = Array.isArray(record.names) ? record.names : null;
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'tools.set_active_tools',
        status: null,
        text: names === null ? null : `${names.length} active tools`,
        detail: compact({
          agentId: record.agentId,
          count: names === null ? null : names.length,
          names: names === null ? null : names.slice(0, MAX_LIST),
        }),
      });
    }

    case 'tools.update_store': {
      const state = { truncated: false };
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'tools.update_store',
        status: null,
        text: typeof record.key === 'string' ? `${record.key} updated` : null,
        detail: compact({
          agentId: record.agentId,
          key: record.key,
          value: record.value === undefined ? null : clipValue(record.value, MAX_ARG_STRING, 0, state),
          valueTruncated: state.truncated || undefined,
        }),
      });
    }

    case 'task.started':
    case 'task.terminated': {
      const info = record.info && typeof record.info === 'object' ? record.info : null;
      let tail = null;
      if (record.outputTail !== undefined) {
        let raw;
        try {
          raw = typeof record.outputTail === 'string' ? record.outputTail : JSON.stringify(record.outputTail);
        } catch {
          raw = String(record.outputTail);
        }
        tail = clipText(raw, 2000);
      }
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: type,
        status: info === null ? null : taskStatus(info),
        text: info !== null && typeof info.description === 'string' ? clipText(info.description, 300).text : null,
        detail: compact({
          taskId: info === null ? null : info.taskId,
          description: info === null ? null : info.description,
          status: info === null ? null : info.status,
          kind: info === null ? null : info.kind,
          detached: info === null ? null : info.detached,
          startedAt: info === null ? null : toIso(info.startedAt),
          endedAt: info === null ? null : toIso(info.endedAt),
          timeoutMs: info === null ? null : info.timeoutMs,
          exitCode: info === null ? null : info.exitCode,
          stopReason: info === null ? null : info.stopReason,
          command: info !== null && typeof info.command === 'string' ? clipText(info.command, 500).text : null,
          outputTail: tail === null ? null : tail.text,
          outputTailTruncated: tail === null ? undefined : tail.truncated || undefined,
        }),
      });
    }

    case 'turn.ended':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'turn.ended',
        status: null,
        text: `turn ${record.turnId ?? '?'} ${record.reason || 'ended'}`,
        detail: compact({
          agentId: record.agentId,
          turnId: record.turnId,
          reason: record.reason,
          durationMs: record.durationMs,
        }),
      });

    case 'turn.cancel':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'turn.cancel',
        status: null,
        text: `turn ${record.turnId ?? '?'} cancelled`,
        detail: compact({ agentId: record.agentId, turnId: record.turnId, target: record.target, reason: record.reason }),
      });

    case 'plan_mode.cancel':
    case 'plan_mode.enter':
    case 'plan_mode.exit':
    case 'swarm_mode.enter':
    case 'swarm_mode.exit':
    case 'full_compaction.begin':
    case 'full_compaction.complete':
    case 'staleGuard.cleared':
    case 'goal.clear':
    case 'interruptionReminder.recorded':
    case 'context.undo':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: type,
        status: null,
        text: type,
        detail: compact({
          agentId: record.agentId,
          trigger: record.trigger,
          source: record.source,
          id: record.id,
          turnId: record.turnId,
          count: record.count,
        }),
      });

    case 'plan.revision':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'plan.revision',
        status: null,
        text: `plan ${record.id || '?'} v${record.version ?? '?'}`,
        detail: compact({
          agentId: record.agentId,
          id: record.id,
          version: record.version,
          path: record.path,
          sha256: record.sha256,
          bytes: record.bytes,
        }),
      });

    case 'staleGuard.recorded':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'staleGuard.recorded',
        status: null,
        text: typeof record.path === 'string' ? record.path : null,
        detail: compact({
          agentId: record.agentId,
          path: record.path,
          mtimeMs: record.mtimeMs,
          mtime: toIso(record.mtimeMs),
        }),
      });

    case 'task.waitDelivered':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'task.waitDelivered',
        status: null,
        text: Array.isArray(record.keys) ? `${record.keys.length} key(s) delivered` : null,
        detail: compact({
          agentId: record.agentId,
          keys: Array.isArray(record.keys) ? record.keys.slice(0, MAX_LIST) : null,
        }),
      });

    case 'file_history.checkpoint': {
      const entries = record.entries && typeof record.entries === 'object' ? record.entries : null;
      const paths = entries === null ? null : Object.keys(entries);
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'file_history.checkpoint',
        status: null,
        text:
          record.phase === undefined
            ? null
            : `${record.phase} checkpoint${paths === null ? '' : ` (${paths.length} files)`}`,
        detail: compact({
          agentId: record.agentId,
          turnId: record.turnId,
          phase: record.phase,
          entryCount: paths === null ? null : paths.length,
          paths: paths === null ? null : paths.slice(0, MAX_LIST),
        }),
      });
    }

    case 'goal.create': {
      const objective = typeof record.objective === 'string' ? clipText(record.objective, MAX_TEXT) : null;
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'goal.create',
        status: null,
        text: objective === null ? null : objective.text,
        detail: compact({
          agentId: record.agentId,
          goalId: record.goalId,
          objectiveLength: objective === null ? null : objective.length,
          completionCriterion:
            typeof record.completionCriterion === 'string' ? clipText(record.completionCriterion, 1000).text : null,
          fullLength: objective !== null && objective.truncated ? objective.length : undefined,
          truncated: objective !== null && objective.truncated ? true : undefined,
        }),
      });
    }

    case 'goal.update':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'goal.update',
        status: null,
        text: typeof record.tokensUsed === 'number' ? `${record.tokensUsed} tokens used` : null,
        detail: compact({ agentId: record.agentId, tokensUsed: record.tokensUsed }),
      });

    case 'prompt.completed':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'prompt.completed',
        status: null,
        text: `prompt ${record.reason || 'completed'}`,
        detail: compact({
          agentId: record.agentId,
          promptId: record.promptId,
          reason: record.reason,
          finishedAt: record.finishedAt,
        }),
      });

    case 'prompt.aborted':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'prompt.aborted',
        status: null,
        text: 'prompt aborted',
        detail: compact({ agentId: record.agentId, promptId: record.promptId, abortedAt: record.abortedAt }),
      });

    case 'turn.step.interrupted':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'turn.step.interrupted',
        status: null,
        text: `step ${record.step ?? '?'} interrupted${record.reason ? ` (${record.reason})` : ''}`,
        detail: compact({
          agentId: record.agentId,
          turnId: record.turnId,
          step: record.step,
          reason: record.reason,
        }),
      });

    case 'agent.turn.started':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'agent.turn.started',
        status: null,
        text: `turn ${record.turnId ?? '?'} started`,
        detail: compact({ turnId: record.turnId, queueItemId: record.queueItemId }),
      });

    case 'agent.turn.ended':
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'agent.turn.ended',
        status:
          record.outcome === 'done'
            ? 'ok'
            : typeof record.outcome === 'string' && ERROR_FINISH_REASONS.has(record.outcome)
              ? 'error'
              : null,
        text: `turn ${record.turnId ?? '?'} ${record.outcome || 'ended'}`,
        detail: compact({ turnId: record.turnId, outcome: record.outcome }),
      });

    case 'agent.message.appended': {
      // 双层信封：record.message.message 是消息本体，record.message.meta 是来源元信息
      const outer = record.message && typeof record.message === 'object' ? record.message : null;
      const message = outer !== null && outer.message && typeof outer.message === 'object' ? outer.message : null;
      const meta = outer !== null && outer.meta && typeof outer.meta === 'object' ? outer.meta : null;
      const clipped = clipText(message === null ? null : textFromContent(message.content), MAX_TEXT);
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'agent.message.appended',
        status: null,
        text: clipped.text,
        detail: compact({
          role: message === null ? null : message.role,
          source: meta === null ? null : meta.source,
          origin: meta !== null && meta.origin && typeof meta.origin === 'object' ? meta.origin : null,
          promptId: meta === null ? null : meta.promptId,
          createdAt: meta === null ? null : meta.createdAt,
          streamKind: record.kind,
          fullLength: clipped.truncated ? clipped.length : undefined,
          truncated: clipped.truncated || undefined,
        }),
      });
    }

    case 'context.apply_compaction': {
      const clipped = clipText(record.summary, MAX_TEXT);
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'context.apply_compaction',
        status: null,
        text: clipped.text,
        detail: compact({
          agentId: record.agentId,
          compactedCount: record.compactedCount,
          tokensBefore: record.tokensBefore,
          tokensAfter: record.tokensAfter,
          keptUserMessageCount: record.keptUserMessageCount,
          contextSummaryLength: typeof record.contextSummary === 'string' ? record.contextSummary.length : null,
          fullLength: clipped.truncated ? clipped.length : undefined,
          truncated: clipped.truncated || undefined,
        }),
      });
    }

    case 'interaction.request': {
      const request = record.request && typeof record.request === 'object' ? record.request : null;
      const questions = request !== null && Array.isArray(request.questions) ? request.questions : [];
      const text = questions.map((q) => (q && typeof q.question === 'string' ? q.question : null)).filter(Boolean).join('\n');
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'interaction.request',
        status: null,
        text: clipText(text, MAX_TEXT).text,
        detail: compact({
          id: record.id,
          interactionKind: record.kind,
          toolCallId: record.toolCallId,
          agentId: record.agentId,
          turnId: request === null ? null : request.turnId,
          questions: questions.slice(0, MAX_LIST).map((q) =>
            compact({
              header: q && q.header,
              question: q && typeof q.question === 'string' ? clipText(q.question, 500).text : null,
              options: Array.isArray(q && q.options)
                ? q.options
                    .map((o) => (o && typeof o.label === 'string' ? o.label : null))
                    .filter(Boolean)
                    .slice(0, MAX_LIST)
                : null,
            })
          ),
        }),
      });
    }

    case 'interaction.resolved': {
      const response = record.response && typeof record.response === 'object' ? record.response : null;
      const answers = response !== null && response.answers && typeof response.answers === 'object' ? response.answers : null;
      const pairs = answers === null ? null : Object.entries(answers).map(([q, a]) => [clipText(q, 200).text, clipText(String(a), 200).text]);
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'interaction.resolved',
        status: null,
        text: pairs === null ? null : clipText(pairs.map(([q, a]) => `${q} → ${a}`).join('\n'), MAX_TEXT).text,
        detail: compact({
          id: record.id,
          method: response === null ? null : response.method,
          answers: pairs === null ? null : Object.fromEntries(pairs),
        }),
      });
    }

    case 'file_history.tracked': {
      const entry = record.entry && typeof record.entry === 'object' ? record.entry : null;
      return makeEvent({
        seq: 0,
        ts,
        kind: 'notice',
        name: 'file_history.tracked',
        status: null,
        text: typeof record.path === 'string' ? record.path : null,
        detail: compact({
          agentId: record.agentId,
          turnId: record.turnId,
          path: record.path,
          version: entry === null ? null : entry.version,
          size: entry === null ? null : entry.size,
          contentHash: entry === null ? null : entry.contentHash,
        }),
      });
    }

    default:
      ctx.warn('unknown_top_type', `无法识别的顶层类型：${String(type)}`, { topType: String(type) });
      return unknownEvent({
        ts,
        detail: { topType: type === undefined ? null : String(type), reason: 'unknown_top_type' },
        line,
      });
  }
}

// ---------------------------------------------------------------------------
// 行 → 事件
// ---------------------------------------------------------------------------

/** 解析一行 wire JSONL 并映射为事件；任何异常都降级为 unknown，不抛给调用方。 */
function mapLine(line, ctx) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    ctx.warn('malformed_line', 'wire 行不是合法 JSON，已降级为 unknown', { lineLength: line.length });
    return unknownEvent({
      ts: null,
      detail: { reason: 'malformed_line', lineLength: line.length },
      line,
    });
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    ctx.warn('malformed_record', 'wire 行不是 JSON 对象，已降级为 unknown', { valueType: Array.isArray(record) ? 'array' : typeof record });
    return unknownEvent({ ts: null, detail: { reason: 'malformed_record' }, line });
  }
  const ts = record.time === undefined ? record.created_at : record.time;
  const type = record.type;
  if (typeof type !== 'string') {
    ctx.warn('missing_type', 'wire 行缺少 type 字段，已降级为 unknown', {});
    return unknownEvent({ ts, detail: { reason: 'missing_type' }, line });
  }
  return mapTopLevel(type, record, ts, line, ctx);
}

// ---------------------------------------------------------------------------
// 文件定位与读取
// ---------------------------------------------------------------------------

/** 解析 ref → 实际 wire 文件路径；失败时给出 warning code/message。 */
function locateWireFile(ref) {
  if (!ref || typeof ref !== 'object') {
    return { file: null, code: 'invalid_ref', message: 'ref 不是对象，无法定位 wire 文件', extra: {} };
  }
  const p = ref.path;
  if (typeof p !== 'string' || p.length === 0) {
    return { file: null, code: 'invalid_ref', message: 'ref.path 缺失或不是字符串', extra: { kind: ref.kind ?? null } };
  }
  let stat;
  try {
    stat = fs.statSync(p);
  } catch (err) {
    return { file: null, code: 'wire_missing', message: `会话路径不存在：${p}`, extra: { path: p, errno: err.code ?? null } };
  }
  try {
    if (stat.isFile()) return { file: p, code: null, message: null, extra: {} };
    // 常规布局：<sessionDir>/agents/main/wire.jsonl（mapping 产出的 ref.path 即会话目录）
    const mainWire = path.join(p, WIRE_RELATIVE);
    try {
      if (fs.statSync(mainWire).isFile()) return { file: mainWire, code: null, message: null, extra: {} };
    } catch {
      /* 继续尝试其它布局 */
    }
    // 兼容：path 直接是 agent 目录时 <path>/wire.jsonl
    const directWire = path.join(p, 'wire.jsonl');
    try {
      if (fs.statSync(directWire).isFile()) return { file: directWire, code: null, message: null, extra: {} };
    } catch {
      /* 落到 wire_missing */
    }
    return { file: null, code: 'wire_missing', message: `未找到 wire 文件：${mainWire}`, extra: { file: mainWire } };
  } catch {
    return {
      file: null,
      code: 'wire_missing',
      message: `未找到 wire 文件：${path.join(p, WIRE_RELATIVE)}`,
      extra: { file: path.join(p, WIRE_RELATIVE) },
    };
  }
}

/** cursor → 字节偏移。非法值按从头读处理并告警。 */
function parseCursor(cursor) {
  if (cursor === null || cursor === undefined || cursor === '') return { offset: 0, ok: true };
  const n = typeof cursor === 'number' ? cursor : Number(String(cursor).trim());
  if (!Number.isFinite(n) || n < 0) return { offset: 0, ok: false };
  return { offset: Math.floor(n), ok: true };
}

/** 读文件头第一行探测 protocol_version（失败返回 null）。 */
function readProtocolVersion(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(PROTOCOL_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, PROTOCOL_HEAD_BYTES, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const idx = text.indexOf('\n');
    const first = idx >= 0 ? text.slice(0, idx) : text;
    const record = JSON.parse(first);
    return record && typeof record.protocol_version === 'string' ? record.protocol_version : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** 从 fd 读取 [start, start+length) 的全部字节（短读时循环补读）。 */
function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = fs.readSync(fd, buf, read, length - read, start + read);
    if (n <= 0) break;
    read += n;
  }
  return read === length ? buf : buf.subarray(0, read);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 读取 kimi wire.jsonl 并归一化为统一事件。
 *
 * @param {{adapter?: string, kind?: string, path: string, id?: string}} ref 会话引用（kind='dir' 为会话目录）
 * @param {{cursor?: string|number|null}} [options] cursor = 已消费字节数（null/缺省表示从头；末尾半行不推进）
 * @returns {{events: object[], nextCursor: string|null, meta: object}}
 */
function readEvents(ref, options = {}) {
  const warnings = [];
  const warn = createWarner(warnings);
  const cursor = options === null || options === undefined ? null : options.cursor;
  const parsed = parseCursor(cursor);
  if (!parsed.ok) {
    warn('invalid_cursor', `cursor 不是合法的字节偏移，已按从头读取处理：${String(cursor)}`, {
      cursor: String(cursor),
    });
  }

  const located = locateWireFile(ref);
  if (located.file === null) {
    warn(located.code, located.message, located.extra);
    return makeReadResult([], { nextCursor: null, adapter: ADAPTER, formatVersion: null, warnings });
  }

  const file = located.file;
  const events = [];
  const ctx = { warn, toolNames: new Map(), formatVersion: null, model: null };
  let nextCursor = parsed.offset;
  let fd;

  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    let start = parsed.offset;
    if (start > size) {
      warn('cursor_beyond_eof', `cursor ${start} 超出文件大小 ${size}（文件被截断或重写），已从头读取`, {
        cursor: start,
        size,
      });
      start = 0;
    }
    const chunk = size > start ? readRange(fd, start, size - start) : Buffer.alloc(0);
    // 只消费以换行结尾的完整行：末尾半行（文件正在被写）留给下次，且不推进 offset。
    const lastNewline = chunk.length > 0 ? chunk.lastIndexOf(0x0a) : -1;
    const complete = lastNewline >= 0 ? chunk.subarray(0, lastNewline + 1) : Buffer.alloc(0);
    nextCursor = start + complete.length;
    if (complete.length > 0) {
      for (const line of complete.toString('utf8').split('\n')) {
        if (line.trim().length === 0) continue;
        const event = mapLine(line, ctx);
        if (event === null) continue;
        event.seq = events.length;
        events.push(event);
      }
    }
  } catch (err) {
    warn('wire_unreadable', `读取 wire 文件失败：${err.message}`, { file });
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }

  const formatVersion = ctx.formatVersion !== null ? ctx.formatVersion : readProtocolVersion(file);
  return makeReadResult(events, {
    nextCursor: String(nextCursor),
    adapter: ADAPTER,
    formatVersion,
    warnings,
    model: ctx.model,
  });
}

module.exports = { readEvents };
