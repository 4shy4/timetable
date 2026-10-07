// 单元测试：重复规则与课表周次展开（前后端同源逻辑的关键部分）
// 运行：node --test tools/
import test from 'node:test';
import assert from 'node:assert/strict';

import { occurrences, expandRange, intervalWeeksOf, freqLabelOf, applyPeriodLimit } from '../core/recurrence.js';
import { weekOfTerm, termStartFromWeek, mondayOf, toDateKey, addDays } from '../core/time.js';

const TERM_START = '2026-03-02'; // 周一

// ---------------------------------------------------------------------------
// 「周期」筛选（用户要的自由度）
// ---------------------------------------------------------------------------

/** 造一个"每周一"的重复事件，并展开成一个窗口内的实例 */
function weeklyMondays(extra = {}, from = '2026-03-01', to = '2026-04-30') {
  return expandRange(
    [{ id: 'w1', title: '每周例会', start: '2026-03-02T09:00:00', end: '2026-03-02T10:00:00', recurrence: { freq: 'weekly', byDay: [1] }, ...extra }],
    new Date(`${from}T00:00:00`), new Date(`${to}T00:00:00`), TERM_START,
  );
}

/**
 * "现在"必须显式传进去。
 *
 * ⚠️ 不传的话 `applyPeriodLimit` 会用真实的今天，而下面这些测试用的是 2026-03 的日期 ——
 *    跑到 2026-09 之后它们**全都变成"过去"，于是全部保留**，
 *    断言会以一种看起来毫不相关的方式失败。所以这里统一钉一个"现在"。
 */
const PERIOD_NOW = new Date('2026-03-01T00:00:00');

test('周期：不设 periodDays → 一颗都不筛（默认行为不能变）', () => {
  const all = weeklyMondays();
  assert.ok(all.length >= 4, `应当展开出多颗，实际 ${all.length}`);
  assert.equal(applyPeriodLimit(all, PERIOD_NOW).length, all.length);
  assert.equal(applyPeriodLimit(all).length, all.length, '不传 now 也不能筛');
});

test('周期：脏值不激活筛选（绝不因为一个坏值把事件全藏起来）', () => {
  for (const bad of [undefined, null, 0, -3, 'abc', '']) {
    const all = weeklyMondays({ periodDays: bad });
    assert.equal(applyPeriodLimit(all, PERIOD_NOW).length, all.length, `periodDays=${String(bad)} 不该筛`);
  }
});

test('周期：规则 B —— 只留「第一颗 + 周期」以内的', () => {
  // 每周一 → 间隔 7 天
  // 周期 3 天：第一颗之后的都超出 → 只剩第一颗
  assert.equal(applyPeriodLimit(weeklyMondays({ periodDays: 3 }), PERIOD_NOW).length, 1);
  // 周期 8 天：第二颗（+7 天）留着，第三颗（+14）筛掉
  assert.equal(applyPeriodLimit(weeklyMondays({ periodDays: 8 }), PERIOD_NOW).length, 2);
  // 周期 15 天：+0/+7/+14 都留，+21 筛掉
  assert.equal(applyPeriodLimit(weeklyMondays({ periodDays: 15 }), PERIOD_NOW).length, 3);
});

test('周期：这条能把"规则 B"和"相邻间隔"读法区分开（关键回归）', () => {
  // 每天重复 → 相邻间隔 1 天。
  // 相邻间隔读法（错的）在周期=3 时会**一直往下显示**（1 ≤ 3 永远成立）；
  // 规则 B 只留第一颗之后 3 天内的 → 共 4 颗（+0/+1/+2/+3）。
  const days = expandRange(
    [{ id: 'd1', title: '每天打卡', start: '2026-03-02T09:00:00', end: '2026-03-02T09:30:00', recurrence: { freq: 'daily', interval: 1 }, periodDays: 3 }],
    new Date('2026-03-02T00:00:00'), new Date('2026-03-15T00:00:00'), TERM_START,
  );
  assert.equal(days.length, 13, '展开窗口里应当有 13 颗（03-02…03-14，前置条件）');
  const kept = applyPeriodLimit(days, PERIOD_NOW);
  assert.equal(kept.length, 4, `规则 B 应当只留 4 颗，实际 ${kept.length}（多于 4 说明退成了"相邻间隔"读法）`);
  assert.deepEqual(kept.map((it) => toDateKey(it.start)), ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']);
});

test('周期：过去的实例永远保留（欠账攒着），只约束未来', () => {
  const ev = { id: 'd2', title: '每天打卡', start: '2026-03-02T09:00:00', end: '2026-03-02T09:30:00', recurrence: { freq: 'daily', interval: 1 }, periodDays: 2 };
  const now = new Date('2026-03-06T00:00:00');
  const items = expandRange([ev], new Date('2026-03-02T00:00:00'), new Date('2026-03-12T00:00:00'), TERM_START);
  const kept = applyPeriodLimit(items, now);
  const past = kept.filter((it) => it.start < now);
  const future = kept.filter((it) => it.start >= now);
  assert.equal(past.length, 4, '3/2–3/5 四颗过去的全部保留');
  assert.equal(future.length, 3, '未来以 3/6 为锚，周期 2 天 → 3/6、3/7、3/8');
  assert.deepEqual(future.map((it) => toDateKey(it.start)), ['2026-03-06', '2026-03-07', '2026-03-08']);
});

test('周期：多个事件各算各的锚点，互不影响', () => {
  const items = expandRange([
    { id: 'a', title: 'A', start: '2026-03-02T09:00:00', end: '2026-03-02T10:00:00', recurrence: { freq: 'weekly', byDay: [1] }, periodDays: 3 },
    { id: 'b', title: 'B', start: '2026-03-02T14:00:00', end: '2026-03-02T15:00:00', recurrence: { freq: 'weekly', byDay: [1] } },
  ], new Date('2026-03-01T00:00:00'), new Date('2026-04-30T00:00:00'), TERM_START);
  const kept = applyPeriodLimit(items, PERIOD_NOW);
  assert.equal(kept.filter((i) => i.event.id === 'a').length, 1, 'A 设了周期 → 只剩一颗');
  assert.ok(kept.filter((i) => i.event.id === 'b').length >= 4, 'B 没设周期 → 不受影响');
});

test('周期：单次日程不受影响（只有一颗，锚点就是它自己）', () => {
  const one = expandRange(
    [{ id: 's', title: '交作业', start: '2026-03-05T20:00:00', end: '2026-03-05T21:00:00', periodDays: 1 }],
    new Date('2026-03-01T00:00:00'), new Date('2026-03-10T00:00:00'),
  );
  assert.equal(applyPeriodLimit(one).length, 1);
});

test('周期：空输入不炸', () => {
  assert.deepEqual(applyPeriodLimit([]), []);
  assert.deepEqual(applyPeriodLimit(null), []);
  assert.deepEqual(applyPeriodLimit(undefined), []);
});

test('周期【回归】早就在跑的老重复事件不能整个消失', () => {
  // ⚠️ 这是上一版实现的严重 bug：
  //    气泡区的展开窗口是**往前 180 天**（bubble.js 的 LOOKBACK_DAYS），
  //    如果锚点取"窗口内第一颗"，对一个三个月前开始的每周事件来说，
  //    锚点就是三个月前 → 锚点+周期 早于今天 → **全部实例被筛掉，事件整个不见**。
  //    锚点必须是**第一个未来的实例**（过去的实例是欠账，永远保留）。
  const ev = {
    id: 'old', title: '三个月前开始的每周例会',
    start: '2026-06-01T09:00:00', end: '2026-06-01T10:00:00',
    recurrence: { freq: 'weekly', byDay: [1] }, periodDays: 3,
  };
  // 模拟气泡区：往前 180 天、往后 14 天
  const now = new Date('2026-09-21T12:00:00');
  const items = expandRange(
    [ev],
    new Date(now.getTime() - 180 * 86_400_000),
    new Date(now.getTime() + 14 * 86_400_000),
  );
  assert.ok(items.length > 10, `前置条件：应当展开出很多颗，实际 ${items.length}`);
  const kept = applyPeriodLimit(items, now);
  const future = kept.filter((it) => it.start.getTime() >= now.getTime());
  assert.ok(future.length >= 1, '未来至少要留一颗 —— 全没了说明锚点取错了');
  assert.equal(future.length, 1, '周期 3 天 < 每周 7 天 → 未来只该留最近那一颗');
  assert.ok(kept.some((it) => it.start.getTime() < now.getTime()), '过去的实例应当原样保留');
});

test('周期：锚点是"第一个未来的实例"，与窗口起点无关', () => {
  const ev = {
    id: 'w2', title: '每周一',
    start: '2026-03-02T09:00:00', end: '2026-03-02T10:00:00',
    recurrence: { freq: 'weekly', byDay: [1] }, periodDays: 8,
  };
  const now = new Date('2026-09-21T12:00:00');  // 周一中午
  // 两个起点差很多的窗口，未来部分的结果必须一致
  const a = expandRange([ev], new Date('2026-09-01T00:00:00'), new Date('2026-10-20T00:00:00'));
  const b = expandRange([ev], new Date(now.getTime() - 180 * 86_400_000), new Date('2026-10-20T00:00:00'));
  const fa = applyPeriodLimit(a, now).filter((it) => it.start >= now).map((it) => toDateKey(it.start));
  const fb = applyPeriodLimit(b, now).filter((it) => it.start >= now).map((it) => toDateKey(it.start));
  assert.deepEqual(fa, fb, '窗口起点不同，未来的保留结果必须一样');
  assert.equal(fb.length, 2, '周期 8 天 → 未来留两颗（+7 天之内）');
});

test('mondayOf 对周日返回上一个周一', () => {
  assert.equal(toDateKey(mondayOf(new Date('2026-03-08T10:00:00'))), '2026-03-02');
  assert.equal(toDateKey(mondayOf(new Date('2026-03-09T10:00:00'))), '2026-03-09');
});

test('weekOfTerm 正确计算学期周次', () => {
  assert.equal(weekOfTerm(new Date('2026-03-02T08:00:00'), TERM_START), 1);
  assert.equal(weekOfTerm(new Date('2026-03-09T08:00:00'), TERM_START), 2);
  assert.equal(weekOfTerm(new Date('2026-03-08T08:00:00'), TERM_START), 1); // 周日仍属第 1 周
  assert.equal(weekOfTerm(new Date('2026-03-16T08:00:00'), TERM_START), 3);
});

/**
 * 「第一周是哪天」应用自己不知道，只能让用户填；而"本周是第几周"用户几乎一定知道。
 * 所以课程表提供了"按本周校准" —— 这条测的就是那个反推公式：
 *   termStart = 本周一 − (N−1) 周
 * 用**往返关系**钉住它，因为"差一周"这种错最容易悄悄发生、而且界面上一眼看不出。
 */
test('termStartFromWeek 与 weekOfTerm 互为逆运算（往返一致）', () => {
  const days = [
    '2026-03-02T08:00:00', // 周一
    '2026-03-05T23:00:00', // 周四
    '2026-03-08T23:59:00', // 周日（仍属第 1 周）
    '2026-09-21T12:00:00', // 跨月
    '2026-12-31T12:00:00', // 跨年
  ];
  for (const d of days) {
    const day = new Date(d);
    for (const n of [1, 2, 3, 10, 16, 20]) {
      const start = termStartFromWeek(day, n);
      assert.ok(start, `第 ${n} 周应当能反推出日期`);
      assert.equal(toDateKey(start), toDateKey(mondayOf(start)), '反推出来的必须是周一');
      assert.equal(weekOfTerm(day, toDateKey(start)), n,
        `${d} 说"本周是第 ${n} 周"，反推出 termStart=${toDateKey(start)}，再算回来却是第 ${weekOfTerm(day, toDateKey(start))} 周`);
    }
  }
});

test('termStartFromWeek 对非法周次返回 null（不硬凑）', () => {
  const day = new Date('2026-03-05T08:00:00');
  assert.equal(termStartFromWeek(day, 0), null);
  assert.equal(termStartFromWeek(day, -3), null);
  assert.equal(termStartFromWeek(day, 'abc'), null);
  assert.equal(termStartFromWeek(day, ''), null);
});

test('单次日程只在窗口内出现一次', () => {
  const ev = { id: 'e1', title: '交作业', start: '2026-03-05T20:00:00', end: '2026-03-05T21:00:00', recurrence: { freq: 'none' } };
  const hit = occurrences(ev, new Date('2026-03-01T00:00:00'), new Date('2026-03-10T00:00:00'));
  assert.equal(hit.length, 1);
  assert.equal(toDateKey(hit[0]), '2026-03-05');
  const miss = occurrences(ev, new Date('2026-04-01T00:00:00'), new Date('2026-04-10T00:00:00'));
  assert.equal(miss.length, 0);
});

test('每周重复按 byDay 展开', () => {
  const ev = {
    id: 'e2', title: '英语角', start: '2026-03-03T19:00:00', end: '2026-03-03T20:00:00',
    recurrence: { freq: 'weekly', byDay: [2, 4] },
  };
  const hit = occurrences(ev, new Date('2026-03-02T00:00:00'), new Date('2026-03-16T00:00:00'));
  // 3/3(二) 3/5(四) 3/10(二) 3/12(四)
  assert.deepEqual(hit.map(toDateKey), ['2026-03-03', '2026-03-05', '2026-03-10', '2026-03-12']);
});

test('每两周重复隔周出现', () => {
  const ev = {
    id: 'e3', title: '组会', start: '2026-03-02T15:00:00', end: '2026-03-02T16:00:00',
    recurrence: { freq: 'biweekly', byDay: [1] },
  };
  const hit = occurrences(ev, new Date('2026-03-01T00:00:00'), new Date('2026-04-01T00:00:00'));
  assert.deepEqual(hit.map(toDateKey), ['2026-03-02', '2026-03-16', '2026-03-30']);
});

// ---- 「每 N 周」可自定义（用户要求：每周/每两周不够用）----

test('每三周：日期序列正确、间隔正好 21 天', () => {
  const ev = {
    id: 'e3w', title: '每三周会', start: '2026-03-02T15:00:00', end: '2026-03-02T16:00:00',
    recurrence: { freq: 'weekly', interval: 3, byDay: [1] },
  };
  const hit = occurrences(ev, new Date('2026-03-01T00:00:00'), new Date('2026-04-20T00:00:00'));
  assert.deepEqual(hit.map(toDateKey), ['2026-03-02', '2026-03-23', '2026-04-13']);
  const gaps = hit.slice(1).map((d, i) => (d - hit[i]) / 86_400_000);
  assert.deepEqual([...new Set(gaps)], [21], `间隔应当是 21 天，实际 ${[...new Set(gaps)]}`);
});

test('interval=1 等价于每周，interval=2 等价于旧的 biweekly', () => {
  const mk = (rec) => occurrences(
    { id: 'x', title: 'x', start: '2026-03-02T15:00:00', end: '2026-03-02T16:00:00', recurrence: rec },
    new Date('2026-03-01T00:00:00'), new Date('2026-04-01T00:00:00'),
  ).map(toDateKey);
  assert.deepEqual(mk({ freq: 'weekly', interval: 1, byDay: [1] }), mk({ freq: 'weekly', byDay: [1] }));
  assert.deepEqual(mk({ freq: 'weekly', interval: 2, byDay: [1] }), mk({ freq: 'biweekly', byDay: [1] }));
});

test('interval 边界归一化：0/负数/非数字 → 1，超上限 → 52', () => {
  assert.equal(intervalWeeksOf({ freq: 'weekly', interval: 0 }), 1);
  assert.equal(intervalWeeksOf({ freq: 'weekly', interval: -5 }), 1);
  assert.equal(intervalWeeksOf({ freq: 'weekly', interval: 'x' }), 1);
  assert.equal(intervalWeeksOf({ freq: 'weekly', interval: 999 }), 52);
  assert.equal(intervalWeeksOf({ freq: 'weekly' }), 1);
  assert.equal(intervalWeeksOf({ freq: 'biweekly' }), 2);   // 旧写法
  assert.equal(intervalWeeksOf(null), 1);
});

test('显示文字如实反映间隔（每三周不能显示成"每周"）', () => {
  assert.equal(freqLabelOf({ freq: 'weekly' }), '每周');
  assert.equal(freqLabelOf({ freq: 'weekly', interval: 1 }), '每周');
  assert.equal(freqLabelOf({ freq: 'biweekly' }), '每两周');
  assert.equal(freqLabelOf({ freq: 'weekly', interval: 2 }), '每两周');
  assert.equal(freqLabelOf({ freq: 'weekly', interval: 3 }), '每 3 周');
  assert.equal(freqLabelOf({ freq: 'none' }), '不重复');
});

test('每三周 + byDay 多天：每个选中星期都按同一个间隔走', () => {
  const ev = {
    id: 'e3m', title: '多天', start: '2026-03-02T15:00:00', end: '2026-03-02T16:00:00',
    recurrence: { freq: 'weekly', interval: 3, byDay: [1, 3] },   // 周一 + 周三
  };
  const hit = occurrences(ev, new Date('2026-03-01T00:00:00'), new Date('2026-04-01T00:00:00'));
  // 第 1 周：03-02(一) 03-04(三)；第 4 周：03-23(一) 03-25(三)；第 7 周：04-13 超出窗口
  assert.deepEqual(hit.map(toDateKey), ['2026-03-02', '2026-03-04', '2026-03-23', '2026-03-25']);
});

test('一周勾满 7 天：每天只算一次，不会重复膨胀', () => {
  // ⚠️ 真 bug 的回归：展开循环是**逐日**推进的，而对每个命中的日子都算同一个
  //    `occ`（时分只来自 start）。所以"一周勾了 7 天"时，那一周里 7 天都命中、
  //    weekDiff 都等于本周 —— 同一个发生时刻被 push 了 7 次。
  //    实测后果：气泡数从应有的 7 个涨到 45 个。
  const ev = {
    id: 'all7', title: '每天跑步', start: '2026-03-02T07:00:00', end: '2026-03-02T07:30:00',
    recurrence: { freq: 'weekly', byDay: [0, 1, 2, 3, 4, 5, 6] },
  };
  const hit = occurrences(ev, new Date('2026-03-02T00:00:00'), new Date('2026-03-09T00:00:00'));
  assert.equal(hit.length, 7, `一周应当恰好 7 次，实际 ${hit.length}`);
  assert.equal(new Set(hit.map((d) => d.getTime())).size, 7, '不能有重复时刻');
  assert.deepEqual(hit.map(toDateKey),
    ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']);
  // 三周窗口：从事件开始那天（03-02 周一）起 21 天 → 恰好 21 次。
  // ⚠️ 别用 03-01 起算 —— 那天是周日、早于事件开始，不该算进去（我第一版就写错了）。
  const wide = occurrences(ev, new Date('2026-03-02T00:00:00'), new Date('2026-03-23T00:00:00'));
  assert.equal(wide.length, 21, `三周应当 21 次，实际 ${wide.length}`);
});

test('每个重复实例有自己的 deadline（不再共用事件那一个）', () => {
  // 用户报的 bug：一周勾 7 天 → 7 个气泡显示**同一个**剩余时间。
  // 修法：expandRange 给每个实例算 occurrenceDeadline，气泡用它。
  const ev = {
    id: 'dl', title: '每天跑步', start: '2026-03-02T07:00:00', end: '2026-03-02T07:30:00',
    recurrence: { freq: 'weekly', byDay: [0, 1, 2, 3, 4, 5, 6] },
  };
  const items = expandRange([ev], new Date('2026-03-02T00:00:00'), new Date('2026-03-05T00:00:00'));
  assert.equal(items.length, 3);
  for (const it of items) {
    assert.ok(it.deadline instanceof Date, '每个实例都要带 deadline');
    // ⚠️ 没填显式 deadline 时，**到期 = 这件事结束**，所以取实例的 end（方案 C）。
    //    原来是取 start（"开始即到期"），会让 18:30–20:05 的课在 19:00 就变紫。
    //    提醒不受影响 —— 提醒点一向相对 start 算（core/reminder-plan.js）。
    assert.equal(it.deadline.getTime(), it.end.getTime(),
      `实例 ${toDateKey(it.start)} 的 deadline 应当等于它自己的结束时刻`);
  }
  // deadline 各不相同 —— 这正是"7 个气泡显示同一个时间"的修复点
  assert.equal(new Set(items.map((i) => i.deadline.getTime())).size, 3);
});

test('方案 C：没填 deadline 时"到期"取结束时间，不是开始时间', () => {
  // 用户明确选定的语义：18:30–20:05 的课在 19:00 应当"还剩 65 分钟"、不变紫。
  const course = {
    id: 'c1', title: '高等数学', type: 'course',
    start: '2026-03-02T18:30:00', end: '2026-03-02T20:05:00',
    recurrence: { freq: 'none' },
  };
  const [it] = expandRange([course], new Date('2026-03-02T00:00:00'), new Date('2026-03-03T00:00:00'));
  assert.equal(toDateKey(it.start), '2026-03-02');
  assert.equal(it.end.getTime() - it.start.getTime(), 95 * 60_000, '前置：这门课 95 分钟');
  assert.equal(it.deadline.getTime(), it.end.getTime(), '到期 = 下课（20:05），不是上课（18:30）');

  // 19:00 这一刻：不该算过期
  const now = new Date('2026-03-02T19:00:00');
  assert.ok(it.deadline.getTime() > now.getTime(), '19:00 时还没到期 → 不该变紫');
  // 提醒仍然是按 start 算的（20:05 前 10 分钟 ≠ 18:20）
  assert.equal(it.start.getTime() - 10 * 60_000, new Date('2026-03-02T18:20:00').getTime(),
    '提醒点相对开始时间（18:20），与"到期"无关');
});

test('填了显式 deadline 时，这段间隔被平移到每个实例上', () => {
  const ev = {
    id: 'span', title: '周三开始周五截止', start: '2026-03-04T09:00:00', end: '2026-03-04T10:00:00',
    deadline: '2026-03-06T18:00:00',
    recurrence: { freq: 'weekly', byDay: [3] },
  };
  const items = expandRange([ev], new Date('2026-03-01T00:00:00'), new Date('2026-03-20T00:00:00'));
  assert.ok(items.length >= 2, `应当展开出多次，实际 ${items.length}`);
  const want = new Date('2026-03-06T18:00:00').getTime() - new Date('2026-03-04T09:00:00').getTime();
  for (const it of items) {
    assert.equal(it.deadline.getTime() - it.start.getTime(), want,
      '每个实例都应保持"开始→截止"同样的间隔');
  }
});

test('重复在 until 之后停止', () => {
  const ev = {
    id: 'e4', title: '晨跑', start: '2026-03-03T06:30:00', end: '2026-03-03T07:00:00',
    recurrence: { freq: 'weekly', byDay: [2], until: '2026-03-10' },
  };
  const hit = occurrences(ev, new Date('2026-03-01T00:00:00'), new Date('2026-03-31T00:00:00'));
  assert.deepEqual(hit.map(toDateKey), ['2026-03-03', '2026-03-10']);
});

test('课表课程按 weeks 只在指定周次出现', () => {
  const ev = {
    id: 'course:高数', title: '高等数学', type: 'course',
    start: '2026-03-02T08:00:00', end: '2026-03-02T09:40:00',
    recurrence: { freq: 'none' }, weeks: [1, 2, 4],
  };
  const hit = occurrences(
    ev,
    new Date('2026-03-01T00:00:00'),
    new Date('2026-03-29T00:00:00'),
    TERM_START,
  );
  assert.deepEqual(hit.map(toDateKey), ['2026-03-02', '2026-03-09', '2026-03-23']);
});

test('单双周跳周导入（奇数周）', () => {
  const ev = {
    id: 'course:实验', title: '数据结构实验', type: 'course',
    start: '2026-03-06T14:00:00', end: '2026-03-06T15:40:00',
    recurrence: { freq: 'none' }, weeks: [1, 3, 5],
  };
  const hit = occurrences(
    ev,
    new Date('2026-03-01T00:00:00'),
    new Date('2026-04-01T00:00:00'),
    TERM_START,
  );
  // 第 1 周 → 3/6，第 3 周 → 3/20，第 5 周 → 4/3（超出查询窗口）
  assert.deepEqual(hit.map(toDateKey), ['2026-03-06', '2026-03-20']);
});

test('expandRange 结果按时间升序且带持续时间', () => {
  const events = [
    { id: 'a', title: 'A', start: '2026-03-04T09:00:00', end: '2026-03-04T10:00:00', recurrence: { freq: 'none' } },
    { id: 'b', title: 'B', start: '2026-03-03T09:00:00', end: '2026-03-03T09:30:00', recurrence: { freq: 'none' } },
  ];
  const items = expandRange(events, new Date('2026-03-01T00:00:00'), new Date('2026-03-10T00:00:00'));
  assert.deepEqual(items.map((i) => i.event.title), ['B', 'A']);
  assert.equal(items[0].end.getTime() - items[0].start.getTime(), 30 * 60_000);
});

test('addDays 跨月正确', () => {
  assert.equal(toDateKey(addDays(new Date('2026-03-31T12:00:00'), 1)), '2026-04-01');
  assert.equal(toDateKey(addDays(new Date('2026-03-01T12:00:00'), -1)), '2026-02-28');
});
