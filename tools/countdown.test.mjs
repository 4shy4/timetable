import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TIME_BANDS, NEUTRAL_SIZE, OVERDUE_SIZE,
  MINUTE_MS, HOUR_MS, DAY_MS, WEEK_MS, MONTH_MS, YEAR_MS,
  bandForRemaining, bandIndex, sizeRatioForRemaining, growthRatePerDay,
  breakdown, calendarDiff, formatRemaining, formatRemainingInUnit,
  tickUnitForParts, partsToMs, deadlineFromParts,
  describeParts, partsFromMs, deadlineFromDateParts,
} from '../core/countdown.js';

// 日历路径（年/月）需要一个固定的"现在"，否则结果随运行时间漂移
const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime();
/** 从 NOW 起算、真实日历意义上的 y 年 m 月 d 天 h 小时 */
const cal = (y = 0, m = 0, d = 0, h = 0) =>
  new Date(2026 + y, 0 + m, 15 + d, 12 + h, 0, 0).getTime() - NOW;

// ---------------------------------------------------------------------------
// 档位划分：必须"无缝且不重叠" —— 任意一个剩余时间只能落在唯一档里
// ---------------------------------------------------------------------------
test('档位边界：365天=年档、30天=月档、7天=周档、24小时=日档、1小时=时档、1分钟=分档', () => {
  assert.equal(bandForRemaining(YEAR_MS).key, 'year');
  assert.equal(bandForRemaining(MONTH_MS).key, 'month');
  assert.equal(bandForRemaining(WEEK_MS).key, 'week');
  assert.equal(bandForRemaining(DAY_MS).key, 'day');
  assert.equal(bandForRemaining(HOUR_MS).key, 'hour');
  assert.equal(bandForRemaining(MINUTE_MS).key, 'minute');
  assert.equal(bandForRemaining(30_000).key, 'second');
});

test('档位边界：刚过边界就落到下一个更紧迫的档', () => {
  assert.equal(bandForRemaining(MONTH_MS - 1).key, 'week');
  assert.equal(bandForRemaining(WEEK_MS - 1).key, 'day');
  assert.equal(bandForRemaining(DAY_MS - 1).key, 'hour');
  assert.equal(bandForRemaining(HOUR_MS - 1).key, 'minute');
  assert.equal(bandForRemaining(MINUTE_MS - 1).key, 'second');
});

test('年档没有上界：2 年也归年档', () => {
  assert.equal(bandForRemaining(2 * YEAR_MS).key, 'year');
  assert.equal(bandForRemaining(100 * YEAR_MS).key, 'year');
});

test('已过期 / 非法值都归秒档（最紧迫）', () => {
  assert.equal(bandForRemaining(0).key, 'second');
  assert.equal(bandForRemaining(-1).key, 'second');
  assert.equal(bandForRemaining(-DAY_MS).key, 'second');
});

// ---------------------------------------------------------------------------
// 尺寸曲线：连续、单调、档内加速 —— 用户最在意的"明显感受到紧迫"
// ---------------------------------------------------------------------------
test('尺寸比例落在用户指定的区间里（年5-10% 月10-20% 周20-35% 日35-55% 时55-80% 分80-110% 秒110-145%）', () => {
  const expected = {
    year: [0.05, 0.10],
    month: [0.10, 0.20],
    week: [0.20, 0.35],
    day: [0.35, 0.55],
    hour: [0.55, 0.80],
    minute: [0.80, 1.10],
    second: [1.10, 1.45],
  };
  const probes = {
    year: [YEAR_MS * 10, YEAR_MS * 2, YEAR_MS, YEAR_MS + DAY_MS],
    month: [DAY_MS * 300, DAY_MS * 90, DAY_MS * 45, DAY_MS * 31],
    week: [DAY_MS * 29, DAY_MS * 20, DAY_MS * 9, DAY_MS * 8],
    day: [DAY_MS * 6, DAY_MS * 3, DAY_MS * 2, DAY_MS + HOUR_MS],
    hour: [HOUR_MS * 23, HOUR_MS * 2, MINUTE_MS * 90, MINUTE_MS * 61],
    minute: [MINUTE_MS * 59, 30 * MINUTE_MS, 2 * MINUTE_MS, MINUTE_MS * 2 + 1],
    second: [999, 500, 1],
  };
  for (const [key, list] of Object.entries(probes)) {
    const [lo, hi] = expected[key];
    for (const ms of list) {
      const r = sizeRatioForRemaining(ms);
      assert.equal(bandForRemaining(ms).key, key, `${ms}ms 应落在 ${key} 档`);
      assert.ok(r >= lo - 1e-9 && r <= hi + 1e-9, `${ms}ms(${key}) → ${r} 超出 [${lo}, ${hi}]`);
    }
  }
});

test('尺寸曲线在年↔月接缝处只有一格台阶，其余接缝连续', () => {
  const start = 3 * YEAR_MS;
  const step = MINUTE_MS;
  let prev = sizeRatioForRemaining(start);
  let maxJump = 0;
  let maxJumpAt = 0;
  let seamJumps = 0;
  for (let ms = start - step; ms >= 1000; ms -= step) {
    const cur = sizeRatioForRemaining(ms);
    const jump = Math.abs(cur - prev);
    if (jump > 0.02) seamJumps += 1;
    if (jump > maxJump) { maxJump = jump; maxJumpAt = ms; }
    prev = cur;
  }
  assert.equal(seamJumps, 1, `只应有一个接缝台阶，实际有 ${seamJumps} 个`);
  assert.equal(Math.round(maxJumpAt / DAY_MS), 365, '台阶应当正好出现在 365 天处');
  assert.ok(maxJump < 0.16, `接缝台阶 ${maxJump} 应当小于月档宽度 0.10`);

  for (const seam of [30 * DAY_MS, 7 * DAY_MS, DAY_MS, HOUR_MS]) {
    const above = sizeRatioForRemaining(seam + MINUTE_MS);
    const below = sizeRatioForRemaining(seam - MINUTE_MS);
    assert.ok(Math.abs(below - above) < 0.02, `${seam}ms 处接缝跳变过大`);
  }
});

test('尺寸曲线单调：剩余时间越少，气泡越大（绝不回缩）', () => {
  let prev = -Infinity;
  for (let ms = 5 * YEAR_MS; ms >= 1000; ms -= HOUR_MS) {
    const r = sizeRatioForRemaining(ms);
    assert.ok(r >= prev - 1e-9, `${ms}ms 的尺寸 ${r} 小于更早的 ${prev}`);
    prev = r;
  }
});

test('档内增长加速：同一档里，靠后的增长率明显大于靠前', () => {
  const early = growthRatePerDay(DAY_MS * 6);
  const late = growthRatePerDay(DAY_MS * 1.5);
  assert.ok(late > early * 1.5, `周档后期增速 ${late} 应当明显大于前期 ${early}`);

  const early2 = growthRatePerDay(HOUR_MS * 20);
  const late2 = growthRatePerDay(HOUR_MS * 2);
  assert.ok(late2 > early2 * 1.5, `日档后期增速 ${late2} 应当明显大于前期 ${early2}`);
});

test('越接近截止，绝对增速越大（整体趋势）', () => {
  assert.ok(growthRatePerDay(20 * DAY_MS) > growthRatePerDay(300 * DAY_MS), '1 月 > 1 年');
  assert.ok(growthRatePerDay(20 * HOUR_MS) > growthRatePerDay(20 * DAY_MS), '1 天 > 1 月');
  assert.ok(growthRatePerDay(50 * MINUTE_MS) > growthRatePerDay(20 * HOUR_MS), '1 时 > 1 天');
});

test('没有截止时间 → 中性尺寸；已过期 → 最大尺寸', () => {
  assert.equal(sizeRatioForRemaining(null), NEUTRAL_SIZE);
  assert.equal(sizeRatioForRemaining(undefined), NEUTRAL_SIZE);
  assert.equal(sizeRatioForRemaining(NaN), NEUTRAL_SIZE);
  assert.equal(sizeRatioForRemaining(0), OVERDUE_SIZE);
  assert.equal(sizeRatioForRemaining(-DAY_MS), OVERDUE_SIZE);
});

test('尺寸区间相接，端点序列是等差 5,10,15,20,25,30,35', () => {
  for (let i = 1; i < TIME_BANDS.length; i += 1) {
    assert.equal(TIME_BANDS[i - 1].hi, TIME_BANDS[i].lo);
  }
  const ends = [TIME_BANDS[0].lo, ...TIME_BANDS.map((b) => b.hi)];
  assert.deepEqual(ends, [0.05, 0.10, 0.20, 0.35, 0.55, 0.80, 1.10, 1.45]);
  const steps = ends.slice(1).map((v, i) => Math.round((v - ends[i]) * 100));
  assert.deepEqual(steps, [5, 10, 15, 20, 25, 30, 35]);
});

// ---------------------------------------------------------------------------
// 周并入天（用户要"8 天"，不要"1 周 1 天"）
// ---------------------------------------------------------------------------
test('拆解时周并入天', () => {
  assert.equal(breakdown(8 * DAY_MS).day, 8);
  assert.equal(breakdown(8 * DAY_MS).week, 0);
  assert.equal(breakdown(20 * DAY_MS).day, 20);
  assert.equal(breakdown(6 * DAY_MS).day, 6);
  // 月以上仍按年/月拆
  const b = breakdown(3 * YEAR_MS + 4 * MONTH_MS + 5 * DAY_MS);
  assert.equal(b.year, 3);
  assert.equal(b.month, 4);
  assert.equal(b.day, 5);
});

// ---------------------------------------------------------------------------
// 两位显示：顶位 + 下一级（仅当总时长还装得下"上一级单位"）
// ---------------------------------------------------------------------------
test('两位显示：细单位（时/分/秒）带上下一级，粗单位（天）只报一级', () => {
  assert.equal(formatRemaining(45 * MINUTE_MS + 10_000), '剩余 45 分 10 秒');
  assert.equal(formatRemaining(2 * HOUR_MS + 3 * MINUTE_MS), '剩余 2 小时 3 分');
  // 到了"天"的量级只报天（floor，不进位）
  assert.equal(formatRemaining(DAY_MS + 2 * HOUR_MS), '剩余 1 天');
  assert.equal(formatRemaining(DAY_MS + 13 * HOUR_MS), '剩余 1 天');
  assert.equal(formatRemaining(3 * DAY_MS + 5 * HOUR_MS), '剩余 3 天');
});

test('两位显示：总时长超过上一级单位时不再带下一级', () => {
  assert.equal(formatRemaining(45 * MINUTE_MS), '剩余 45 分');
  assert.equal(formatRemaining(8 * DAY_MS), '剩余 8 天');
  assert.equal(formatRemaining(20 * DAY_MS), '剩余 20 天');
  assert.equal(formatRemaining(cal(1, 2), { now: NOW }), '剩余 1 年 2 月');
});

test('向下取整：只有"剩余"一种前缀，读数永不虚报', () => {
  assert.equal(formatRemaining(8 * DAY_MS), '剩余 8 天');
  // 差 1 分钟就不是 8 天了（floor），也不是"不足 8 天"
  assert.equal(formatRemaining(8 * DAY_MS - MINUTE_MS), '剩余 7 天');
  assert.equal(formatRemaining(3 * DAY_MS), '剩余 3 天');
  assert.equal(formatRemaining(3 * DAY_MS - MINUTE_MS), '剩余 2 天');
  assert.equal(formatRemaining(3 * MINUTE_MS), '剩余 3 分');
  assert.equal(formatRemaining(3 * MINUTE_MS - 1000), '剩余 2 分 59 秒');
  assert.equal(formatRemaining(MINUTE_MS), '剩余 1 分');
  // 不满一分钟就改用秒说
  assert.equal(formatRemaining(MINUTE_MS - 1000), '剩余 59 秒');
  assert.equal(formatRemaining(MINUTE_MS + 1000), '剩余 1 分 1 秒');
  // 任何输入都不该出现"不足"
  for (const ms of [1, 1000, MINUTE_MS - 1, 8 * DAY_MS - 1, 3 * YEAR_MS - 1, 24 * HOUR_MS - 1]) {
    assert.doesNotMatch(formatRemaining(ms, { now: NOW }), /不足/, `不该出现"不足"：${formatRemaining(ms, { now: NOW })}`);
  }
});

test('未设期限的显示', () => {
  assert.equal(formatRemaining(null), '未设期限');
  assert.equal(formatRemaining(undefined), '未设期限');
});

test('可以关掉前缀（气泡里空间不够时只显示数字单位）', () => {
  assert.equal(formatRemaining(8 * DAY_MS, { prefix: false }), '8 天');
  assert.equal(formatRemaining(45 * MINUTE_MS + 10_000, { prefix: false }), '45 分 10 秒');
});

// ---------------------------------------------------------------------------
// 日历借位：3 年 4 月必须按真实月份算，不能拿 30 天硬除
// ---------------------------------------------------------------------------
test('日历路径按真实月份借位：+3 年 4 月 → 剩余 3 年 4 月', () => {
  assert.equal(formatRemaining(cal(3, 4), { now: NOW }), '剩余 3 年 4 月');
  assert.equal(formatRemaining(cal(3, 0), { now: NOW }), '剩余 3 年');
  assert.equal(formatRemaining(cal(3, 4, 10), { now: NOW }), '剩余 3 年 4 月');
  // 差 1 小时：floor 掉一格 → "剩余 3 年 3 月"（不再是"不足 3 年 4 月"）
  assert.equal(formatRemaining(cal(3, 4, 0, -1), { now: NOW }), '剩余 3 年 3 月');
});

test('日历借位：跨月长度不一样也算对（1 月 31 日 + 1 月 = 2 月末）', () => {
  const jan31 = new Date(2026, 0, 31, 12, 0, 0).getTime();
  const feb28 = new Date(2026, 1, 28, 12, 0, 0).getTime();
  const diff = calendarDiff(jan31, feb28);
  assert.equal(diff.month, 0);
  assert.equal(diff.day, 28);
});

test('进位后低位满格要并进上位（不许出现"23 小时 60 分"这种读数）', () => {
  const H = 3_600_000; const MIN = 60_000; const S = 1000;
  assert.equal(formatRemaining(23 * H + 59 * MIN + 59 * S), '剩余 23 小时 59 分');
  assert.equal(formatRemaining(24 * H - S), '剩余 23 小时 59 分');
  // 绝不能出现"60 分""60 秒""13 月"这种不存在的读数
  for (const ms of [23 * H + 59 * MIN + 59 * S, 24 * H - 1, 59 * MIN + 59 * S, 3 * 365 * 86400_000 + 11 * 30 * 86400_000 + 29 * 86400_000]) {
    assert.doesNotMatch(formatRemaining(ms, { now: NOW }), /(6[0-9]|[7-9][0-9]) 分|(6[0-9]|[7-9][0-9]) 秒|(1[3-9]|[2-9][0-9]) 月/, `读数越界：${formatRemaining(ms, { now: NOW })}`);
  }
});

test('日历借位：天数与月数同时给出时互不干扰', () => {
  const d = calendarDiff(NOW, new Date(2026, 1, 20, 12, 0, 0).getTime());
  assert.equal(d.year, 0);
  assert.equal(d.month, 1);
  assert.equal(d.day, 5);
});

test('40 天（跨 2 月）→ 月+天 两位，各自向下取整', () => {
  // 40 天 = 1个整月 + 10天；显示两位（月带天，这样"1 月 25 天"和"1 月 2 天"能区分）
  assert.equal(formatRemaining(40 * DAY_MS, { now: NOW }), '剩余 1 月 9 天');
  assert.equal(formatRemaining(cal(0, 1), { now: NOW }), '剩余 1 月');
  // 差 1 天就不是整月了（1 月 15 日 + 1 月 = 2 月 15 日，差一天是 2 月 14 日 → 30 天）
  assert.equal(formatRemaining(cal(0, 1) - DAY_MS, { now: NOW }), '剩余 30 天');
});

// ---------------------------------------------------------------------------
// 距离输入：最小填写项 = 时间流逝单位
// ---------------------------------------------------------------------------
test('刻度 = 最小填写项：只填 3 周 → 周；3 年 4 月 → 月', () => {
  assert.equal(tickUnitForParts({ week: 3 }), 'week');
  assert.equal(tickUnitForParts({ year: 3, month: 4 }), 'month');
  assert.equal(tickUnitForParts({ year: 3, month: 4, day: 2 }), 'day');
  assert.equal(tickUnitForParts({ day: 5, hour: 3 }), 'hour');
  assert.equal(tickUnitForParts({ hour: 2, minute: 30 }), 'minute');
  assert.equal(tickUnitForParts({}), 'day');
});

test('用户举的例子：只填 3 周，倒计时按周推进（向下取整）', () => {
  const tick = tickUnitForParts({ week: 3 });
  assert.equal(tick, 'week');
  const t = (ms) => formatRemainingInUnit(ms, tick, { now: NOW });
  assert.equal(t(3 * WEEK_MS), '剩余 3 周');
  // 差 1 分钟就掉到 2 周（floor 的代价，换取"永不虚报"）
  assert.equal(t(3 * WEEK_MS - MINUTE_MS), '剩余 2 周');
  assert.equal(t(2 * WEEK_MS + 6 * DAY_MS), '剩余 2 周');
  assert.equal(t(2 * WEEK_MS), '剩余 2 周');
  assert.equal(t(WEEK_MS), '剩余 1 周');
  // 不到 1 周 → 退回按天说
  assert.equal(t(WEEK_MS - MINUTE_MS), '剩余 6 天');
  // 2.6 周 → 只有 2 个整周
  assert.equal(t(Math.floor(WEEK_MS * 2.6)), '剩余 2 周');
  assert.equal(t(3 * DAY_MS), '剩余 3 天');
  // 刻度模式下也不该出现"不足"
  for (const ms of [3 * WEEK_MS - 1, WEEK_MS - 1, 2 * DAY_MS + 5 * HOUR_MS]) {
    assert.doesNotMatch(t(ms), /不足/, `不该出现"不足"：${t(ms)}`);
  }
});

test('用户举的例子：3 年 4 月按"月"推进，并按 12 月一年写成 年+月', () => {
  const tick = tickUnitForParts({ year: 3, month: 4 });
  assert.equal(tick, 'month');
  const t = (ms) => formatRemainingInUnit(ms, tick, { now: NOW });
  assert.equal(t(cal(3, 4)), '剩余 3 年 4 月');
  assert.equal(t(cal(3, 3)), '剩余 3 年 3 月');
  // 差 1 小时 → 只有 39 个整月
  assert.equal(t(cal(3, 4) - 3600000), '剩余 3 年 3 月');
  assert.equal(t(cal(3, 4) - 20 * DAY_MS), '剩余 3 年 3 月');
});

test('刻度：不到一格就退回更小的单位显示', () => {
  const tick = tickUnitForParts({ week: 3 });
  const t = (ms) => formatRemainingInUnit(ms, tick, { now: NOW });
  assert.equal(t(3 * DAY_MS), '剩余 3 天');
  assert.equal(t(2 * DAY_MS + 5 * HOUR_MS), '剩余 2 天');
  // 30 天 = 4 个整周
  assert.equal(t(30 * DAY_MS), '剩余 4 周');
  // 差一点点到 1 周 → 退回按天说
  assert.equal(t(WEEK_MS - MINUTE_MS), '剩余 6 天');
});

test('距离输入换算成截止时间点：按**日历**相加（不是固定天数）', () => {
  const at = new Date(2026, 0, 1, 12, 0, 0).getTime();
  // 3 周：日历相加与 21 天完全一致
  const dl = deadlineFromParts({ week: 3 }, at);
  assert.equal(dl.getTime() - at, 3 * WEEK_MS);
  // 3 年 4 月：日历上是 3 个日历年 + 4 个月（含闰年 1457 天），
  // 而固定长度口径只有 365×3 + 30×4 = 1455 天 —— 必须按日历落点
  const cal = deadlineFromParts({ year: 3, month: 4 }, at);
  assert.equal(cal.getTime(), new Date(2029, 4, 1, 12, 0, 0).getTime());
  assert.notEqual(cal.getTime() - at, 3 * YEAR_MS + 4 * MONTH_MS);
  assert.equal(partsToMs({ year: 3, month: 4 }), 3 * YEAR_MS + 4 * MONTH_MS, 'partsToMs 仍是固定长度口径');
  assert.equal(describeParts({ year: 3, month: 4 }), '3 年 4 月');
  assert.equal(describeParts({ week: 3 }), '3 周');
});

test('partsFromMs 是 partsToMs 的逆（截断到单位）', () => {
  const ms = 3 * YEAR_MS + 4 * MONTH_MS;
  const parts = partsFromMs(ms);
  assert.deepEqual(parts, { year: 3, month: 4 });
  assert.equal(partsToMs(parts), ms);
});

// ---------------------------------------------------------------------------
// 确切日期：无需都填，缺的按粒度起点补齐
// ---------------------------------------------------------------------------
test('只填年 → 那年 1 月 1 日 00:00', () => {
  const d = deadlineFromDateParts({ year: 2027 });
  assert.equal(d.getFullYear(), 2027);
  assert.equal(d.getMonth(), 0);
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 0);
});

test('填年月 → 那个月 1 日；填年月日时分 → 精确到分', () => {
  const a = deadlineFromDateParts({ year: 2027, month: 6 });
  assert.equal(a.getMonth(), 5);
  assert.equal(a.getDate(), 1);

  const b = deadlineFromDateParts({ year: 2027, month: 6, day: 15, hour: 9, minute: 30 });
  assert.equal(b.getMonth(), 5);
  assert.equal(b.getDate(), 15);
  assert.equal(b.getHours(), 9);
  assert.equal(b.getMinutes(), 30);
  assert.equal(b.getSeconds(), 0);
});

test('没有年份 → 无法算截止时间', () => {
  assert.equal(deadlineFromDateParts({ month: 6 }), null);
  assert.equal(deadlineFromDateParts({}), null);
});

// ---------------------------------------------------------------------------
// 档位序号（用于"翻档"提示）
// ---------------------------------------------------------------------------
test('档位序号越小越紧迫', () => {
  assert.ok(bandIndex('second') < bandIndex('minute'));
  assert.ok(bandIndex('minute') < bandIndex('hour'));
  assert.ok(bandIndex('hour') < bandIndex('day'));
  assert.ok(bandIndex('day') < bandIndex('week'));
  assert.ok(bandIndex('week') < bandIndex('month'));
  assert.ok(bandIndex('month') < bandIndex('year'));
});

test('breakdown 拆解正确（秒级）', () => {
  const b = breakdown(3 * DAY_MS + 6 * HOUR_MS + 7 * MINUTE_MS + 8_000);
  assert.equal(b.day, 3);
  assert.equal(b.hour, 6);
  assert.equal(b.minute, 7);
  assert.equal(b.second, 8);
});
