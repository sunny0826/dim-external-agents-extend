#!/usr/bin/env node
'use strict';
/**
 * 从本机各 Agent 应用的 icon.icns 提取 44px PNG 并注入 widget 的 AGENT_LOGOS 表。
 *
 * - 依赖 macOS 自带 `sips`；只读本机 app，不联网；
 * - logo 版权归各厂商，仅用于本机界面标识；
 * - 注入后 log.html 中的占位符 `/*__AGENT_LOGOS__*​/` 会被替换；重跑前需先还原占位符。
 *
 * 用法：node scripts/build-logos.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APPS = [
  ['kimi', '/Applications/Kimi.app/Contents/Resources/icon.icns'],
  ['cursor', '/Applications/Cursor.app/Contents/Resources/Cursor.icns'],
  ['codex', '/Applications/ChatGPT.app/Contents/Resources/icon-chatgpt.icns'],
  ['grok', '/Applications/Grok Bot.app/Contents/Resources/icon.icns'],
  ['opencode', '/Applications/OpenCode.app/Contents/Resources/icon.icns'],
  ['zcode', '/Applications/ZCode.app/Contents/Resources/icon.icns'],
];

const WIDGET = path.join(__dirname, '..', 'server', 'src', 'widget', 'log.html');
const PLACEHOLDER = '/*__AGENT_LOGOS__*/';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-logos-'));

const entries = [];
for (const [name, icns] of APPS) {
  if (!fs.existsSync(icns)) {
    console.warn('skip (app not found):', name, icns);
    continue;
  }
  const png = path.join(tmp, name + '.png');
  execFileSync('sips', ['-s', 'format', 'png', icns, '--out', png, '-Z', '44'], { stdio: 'ignore' });
  entries.push(`      ${name}: "data:image/png;base64,${fs.readFileSync(png).toString('base64')}",`);
}

let html = fs.readFileSync(WIDGET, 'utf8');
if (!html.includes(PLACEHOLDER)) {
  console.error('占位符不存在：log.html 已注入过或结构已变；请先还原占位符再运行。');
  process.exit(1);
}
html = html.replace(PLACEHOLDER, '\n' + entries.join('\n') + '\n    ');
fs.writeFileSync(WIDGET, html);
console.log(`已注入 ${entries.length} 个 logo（${entries.join('').length} 字符）`);
