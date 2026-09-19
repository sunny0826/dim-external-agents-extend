'use strict';

/**
 * codex 适配器（T1.5）：把 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 归一化为统一事件。
 *
 * 文件格式（实测 2026-06 ~ 2026-09 共 500+ 样本）：
 * 每行一个 JSON 对象 `{ timestamp, ordinal, type, payload }`，首行 `type='session_meta'`。
 * 实测出现的顶层 type：session_meta / response_item / event_msg / turn_context / world_state /
 * token_usage_record / compacted / inter_agent_communication_metadata。
 * 二级分派键：`response_item.payload.type`、`event_msg.payload.type`（`item_completed` 再看 `payload.item.type`）。
 *
 * 映射表（'→' 右侧为统一事件 kind / name）：
 *   session_meta                            → meta / session
 *   response_item message(assistant)        → text / assistant
 *   response_item message(user)             → notice / user_message（含 harness 注入的上下文）
 *   response_item message(developer|system) → notice / developer_message | system_message
 *   response_item message(tool)             → tool_result
 *   response_item reasoning                 → think / reasoning
 *   response_item custom_tool_call | function_call | *_call → tool_call
 *   response_item *_output | *_result       → tool_result
 *   response_item web_search_call           → tool_call / web_search
 *   response_item image_generation_call     → tool_call / image_generation
 *   response_item agent_message             → notice / agent_message（子 agent 通信）
 *   response_item compaction                → notice / compaction（内容加密）
 *   event_msg task_started                  → step / turn（detail.phase='begin'）
 *   event_msg task_complete | turn_aborted  → step / turn（detail.phase='end'）
 *   event_msg token_count                   → usage / token_count
 *   event_msg thread_settings[_applied]     → notice / thread_settings
 *   event_msg thread_goal_updated           → notice / thread_goal
 *   event_msg item_completed                → 按 item.type 分派（见 mapItem）
 *   token_usage_record                      → usage / response_usage
 *   turn_context                            → notice / turn_context
 *   world_state                             → notice / world_state
 *   compacted                               → notice / compacted
 *   inter_agent_communication_metadata      → notice / inter_agent_meta
 *   其余（含未识别的二级 type）              → unknown + warning（降级显式，绝不静默丢弃）
 *
 * 去重（同一逻辑记录可能同时落在 response_item 与 event_msg/item_completed 两条流）：
 *   - id 命中：item.id 出现在 response_item 的 id/call_id 集合 → 该 item 不再单独出事件
 *     （实测覆盖 AgentMessage / Reasoning / McpToolCall / FileChange / WebSearch / SubAgentActivity /
 *      FunctionCallOutput，以及旧版把 exec 记成 function_call 的 CommandExecution）；
 *   - 文本指纹命中：item 文本与 response_item 的 user/assistant 文本完全相同 → 跳过；
 *   - 命令指纹命中：CommandExecution 的命令行等于某条 response_item 工具调用的 cmd → 跳过
 *     （Codex Desktop 0.15x 把同一次 exec 同时写成 custom_tool_call 与 CommandExecution，两侧 id 无关联）；
 *   - 用量指纹命中：token_usage_record 与 event_msg/token_count 数值相同时只保留先出现的一条。
 *   去重只消除重复、不丢信息，因此不产生 warning（不置 degraded）。
 *
 * 体积控制：base_instructions / encrypted_content / developer_instructions / stdout 等大字段一律不进事件；
 * 主文本上限 MAX_TEXT，detail 内字符串上限 MAX_DETAIL_TEXT，raw 只保留标量与短字符串
 * （超限字段以 `[string:N]` 占位并记入 raw.payload.__dropped）。
 *
 * 增量读：cursor = 已消费字节数（字符串化的十进制数字；null/'' 表示从头）。
 * 只消费以 `\n` 结尾的完整行；尾部半行不消费、不推进 offset（调用可安全重复）。
 * 单次调用有行数与字节上限（MAX_LINES_PER_CALL / MAX_CALL_BYTES），未读完部分留给下次，
 * nextCursor 精确指向已消费边界。cursor>0 时另回看 CONTEXT_BYTES 字节做去重预扫描（不出事件），
 * 使跨批次的孪生记录仍能被识别；实测把整文件一次性读与分 3~50 行增量读的差异压到极少数
 * 超长间距的 think/assistant 文本重复（**不会丢事件**）。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const { makeEvent, makeReadResult, modelHint, warning } = require('../events');

/** 适配器标识，与 core/mapping.js 产出的 ref.adapter 一致。 */
const ADAPTER = 'codex';
/** 单次调用最多读取的字节数（超出留给下次，保证单次调用有界）。 */
const MAX_CALL_BYTES = 8 * 1024 * 1024;
/** 单行硬上限：窗口内仍无换行则放弃本次读取（不推进 cursor，避免丢事件）。 */
const MAX_LINE_BYTES = 64 * 1024 * 1024;
/** 单次调用最多处理的行数。 */
const MAX_LINES_PER_CALL = 1000;
/** 主文本（事件 text 字段）截断上限。 */
const MAX_TEXT = 4000;
/** detail 内字符串截断上限。 */
const MAX_DETAIL_TEXT = 1000;
/** raw 投影里保留的字符串上限，超出的只记字段名。 */
const MAX_RAW_TEXT = 200;
/** 计算去重指纹前先截断，避免对 MB 级文本做哈希。 */
const MAX_FP_TEXT = 2000;
/** 读 session_meta 头部窗口（cli_version 位于首行前若干字节）。 */
const FIRST_LINE_PROBE_BYTES = 2048;
/** 增量读时向前回看的字节数：让去重指纹看到上一批次的孪生记录（只用于预扫描，不出事件）。 */
const CONTEXT_BYTES = 1024 * 1024;

/* ------------------------------- 通用工具 -------------------------------- */

/** 截断文本；返回 {text, truncated, length}；非字符串 → text 为 null。 */
function cap(value, max) {
  if (typeof value !== 'string') return { text: null, truncated: false, length: 0 };
  if (value.length <= max) return { text: value, truncated: false, length: value.length };
  return { text: `${value.slice(0, max)}…`, truncated: true, length: value.length };
}

/** 主文本截断：截断时把 detail.truncated / detail.textLength 写进 detail。 */
function primaryText(detail, value, max = MAX_TEXT) {
  const c = cap(value, max);
  if (c.truncated) {
    detail.truncated = true;
    detail.textLength = c.length;
  }
  return c.text;
}

/** detail 内次级字符串：截断时标注 `<key>Truncated` / `<key>Length`。 */
function putText(detail, key, value, max = MAX_DETAIL_TEXT) {
  const c = cap(value, max);
  if (c.text === null) return null;
  detail[key] = c.text;
  if (c.truncated) {
    detail[`${key}Truncated`] = true;
    detail[`${key}Length`] = c.length;
  }
  return c.text;
}

/** 拼接内容数组（支持纯字符串、{text}、codex 的 input_text/output_text/Text）→ 文本或 null。 */
function joinTexts(value) {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (!Array.isArray(value)) return null;
  const parts = [];
  for (const item of value) {
    if (typeof item === 'string') parts.push(item);
    else if (item && typeof item.text === 'string') parts.push(item.text);
  }
  const out = parts.filter((t) => t.length > 0).join('\n');
  return out.length > 0 ? out : null;
}

/** 内容数组的条目类型列表（展示用，最多 8 个）。 */
function contentKinds(content) {
  if (!Array.isArray(content)) return null;
  const kinds = [];
  for (const item of content) {
    const t = item && typeof item.type === 'string' ? item.type : typeof item;
    if (!kinds.includes(t)) kinds.push(t);
  }
  return kinds.slice(0, 8);
}

/** 归一化文本 → 去重指纹（sha1 前 16 位）；空文本返回 null。 */
function fpOf(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return null;
  return crypto.createHash('sha1').update(normalized.slice(0, MAX_FP_TEXT)).digest('hex').slice(0, 16);
}

/**
 * 从 function_call.arguments / custom_tool_call.input 里提取 exec 的命令行文本（可能一次调用里批量执行多条命令）。
 * 覆盖两种写法：JSON `"cmd":"..."`（旧版 function_call）与 DSL `cmd:"..."`（新版 custom_tool_call）。
 * 只用于去重指纹与展示摘要，不追求完整还原调用语义。
 */
function extractCmdTexts(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = [];
  const seen = new Set();
  const push = (value) => {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    out.push(value);
    return out.length >= 50; // 单条调用内的命令数上限，防病态输入
  };
  const unescape = (raw) => {
    try {
      return JSON.parse(`"${raw}"`);
    } catch {
      return raw;
    }
  };
  for (const re of [/"cmd"\s*:\s*"((?:[^"\\]|\\.)*)"/g, /(?:^|[^A-Za-z_"])cmd\s*:\s*"((?:[^"\\]|\\.)*)"/g]) {
    re.lastIndex = 0;
    let m = re.exec(text);
    while (m !== null) {
      if (push(unescape(m[1]))) return out;
      m = re.exec(text);
    }
  }
  // 批量形态（实测 Codex Desktop 0.15x）：`const cmds=["a","b"]; for (...) exec_command({cmd:c})`
  const batch = /(?:^|[^A-Za-z_$])cmds\s*=\s*\[([^\]]*)\]/g;
  let bm = batch.exec(text);
  while (bm !== null) {
    const strings = /"((?:[^"\\]|\\.)*)"/g;
    let sm = strings.exec(bm[1]);
    while (sm !== null) {
      if (push(unescape(sm[1]))) return out;
      sm = strings.exec(bm[1]);
    }
    bm = batch.exec(text);
  }
  return out;
}

/** 单条工具调用的首条命令（展示用）。 */
function extractCmdText(text) {
  const all = extractCmdTexts(text);
  return all.length > 0 ? all[0] : null;
}

/** CommandExecution 的 command 字段 → 可比较的命令文本。 */
function commandTextOf(command) {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command) || command.length === 0) return null;
  const parts = command.map((c) => String(c));
  // ["/bin/zsh","-lc","<cmd>"] 形态：取最后一段（与工具调用里的 cmd 对齐）
  if (parts.length >= 3 && /^-[A-Za-z]*c$/.test(parts[1])) return parts[parts.length - 1];
  return parts.join(' ');
}

/** 从工具输出文本里尽力解析退出码。 */
function exitCodeOf(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const m =
    /"exit_code"\s*:\s*(-?\d+)/.exec(text) ||
    /Process exited with code (-?\d+)/.exec(text) ||
    /Exit code:\s*(-?\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

/** payload.status / item.status → 'ok' | 'error' | null。 */
function statusOf(status) {
  if (status === 'completed' || status === 'success' || status === 'succeeded') return 'ok';
  if (status === 'failed' || status === 'error' || status === 'errored' || status === 'aborted') return 'error';
  return null;
}

/** 综合退出码、状态字段与少量已知输出模式判定结果状态。 */
function resultStatus(text, status) {
  const code = exitCodeOf(text);
  if (code !== null) return { status: code === 0 ? 'ok' : 'error', exitCode: code };
  if (typeof text === 'string' && /^Success\.\s+Updated the following files:/m.test(text)) {
    return { status: 'ok', exitCode: null };
  }
  return { status: statusOf(status), exitCode: null };
}

/** raw 投影：只保留标量与短字符串，大字段换成 `[string:N]` / `[array:N]` 并登记字段名。 */
function compactRaw(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === 'payload') continue;
    if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.length <= MAX_RAW_TEXT ? v : `[string:${v.length}]`;
  }
  const payload = record.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = {};
    const dropped = [];
    for (const [k, v] of Object.entries(payload)) {
      if (v === null || typeof v === 'number' || typeof v === 'boolean') p[k] = v;
      else if (typeof v === 'string') {
        if (v.length <= MAX_RAW_TEXT) p[k] = v;
        else {
          p[k] = `[string:${v.length}]`;
          dropped.push(k);
        }
      } else if (Array.isArray(v)) {
        p[k] = `[array:${v.length}]`;
        dropped.push(k);
      } else if (typeof v === 'object') {
        p[k] = `[object:${Object.keys(v).length}]`;
        dropped.push(k);
      }
    }
    if (dropped.length > 0) p.__dropped = dropped.slice(0, 12);
    out.payload = p;
  }
  return out;
}

/** 只读文件头部窗口，尽力取 session_meta.cli_version（cursor>0 的调用也能给出 formatVersion）。 */
function readCliVersion(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(FIRST_LINE_PROBE_BYTES);
    const n = fs.readSync(fd, buf, 0, FIRST_LINE_PROBE_BYTES, 0);
    const m = /"cli_version"\s*:\s*"([^"]*)"/.exec(buf.subarray(0, n).toString('utf8'));
    return m ? m[1] : null;
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

/**
 * 从 offset 起读一段；窗口内没有换行且文件未读完时按需扩大窗口（上限 MAX_LINE_BYTES）。
 * 返回 {buffer, truncatedLine}：truncatedLine=true 表示单行超过硬上限，调用方应放弃本次读取。
 */
function readWindow(fd, offset, size) {
  let limit = Math.min(MAX_CALL_BYTES, Math.max(size - offset, 0));
  if (limit <= 0) return { buffer: Buffer.alloc(0), truncatedLine: false };
  let buf = Buffer.alloc(limit);
  let n = fs.readSync(fd, buf, 0, limit, offset);
  while (buf.subarray(0, n).indexOf(0x0a) < 0 && offset + n < size) {
    if (limit >= MAX_LINE_BYTES) return { buffer: buf.subarray(0, n), truncatedLine: true };
    limit = Math.min(MAX_LINE_BYTES, Math.max(limit * 4, 64 * 1024), size - offset);
    buf = Buffer.alloc(limit);
    n = fs.readSync(fd, buf, 0, limit, offset);
  }
  return { buffer: buf.subarray(0, n), truncatedLine: false };
}

/**
 * 读取 [start-CONTEXT_BYTES, start) 区间作为「上一批次上下文」，
 * 只用于预扫描指纹（跨批次去重稳定），不产生事件。坏行忽略。
 */
function readContextRecords(fd, start) {
  const from = Math.max(0, start - CONTEXT_BYTES);
  const length = start - from;
  if (length <= 0) return [];
  const buf = Buffer.alloc(length);
  let read = 0;
  try {
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, from + read);
      if (n <= 0) break;
      read += n;
    }
  } catch {
    return [];
  }
  let text = buf.subarray(0, read).toString('utf8');
  if (from > 0) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      const record = JSON.parse(t);
      if (record && typeof record === 'object' && !Array.isArray(record)) out.push({ record, offset: from });
    } catch {
      /* 上下文里的坏行忽略（它在上一次调用中已被处理） */
    }
  }
  return out;
}

/* ------------------------------- 预扫描 ---------------------------------- */

/**
 * 批次预扫描：收集「另一条流」的 id、文本指纹与工具名，使去重与行序无关
 * （同一逻辑记录在部分版本里先出现在 event_msg，部分版本里先出现在 response_item）。
 *
 * @param {object[]} context 上一批次窗口内的记录（只看不产出，用于跨批次稳定去重）
 * @param {object[]} records 本批次记录
 */
function prescan(context, records) {
  const probe = {
    riIds: new Set(), // response_item 的 id / call_id
    assistantFp: new Set(), // assistant 文本指纹
    userFp: new Set(), // user 文本指纹
    execCmdFp: new Set(), // response_item 工具调用里的命令行指纹
    reasoningTextById: new Map(), // reasoning id → item 侧可读摘要（用于补齐被加密的 response_item/reasoning）
    callNames: new Map(), // callId → 工具名（跨批次给 tool_result 补名）
    usageCp: new Set(), // 上一批次已发出的用量指纹（批次内不再重复）
    formatVersion: null,
  };
  for (const rec of context) {
    if (rec.invalid) continue;
    const r = rec.record;
    const p = r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload) ? r.payload : null;
    if (!p) continue;
    if (r.type === 'token_usage_record') {
      const u = p.usage && typeof p.usage === 'object' ? p.usage : {};
      const fp = usageFingerprint(num(u.input_tokens), num(u.output_tokens), num(u.total_tokens));
      if (fp !== null) probe.usageCp.add(fp);
    } else if (r.type === 'event_msg' && p.type === 'token_count') {
      const info = p.info && typeof p.info === 'object' ? p.info : {};
      const u = info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : info.total_token_usage || {};
      const fp = usageFingerprint(num(u.input_tokens), num(u.output_tokens), num(u.total_tokens));
      if (fp !== null) probe.usageCp.add(fp);
    }
  }
  for (const rec of context.concat(records)) {
    if (rec.invalid) continue;
    const r = rec.record;
    const p = r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload) ? r.payload : null;
    if (!p) continue;
    if (r.type === 'session_meta') {
      probe.formatVersion = typeof p.cli_version === 'string' ? p.cli_version : probe.formatVersion;
      continue;
    }
    if (r.type === 'response_item') {
      if (typeof p.id === 'string') probe.riIds.add(p.id);
      if (typeof p.call_id === 'string') probe.riIds.add(p.call_id);
      if (p.type === 'message') {
        const fp = fpOf(joinTexts(p.content));
        if (fp) {
          if (p.role === 'assistant') probe.assistantFp.add(fp);
          else if (p.role === 'user') probe.userFp.add(fp);
        }
      }
      const argsText = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : null;
      for (const cmd of extractCmdTexts(argsText)) {
        const cmdFp = fpOf(cmd);
        if (cmdFp) probe.execCmdFp.add(cmdFp);
      }
      if (typeof p.call_id === 'string' && /_call$/.test(typeof p.type === 'string' ? p.type : '')) {
        const name = [typeof p.namespace === 'string' && p.namespace.length > 0 ? p.namespace : null, typeof p.name === 'string' ? p.name : null]
          .filter(Boolean)
          .join('/');
        if (name.length > 0) probe.callNames.set(p.call_id, name);
      }
      continue;
    }
    if (r.type === 'event_msg' && p.item && typeof p.item === 'object') {
      const item = p.item;
      if (item.type === 'Reasoning' && typeof item.id === 'string') {
        const text = joinTexts(item.summary_text) || joinTexts(item.raw_content);
        if (fpOf(text)) probe.reasoningTextById.set(item.id, text);
      }
    }
  }
  return probe;
}

/* ------------------------------- 映射器 ---------------------------------- */

/** 构造一次读取的映射状态与分派函数。 */
function createMapper(probe) {
  const state = {
    events: [],
    warnings: [],
    seq: 0,
    formatVersion: probe.formatVersion,
    callNames: new Map(probe.callNames), // callId → 工具名（给 tool_result 补名）
    usageFp: new Set(probe.usageCp), // token 用量指纹（token_usage_record 与 event_msg/token_count 去重）
    model: null, // 会话实际使用的模型（turn_context / thread_settings 中提取）
  };

  /** 记录会话实际使用的模型；后者覆盖前者（模型可在会话中被切换）。 */
  function noteModel(id, provider, source) {
    if (typeof id !== 'string' || id.length === 0) return;
    const prev = state.model;
    state.model = modelHint(id, {
      provider: typeof provider === 'string' && provider.length > 0 ? provider : prev ? prev.provider : null,
      source,
    });
  }

  function emit(partial) {
    const ev = makeEvent({ seq: state.seq, ...partial });
    state.seq += 1;
    state.events.push(ev);
    return ev;
  }

  function warn(code, message, extra) {
    state.warnings.push(warning(code, message, extra));
  }

  /** 无法识别的记录 → unknown 事件 + warning（降级必须显式）。 */
  function unknown(name, text, detail, code, message) {
    warn(code, message, { name: name === null ? null : String(name), ...(detail || {}) });
    return emit({ kind: 'unknown', name: name === null ? null : String(name), text, detail });
  }

  /** 工具名：function_call 带 namespace（如 mcp__node_repl）时拼成 `namespace/name`。 */
  function toolNameOf(p) {
    const name = typeof p.name === 'string' && p.name.length > 0 ? p.name : null;
    const ns = typeof p.namespace === 'string' && p.namespace.length > 0 ? p.namespace : null;
    if (ns && name) return `${ns}/${name}`;
    return name || ns || null;
  }

  /** 工具调用：custom_tool_call（DSL）/ function_call（JSON 参数）/ 其它 *_call。 */
  function emitToolCall(p, ts, raw, source) {
    const callId = typeof p.call_id === 'string' ? p.call_id : typeof p.id === 'string' ? p.id : null;
    const name = toolNameOf(p) || (typeof p.type === 'string' ? p.type : 'tool_call');
    const argsText = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : null;
    const cmd = extractCmdText(argsText);
    const detail = {
      source,
      callId,
      status: statusOf(p.status),
      argumentsKind: typeof p.arguments === 'string' ? 'json' : typeof p.input === 'string' ? 'dsl' : null,
    };
    if (cmd) putText(detail, 'command', cmd, 400);
    putText(detail, 'input', argsText);
    if (callId) state.callNames.set(callId, name);
    emit({ ts, raw, kind: 'tool_call', name, text: cmd ? cap(cmd, 300).text : null, detail });
    return { callId, name };
  }

  /** 工具输出文本：string | [{text}] | {content:[{text}]} | payload.result。 */
  function outputTextOf(p) {
    if (typeof p.output === 'string') return p.output;
    const joined = joinTexts(p.output);
    if (joined !== null) return joined;
    if (p.output && typeof p.output === 'object') {
      const inner = joinTexts(p.output.content);
      if (inner !== null) return inner;
    }
    if (typeof p.result === 'string') return p.result;
    const rJoined = joinTexts(p.result);
    if (rJoined !== null) return rJoined;
    if (p.result && typeof p.result === 'object') return joinTexts(p.result.content);
    return null;
  }

  /** 工具结果：状态由退出码 / status 字段判定；名字尽量从本次调用里带上来的 callId 反查。 */
  function emitToolResult(p, ts, raw, source, extra = {}) {
    const callId = typeof p.call_id === 'string' ? p.call_id : typeof p.id === 'string' ? p.id : null;
    const name = (callId ? state.callNames.get(callId) : null) || toolNameOf(p) || extra.name || null;
    const text = outputTextOf(p);
    const judged = resultStatus(text, p.status);
    const detail = { source, callId, status: judged.status, ...(extra.detail || {}) };
    if (judged.exitCode !== null) detail.exitCode = judged.exitCode;
    if (text === null) detail.outputMissing = true;
    const out = primaryText(detail, text, MAX_TEXT);
    emit({ ts, raw, kind: 'tool_result', name, status: judged.status, text: out, detail });
  }

  /** response_item 分派。 */
  function mapResponseItem(p, ts, raw) {
    const sub = typeof p.type === 'string' ? p.type : null;
    if (sub === null) {
      return unknown(null, null, { source: 'response_item' }, 'missing_type', 'response_item 缺少 payload.type，无法识别');
    }

    if (sub === 'message') {
      const role = typeof p.role === 'string' ? p.role : 'unknown';
      const detail = {
        source: 'response_item/message',
        role,
        itemId: typeof p.id === 'string' ? p.id : null,
        phase: typeof p.phase === 'string' ? p.phase : null,
        contentTypes: contentKinds(p.content),
      };
      const text = joinTexts(p.content);
      if (role === 'assistant') {
        emit({ ts, raw, kind: 'text', name: 'assistant', text: primaryText(detail, text, MAX_TEXT), detail });
        return;
      }
      if (role === 'user') {
        // 响应流优先：同内容的 event_msg/item_completed(UserMessage) 会在 mapItem 里按指纹跳过
        emit({ ts, raw, kind: 'notice', name: 'user_message', text: primaryText(detail, text, MAX_TEXT), detail });
        return;
      }
      if (role === 'developer' || role === 'system') {
        emit({ ts, raw, kind: 'notice', name: `${role}_message`, text: primaryText(detail, text, 2000), detail });
        return;
      }
      if (role === 'tool') {
        if (text === null) detail.outputMissing = true;
        emit({ ts, raw, kind: 'tool_result', name: null, text: primaryText(detail, text, MAX_TEXT), detail });
        return;
      }
      return unknown(role, null, { source: 'response_item/message', role }, 'unknown_message_role', `未识别的消息角色：${role}`);
    }

    if (sub === 'reasoning') {
      const itemId = typeof p.id === 'string' ? p.id : null;
      const detail = {
        source: 'response_item/reasoning',
        itemId,
        encrypted: typeof p.encrypted_content === 'string' && p.encrypted_content.length > 0,
        summaryCount: Array.isArray(p.summary) ? p.summary.length : 0,
      };
      // 多数版本 response_item/reasoning 只有加密内容，可读摘要在 item_completed(Reasoning) 上
      let text = joinTexts(p.summary) || joinTexts(p.content);
      if (text === null && itemId !== null) {
        const fromItem = probe.reasoningTextById.get(itemId);
        if (fromItem !== undefined) {
          text = fromItem;
          detail.summaryFrom = 'item_completed';
        }
      }
      emit({ ts, raw, kind: 'think', name: 'reasoning', text: primaryText(detail, text, MAX_TEXT), detail });
      return;
    }

    if (sub === 'custom_tool_call' || sub === 'function_call' || /_call$/.test(sub)) {
      emitToolCall(p, ts, raw, `response_item/${sub}`);
      return;
    }

    if (
      sub === 'custom_tool_call_output' ||
      sub === 'function_call_output' ||
      sub === 'tool_search_output' ||
      /_output$/.test(sub) ||
      /_result$/.test(sub)
    ) {
      const extraDetail = sub === 'tool_search_output' && Array.isArray(p.tools) ? { toolCount: p.tools.length } : null;
      emitToolResult(p, ts, raw, `response_item/${sub}`, { detail: extraDetail });
      return;
    }

    if (sub === 'web_search_call') {
      const action = p.action && typeof p.action === 'object' ? p.action : null;
      const detail = { source: 'response_item/web_search_call', status: statusOf(p.status) };
      if (action) {
        detail.actionType = typeof action.type === 'string' ? action.type : null;
        putText(detail, 'url', typeof action.url === 'string' ? action.url : null, 300);
        putText(detail, 'query', typeof action.query === 'string' ? action.query : null, 300);
      }
      const summary = action && (action.query || action.url) ? String(action.query || action.url) : null;
      emit({ ts, raw, kind: 'tool_call', name: 'web_search', text: summary === null ? null : cap(summary, 300).text, detail });
      return;
    }

    if (sub === 'image_generation_call') {
      const detail = {
        source: 'response_item/image_generation_call',
        itemId: typeof p.id === 'string' ? p.id : null,
        status: statusOf(p.status),
      };
      const text = primaryText(detail, typeof p.revised_prompt === 'string' ? p.revised_prompt : null, MAX_TEXT);
      emit({ ts, raw, kind: 'tool_call', name: 'image_generation', status: statusOf(p.status), text, detail });
      return;
    }

    if (sub === 'agent_message') {
      const detail = { source: 'response_item/agent_message', author: p.author || null, recipient: p.recipient || null };
      emit({ ts, raw, kind: 'notice', name: 'agent_message', text: primaryText(detail, joinTexts(p.content), MAX_TEXT), detail });
      return;
    }

    if (sub === 'compaction') {
      emit({
        ts,
        raw,
        kind: 'notice',
        name: 'compaction',
        text: null,
        detail: {
          source: 'response_item/compaction',
          encrypted: typeof p.encrypted_content === 'string',
          itemId: typeof p.id === 'string' ? p.id : null,
        },
      });
      return;
    }

    unknown(sub, null, { source: 'response_item' }, 'unknown_response_item', `未识别的 response_item 类型：${sub}`);
  }

  /* ---------------------------- event_msg ------------------------------ */

  /** item_completed 分派。 */
  function mapItem(item, ts, raw) {
    const itemType = typeof item.type === 'string' ? item.type : null;
    if (itemType === null) {
      return unknown(null, null, { source: 'event_msg/item_completed' }, 'missing_type', 'item_completed 的 item 缺少 type');
    }
    const id = typeof item.id === 'string' ? item.id : null;
    const isTwin = id !== null && probe.riIds.has(id);

    if (itemType === 'UserMessage') {
      const text = joinTexts(item.content) || (typeof item.text === 'string' ? item.text : null);
      if (probe.userFp.has(fpOf(text))) return; // response_item/message(user) 已覆盖
      const detail = { source: 'event_msg/item_completed/UserMessage', itemId: id };
      emit({ ts, raw, kind: 'notice', name: 'user_message', text: primaryText(detail, text, MAX_TEXT), detail });
      return;
    }

    if (itemType === 'AgentMessage') {
      if (isTwin) return; // response_item/message(assistant) 已覆盖
      const text = joinTexts(item.content);
      if (probe.assistantFp.has(fpOf(text))) return;
      const detail = { source: 'event_msg/item_completed/AgentMessage', itemId: id, phase: item.phase || null };
      emit({ ts, raw, kind: 'text', name: 'assistant', text: primaryText(detail, text, MAX_TEXT), detail });
      return;
    }

    if (itemType === 'Reasoning') {
      if (isTwin) return; // response_item/reasoning 已覆盖（可读摘要已在上方补齐）
      const detail = { source: 'event_msg/item_completed/Reasoning', itemId: id };
      const text = primaryText(detail, joinTexts(item.summary_text) || joinTexts(item.raw_content), MAX_TEXT);
      if (text === null) detail.encryptedOnly = true;
      emit({ ts, raw, kind: 'think', name: 'reasoning', text, detail });
      return;
    }

    if (itemType === 'CommandExecution') {
      if (isTwin) return; // 旧版：item.id 就是 function_call.call_id
      const command = commandTextOf(item.command);
      if (probe.execCmdFp.has(fpOf(command))) return; // 新版 Desktop：同一次 exec 被写成两条流
      const text =
        typeof item.aggregated_output === 'string' && item.aggregated_output.length > 0 ? item.aggregated_output : item.stdout;
      const judged = resultStatus(text, item.status);
      const detail = {
        source: 'event_msg/item_completed/CommandExecution',
        callId: id,
        status: judged.status,
        processId: item.process_id || null,
        durationMs: typeof item.duration === 'number' ? item.duration : typeof item.duration_ms === 'number' ? item.duration_ms : null,
      };
      if (judged.exitCode !== null) detail.exitCode = judged.exitCode;
      putText(detail, 'command', command, 400);
      putText(detail, 'cwd', typeof item.cwd === 'string' ? item.cwd.replace(/^file:\/\//, '') : null, 300);
      putText(detail, 'stderr', typeof item.stderr === 'string' && item.stderr.length > 0 ? item.stderr : null, 500);
      emit({ ts, raw, kind: 'tool_result', name: 'exec', status: judged.status, text: primaryText(detail, text, MAX_TEXT), detail });
      return;
    }

    if (itemType === 'McpToolCall') {
      if (isTwin) return; // response_item 里已有该调用的 call + output
      const name = [item.server, item.tool].filter((v) => typeof v === 'string' && v.length > 0).join('/') || 'mcp_tool';
      const detail = {
        source: 'event_msg/item_completed/McpToolCall',
        callId: id,
        status: statusOf(item.status),
        durationMs: typeof item.duration === 'number' ? item.duration : null,
      };
      putText(detail, 'arguments', item.arguments === undefined ? null : JSON.stringify(item.arguments));
      emit({ ts, raw, kind: 'tool_call', name, text: null, detail });
      const resultText = typeof item.result === 'string' ? item.result : item.result === undefined || item.result === null ? null : JSON.stringify(item.result);
      if (resultText !== null) {
        const rDetail = { source: 'event_msg/item_completed/McpToolCall', callId: id, status: statusOf(item.status), pairedCall: true };
        emit({
          ts,
          raw,
          kind: 'tool_result',
          name,
          status: statusOf(item.status),
          text: primaryText(rDetail, resultText, MAX_TEXT),
          detail: rDetail,
        });
      }
      return;
    }

    if (itemType === 'FileChange') {
      if (isTwin) return; // apply_patch 的 custom_tool_call/output 已覆盖
      const changes = item.changes && typeof item.changes === 'object' ? item.changes : {};
      const files = [];
      for (const [file, meta] of Object.entries(changes)) {
        files.push({
          path: cap(String(file), 300).text,
          changeType: meta && typeof meta.type === 'string' ? meta.type : null,
          diffLength: meta && typeof meta.unified_diff === 'string' ? meta.unified_diff.length : null,
        });
      }
      const detail = { source: 'event_msg/item_completed/FileChange', callId: id, files: files.slice(0, 50), fileCount: files.length };
      const text = files.length > 0 ? files.map((f) => `${f.changeType || 'change'}: ${f.path}`).join('\n') : null;
      emit({ ts, raw, kind: 'tool_result', name: 'file_change', status: 'ok', text: primaryText(detail, text, MAX_TEXT), detail });
      return;
    }

    if (itemType === 'FunctionCallOutput') {
      if (isTwin) return;
      const name = [item.namespace, item.name].filter((v) => typeof v === 'string' && v.length > 0).join('/') || 'function_call_output';
      const rawOutput = typeof item.output === 'string' ? item.output : joinTexts(item.output);
      const judged = resultStatus(rawOutput, item.status);
      const detail = { source: 'event_msg/item_completed/FunctionCallOutput', callId: id, status: judged.status };
      if (judged.exitCode !== null) detail.exitCode = judged.exitCode;
      emit({ ts, raw, kind: 'tool_result', name, status: judged.status, text: primaryText(detail, rawOutput, MAX_TEXT), detail });
      return;
    }

    if (itemType === 'WebSearch') {
      if (isTwin) return;
      const detail = {
        source: 'event_msg/item_completed/WebSearch',
        callId: id,
        actionType: item.action && item.action.type ? item.action.type : null,
      };
      putText(detail, 'query', typeof item.query === 'string' ? item.query : null, 300);
      emit({ ts, raw, kind: 'tool_call', name: 'web_search', text: typeof item.query === 'string' ? cap(item.query, 300).text : null, detail });
      return;
    }

    if (itemType === 'SubAgentActivity') {
      if (isTwin) return;
      emit({
        ts,
        raw,
        kind: 'notice',
        name: 'subagent_activity',
        text: null,
        detail: {
          source: 'event_msg/item_completed/SubAgentActivity',
          callId: id,
          activityKind: item.kind || null,
          agentPath: item.agent_path || null,
          agentThreadId: item.agent_thread_id || null,
        },
      });
      return;
    }

    if (itemType === 'Plan') {
      const detail = { source: 'event_msg/item_completed/Plan', planId: id };
      const text = typeof item.text === 'string' ? item.text : joinTexts(item.content);
      emit({ ts, raw, kind: 'notice', name: 'plan', text: primaryText(detail, text, MAX_TEXT), detail });
      return;
    }

    if (itemType === 'Extension') {
      const detail = { source: 'event_msg/item_completed/Extension', itemId: id, extensionKind: item.kind || null, status: item.status || null };
      const prompt = typeof item.revisedPrompt === 'string' ? item.revisedPrompt : item.revised_prompt;
      putText(detail, 'revisedPrompt', typeof prompt === 'string' ? prompt : null);
      emit({ ts, raw, kind: 'notice', name: 'extension', text: null, detail });
      return;
    }

    if (itemType === 'ImageView') {
      emit({
        ts,
        raw,
        kind: 'notice',
        name: 'image_view',
        text: null,
        detail: {
          source: 'event_msg/item_completed/ImageView',
          itemId: id,
          imagePath: typeof item.path === 'string' ? item.path.replace(/^file:\/\//, '') : null,
        },
      });
      return;
    }

    if (itemType === 'ContextCompaction') {
      emit({ ts, raw, kind: 'notice', name: 'context_compaction', text: null, detail: { source: 'event_msg/item_completed/ContextCompaction', itemId: id } });
      return;
    }

    unknown(itemType, null, { source: 'event_msg/item_completed', itemId: id }, 'unknown_item_type', `未识别的 item_completed 类型：${itemType}`);
  }

  /** event_msg 分派。 */
  function mapEventMsg(p, ts, raw) {
    const sub = typeof p.type === 'string' ? p.type : null;
    if (sub === null) {
      return unknown(null, null, { source: 'event_msg' }, 'missing_type', 'event_msg 缺少 payload.type');
    }

    if (sub === 'item_completed') {
      if (!p.item || typeof p.item !== 'object') {
        return unknown(null, null, { source: 'event_msg/item_completed' }, 'malformed_record', 'item_completed 缺少 item 对象');
      }
      mapItem(p.item, ts, raw);
      return;
    }

    if (sub === 'task_started') {
      emit({
        ts,
        raw,
        kind: 'step',
        name: 'turn',
        text: null,
        detail: {
          source: 'event_msg/task_started',
          phase: 'begin',
          turnId: p.turn_id || null,
          modelContextWindow: p.model_context_window || null,
          collaborationMode: p.collaboration_mode_kind || null,
        },
      });
      return;
    }

    if (sub === 'task_complete') {
      const hasError = p.error !== undefined && p.error !== null;
      const detail = {
        source: 'event_msg/task_complete',
        phase: 'end',
        turnId: p.turn_id || null,
        durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : null,
        timeToFirstTokenMs: typeof p.time_to_first_token_ms === 'number' ? p.time_to_first_token_ms : null,
      };
      if (hasError) putText(detail, 'error', typeof p.error === 'string' ? p.error : JSON.stringify(p.error), 500);
      const status = hasError ? 'error' : 'ok';
      emit({
        ts,
        raw,
        kind: 'step',
        name: 'turn',
        status,
        text: primaryText(detail, typeof p.last_agent_message === 'string' ? p.last_agent_message : null, MAX_TEXT),
        detail,
      });
      return;
    }

    if (sub === 'turn_aborted') {
      const detail = {
        source: 'event_msg/turn_aborted',
        phase: 'end',
        turnId: p.turn_id || null,
        aborted: true,
        durationMs: typeof p.duration_ms === 'number' ? p.duration_ms : null,
      };
      putText(detail, 'reason', typeof p.reason === 'string' ? p.reason : null, 300);
      emit({ ts, raw, kind: 'step', name: 'turn', status: 'error', text: null, detail });
      return;
    }

    if (sub === 'token_count') {
      const info = p.info && typeof p.info === 'object' ? p.info : {};
      const usage = info.last_token_usage && typeof info.last_token_usage === 'object' ? info.last_token_usage : info.total_token_usage || {};
      const total = num(usage.total_tokens);
      const input = num(usage.input_tokens);
      const output = num(usage.output_tokens);
      const fp = usageFingerprint(input, output, total);
      if (fp !== null && state.usageFp.has(fp)) return; // 与 token_usage_record 数值相同，只留一条
      if (fp !== null) state.usageFp.add(fp);
      const window = num(info.model_context_window);
      const detail = {
        source: 'event_msg/token_count',
        inputTokens: input,
        cachedInputTokens: num(usage.cached_input_tokens),
        outputTokens: output,
        reasoningOutputTokens: num(usage.reasoning_output_tokens),
        totalTokens: total,
        modelContextWindow: window,
      };
      if (p.rate_limits && typeof p.rate_limits === 'object') {
        const rl = p.rate_limits;
        detail.rateLimits = {
          limitId: rl.limit_id === undefined ? null : rl.limit_id,
          limitName: rl.limit_name === undefined ? null : rl.limit_name,
          planType: rl.plan_type === undefined ? null : rl.plan_type,
        };
        if (rl.primary && typeof rl.primary === 'object') detail.rateLimits.primaryUsedPercent = num(rl.primary.used_percent);
        if (rl.secondary && typeof rl.secondary === 'object') detail.rateLimits.secondaryUsedPercent = num(rl.secondary.used_percent);
      }
      emit({ ts, raw, kind: 'usage', name: 'token_count', text: usageSummary(input, output, total, window), detail });
      return;
    }

    if (sub === 'thread_settings_applied' || sub === 'thread_settings') {
      const settings = p.thread_settings && typeof p.thread_settings === 'object' ? p.thread_settings : p;
      noteModel(settings.model, settings.model_provider_id, `event_msg/${sub}`);
      const mode = settings.collaboration_mode && typeof settings.collaboration_mode === 'object' ? settings.collaboration_mode : null;
      const modeSettings = mode && mode.settings && typeof mode.settings === 'object' ? mode.settings : null;
      const detail = {
        source: `event_msg/${sub}`,
        model: settings.model === undefined ? null : settings.model,
        modelProviderId: settings.model_provider_id === undefined ? null : settings.model_provider_id,
        reasoningEffort: modeSettings ? modeSettings.reasoning_effort : null,
        approvalPolicy: settings.approval_policy === undefined ? null : settings.approval_policy,
        serviceTier: settings.service_tier === undefined ? null : settings.service_tier,
        personality: settings.personality === undefined ? null : settings.personality,
        reasoningSummary: settings.reasoning_summary === undefined ? null : settings.reasoning_summary,
      };
      // 不落 collaboration_mode.settings.developer_instructions（体积大且与事件无关）
      putText(detail, 'cwd', typeof settings.cwd === 'string' ? settings.cwd : null, 300);
      if (modeSettings && modeSettings.developer_instructions !== null && modeSettings.developer_instructions !== undefined) {
        detail.developerInstructionsChars =
          typeof modeSettings.developer_instructions === 'string' ? modeSettings.developer_instructions.length : null;
      }
      emit({ ts, raw, kind: 'notice', name: 'thread_settings', text: null, detail });
      return;
    }

    if (sub === 'thread_goal_updated') {
      const goal = p.goal && typeof p.goal === 'object' ? p.goal : {};
      const detail = {
        source: 'event_msg/thread_goal_updated',
        threadId: p.threadId || p.thread_id || null,
        turnId: p.turnId || p.turn_id || null,
        goalStatus: goal.status === undefined ? null : goal.status,
        tokensUsed: num(goal.tokensUsed),
        timeUsedSeconds: num(goal.timeUsedSeconds),
      };
      emit({
        ts,
        raw,
        kind: 'notice',
        name: 'thread_goal',
        text: primaryText(detail, typeof goal.objective === 'string' ? goal.objective : null, MAX_TEXT),
        detail,
      });
      return;
    }

    unknown(sub, null, { source: 'event_msg' }, 'unknown_event_type', `未识别的 event_msg 类型：${sub}`);
  }

  /** 顶层分派。 */
  function mapRecord(record) {
    const type = typeof record.type === 'string' ? record.type : null;
    const ts = record.timestamp === undefined ? null : record.timestamp;
    const raw = compactRaw(record);
    const p = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload) ? record.payload : null;

    if (type === null) {
      return unknown(null, null, { source: 'raw_line' }, 'missing_type', '记录缺少顶层 type');
    }

    if (type === 'session_meta') {
      if (p === null) return unknown(type, null, { source: type }, 'malformed_record', 'session_meta 缺少 payload 对象');
      const base = p.base_instructions;
      const baseChars =
        typeof base === 'string' ? base.length : base && typeof base.text === 'string' ? base.text.length : 0;
      const cliVersion = typeof p.cli_version === 'string' ? p.cli_version : null;
      if (cliVersion !== null) state.formatVersion = cliVersion;
      emit({
        ts,
        raw,
        kind: 'meta',
        name: 'session',
        text: typeof p.cwd === 'string' ? p.cwd : null,
        detail: {
          source: 'session_meta',
          sessionId: typeof p.session_id === 'string' ? p.session_id : typeof p.id === 'string' ? p.id : null,
          cwd: typeof p.cwd === 'string' ? p.cwd : null,
          originator: p.originator === undefined ? null : p.originator,
          cliVersion,
          sourceKind: p.source === undefined ? null : p.source,
          threadSource: p.thread_source === undefined ? null : p.thread_source,
          modelProvider: p.model_provider === undefined ? null : p.model_provider,
          baseInstructionsChars: baseChars, // 只记长度，正文不入事件
        },
      });
      return;
    }

    if (type === 'response_item') {
      if (p === null) return unknown(type, null, { source: type }, 'malformed_record', 'response_item 缺少 payload 对象');
      return mapResponseItem(p, ts, raw);
    }

    if (type === 'event_msg') {
      if (p === null) return unknown(type, null, { source: type }, 'malformed_record', 'event_msg 缺少 payload 对象');
      return mapEventMsg(p, ts, raw);
    }

    if (type === 'token_usage_record') {
      if (p === null) return unknown(type, null, { source: type }, 'malformed_record', 'token_usage_record 缺少 payload 对象');
      const usage = p.usage && typeof p.usage === 'object' ? p.usage : {};
      const fp = usageFingerprint(num(usage.input_tokens), num(usage.output_tokens), num(usage.total_tokens));
      if (fp !== null && state.usageFp.has(fp)) return;
      if (fp !== null) state.usageFp.add(fp);
      const detail = {
        source: 'token_usage_record',
        turnId: p.turn_id || null,
        responseId: p.response_id || null,
        inputTokens: num(usage.input_tokens),
        cachedInputTokens: num(usage.cached_input_tokens),
        outputTokens: num(usage.output_tokens),
        reasoningOutputTokens: num(usage.reasoning_output_tokens),
        totalTokens: num(usage.total_tokens),
      };
      emit({
        ts,
        raw,
        kind: 'usage',
        name: 'response_usage',
        text: usageSummary(detail.inputTokens, detail.outputTokens, detail.totalTokens, null),
        detail,
      });
      return;
    }

    if (type === 'turn_context') {
      if (p === null) return unknown(type, null, { source: type }, 'malformed_record', 'turn_context 缺少 payload 对象');
      noteModel(p.model, null, 'turn_context');
      const sandbox = p.sandbox_policy && typeof p.sandbox_policy === 'object' ? p.sandbox_policy : null;
      const mode = p.collaboration_mode && typeof p.collaboration_mode === 'object' ? p.collaboration_mode : null;
      const modeSettings = mode && mode.settings && typeof mode.settings === 'object' ? mode.settings : null;
      const detail = {
        source: 'turn_context',
        turnId: p.turn_id || null,
        model: p.model === undefined ? null : p.model,
        approvalPolicy: p.approval_policy === undefined ? null : p.approval_policy,
        sandboxType: sandbox && sandbox.type !== undefined ? sandbox.type : null,
        timezone: p.timezone === undefined ? null : p.timezone,
        currentDate: p.current_date === undefined ? null : p.current_date,
        reasoningEffort: modeSettings ? modeSettings.reasoning_effort : null,
      };
      if (Array.isArray(p.workspace_roots)) detail.workspaceRoots = p.workspace_roots.slice(0, 5).map((r) => cap(String(r), 200).text);
      putText(detail, 'cwd', typeof p.cwd === 'string' ? p.cwd : null, 300);
      emit({ ts, raw, kind: 'notice', name: 'turn_context', text: null, detail });
      return;
    }

    if (type === 'world_state') {
      if (p === null) return unknown(type, null, { source: type }, 'malformed_record', 'world_state 缺少 payload 对象');
      const st = p.state && typeof p.state === 'object' ? p.state : {};
      const agentsMd = st.agents_md && typeof st.agents_md === 'object' ? st.agents_md : null;
      const envs = st.environments && typeof st.environments === 'object' ? st.environments.environments : null;
      const local = envs && typeof envs === 'object' && envs.local && typeof envs.local === 'object' ? envs.local : null;
      const detail = {
        source: 'world_state',
        full: p.full === undefined ? null : p.full,
        timezone: st.timezone === undefined ? null : st.timezone,
        currentDate: st.current_date === undefined ? null : st.current_date,
        hasAgentsMd: agentsMd !== null && typeof agentsMd.text === 'string' && agentsMd.text.length > 0,
        agentsMdChars: agentsMd !== null && typeof agentsMd.text === 'string' ? agentsMd.text.length : 0,
      };
      putText(detail, 'cwd', local && typeof local.cwd === 'string' ? local.cwd : agentsMd && typeof agentsMd.directory === 'string' ? agentsMd.directory : null, 300);
      emit({ ts, raw, kind: 'notice', name: 'world_state', text: null, detail });
      return;
    }

    if (type === 'compacted') {
      if (p === null) return unknown(type, null, { source: type }, 'malformed_record', 'compacted 缺少 payload 对象');
      const message = typeof p.message === 'string' ? p.message : typeof p.summary === 'string' ? p.summary : null;
      const detail = { source: 'compacted', messageChars: typeof message === 'string' ? message.length : 0 };
      emit({ ts, raw, kind: 'notice', name: 'compacted', text: primaryText(detail, message, MAX_TEXT), detail });
      return;
    }

    if (type === 'inter_agent_communication_metadata') {
      emit({
        ts,
        raw,
        kind: 'notice',
        name: 'inter_agent_meta',
        text: null,
        detail: { source: type, triggerTurn: p === null ? null : p.trigger_turn === undefined ? null : p.trigger_turn },
      });
      return;
    }

    unknown(type, null, { source: 'raw_line' }, 'unknown_top_type', `未识别的顶层记录类型：${type}`);
  }

  return { state, mapRecord };
}

/* ---------------------------- 数值与用量工具 ----------------------------- */

/** 数值字段容错：非有限数返回 null。 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 用量去重指纹：token_usage_record 与 event_msg/token_count 是同一份用量的两种落盘形式
 * （数值实测一致），按 token 数值去重；同一批次内数值完全相同的用量只保留先出现的一条。
 */
function usageFingerprint(input, output, total) {
  if (input === null && output === null && total === null) return null;
  return `${input}|${output}|${total}`;
}

/** 用量事件的人类可读摘要。 */
function usageSummary(input, output, total, window) {
  const parts = [];
  if (input !== null) parts.push(`输入 ${input}`);
  if (output !== null) parts.push(`输出 ${output}`);
  if (total !== null) parts.push(`合计 ${total}`);
  if (parts.length === 0) return window === null ? null : `上下文窗口 ${window}`;
  const head = `tokens ${parts.join(' / ')}`;
  if (total !== null && window !== null && window > 0) {
    return `${head}（上下文 ${Math.round((total / window) * 1000) / 10}% / ${window}）`;
  }
  return head;
}

/* --------------------------------- 入口 ---------------------------------- */

/**
 * 读取 codex rollout.jsonl 并归一化为统一事件。
 *
 * @param {{adapter?: string, kind?: string, path: string, id?: string}} ref 会话引用（core/mapping.js 产出，kind='file'）
 * @param {{cursor?: string|number|null, maxLines?: number}} [options]
 *        cursor = 已消费字节数（null/缺省表示从头；尾部半行不消费、不推进）；maxLines 覆盖单次行数上限
 * @returns {{events: object[], nextCursor: string, meta: object}}
 */
function readEvents(ref, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const maxLines = Number.isInteger(opts.maxLines) && opts.maxLines > 0 ? opts.maxLines : MAX_LINES_PER_CALL;
  const warnings = [];
  const filePath = ref && typeof ref.path === 'string' && ref.path.length > 0 ? ref.path : null;
  if (filePath === null) {
    warnings.push(warning('invalid_ref', '会话引用缺少 path 字段，无法读取 codex rollout 文件'));
    return makeReadResult([], { nextCursor: null, adapter: ADAPTER, formatVersion: null, warnings });
  }

  let offset = 0;
  if (opts.cursor !== undefined && opts.cursor !== null && opts.cursor !== '') {
    const parsed = Number(opts.cursor);
    if (Number.isInteger(parsed) && parsed >= 0) offset = parsed;
    else warnings.push(warning('invalid_cursor', `cursor 不是合法的字节偏移，已按从头读取处理：${String(opts.cursor)}`, { cursor: String(opts.cursor) }));
  }

  let fd;
  let events = [];
  let nextCursor = offset;
  let formatVersion = null;
  let model = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    let start = offset;
    if (start > size) {
      warnings.push(warning('cursor_beyond_eof', `cursor ${start} 超出文件大小 ${size}（文件被截断或重写），已从头读取`, { cursor: start, size }));
      start = 0;
    }

    const { buffer, truncatedLine } = readWindow(fd, start, size);
    if (truncatedLine) {
      // 单行超过硬上限：不推进 cursor，避免把半行当完整行消费
      warnings.push(warning('line_too_long', `第 ${start} 字节起存在超过 ${MAX_LINE_BYTES} 字节的超长行，本次跳过（cursor 不推进）`, { byteOffset: start }));
      nextCursor = start;
      return makeReadResult([], { nextCursor: String(nextCursor), adapter: ADAPTER, formatVersion: readCliVersion(filePath), warnings });
    }

    // 只消费以换行结尾的完整行；同时受单次行数上限约束
    const records = [];
    let pos = 0;
    let consumed = 0;
    while (pos < buffer.length) {
      const nl = buffer.indexOf(0x0a, pos);
      if (nl < 0) break; // 尾部半行：留给下次
      if (records.length >= maxLines) break; // 本次行数上限：留给下次
      const startOffset = start + pos;
      const line = buffer.subarray(pos, nl).toString('utf8').trim();
      pos = nl + 1;
      consumed = pos;
      if (line.length === 0) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        records.push({ invalid: true, line, offset: startOffset, reason: 'parse_error' });
        continue;
      }
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        records.push({ invalid: true, line, offset: startOffset, reason: 'not_object' });
        continue;
      }
      records.push({ record, offset: startOffset });
    }

    const probe = prescan(start > 0 ? readContextRecords(fd, start) : [], records);
    const mapper = createMapper(probe);
    for (const rec of records) {
      if (rec.invalid) {
        mapper.state.warnings.push(
          warning('malformed_line', `第 ${rec.offset} 字节处的行无法作为 JSON 对象解析，已降级为 unknown 事件`, {
            byteOffset: rec.offset,
            reason: rec.reason,
          })
        );
        const clipped = cap(rec.line, MAX_DETAIL_TEXT);
        mapper.state.events.push(
          makeEvent({
            seq: mapper.state.seq,
            ts: null,
            kind: 'unknown',
            name: 'invalid_json',
            text: clipped.text,
            detail: { source: 'raw_line', byteOffset: rec.offset, truncated: clipped.truncated, textLength: clipped.length },
            raw: null,
          })
        );
        mapper.state.seq += 1;
        continue;
      }
      mapper.mapRecord(rec.record);
    }

    events = mapper.state.events;
    for (const w of mapper.state.warnings) warnings.push(w);
    formatVersion = mapper.state.formatVersion;
    model = mapper.state.model;
    nextCursor = start + consumed;
  } catch (err) {
    warnings.push(warning('rollout_unreadable', `读取 rollout 文件失败：${String((err && err.message) || err)}`, { file: filePath }));
    events = [];
    nextCursor = offset;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }

  // 本次批次没有 session_meta（cursor>0）时，从文件头部窗口补 formatVersion
  if (formatVersion === null) formatVersion = readCliVersion(filePath);
  return makeReadResult(events, {
    nextCursor: String(nextCursor),
    adapter: ADAPTER,
    formatVersion,
    warnings,
    model: model,
  });
}

module.exports = { readEvents };
