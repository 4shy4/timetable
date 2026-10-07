// 课程摘要提醒的单元测试（纯函数，不依赖服务）。
//
// 用户需求：「前一天晚上提醒第二天课程，早上提醒上午课程，中午提醒下午课程，
// 傍晚提醒晚上课程」+「何时提醒、要不要提醒都能调」。
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  dueDigests, normalizeDigest, defaultDigestSettings, parseHHMM,
  courseStartOn, coursesOnDay, DIGEST_FRESH_MS,
} = await import('../core/course-digest.js');

// 构造一门课：周三第 1-2 节（08:00）、第 1-16 周
const TERM = '2026-09-21';   // 周一
function course(over = {}) {
  return {
    id: over.id || 'c1',
    type: 'course',
    title: over.title || '高等数学B(I)',
    location: over.location || '北101',
    start: over.start || '2026-09-23T08:00:00',   // 周三（第 1 周的周三 = 09-23）
    end: over.end || '2026-09-23T09:35:00',
    weeks: over.weeks || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
  };
}
const SETTINGS = { termStart: TERM, courseDigest: { enabled: true, slots: {} } };

test('默认配置：总开关关、逐条提醒关、四个槽位都开且时间合理', () => {
  const d = defaultDigestSettings();
  assert.equal(d.enabled, false, '默认必须是关的（不改变用户现有行为）');
  assert.equal(d.perCourseReminders, false);
  for (const k of ['tonight', 'morning', 'noon', 'evening']) {
    assert.ok(d.slots[k], `缺槽位 ${k}`);
    assert.equal(d.slots[k].on, true);
    assert.ok(parseHHMM(d.slots[k].at) !== null, `${k} 的时间不合法`);
  }
});

test('总开关关着时，任何时间都不响', () => {
  const r = dueDigests({
    events: [course()],
    settings: { termStart: TERM, courseDigest: { enabled: false } },
    now: new Date('2026-09-22T21:05:00'),   // 周二晚 21:05，本该提醒周三的课
  });
  assert.equal(r.length, 0);
});

test('前一天晚上提醒明天的课（tonight 槽位）', () => {
  const r = dueDigests({
    events: [course()],
    settings: SETTINGS,
    now: new Date('2026-09-22T21:05:00'),   // 周二 21:05 → 明天是周三
  });
  assert.equal(r.length, 1, `应当只有 tonight 一条，实际 ${r.length}`);
  assert.equal(r[0].slot, 'tonight');
  assert.match(r[0].title, /明天/);
  assert.match(r[0].body, /08:00 高等数学B\(I\) @北101/);
  assert.equal(r[0].key, 'digest:tonight:2026-09-23');
});

test('早上/中午/傍晚各提醒对应时段的课', () => {
  const morning = course({ id: 'm', title: '上午课', start: '2026-09-23T08:00:00' });
  const noon = course({ id: 'n', title: '下午课', start: '2026-09-23T13:30:00' });
  const evening = course({ id: 'e', title: '晚上课', start: '2026-09-23T18:30:00' });

  const atMorning = dueDigests({
    events: [morning, noon, evening], settings: SETTINGS,
    now: new Date('2026-09-23T07:35:00'),
  });
  assert.ok(atMorning.some((d) => d.slot === 'morning'), '早上该响');
  assert.ok(!atMorning.some((d) => d.slot === 'noon'), '早上不该响中午那条');
  assert.ok(!atMorning.some((d) => d.slot === 'evening'), '早上不该响傍晚那条');
  const m = atMorning.find((d) => d.slot === 'morning');
  assert.match(m.body, /上午课/);
  assert.ok(!/下午课/.test(m.body), '上午的摘要不该带上下午的课');

  const atNoon = dueDigests({
    events: [morning, noon, evening], settings: SETTINGS,
    now: new Date('2026-09-23T12:35:00'),
  });
  assert.ok(atNoon.some((d) => d.slot === 'noon'), '中午该响');
  const n = atNoon.find((d) => d.slot === 'noon');
  assert.match(n.body, /下午课/);
  assert.ok(!/上午课/.test(n.body));

  const atEve = dueDigests({
    events: [morning, noon, evening], settings: SETTINGS,
    now: new Date('2026-09-23T17:35:00'),
  });
  assert.ok(atEve.some((d) => d.slot === 'evening'), '傍晚该响');
  assert.match(atEve.find((d) => d.slot === 'evening').body, /晚上课/);
});

test('同一槽位同一天只响一次（账本记账）', () => {
  const fired = new Set();
  const now = new Date('2026-09-22T21:05:00');
  const first = dueDigests({ events: [course()], settings: SETTINGS, now, fired });
  assert.equal(first.length, 1);
  first.forEach((d) => fired.add(d.key));
  const second = dueDigests({ events: [course()], settings: SETTINGS, now, fired });
  assert.equal(second.length, 0, '记过账就不该再响');
});

test('太晚了不补发（23:00 打开不该连弹早上/中午/傍晚三条）', () => {
  const morning = course({ id: 'm', start: '2026-09-23T08:00:00' });
  const noon = course({ id: 'n', start: '2026-09-23T13:30:00' });
  const evening = course({ id: 'e', start: '2026-09-23T18:30:00' });
  const r = dueDigests({
    events: [morning, noon, evening], settings: SETTINGS,
    now: new Date('2026-09-23T23:00:00'),
  });
  const slots = r.map((d) => d.slot);
  assert.ok(!slots.includes('morning'), '早上的摘要 23:00 才发没意义');
  assert.ok(!slots.includes('noon'), '中午的摘要 23:00 才发没意义');
  assert.ok(!slots.includes('evening'), '傍晚的摘要 23:00 才发没意义');
});

test('目标时段没有课就不响（不发自内容）', () => {
  const onlyMorning = course({ id: 'm', start: '2026-09-23T08:00:00' });
  const r = dueDigests({
    events: [onlyMorning], settings: SETTINGS,
    now: new Date('2026-09-23T17:35:00'),   // 傍晚，但今天没有晚上的课
  });
  assert.ok(!r.some((d) => d.slot === 'evening'), '没有晚上的课就不该发傍晚摘要');
});

test('课都上完了就不再提醒（upcoming 过滤）', () => {
  const c = course({ start: '2026-09-23T08:00:00' });
  const r = dueDigests({
    events: [c], settings: SETTINGS,
    now: new Date('2026-09-23T09:00:00'),   // 8:00 的课已经开始了
  });
  assert.ok(!r.some((d) => d.slot === 'morning'), '已经开始的课不该还在"上午摘要"里');
});

test('单个槽位可以关掉', () => {
  const s = { termStart: TERM, courseDigest: { enabled: true, slots: { tonight: { on: false, at: '21:00' } } } };
  const r = dueDigests({ events: [course()], settings: s, now: new Date('2026-09-22T21:05:00') });
  assert.ok(!r.some((d) => d.slot === 'tonight'), '关掉的槽位不该响');
});

test('槽位时间可以改', () => {
  const s = { termStart: TERM, courseDigest: { enabled: true, slots: { tonight: { on: true, at: '19:00' } } } };
  const early = dueDigests({ events: [course()], settings: s, now: new Date('2026-09-22T19:05:00') });
  assert.ok(early.some((d) => d.slot === 'tonight'), '改成 19:00 后 19:05 该响');
  const late = dueDigests({ events: [course()], settings: s, now: new Date('2026-09-22T20:40:00') });
  assert.ok(!late.some((d) => d.slot === 'tonight'),
    `19:00 的槽位在 20:40 已超过 ${DIGEST_FRESH_MS / 60000} 分钟，不该再响`);
});

test('只汇总课程，不管日程/作业（type 过滤）', () => {
  const personal = { id: 'p', type: 'personal', title: '交实验报告', start: '2026-09-23T08:00:00', end: '2026-09-23T08:00:00' };
  const r = dueDigests({
    events: [personal], settings: SETTINGS,
    now: new Date('2026-09-22T21:05:00'),
  });
  assert.equal(r.length, 0, '非课程事件不该进摘要');
});

test('周次对不上就不算（单双周/周次范围）', () => {
  const evenWeeks = course({ weeks: [2, 4, 6, 8] });
  // 2026-09-23 是第 1 周 → 不该出现
  const r = dueDigests({ events: [evenWeeks], settings: SETTINGS, now: new Date('2026-09-22T21:05:00') });
  assert.equal(r.length, 0, '第 1 周不该出现（这门课只有双周）');
  // 09-30 是第 2 周 → 该出现
  const r2 = dueDigests({ events: [evenWeeks], settings: SETTINGS, now: new Date('2026-09-29T21:05:00') });
  assert.equal(r2.length, 1, '第 2 周该出现');
});

test('没有 termStart 时安静不响（不猜周次）', () => {
  const r = dueDigests({
    events: [course()],
    settings: { courseDigest: { enabled: true } },
    now: new Date('2026-09-22T21:05:00'),
  });
  assert.equal(r.length, 0);
});

test('normalizeDigest 容错：旧数据没 courseDigest 也能跑', () => {
  const d = normalizeDigest(undefined);
  assert.equal(d.enabled, false);
  assert.ok(d.slots.tonight);
  // 脏数据：非法时间要回落到默认
  const d2 = normalizeDigest({ enabled: true, slots: { tonight: { on: true, at: '25:99' } } });
  assert.equal(d2.slots.tonight.at, '21:00', '非法时间要回落到默认 21:00');
  const d3 = normalizeDigest({ enabled: true, slots: { noon: { on: false } } });
  assert.equal(d3.slots.noon.on, false);
});

test('courseStartOn：星期/周次/时刻都对得上才算', () => {
  const c = course();                            // 周三 08:00，第 1-16 周
  const wed = new Date('2026-09-23T00:00:00');   // 第 1 周周三
  assert.ok(courseStartOn(c, wed, TERM), '第 1 周周三该有课');
  const tue = new Date('2026-09-22T00:00:00');
  assert.equal(courseStartOn(c, tue, TERM), null, '周二不该有');
  const wed2 = new Date('2026-09-30T00:00:00');  // 第 2 周周三
  const at = courseStartOn(c, wed2, TERM);
  assert.ok(at, '第 2 周周三该有课');
  assert.equal(at.getHours(), 8);
  assert.equal(at.getMinutes(), 0);
});

test('coursesOnDay：按时间排序且受 window 限制', () => {
  const a = course({ id: 'a', title: 'A', start: '2026-09-23T13:30:00' });
  const b = course({ id: 'b', title: 'B', start: '2026-09-23T08:00:00' });
  const day = new Date('2026-09-23T00:00:00');
  const all = coursesOnDay([a, b], day, TERM, null);
  assert.deepEqual(all.map((x) => x.ev.title), ['B', 'A'], '要按时间排序');
  const onlyAm = coursesOnDay([a, b], day, TERM, [5 * 60, 12 * 60]);
  assert.deepEqual(onlyAm.map((x) => x.ev.title), ['B'], 'window 只留上午');
});
