'use strict';

/**
 * pi 适配器 —— 把 pi 的会话文件（追加式 JSONL）归一化为统一事件流。
 *
 * ============================ 数据源（本机实测 2026-09-20） ============================
 *
 * `~/.pi/agent/sessions/<cwd 编码>/<ISO 时间戳>_<uuid>.jsonl`
 * ——目录名是 cwd 把 `/` 换成 `-` 后首尾各加一个 `-`（`/Users/x/codes` →
 * `--Users-x-codes--`），文件名前缀是会话创建时间、后缀是会话 uuid。
 * dim 经 `pi-acp`（ACP 桥接，`externalAgents.pi.execPath`）委托 pi，会话仍落在同一目录，
 * 所以 dim 委托与用户手跑的会话格式完全一致。
 *
 * 格式为 **version 3 的追加式 JSONL**：本机 87 个会话 / 22081 行实测，零坏行。
 * 首行固定是 `session`，其后按时间顺序追加：
 *
 *   {"type":"session","version":3,"id":<uuid>,"timestamp":ISO,"cwd":<path>}
 *   {"type":"model_change","id","parentId","timestamp","provider","modelId"}
 *   {"type":"thinking_level_change","id","parentId","timestamp","thinkingLevel"}
 *   {"type":"custom","customType":"web-search-results","data":{…}}      // 扩展写入
 *   {"type":"message","id","parentId","timestamp","message":{…}}
 *
 * `message.role` 有四种（实测计数 user 321 / assistant 9973 / toolResult 11486 / system 1）：
 *
 *   user       {role, content:[{type:'text',text}], timestamp}
 *   assistant  {role, content:[thinking|text|toolCall|image], api, provider, model,
 *               usage:{input,output,cacheRead,cacheWrite,reasoning,totalTokens,cost:{…}},
 *               stopReason, rawStopReason, responseId, errorMessage?}
 *   toolResult {role, toolCallId, toolName, content:[{type:'text',text}], isError, details}
 *   system     {role, content:'', sections:{preamble,…}}                // 框架注入，罕见
 *
 * content part 实测分布：text 14701 / thinking 6245 / toolCall 11490 / image 2。
 *
 * ============================ 与 opencode 的关键差异 ============================
 *
 * pi 是**追加式**的：已落盘的行不会再被改写（opencode 的 part 行则会被原地改写、文本流式
 * 写回同一行）。因此这里不需要 opencode 那套「稳定边界」判定——**字节偏移就是正确游标**，
 * 与 kimi / codex / grok 同构：只消费以换行结尾的完整行（运行中会话的尾部半行留给下次），
 * 单行超上限时跳过并警告。
 *
 * 代价是**回合粒度**：pi 每个 assistant 回合写一行，所以一个回合进行中（模型正在流式输出）
 * 时日志里看不到它的中间内容，要等该行落盘。对「任务跑到哪了 / 结果如何」这个主要用途
 * 没有影响，且不会出现重复或截断的事件。
 *
 * ------------------------------ 事件映射 ------------------------------
 *
 *   session               → meta（只在首次读取时产出）
 *   model_change          → notice(model_change)
 *   thinking_level_change → notice(thinking_level)
 *   custom                → notice(custom)，name = customType
 *   message(user)         → notice(user_message)     ← 任务 prompt
 *   message(assistant)    → content 逐 part：thinking → think，text → text，
 *                           toolCall → tool_call；回合末尾另有 usage，有 errorMessage 时
 *                           再给一条 status=error 的 notice(error)
 *   message(toolResult)   → tool_result（status 由 isError 决定）
 *   message(system)       → notice(system)
 *   其它 / 无法解析        → unknown + warning（显式降级，不静默丢数据）
 *
 * 两处必须剥离的大字段（否则一次读取会把巨量 base64 灌进日志与 UI）：
 *   · `image` part 的 `data` 是 base64（实测 image/png），只留 mimeType 与字节数；
 *   · `toolResult.details` 是 **Python repr 字符串**（不是 JSON，实测单条可含整段文件内容），
 *     只留截断预览。
 */

const fs = require('node:fs');
const { toIso, makeEvent, makeReadResult, modelHint, warning } = require('../events');

const ADAPTER = 'pi';
const FORMAT_VERSION = 'pi-session/3';

const MAX_TEXT = 4000; // 单条事件 text 上限（超出截断并在 detail.truncated 标注）
const MAX_ARGS_TEXT = 1200; // tool_call detail.args 的 JSON 文本上限
const MAX_SUMMARY_TEXT = 160; // 一行摘要长度
const MAX_DETAILS_PREVIEW = 200; // toolResult.details（Python repr）预览上限
const MAX_LINE_BYTES = 1024 * 1024; // 单行硬上限（实测最大 362KB，中位数 1.4KB）
const MAX_LINES_PER_CALL = 1000; // 单次调用消费行数上限
const MAX_HEAD_BYTES = 65536; // 读首行（session 记录）的字节窗口

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

/** 一行摘要：折叠空白 + 截断。 */
function oneLine(text) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length <= MAX_SUMMARY_TEXT ? flat : flat.slice(0, MAX_SUMMARY_TEXT) + '…';
}

/** content（数组 / 字符串）→ 文本（拼接所有 text part）。 */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const out = [];
  for (const p of content) {
    if (p && typeof p === 'object' && typeof p.text === 'string') out.push(p.text);
  }
  return out.length === 0 ? null : out.join('\n');
}

/** toolCall 的 detail.args：序列化后截断（write/edit 的 content 可能极大）。 */
function clipArgs(args) {
  if (args === null || args === undefined) return null;
  let json;
  try {
    json = JSON.stringify(args);
  } catch {
    return { unserializable: true };
  }
  if (json.length <= MAX_ARGS_TEXT) return args;
  return { truncated: true, originalLength: json.length, preview: json.slice(0, MAX_ARGS_TEXT) };
}

/** 读文件首行（session 记录）；不可读返回 null。 */
function readSessionHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(MAX_HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, MAX_HEAD_BYTES, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    const text = buf.subarray(0, nl < 0 ? n : nl).toString('utf8').trim();
    if (text.length === 0) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && parsed.type === 'session' ? parsed : null;
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

/* ------------------------------ 记录 → 事件 ------------------------------ */

function messageEvents(record, ctx) {
  const out = [];
  const msg = record.message;
  const ts = toIso(record.timestamp) || toIso(msg.timestamp);
  const base = { messageId: typeof record.id === 'string' ? record.id : null };
  const role = typeof msg.role === 'string' ? msg.role : null;

  switch (role) {
    case 'user': {
      const text = textOfContent(msg.content);
      const detail = { ...base, role: 'user' };
      out.push(
        makeEvent({ kind: 'notice', ts, name: 'user_message', text: capText(text, detail), detail })
      );
      return out;
    }

    case 'system': {
      const sections = msg.sections && typeof msg.sections === 'object' ? msg.sections : null;
      const preamble = sections && typeof sections.preamble === 'string' ? sections.preamble : null;
      out.push(
        makeEvent({
          kind: 'notice',
          ts,
          name: 'system',
          text: oneLine(preamble) || 'system prompt',
          detail: { ...base, role: 'system', sectionKeys: sections ? Object.keys(sections) : [] },
        })
      );
      return out;
    }

    case 'assistant': {
      const detail0 = { ...base, role: 'assistant' };
      if (typeof msg.provider === 'string' && typeof msg.model === 'string') {
        ctx.model = ctx.model || modelHint(msg.model, { provider: msg.provider, source: 'message' });
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const part of content) {
        if (part === null || typeof part !== 'object') continue;
        switch (part.type) {
          case 'thinking': {
            const text = typeof part.thinking === 'string' ? part.thinking : '';
            if (text.trim().length === 0) {
              ctx.emptyText += 1;
              break;
            }
            const d = { ...detail0 };
            out.push(makeEvent({ kind: 'think', ts, name: 'thinking', text: capText(text, d), detail: d }));
            break;
          }
          case 'text': {
            const text = typeof part.text === 'string' ? part.text : '';
            if (text.trim().length === 0) {
              ctx.emptyText += 1;
              break;
            }
            const d = { ...detail0 };
            out.push(makeEvent({ kind: 'text', ts, name: 'assistant', text: capText(text, d), detail: d }));
            break;
          }
          case 'toolCall': {
            const name = typeof part.name === 'string' && part.name.length > 0 ? part.name : 'tool';
            const args = part.arguments && typeof part.arguments === 'object' ? part.arguments : null;
            if (typeof part.id === 'string') ctx.toolNames.set(part.id, name);
            const brief = args === null ? null : oneLine(safeStringify(args));
            out.push(
              makeEvent({
                kind: 'tool_call',
                ts,
                name,
                text: brief === null ? name : `${name}: ${brief}`,
                detail: { ...detail0, toolCallId: typeof part.id === 'string' ? part.id : null, args: clipArgs(args) },
              })
            );
            break;
          }
          case 'image': {
            // 实测 image part 的 data 是 base64（image/png）——绝不进入事件
            const data = typeof part.data === 'string' ? part.data : '';
            out.push(
              makeEvent({
                kind: 'notice',
                ts,
                name: 'image',
                text: typeof part.mimeType === 'string' ? part.mimeType : 'image',
                detail: { ...detail0, mimeType: typeof part.mimeType === 'string' ? part.mimeType : null, base64Length: data.length },
              })
            );
            break;
          }
          default:
            ctx.unknownParts.add(part.type === undefined ? '(missing)' : String(part.type));
            out.push(
              makeEvent({
                kind: 'unknown',
                ts,
                detail: { ...detail0, droppedKind: part.type === undefined ? null : part.type },
                raw: { preview: safeStringify(part).slice(0, 200) },
              })
            );
        }
      }

      if (typeof msg.errorMessage === 'string' && msg.errorMessage.length > 0) {
        const d = { ...detail0 };
        out.push(
          makeEvent({
            kind: 'notice',
            ts,
            name: 'error',
            status: 'error',
            text: capText(msg.errorMessage, d),
            detail: { ...d, stopReason: typeof msg.stopReason === 'string' ? msg.stopReason : null },
          })
        );
      }

      const usage = msg.usage && typeof msg.usage === 'object' ? msg.usage : null;
      if (usage !== null) {
        const parts = [];
        if (Number.isFinite(usage.input)) parts.push(`${usage.input} in`);
        if (Number.isFinite(usage.output)) parts.push(`${usage.output} out`);
        if (Number.isFinite(usage.reasoning)) parts.push(`${usage.reasoning} reasoning`);
        if (Number.isFinite(usage.cacheRead) && usage.cacheRead > 0) parts.push(`${usage.cacheRead} cache read`);
        const cost = usage.cost && typeof usage.cost === 'object' && Number.isFinite(usage.cost.total) ? usage.cost.total : null;
        if (cost !== null) parts.push(`$${cost}`);
        out.push(
          makeEvent({
            kind: 'usage',
            ts,
            name: 'usage.message',
            text: parts.length === 0 ? null : parts.join(' / '),
            detail: {
              ...detail0,
              usage,
              cost,
              stopReason: typeof msg.stopReason === 'string' ? msg.stopReason : null,
              rawStopReason: typeof msg.rawStopReason === 'string' ? msg.rawStopReason : null,
            },
          })
        );
      }
      return out;
    }

    case 'toolResult': {
      const name = typeof msg.toolName === 'string' && msg.toolName.length > 0 ? msg.toolName : null;
      const callId = typeof msg.toolCallId === 'string' ? msg.toolCallId : null;
      const detail = { ...base, role: 'toolResult', toolCallId: callId, nameResolved: name !== null };
      if (typeof msg.details === 'string' && msg.details.length > 0) {
        // details 是 Python repr 字符串（不是 JSON），单条可含整段文件内容——只留截断预览
        detail.detailsPreview = msg.details.slice(0, MAX_DETAILS_PREVIEW);
        detail.detailsLength = msg.details.length;
        detail.detailsTruncated = msg.details.length > MAX_DETAILS_PREVIEW;
      } else if (msg.details !== undefined && msg.details !== null) {
        detail.detailsType = typeof msg.details;
      }
      // 工具返回的图片（实测 image part 的 data 是 base64）只留占位符与元数据，正文绝不进入事件
      let text = textOfContent(msg.content);
      const images = Array.isArray(msg.content) ? msg.content.filter((p) => p && typeof p === 'object' && p.type === 'image') : [];
      if (images.length > 0) {
        const marker = images
          .map((p) => `[image: ${typeof p.mimeType === 'string' ? p.mimeType : 'unknown'}]`)
          .join(' ');
        text = text === null || text.trim().length === 0 ? marker : `${text}\n${marker}`;
        detail.imageParts = images.length;
        detail.imageBase64Length = images.reduce((n, p) => n + (typeof p.data === 'string' ? p.data.length : 0), 0);
      }
      out.push(
        makeEvent({
          kind: 'tool_result',
          ts,
          name,
          status: msg.isError === true ? 'error' : 'ok',
          text: capText(text, detail),
          detail,
        })
      );
      return out;
    }

    default:
      ctx.unknownRoles.add(role === null ? '(missing)' : role);
      out.push(
        makeEvent({
          kind: 'unknown',
          ts,
          detail: { ...base, droppedKind: role },
          raw: { preview: safeStringify(msg).slice(0, 200) },
        })
      );
      return out;
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** 一条 jsonl 记录 → 0..n 个事件。 */
function eventsOfRecord(record, ctx) {
  switch (record.type) {
    case 'session':
      return []; // 由 meta 事件单独承载（只在首次读取时产出）

    case 'model_change':
      return [
        makeEvent({
          kind: 'notice',
          ts: toIso(record.timestamp),
          name: 'model_change',
          text: [record.provider, record.modelId].filter((v) => typeof v === 'string').join('/') || null,
          detail: {
            provider: typeof record.provider === 'string' ? record.provider : null,
            modelId: typeof record.modelId === 'string' ? record.modelId : null,
          },
        }),
      ];

    case 'thinking_level_change':
      return [
        makeEvent({
          kind: 'notice',
          ts: toIso(record.timestamp),
          name: 'thinking_level',
          text: typeof record.thinkingLevel === 'string' ? record.thinkingLevel : null,
          detail: { thinkingLevel: typeof record.thinkingLevel === 'string' ? record.thinkingLevel : null },
        }),
      ];

    case 'custom': {
      const customType = typeof record.customType === 'string' ? record.customType : null;
      return [
        makeEvent({
          kind: 'notice',
          ts: toIso(record.timestamp),
          name: customType === null ? 'custom' : `custom:${customType}`,
          text: customType,
          detail: { customType, keys: record.data && typeof record.data === 'object' ? Object.keys(record.data) : [] },
        }),
      ];
    }

    case 'message': {
      const msg = record.message;
      if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
        ctx.unknownTypes.add('message:malformed');
        return [
          makeEvent({
            kind: 'unknown',
            ts: toIso(record.timestamp),
            detail: { reason: 'malformed_message' },
            raw: { preview: safeStringify(record).slice(0, 200) },
          }),
        ];
      }
      return messageEvents(record, ctx);
    }

    default:
      ctx.unknownTypes.add(record.type === undefined ? '(missing)' : String(record.type));
      return [
        makeEvent({
          kind: 'unknown',
          ts: toIso(record.timestamp),
          detail: { droppedKind: record.type === undefined ? null : record.type },
          raw: { preview: safeStringify(record).slice(0, 200) },
        }),
      ];
  }
}

/* ------------------------------ 入口 ------------------------------------ */

/**
 * 读取 pi 会话事件。
 * @param {{adapter?: string, kind?: string, path: string, id?: string}} ref 会话引用（path = 会话 jsonl 文件）
 * @param {{cursor?: string|null, maxLines?: number}} [options]
 */
function readEvents(ref, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxLines = Number.isInteger(opts.maxLines) && opts.maxLines > 0 ? opts.maxLines : MAX_LINES_PER_CALL;
  const warnings = [];
  const stop = (events = [], nextCursor = null, model = null) =>
    makeReadResult(events, { nextCursor, adapter: ADAPTER, formatVersion: FORMAT_VERSION, warnings, model });

  const file = ref && typeof ref.path === 'string' && ref.path.length > 0 ? ref.path : null;
  if (file === null) {
    warnings.push(warning('invalid_ref', '会话引用缺少 path 字段，无法读取 pi 会话文件'));
    return stop();
  }

  const header = readSessionHeader(file);
  const model = null; // 由 assistant 消息里的 provider/model 填充（见 ctx.model）

  let offset = 0;
  if (opts.cursor !== undefined && opts.cursor !== null && opts.cursor !== '') {
    const parsed = Number(opts.cursor);
    if (Number.isInteger(parsed) && parsed >= 0) offset = parsed;
    else
      warnings.push(
        warning('invalid_cursor', `cursor 不是合法的字节偏移，已按从头读取处理：${String(opts.cursor)}`, {
          cursor: String(opts.cursor),
        })
      );
  }

  const ctx = { toolNames: new Map(), unknownTypes: new Set(), unknownParts: new Set(), unknownRoles: new Set(), emptyText: 0, model };

  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    warnings.push(warning('session_missing', `无法读取 ${file}：${String((err && err.message) || err)}`, { file }));
    return stop();
  }

  try {
    const size = fs.fstatSync(fd).size;
    let start = offset;
    if (start > size) {
      warnings.push(
        warning('cursor_beyond_eof', `cursor ${start} 超出文件大小 ${size}（文件被截断或重写），已从头读取`, {
          cursor: start,
          size,
        })
      );
      start = 0;
    }

    const window = Math.max(size - start, 0);
    const buf = Buffer.alloc(Math.min(window, MAX_LINE_BYTES * 4));
    const read = fs.readSync(fd, buf, 0, buf.length, start);
    const chunk = buf.subarray(0, read);

    const events = [];
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
            kind: 'unknown',
            detail: { reason: 'non_object_record', byteOffset: lineStart },
            raw: { preview: raw.slice(0, 200) },
          })
        );
        continue;
      }
      for (const ev of eventsOfRecord(record, ctx)) events.push(ev);
    }

    const nextCursor = start + consumed;

    if (ctx.unknownTypes.size > 0) {
      warnings.push(
        warning('unknown_record_type', `出现未识别的记录类型：${[...ctx.unknownTypes].join(', ')}`, {
          types: [...ctx.unknownTypes],
        })
      );
    }
    if (ctx.unknownRoles.size > 0) {
      warnings.push(
        warning('unknown_role', `出现未识别的消息角色：${[...ctx.unknownRoles].join(', ')}`, {
          roles: [...ctx.unknownRoles],
        })
      );
    }
    if (ctx.unknownParts.size > 0) {
      warnings.push(
        warning('unknown_part_type', `出现未识别的 content part 类型：${[...ctx.unknownParts].join(', ')}`, {
          parts: [...ctx.unknownParts],
        })
      );
    }

    // 元信息事件只在首次读取时给出（增量读不重复）——header 来自首行 session 记录。
    if (offset === 0) {
      const detail = {
        adapter: ADAPTER,
        formatVersion: FORMAT_VERSION,
        sessionId: (header && typeof header.id === 'string' ? header.id : null) || ref.id || null,
        version: header && Number.isFinite(header.version) ? header.version : null,
        cwd: header && typeof header.cwd === 'string' ? header.cwd : null,
        createdAt: toIso(header && header.timestamp),
        file,
        // 空白占位文本（实测存在）不产事件、只计数，免得把「行数 > 事件数」误判成丢数据
        emptyTextParts: ctx.emptyText,
      };
      events.unshift(makeEvent({ kind: 'meta', name: 'metadata', ts: detail.createdAt, text: detail.cwd, detail }));
    }

    events.forEach((ev, i) => {
      ev.seq = i;
    });

    return stop(events, String(nextCursor), ctx.model);
  } catch (err) {
    warnings.push(warning('read_failed', `读取 ${file} 失败：${String((err && err.message) || err)}`, { file }));
    return stop([], String(offset));
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}

module.exports = { readEvents, FORMAT_VERSION };
