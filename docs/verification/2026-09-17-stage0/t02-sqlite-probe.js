#!/usr/bin/env node
/**
 * T0.2 验证探针：node:sqlite 只读 / WAL / 异常捕获
 *
 * 运行：mise exec -- node t02-sqlite-probe.js
 * 结论见同目录 RESULTS.md。本脚本只读访问本机数据库，不写入任何数据。
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');

const rows = [];
const t = (name, fn) => {
  try {
    const detail = fn();
    rows.push([name, 'OK', detail || '']);
  } catch (e) {
    rows.push([name, 'ERR', `${e.code || ''} ${e.message}`.trim()]);
  }
};

const dimDb = path.join(os.homedir(), '.dimcode/v2/dimcode.sqlite');

// 1) 活跃 WAL 库只读读取（dimcode.sqlite 有 -wal/-shm）
t('dimcode.sqlite readOnly count', () => {
  const db = new DatabaseSync(dimDb, { readOnly: true });
  const r = db.prepare("SELECT COUNT(*) c FROM background_tasks WHERE toolName='agent'").get();
  db.close();
  return `agent tasks = ${r.c}`;
});

// 2) 已知样本任务可读 + metadata JSON 抽取
t('sample task + metadata', () => {
  const db = new DatabaseSync(dimDb, { readOnly: true });
  const r = db
    .prepare(
      "SELECT taskId, status, json_extract(metadata,'$.externalAgentType') AS agent, startedAt FROM background_tasks WHERE taskId LIKE 'task_1789559570749%'"
    )
    .get();
  db.close();
  return JSON.stringify(r);
});

// 3) cursor store.db 只读（任一 ACP 会话；路径按本机实际替换）
t('cursor store.db readOnly', () => {
  const p = path.join(os.homedir(), '.cursor/acp-sessions/db7f3c1e-276a-4ec2-8e3f-fe7d485305fd/store.db');
  const db = new DatabaseSync(p, { readOnly: true });
  const r = db.prepare('SELECT COUNT(*) c FROM blobs').get();
  db.close();
  return `blobs = ${r.c}`;
});

// 4) 不存在的文件（只读打开不应创建）
t('missing file (expect ERR, no create)', () => {
  const p = '/tmp/agent-log-t02-missing.sqlite';
  const db = new DatabaseSync(p, { readOnly: true });
  db.close();
  return 'unexpectedly opened';
});

// 5) 非 SQLite 文件（打开不报错，查询时报错）
t('non-sqlite file (expect ERR)', () => {
  const db = new DatabaseSync('/etc/hosts', { readOnly: true });
  try {
    db.prepare('SELECT COUNT(*) c FROM sqlite_master').get();
  } finally {
    db.close();
  }
  return 'unexpectedly readable';
});

// 6) 垃圾文件：魔数正确但内容损坏
t('truncated sqlite header (expect ERR)', () => {
  const fs = require('node:fs');
  const p = '/tmp/agent-log-t02-corrupt.sqlite';
  fs.writeFileSync(p, Buffer.from('SQLite format 3\0', 'binary'));
  const db = new DatabaseSync(p, { readOnly: true });
  try {
    db.prepare('SELECT COUNT(*) c FROM sqlite_master').get();
  } finally {
    db.close();
  }
  return 'unexpectedly readable';
});

for (const r of rows) console.log(r.join(' | '));
