#!/usr/bin/env node
/**
 * 结构与一致性校验（CI / 发布前使用）：
 *  1. 关键文件存在（含双语 README、CHANGELOG、AGENTS.md）
 *  2. manifest JSON 可解析（.codex-plugin/plugin.json、.mcp.json）
 *  3. plugin.json 引用的路径存在（mcpServers / skills / hooks）
 *  4. 版本号一致性：plugin.json version == server/src/index.js 的 SERVER_INFO.version
 *  5. CHANGELOG.md 包含当前版本条目
 *  6. README 双语互链存在
 * 任一失败以非零退出码结束。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const failures = [];

function check(desc, fn) {
  try {
    const detail = fn();
    console.log(`ok    ${desc}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures.push(desc);
    console.error(`FAIL  ${desc} — ${err.message}`);
  }
}

function mustExist(rel) {
  if (!fs.existsSync(path.join(ROOT, rel))) throw new Error(`missing: ${rel}`);
  return rel;
}

function readJson(rel) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON: ${err.message}`);
  }
}

// 1) 关键文件
for (const rel of [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'README.md',
  'README.zh-CN.md',
  'CHANGELOG.md',
  'AGENTS.md',
  'LICENSE',
  'bin/dim-external-agents-extend',
  'server/src/index.js',
  'server/src/cli.js',
  'skills/external-agents-extend/SKILL.md',
  'hooks/hooks.json',
]) {
  check(`file exists: ${rel}`, () => mustExist(rel));
}

// 2) manifest JSON
let plugin = null;
check('parse: .codex-plugin/plugin.json', () => {
  plugin = readJson('.codex-plugin/plugin.json');
  return `name=${plugin.name}`;
});
check('parse: .mcp.json', () => readJson('.mcp.json') && '.mcp.json');

// 3) plugin.json 引用路径
if (plugin !== null) {
  for (const key of ['mcpServers', 'skills', 'hooks']) {
    check(`plugin.json ${key} path`, () => {
      const rel = plugin[key];
      if (typeof rel !== 'string' || rel.length === 0) throw new Error(`${key} is not a path string`);
      if (!fs.existsSync(path.join(ROOT, rel))) throw new Error(`missing: ${rel}`);
      return rel;
    });
  }
}

// 4) 版本一致性
let version = null;
check('version consistency (plugin.json == index.js SERVER_INFO)', () => {
  if (plugin === null) throw new Error('plugin.json not parsed');
  if (typeof plugin.version !== 'string' || plugin.version.length === 0) {
    throw new Error('plugin.json version is empty');
  }
  const src = fs.readFileSync(path.join(ROOT, 'server/src/index.js'), 'utf8');
  const m = /SERVER_INFO\s*=\s*\{[^}]*version:\s*'([^']+)'/.exec(src);
  if (m === null) throw new Error('SERVER_INFO.version not found in server/src/index.js');
  if (m[1] !== plugin.version) {
    throw new Error(`mismatch: plugin.json=${plugin.version} index.js=${m[1]}`);
  }
  version = plugin.version;
  return `version=${version}`;
});

// 5) CHANGELOG 含当前版本
check('CHANGELOG.md contains current version entry', () => {
  if (version === null) throw new Error('version unknown (previous check failed)');
  const text = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  if (!text.includes(`[${version}]`)) throw new Error(`no "[${version}]" entry in CHANGELOG.md`);
  return `[${version}]`;
});

// 6) README 双语互链
check('README language switch links', () => {
  const en = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const zh = fs.readFileSync(path.join(ROOT, 'README.zh-CN.md'), 'utf8');
  if (!en.includes('README.zh-CN.md')) throw new Error('README.md does not link to README.zh-CN.md');
  if (!zh.includes('README.md')) throw new Error('README.zh-CN.md does not link back to README.md');
  return 'README.md <-> README.zh-CN.md';
});

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
