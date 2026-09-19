#!/usr/bin/env node
'use strict';
/**
 * 全自动会话命名（hook 侧）。
 *
 * 作用：dim 把任务委托给外部 agent 后，该外部会话在它自己的存储里往往是泛化标题
 * （`Help` / `New session - <ISO>` / 整段 prompt 样板），开启本功能后 hook 会在后续的
 * UserPromptSubmit / PostToolUse / Stop 时机把它改写成统一名（`[dim] 修复 GUO-108 审查问题`）。
 *
 * **默认关闭（opt-in）**——改名会写进别的工具自己的存储，必须由用户显式打开：
 *   - `dim-external-agents-extend autoname --enable`（写 `~/.dimcode/ea-extend-config.json`，推荐）
 *   - 或手工写该文件：`{ "autoName": true }`
 *   - 或环境变量 `EA_EXT_AUTO_NAME=on`（注意 macOS 桌面 App 不继承 shell 的 export）
 *
 * 硬边界（与 rename_external_sessions 一致，且更保守）：
 * - 只处理**能关联到 dim 任务**的会话，你手动开的会话一律不碰；
 * - 只处理**会话自身标题泛化**的；名称已有信息量的不动，你自定义过标题的更不动；
 * - 写前照常备份到 `~/.dimcode/ea-extend-backups/`；
 * - 静默：不打印任何内容、不改变退出码；任何异常都吞掉。
 *
 * 状态：`<tmp>/ea-extend-auto-named.json`（每个 taskId 只处理一次 + 节流时间戳）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { autoNameSessions } = require('../server/src/core/sessions');
const { autoNameStatus } = require('../server/src/core/settings');

const STATE_FILE = process.env.EA_EXT_AUTONAME_STATE || path.join(os.tmpdir(), 'ea-extend-auto-named.json');
const WINDOW_MS = Number(process.env.EA_EXT_AUTONAME_WINDOW_MS) > 0 ? Number(process.env.EA_EXT_AUTONAME_WINDOW_MS) : 2 * 60 * 60 * 1000;
const THROTTLE_MS = Number(process.env.EA_EXT_AUTONAME_THROTTLE_MS) >= 0 ? Number(process.env.EA_EXT_AUTONAME_THROTTLE_MS) : 10000;
const MAX_ENTRIES = 300;

/** 是否开启自动命名（默认关闭；见文件头）。 */
function isEnabled(home = os.homedir()) {
  return autoNameStatus(home).enabled;
}

/** 兼容旧名（语义相反），供测试与调用方判断。 */
function isDisabled(home = os.homedir()) {
  return !isEnabled(home);
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      lastRunAt: Number(parsed.lastRunAt) || 0,
    };
  } catch {
    return { entries: [], lastRunAt: 0 };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ entries: state.entries.slice(-MAX_ENTRIES), lastRunAt: state.lastRunAt })
    );
  } catch {
    /* 状态写失败只意味着可能重复处理，忽略 */
  }
}

/**
 * 执行一轮自动命名（静默）。
 * @param {{force?: boolean, apply?: boolean, windowMs?: number, max?: number}} [options]
 *   force=true 忽略节流（CLI / 测试用）。
 */
function runAutoName(options = {}) {
  if (!isEnabled()) return { status: 'disabled', renamed: 0, named: [] };
  const state = loadState();
  const now = Date.now();
  if (options.force !== true && THROTTLE_MS > 0 && now - state.lastRunAt < THROTTLE_MS) {
    return { status: 'throttled', renamed: 0, named: [] };
  }

  const alreadyNamed = new Set(state.entries.map((e) => e.taskId));
  let result;
  try {
    result = autoNameSessions({
      ...(process.env.DIM_EXT_HOOK_DB ? { dbPath: process.env.DIM_EXT_HOOK_DB } : {}),
      windowMs: Number.isFinite(options.windowMs) ? options.windowMs : WINDOW_MS,
      max: Number.isFinite(options.max) ? options.max : 5,
      apply: options.apply !== false,
      alreadyNamed,
    });
  } catch {
    state.lastRunAt = now;
    saveState(state);
    return { status: 'error', renamed: 0, named: [] };
  }

  state.lastRunAt = now;
  for (const item of result.named || []) {
    state.entries.push({ taskId: item.taskId, reason: item.reason, key: item.key || null, at: now });
  }
  if ((result.named || []).length > 0 || result.considered > 0) saveState(state);
  return result;
}

module.exports = { runAutoName, isEnabled, isDisabled, autoNameStatus, STATE_FILE };

if (require.main === module) {
  try {
    runAutoName();
  } catch {
    /* hook 必须静默且不影响会话 */
  }
}
