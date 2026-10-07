// 提醒决策层的单元测试（平台无关，三端共用同一套判定）
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dueReminders, createReminderEngine, buildReminderText, reminderKey,
  LATE_TOLERANCE_MS, EVENT_GRACE_MS,
} from '../core/reminder-plan.js';
import { occurrences } from '../core/recurrence.js';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

/** 造一条日程 */
function ev({ id = 'e1', title = '测试', startMinutesFromNow, reminders = [0], minutes = 60, done = false }) {
  const start = new Date(Date.now() + startMinutesFromNow * 60_000);
  return {
    id,
    title,
    start: stamp(start),
    end: stamp(new Date(start.getTime() + minutes * 60_000)),
    reminders,
    done,
    location: '教三 305',
    teacher: '李老师',
  };
}

const scan = (events, now = new Date(), fired = new Set()) => dueReminders({
  events, termStart: '', now, fired,
});

test('到点的提醒会被扫出来', () => {
  // 10 分钟后开始，提前 10 分钟提醒 → 正好现在该响
  const e = ev({ startMinutesFromNow: 10, reminders: [10] });
  const hit = scan([e]);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].eventId, 'e1');
  assert.equal(hit[0].minutes, 10);
});

test('还没到点的提醒不会被扫出来', () => {
  const e = ev({ startMinutesFromNow: 60, reminders: [10] }); // 50 分钟后才该响
  assert.equal(scan([e]).length, 0);
});

test('迟到太久的不补报（避免"马后炮轰炸"）', () => {
  // 2 小时前开始，提前 10 分钟 → 提醒点早在 110 分钟前
  const e = ev({ startMinutesFromNow: -120, reminders: [10] });
  assert.equal(scan([e]).length, 0, '迟到超过容忍窗口就不该再报');
});

test('刚过去一点点的仍然算数（容忍定时器抖动）', () => {
  // 未来事件：start = now + 10min，希望 fireAt = now − 30s
  //   fireAt = start − lead  →  lead = start − fireAt = (now+10min) − (now−30s) = 10.5min
  // 用截断后的 start 反推，避免分钟取整带来的漂移。
  const start = new Date(Date.now() + 10 * 60_000);
  const truncatedStart = new Date(stamp(start));
  const leadMinutes = (truncatedStart.getTime() - (Date.now() - 30_000)) / 60_000;
  const e = ev({
    id: 'e2',
    startMinutesFromNow: 10,
    reminders: [Number(leadMinutes.toFixed(4))],
    minutes: 60,
  });
  const hit = scan([e]);
  assert.equal(hit.length, 1, '刚过去 30 秒的提醒应仍然算数');
  const late = Date.now() - hit[0].fireAt.getTime();
  assert.ok(late > 0 && late < LATE_TOLERANCE_MS, `迟到 ${late}ms 应落在容忍窗口内`);
});

test('提前量为正 → 提醒点在开始之前（到点的会被扫出来）', () => {
  // 10 分钟后开始、提前 10 分钟 → fireAt 正好是现在
  const e = ev({ startMinutesFromNow: 10, reminders: [10] });
  const hit = scan([e]);
  assert.equal(hit.length, 1, '提前提醒必须能在到点时被扫出来');
  assert.equal(hit[0].minutes, 10);
  assert.ok(hit[0].fireAt.getTime() <= Date.now(), 'fireAt 应该已经到点');
});

test('已经结束很久的事件不再提醒', () => {
  // 3 小时前开始、只持续 30 分钟 → 早已结束，即使提醒点是"开始后 5 分钟"也不该报
  const e = ev({ startMinutesFromNow: -180, reminders: [-5], minutes: 30 });
  assert.equal(scan([e]).length, 0);
});

/**
 * 造一条"触发点已经到点"的延后提醒（提前量为负）。
 *
 * 为什么这么绕：ev() 按分钟取整时间戳，而 now 每秒都在变，
 * 所以"从 now 倒推几分钟"会让触发点在容忍窗口边缘随机漂移。
 * 这里改成**从 start 同源推导**：先算 deltaMs = 截断后(now−start) − fireOffsetMs，
 * 再让提前量 = −deltaMs/60000，这样 fireAt 就精确落在 now − fireOffsetMs。
 */
function lateEvent({ id = 'e1', startMinutesFromNow = -42, fireOffsetMs = 30_000, minutes = 120 } = {}) {
  const start = new Date(Date.now() + startMinutesFromNow * 60_000);
  const truncatedStart = new Date(stamp(start));
  const deltaMs = Date.now() - truncatedStart.getTime();
  const leadMinutes = -(deltaMs - fireOffsetMs) / 60_000;
  return ev({
    id,
    startMinutesFromNow,
    reminders: [Number(leadMinutes.toFixed(4))],
    minutes,
  });
}

test('提前量为负 → 提醒点在开始之后（不能因为"已开始"就丢掉）', () => {
  const e = lateEvent({ fireOffsetMs: 30_000 });
  const hit = scan([e]);
  assert.equal(hit.length, 1, '「开始后 N 分钟提醒」必须能被算出来');
  assert.ok(hit[0].minutes < 0, `提前量应为负，实际 ${hit[0].minutes}`);
  assert.ok(hit[0].fireAt.getTime() > new Date(e.start).getTime(),
    'fireAt 应晚于开始时间（这正是"延后提醒"的语义）');
  const late = Date.now() - hit[0].fireAt.getTime();
  assert.ok(late > 0 && late < 90_000, `触发点应在容忍窗口内，实际迟到 ${late}ms`);
});

test('还没到点的延后提醒不会被提前报出来', () => {
  const e = lateEvent({ fireOffsetMs: -30_000 }); // 触发点在 30 秒后才到
  assert.equal(scan([e]).length, 0, '还没到点就不该报');
});

test('多个提醒点可以在同一轮里都命中', () => {
  // 同一 start，两个延后提醒：触发点分别约 now−40s / now−10s
  const base = new Date(Date.now() - 42 * 60_000);
  const truncatedStart = new Date(stamp(base));
  const deltaMs = Date.now() - truncatedStart.getTime();
  const lead = (offsetMs) => Number((-(deltaMs - offsetMs) / 60_000).toFixed(4));
  const e = ev({
    startMinutesFromNow: -42,
    reminders: [lead(40_000), lead(10_000)],
    minutes: 120,
  });
  const hit = scan([e]);
  assert.equal(hit.length, 2, `两个提醒点都应命中，实际 ${hit.length}`);
  for (const h of hit) assert.ok(h.minutes < 0, '都应是延后提醒');
});

test('结果按触发时间排序（越早到点的排越前）', () => {
  // 同一 start，触发点 now−70s 与 now−20s
  const base = new Date(Date.now() - 42 * 60_000);
  const truncatedStart = new Date(stamp(base));
  const deltaMs = Date.now() - truncatedStart.getTime();
  const lead = (offsetMs) => Number((-(deltaMs - offsetMs) / 60_000).toFixed(4));
  const e = ev({
    startMinutesFromNow: -42,
    reminders: [lead(20_000), lead(70_000)],
    minutes: 120,
  });
  const hit = scan([e]);
  assert.equal(hit.length, 2, `应命中 2 条，实际 ${hit.length}`);
  for (let i = 1; i < hit.length; i += 1) {
    assert.ok(hit[i].fireAt >= hit[i - 1].fireAt, '应按 fireAt 升序');
  }
  assert.ok(hit[0].fireAt < hit[1].fireAt, '两个触发点应不同');
});

test('文案：提前 / 准点 / 已开始 三种说法', () => {
  const start = new Date('2026-03-02T08:50:00');
  const withLoc = buildReminderText({ location: '教三 305' }, start, 10);
  assert.ok(withLoc.includes('10 分钟后（08:50）'), `提前提醒文案不对：${withLoc}`);
  assert.ok(withLoc.includes('教三 305'), `应带上地点：${withLoc}`);
  assert.ok(buildReminderText({}, start, 0).includes('现在开始（08:50）'), '准点文案不对');
  assert.ok(buildReminderText({}, start, -5).includes('已开始 5 分钟（08:50）'), '延后文案不对');
});

test('已完成的日程不提醒', () => {
  const e = ev({ startMinutesFromNow: 10, reminders: [10], done: true });
  assert.equal(scan([e]).length, 0);
});

test('同一提醒点在账本里就不再重复', () => {
  const e = ev({ startMinutesFromNow: 10, reminders: [10] });
  const key = reminderKey('e1', new Date(e.start), 10);
  assert.equal(scan([e]).length, 1);
  assert.equal(scan([e], new Date(), new Set([key])).length, 0, '账本里有的不该再冒出来');
});

test('提醒 key 稳定且三端一致', () => {
  const occ = new Date('2026-03-02T08:00:00');
  assert.equal(reminderKey('evt_x', occ, 10), 'evt_x@2026-03-02T08:00:00@10');
  assert.equal(reminderKey('evt_x', occ, 10), reminderKey('evt_x', occ, 10));
});

// ---------------------------------------------------------------------------
// 引擎骨架：扫描 → 记账 → 投递
// ---------------------------------------------------------------------------

test('引擎：投递一次、写入账本、不重复投递', async () => {
  let stored = [];
  const delivered = [];
  const engine = createReminderEngine({
    ledger: { load: () => stored, save: (k) => { stored = k; } },
    deliver: (item) => { delivered.push(item); },
  });

  const e = ev({ id: 'eng', startMinutesFromNow: 10, reminders: [10] });
  const first = await engine.tick({ events: [e], termStart: '' });
  assert.equal(first.length, 1, '第一次应投递 1 条');
  assert.equal(delivered.length, 1);
  assert.equal(stored.length, 1, '账本应被写入');

  const second = await engine.tick({ events: [e], termStart: '' });
  assert.equal(second.length, 0, '第二次不该重复投递');
  assert.equal(delivered.length, 1);
});

test('引擎：账本能持久化到"存储"里（模拟换端/重启后不重复）', async () => {
  let stored = [];
  const mkEngine = () => createReminderEngine({
    ledger: { load: () => stored, save: (k) => { stored = k; } },
    deliver: () => {},
  });
  const e = ev({ id: 'persist', startMinutesFromNow: 10, reminders: [10] });

  const a = await mkEngine().tick({ events: [e], termStart: '' });
  assert.equal(a.length, 1);
  // 新建一个引擎实例（等价于重新加载页面 / 重开 App）
  const b = await mkEngine().tick({ events: [e], termStart: '' });
  assert.equal(b.length, 0, '账本已持久化，不该重复');
});

test('引擎：投递抛错不会卡住其它提醒，也不会永远重试', async () => {
  let stored = [];
  let calls = 0;
  const engine = createReminderEngine({
    ledger: { load: () => stored, save: (k) => { stored = k; } },
    deliver: () => { calls += 1; if (calls === 1) throw new Error('模拟通知失败'); },
  });
  const e = ev({ id: 'boom', startMinutesFromNow: 10, reminders: [10] });

  const first = await engine.tick({ events: [e], termStart: '' });
  assert.equal(first.length, 0, '投递失败的这一条不算投递成功');
  assert.equal(stored.length, 1, '但账本仍然要记账，避免无限重试');

  await engine.tick({ events: [e], termStart: '' });
  assert.equal(calls, 1, '不该反复重试同一个提醒点');
});

test('引擎：reset 后可以重新提醒（演示用）', async () => {
  let stored = [];
  let n = 0;
  const engine = createReminderEngine({
    ledger: { load: () => stored, save: (k) => { stored = k; } },
    deliver: () => { n += 1; },
  });
  const e = ev({ id: 'reset', startMinutesFromNow: 10, reminders: [10] });

  await engine.tick({ events: [e], termStart: '' });
  assert.equal(n, 1);
  engine.reset();
  assert.deepEqual(engine.firedKeys(), []);
  await engine.tick({ events: [e], termStart: '' });
  assert.equal(n, 2, 'reset 后应能再提醒一次');
});

test('引擎：缺少 ledger/deliver 时明确报错，而不是静默失效', () => {
  assert.throws(() => createReminderEngine({}), /ledger/);
  assert.throws(() => createReminderEngine({ ledger: { load: () => [], save: () => {} } }), /deliver/);
  assert.throws(
    () => createReminderEngine({ ledger: { load: () => [] }, deliver: () => {} }),
    /save/,
  );
});

test('容忍窗口常量有明确含义（改动会被这里提醒）', () => {
  assert.equal(LATE_TOLERANCE_MS, 90_000);
  assert.equal(EVENT_GRACE_MS, 60_000);
});

// ---------------------------------------------------------------------------
// 「周期」开关：periodAffectsReminders
//
// 用户要的开关（原话"不开是 1，开是 2"）：
//   关（默认）= 周期只收起气泡区的显示，**提醒照旧全发**
//   开        = 被周期收起来的实例**也不再提醒**
//
// 这里必须用固定时钟 —— 周期筛选的锚点是"第一个未来的实例"，
// 用相对时间造事件会让锚点漂移，断言会变得不可读。
// ---------------------------------------------------------------------------

/** 每周一 09:00 的重复事件，未来会有多颗；periodDays 控制收起到几颗 */
function weeklyEv(periodDays) {
  const base = new Date();
  // 找下一个周一 09:00，保证"锚点"就是它
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 9, 0, 0, 0);
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  const stampLocal = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}:00`;
  return {
    id: 'wk', title: '每周例会', type: 'personal',
    start: stampLocal(d), end: stampLocal(new Date(d.getTime() + 3_600_000)),
    // 提前 0 分钟 = 到点就提醒，这样只要实例被保留就一定会进 due
    recurrence: { freq: 'weekly', byDay: [d.getDay()], interval: 1 },
    reminders: [0], autoReminders: false, done: false,
    ...(periodDays == null ? {} : { periodDays }),
  };
}

/** 在第 k 颗发生的那一刻问一次：这颗会不会出现在 due 里 */
function firesAt(events, occ, opts) {
  // +1 秒：落在 LATE_TOLERANCE_MS（90 秒）窗口内，保证"到点"能被判定
  const at = new Date(occ.getTime() + 1_000);
  const due = dueReminders({ events, termStart: '', now: at, fired: new Set(), ...opts });
  return due.some((r) => new Date(r.occurrence).getTime() === occ.getTime());
}

test('周期开关：前置 —— 最近那颗确实会响（证明这套探针是有效的）', () => {
  const ev = weeklyEv(null);
  const occs = occurrences(ev, new Date(), new Date(Date.now() + 21 * 86_400_000), '');
  assert.ok(occs.length >= 2, `未来应当至少两颗，实际 ${occs.length}`);
  assert.equal(firesAt([ev], occs[0], {}), true, '最近那颗应当响');
});

/**
 * ⚠️ 结论性发现：**「周期也管提醒」这个开关在提醒上不可能生效。**
 *
 * 把它写成测试，是为了让以后的人一眼看到"这不是坏了，是数学上不可能"：
 *   · 提醒只扫未来 **26 小时**（core/reminder-plan.js 的 SCAN_AHEAD_MS）
 *   · 本应用的重复粒度**最小是"每天"**（间隔 ≥ 24 小时）——
 *     周级 byDay 勾多天时，相邻两颗也只差 24 小时
 *   · 而周期**最小是 1 天**
 *   ⇒ 26 小时窗口里最多出现两颗，间隔恰好 24 小时，永远 ≤ 周期
 *   ⇒ 筛选**永远不触发**
 *
 * 所以这个开关真正有意义的地方是**日历订阅**（那条路要展开 400 天），
 * 不是提醒。参数先留着，是为了三端语义统一、以及将来若扩大扫描窗口能自然生效。
 */
test('周期开关：开着和关着，对同一颗的结论必然一致（已知且已解释）', () => {
  const ev = weeklyEv(3);
  const occs = occurrences(ev, new Date(), new Date(Date.now() + 21 * 86_400_000), '');
  assert.ok(occs.length >= 2);
  for (const o of occs.slice(0, 3)) {
    assert.equal(
      firesAt([ev], o, { periodAffectsReminders: true }),
      firesAt([ev], o, { periodAffectsReminders: false }),
      '26h 窗口 + ≥24h 粒度 ⇒ 周期筛不动提醒',
    );
  }
});

test('周期开关【开】但事件没设周期 → 提醒不受影响', () => {
  const ev = weeklyEv(null);
  const occs = occurrences(ev, new Date(), new Date(Date.now() + 21 * 86_400_000), '');
  for (const o of occs.slice(0, 3)) {
    assert.equal(firesAt([ev], o, { periodAffectsReminders: true }), firesAt([ev], o, {}));
  }
});

// ---------------------------------------------------------------------------
// 方案 C 的契约：「什么时候提醒你」和「什么时候算过期」是两个概念
//
// 用户选定的方案 C：**到期 = 结束时间**（18:30–20:05 的课在 19:00 不该算过期），
// 但**提醒点仍然相对开始时间**（上课前 10 分钟才有用）。
//
// 这条测试专门防止以后有人"顺手统一"把提醒也挪到 end 上 ——
// 那会让"课前 10 分钟提醒"变成"下课前 10 分钟提醒"，课都快上完了才响。
// 实测（真实数据 55 条未完成事件）：到期时刻变了 29 条，但提醒点一条都没变。
// ---------------------------------------------------------------------------

test('方案C：提醒点相对**开始时间**算，不跟"到期"（结束时间）走', () => {
  // 一门 95 分钟的课，提前 10 分钟提醒
  const start = new Date(Date.now() + 5 * 3_600_000);
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 95 * 60_000);
  const ev = {
    id: 'c1', title: '高等数学', type: 'course',
    start: stamp(start), end: stamp(end),
    reminders: [10], autoReminders: false, done: false,
  };

  // 在"开始前 10 分钟"那一刻问：应当响
  const atLead = new Date(start.getTime() - 10 * 60_000 + 1_000);
  const due = dueReminders({ events: [ev], termStart: '', now: atLead, fired: new Set() });
  assert.equal(due.length, 1, '课前 10 分钟应当响');
  assert.equal(due[0].occurrence.getTime(), start.getTime(), 'occurrence 必须是开始时间');
  assert.equal(due[0].fireAt.getTime(), start.getTime() - 10 * 60_000,
    'fireAt = 开始时间 − 提前量。若有人把它改成用 end，这里会变成 19:55 而失败');

  // 反证：在下课前 10 分钟那一刻**不该**再响（这个提醒点早过去了，且不补报）
  const nearEnd = new Date(end.getTime() - 10 * 60_000 + 1_000);
  const due2 = dueReminders({ events: [ev], termStart: '', now: nearEnd, fired: new Set() });
  assert.equal(due2.length, 0, '快下课了不该再补报一次');
});

test('方案C：「到期」用的是结束时间（气泡的倒计时/变紫跟它走）', async () => {
  const { remainingMsOf, deadlineMsOf } = await import('../core/state-ops.js');
  const start = new Date('2026-03-02T18:30:00');
  const end = new Date('2026-03-02T20:05:00');
  const course = { id: 'c2', title: '高等数学', start: stamp(start), end: stamp(end) };
  assert.equal(deadlineMsOf(course), end.getTime(), '没有显式 deadline → 到期 = 结束时间');
  // 19:00 这一刻：还剩 65 分钟（而不是"已过 30 分钟"）
  const at1900 = new Date('2026-03-02T19:00:00');
  assert.equal(remainingMsOf(course, at1900), 65 * 60_000);
});

// ---------------------------------------------------------------------------
// `markFired()`：外部投递的 key 必须走引擎记账（2026-10-01 新增）
//
// ⚠️ 为什么单独盯它：外部投递（不走 `engine.tick()` 的那条路）不经过
//    `engine.tick()`，而是自己算完再投递。如果它**直接写 localStorage**，
//    就会被引擎的**内存快照**盖回去 —— 下一轮 `tick()` 一回写，那些 key 又变回"没发过"，
//    于是**同一条提醒会重复弹**（，用户会以为程序坏了）。
// ---------------------------------------------------------------------------

test('⭐ markFired：写进账本后 tick() 不会把它抹掉（外部投递靠这条防重复弹）', async () => {
  let stored = [];
  const engine = createReminderEngine({
    ledger: { load: () => stored, save: (k) => { stored = k; } },
    deliver: () => {},
  });
  // 模拟"外部投递完，来记账"
  const KEY = 'greet:c1|festival:zhongqiu|2026-09-25';
  assert.equal(engine.markFired([KEY]), true, '第一次记应当返回 true');
  assert.deepEqual(engine.firedKeys(), [KEY], '内存快照要认这个 key');
  assert.deepEqual(stored, [KEY], '账本也要落盘');

  // ⚠️ 关键：跑一次 tick()。旧实现会在这里用**内存快照回写**，把那个 key 抹掉。
  await engine.tick({ events: [], termStart: '', now: new Date('2026-09-25T09:00:00') });
  assert.ok(engine.firedKeys().includes(KEY),
    'tick() 之后那个 key 必须还在（被抹掉 = 同一条提醒会被再投一次）');
  assert.ok(stored.includes(KEY), '落盘的账本里也必须还在');

  // 幂等：同一个 key 再记一次 → 没有变化
  assert.equal(engine.markFired([KEY]), false, '重复记应当返回 false');
  // 脏输入不炸、也不该往账本里塞东西
  // ⚠️ 空串要一起挡：`k == null` 挡不住 `''`，而空 key 进了账本毫无意义
  //    （第一版这里就漏了空串 —— 断言当场报红，才补上 `k === ''` 那一判）
  assert.equal(engine.markFired([]), false, '没给 key → false');
  assert.equal(engine.markFired([null, undefined, '']), false, '空/脏 key 一律不记');
  assert.ok(!engine.firedKeys().includes(''), '账本里不许出现空 key');
  assert.ok(Array.isArray(engine.firedKeys()));
});
