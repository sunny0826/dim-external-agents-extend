'use strict';
/**
 * 共享：记录「最近活跃的 dim 会话」（hook 侧入口）。
 *
 * 状态格式与读写逻辑统一放在 `server/src/core/active-session.js`，
 * 这里只做转发，保持 hook 的既有引用路径不变。
 */

module.exports = require('../server/src/core/active-session');
