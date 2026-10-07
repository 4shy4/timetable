// 「提前排提醒」的单元测试（原生壳路线：iOS UNCalendarNotificationTrigger / 安卓 AlarmManager）。
//
// 为什么这块值得测透：原生壳里**提醒是唯一的"活"逻辑** ——
// 气泡、编辑器、课表全都是同一份 web/ 代码，在 WebView 里跑；
// 唯一需要 Swift/Kotlin 参与的就是"把提醒注册给系统"。
// 所以这层算错了，整个原生壳就白做。
//
// 而且它是平台无关的纯函数，能在这台 Windows 上验完 —— 不用等 Mac。
//
// 跑法：node tools/notify-plan.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planNotifications, planSummary, MAX_PENDING, DEFAULT_HORIZON_DAYS,
  BUILTIN_SOUNDS, soundForIntensity, usableCustomSounds,
} from '../core/notify-plan.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 造一条日程。start 用**相对现在**的偏移，避免写死日期变成定时炸弹 */
function ev(id, startOffsetMs, extra = {}) {
  const start = new Date(Date.now() + startOffsetMs);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  return {
    id, title: id, type: 'personal',
    start: stamp(start), end: stamp(new Date(start.getTime() + HOUR)),
    autoReminders: false, reminders: [10, 0], done: false, ...extra,
  };
}

test('排出未来的提醒点：按 fireAt 升序', () => {
  const plan = planNotifications({
    events: [ev('a', 3 * HOUR), ev('b', 1 * HOUR)],
    now: new Date(), horizonDays: 1,
  });
  assert.ok(plan.length >= 4, `两条日程各两个提醒点 → 至少 4 条，实际 ${plan.length}`);
  for (let i = 1; i < plan.length; i += 1) {
    assert.ok(new Date(plan[i - 1].fireAt) <= new Date(plan[i].fireAt), '必须按时间升序');
  }
});

test('提醒点 = 开始时间 − 提前量；为负表示开始之后', () => {
  const now = new Date();
  const start = new Date(now.getTime() + 5 * HOUR);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  const e = {
    id: 'x', title: 'x', start: stamp(start), end: stamp(new Date(start.getTime() + HOUR)),
    autoReminders: false, reminders: [30, -15], done: false,
  };
  const plan = planNotifications({ events: [e], now, horizonDays: 1 });
  const f = (m) => plan.find((p) => p.id.endsWith(`@${m}`));
  assert.ok(f(30), '提前 30 分钟的点要在');
  assert.equal(new Date(f(30).fireAt).getTime(), new Date(e.start).getTime() - 30 * MIN);
  assert.ok(f(-15), '延后 15 分钟的点也要在');
  assert.equal(new Date(f(-15).fireAt).getTime(), new Date(e.start).getTime() + 15 * MIN);
});

test('已经过去的提醒点不再排（不补报）', () => {
  const now = new Date();
  // 事件 2 小时前就开始了，"提前 10 分钟"的点早就过了
  const plan = planNotifications({ events: [ev('past', -2 * HOUR)], now, horizonDays: 1 });
  assert.equal(plan.length, 0, '过去的点不该排给系统');
});

test('超出时间窗的提醒点不排', () => {
  const plan = planNotifications({
    events: [ev('far', 30 * DAY)], now: new Date(), horizonDays: 7,
  });
  assert.equal(plan.length, 0, '30 天后的日程不在 7 天窗口里');
  const plan2 = planNotifications({
    events: [ev('far', 30 * DAY)], now: new Date(), horizonDays: 40,
  });
  assert.ok(plan2.length > 0, '把窗口放大就应当排进来');
});

test('★ 最多 64 条，且留的是**最早响的**那些（iOS 硬限制）', () => {
  // 造一堆很近的日程，提醒点总数远超 64
  const events = [];
  for (let i = 0; i < 100; i += 1) {
    events.push(ev(`e${String(i).padStart(3, '0')}`, (10 + i) * MIN, { reminders: [5, 0] }));
  }
  const plan = planNotifications({ events, now: new Date(), horizonDays: 7 });
  assert.equal(plan.length, MAX_PENDING, `应当截到 ${MAX_PENDING} 条，实际 ${plan.length}`);
  // ★ 关键：留的是最早的 64 条，不是最晚的、也不是随便 64 条
  const all = planNotifications({ events, now: new Date(), horizonDays: 7, max: 0 });
  assert.ok(all.length > MAX_PENDING, '前置：不截断时确实超了');
  const expectFirst = all[0].fireAt;
  assert.equal(plan[0].fireAt, expectFirst, '第一条必须是最早响的那个');
  // 截断后最后一条应当 ≤ 未截断时的第 64 条
  assert.equal(plan[plan.length - 1].fireAt, all[MAX_PENDING - 1].fireAt,
    '应当正好是"最早的 64 条"');
});

test('★ id 稳定：同一个提醒点每次算出同一个 id（原生侧重排才是替换而非堆积）', () => {
  const now = new Date();
  const events = [ev('stable', 2 * HOUR)];
  const a = planNotifications({ events, now, horizonDays: 1 });
  const b = planNotifications({ events, now: new Date(now.getTime() + 1000), horizonDays: 1 });
  assert.ok(a.length > 0 && b.length > 0);
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id),
    'id 不稳定的话，每次重排都会在系统里堆一份重复通知');
});

test('id 里带事件与发生时刻 —— 不同实例/不同提前量互不相同', () => {
  const now = new Date();
  const e = {
    id: 'rec', title: '每周', type: 'personal',
    start: (() => { const d = new Date(now.getTime() + 2 * HOUR); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`; })(),
    end: undefined, autoReminders: false, reminders: [10, 0],
    recurrence: { freq: 'daily', interval: 1 }, done: false,
  };
  const plan = planNotifications({ events: [e], now, horizonDays: 3 });
  const ids = plan.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须互不相同');
  assert.ok(ids.every((i) => i.startsWith('rec@')), `id 应当带事件 id，实际 ${ids[0]}`);
});

test('字段形状就是 JS↔原生壳的契约', () => {
  const plan = planNotifications({ events: [ev('c1', 2 * HOUR, { location: '北101', teacher: '黄老师' })], now: new Date(), horizonDays: 1 });
  assert.ok(plan.length > 0);
  const it = plan[0];
  // ⚠️ 这个列表**故意写成穷举**：条目形状就是网页层与原生壳之间的契约，
  //    加字段必须两边一起改（壳侧的解析在 App.swift 的 parse）。
  //    所以"多一个字段就红"是**想要的行为**，不是脆弱 ——
  //    它挡住的是"网页加了字段、壳没读"，那种漏掉只会表现成"设了没反应"。
  //    （`sound` 就是照着这条规矩加进去的：网页侧决定放哪个音，
  //      壳侧在 App.swift 的 parse 里读 `d["sound"]`。）
  assert.deepEqual(Object.keys(it).sort(),
    ['body', 'eventId', 'fireAt', 'id', 'intensity', 'sound', 'title', 'useAlarm']);
  assert.equal(it.eventId, 'c1');
  assert.equal(it.title, 'c1');
  assert.match(it.fireAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'fireAt 必须是 UTC ISO，原生侧直接转 DateComponents');
  assert.ok(it.intensity >= 1 && it.intensity <= 4);
  // body 里要有"还剩多久"和地点 —— 这是用户实际看到的那行字
  assert.ok(it.body.includes('分钟后') || it.body.includes('现在开始'), `body 异常: ${it.body}`);
  assert.ok(it.body.includes('北101'), `body 应当带地点: ${it.body}`);
});

test('「到点用真闹钟」的意愿要一路带到壳（默认不勾）', () => {
  // ⚠️ 这条链任何一环断了都**不会报错**，只会"勾了没反应"，
  //    而用户在设备上根本看不出是哪一环断的 —— 所以在这里钉住。
  //    壳侧还会再要求 intensity>=4 才真做成闹钟（见 AlarmKitScheduler.swift）。
  const off = planNotifications({ events: [ev('a', HOUR, {})], now: new Date(), horizonDays: 1 });
  assert.equal(off[0].useAlarm, false, '没勾就必须是 false —— 绝不能让没勾的日程炸穿专注模式');

  const on = planNotifications({ events: [ev('b', HOUR, { alarm: true })], now: new Date(), horizonDays: 1 });
  assert.equal(on[0].useAlarm, true, '勾了就要带出去');

  // 它只是同一个字段的搬运，不该影响强度 / 时间
  assert.equal(on[0].intensity, off[0].intensity);
  assert.equal(on[0].fireAt, off[0].fireAt);
});

test('跳过已完成的日程', () => {
  const plan = planNotifications({ events: [ev('done1', 2 * HOUR, { done: true })], now: new Date(), horizonDays: 1 });
  assert.equal(plan.length, 0);
});

test('没有 reminders 且是自动模式 → 按剩余时间档位自动排（不为空）', () => {
  const e = ev('auto', 3 * HOUR, { autoReminders: true, reminders: [] });
  const plan = planNotifications({ events: [e], now: new Date(), horizonDays: 1 });
  assert.ok(plan.length > 0, '自动模式下应当按档位排出提醒');
});

test('「周期」开关打开时，被周期收起的实例不再排提醒', () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  const start = new Date(now.getTime() + 2 * HOUR);
  const e = {
    id: 'p', title: '每天', start: stamp(start), end: stamp(new Date(start.getTime() + HOUR)),
    autoReminders: false, reminders: [0],
    recurrence: { freq: 'daily', interval: 1 }, periodDays: 1, done: false,
  };
  const off = planNotifications({ events: [e], now, horizonDays: 5, max: 0 });
  const on = planNotifications({ events: [e], now, horizonDays: 5, max: 0, periodAffectsReminders: true });
  assert.ok(off.length > on.length, `开着应当更少：关 ${off.length} 条 / 开 ${on.length} 条`);
  assert.equal(on.length, 2, '周期 1 天 → 只留当天与次日两点（0/1 天）');
});

/**
 * 未来泡泡的提醒锚点是 **end**，不是 start。
 *
 * 为什么必须有这条测试：未来泡泡的 `start` 是"泡泡出现的日子"，不是事情发生的时刻。
 * 如果这里漏改，表现是"提前 10 分钟提醒"变成"泡泡刚冒出来那一下提醒"，
 * 而**用户在设备上完全看不出哪里错了**（通知确实响了，只是响错了日子）。
 */
test('未来泡泡：提醒按「结束」算，不按「start（出现日期）」算', () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
  const appear = new Date(now.getTime() + 5 * DAY);      // 5 天后才出现
  const due = new Date(now.getTime() + 5 * DAY + 2 * HOUR);  // 出现 2 小时后到期
  const base = {
    id: 'fut', title: '未来', start: stamp(appear), end: stamp(due),
    autoReminders: false, reminders: [10], done: false,
  };
  const fut = planNotifications({ events: [{ ...base, future: true }], now, horizonDays: 10, max: 0 });
  const norm = planNotifications({ events: [base], now, horizonDays: 10, max: 0 });

  assert.equal(fut.length, 1);
  assert.equal(norm.length, 1);
  // ⚠️ 期望值要用**截断到分钟**的那个时刻（stamp 抹掉了秒和毫秒），
  //    直接拿 appear/due 比会差几十秒 —— 那不是 bug，是造数据时的精度。
  const appearMs = new Date(stamp(appear)).getTime();
  const dueMs = new Date(stamp(due)).getTime();
  // 普通日程：start − 10 分钟；未来泡泡：end − 10 分钟
  assert.equal(new Date(norm[0].fireAt).getTime(), appearMs - 10 * MIN);
  assert.equal(new Date(fut[0].fireAt).getTime(), dueMs - 10 * MIN,
    '未来泡泡必须按「结束」提前 10 分钟，而不是按出现日期');
});

test('planSummary：给原生壳的最小信息', () => {
  assert.deepEqual(planSummary([]), { count: 0, nextAt: null });
  assert.deepEqual(planSummary(null), { count: 0, nextAt: null });
  const plan = planNotifications({ events: [ev('s', 2 * HOUR)], now: new Date(), horizonDays: 1 });
  const s = planSummary(plan);
  assert.equal(s.count, plan.length);
  assert.equal(s.nextAt, plan[0].fireAt);
});

test('常量：64 是 iOS 的硬限制，7 天是默认窗口（改动会被这里提醒）', () => {
  assert.equal(MAX_PENDING, 64);
  assert.equal(DEFAULT_HORIZON_DAYS, 7);
});

// ---------------------------------------------------------------------------
// 提示音：哪一档配哪个声音（用户还能换成自己导入的）
// ---------------------------------------------------------------------------
//
// ⚠️ 这块以前**根本没有测试**，而它的失效方式是"最安静的那种"：
//    名字错了/文件不在 → iOS **不报错**，只是放默认音（或者干脆没声音），
//    用户只会觉得"我的提示音怎么没了"。
test('提示音：三档各用哪个文件，1 档是系统默认音', () => {
  assert.equal(soundForIntensity(4), 'timetable-alert-strong.wav');
  assert.equal(soundForIntensity(3), 'timetable-alert.wav');
  assert.equal(soundForIntensity(2), 'timetable-alert-soft.wav');
  assert.equal(soundForIntensity(1), null, '1 档用系统默认音（最短一声叮）');
  // 脏输入不许炸，也不许发空名字给系统
  for (const bad of [0, -1, 99, null, undefined, 'x', NaN]) {
    const got = soundForIntensity(bad);
    assert.ok(got === null || typeof got === 'string', `intensity=${String(bad)} → ${String(got)}`);
    assert.notEqual(got, '', '绝不能返回空串（那会让通知静音）');
  }
});

test('提示音：用户导入的名字优先，空串/非字符串一律当没有', () => {
  const custom = { 2: 'timetable-custom-t2-1.caf', 4: 'timetable-custom-t4-1.caf' };
  assert.equal(soundForIntensity(2, custom), 'timetable-custom-t2-1.caf');
  assert.equal(soundForIntensity(4, custom), 'timetable-custom-t4-1.caf');
  assert.equal(soundForIntensity(3, custom), 'timetable-alert.wav', '没换的那档仍用内置');
  // ⚠️ 空串会静音、true/number 会让系统拿到垃圾名字 → 都必须退回内置
  assert.equal(soundForIntensity(2, { 2: '' }), 'timetable-alert-soft.wav');
  assert.equal(soundForIntensity(2, { 2: '   ' }), 'timetable-alert-soft.wav');
  assert.equal(soundForIntensity(2, { 2: true }), 'timetable-alert-soft.wav');
  assert.equal(soundForIntensity(2, { 2: 123 }), 'timetable-alert-soft.wav');
});

test('提示音：只认这台设备上真的存在的文件（跨设备同步的防护）', () => {
  const custom = { 2: 'timetable-custom-t2-1.caf', 3: 'timetable-custom-t3-9.caf' };
  // 容器里只有第 2 档那个文件（换设备的典型情形：设置同步过来了，文件没过来）
  const ok = usableCustomSounds(custom, ['timetable-custom-t2-1.caf', '别的.caf']);
  assert.deepEqual(ok, { 2: 'timetable-custom-t2-1.caf' });
  // 过滤之后，缺文件的那档会自动退回内置音
  assert.equal(soundForIntensity(3, usableCustomSounds(custom, ['timetable-custom-t2-1.caf'])),
    'timetable-alert.wav');
  // 壳没报名单（老版本/浏览器）→ 谁都不认，全部走内置（宁可保守）
  assert.deepEqual(usableCustomSounds(custom, null), {});
  assert.deepEqual(usableCustomSounds(null, ['a.caf']), {});
});

test('提示音：排出来的每一条都带 sound 字段（壳那边靠它决定放什么）', () => {
  const now = new Date();
  const custom = { 4: 'timetable-custom-t4-42.caf' };
  const plan = planNotifications({
    events: [ev('snd', 3 * HOUR)],
    now,
    horizonDays: 1,
    max: 0,
    customSounds: custom,
  });
  assert.ok(plan.length > 0);
  for (const p of plan) {
    assert.ok('sound' in p, '每条都必须显式带 sound 字段（null 也是显式的）');
    // ⚠️ 判据要**按这条自己的档位**算，别假设它是几档：
    //    这里的 intensity 来自"这条提醒提前多少"（`anchor - fireAt`），
    //    而不是"事件还有多远" —— 提前 10 分钟排的那条就是 4 档。
    assert.equal(p.sound, soundForIntensity(p.intensity, custom),
      `第 ${p.intensity} 档的声音不对`);
  }
  assert.ok(plan.some((p) => p.sound === 'timetable-custom-t4-42.caf'),
    '自定义音没被用上：' + JSON.stringify(plan.map((p) => [p.intensity, p.sound])));
  // 内置三档的名字必须**一个都没打错**（写错文件名 = 静默变默认音）
  const names = Object.values(BUILTIN_SOUNDS).filter(Boolean);
  assert.deepEqual(names.slice().sort(),
    ['timetable-alert-soft.wav', 'timetable-alert-strong.wav', 'timetable-alert.wav'].sort());
  // 而且这三个名字**都要超过 15 字节** —— 短了 Swift 会把字面量内联编码，
  // 产物里 `strings` 搜不到，"改动有没有编进去"就没法验证（这个项目栽过）
  for (const n of names) assert.ok(Buffer.byteLength(n, 'utf8') > 15, `${n} 太短`);
});

test('健壮：空输入 / 坏日期 / 坏提醒值都不炸', () => {
  assert.deepEqual(planNotifications(), []);
  assert.deepEqual(planNotifications({ events: [], now: new Date() }), []);
  const junk = [
    { id: 'j1', title: '坏日期', start: 'not-a-date', reminders: [10] },
    { id: 'j2', title: '坏提醒', start: new Date(Date.now() + HOUR).toISOString(), end: new Date(Date.now() + 2 * HOUR).toISOString(), autoReminders: false, reminders: ['x', null, 5] },
  ];
  const plan = planNotifications({ events: junk, now: new Date(), horizonDays: 1 });
  assert.ok(plan.every((p) => Number.isFinite(new Date(p.fireAt).getTime())), '排出来的时间都必须是合法的');
  assert.ok(!plan.some((p) => p.id.endsWith('@null')), 'null 提醒值不该被当成 0');
});
