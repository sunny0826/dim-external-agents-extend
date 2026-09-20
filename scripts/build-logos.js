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

/* pi 是 CLI（@earendil-works/pi-coding-agent），本机没有 .app/icns 可提取；
 * 用官方 SVG（来源 https://pi.dev/logo-auto.svg，2026-09-20 抓取，338 字节）的 data URI，
 * 与 log.html 中 AGENT_LOGOS 的 pi 值保持一致。
 * viewBox 已收紧到图形包围盒 + 约 3% 边距（145 145 510 510），去掉厂商 SVG 自带的
 * 大留白，使其在 12px 的 badge 内与其余 6 个 logo 视觉大小一致；path 数据未改。 */
const PI_LOGO_SVG_URI =
  'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz4KPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjE0NSAxNDUgNTEwIDUxMCI+CiAgPHBhdGggZmlsbD0iI0YwOTA4MiIgZD0iTTE2NS4yOSAxNjUuMjlINTE3LjM2VjQwMEg0MDBWMjgyLjY1SDE2NS4yOVoiLz4KICA8cGF0aCBmaWxsPSIjNEQ5QUJGIiBkPSJNMTY1LjI5IDI4Mi42NUgyODIuNjVWNDAwSDQwMFY1MTcuMzZIMjgyLjY1VjYzNC43MkgxNjUuMjlaIi8+CiAgPHBhdGggZmlsbD0iI0YxQkU1OCIgZD0iTTUxNy4zNiA0MDBINjM0LjcyVjYzNC43Mkg1MTcuMzZaIi8+Cjwvc3ZnPgo=';

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
/* 插到 opencode 之后、zcode 之前，与 log.html 的 AGENT_LOGOS 顺序保持一致 */
const zcodeIdx = entries.findIndex((e) => e.startsWith('      zcode:'));
const piEntry = `      pi: "${PI_LOGO_SVG_URI}",`;
if (zcodeIdx >= 0) entries.splice(zcodeIdx, 0, piEntry);
else entries.push(piEntry);

let html = fs.readFileSync(WIDGET, 'utf8');
if (!html.includes(PLACEHOLDER)) {
  console.error('占位符不存在：log.html 已注入过或结构已变；请先还原占位符再运行。');
  process.exit(1);
}
html = html.replace(PLACEHOLDER, '\n' + entries.join('\n') + '\n    ');
fs.writeFileSync(WIDGET, html);
console.log(`已注入 ${entries.length} 个 logo（${entries.join('').length} 字符）`);
