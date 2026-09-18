'use strict';

/**
 * cursor 适配器（T1.4）——把 `~/.cursor/acp-sessions/<uuid>/store.db` 归一化为统一事件流。
 *
 * ========================= 顺序恢复调查结论（T1.4 第一步） =========================
 *
 * 结论：**顺序可恢复，正常路径无需降级**。恢复来源 = 快照 blob 的 protobuf 字段 #1。
 *
 * 数据结构（本机 113 个会话目录全量实测，2026-09-17）：
 *
 * 1. `blobs(id TEXT PRIMARY KEY, data BLOB)` 是内容寻址存储：id 即 data 的 sha256
 *    （样本：id `b2a1ae2d…` 正是其 JSON 消息的 hash；同一 32 字节串又以二进制字段形式
 *    出现在其它 blob 中）。
 * 2. `meta` 表只有 1 行（key='0'），value 是 **hex 编码的 JSON**：
 *    `{ agentId, latestRootBlobId, name, mode, isRunEverything, createdAt, blobEncryptionKey }`
 * 3. `latestRootBlobId` 指向一个 *会话状态快照* blob（protobuf-ish 二进制，无 .proto 可依，
 *    故按「字段号 + wire type」泛化解析）。实测字段含义：
 *      #1  (repeated 32B) = **完整的有序消息列表（最旧 → 最新）**   ← 顺序来源
 *      #3  (repeated 32B) = 计划/待办（TodoWrite）项 id
 *      #4  (bytes)        = 最近一条 assistant 消息的 JSON 内联副本
 *      #5  (bytes)        = 上下文用量报告 {#1 已用, #2 上限, #3 [{id,label,a,b}]}
 *      #8  (32B ref)      = 请求包装节点（容器，无可读内容）
 *      #9  (string)       = cwd（`file://` URI）
 *      #15 (bytes)        = 最近打开的文件路径列表
 * 4. 消息本体是**独立的 JSON blob**：`{ role, content, id?, providerOptions? }`，
 *    role ∈ system | user | assistant | tool；content 为 string（system / user_info 注入）
 *    或 parts 数组，part 类型实测只有四种：
 *      text        → 文本
 *      reasoning   → 思考。**实测 3172/3172 个 reasoning part 的 text 均为空串**（cursor 只存
 *                    加密 signature，无可读思考）→ 空文本 reasoning 不产出事件，只计数
 *      tool-call   → { toolCallId, toolName, args }
 *      tool-result → { toolCallId, toolName, result, experimental_content }；失败标记在**消息级**
 *                    `providerOptions.cursor.highLevelToolCallResult.isError`
 *                    （7669/7682 条工具消息带该字段，其中 67 条 isError=true）
 * 5. 全量校验（102 个可读会话，列表长 6–364，合计 11162 条消息 / 其中 7682 条 tool 结果）：
 *      - 列表内无重复 id（内容寻址天然去重）；
 *      - 库中所有 JSON 消息 blob 在列表里**恰好出现一次**（0 缺失）→ 列表完整；
 *      - 列表恒以 system,user,user,assistant 开头（每条会话注入 user_info + user_query）；
 *      - 所有 tool 结果的 toolCallId 都能在**更早**的 assistant tool-call 中找到（0 例越界）
 *        → 顺序满足因果一致性。这**不是** rowid 顺序能解释的：样本里存在 rowid 13 排在 12
 *        之前、90 排在 89 之前等局部错位，唯列表顺序满足因果。
 *    ⇒ 该字段就是真实消息顺序，无需「集合视图」降级。
 * 6. 已确认的反例（走显式降级 / 兜底）：
 *      - 1 个会话 `latestRootBlobId` 为空串（创建后即中断，库里仅 4 个 blob）→ `root_missing`；
 *      - 10 个目录没有 store.db（mapping 按目录 birthtime 匹配，可能给出这类 ref）→ `store_missing`；
 *      - `DatabaseSync(path,{readOnly:true})` 打开成功 ≠ 可用：损坏/非 SQLite 文件要到**查询**
 *        才报 `file is not a database`，零字节文件报 `no such table` ⇒ 打开与查询两层都要 try/catch。
 *
 * ========================== cursor（增量）语义 ==========================
 *
 * SQLite 无自然字节偏移；快照 blob 每追加一条消息就被新 id 替换（rootId 每次都变），
 * 因此偏移量只能用「**最后一条已产出消息的 blob id**」表达，格式为 opaque JSON 字符串：
 *
 *     {"v":1,"rootId":"<读取时的快照 id>","lastId":"<最后一条已产出消息 blob id>"}
 *
 * 读取时在新列表里定位 lastId，只产出其后的条目（tail）；定位失败（列表被重写/压缩）→
 * 整表重读并给 `cursor_reset`。lastId 是内容寻址 id，天然稳定；`rootId` 仅作调试信息
 * （每追加一次就会变，故不用于判定）。调用方按 `detail.index`（条目在有序列表中的全局
 * 下标）即可稳定去重与续读。`seq` 是**本批次内**从 0 起的序号（签名无起始 seq 参数），
 * 调用方可用 detail.index 重定基。
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { toIso, makeEvent, makeReadResult, warning } = require('../events');

const ADAPTER = 'cursor';
const FORMAT_VERSION = 'cursor-acp-store/1';

const MAX_TEXT = 8000; // 单条事件 text 主体上限（超出截断并在 detail.truncated 标注）
const MAX_SCAN_BLOBS = 5000; // 兜底扫描上限（防御超大库）
const MAX_LIST_ENTRIES = 20000; // 消息列表上限（防御异常数据）
const MAX_PLAN_ITEMS = 50;
const MAX_USAGE_ENTRIES = 50;

/* --------------------------- protobuf-ish 解析 --------------------------- */

/** 读 varint；越界/过长抛错（调用方兜住 → 「解析到此为止」）。 */
function readVarint(buf, start) {
  let shift = 0;
  let value = 0n;
  let i = start;
  while (i < buf.length) {
    const byte = buf[i];
    value |= BigInt(byte & 0x7f) << BigInt(shift);
    i += 1;
    if ((byte & 0x80) === 0) return { value, next: i };
    shift += 7;
    if (shift > 63) throw new Error('varint too long');
  }
  throw new Error('varint truncated');
}

/**
 * 泛化解析一层 protobuf 字段；未知 wire type 或截断处**停止**并返回已解析部分
 * （快照形态若变化，要的是「尽力而为 + 显式降级」，而不是抛错）。
 */
function parseFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let key;
    let len;
    try {
      key = readVarint(buf, i);
    } catch {
      return out;
    }
    i = key.next;
    const field = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (wire === 0) {
      try {
        const v = readVarint(buf, i);
        out.push({ field, wire, number: v.value });
        i = v.next;
      } catch {
        return out;
      }
    } else if (wire === 2) {
      try {
        len = readVarint(buf, i);
      } catch {
        return out;
      }
      const n = Number(len.value);
      if (n < 0 || len.next + n > buf.length) return out;
      out.push({ field, wire, bytes: buf.subarray(len.next, len.next + n) });
      i = len.next + n;
    } else if (wire === 5) {
      if (i + 4 > buf.length) return out;
      i += 4;
    } else if (wire === 1) {
      if (i + 8 > buf.length) return out;
      i += 8;
    } else {
      return out;
    }
  }
  return out;
}

/** 取某字段中所有 32 字节引用（hex 字符串，保持出现顺序）。 */
function refsOfField(buf, field) {
  const out = [];
  for (const f of parseFields(buf)) {
    if (f.field === field && f.wire === 2 && f.bytes && f.bytes.length === 32) out.push(f.bytes.toString('hex'));
  }
  return out;
}

/* ------------------------------ 基础工具 -------------------------------- */

/** node:sqlite 的 BLOB 列是 Uint8Array（不是 Buffer），TEXT 列是 string —— 统一成 Buffer。 */
function toBuffer(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return null;
}

function safeParseJson(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** meta.value：常规是 hex 编码 JSON；若将来直接是 JSON 文本也能解。 */
function decodeMetaValue(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 0) return null;
  if (text.startsWith('{')) return safeParseJson(text);
  if (text.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(text)) return safeParseJson(Buffer.from(text, 'hex').toString('utf8'));
  return null;
}

/** 文本上限：超出时截断并**显式**记录原始长度。 */
function capText(text, detail) {
  if (typeof text !== 'string') return { text: null, detail };
  if (text.length <= MAX_TEXT) return { text, detail };
  return { text: text.slice(0, MAX_TEXT), detail: { ...detail, truncated: { chars: text.length, shown: MAX_TEXT } } };
}

/** 内容展平（未知角色 / 形态外内容的兜底）。 */
function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .filter((s) => s.length > 0)
      .join('\n');
  }
  return '';
}

/* ------------------------------- 读取层 ---------------------------------- */

function openStore(dbPath) {
  try {
    return { db: new DatabaseSync(dbPath, { readOnly: true }) };
  } catch (err) {
    return { db: null, error: err };
  }
}

function closeQuietly(db) {
  try {
    db.close();
  } catch {
    /* close best-effort */
  }
}

/** 预编译取 blob（复用 statement；缺行/查询失败均返回 null → 上层记为 entry_unreadable）。 */
function makeBlobLoader(db) {
  let stmt = null;
  try {
    stmt = db.prepare('select data from blobs where id = ?');
  } catch {
    return () => null;
  }
  return (id) => {
    try {
      const row = stmt.get(id);
      return row ? toBuffer(row.data) : null;
    } catch {
      return null;
    }
  };
}

function readMetaRow(db) {
  const rows = db.prepare('select key, value from meta').all();
  if (rows.length === 0) return null;
  const row = rows.find((r) => String(r.key) === '0') || rows[0];
  const buf = toBuffer(row.value);
  return decodeMetaValue(buf ? buf.toString('utf8') : null);
}

/**
 * 兜底 A：扫描快照候选 —— 返回 field#1 引用最多的 blob（并列取 rowid 更大者 = 更晚写入）。
 * 仅在 meta.latestRootBlobId 不可用时使用（实测 1/113 个会话如此）。
 */
function findLargestSnapshot(db, loadBlob) {
  let rows;
  try {
    // 快照至少含 1 个 32B 引用（≥34 字节），据此先行裁剪。
    rows = db.prepare('select rowid, id from blobs where length(data) >= 34 order by rowid desc limit ?').all(MAX_SCAN_BLOBS);
  } catch {
    return null;
  }
  let best = null;
  for (const row of rows) {
    const buf = loadBlob(row.id);
    if (!buf) continue;
    const ids = refsOfField(buf, 1);
    if (ids.length === 0) continue;
    if (!best || ids.length > best.ids.length) best = { id: row.id, rowid: row.rowid, ids };
  }
  return best ? { id: best.id, ids: best.ids.slice(0, MAX_LIST_ENTRIES) } : null;
}

/** 兜底 B：库里所有「JSON 消息」blob 的 id，按 rowid（≈ 首次写入顺序）升序。 */
function listMessageBlobIds(db, loadBlob) {
  let rows;
  try {
    rows = db.prepare('select rowid, id from blobs order by rowid limit ?').all(MAX_SCAN_BLOBS);
  } catch {
    return [];
  }
  const out = [];
  for (const row of rows) {
    const buf = loadBlob(row.id);
    if (!buf) continue;
    const json = safeParseJson(buf.toString('utf8'));
    if (json && typeof json.role === 'string') out.push(row.id);
  }
  return out;
}

/**
 * 恢复消息顺序。
 * 主路径：meta.latestRootBlobId → 快照 blob 的 field#1（有序消息列表）。
 * 兜底 A：field#1 引用最多的快照（warning `root_missing`）。
 * 兜底 B：按 rowid 的集合视图（warning `order_unrecovered`，显式降级）。
 */
function recoverOrder(db, loadBlob, warnings) {
  let meta = null;
  let metaError = null;
  try {
    meta = readMetaRow(db);
    if (!meta) metaError = 'meta 表无行，或 value 无法解码为 hex-JSON';
  } catch (err) {
    metaError = `meta 表不可读：${String((err && err.message) || err)}`;
  }
  if (metaError) warnings.push(warning('meta_unreadable', metaError));

  const rootId = meta && typeof meta.latestRootBlobId === 'string' ? meta.latestRootBlobId : '';
  let rootMissing = null;
  if (rootId) {
    const buf = loadBlob(rootId);
    if (buf) {
      const ids = refsOfField(buf, 1).slice(0, MAX_LIST_ENTRIES);
      if (ids.length > 0) return { ids, source: 'snapshot-field-1', rootId, meta };
      rootMissing = `快照 ${rootId.slice(0, 12)}… 的 field#1 为空`;
    } else {
      rootMissing = `meta.latestRootBlobId=${rootId.slice(0, 12)}… 指向的 blob 不存在`;
    }
  } else if (meta) {
    rootMissing = 'meta.latestRootBlobId 为空（会话创建后即中断？）';
  }

  const cand = findLargestSnapshot(db, loadBlob);
  if (cand && cand.ids.length > 0) {
    warnings.push(
      warning(
        'root_missing',
        `${rootMissing || '未取得快照指针'}；改用 field#1 引用最多的快照 ${cand.id.slice(0, 12)}… 兜底（列表可能不是最新）`,
        { rootId: cand.id }
      )
    );
    return { ids: cand.ids, source: 'largest-snapshot', rootId: cand.id, meta };
  }

  const ids = listMessageBlobIds(db, loadBlob);
  warnings.push(
    warning('order_unrecovered', `未找到会话快照消息列表（${rootMissing || 'meta/snapshot 缺失'}），降级为按 rowid 的集合视图`, {
      count: ids.length,
    })
  );
  return { ids, source: 'rowid', rootId: null, meta };
}

/* ------------------------ 快照附加状态（元信息） ------------------------ */

/** 快照 field#3 = 计划/待办（TodoWrite）项节点：{#1 id, #2 content, #3 statusRaw, #4 createdMs, #5 updatedMs}。 */
function readPlan(loadBlob, rootBuf) {
  const plan = [];
  for (const id of refsOfField(rootBuf, 3).slice(0, MAX_PLAN_ITEMS)) {
    const buf = loadBlob(id);
    if (!buf) continue;
    const fields = parseFields(buf);
    const str = (n) => {
      const f = fields.find((x) => x.field === n && x.bytes);
      return f ? f.bytes.toString('utf8') : null;
    };
    const num = (n) => {
      const f = fields.find((x) => x.field === n && x.number !== undefined);
      return f ? Number(f.number) : null;
    };
    plan.push({ id: str(1), content: str(2), statusRaw: num(3), createdAt: toIso(num(4)), updatedAt: toIso(num(5)) });
  }
  return plan;
}

/**
 * 快照 field#5 = 上下文用量报告：{#1 已用, #2 上限, #3 [{#1 id, #2 label, #3 a, #4 b}]}。
 * 注：`a` / `b` 的量纲未经验证（疑似 tokens / chars），故保留中性字段名。
 */
function readUsage(rootBuf) {
  const f5 = parseFields(rootBuf).find((f) => f.field === 5 && f.wire === 2 && f.bytes);
  if (!f5) return null;
  const fields = parseFields(f5.bytes);
  const num = (n) => {
    const f = fields.find((x) => x.field === n && x.number !== undefined);
    return f ? Number(f.number) : null;
  };
  const entries = [];
  for (const f of fields) {
    if (f.field !== 3 || f.wire !== 2 || !f.bytes) continue;
    const inner = parseFields(f.bytes);
    const str = (n) => {
      const x = inner.find((y) => y.field === n && y.bytes);
      return x ? x.bytes.toString('utf8') : null;
    };
    const inum = (n) => {
      const x = inner.find((y) => y.field === n && y.number !== undefined);
      return x ? Number(x.number) : null;
    };
    entries.push({ id: str(1), label: str(2), a: inum(3), b: inum(4) });
    if (entries.length >= MAX_USAGE_ENTRIES) break;
  }
  const used = num(1);
  const limit = num(2);
  if (used === null && limit === null && entries.length === 0) return null;
  return { used, limit, entries };
}

/** 快照 field#9 = cwd（`file://` URI）。 */
function snapshotCwd(rootBuf) {
  const f = parseFields(rootBuf).find((x) => x.field === 9 && x.wire === 2 && x.bytes);
  if (!f) return null;
  const raw = f.bytes.toString('utf8');
  return raw.startsWith('file://') ? raw.slice('file://'.length) : raw;
}

/** meta.json（v1：schemaVersion/cwd/title）——只读，绝不写入。 */
function readMetaJson(dir) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
  } catch {
    return null;
  }
  return safeParseJson(text);
}

/* ------------------------------ 消息归一化 ------------------------------ */

/**
 * 解析 cursor 注入的 `<timestamp>` 文本（如 `Friday, Sep 18, 2026, 9:55 AM (UTC+8)`）→ ISO。
 * 这是 cursor 会话数据里唯一的逐消息时间来源（仅用户消息携带）；解析失败返回 null。
 */
function parseCursorTimestamp(s) {
  const m = /^[A-Za-z]+,\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\s*(?:\(UTC\s*([+-]?\d+(?:\.\d+)?)\))?/.exec(s);
  if (!m) return null;
  const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const mon = MONTHS[m[1]];
  if (mon === undefined) return null;
  let hour = Number(m[4]);
  const ampm = m[6];
  if (ampm === 'PM' && hour < 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const offsetMin = m[7] === undefined ? 0 : Math.round(Number(m[7]) * 60);
  const ms = Date.UTC(Number(m[3]), mon, Number(m[2]), hour, Number(m[5])) - offsetMin * 60 * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * 单条消息 → 事件数组。ctx 汇总「批量告警」，避免逐条 warning 刷屏
 * （degraded 语义 = warnings 非空，见 events.js）。
 * `raw` 一律留空：blob 内容寻址，detail.blobId 足以按需回查原始数据；
 * 仅 `unknown` 事件保留一段 hex/text 预览便于排障。
 */
function messageEvents(json, blobId, index, ctx) {
  const role = json.role;
  const out = [];
  const base = { blobId, index, role };
  const messageId = typeof json.id === 'string' ? json.id : null;
  const push = (ev) => out.push(ev);

  if (role === 'system') {
    const capped = capText(flattenContent(json.content), base);
    push(makeEvent({ kind: 'notice', name: 'system', text: capped.text, detail: capped.detail }));
    return out;
  }

  if (role === 'user') {
    // cursor 注入两种用户侧消息：content 为 string 的 <user_info>（环境注入，27KB 级）与
    // content 为 parts 的 <timestamp>/<user_query>（真实任务输入）。
    // 前者归 notice，后者归 text（判据是稳定的前缀标记；命中失败则回落为 text，不丢信息）。
    const text = flattenContent(json.content);
    if (typeof json.content === 'string' && text.startsWith('<user_info>')) {
      const capped = capText(text, { ...base, injected: 'user_info' });
      push(makeEvent({ kind: 'notice', name: 'user_info', text: capped.text, detail: capped.detail }));
      return out;
    }
    const detail = { ...base, messageId };
    // <timestamp> 是 cursor 数据里唯一的逐消息时间（仅用户消息携带）；解析为事件 ts。
    const tsMatch = /<timestamp>([\s\S]*?)<\/timestamp>/.exec(text);
    const userTs = tsMatch ? parseCursorTimestamp(tsMatch[1].trim()) : null;
    const query = /<user_query>([\s\S]*?)<\/user_query>/.exec(text);
    let display = text;
    if (query) {
      const trimmed = query[1].trim();
      detail.userQuery = capText(trimmed, {}).text;
      if (trimmed.length > MAX_TEXT) detail.userQueryFullChars = trimmed.length;
      display = trimmed; // 展示文本去掉 <timestamp>/<user_query> 标记；原文保留在 detail.userQuery
    }
    const capped = capText(display, detail);
    push(makeEvent({ kind: 'text', name: 'user', text: capped.text, detail: capped.detail, ts: userTs }));
    return out;
  }

  if (role !== 'assistant' && role !== 'tool') {
    ctx.unknownRoles.add(String(role));
    const text = flattenContent(json.content);
    const capped = capText(text, { ...base, messageId });
    push(
      makeEvent({
        kind: 'unknown',
        name: String(role),
        text: capped.text,
        detail: capped.detail,
        raw: { blobId, preview: (text || JSON.stringify(json.content)).slice(0, 200) },
      })
    );
    return out;
  }

  if (!Array.isArray(json.content)) {
    // 形态外：该角色本应是 parts 数组
    ctx.unknownParts.add(`content:${typeof json.content}`);
    const text = flattenContent(json.content);
    const capped = capText(text, { ...base, messageId });
    push(
      makeEvent({
        kind: 'unknown',
        name: role,
        text: capped.text,
        detail: capped.detail,
        raw: { blobId, preview: (text || JSON.stringify(json.content)).slice(0, 200) },
      })
    );
    return out;
  }

  const parts = json.content;
  const model = (() => {
    if (role !== 'assistant') return null;
    for (const p of parts) {
      const name = p && p.providerOptions && p.providerOptions.cursor && p.providerOptions.cursor.modelName;
      if (typeof name === 'string' && name.length > 0) return name;
    }
    return null;
  })();
  const cursorPo = json.providerOptions && json.providerOptions.cursor ? json.providerOptions.cursor : null;
  const hl = cursorPo && cursorPo.highLevelToolCallResult ? cursorPo.highLevelToolCallResult : null;
  const isError = hl && typeof hl.isError === 'boolean' ? hl.isError : null;

  for (const part of parts) {
    if (!part || typeof part !== 'object' || typeof part.type !== 'string') {
      ctx.unknownParts.add(`part:${part === null ? 'null' : typeof part}`);
      push(
        makeEvent({
          kind: 'unknown',
          name: role,
          detail: { ...base, messageId, reason: 'malformed_part' },
          raw: { blobId, preview: JSON.stringify(part === undefined ? null : part).slice(0, 200) },
        })
      );
      continue;
    }

    if (part.type === 'reasoning') {
      // 实测 cursor 的 reasoning 只存加密 signature（text 恒为空串）→ 不产出空 think 事件，
      // 仅在元信息里计数 reasoningRedacted：既不静默丢数据，也不污染事件流。
      if (typeof part.text === 'string' && part.text.length > 0) {
        const capped = capText(part.text, { ...base, messageId, model });
        push(makeEvent({ kind: 'think', name: 'assistant', text: capped.text, detail: capped.detail }));
      } else {
        ctx.reasoningRedacted += 1;
      }
      continue;
    }

    if (part.type === 'text') {
      if (typeof part.text !== 'string' || part.text.length === 0) continue;
      const capped = capText(part.text, { ...base, messageId, model });
      push(makeEvent({ kind: 'text', name: 'assistant', text: capped.text, detail: capped.detail }));
      continue;
    }

    if (part.type === 'tool-call') {
      if (typeof part.toolCallId === 'string' && typeof part.toolName === 'string') {
        ctx.toolNames.set(part.toolCallId, part.toolName);
      }
      push(
        makeEvent({
          kind: 'tool_call',
          name: typeof part.toolName === 'string' ? part.toolName : null,
          detail: {
            ...base,
            messageId,
            model,
            toolCallId: part.toolCallId === undefined ? null : part.toolCallId,
            args: part.args === undefined ? null : part.args,
          },
        })
      );
      continue;
    }

    if (part.type === 'tool-result') {
      const resultText =
        typeof part.result === 'string'
          ? part.result
          : part.result === undefined || part.result === null
            ? ''
            : JSON.stringify(part.result);
      const name = typeof part.toolName === 'string' ? part.toolName : null;
      const detail = { ...base, messageId, toolCallId: part.toolCallId === undefined ? null : part.toolCallId, isError };
      if (name === null && typeof part.toolCallId === 'string') detail.toolName = ctx.toolNames.get(part.toolCallId) || null;
      if (isError === true && hl && hl.rawErrorMessages !== undefined) {
        detail.rawErrorMessages = capText(
          typeof hl.rawErrorMessages === 'string' ? hl.rawErrorMessages : JSON.stringify(hl.rawErrorMessages),
          {}
        ).text;
      }
      const capped = capText(resultText, detail);
      push(
        makeEvent({
          kind: 'tool_result',
          name: name || detail.toolName || null,
          status: isError === null ? null : isError ? 'error' : 'ok',
          text: capped.text,
          detail: capped.detail,
        })
      );
      continue;
    }

    ctx.unknownParts.add(`part:${part.type}`);
    push(
      makeEvent({
        kind: 'unknown',
        name: typeof part.toolName === 'string' ? part.toolName : role,
        detail: { ...base, messageId, partType: part.type },
        raw: { blobId, preview: JSON.stringify(part).slice(0, 200) },
      })
    );
  }
  return out;
}

/* -------------------------------- 入口 ---------------------------------- */

function parseCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0) return null;
  const parsed = safeParseJson(cursor);
  if (!parsed || typeof parsed.lastId !== 'string') return { invalid: true };
  return parsed;
}

function encodeCursor(rootId, lastId) {
  return JSON.stringify({ v: 1, rootId: rootId || null, lastId });
}

/**
 * 读取 cursor 会话事件。
 * @param {{adapter?: string, kind?: string, path: string, id?: string}} ref mapping 产出的会话引用
 * @param {{cursor?: string|null}} [options]
 */
function readEvents(ref, options = {}) {
  const warnings = [];
  const stop = (events = []) =>
    makeReadResult(events, { nextCursor: null, adapter: ADAPTER, formatVersion: FORMAT_VERSION, warnings });

  if (!ref || typeof ref.path !== 'string' || ref.path.length === 0) {
    warnings.push(warning('bad_ref', '会话引用缺少 path（mapping 输出异常）'));
    return stop();
  }
  const dir = ref.path;
  const dbPath = ref.kind === 'file' ? dir : path.join(dir, 'store.db');
  if (!fs.existsSync(dbPath)) {
    warnings.push(warning('store_missing', `会话数据库不存在：${dbPath}`));
    return stop();
  }

  const opened = openStore(dbPath);
  if (!opened.db) {
    warnings.push(
      warning('db_open_failed', `无法以只读方式打开 ${dbPath}：${String((opened.error && opened.error.message) || opened.error)}`)
    );
    return stop();
  }
  const db = opened.db;

  try {
    const loadBlob = makeBlobLoader(db);
    const order = recoverOrder(db, loadBlob, warnings);

    // 游标：定位 lastId → 只产出其后的条目；定位失败 → 整表重读 + cursor_reset。
    const cursorIn = options ? options.cursor : null;
    const parsed = parseCursor(cursorIn);
    let start = 0;
    if (parsed && parsed.invalid) {
      warnings.push(
        warning('cursor_invalid', 'cursor 不是本适配器产出的 opaque 值，已忽略并按整表读取', {
          cursor: String(cursorIn).slice(0, 120),
        })
      );
    } else if (parsed) {
      const at = order.ids.lastIndexOf(parsed.lastId);
      if (at >= 0) start = at + 1;
      else {
        warnings.push(
          warning('cursor_reset', `cursor.lastId=${parsed.lastId.slice(0, 12)}… 已不在当前消息列表中（列表被重写？），整表重读`)
        );
      }
    }

    const rootBuf = order.rootId ? loadBlob(order.rootId) : null;
    const ctx = {
      counts: {},
      toolNames: new Map(),
      unknownRoles: new Set(),
      unknownParts: new Set(),
      reasoningRedacted: 0,
    };
    const events = [];
    let lastEmitted = null;
    let unreadable = 0;
    const unreadableSamples = [];

    for (let i = start; i < order.ids.length; i += 1) {
      const id = order.ids[i];
      const buf = loadBlob(id);
      if (!buf) {
        unreadable += 1;
        if (unreadableSamples.length < 5) unreadableSamples.push(id.slice(0, 12));
        continue;
      }
      const json = safeParseJson(buf.toString('utf8'));
      if (!json || typeof json.role !== 'string') {
        ctx.unknownParts.add('entry:non_message');
        events.push(
          makeEvent({
            kind: 'unknown',
            name: null,
            detail: { blobId: id, index: i, reason: 'non_message_entry' },
            raw: {
              blobId: id,
              previewHex: buf.subarray(0, 64).toString('hex'),
              previewText: buf.toString('utf8').slice(0, 120),
            },
          })
        );
        lastEmitted = id;
        continue;
      }
      for (const ev of messageEvents(json, id, i, ctx)) events.push(ev);
      ctx.counts[json.role] = (ctx.counts[json.role] || 0) + 1;
      lastEmitted = id;
    }

    if (unreadable > 0) {
      warnings.push(
        warning('entry_unreadable', `${unreadable} 个被列表引用的消息 blob 缺失或不可读`, {
          count: unreadable,
          samples: unreadableSamples,
        })
      );
    }
    if (ctx.unknownRoles.size > 0) {
      warnings.push(
        warning('unknown_role', `出现未识别的消息角色：${[...ctx.unknownRoles].join(', ')}`, { roles: [...ctx.unknownRoles] })
      );
    }
    if (ctx.unknownParts.size > 0) {
      warnings.push(
        warning('unknown_part_type', `出现未识别的 part 类型：${[...ctx.unknownParts].join(', ')}`, {
          parts: [...ctx.unknownParts],
        })
      );
    }

    // 元信息事件只在整表读取且库确实可读时给出（损坏库/空库不产出任何事件，
    // 只留 warning）；tail 读取不重复。
    const storeReadable = order.ids.length > 0 || order.rootId !== null || order.meta !== null;
    if (start === 0 && storeReadable) {
      const metaJson = readMetaJson(dir);
      const detail = {
        adapter: ADAPTER,
        formatVersion: FORMAT_VERSION,
        sessionId: (order.meta && order.meta.agentId) || ref.id || null,
        name: (order.meta && order.meta.name) || (metaJson && metaJson.title) || null,
        mode: (order.meta && order.meta.mode) || null,
        createdAt: toIso(order.meta && order.meta.createdAt),
        cwd: (rootBuf && snapshotCwd(rootBuf)) || (metaJson && metaJson.cwd) || null,
        orderSource: order.source,
        orderRecovered: order.source !== 'rowid',
        messageCount: order.ids.length,
        counts: ctx.counts,
        reasoningRedacted: ctx.reasoningRedacted,
        plan: rootBuf ? readPlan(loadBlob, rootBuf) : [],
        usage: rootBuf ? readUsage(rootBuf) : null,
      };
      events.unshift(makeEvent({ kind: 'meta', name: 'metadata', text: detail.name, detail }));
    }

    // seq = 本批次内 0..n-1（签名无起始 seq 参数）；全局定位用 detail.index。
    events.forEach((ev, i) => {
      ev.seq = i;
    });

    const nextCursor = lastEmitted === null ? (parsed && !parsed.invalid ? cursorIn : null) : encodeCursor(order.rootId, lastEmitted);
    return makeReadResult(events, { nextCursor, adapter: ADAPTER, formatVersion: FORMAT_VERSION, warnings });
  } catch (err) {
    // 查询层容错：损坏库 / 非 SQLite 文件 / schema 漂移都只在这一层暴露
    warnings.push(warning('db_unreadable', `读取 ${dbPath} 失败：${String((err && err.message) || err)}`));
    return stop();
  } finally {
    closeQuietly(db);
  }
}

module.exports = { readEvents, FORMAT_VERSION };
