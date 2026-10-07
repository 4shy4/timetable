import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEVELS, DEFAULT_LEVEL, levelByKey, rankOf, canNestInside, allowedChildLevels,
  isLeafLevel, levelFromLegacyMagnitude, BAND_INTENSITY, intensityForBand,
  reminderPlanForBand, notificationPlanForRemaining, notifyStyleForIntensity,
  bandOverview, NOTIFY_INTENSITY, clampIntensity, resolveIntensity,
} from '../core/level.js';
import { MINUTE_MS, HOUR_MS, DAY_MS, WEEK_MS, MONTH_MS, YEAR_MS } from '../core/countdown.js';

// ---------------------------------------------------------------------------
// 四档颜色与等级
// ---------------------------------------------------------------------------
test('四档颜色顺序固定：蓝 < 绿 < 黄 < 红', () => {
  assert.deepEqual(LEVELS.map((l) => l.key), ['sky', 'emerald', 'amber', 'red']);
  assert.deepEqual(LEVELS.map((l) => l.rank), [0, 1, 2, 3]);
  assert.equal(rankOf('sky'), 0);
  assert.equal(rankOf('red'), 3);
});

test('未知等级回落到默认（不抛错）', () => {
  assert.equal(levelByKey('nope').key, DEFAULT_LEVEL);
  assert.equal(levelByKey(null).key, DEFAULT_LEVEL);
  assert.equal(rankOf(undefined), rankOf(DEFAULT_LEVEL));
});

// ---------------------------------------------------------------------------
// 套娃规则：元素框等级必须**严于**父容器
// ---------------------------------------------------------------------------
test('套娃规则：红色里能有黄/绿/蓝，不能有红', () => {
  assert.equal(canNestInside('red', 'amber'), true);
  assert.equal(canNestInside('red', 'emerald'), true);
  assert.equal(canNestInside('red', 'sky'), true);
  assert.equal(canNestInside('red', 'red'), false, '同级不能嵌套');
});

test('套娃规则：黄色里只能有绿/蓝，绿色里只能有蓝，蓝色是叶子', () => {
  assert.equal(canNestInside('amber', 'emerald'), true);
  assert.equal(canNestInside('amber', 'sky'), true);
  assert.equal(canNestInside('amber', 'amber'), false);
  assert.equal(canNestInside('amber', 'red'), false);

  assert.equal(canNestInside('emerald', 'sky'), true);
  assert.equal(canNestInside('emerald', 'emerald'), false);
  assert.equal(canNestInside('emerald', 'amber'), false);

  assert.equal(isLeafLevel('sky'), true);
  assert.equal(isLeafLevel('emerald'), false);
  assert.equal(isLeafLevel('red'), false);
});

test('蓝色什么都装不下（双击只抖一下）', () => {
  for (const key of LEVELS.map((l) => l.key)) {
    assert.equal(canNestInside('sky', key), false, `蓝色不该能装 ${key}`);
  }
});

test('allowedChildLevels 给出容器里允许的颜色', () => {
  assert.deepEqual(allowedChildLevels('red').map((l) => l.key), ['sky', 'emerald', 'amber']);
  assert.deepEqual(allowedChildLevels('amber').map((l) => l.key), ['sky', 'emerald']);
  assert.deepEqual(allowedChildLevels('emerald').map((l) => l.key), ['sky']);
  assert.deepEqual(allowedChildLevels('sky').map((l) => l.key), []);
});

// ---------------------------------------------------------------------------
// 旧数据迁移
// ---------------------------------------------------------------------------
test('旧的 magnitude(1–100) 映射成四档，信息不丢', () => {
  assert.equal(levelFromLegacyMagnitude(100), 'red');
  assert.equal(levelFromLegacyMagnitude(80), 'red');
  assert.equal(levelFromLegacyMagnitude(79), 'amber');
  assert.equal(levelFromLegacyMagnitude(60), 'amber');
  assert.equal(levelFromLegacyMagnitude(59), 'emerald');
  assert.equal(levelFromLegacyMagnitude(40), 'emerald');
  assert.equal(levelFromLegacyMagnitude(39), 'sky');
  assert.equal(levelFromLegacyMagnitude(1), 'sky');
});

test('旧的 importance(1–5) 也映射成四档', () => {
  assert.equal(levelFromLegacyMagnitude(5), 'red');
  assert.equal(levelFromLegacyMagnitude(4), 'amber');
  assert.equal(levelFromLegacyMagnitude(3), 'emerald');
  assert.equal(levelFromLegacyMagnitude(2), 'sky');
  assert.equal(levelFromLegacyMagnitude(1), 'sky');
});

test('空值 / 非法值给默认档', () => {
  assert.equal(levelFromLegacyMagnitude(null), 'sky');
  assert.equal(levelFromLegacyMagnitude(undefined), 'sky');
  assert.equal(levelFromLegacyMagnitude(NaN), 'sky');
  assert.equal(levelFromLegacyMagnitude(0), 'sky');
});

// ---------------------------------------------------------------------------
// 通知强度：改按剩余时间档位
// ---------------------------------------------------------------------------
test('通知强度随剩余时间收紧：周以上→1、日→2、时→3、分秒→4', () => {
  assert.equal(intensityForBand('year'), 1);
  assert.equal(intensityForBand('month'), 1);
  assert.equal(intensityForBand('week'), 1);
  assert.equal(intensityForBand('day'), 2);
  assert.equal(intensityForBand('hour'), 3);
  assert.equal(intensityForBand('minute'), 4);
  assert.equal(intensityForBand('second'), 4);
});

test('通知强度单调不减：剩余时间越少，强度越高', () => {
  const marks = [YEAR_MS * 3, MONTH_MS * 6, WEEK_MS * 2, DAY_MS * 3, HOUR_MS * 10, MINUTE_MS * 30, 5000];
  let prev = 0;
  for (const ms of marks) {
    const i = notificationPlanForRemaining(ms).intensity;
    assert.ok(i >= prev, `${ms}ms 的强度 ${i} 小于更早的 ${prev}`);
    prev = i;
  }
  assert.equal(prev, 4, '最后一档应当是最高强度');
});

test('提醒计划随档位加密', () => {
  assert.ok(reminderPlanForBand('year').length <= 2);
  assert.ok(reminderPlanForBand('day').length >= 4);
  assert.ok(reminderPlanForBand('second').length >= 4);
  // 临近截止的计划里要有"截止之后追问"（负值）
  assert.ok(reminderPlanForBand('hour').some((m) => m < 0));
  assert.ok(reminderPlanForBand('second').some((m) => m < 0));
  // 还早的时候不要追问
  assert.ok(!reminderPlanForBand('year').some((m) => m < 0));
});

test('已过期 → 最高强度和追问计划', () => {
  const p = notificationPlanForRemaining(-HOUR_MS);
  assert.equal(p.overdue, true);
  assert.equal(p.intensity, 4);
  assert.ok(p.plan.some((m) => m < 0));
});

test('弹窗强度表：强度 4 才必看', () => {
  assert.equal(notifyStyleForIntensity(1).requireInteraction, false);
  assert.equal(notifyStyleForIntensity(3).requireInteraction, false);
  assert.equal(notifyStyleForIntensity(4).requireInteraction, true);
  assert.ok(notifyStyleForIntensity(4).durationMs > notifyStyleForIntensity(1).durationMs);
  // 越界值被夹住
  assert.equal(notifyStyleForIntensity(0).intensity, 1);
  assert.equal(notifyStyleForIntensity(99).intensity, 4);
});

test('bandOverview 把七档按"最不紧迫 → 最紧迫"列全', () => {
  const rows = bandOverview();
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.map((r) => r.band), ['year', 'month', 'week', 'day', 'hour', 'minute', 'second']);
  for (const r of rows) {
    assert.ok(r.sizeLo < r.sizeHi, `${r.band} 的尺寸区间应当递增`);
    assert.ok(r.intensity >= 1 && r.intensity <= 4);
    assert.ok(Array.isArray(r.reminders));
  }
});

test('BAND_INTENSITY 覆盖了全部七个档位', () => {
  for (const key of ['year', 'month', 'week', 'day', 'hour', 'minute', 'second']) {
    assert.ok(BAND_INTENSITY[key] >= 1, `${key} 缺少强度定义`);
  }
});

// ---------------------------------------------------------------------------
// 提醒强度可由用户调（用户报："我要平板端提醒强度"）
// ---------------------------------------------------------------------------

test('clampIntensity 把任何值夹进 1–4', () => {
  assert.equal(clampIntensity(1), 1);
  assert.equal(clampIntensity(4), 4);
  assert.equal(clampIntensity(0), 1);
  assert.equal(clampIntensity(99), 4);
  assert.equal(clampIntensity(2.6), 3, '应当四舍五入');
  // 非法值给 1 —— 不要因为一个脏值把提醒弄哑
  assert.equal(clampIntensity('abc'), 1);
  assert.equal(clampIntensity(null), 1);
  assert.equal(clampIntensity(undefined), 1);
});

test('resolveIntensity：auto 用自动值，数字强制覆盖', () => {
  assert.equal(resolveIntensity('auto', 2), 2, 'auto 应当沿用自动算出的档');
  assert.equal(resolveIntensity(undefined, 3), 3, '没设置也等于 auto');
  assert.equal(resolveIntensity(null, 3), 3);
  assert.equal(resolveIntensity('', 3), 3);
  assert.equal(resolveIntensity(4, 1), 4, '用户强制 4 档时，自动值 1 不该把它拉回来');
  assert.equal(resolveIntensity(1, 4), 1, '用户强制 1 档时，也应当听话');
  assert.equal(resolveIntensity('3', 1), 3, '字符串数字也认（设置从 JSON 来可能是字符串）');
});

test('resolveIntensity：非法设置退回自动，而不是退回最弱', () => {
  // ⚠️ 这条是刻意的：设置里一个脏值不该让所有提醒变成最弱档 ——
  //    那种故障几乎不可能被联想到是设置问题（而且用户会以为提醒坏了）。
  assert.equal(resolveIntensity('loud', 3), 3);
  assert.equal(resolveIntensity({}, 2), 2);
  assert.equal(resolveIntensity(NaN, 4), 4);
});

test('NOTIFY_INTENSITY：强度越高，停留越久、重复越多、音量越大', () => {
  let prev = NOTIFY_INTENSITY[1];
  for (const lv of [2, 3, 4]) {
    const cur = NOTIFY_INTENSITY[lv];
    assert.ok(cur.durationMs >= prev.durationMs, `强度 ${lv} 的停留时长不该变短`);
    assert.ok(cur.repeats >= prev.repeats, `强度 ${lv} 的重复次数不该变少`);
    assert.ok(cur.volume > prev.volume, `强度 ${lv} 的音量应当更大`);
    prev = cur;
  }
  // 只有最高档"不自动消失"（对齐电脑端 Toast 的 urgent）
  assert.equal(NOTIFY_INTENSITY[1].requireInteraction, false);
  assert.equal(NOTIFY_INTENSITY[2].requireInteraction, false);
  assert.equal(NOTIFY_INTENSITY[3].requireInteraction, false);
  assert.equal(NOTIFY_INTENSITY[4].requireInteraction, true);
});

test('notifyStyleForIntensity：越界与脏值都被夹住', () => {
  assert.equal(notifyStyleForIntensity(99).intensity, 4);
  assert.equal(notifyStyleForIntensity(-5).intensity, 1);
  assert.equal(notifyStyleForIntensity('x').intensity, 1);
  assert.equal(notifyStyleForIntensity(3).requireInteraction, false);
});
