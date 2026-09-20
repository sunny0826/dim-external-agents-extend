'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isGenericTitle,
  normalizeTitle,
  firstMeaningfulLine,
  cwdLabel,
  shortId,
  deriveSessionTitle,
  formatStamp,
  formatDisplayName,
  formatWritebackTitle,
  stripSourceMarker,
  stripDelegationPrefix,
  looksDelegated,
} = require('../src/core/session-name');

/* ---------------------------- isGenericTitle ----------------------------- */

test('isGenericTitle：识别各 agent 的通用标题', () => {
  const generic = [
    '',
    '   ',
    'Help',
    'help',
    'Untitled',
    'New session',
    'New session - 2026-09-16T14:12:03.160Z',
    '2026-09-16',
    '2026-09-16T14:12:03.160Z',
    '019e6844-f541-78e1-a035-bb7cd6e37d4b',
    'session_c476669d-1330-47b6-880a-f6758f39cd33',
    'ses_f55708c27ffesc7SG7k5MdEPo4',
    '%2FUsers%2Fguoxudong%2Fcodes',
    '/Users/guoxudong/codes/project-v',
    'Session 3',
    'codex',
    'Kimi Code',
    '你好',
  ];
  for (const t of generic) assert.equal(isGenericTitle(t), true, `应判为通用：${JSON.stringify(t)}`);
});

test('isGenericTitle：有信息量的标题不误判', () => {
  const good = [
    '修复 GUO-108 审查问题（P0/P1/P2）',
    'Maintain local skill',
    'Project V Reviewer',
    'Generate random integer 1 to 100',
    '美化社区页面文章卡片展示',
  ];
  for (const t of good) assert.equal(isGenericTitle(t), false, `不应判为通用：${JSON.stringify(t)}`);
});

test('isGenericTitle：与 cwd / sessionId 相同时判为通用', () => {
  assert.equal(isGenericTitle('/Users/guoxudong/codes/project-v', { cwd: '/Users/guoxudong/codes/project-v' }), true);
  assert.equal(isGenericTitle('project-v', { cwd: '/Users/guoxudong/codes/project-v' }), true);
  assert.equal(isGenericTitle('abc-123', { sessionId: 'abc-123' }), true);
});

test('isGenericTitle：被委托样板占据的标题判为通用', () => {
  const dumped =
    'You are an agent handling a delegated task. Focus on the task described below. Complete it within the specified scope.';
  assert.equal(isGenericTitle(dumped), true);
  assert.equal(isGenericTitle('You are an agent handling a delegated task. Focus on the ta…'), true);
  /* 含任务信息的标题（哪怕带「你是…」前缀）不算通用 */
  assert.equal(isGenericTitle('你是 Project V 仓库的执行开发者。任务：时间轴统一横向滚动轴重构'), false);
});

/* ----------------------------- normalizeTitle ---------------------------- */

test('normalizeTitle：去 Markdown 装饰、压空白、去首尾标点', () => {
  assert.equal(normalizeTitle('# 修复 **登录** 问题'), '修复 登录 问题');
  assert.equal(normalizeTitle('- 处理 `wire.jsonl` 解析'), '处理 wire.jsonl 解析');
  assert.equal(normalizeTitle('见 [文档](https://example.com) 说明'), '见 文档 说明');
  assert.equal(normalizeTitle('  多行\n文本  '), '多行 文本');
  assert.equal(normalizeTitle('：修复问题。'), '修复问题');
});

test('normalizeTitle：超长截断并加省略号', () => {
  const out = normalizeTitle('a'.repeat(200), 20);
  assert.equal(out.length, 20);
  assert.ok(out.endsWith('…'));
});

test('normalizeTitle：代码块整体丢弃，空输入返回空串', () => {
  assert.equal(normalizeTitle('```js\nconst a = 1;\n```'), '');
  assert.equal(normalizeTitle(''), '');
  assert.equal(normalizeTitle(undefined), '');
});

/* --------------------------- firstMeaningfulLine -------------------------- */

test('firstMeaningfulLine：优先取含 Issue token 的行', () => {
  const prompt = ['你是 Project V 的执行开发者。', '', '# 工作目录', '/Users/guoxudong/codes/project-v', '', '任务：修复 GUO-108 的字幕样式'].join('\n');
  assert.equal(firstMeaningfulLine(prompt), '任务：修复 GUO-108 的字幕样式');
});

test('firstMeaningfulLine：首行是样板 → 整段判为包装 prompt，返回空', () => {
  const wrapped = [
    'You are an agent handling a delegated task.',
    'Focus on the task described below.',
    '## Nowledge Mem routing',
    'Use Nowledge Mem as the source for cross-tool context.',
    'For continuation, review, regression, release work, run one targeted search.',
  ].join('\n');
  assert.equal(firstMeaningfulLine(wrapped), '');
});

test('firstMeaningfulLine：跳过样板行与纯路径，取普通首行', () => {
  assert.equal(firstMeaningfulLine('清理 dirty 文件\n\n详情见 /tmp/x'), '清理 dirty 文件');
  assert.equal(firstMeaningfulLine('[Slock inbox notice: Inbox update: 2 unread messages]'), '');
  assert.equal(firstMeaningfulLine('<system-reminder>\n真正的任务：修 UI\n</system-reminder>'), '真正的任务：修 UI');
});

/* ------------------------------- 兜底命名 -------------------------------- */

test('cwdLabel / shortId：忽略无信息段', () => {
  assert.equal(cwdLabel('/Users/guoxudong/codes/project-v/'), 'project-v');
  assert.equal(cwdLabel('.'), '');
  assert.equal(cwdLabel('/'), '');
  assert.equal(cwdLabel('~'), '');
  assert.equal(shortId('session_c476669d-1330-47b6-880a-f6758f39cd33'), 'c476669d');
  assert.equal(shortId('ses_f55708c27ffesc7SG7k5MdEPo4'), 'f55708c2');
  assert.equal(shortId(''), '');
});

/* ---------------------------- deriveSessionTitle -------------------------- */

test('deriveSessionTitle：dim 任务标题优先', () => {
  const r = deriveSessionTitle({ dimTaskTitle: '审查 GUO-108 PR #121', rawTitle: 'Code Review Agent', prompt: '随便什么' });
  assert.equal(r.title, '审查 GUO-108 PR #121');
  assert.equal(r.source, 'dim-task');
});

test('deriveSessionTitle：无 dim 任务时用会话自身标题', () => {
  const r = deriveSessionTitle({ rawTitle: '维护本地 skill' });
  assert.equal(r.title, '维护本地 skill');
  assert.equal(r.source, 'session');
});

test('deriveSessionTitle：自身标题通用时退到 prompt', () => {
  const r = deriveSessionTitle({ rawTitle: 'New session - 2026-09-16T14:12:03.160Z', prompt: '独立审查 PR #53：SRT/VTT 导出' });
  assert.equal(r.title, '独立审查 PR #53：SRT/VTT 导出');
  assert.equal(r.source, 'prompt');
});

test('deriveSessionTitle：全都不可用时兜底为「未命名会话 · 短码/cwd」', () => {
  const byId = deriveSessionTitle({ rawTitle: '', prompt: null, sessionId: 'session_e5ca069c-4f18', agentType: 'kimi' });
  assert.equal(byId.title, '未命名会话 · e5ca069c');
  assert.equal(byId.source, 'fallback');
  const byCwd = deriveSessionTitle({ rawTitle: 'Help', cwd: '/Users/guoxudong/codes/project-v', agentType: 'codex' });
  assert.equal(byCwd.title, '未命名会话 · project-v');
});

/* ------------------------------- 格式化 ---------------------------------- */

test('formatStamp / formatDisplayName：统一展示格式', () => {
  const at = new Date(2026, 8, 19, 20, 31);
  assert.equal(formatStamp(at), '09-19 20:31');
  assert.equal(
    formatDisplayName({ agentType: 'codex', createdAt: at, title: '修复 GUO-108 审查问题' }),
    '[codex] 09-19 20:31 · 修复 GUO-108 审查问题'
  );
  assert.equal(formatDisplayName({ agentType: null, createdAt: null, title: '' }), '[unknown] --:-- · 未命名会话');
});

test('formatWritebackTitle：带来源标记，且二次格式化不会叠加标记', () => {
  const at = new Date(2026, 8, 19, 20, 31);
  assert.equal(formatWritebackTitle({ title: '审查 PR #121', createdAt: at }), '审查 PR #121');
  assert.equal(formatWritebackTitle({ title: '审查 PR #121', createdAt: at, collision: true }), '审查 PR #121 · 09-19');
  assert.equal(formatWritebackTitle({ title: '', createdAt: at }), '未命名会话');
  /* 来源标记：dim 委托 / 其它来源 */
  assert.equal(formatWritebackTitle({ title: '修复 GUO-108', source: 'dim' }), '[dim] 修复 GUO-108');
  assert.equal(formatWritebackTitle({ title: '维护本地 skill', source: 'manual' }), '[手动] 维护本地 skill');
  assert.equal(formatWritebackTitle({ title: '修复 GUO-108', source: 'dim', prefix: false }), '修复 GUO-108');
  /* 幂等：已经带标记的标题不会变成 `[dim] [dim] …` */
  assert.equal(formatWritebackTitle({ title: '[dim] 修复 GUO-108', source: 'dim' }), '[dim] 修复 GUO-108');
  assert.equal(formatWritebackTitle({ title: '[手动] 维护 skill', source: 'manual' }), '[手动] 维护 skill');
  /* 换来源时按新来源重新标注 */
  assert.equal(formatWritebackTitle({ title: '[手动] 修复 GUO-108', source: 'dim' }), '[dim] 修复 GUO-108');
  assert.equal(stripSourceMarker('[dim] abc'), 'abc');
  assert.equal(stripSourceMarker('abc'), 'abc');
});

test('formatDisplayName：展示名 = [agent] 时间 · 统一名', () => {
  const at = new Date(2026, 8, 19, 20, 31);
  const name = formatWritebackTitle({ title: '修复 GUO-108 审查问题', source: 'dim' });
  assert.equal(
    formatDisplayName({ agentType: 'codex', createdAt: at, title: name }),
    '[codex] 09-19 20:31 · [dim] 修复 GUO-108 审查问题'
  );
});

test('stripDelegationPrefix：剥掉委托前缀，只留任务信息', () => {
  assert.equal(
    stripDelegationPrefix('你是 Project V 仓库的执行开发者。任务：时间轴统一横向滚动轴重构'),
    '任务：时间轴统一横向滚动轴重构'
  );
  assert.equal(stripDelegationPrefix('你是实现者'), '');
  assert.equal(stripDelegationPrefix('实现 M9-01 自动命名'), '实现 M9-01 自动命名');
  assert.equal(stripDelegationPrefix(''), '');
});

test('isGenericTitle：只剩委托前缀的标题算泛化，带任务信息的不算', () => {
  assert.equal(isGenericTitle('你是实现者'), true);
  assert.equal(isGenericTitle('你是 Project V 仓库的执行开发者。任务：时间轴重构'), false);
});

test('deriveSessionTitle：会话自身标题带委托前缀时会剥掉前缀', () => {
  const r = deriveSessionTitle({ rawTitle: '你是 Project V 仓库的执行开发者。任务：时间轴重构' });
  assert.equal(r.title, '任务：时间轴重构');
  assert.equal(r.source, 'session');
});

test('looksDelegated：识别委托 prompt，用户手打的标题不算', () => {
  assert.equal(looksDelegated('You are an agent handling a delegated task.\nFocus…'), true);
  assert.equal(looksDelegated('你是 Project V 仓库的执行开发者。任务：时间轴重构'), true);
  assert.equal(looksDelegated('Project V Reviewer'), false);
  assert.equal(looksDelegated('实现 M9-01 自动命名'), false);
  assert.equal(looksDelegated(''), false);
});
