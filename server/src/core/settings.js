'use strict';

/**
 * 插件设置（`~/.dimcode/ea-extend-config.json`）。
 *
 * 目前只有一项：`autoName` —— 是否允许 hook 在 dim 委托后**自动**改写外部会话名。
 * **默认关闭**（opt-in）：改名会写进别的工具自己的存储，必须由用户显式打开。
 *
 * 打开方式（任一，配置文件是桌面端唯一可靠的方式——DimAgent.app 不继承 shell 的 export）：
 *   - `dim-external-agents-extend autoname --enable`（写配置文件）
 *   - 手工写 `~/.dimcode/ea-extend-config.json`：`{ "autoName": true }`
 *   - 环境变量 `EA_EXT_AUTO_NAME=on`（对从终端启动的 dim 生效）
 *
 * 环境变量 `EA_EXT_CONFIG` 可覆盖配置文件路径（测试用）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_SETTINGS = { autoName: false };
const TRUTHY = new Set(['1', 'on', 'true', 'yes', 'enable', 'enabled']);
const FALSY = new Set(['0', 'off', 'false', 'no', 'disable', 'disabled']);

function configPath(home = os.homedir()) {
  return process.env.EA_EXT_CONFIG || path.join(home, '.dimcode', 'ea-extend-config.json');
}

/** 读原始配置对象（缺失/损坏返回 null）。 */
function readRawSettings(home = os.homedir()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 读设置（缺失/损坏一律回落到默认值：autoName 关闭）。 */
function readSettings(home = os.homedir()) {
  const parsed = readRawSettings(home);
  if (parsed === null) return { ...DEFAULT_SETTINGS };
  const out = { ...DEFAULT_SETTINGS };
  if (typeof parsed.autoName === 'boolean') out.autoName = parsed.autoName;
  return out;
}

/** 原子写设置（保留文件里其它未知键）。 */
function writeSettings(home = os.homedir(), patch = {}) {
  const file = configPath(home);
  let current = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') current = parsed;
  } catch {
    /* 无配置或损坏：从空对象开始 */
  }
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return { file, settings: readSettings(home) };
}

/**
 * 解析「自动命名是否开启」及其来源。
 * 优先级：环境变量（显式 on/off）> 配置文件 > 默认（关闭）。
 * @returns {{enabled: boolean, source: 'env'|'config'|'default', configPath: string, rawEnv: string|null}}
 */
function autoNameStatus(home = os.homedir()) {
  const rawEnv = process.env.EA_EXT_AUTO_NAME === undefined ? null : String(process.env.EA_EXT_AUTO_NAME).trim().toLowerCase();
  if (rawEnv !== null && TRUTHY.has(rawEnv)) return { enabled: true, source: 'env', configPath: configPath(home), rawEnv };
  if (rawEnv !== null && FALSY.has(rawEnv)) return { enabled: false, source: 'env', configPath: configPath(home), rawEnv };
  const raw = readRawSettings(home);
  if (raw !== null && typeof raw.autoName === 'boolean') {
    /* 配置里显式写了值：无论 true/false 都算「配置决定」，不是默认值 */
    return { enabled: raw.autoName, source: 'config', configPath: configPath(home), rawEnv };
  }
  return { enabled: false, source: 'default', configPath: configPath(home), rawEnv };
}

/** 便捷判定。 */
function isAutoNameEnabled(home = os.homedir()) {
  return autoNameStatus(home).enabled;
}

module.exports = {
  DEFAULT_SETTINGS,
  configPath,
  readRawSettings,
  readSettings,
  writeSettings,
  autoNameStatus,
  isAutoNameEnabled,
};
