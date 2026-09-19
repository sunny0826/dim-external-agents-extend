'use strict';

/**
 * 会话名称归一化（纯函数，无 I/O）。
 *
 * 目标：把各外部 agent 自造的、五花八门的会话标题，收敛成统一的展示名。
 *
 * 命名优先级（用户决定）：
 *   1. dim 任务标题（metadata.taskTitle，本来就是人话中文）
 *   2. 会话自身标题（当它不是「通用/无信息」标题时）
 *   3. 会话首条 prompt 里有意义的行（跳过委托包装样板；含 Issue token 的行优先）
 *   4. 兜底：`未命名会话 · <cwd 末段 或 会话短码>`
 *
 * 统一展示格式：`[codex] 09-19 20:31 · [dim] 修复 GUO-108 审查问题`
 * 统一名（写进各 agent 自己的会话存储）：`[dim] 修复 GUO-108 审查问题`
 *   —— `[dim]` = dim 委托产生的会话，`[手动]` = 其它来源（你手动开的、别的编排器拉起的）；
 *   同一 agent 内出现重名时追加 `· 09-19` 以保持可区分。
 */

const MAX_TITLE_LEN = 60;
const FALLBACK_TITLE = '未命名会话';

/** 通用（无信息量）标题的识别规则。命中即视为「需要重新命名」。 */
const GENERIC_EXACT = new Set([
  'help',
  'untitled',
  'untitled session',
  'new session',
  'new chat',
  'new conversation',
  'chat',
  'conversation',
  'session',
  'default',
  'test',
  'main',
  '你好',
  'hi',
  'hello',
  '你是谁',
  '你是谁？',
  '开始',
  'start',
]);

const GENERIC_PATTERNS = [
  /* opencode 的自动标题：New session - 2026-09-16T14:12:03.160Z */
  /^new session\s*[-–—:]\s*\d{4}-\d{2}-\d{2}/i,
  /* 纯时间戳 / 日期 */
  /^\d{4}-\d{2}-\d{2}([t ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?z?)?$/i,
  /^\d{2}[-/]\d{2}\s+\d{2}:\d{2}(:\d{2})?$/,
  /* 会话 id / uuid */
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^(session|sess|ses|task|subagent|thread)[_-][0-9a-z_-]+$/i,
  /* URL 编码路径（grok 的会话目录名形态） */
  /^(%2f|%5c)/i,
  /* 纯路径 */
  /^([~/]|[a-z]:\\)/i,
  /* 编号型：Session 1 / 会话 3 */
  /^(session|chat|conversation|会话|对话)\s*#?\d+$/i,
  /* 默认 agent 名 */
  /^(codex|kimi|cursor|grok|opencode|zcode|claude)(\s*(cli|code|agent))?$/i,
];

/** 空 / 纯空白。 */
function isBlank(value) {
  return typeof value !== 'string' || value.trim().length === 0;
}

/**
 * 标题是否为「通用/无信息」标题。
 * @param {string} title
 * @param {{cwd?: string, sessionId?: string}} [ctx]
 */
function isGenericTitle(title, ctx = {}) {
  if (isBlank(title)) return true;
  const t = String(title).trim();
  if (t.length <= 2) return true;
  const lower = t.toLowerCase();
  if (GENERIC_EXACT.has(lower)) return true;
  for (const re of GENERIC_PATTERNS) if (re.test(t)) return true;
  const cwd = ctx.cwd ? String(ctx.cwd) : '';
  if (cwd.length > 0) {
    const base = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
    if (base.length > 0 && (t === cwd || t === base)) return true;
  }
  const sid = ctx.sessionId ? String(ctx.sessionId) : '';
  if (sid.length > 0 && t === sid) return true;
  /* 标题本身就是一段被包装的委托样板（kimi / cursor 会拿 prompt 全文当标题） */
  if (isHardWrapperLine(normalizeTitle(t, 100))) return true;
  /* 整条标题只有委托前缀、剥掉后什么都不剩（如「你是实现者」）→ 同样没有信息量 */
  if (stripDelegationPrefix(normalizeTitle(t, 100)) === '') return true;
  return false;
}

/** 去掉 Markdown 装饰、压缩空白、截断。 */
function normalizeTitle(text, maxLen = MAX_TITLE_LEN) {
  if (isBlank(text)) return '';
  let t = String(text)
    .replace(/```[\s\S]*?```/g, ' ') /* 代码块整体丢弃 */
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '') /* ATX 标题标记 */
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\*\*|__|\*|~~/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.replace(/^[\s:：\-–—、,，.。;；]+/, '').replace(/[\s:：\-–—、,，.。;；]+$/, '');
  if (t.length > maxLen) t = `${t.slice(0, maxLen - 1).trimEnd()}…`;
  return t;
}

/**
 * 委托型 prompt 的样板分两类：
 * - HARD：dim/宿主注入的通用样板。首行命中它说明整段 prompt 都是包装文本，
 *   真正的任务描述埋在注入段落之后，挖出来的只会是样板碎片 → 整段判为不可用于命名。
 * - SOFT：某一行是包装/系统行，跳过它继续往下找即可（如「你是 XX 的实现者」「<system-reminder>」）。
 */
const HARD_WRAPPER_PATTERNS = [
  /^you are an agent handling a delegated task/i,
  /^focus on the task described below/i,
  /^complete it within the specified scope/i,
  /^return the (judgment|result|summary)/i,
  /^use available tools only when/i,
  /^prefer targeted commands/i,
  /^use nowledge mem as the source/i,
  /^nowledge mem routing/i,
  /^isolated subagent boundary/i,
  /^you are working in an isolated subagent context/i,
  /^for continuation[, ]/i,
  /^prior-decision work/i,
];

const SOFT_WRAPPER_PATTERNS = [
  /^你是.{0,40}(实现者|审查者|开发者|执行者|助手|助理|agent)/i,
  /^you are (an?|the) .{0,60}(agent|assistant|developer|reviewer)/i,
  /^\[?slock /i,
  /^new messages? received/i,
  /^<[^>]+>$/,
  /^(start\.?|new message received:?|new session)$/i,
  /^(#{0,3}\s*)?(task|context|instructions|background|背景|任务|要求|工作目录|目标)[:：]?$/i,
  /^[`~]?\/(users|private|tmp|var)\//i,
];

/** 任务标识 token（如 GUO-108、PR-12）：出现在哪一行，哪一行就更可能是任务描述。 */
const TASK_TOKEN_RE = /\b[A-Z]{2,}-\d+\b/;

function isHardWrapperLine(text) {
  return HARD_WRAPPER_PATTERNS.some((re) => re.test(text));
}

function isSoftWrapperLine(text) {
  return SOFT_WRAPPER_PATTERNS.some((re) => re.test(text));
}

function isWrapperLine(text) {
  return isHardWrapperLine(text) || isSoftWrapperLine(text);
}

/**
 * 从一段（可能是包装过的）prompt 里取「第一个有意义的行」。
 *   - 首行命中 HARD 样板 → 整段不可用，返回 ''（交给上层兜底命名）；
 *   - 否则优先取含任务 token（GUO-108 之类）的首行，再退化为首个非样板行。
 */
function firstMeaningfulLine(text, maxLen = MAX_TITLE_LEN) {
  if (isBlank(text)) return '';
  const lines = String(text).split(/\r?\n/);
  const candidates = [];
  let firstNonEmpty = null;
  for (const line of lines) {
    const t = normalizeTitle(line, maxLen);
    if (t.length === 0) continue;
    if (firstNonEmpty === null) firstNonEmpty = t;
    if (isWrapperLine(t)) continue;
    /* 纯路径 / 纯文件名不作为标题 */
    if (/^[a-z0-9_./-]+\.(ts|tsx|js|jsx|json|md|py|go|rs|sql|yml|yaml|sh)$/i.test(t)) continue;
    candidates.push(t);
  }
  if (firstNonEmpty !== null && isHardWrapperLine(firstNonEmpty)) return '';
  if (candidates.length === 0) return '';
  const withToken = candidates.find((t) => TASK_TOKEN_RE.test(t));
  return withToken !== undefined ? withToken : candidates[0];
}

/** 从 cwd 取一个可读的兜底名（忽略 `.` `/` 这类无信息段）。 */
function cwdLabel(cwd) {
  if (isBlank(cwd)) return '';
  const parts = String(cwd)
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .filter((p) => p.length > 0 && p !== '.' && p !== '..' && p !== '~');
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

/** 「被委托/被编排」产生的文本特征（用于区分 dim 委托 vs 你手打）。 */
const DELEGATION_PATTERNS = [
  /^you are an agent handling a delegated task/i,
  /^you are (an?|the) .{0,60}(agent|assistant|developer|reviewer)/i,
  /^你是.{0,40}(实现者|审查者|开发者|执行者|助手|助理|agent)/i,
];

/** 首行是否像委托 prompt（说明这条会话由某个编排器拉起，而不是你手打的）。 */
function looksDelegated(text) {
  if (isBlank(text)) return false;
  const first = String(text).split(/\r?\n/).find((l) => l.trim().length > 0);
  if (first === undefined) return false;
  const t = normalizeTitle(first, 120);
  return t.length > 0 && DELEGATION_PATTERNS.some((re) => re.test(t));
}

/**
 * 剥掉标题开头的委托前缀：
 *   `你是 Project V 的执行开发者。任务：时间轴重构` → `任务：时间轴重构`
 *   `你是实现者` → ``（只剩样板，说明这条标题没有信息量）
 */
function stripDelegationPrefix(title) {
  const t = String(title === undefined || title === null ? '' : title).trim();
  if (t.length === 0) return '';
  for (const re of DELEGATION_PATTERNS) {
    const m = re.exec(t);
    if (m === null) continue;
    return t.slice(m[0].length).replace(/^[\s。.，,：:；;\-–—、]+/, '').trim();
  }
  return t;
}

/**
 * 推导会话标题。
 * @param {{dimTaskTitle?: string, rawTitle?: string, prompt?: string, cwd?: string,
 *          agentType?: string, sessionId?: string}} input
 * @returns {{title: string, source: 'dim-task'|'session'|'prompt'|'fallback', generic: boolean}}
 */
function deriveSessionTitle(input = {}) {
  const { dimTaskTitle, rawTitle, prompt, cwd, agentType, sessionId } = input;

  const dimTitle = normalizeTitle(dimTaskTitle);
  if (dimTitle.length > 0) {
    return { title: dimTitle, source: 'dim-task', generic: isGenericTitle(rawTitle, { cwd, sessionId }) };
  }

  const own = stripDelegationPrefix(normalizeTitle(rawTitle));
  if (own.length > 0 && !isGenericTitle(own, { cwd, sessionId })) {
    return { title: own, source: 'session', generic: false };
  }

  const fromPrompt = firstMeaningfulLine(prompt);
  if (fromPrompt.length > 0 && !isGenericTitle(fromPrompt, { cwd, sessionId })) {
    return { title: fromPrompt, source: 'prompt', generic: false };
  }

  /* 兜底：用 cwd 末段或会话 id 短码，保证多个「未命名会话」之间仍可区分。 */
  const label = cwdLabel(cwd) || shortId(sessionId) || (agentType ? String(agentType) : '');
  const suffix = label.length > 0 ? ` · ${label}` : '';
  return { title: `${FALLBACK_TITLE}${suffix}`, source: 'fallback', generic: true };
}

/** `session_c476669d-…` → `c476669d`（去掉前缀取短码，用于兜底命名）。 */
function shortId(sessionId) {
  if (isBlank(sessionId)) return '';
  const s = String(sessionId).replace(/^(session|sess|ses|task|subagent|thread|rollout)[_-]/i, '');
  const head = s.split(/[-_]/)[0];
  return head.length >= 4 ? head.slice(0, 8) : s.slice(0, 8);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toDate(value) {
  if (value === undefined || value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `09-19 20:31` */
function formatStamp(value) {
  const d = toDate(value);
  if (d === null) return '--:--';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `09-19` */
function formatDay(value) {
  const d = toDate(value);
  if (d === null) return '--';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 来源标记：dim 委托 vs 其它（你手动开的、或别的编排器拉起的）。 */
const SOURCE_LABELS = { dim: '[dim]', manual: '[手动]' };

function formatSourceMarker(source) {
  return SOURCE_LABELS[source] || '';
}

/** 统一展示名：`[codex] 09-19 20:31 · [dim] 修复 GUO-108 审查问题` */
function formatDisplayName({ agentType, createdAt, title }) {
  const agent = isBlank(agentType) ? 'unknown' : String(agentType);
  const name = normalizeTitle(title);
  return `[${agent}] ${formatStamp(createdAt)} · ${name.length > 0 ? name : FALLBACK_TITLE}`;
}

/** 去掉标题开头已有的来源标记（避免二次改名时叠加成 `[手动] [手动] …`）。 */
function stripSourceMarker(title) {
  return String(title).replace(/^\[(dim|手动)\]\s*/i, '').trim();
}

/**
 * 统一名（也是写进外部 agent 自己存储的那个名字）。
 * 组成：来源标记 + 标题（+ 重名时的日期后缀）
 *   `[dim] 修复 GUO-108 审查问题`、`[手动] 维护本地 skill · 09-19`
 * 标题里已有的来源标记会先被剥掉再加，保证幂等。
 * @param {{title?: string, source?: 'dim'|'manual', createdAt?: any, collision?: boolean, prefix?: boolean}} input
 */
function formatWritebackTitle(input = {}) {
  const { title, source, createdAt, collision = false, prefix = true } = input;
  const name = stripSourceMarker(normalizeTitle(title));
  const base = name.length > 0 ? name : FALLBACK_TITLE;
  const marker = prefix ? formatSourceMarker(source) : '';
  const withMarker = marker.length > 0 ? `${marker} ${base}` : base;
  return collision ? `${withMarker} · ${formatDay(createdAt)}` : withMarker;
}

module.exports = {
  MAX_TITLE_LEN,
  FALLBACK_TITLE,
  SOURCE_LABELS,
  isBlank,
  isGenericTitle,
  normalizeTitle,
  firstMeaningfulLine,
  cwdLabel,
  shortId,
  deriveSessionTitle,
  formatStamp,
  formatDay,
  formatDisplayName,
  formatWritebackTitle,
  formatSourceMarker,
  stripSourceMarker,
  stripDelegationPrefix,
  looksDelegated,
};
