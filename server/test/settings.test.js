'use strict';

/**
 * settings 测试：自动命名开关（**默认关闭**）的解析与写入。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  configPath,
  readSettings,
  writeSettings,
  autoNameStatus,
  isAutoNameEnabled,
} = require('../src/core/settings');

function mkHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ea-settings-test-'));
}

/** 在指定 home 下跑一段逻辑，并临时清掉可能影响判定的环境变量。 */
function withEnv(value, fn) {
  const saved = process.env.EA_EXT_AUTO_NAME;
  const savedCfg = process.env.EA_EXT_CONFIG;
  if (value === undefined) delete process.env.EA_EXT_AUTO_NAME;
  else process.env.EA_EXT_AUTO_NAME = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.EA_EXT_AUTO_NAME;
    else process.env.EA_EXT_AUTO_NAME = saved;
    if (savedCfg === undefined) delete process.env.EA_EXT_CONFIG;
    else process.env.EA_EXT_CONFIG = savedCfg;
  }
}

test('默认关闭：没有配置文件、没有环境变量 → autoName=false', () => {
  const home = mkHome();
  withEnv(undefined, () => {
    assert.equal(readSettings(home).autoName, false);
    assert.equal(isAutoNameEnabled(home), false);
    const status = autoNameStatus(home);
    assert.equal(status.enabled, false);
    assert.equal(status.source, 'default');
    assert.equal(status.configPath, configPath(home));
  });
});

test('配置文件可开启；损坏的配置回落到默认（关闭）', () => {
  const home = mkHome();
  writeSettings(home, { autoName: true });
  withEnv(undefined, () => {
    assert.equal(isAutoNameEnabled(home), true);
    assert.equal(autoNameStatus(home).source, 'config');
  });
  fs.writeFileSync(configPath(home), '{ not json');
  withEnv(undefined, () => {
    assert.equal(readSettings(home).autoName, false);
  });
});

test('writeSettings：保留其它未知键，并可再次关闭', () => {
  const home = mkHome();
  fs.mkdirSync(path.dirname(configPath(home)), { recursive: true });
  fs.writeFileSync(configPath(home), JSON.stringify({ autoName: true, keepMe: 'x' }));
  writeSettings(home, { autoName: false });
  const raw = JSON.parse(fs.readFileSync(configPath(home), 'utf8'));
  assert.equal(raw.autoName, false);
  assert.equal(raw.keepMe, 'x');
});

test('环境变量优先于配置文件，且能双向覆盖', () => {
  const home = mkHome();
  writeSettings(home, { autoName: true });
  withEnv('off', () => {
    assert.equal(isAutoNameEnabled(home), false);
    assert.equal(autoNameStatus(home).source, 'env');
  });
  writeSettings(home, { autoName: false });
  withEnv('on', () => {
    assert.equal(isAutoNameEnabled(home), true);
    assert.equal(autoNameStatus(home).source, 'env');
  });
  withEnv('whatever', () => {
    /* 无法识别的值不算显式开关 → 回落到配置文件 */
    assert.equal(autoNameStatus(home).source, 'config');
  });
});
