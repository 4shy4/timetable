// 「没设期限」的中性档 —— 契约 + 回归测试。
//
// 修的是什么（用户报的矛盾）：
//   没填截止时间的泡泡，`style.band` 落在**最紧迫**的"秒"档，可**同一颗泡泡**上
//   大小走 NEUTRAL_SIZE(0.30)、通知强度是 1（不催）、倒计时文字是"未设期限" ——
//   四支口径里只有档位在喊"马上到期"。
//
// 根因（两处都是同一个反模式：把"没期限"翻译成 `Infinity`）：
//   · `core/urgency.js` 的 `bubbleStyle()`：`bandForRemaining(remaining == null ? Infinity : remaining)`
//   · `web/ui/editor.js` 的自动提醒预览：`r == null ? Number.POSITIVE_INFINITY : r`
//   —— 而 `bandForRemaining()` 对**非有限数**是兜底到**最紧迫的秒档**的，
//      和"∞ = 很远 = 年档"的直觉正好相反。现在两处都喂 `null`，core 给中性档。
//
// 这个文件钉四件事：
//   ① 没期限 → 档位是中性的新键，文案是"未设期限"，强度 1，大小仍是中性的 0.30
//   ② 有期限的七档：阈值与语义**一字不变**（按 `bandForRemaining()` 的真值断言）
//   ③ 边界：0 / 负数 / 极大值 / 非有限数 / Invalid Date / 空串 / 缺字段 各自落在哪一档
//   ④ **通知计划一字不变**：对"没设期限"的事件，`core/notify-plan.js` 排出来的提醒计划
//      与本次修改**之前**抓下来的真实输出逐字段相等（见下面 FROZEN_PLAN）
//
// 跑法：node tools/bubble-band-unset.test.mjs
//
// ⚠️ 消费者清单（读 `style.band` / `bandLabel` / 档位键的地方，逐条核过）：
//   · `core/urgency.js:band/bandLabel`        —— 生产者。`remaining == null` → 'unset' / "未设期限"
//   · `core/bubble-select.js`（节日泡泡）      —— **整体覆写**成 'day' / "节日"，碰不到 unset
//   · `web/ui/editor.js:renderAutoReminders`  —— 唯一的界面查表 `label[info.band]`；
//                                                已补 `unset: '未设期限'` 一行（下面有源码断言钉住）
//   · `web/ui/views/bubble.js`                —— 不用 band（颜色/文字走 tierKey / countdownText），无需改
//   · `core/desktop-bubbles.js`（Windows 桌面层）—— 输出契约里**没有** band/bandLabel，无需改
//   · `core/state-ops.js:bandForEvent`        —— 另一条路：没期限时给 `{band:null, intensity:1}`（本来就中性）
//   · `server/scheduler.js` / `server/store.js` —— 只转发上面那条路的 `band`（可能为 null），不查表
//   · `core/countdown.js:bandIndex/bandByKey` —— 查表；`bandIndex('unset')` 已显式排到"最不紧迫"端，
//                                                `bandByKey('unset')` 故意 null（UNSET_BAND 上没有尺寸区间）
//   · `core/level.js:bandOverview`            —— 只列 TIME_BANDS 的七档（未设期限没尺寸区间，故意不进）
//   · `android/.../Store.kt`                  —— Kotlin 自己算档位，与 JS 的 unset 无关（本次未碰）
//   · `public/bubble-demo/`（生成物）          —— 本仓库的旧快照，未随本次重新生成（见汇报）
//
// 时区：第 ④ 条要逐字对照**冻结的输出**，而输出里的 `id`/`body` 带本地时间 →
//       先把时区钉死（这个项目在 +08:00 上用）。Node 在 `process.env.TZ` 变化时会
//       让时区缓存失效，所以下面这一行放在文件顶部就够（有前置断言兜着）。
process.env.TZ = 'Asia/Shanghai';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bubbleStyle } from '../core/urgency.js';
import {
  UNSET_BAND, bandForRemaining, bandIndex, bandByKey, sizeRatioForRemaining, NEUTRAL_SIZE,
  formatRemaining, MINUTE_MS, HOUR_MS, DAY_MS, WEEK_MS, MONTH_MS, YEAR_MS,
} from '../core/countdown.js';
import {
  BAND_INTENSITY, intensityForBand, reminderPlanForBand, notificationPlanForRemaining,
} from '../core/level.js';
import { effectiveReminders, inheritedOverdueOf } from '../core/state-ops.js';
import { planNotifications } from '../core/notify-plan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ===========================================================================
// 最小 DOM 桩 —— 只为把 `web/ui/editor.js` import 起来（第⑤/⑥条要断言它显示的那句话）
//
// 为什么需要：`web/ui/editor.js` → `web/ui/modal.js` 在**模块顶层**就
// `document.addEventListener('keydown', …)`，裸 Node 里 import 会直接 ReferenceError。
// 做法照抄 `tools/web-modules.test.mjs`（那边用同一套路把每个前端模块 import 一遍），
// 这里只留 editor.js 这条链真正会碰到的几个 API。
// ⚠️ `navigator` / `location` 在 Node 里是只读 getter，必须 `defineProperty` 覆盖。
// ===========================================================================
const defineGlobal = (name, value) => Object.defineProperty(globalThis, name, {
  value, writable: true, configurable: true, enumerable: false,
});
const stubEl = () => ({
  style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  dataset: {}, children: [], childNodes: [], value: '', textContent: '', hidden: false,
  appendChild(c) { this.children.push(c); return c; },
  append(...c) { this.children.push(...c); },
  removeChild() {}, remove() {}, insertBefore(n) { return this.appendChild(n); },
  addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null,
  removeAttribute() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  contains: () => true, focus() {}, click() {}, insertAdjacentHTML() {}, scrollIntoView() {},
  getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600, right: 800, bottom: 600 }),
  setPointerCapture() {}, releasePointerCapture() {}, getContext: () => null, toDataURL: () => 'data:,',
});
const stubDoc = {
  documentElement: stubEl(), head: stubEl(), body: stubEl(),
  createElement: () => stubEl(), createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  createDocumentFragment: () => stubEl(),
  getElementById: () => stubEl(), querySelector: () => stubEl(), querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', hidden: false,
  title: '', cookie: '', readyState: 'complete',
};
globalThis.Node = class Node {};
defineGlobal('document', stubDoc);
defineGlobal('window', {
  document: stubDoc,
  location: { protocol: 'http:', href: 'http://127.0.0.1:7080/' },
  navigator: { userAgent: 'node', language: 'zh-CN' },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout,
  setInterval: () => 0, clearInterval() {},
  requestAnimationFrame: () => 1, cancelAnimationFrame() {}, devicePixelRatio: 1,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  focus() {}, open() {}, Notification: undefined, AudioContext: undefined,
  CustomEvent: class CustomEvent { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
});
defineGlobal('navigator', globalThis.window.navigator);
defineGlobal('location', globalThis.window.location);
defineGlobal('CustomEvent', globalThis.window.CustomEvent);
defineGlobal('localStorage', {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
  clear() { this._m.clear(); },
});
defineGlobal('sessionStorage', globalThis.localStorage);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
defineGlobal('setInterval', () => 0);
defineGlobal('clearInterval', () => {});
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
globalThis.fetch = async () => { throw new Error('测试环境不联网'); };

// ⚠️ 必须是**动态** import：静态 import 会被提升到桩之前执行，editor.js 立刻炸。
const { autoReminderPreview } = await import('../web/ui/editor.js');

const NOW = new Date('2026-03-02T12:00:00');
/** 造一颗"还剩 ms 毫秒"的泡泡（`item.deadline` 是真期限，优先级和 state-ops 一致） */
const styleAt = (ms, ev = {}) => bubbleStyle({
  event: { id: 'e', title: 'x', level: 'sky', ...ev },
  start: NOW, end: NOW, deadline: new Date(NOW.getTime() + ms),
}, { now: NOW });

/** 造一颗"真·没期限"的泡泡：deadline / end / start 三样都算不出时刻 */
const styleNoDeadline = (over = {}) => bubbleStyle({
  event: { id: 'nodl', title: '没期限', level: 'sky', ...over.event },
  start: null, end: null, deadline: null, ...over.item,
}, { now: NOW });

// ===========================================================================
// 前置：时区真的钉住了（没钉住的话第 ④ 条会以一条看不懂的方式失败）
// ===========================================================================
test('前置：时区已钉在 +08:00（第④条逐字对照冻结输出，依赖固定时区）', () => {
  assert.equal(new Date('2026-03-02T06:00:00Z').getTimezoneOffset(), -480,
    'process.env.TZ 没生效 —— 本文件第④条要逐字对照冻结的 id/body（带本地时间），换时区会全错');
});

// ===========================================================================
// ① 没设期限 → 中性档
// ===========================================================================
test('① 没设期限：档位是中性新键、文案"未设期限"、强度 1、大小中性（四支口径第一次一致）', () => {
  assert.equal(UNSET_BAND.key, 'unset');
  assert.equal(UNSET_BAND.label, '未设期限');
  // 文案必须和倒计时/格式化的说法**同一个词**（同一件事两种说法就是下一个 bug）
  assert.equal(UNSET_BAND.label, formatRemaining(null), '档位文案和 formatRemaining(null) 必须一字不差');

  const st = styleNoDeadline();
  assert.equal(st.remaining, null, '没期限 → remaining 是 null（不是 0、不是 NaN）');
  assert.equal(st.band, 'unset', '档位必须是中性档，不是最紧迫的 second');
  assert.equal(st.bandLabel, '未设期限');
  assert.equal(st.intensity, 1, '没期限 → 不催');
  assert.equal(st.radiusRatio, NEUTRAL_SIZE, '大小仍是中性的 0.30（这条不许动）');
  assert.equal(NEUTRAL_SIZE, 0.30, 'NEUTRAL_SIZE 本身也不许动');
  assert.equal(st.overdue, false, '没期限不算过期（否则没填期限的全变紫）');
  assert.equal(st.ownOverdue, false);
  assert.equal(st.timeText, '未设期限');
  assert.equal(st.countdownText, '未设期限');
  assert.ok(Number.isFinite(st.radius) && st.radius > 0, '半径必须是有限正数（NaN 会炸整块画布）');
});

test('① `bandForRemaining(null/undefined)` 自己就回答 unset（不再靠"喂 Infinity"）', () => {
  assert.equal(bandForRemaining(null).key, 'unset');
  assert.equal(bandForRemaining(undefined).key, 'unset');
  assert.equal(bandForRemaining(null).label, '未设期限');
  // 三种"没期限"的脏写法都要认
  for (const [what, over] of [
    ['缺字段（deadline/end/start 都没有）', { event: { deadline: undefined } }],
    ['deadline 是空串', { event: { deadline: '' }, item: { deadline: '' } }],
    ['deadline 是 Invalid Date', { event: { deadline: new Date('x') }, item: { deadline: new Date('x') } }],
    ['deadline 显式 null', { event: { deadline: null } }],
  ]) {
    const st = styleNoDeadline(over);
    assert.equal(st.remaining, null, `${what} → remaining 应当是 null`);
    assert.equal(st.band, 'unset', `${what} → 应当落在中性档`);
    assert.equal(st.bandLabel, '未设期限', `${what} → 文案应当是"未设期限"`);
    assert.equal(st.intensity, 1, `${what} → 强度 1（不催）`);
    assert.equal(st.radiusRatio, NEUTRAL_SIZE, `${what} → 大小中性`);
  }
});

// ===========================================================================
// ② 有期限的七档：阈值与语义一字不变
// ===========================================================================
test('② 七档边界真值（`bandForRemaining` 的既有语义，一个字都不许变）', () => {
  // 表的顺序是"最不紧迫 → 最紧迫"，判据是 `ms >= band.min`，含下界不含上界
  const cases = [
    [YEAR_MS, 'year'], [2 * YEAR_MS, 'year'], [100 * YEAR_MS, 'year'],
    [MONTH_MS, 'month'], [YEAR_MS - 1, 'month'], [200 * DAY_MS, 'month'],
    [WEEK_MS, 'week'], [MONTH_MS - 1, 'week'], [20 * DAY_MS, 'week'],
    [DAY_MS, 'day'], [WEEK_MS - 1, 'day'], [3 * DAY_MS, 'day'],
    [HOUR_MS, 'hour'], [DAY_MS - 1, 'hour'], [23 * HOUR_MS, 'hour'],
    [MINUTE_MS, 'minute'], [HOUR_MS - 1, 'minute'], [59 * MINUTE_MS, 'minute'],
    [30_000, 'second'], [MINUTE_MS - 1, 'second'], [1, 'second'],
  ];
  const LABELS = { year: '年', month: '月', week: '周', day: '日', hour: '时', minute: '分', second: '秒' };
  const INTENSITY = { year: 1, month: 1, week: 1, day: 2, hour: 3, minute: 4, second: 4 };
  for (const [ms, key] of cases) {
    assert.equal(bandForRemaining(ms).key, key, `${ms}ms 应落在 ${key} 档`);
    const st = styleAt(ms);
    assert.equal(st.band, key, `${ms}ms 的泡泡档位应当是 ${key}`);
    assert.equal(st.bandLabel, LABELS[key], `${ms}ms 的档位文案应当是"${LABELS[key]}"`);
    assert.equal(st.intensity, INTENSITY[key], `${ms}ms 的通知强度应当是 ${INTENSITY[key]}`);
    assert.equal(st.overdue, false, `${ms}ms 还没到期`);
  }
  // 强度的真值表本身（七档 + 中性档）也要钉住
  assert.deepEqual(
    ['year', 'month', 'week', 'day', 'hour', 'minute', 'second', 'unset'].map((k) => intensityForBand(k)),
    [1, 1, 1, 2, 3, 4, 4, 1],
    '强度表：越接近截止越强；未设期限是中性 1（不催）',
  );
  assert.equal(BAND_INTENSITY.unset, 1, '未设期限的强度必须是显式的 1');
});

// ===========================================================================
// ③ 边界：0 / 负数 / 极大值 / 非有限数 / 脏期限
// ===========================================================================
test('③ 正好到期（remaining === 0）与负数（已逾期）都落在最紧迫的秒档，且文案是"已过期"', () => {
  for (const ms of [0, -1, -MINUTE_MS, -DAY_MS, -365 * DAY_MS]) {
    const st = styleAt(ms);
    assert.equal(st.remaining, ms, `${ms}: remaining 应当原样透出`);
    assert.equal(st.ownOverdue, true, `${ms}: 自己到期了`);
    assert.equal(st.band, 'second', `${ms}: 已过期 → 秒档（有期限口径未动）`);
    assert.equal(st.bandLabel, '已过期');
    assert.equal(st.intensity, 4, `${ms}: 已过期 → 强度拉满（原有语义）`);
    assert.equal(st.radiusRatio, 1.45, `${ms}: 已过期 → OVERDUE_SIZE（原有语义）`);
  }
  // 边界两侧必须是"0 及以下 → second / 1ms → second（同一档）"，而 null 才是 unset
  assert.equal(bandForRemaining(0).key, 'second');
  assert.equal(bandForRemaining(null).key, 'unset');
  assert.notEqual(bandForRemaining(0).key, bandForRemaining(null).key,
    '0（正好到期）和 null（没设期限）必须是两回事 —— `Number(null) === 0` 正是老 bug 的来源');
});

test('③ 极大值仍然落在年档', () => {
  /**
   * ⚠️ 这里分两种"极大值"，别混：
   *   · `bandForRemaining()` 是**纯算术**，`Number.MAX_SAFE_INTEGER` 照样是年档
   *   · 但泡泡的期限是 `Date`，而 Date 的上限是 ±8.64e15 ms（≈ 1 亿天）——
   *     `new Date(NOW + MAX_SAFE_INTEGER)` 是 **Invalid Date**，于是 `bubbleStyle`
   *     退回 `remainingMsOf(ev)`（事件没有期限）→ remaining = null → **中性档**。
   *     这不是"极大值算错了"，是"这个值根本表达不成一个日期"。所以下面用
   *     `100 * YEAR_MS` / `3650 天` 这种真能落成日期的极大值断言泡泡那一侧。
   */
  assert.equal(bandForRemaining(Number.MAX_SAFE_INTEGER).key, 'year',
    '纯算术：MAX_SAFE_INTEGER 远大于一年 → 年档');
  for (const ms of [100 * YEAR_MS, 3650 * DAY_MS, 20 * YEAR_MS]) {
    assert.equal(bandForRemaining(ms).key, 'year', `${ms}ms → 年档`);
    assert.equal(styleAt(ms).band, 'year', `${ms}ms 的泡泡 → 年档`);
    assert.equal(styleAt(ms).bandLabel, '年');
  }
  // Date 上限之外的值表达不成日期 → 泡泡那一侧只有"没期限"这一种答案（中性档）
  assert.equal(styleAt(Number.MAX_SAFE_INTEGER).band, 'unset',
    'Date 上限之外 → 期限算不出来 → 中性档（和"没设期限"同一支）');
});

test('③ 非有限数（NaN / ±Infinity）仍是**既有的秒档兜底**（本次刻意不动）', () => {
  // 为什么不动它：`remaining` 在产品里要么是有限数（deadline - now），要么是 null
  //   （没期限，由 core/state-ops.js 的 remainingMsOf 给）。NaN/Infinity 只可能来自
  //   调用方自己塞的脏 plumbing 值，不是"没设期限"的合法表示。
  //   本次要修的是"把 null 翻译成 Infinity"那个反模式，不是重定义非有限数。
  //   （`sizeRatioForRemaining` 对非有限数给的是 NEUTRAL_SIZE，所以严格说
  //     这里仍留着一处"大小中性、档位最紧迫"的不一致 —— 已在汇报里点出来，不顺手改。）
  for (const v of [NaN, Infinity, -Infinity]) {
    assert.equal(bandForRemaining(v).key, 'second', `${v} → 秒档（既有兜底，未动）`);
  }
  assert.equal(sizeRatioForRemaining(null), NEUTRAL_SIZE);
  assert.equal(sizeRatioForRemaining(NaN), NEUTRAL_SIZE);
  assert.equal(sizeRatioForRemaining(undefined), NEUTRAL_SIZE);
});

test('③ 查表落空也算得出来：bandIndex / bandByKey 对 unset 都有明确答案', () => {
  // 「未设期限」不在紧迫度刻度上 → 排到**最不紧迫**那一端（6），不是兜底的 0（最紧迫）
  assert.equal(bandIndex('unset'), bandIndex('year'), '未设期限应当和最不紧迫的年档同侧');
  assert.ok(bandIndex('unset') > bandIndex('month'));
  assert.ok(bandIndex('unset') > bandIndex('second'), '绝不能掉到 0（= 最紧迫）');
  // bandByKey 故意返回 null（UNSET_BAND 上没有 lo/hi/p），调用方必须自己处理"不在尺寸刻度上"
  assert.equal(bandByKey('unset'), null, 'bandByKey 不返回尺寸档记录（返回半截对象比 null 更危险）');
  assert.equal(bandByKey('year').key, 'year');
  // 中性档真的没有尺寸区间（谁把它当尺寸档读会读到 undefined → NaN，所以别这么用）
  assert.equal(UNSET_BAND.lo, undefined);
  assert.equal(UNSET_BAND.hi, undefined);
});

// ===========================================================================
// ④ 通知计划**一字不变**（最重要的一条回归）
// ===========================================================================
//
// 期望值是**改之前**用同一份固定 now / 固定事件快照跑 `planNotifications()` 抓下来的真实输出
// （不是手写的猜测值）。里面那条 `nodl-dirtyend` 就是"没设期限"的真身：
//   `start` 有、`end` 是脏值 'x' → `occurrenceDeadline()` 给 null →
//   `state-ops.remainingMsOf()` 给 null → `effectiveReminders()` 给 [0]（只准点提醒一次）。
// 结论：**通知计划与改前逐字段相等**（7 个字段 × 6 条），本次改动没有碰它。
const FROZEN_EVENTS = [
  // 真·没期限：deadline / end / start 一个都没有
  { id: 'nodl-none', title: '没期限', autoReminders: true, done: false },
  // 有 start、但 end 是脏值 → 这次发生的期限算不出来 → "没设期限"
  { id: 'nodl-dirtyend', title: '脏 end', start: '2026-03-02T14:00:00', end: 'x', autoReminders: true, done: false },
  // 普通事件：确认"有期限"那条路一个字节都没动
  { id: 'normal', title: '普通', start: '2026-03-02T15:00:00', end: '2026-03-02T16:00:00', autoReminders: true, done: false },
];

const FROZEN_PLAN = [
  {
    id: 'nodl-dirtyend@2026-03-02T14:00:00@0',
    eventId: 'nodl-dirtyend',
    title: '脏 end',
    body: '现在开始（14:00）',
    fireAt: '2026-03-02T06:00:00.000Z',
    intensity: 4,
    useAlarm: false,
    sound: 'timetable-alert-strong.wav',
  },
  {
    id: 'normal@2026-03-02T15:00:00@60',
    eventId: 'normal',
    title: '普通',
    body: '60 分钟后（15:00）',
    fireAt: '2026-03-02T06:00:00.000Z',
    intensity: 3,
    useAlarm: false,
    sound: 'timetable-alert.wav',
  },
  {
    id: 'normal@2026-03-02T15:00:00@30',
    eventId: 'normal',
    title: '普通',
    body: '30 分钟后（15:00）',
    fireAt: '2026-03-02T06:30:00.000Z',
    intensity: 4,
    useAlarm: false,
    sound: 'timetable-alert-strong.wav',
  },
  {
    id: 'normal@2026-03-02T15:00:00@10',
    eventId: 'normal',
    title: '普通',
    body: '10 分钟后（15:00）',
    fireAt: '2026-03-02T06:50:00.000Z',
    intensity: 4,
    useAlarm: false,
    sound: 'timetable-alert-strong.wav',
  },
  {
    id: 'normal@2026-03-02T15:00:00@0',
    eventId: 'normal',
    title: '普通',
    body: '现在开始（15:00）',
    fireAt: '2026-03-02T07:00:00.000Z',
    intensity: 4,
    useAlarm: false,
    sound: 'timetable-alert-strong.wav',
  },
  {
    id: 'normal@2026-03-02T15:00:00@-5',
    eventId: 'normal',
    title: '普通',
    body: '已开始 5 分钟（15:00）',
    fireAt: '2026-03-02T07:05:00.000Z',
    intensity: 4,
    useAlarm: false,
    sound: 'timetable-alert-strong.wav',
  },
];

test('④ 没设期限的事件：core/notify-plan.js 的计划与改前**逐字段相等**（回归）', () => {
  const plan = planNotifications({ events: FROZEN_EVENTS, now: NOW, horizonDays: 7 });
  // 整数组逐字段相等（deepEqual 会一个字段一个字段地报差异）：
  //   id / eventId / title / body / fireAt / intensity / useAlarm / sound
  assert.deepEqual(plan, FROZEN_PLAN, '通知计划漂了 —— 本次改动绝不该碰到任何提醒');
  // 单独再钉一遍"没期限"那条：只有**一条**，而且是准点（minutes = 0）
  const noDl = plan.filter((p) => p.eventId === 'nodl-dirtyend');
  assert.equal(noDl.length, 1, '没设期限的事件只该排一条（准点）');
  assert.ok(noDl[0].id.endsWith('@0'), '那一条必须是准点提醒（minutes = 0）');
  // 真正没有 start 的那条连实例都展开不出来 → 一条都不排（也确认没有抛错）
  assert.equal(plan.filter((p) => p.eventId === 'nodl-none').length, 0);
});

test('④ `effectiveReminders()`（真正会响的那份计划）对没期限仍然是 [0]', () => {
  // 这是"没设期限不打扰"的真值所在；本次改动一个字都没动它
  assert.deepEqual(effectiveReminders({ id: 'a', title: '没期限' }, NOW), [0]);
  assert.deepEqual(effectiveReminders({ id: 'a', title: '没期限', autoReminders: true }, NOW), [0]);
  // 有期限的仍然按档位加密（对照一下，证明上面不是"什么都没算"）。
  // ⚠️ 期限优先级是 deadline > end > start（core/state-ops.js 的 deadlineMsOf），
  //    所以下面这条 30 秒后结束 → remaining = 30 秒 → 秒档。
  const soon = { id: 'b', title: '马上', start: '2026-03-02T12:00:00', end: '2026-03-02T12:00:30' };
  assert.deepEqual(effectiveReminders(soon, NOW), reminderPlanForBand('second'));
  // 半小时后结束 → 分档（顺便把"档位真的跟着剩余时间走"这条也钉住）
  const halfHour = { id: 'c', title: '半小时', start: '2026-03-02T12:00:00', end: '2026-03-02T12:30:00' };
  assert.deepEqual(effectiveReminders(halfHour, NOW), reminderPlanForBand('minute'));
});

test('④ `notificationPlanForRemaining(null)` 现在也是中性的（编辑器的预览靠它说真话）', () => {
  // ⚠️ 以前 null 会掉进 `!(null > 0)` → 被当成**已过期**：强度 4 + "截止后追问"的计划，
  //    而真正会响的是 effectiveReminders 给的 [0] —— 编辑器的预览于是自相矛盾
  //    （「马上到期 · 强度 4」紧挨着"没有截止时间"）。现在两处口径一致。
  const info = notificationPlanForRemaining(null);
  assert.deepEqual(info, { band: 'unset', intensity: 1, plan: [0], overdue: false });
  // 有期限的语义一个字没变
  assert.deepEqual(notificationPlanForRemaining(-HOUR_MS), {
    band: 'second', intensity: 4, plan: reminderPlanForBand('minute'), overdue: true,
  });
  assert.deepEqual(notificationPlanForRemaining(3 * DAY_MS), {
    band: 'day', intensity: 2, plan: reminderPlanForBand('day'), overdue: false,
  });
});

// ===========================================================================
// ⑤ 编辑器那句"档位 · 强度"本身（`autoReminderPreview` 是界面真正用的那一个函数）
// ===========================================================================
test('⑤ 档位文案：七个档位 + 中性档都有人话，绝不把英文键印到界面上', () => {
  // 每个档位都要有对应文案（查表落空就会把 'unset' 这类键直接显示出来）
  const cases = [
    [400 * DAY_MS, '一年以上 · 强度 1'],
    [100 * DAY_MS, '一个月以上 · 强度 1'],
    [20 * DAY_MS, '一周以上 · 强度 1'],
    [3 * DAY_MS, '一天之内 · 强度 2'],
    [5 * HOUR_MS, '几小时内 · 强度 3'],
    [10 * MINUTE_MS, '几分钟内 · 强度 4'],
    [1500, '马上到期 · 强度 4'],
    [null, '未设期限 · 强度 1'],
    [Infinity, '未设期限 · 强度 1'],
    [NaN, '未设期限 · 强度 1'],
  ];
  for (const [ms, want] of cases) {
    const p = autoReminderPreview(ms);
    assert.equal(p.text, want, `${ms} 的标签文案不对`);
    // 文案里不许出现档位键那种英文（"unset" / "second" …）
    assert.ok(!/[a-z]{3,}/.test(p.text), `标签里混进了英文键：${p.text}`);
  }
  // 中性档那句必须和倒计时文字/档位 label 用同一个词
  assert.equal(autoReminderPreview(null).text.startsWith('未设期限'), true);
});

test('⑤ 自动提醒的计划文案也对得上（没期限 = 只准点一次，不是秒档那串追问）', () => {
  assert.equal(autoReminderPreview(null).planText, '准点', '没期限 → 只准点一次（和 effectiveReminders 的 [0] 一致）');
  // ⚠️ 小时档本身就带"截止后追问"（BAND_REMINDER_PLAN.hour = [60,30,10,0,-5]），别按"还早就不追问"想当然
  assert.equal(autoReminderPreview(5 * HOUR_MS).planText, '提前1小时 / 提前30分 / 提前10分 / 准点 / 截止后5分');
  // 秒档才有那一串密集的追问 —— 没期限的那一支绝不能出现负数那几条
  assert.ok(!autoReminderPreview(null).planText.includes('截止后'));
  assert.equal(autoReminderPreview(1500).planText, '提前10分 / 准点 / 截止后5分 / 截止后15分 / 截止后25分');
});

// ===========================================================================
// ⑥ 过期日程必须显示"已过期"（用户能看见的那个错）
//
// 老 bug：这一行读的是 `info.ownOverdue` / `info.overdueInherited`，而
// `notificationPlanForRemaining()` 从来不返回这两个字段（它只收一个数字）
// → 两个分支恒不生效 → **过期日程一直显示成「马上到期」**。
// 现在改读 `info.overdue`（在这个上下文里它**恒等于** `ownOverdue`，判据都是 remaining ≤ 0）。
// ===========================================================================
test('⑥ 自己过期 → "已过期"（不是"马上到期"），强度和计划仍是已过期那一套', () => {
  for (const ms of [0, -1, -HOUR_MS, -DAY_MS, -365 * DAY_MS]) {
    const p = autoReminderPreview(ms);
    assert.equal(p.text, '已过期 · 强度 4', `${ms}ms（自己已过期）应当显示"已过期"`);
    assert.notEqual(p.text, '马上到期 · 强度 4', '这就是用户报的那个错：过期了还说"马上到期"');
    assert.equal(p.info.overdue, true);
    assert.ok(p.planText.includes('截止后'), '已过期 → 计划里有"截止后追问"');
    assert.equal(p.color, '#ef4444');
  }
  // 还没到期的那一侧不许被误伤
  assert.equal(autoReminderPreview(1).text, '马上到期 · 强度 4', '还剩 1ms 是"马上到期"，不是"已过期"');
});

test('⑥ 只有**祖先**过期：编辑器这块预览照常显示自己的档位文案，不写"已过期"', () => {
  // 造一个"母泡泡早过期、子泡泡还没到"的真实结构
  const now = NOW;
  const parent = { id: 'p', title: '母', start: '2026-03-01T10:00:00', end: '2026-03-01T11:00:00' };
  const child = { id: 'c', title: '子', parentId: 'p', start: '2026-03-02T12:00:00', end: '2026-03-03T12:00:00' };
  const events = [parent, child];
  assert.equal(inheritedOverdueOf(child, events, now), true, '母泡泡确实过期了（祖先链判定）');
  // 气泡那一侧：颜色/档位只陈述自己，容器过期交给 overdueInherited（渲染层画虚线环）
  const st = bubbleStyle({
    event: child, start: new Date(child.start), end: new Date(child.end), deadline: new Date(child.end),
  }, { now, forceOverdue: inheritedOverdueOf(child, events, now) });
  assert.equal(st.overdueInherited, true);
  assert.equal(st.ownOverdue, false);
  // ⚠️ 两套文案别混：`bubbleStyle` 的 `bandLabel` 是**档位名**（'日'/'秒'/'年'，来自 TIME_BANDS），
  //    编辑器那句是**人话**（'一天之内'/'马上到期'）。同一个档位、两种说法，各自都别串味。
  assert.equal(st.band, 'day');
  assert.equal(st.bandLabel, '日', '档位文字只陈述自己 —— 子泡泡自己还没到期');
  // 编辑器这块预览只拿得到"自己还剩多久"，所以它说"一天之内"，**不是**"已过期"
  const p = autoReminderPreview(new Date(child.end).getTime() - now.getTime());
  assert.equal(p.text, '一天之内 · 强度 2');
  assert.ok(!p.text.includes('已过期'), '自己没过期就不能说"已过期"（那会和它的"剩余 N 天"自相矛盾）');
  // ⚠️ 也**不许**退回那个从来没显示成功过的"容器已过期"分支：那个词全仓库只在这里造过，
  //    而"容器过期"在项目里是用**视觉**表达的（气泡区一圈暗紫虚线环 / 桌面层契约的 ring）。
  assert.ok(!p.text.includes('容器'), '编辑器这块预览不陈述容器状态（没有事件链可查，说了就是编）');
});

test('⑥ 没过期 / 没期限：保持现状（没期限仍是上一轮改好的中性档）', () => {
  assert.equal(autoReminderPreview(3 * DAY_MS).text, '一天之内 · 强度 2');
  assert.equal(autoReminderPreview(null).text, '未设期限 · 强度 1');
  // 顺带钉住实现：不许再读那两个不存在/不可得的字段。
  // ⚠️ 先剥掉注释再查 —— editor.js 里那段"为什么不能读 ownOverdue"的说明**故意**提到了这两个名字，
  //    不剥注释的话这条断言会被自己的注释绊倒（踩过）。
  const src = fs.readFileSync(path.join(ROOT, 'web', 'ui', 'editor.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/info\.ownOverdue|info\.overdueInherited/.test(code),
    '不要再读 info.ownOverdue / info.overdueInherited —— notificationPlanForRemaining 不返回它们（恒 undefined）');
  assert.match(code, /info\.overdue \? '已过期'/, '过期那句必须读 info.overdue');
  assert.ok(!/renderAutoReminders\(autoHost,[^)]*POSITIVE_INFINITY/.test(code),
    '不要再把"没期限"翻译成 Infinity —— bandForRemaining 对非有限数的兜底是**最紧迫的秒档**');
});
