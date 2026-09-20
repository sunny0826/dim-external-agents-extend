'use strict';

/**
 * opencode 适配器 —— 把 `~/.local/share/opencode/opencode.db` 归一化为统一事件流。
 *
 * ============================ 数据源（本机实测 2026-09-20） ============================
 *
 * 库：`~/.local/share/opencode/opencode.db`（本机 3.4GB / 1167 会话 / 约 17.3 万 part）。
 * 读取只碰三张表，且都走 session 维度索引（`part_session_idx`、
 * `message_session_time_created_id_idx`）——3.4GB 的库不能有任何全表扫描。
 *
 *   session(id, title, directory, agent, model, time_created, time_updated, …)
 *   message(id, session_id, time_created, time_updated, data TEXT)  -- data.role ∈ user|assistant
 *   part(id, message_id, session_id, time_created, time_updated, data TEXT)
 *
 * `data` 是 JSON 文本列。part 的 `data.type` 全量实测分布：
 *   tool 48013 / step-start 36492 / step-finish 36335 / reasoning 26388 / text 18317
 *   / patch 7317 / compaction 113 / file 110
 *
 * ============================ 与 jsonl 适配器的根本差异 ============================
 *
 * kimi / codex / grok 是**追加式**日志：新增行 = 新增事件，字节偏移即天然游标。
 * opencode 是**状态式**存储，**part 行会被原地更新**：
 *
 *   · tool part 先以 `state.status='running'` 落库，执行完再原地改写成 `'completed'` / `'error'`
 *     （实测本机某会话 74/74 个 tool part 的 time_updated ≠ time_created）；
 *   · text / reasoning 是**流式追加**的，逐块增长，不是一次写完
 *     （实测 time_updated − time_created：text 平均 3.4s / 最长 35s，reasoning 平均 5.2s / 最长 83s）。
 *
 * 因此照搬字节偏移游标是错的：按 time_created 单调推进，会让一个"先落库、后完成"的 part
 * 永远停在中间态——tool 永远显示"调用中"、文本被截断。而按 time_updated 推进又会让
 * 同一 part 被反复输出（流式文本重复）。
 *
 * ------------------------------ 稳定边界（本适配器的核心） ------------------------------
 *
 * opencode 用 step 切分回合：`step-start` … （reasoning / text / tool）… `step-finish`。
 * **一条 step-finish 落库，即表示该 step 内的 part 已全部写完**（实测 step-start /
 * step-finish 自身的 time_updated − time_created ≤ 5ms，是瞬时写入，不是流式）。
 *
 * 于是用「**最后一条 step 标记（step-start 或 step-finish）的位置**」作为稳定边界：
 *
 *   位置 ≤ 边界  → 已终态，输出完整事件；
 *   位置 > 边界  → 属于进行中的 step，本批不输出，留给下次读取。
 *
 * 取"最后一条 step 标记"而非"最后一条 step-finish"，是为了让**进行中 step 的
 * step-start 也能立刻可见**——否则运行中的任务在日志里会看起来完全停滞。
 * 代价是进行中 step 的中间输出（流式文本、正在跑的工具）要等该 step 结束才出现，
 * 这是有意取舍：**宁可滞后一个 step，也不输出随后会被改写的中间态**
 * （重复、被截断的日志比滞后的日志更难读）。
 *
 * 边界不存在时（会话还没有 step 结构）不设上界，退化为"全部输出"。
 *
 * ------------------------------ 游标语义 ------------------------------
 *
 * 游标是 (time_created, id) 复合位置，opaque JSON：
 *
 *     {"v":1,"t":<已输出最后一条 part 的 time_created>,"id":"<该 part id>"}
 *
 * opencode 的 id 是 ULID 风格（`prt_0aa54334c0019…`，前缀与创建时间同序），实测
 * (time_created, id) 排序稳定，故位置比较可直接用元组大小。因为每条 part 只在
 * 终态被输出一次，**游标天然保证不重复**；若游标位置已不在库中（会话被清理），
 * 整表重读并给 `cursor_reset`。
 *
 * ------------------------------ 事件映射 ------------------------------
 *
 *   user message 下的 text   → notice(user_message)   ← 任务 prompt
 *   assistant text           → text
 *   reasoning                → think
 *   tool（completed/error）  → tool_call + tool_result（同一 callID 配对，与 kimi/codex 一致）
 *   tool（running/pending）  → 仅 tool_call
 *   step-start               → step(phase=begin)
 *   step-finish              → step(phase=end) + usage（tokens / cost）
 *   patch                    → notice(patch)（hash + 文件列表）
 *   compaction               → notice(compaction)
 *   file                     → notice(file)（**只留 mime/filename，丢弃 base64 data URI**）
 *   其它 / 无法解析           → unknown + warning（显式降级，不静默丢数据）
 *
 * 纯空白文本（实测存在 `text:" "` 的 part）不产出事件，只计数——它们是空输出噪音。
 */

const { DatabaseSync } = require('node:sqlite');
const { toIso, makeEvent, makeReadResult, modelHint, warning } = require('../events');

const ADAPTER = 'opencode';
const FORMAT_VERSION = 'opencode-db/1';

const MAX_TEXT = 4000; // 单条事件 text 上限（超出截断并在 detail.truncated 标注）
const MAX_ARGS_TEXT = 1200; // tool_call detail.args 的 JSON 文本上限
const MAX_EVENTS_PER_CALL = 400; // 单次调用产出事件上限（超出部分留给下次）
const MAX_PART_SCAN = 5000; // 单次扫描 part 行数上限（防御异常会话）
const MAX_SUMMARY_TEXT = 160; // 一行摘要长度
const MAX_PATCH_FILES = 20; // patch 事件列出的文件数上限

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

/** 一行摘要：折叠空白 + 截断（用于 text / notice 的短标题）。 */
function oneLine(text) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length <= MAX_SUMMARY_TEXT ? flat : flat.slice(0, MAX_SUMMARY_TEXT) + '…';
}

/** 宽松解析 JSON 文本列（sqlite 里可能是对象、字符串或损坏值）。 */
function parseJsonLoose(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** part / message 的毫秒时间戳 → ISO；无效返回 null。 */
function msToIso(value) {
  return Number.isFinite(value) ? toIso(value) : null;
}

/** part 的时间：优先 `data.time.start`（工具/文本的真实起止），其次行的 time_created。 */
function partTs(data, fallbackMs) {
  const t = data && data.time;
  if (t && typeof t === 'object') {
    if (Number.isFinite(t.start)) return toIso(t.start);
    if (Number.isFinite(t.end)) return toIso(t.end);
  }
  return msToIso(fallbackMs);
}

/** 只读打开（打开成功 ≠ 可用：损坏库要到查询层才报错，调用方必须再包一层 try/catch）。 */
function openDb(dbPath) {
  try {
    return { db: new DatabaseSync(dbPath, { readOnly: true }) };
  } catch (err) {
    return { db: null, error: err };
  }
}

function closeQuietly(db) {
  if (db === undefined || db === null) return;
  try {
    db.close();
  } catch {
    /* best-effort */
  }
}

/* ------------------------------ 稳定边界 -------------------------------- */

/**
 * 最后一条 step 标记（step-start / step-finish）的位置，即本批可安全输出的上界。
 * 返回 null 表示该会话尚无 step 结构（不设上界）。
 *
 * 注：`json_extract` 无法走索引，但外层 `session_id = ?` 已把扫描收窄到单个会话
 * （实测 290 part 的会话为亚毫秒级），3.4GB 的库不会因此被全表扫描。
 */
function findBoundary(db, sessionId) {
  try {
    const row = db
      .prepare(
        `SELECT time_created, id FROM part
          WHERE session_id = ?
            AND json_extract(data, '$.type') IN ('step-start', 'step-finish')
          ORDER BY time_created DESC, id DESC
          LIMIT 1`
      )
      .get(sessionId);
    return row ? { t: row.time_created, id: row.id } : null;
  } catch {
    return null;
  }
}

/* ------------------------------ 消息与模型 ------------------------------ */

/**
 * 会话内所有 message 的 role 表 + 会话实际使用的模型。
 * message 行数远小于 part（实测同会话 67 : 290），先整表取回再在内存里关联，
 * 避免对每一行 part 都做一次 JSON 解析。
 */
function loadMessages(db, sessionId) {
  const roleById = new Map();
  let model = null;
  try {
    const rows = db
      .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id')
      .all(sessionId);
    for (const row of rows) {
      const data = parseJsonLoose(row.data);
      if (data === null) continue;
      const role = typeof data.role === 'string' ? data.role : null;
      roleById.set(row.id, role);
      if (role !== 'assistant') continue;
      if (model === null && typeof data.modelID === 'string' && data.modelID.length > 0) {
        model = modelHint(data.modelID, {
          provider: typeof data.providerID === 'string' ? data.providerID : null,
          source: 'message',
        });
      }
    }
  } catch {
    /* schema 漂移：role 关联缺失时全部按非 user 处理，由上层 warning 说明 */
  }
  return { roleById, model };
}

/**
 * 会话行（元信息 + 模型兜底）：`session.model` 形如 {"id","providerID","variant"}。
 * 返回 `{row}` / `{row: null}`（会话不存在）/ `{error}`（库或表不可查）——打开成功 ≠ 可用，
 * 损坏库、非 SQLite 文件、schema 漂移都要到查询层才暴露。
 */
function loadSession(db, sessionId) {
  try {
    const row = db
      .prepare('SELECT id, title, directory, parent_id, agent, model, time_created FROM session WHERE id = ?')
      .get(sessionId);
    return { row: row === undefined ? null : row };
  } catch (err) {
    return { error: err };
  }
}

/** 从 `session.model` JSON 取模型提示（message 层没拿到时的兜底）。 */
function modelFromSessionRow(row) {
  if (!row || typeof row.model !== 'string') return null;
  const parsed = parseJsonLoose(row.model);
  if (parsed === null) return null;
  const id = typeof parsed.id === 'string' ? parsed.id : typeof parsed.modelID === 'string' ? parsed.modelID : null;
  if (id === null || id.length === 0) return null;
  const provider = typeof parsed.providerID === 'string' ? parsed.providerID : null;
  return modelHint(id, { provider, source: 'session' });
}

/* ------------------------------ 事件构造 -------------------------------- */

/** tool part 的 state（缺失时给空对象，避免下游到处判空）。 */
function toolStateOf(data) {
  const state = data && data.state;
  return state && typeof state === 'object' ? state : {};
}

/** tool_call 的文本摘要：`tool: <参数一行摘要>`。 */
function toolCallText(name, args) {
  if (args === null || Object.keys(args).length === 0) return name;
  let json;
  try {
    json = JSON.stringify(args);
  } catch {
    return name;
  }
  const brief = oneLine(json);
  return brief === null ? name : `${name}: ${brief}`;
}

/** tool_call 的 detail.args：序列化后截断（write/edit 的 content 可能极大）。 */
function clipArgs(args) {
  if (args === null) return null;
  let json;
  try {
    json = JSON.stringify(args);
  } catch {
    return { unserializable: true };
  }
  if (json.length <= MAX_ARGS_TEXT) return args;
  return { truncated: true, originalLength: json.length, preview: json.slice(0, MAX_ARGS_TEXT) };
}

/** 把一条 part 转成 0–2 个事件。fallbackMs 是行上的 time_created（data 里没有 time 时用）。 */
function partEvents(part, role, fallbackMs, ctx) {
  const out = [];
  const data = parseJsonLoose(part.data);
  if (data === null) {
    ctx.unknownParts.add('unparsable');
    out.push(
      makeEvent({
        kind: 'unknown',
        ts: msToIso(fallbackMs),
        detail: { partId: part.id, reason: 'unparsable_data' },
        raw: { preview: String(part.data).slice(0, 200) },
      })
    );
    return out;
  }

  const type = typeof data.type === 'string' ? data.type : null;
  const ts = partTs(data, fallbackMs);
  const detail = { partId: part.id };

  switch (type) {
    case 'text': {
      const text = typeof data.text === 'string' ? data.text : '';
      if (text.trim().length === 0) {
        ctx.emptyText += 1; // 实测存在 text:" " 的空输出 part：不产事件，只计数
        return out;
      }
      const clipped = capText(text, detail);
      if (role === 'user') {
        out.push(
          makeEvent({
            kind: 'notice',
            ts,
            name: 'user_message',
            text: clipped,
            detail: { ...detail, role: 'user' },
          })
        );
      } else {
        out.push(makeEvent({ kind: 'text', ts, name: role === 'assistant' ? 'assistant' : role, text: clipped, detail }));
      }
      return out;
    }

    case 'reasoning': {
      const text = typeof data.text === 'string' ? data.text : '';
      if (text.trim().length === 0) {
        ctx.emptyText += 1;
        return out;
      }
      out.push(makeEvent({ kind: 'think', ts, name: 'reasoning', text: capText(text, detail), detail }));
      return out;
    }

    case 'tool': {
      const name = typeof data.tool === 'string' && data.tool.length > 0 ? data.tool : 'tool';
      const callId = typeof data.callID === 'string' ? data.callID : null;
      const state = toolStateOf(data);
      const status = typeof state.status === 'string' ? state.status : null;
      const args = state.input && typeof state.input === 'object' ? state.input : null;
      const startedAt = msToIso(state.time && state.time.start) || ts;
      const endedAt = msToIso(state.time && state.time.end);

      out.push(
        makeEvent({
          kind: 'tool_call',
          ts: startedAt,
          name,
          text: toolCallText(name, args),
          detail: { ...detail, toolCallId: callId, args: clipArgs(args) },
        })
      );

      // running / pending 的调用尚无结果：只给 tool_call，等该 step 结束后的批次再给结果。
      if (status === 'completed' || status === 'error') {
        const resultDetail = { ...detail, toolCallId: callId, nameResolved: true };
        const body =
          status === 'error'
            ? typeof state.error === 'string'
              ? state.error
              : 'tool failed'
            : typeof state.output === 'string'
              ? state.output
              : state.output === undefined || state.output === null
                ? null
                : JSON.stringify(state.output);
        out.push(
          makeEvent({
            kind: 'tool_result',
            ts: endedAt || ts,
            name,
            status: status === 'error' ? 'error' : 'ok',
            text: capText(body, resultDetail),
            detail: resultDetail,
          })
        );
      } else {
        ctx.inFlightTools += 1;
        if (status !== null) ctx.toolStatuses.add(status);
      }
      return out;
    }

    case 'step-start':
      out.push(
        makeEvent({
          kind: 'step',
          ts,
          name: 'step.begin',
          text: 'step begin',
          detail: { ...detail, phase: 'begin', snapshot: typeof data.snapshot === 'string' ? data.snapshot : null },
        })
      );
      return out;

    case 'step-finish': {
      const reason = typeof data.reason === 'string' ? data.reason : null;
      const failed = reason === 'error' || reason === 'aborted';
      out.push(
        makeEvent({
          kind: 'step',
          ts,
          name: 'step.end',
          status: reason === null ? null : failed ? 'error' : 'ok',
          text: reason === null ? 'step end' : `step end (${reason})`,
          detail: { ...detail, phase: 'end', finishReason: reason, cost: Number.isFinite(data.cost) ? data.cost : null },
        })
      );
      const tokens = data.tokens && typeof data.tokens === 'object' ? data.tokens : null;
      if (tokens !== null) {
        const parts = [];
        if (Number.isFinite(tokens.input)) parts.push(`${tokens.input} in`);
        if (Number.isFinite(tokens.output)) parts.push(`${tokens.output} out`);
        if (Number.isFinite(tokens.reasoning)) parts.push(`${tokens.reasoning} reasoning`);
        if (Number.isFinite(data.cost)) parts.push(`$${data.cost}`);
        out.push(
          makeEvent({
            kind: 'usage',
            ts,
            name: 'usage.step',
            text: parts.length === 0 ? null : parts.join(' / '),
            detail: { ...detail, tokens, cost: Number.isFinite(data.cost) ? data.cost : null },
          })
        );
      }
      return out;
    }

    case 'patch': {
      const files = Array.isArray(data.files) ? data.files.filter((f) => typeof f === 'string') : [];
      const shown = files.slice(0, MAX_PATCH_FILES);
      out.push(
        makeEvent({
          kind: 'notice',
          ts,
          name: 'patch',
          text: shown.length === 0 ? 'patch' : shown.map((f) => f.split('/').pop()).join(', '),
          detail: {
            ...detail,
            hash: typeof data.hash === 'string' ? data.hash : null,
            files: shown,
            fileCount: files.length,
            truncated: files.length > shown.length,
          },
        })
      );
      return out;
    }

    case 'compaction':
      out.push(
        makeEvent({
          kind: 'notice',
          ts,
          name: 'compaction',
          text: data.auto === true ? 'auto compaction' : 'compaction',
          detail: { ...detail, auto: data.auto === true },
        })
      );
      return out;

    case 'file': {
      // 实测 file part 的 url 是 data URI（图片 base64，单条可达数 MB）——绝不进入事件，
      // 只保留文件名与 MIME，否则一次读取会把巨量 base64 灌进日志与 UI。
      const url = typeof data.url === 'string' ? data.url : '';
      out.push(
        makeEvent({
          kind: 'notice',
          ts,
          name: 'file',
          text: typeof data.filename === 'string' ? data.filename : 'file',
          detail: {
            ...detail,
            mime: typeof data.mime === 'string' ? data.mime : null,
            inline: url.startsWith('data:'),
            byteSize: url.startsWith('data:') ? url.length : null,
          },
        })
      );
      return out;
    }

    default:
      ctx.unknownParts.add(type === null ? '(missing)' : type);
      out.push(
        makeEvent({
          kind: 'unknown',
          ts,
          detail: { ...detail, droppedKind: type },
          raw: { preview: JSON.stringify(data).slice(0, 200) },
        })
      );
      return out;
  }
}

/* ------------------------------ 游标 ------------------------------------ */

function parseCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) return null;
  const parsed = parseJsonLoose(cursor);
  if (!parsed || !Number.isFinite(parsed.t) || typeof parsed.id !== 'string') return { invalid: true };
  return parsed;
}

function encodeCursor(t, id) {
  return JSON.stringify({ v: 1, t, id });
}

/* ------------------------------ 入口 ------------------------------------ */

/**
 * 读取 opencode 会话事件。
 * @param {{adapter?: string, kind?: string, path: string, id?: string}} ref mapping 产出的会话引用
 * @param {{cursor?: string|null, maxEvents?: number}} [options]
 */
function readEvents(ref, options = {}) {
  const warnings = [];
  const stop = (events = [], nextCursor = null, model = null) =>
    makeReadResult(events, {
      nextCursor,
      adapter: ADAPTER,
      formatVersion: FORMAT_VERSION,
      warnings,
      model,
    });

  if (!ref || typeof ref.path !== 'string' || ref.path.length === 0) {
    warnings.push(warning('bad_ref', '会话引用缺少 path（mapping 输出异常）'));
    return stop();
  }
  const sessionId = typeof ref.id === 'string' && ref.id.length > 0 ? ref.id : null;
  if (sessionId === null) {
    warnings.push(warning('bad_ref', '会话引用缺少 id（opencode 会话 id）'));
    return stop();
  }
  const dbPath = ref.path;

  const opened = openDb(dbPath);
  if (opened.db === null) {
    warnings.push(
      warning('db_open_failed', `无法以只读方式打开 ${dbPath}：${String((opened.error && opened.error.message) || opened.error)}`)
    );
    return stop();
  }
  const db = opened.db;

  try {
    const sessionLoad = loadSession(db, sessionId);
    if (sessionLoad.error !== undefined) {
      warnings.push(
        warning(
          'db_unreadable',
          `读取 ${dbPath} 失败：${String((sessionLoad.error && sessionLoad.error.message) || sessionLoad.error)}`
        )
      );
      return stop();
    }
    if (sessionLoad.row === null) {
      warnings.push(warning('session_not_found', `opencode 库中不存在会话 ${sessionId}（可能已被清理）`));
      return stop();
    }
    const sessionRow = sessionLoad.row;

    const { roleById, model: messageModel } = loadMessages(db, sessionId);
    const model = messageModel || modelFromSessionRow(sessionRow);

    const parsed = parseCursor(options.cursor);
    let cursorT = null;
    let cursorId = null;
    if (parsed && parsed.invalid) {
      warnings.push(
        warning('cursor_invalid', 'cursor 不是本适配器产出的 opaque 值，已忽略并按整表读取', {
          cursor: String(options.cursor).slice(0, 120),
        })
      );
    } else if (parsed) {
      cursorT = parsed.t;
      cursorId = parsed.id;
    }
    const isFirstBatch = cursorT === null;

    const boundary = findBoundary(db, sessionId);

    let sql =
      'SELECT id, message_id, time_created, data FROM part WHERE session_id = ?';
    const params = [sessionId];
    if (cursorT !== null) {
      sql += ' AND (time_created > ? OR (time_created = ? AND id > ?))';
      params.push(cursorT, cursorT, cursorId);
    }
    if (boundary !== null) {
      sql += ' AND (time_created < ? OR (time_created = ? AND id <= ?))';
      params.push(boundary.t, boundary.t, boundary.id);
    }
    sql += ' ORDER BY time_created, id LIMIT ?';
    params.push(MAX_PART_SCAN);

    const rows = db.prepare(sql).all(...params);
    if (rows.length >= MAX_PART_SCAN) {
      warnings.push(
        warning('scan_truncated', `本批扫描达到 ${MAX_PART_SCAN} 条 part 上限，其余留给下次读取`, {
          scanned: rows.length,
        })
      );
    }

    const maxEvents = Number.isInteger(options.maxEvents) && options.maxEvents > 0 ? options.maxEvents : MAX_EVENTS_PER_CALL;
    const ctx = { unknownParts: new Set(), toolStatuses: new Set(), emptyText: 0, inFlightTools: 0, counts: {} };

    const events = [];
    let lastT = null;
    let lastId = null;
    for (const row of rows) {
      const data = parseJsonLoose(row.data);
      const type = data && typeof data.type === 'string' ? data.type : '(unparsable)';
      ctx.counts[type] = (ctx.counts[type] || 0) + 1;

      const role = roleById.has(row.message_id) ? roleById.get(row.message_id) : null;
      for (const ev of partEvents(row, role, row.time_created, ctx)) events.push(ev);

      lastT = row.time_created;
      lastId = row.id;
      if (events.length >= maxEvents) break;
    }

    if (ctx.unknownParts.size > 0) {
      warnings.push(
        warning('unknown_part_type', `出现未识别的 part 类型：${[...ctx.unknownParts].join(', ')}`, {
          parts: [...ctx.unknownParts],
        })
      );
    }
    if (ctx.inFlightTools > 0) {
      warnings.push(
        warning('tool_in_flight', `${ctx.inFlightTools} 个工具调用尚无结果（进行中的 step 不输出中间态）`, {
          count: ctx.inFlightTools,
          statuses: [...ctx.toolStatuses],
        })
      );
    }

    // 元信息事件只在首次读取时给出（增量批次不重复）。
    if (isFirstBatch) {
      events.unshift(
        makeEvent({
          kind: 'meta',
          name: 'metadata',
          ts: msToIso(sessionRow.time_created),
          text: typeof sessionRow.title === 'string' ? sessionRow.title : null,
          detail: {
            adapter: ADAPTER,
            formatVersion: FORMAT_VERSION,
            sessionId,
            title: typeof sessionRow.title === 'string' ? sessionRow.title : null,
            cwd: typeof sessionRow.directory === 'string' ? sessionRow.directory : null,
            agent: typeof sessionRow.agent === 'string' ? sessionRow.agent : null,
            subagent: sessionRow.parent_id !== null && sessionRow.parent_id !== undefined,
            messageCount: roleById.size,
            counts: ctx.counts,
            // 实测存在 `text:" "` 的空白占位 part（本机某会话 51 个 text part 里 27 个空白，
            // reasoning 也有同形态），它们不产事件、只计数——显式给出，
            // 免得排查时把"part 数 > 事件数"误判成丢数据。
            // 注意：这是**首批扫描范围内**的计数（增量批次不重复 meta）。
            emptyTextParts: ctx.emptyText,
          },
        })
      );
    }

    // seq = 本批次内 0..n-1；全局定位用 (time_created, id)，见游标说明。
    events.forEach((ev, i) => {
      ev.seq = i;
    });

    // 有输出 → 游标指向最后一条已输出的 part；本批无新内容 → 保持原游标，让调用方继续轮询
    // （后续 step 结束时稳定边界推进会带来新事件）。
    // 首次读取且尚无内容（会话刚创建 / 进行中的 step 还没结束）→ 给"从头开始"的游标而不是 null，
    // 否则调用方会判定"已读尽"而停止轮询，运行中的任务将永远看不到后续输出。
    let nextCursor;
    if (lastId !== null) nextCursor = encodeCursor(lastT, lastId);
    else if (parsed && !parsed.invalid) nextCursor = options.cursor;
    else nextCursor = encodeCursor(0, '');

    return stop(events, nextCursor, model);
  } catch (err) {
    warnings.push(warning('db_unreadable', `读取 ${dbPath} 失败：${String((err && err.message) || err)}`));
    return stop();
  } finally {
    closeQuietly(db);
  }
}

module.exports = { readEvents, FORMAT_VERSION };
