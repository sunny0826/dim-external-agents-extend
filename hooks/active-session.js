'use strict';
/**
 * 共享：记录「当前活跃 dim 会话」。
 *
 * hook（UserPromptSubmit / Stop）的输入里带 sessionId；每次触发时把它写入一个
 * 临时文件，供 MCP server（tools.js）在 list_agent_runs 默认 scope=session 时读取，
 * 从而「默认只列出本会话委托的外部 Agent」。
 *
 * 约束：任何异常都静默（hook 绝不影响会话）；路径可用 EA_EXT_ACTIVE_SESSION 覆盖（测试用）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE_NAME = 'ea-extend-active-session.json';

function activeSessionPath() {
  return process.env.EA_EXT_ACTIVE_SESSION || path.join(os.tmpdir(), FILE_NAME);
}

/** 从 hook 输入对象里取会话 id 并落盘；无 id 或失败则静默。 */
function recordActiveSession(input) {
  try {
    const sid = input && (input.sessionId || input.session_id);
    if (typeof sid !== 'string' || sid.length === 0) return;
    fs.writeFileSync(activeSessionPath(), JSON.stringify({ sessionId: sid, updatedAt: Date.now() }));
  } catch {
    /* 忽略：仅影响默认过滤范围，不影响功能 */
  }
}

module.exports = { activeSessionPath, recordActiveSession };
