// 节日表 + 农历换算的验证。
//
// ⚠️ 这个文件的第一要务是**核对农历表**：那张表只要错一个 bit，某一年的春节就会差一天，
//    而"看着都对"是这类表最危险的地方。所以这里用的全是**公开可查的确定日期**。
//
// 跑法：node tools/holidays.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { solarToLunar, lunarToSolar, lunarDateName, LUNAR_MAX_YEAR } from '../core/lunar.js';
import {
  FESTIVALS, FESTIVAL_COLORS, festivalsInYear, festivalsOn, festivalDate,
  upcomingFestivals, festivalEvents, festivalCountdownText, termDate,
} from '../core/holidays.js';

const ymd = (r) => (r ? `${r.y}-${String(r.m).padStart(2, '0')}-${String(r.d).padStart(2, '0')}` : null);

// ---------------------------------------------------------------------------
// ① 农历换算：拿已知日期逐个核对
// ---------------------------------------------------------------------------
test('农历：春节（正月初一）多年核对', () => {
  // 这些日期是公开知道的春节，错一天就会被抓住
  const known = {
    2000: '2000-02-05', 2010: '2010-02-14', 2020: '2020-01-25', 2021: '2021-02-12',
    2022: '2022-02-01', 2023: '2023-01-22', 2024: '2024-02-10', 2025: '2025-01-29',
    2026: '2026-02-17', 2027: '2027-02-06', 2028: '2028-01-26', 2030: '2030-02-03',
  };
  for (const [y, date] of Object.entries(known)) {
    assert.equal(ymd(lunarToSolar(Number(y), 1, 1)), date, `${y} 年春节`);
    // 反着也要对：那天的农历必须是正月初一
    const [yy, mm, dd] = date.split('-').map(Number);
    const l = solarToLunar(yy, mm, dd);
    assert.equal(l.month, 1, `${date} 的农历月`);
    assert.equal(l.day, 1, `${date} 的农历日`);
  }
});

test('农历：2026 年的几个节日（和台历对得上）', () => {
  // 2026：中秋 9/25（用户自己的数据里那条"中秋任务合集"就是这天）、端午 6/19、元宵 3/3
  assert.equal(ymd(lunarToSolar(2026, 8, 15)), '2026-09-25', '中秋');
  assert.equal(ymd(lunarToSolar(2026, 5, 5)), '2026-06-19', '端午');
  assert.equal(ymd(lunarToSolar(2026, 1, 15)), '2026-03-03', '元宵');
  assert.equal(ymd(lunarToSolar(2026, 7, 7)), '2026-08-19', '七夕');
  assert.equal(ymd(lunarToSolar(2026, 9, 9)), '2026-10-18', '重阳');
  // 除夕 = 腊月最后一天（2026 春节是 2/17 → 除夕是 2/16）
  assert.equal(ymd(lunarToSolar(2025, 12, 30)) || ymd(lunarToSolar(2025, 12, 29)), '2026-02-16', '除夕');
});

test('农历：闰月要认（2023 闰二月、2025 闰六月）', () => {
  // 2023 年闰二月；闰二月初一 = 2023-03-22
  assert.equal(ymd(lunarToSolar(2023, 2, 1, true)), '2023-03-22', '2023 闰二月初一');
  const l = solarToLunar(2023, 3, 22);
  assert.equal(l.month, 2);
  assert.equal(l.isLeap, true, '这天应当被认成闰月');
  // 2025 年闰六月
  assert.equal(ymd(lunarToSolar(2025, 6, 1, true)), '2025-07-25', '2025 闰六月初一');
  // 不闰的那个月传 true 要老实返回 null（不许硬算）
  assert.equal(lunarToSolar(2026, 2, 1, true), null, '2026 没有闰二月');
});

test('农历：范围和脏输入', () => {
  assert.equal(solarToLunar(1899, 12, 31), null, '表外要返回 null，不许猜');
  assert.equal(solarToLunar(LUNAR_MAX_YEAR + 1, 1, 1), null);
  assert.equal(solarToLunar(2026, 13, 1), null);
  assert.equal(lunarToSolar(2026, 13, 1), null);
  assert.equal(lunarToSolar(2026, 1, 31), null, '农历一个月没有 31 天');
  assert.equal(solarToLunar('x', 1, 1), null);
});

test('农历：汉字说法', () => {
  assert.equal(lunarDateName(1, 1), '正月初一');
  assert.equal(lunarDateName(8, 15), '八月十五');
  assert.equal(lunarDateName(12, 30), '腊月三十');
  assert.equal(lunarDateName(2, 1, true), '闰二月初一');
  assert.equal(lunarDateName(7, 20), '七月二十');
});

// ---------------------------------------------------------------------------
// ② 节日表
// ---------------------------------------------------------------------------
test('节日表：字段完整、key 不重复、都排得上日期', () => {
  const keys = new Set();
  for (const f of FESTIVALS) {
    assert.ok(f.key && !keys.has(f.key), 'key 重复或缺失：' + f.key);
    keys.add(f.key);
    assert.ok(f.name, f.key + ' 缺名字');
    assert.ok(f.blessing && f.blessing.length >= 4, f.key + ' 缺祝福语（用户要求备注里要有）');
    assert.ok(f.intro && f.intro.length >= 8, f.key + ' 缺介绍（用户要求备注里要有）');
    assert.ok(['lunar', 'solar', 'term'].includes(f.kind), f.key + ' 的 kind 不认识');
    // 每个节日在 2024–2035 里至少能算出一次日期
    let hit = false;
    for (let y = 2024; y <= 2035 && !hit; y += 1) hit = !!festivalDate(f, y);
    assert.ok(hit, f.key + ' 在 2024–2035 里算不出日期');
  }
  // "包括但不限于中国传统节日和热门节日"：两边都得有
  assert.ok(FESTIVALS.some((f) => f.key === 'chunjie') && FESTIVALS.some((f) => f.key === 'zhongqiu'), '缺传统节日');
  assert.ok(FESTIVALS.some((f) => f.key === 'shengdan') && FESTIVALS.some((f) => f.key === 'yuandan'), '缺热门节日');
  assert.ok(FESTIVALS.length >= 25, '节日太少：' + FESTIVALS.length);
});

test('节日表：2026 年的日期逐条对（月历要照这个挂标签）', () => {
  const list = festivalsInYear(2026);
  const byKey = Object.fromEntries(list.map((f) => [f.key, f.date]));
  assert.equal(byKey.yuandan, '2026-01-01');
  assert.equal(byKey.chunjie, '2026-02-17');
  assert.equal(byKey.qingren, '2026-02-14');
  assert.equal(byKey.yuanxiao, '2026-03-03');
  assert.equal(byKey.qingming, '2026-04-05');
  assert.equal(byKey.laodong, '2026-05-01');
  assert.equal(byKey.muqin, '2026-05-10', '母亲节 = 5 月第二个星期日');
  assert.equal(byKey.duanwu, '2026-06-19');
  assert.equal(byKey.fuqin, '2026-06-21', '父亲节 = 6 月第三个星期日');
  assert.equal(byKey.qixi, '2026-08-19');
  assert.equal(byKey.jiaoshi, '2026-09-10');
  assert.equal(byKey.zhongqiu, '2026-09-25');
  assert.equal(byKey.guoqing, '2026-10-01');
  assert.equal(byKey.chongyang, '2026-10-18');
  assert.equal(byKey.shengdan, '2026-12-25');
  assert.equal(byKey.dongzhi, '2026-12-22');
  // 排序过
  const dates = list.map((f) => f.date);
  assert.deepEqual(dates, dates.slice().sort(), '应当按日期排好序');
});

test('节日表：除夕/腊月节日要能跨年归到对的那一年', () => {
  // 2026 年 2 月 16 日是除夕（2025 农历腊月最后一天）
  const onEve = festivalsOn(2026, 2, 16).map((f) => f.key);
  assert.ok(onEve.includes('chuxi'), '2026-02-16 应当是除夕：' + onEve.join(','));
  // 2027 年 1 月的腊八/小年属于 2026 农历年，但公历归到 2027
  const list2027 = festivalsInYear(2027).map((f) => f.key);
  assert.ok(list2027.includes('chunjie'), '2027 应当有春节');
});

test('节日表：按天查（月历格子用）', () => {
  assert.deepEqual(festivalsOn(2026, 9, 25).map((f) => f.name), ['中秋节']);
  assert.deepEqual(festivalsOn(2026, 3, 8).map((f) => f.name), ['妇女节']);
  assert.deepEqual(festivalsOn(2026, 9, 24).map((f) => f.name), []);
});

// ---------------------------------------------------------------------------
// ③ 气泡区：还剩 N 天时浮出来
// ---------------------------------------------------------------------------
test('快要到的节日：窗口默认 4 天，含"就是今天"', () => {
  // 距中秋（2026-09-25）还有 4 天
  const list = upcomingFestivals(new Date('2026-09-21T10:00:00'), { days: 4 });
  assert.deepEqual(list.map((f) => f.name), ['中秋节']);
  assert.equal(list[0].daysLeft, 4);
  assert.equal(list[0].countdown, '还剩 4 天');
  // 3 天时也在窗口里
  assert.equal(upcomingFestivals(new Date('2026-09-22T10:00:00'), { days: 4 }).length, 1);
  // 第 5 天就出去了
  assert.equal(upcomingFestivals(new Date('2026-09-20T10:00:00'), { days: 4 }).length, 0);
  // 当天也在（daysLeft = 0）
  const today = upcomingFestivals(new Date('2026-09-25T08:00:00'), { days: 4 });
  assert.equal(today.length, 1);
  assert.equal(today[0].daysLeft, 0);
  assert.equal(today[0].countdown, '就是今天');
  // 过了就不再提（不看历史）
  assert.equal(upcomingFestivals(new Date('2026-09-26T08:00:00'), { days: 4 }).length, 0);
});

test('快要到的节日：窗口可调（用户要的"默认4天、可调"）', () => {
  const at = new Date('2026-09-18T09:00:00');       // 距中秋 7 天
  assert.equal(upcomingFestivals(at, { days: 4 }).length, 0);
  assert.equal(upcomingFestivals(at, { days: 7 }).length, 1);
  assert.equal(upcomingFestivals(at, { days: 30 }).length >= 2, true, '30 天窗口里应当不止一个');
  // 脏值退回默认 4 天
  assert.equal(upcomingFestivals(new Date('2026-09-21T09:00:00'), { days: 'x' }).length, 1);
});

test('快要到的节日：默认只报"重要的"，免得一年到头都在过节', () => {
  const at = new Date('2026-03-04T09:00:00');       // 距植树节(3/12) 8 天，距妇女节已过
  assert.equal(upcomingFestivals(at, { days: 10 }).some((f) => f.key === 'zhishu'), false, '非重要节日默认不浮');
  assert.equal(upcomingFestivals(at, { days: 10, majorOnly: false }).some((f) => f.key === 'zhishu'), true, '关掉 majorOnly 就该有');
});

test('节日气泡：专用颜色 + 备注里是祝福语和介绍', () => {
  const items = festivalEvents(new Date('2026-09-21T10:00:00'), { days: 4 });
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.type, 'festival', '要给渲染层一个能认出来的 type');
  assert.equal(it.festival, true);
  assert.match(it.id, /^festival:/, 'id 前缀要能看出来"不是库里的事件"');
  assert.equal(it.readonly, true, '节日气泡是只读的');
  assert.equal(it.title, '中秋节');
  // 用户要求：备注里注明祝福语和节日介绍
  assert.ok(it.notes.includes('中秋快乐'), '备注里要有祝福语：' + it.notes);
  assert.ok(it.notes.includes('月饼'), '备注里要有介绍：' + it.notes);
  assert.equal(it.blessing, '中秋快乐，月圆人团圆');
  assert.equal(it.lunarLabel, '八月十五');
  // 专用颜色要**明显区别于**四档（天蓝/翠绿/黄/红）
  const four = ['#38bdf8', '#22c55e', '#f5b301', '#ef4444'];
  assert.ok(!four.includes(FESTIVAL_COLORS.fill), '节日颜色不能和四档之一相同');
  assert.match(FESTIVAL_COLORS.fill, /^#[0-9a-f]{6}$/i);
  assert.match(FESTIVAL_COLORS.edge, /^#[0-9a-f]{6}$/i);
});

test('气泡区：festivalDays 由调用方给，默认关（不再硬编码）', async () => {
  const { selectBubbleItems, BUBBLE_VIEW_DEFAULTS } = await import('../core/bubble-select.js');
  const at = new Date('2026-09-21T10:00:00');
  // 默认值里带着 4 天（用户定的），但 selectBubbleItems 自己不会偷偷加 —— 由调用方喂
  assert.equal(BUBBLE_VIEW_DEFAULTS.festivalDays, 4, '默认应当是 4 天');
  assert.equal(selectBubbleItems([], { now: at }).length, 0, '不传 festivalDays 就不该冒出节日泡泡');
  const on = selectBubbleItems([], { now: at, festivalDays: 4 });
  assert.equal(on.length, 1, '传了就该有');
  assert.equal(on[0].style.tier.color, '#e03a3a', '用的是节日专用色');
  assert.equal(on[0].style.countdownText, '还剩 4 天');
  assert.equal(selectBubbleItems([], { now: at, festivalDays: 4, parentId: 'x' }).length, 0, '容器里不显示节日');
});

test('倒计时那句话', () => {
  assert.equal(festivalCountdownText(0), '就是今天');
  assert.equal(festivalCountdownText(1), '明天');
  assert.equal(festivalCountdownText(4), '还剩 4 天');
  assert.equal(festivalCountdownText(-1), '已过');
  assert.equal(festivalCountdownText('x'), '');
});

test('节气：清明/冬至的近似日期（2000–2035 与日历一致）', () => {
  assert.equal(ymd(termDate(2026, 'qingming')), '2026-04-05');
  assert.equal(ymd(termDate(2025, 'qingming')), '2025-04-04');
  assert.equal(ymd(termDate(2026, 'dongzhi')), '2026-12-22');
  assert.equal(termDate(2026, 'nope'), null);
});
