// 调度器（服务端提醒引擎）的单元测试。
// 用临时 data 目录，避免污染真实数据。
//
// 说明：现在提醒可以「按紧急档位自动排」（方案 C）。要精确验证"某个提前量"时，
// 测试里统一用 autoReminders:false + 显式 reminders，把档位自动逻辑单独测。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'timetable-sched-test-'));
process.argv.push(`--data-dir=${TMP}`);

const store = await import('../server/store.js');
const sched = await import('../server/scheduler.js');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

function reset() {
  store.clearEvents({ keepCourses: false });
  store.updateSettings({ termStart: '', sectionTimes: [] });
}

// ---------------------------------------------------------------------------
// 手动提醒（autoReminders:false）
// ---------------------------------------------------------------------------

test('提前提醒：提醒点早于开始时间', () => {
  reset();
  const start = new Date('2026-03-02T10:00:00');
  const ev = store.upsertEvent({
    title: 'A', start: stamp(start), end: stamp(new Date(start.getTime() + 3600_000)),
    autoReminders: false, reminders: [10],
  });
  const due = sched.dueReminders(new Date('2026-03-02T09:00:00')).filter((i) => i.event.id === ev.id);
  assert.equal(due.length, 1);
  assert.equal(due[0].fireAt.getTime(), start.getTime() - 10 * 60_000);
  assert.equal(due[0].occurrence, start.toISOString());
});

test('延后提醒（提前量为负）：提醒点晚于开始时间', () => {
  reset();
  const start = new Date('2026-03-02T10:00:00');
  const ev = store.upsertEvent({ title: 'B', start: stamp(start), autoReminders: false, reminders: [-5] });
  const due = sched.dueReminders(new Date('2026-03-02T09:00:00')).filter((i) => i.event.id === ev.id);
  assert.equal(due.length, 1);
  assert.equal(due[0].fireAt.getTime(), start.getTime() + 5 * 60_000);
});

test('事件已开始但提醒点还没到 —— 必须仍能被算出来（回归）', () => {
  reset();
  const start = new Date('2026-03-02T10:00:00');
  const ev = store.upsertEvent({ title: 'C', start: stamp(start), autoReminders: false, reminders: [-30] });
  const due = sched.dueReminders(new Date('2026-03-02T10:10:00')).filter((i) => i.event.id === ev.id);
  assert.equal(due.length, 1, '已开始的事件的延后提醒被漏掉了');
  assert.equal(due[0].fireAt.getTime(), new Date('2026-03-02T10:30:00').getTime());
});

test('DONE 的日程不产生提醒', () => {
  reset();
  const ev = store.upsertEvent({ title: 'D', start: stamp(new Date('2026-03-02T10:00:00')), autoReminders: false, reminders: [10], done: true });
  const due = sched.dueReminders(new Date('2026-03-02T09:00:00')).filter((i) => i.event.id === ev.id);
  assert.equal(due.length, 0);
});

// ---------------------------------------------------------------------------
// 按"剩余时间档位"自动排提醒（v0.4：不再按颜色）
// ---------------------------------------------------------------------------

test('自动模式：还很远的事件只排少量提醒（周以上档）', () => {
  reset();
  const far = new Date('2026-03-20T10:00:00'); // 距今约 18 天 → "周"档
  const ev = store.upsertEvent({ title: '很远', start: stamp(far), autoReminders: true });
  const now = new Date('2026-03-02T10:00:00');
  assert.deepEqual(store.effectiveReminders(ev, now), [30, 0]);
  assert.equal(store.bandKeyForEvent(ev, now), 'week');
  // 更远（半年后）→ "月/年"档，只留最少的两次
  const veryFar = store.upsertEvent({ title: '更远', start: stamp(new Date('2026-09-20T10:00:00')), autoReminders: true });
  assert.deepEqual(store.effectiveReminders(veryFar, now), [10, 0]);
});

test('自动模式：同一事件走近后会"自动加密"提醒次数（不用用户干预）', () => {
  reset();
  const start = new Date('2026-03-02T18:00:00');
  const ev = store.upsertEvent({ title: '临近', start: stamp(start), autoReminders: true });

  // 3 天前 → 日档
  const longBefore = store.effectiveReminders(ev, new Date('2026-02-27T18:00:00'));
  // 1 天前 → 日档
  const dayBefore = store.effectiveReminders(ev, new Date('2026-03-01T18:00:00'));
  // 3 小时前 → 时档，提醒最多
  const soon = store.effectiveReminders(ev, new Date('2026-03-02T15:00:00'));

  assert.ok(longBefore.length <= dayBefore.length, `应逐级变多：${longBefore.length} -> ${dayBefore.length}`);
  assert.ok(dayBefore.length < soon.length, `应逐级变多：${dayBefore.length} -> ${soon.length}`);
  assert.equal(store.bandKeyForEvent(ev, new Date('2026-03-02T15:00:00')), 'hour');
  assert.ok(soon.some((m) => m < 0), '时档应包含"截止之后"的追问提醒');
});

test('自动模式：档位判定与共用核心层一致（按剩余时间，不按颜色）', () => {
  reset();
  const cases = [
    [200 * 24, 'month'],
    [100 * 24, 'month'],
    [20 * 24, 'week'],
    [30, 'day'],
    [12, 'hour'],
    [2, 'hour'],
    [0.5, 'minute'],
    [-1, 'second'],
  ];
  const now = new Date('2026-03-02T10:00:00');
  for (const [hours, expect] of cases) {
    const start = new Date(now.getTime() + hours * 3_600_000);
    assert.equal(store.bandKeyForEvent({ start: stamp(start) }, now), expect, `hours=${hours}`);
  }
});

test('颜色（事情多大）不再影响提醒强度：同样时间、不同颜色，强度一样', () => {
  reset();
  const now = new Date('2026-03-02T10:00:00');
  const soon = stamp(new Date(now.getTime() + 2 * 3_600_000));
  const a = store.upsertEvent({ title: '小事', start: soon, level: 'sky', autoReminders: true });
  const b = store.upsertEvent({ title: '大事', start: soon, level: 'red', autoReminders: true });
  assert.deepEqual(store.effectiveReminders(a, now), store.effectiveReminders(b, now));
  assert.equal(store.bandForEvent(a, now).intensity, store.bandForEvent(b, now).intensity);
});

test('手动模式：完全不理会档位，只按用户设的提醒', () => {
  reset();
  const start = new Date('2026-03-02T10:00:00');
  const ev = store.upsertEvent({ title: '手动', start: stamp(start), autoReminders: false, reminders: [120] });
  assert.deepEqual(store.effectiveReminders(ev, new Date('2026-03-02T09:59:00')), [120]);
});

// ---------------------------------------------------------------------------
// 触发与账本
// ---------------------------------------------------------------------------

test('tick 到点触发一次，并写入账本、不重复', () => {
  reset();
  sched.loadLedger();
  const start = new Date('2026-03-02T10:00:00');
  const ev = store.upsertEvent({ title: 'E', start: stamp(start), autoReminders: false, reminders: [10] });
  const fireAt = new Date(start.getTime() - 10 * 60_000);

  assert.equal(sched.tick(new Date(fireAt.getTime() - 30_000)).filter((i) => i.event.id === ev.id).length, 0);
  const fired = sched.tick(new Date(fireAt.getTime() + 5_000)).filter((i) => i.event.id === ev.id);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].bandKey, 'minute', '开始前 10 分钟应判定为"分"档');
  const again = sched.tick(new Date(fireAt.getTime() + 10_000)).filter((i) => i.event.id === ev.id);
  assert.equal(again.length, 0);
  assert.ok(sched.firedKeys().some((k) => k.startsWith(ev.id)), '账本没有记录');
});

test('迟到太多的提醒不补报（不做马后炮轰炸）', () => {
  reset();
  sched.loadLedger();
  const start = new Date('2026-03-02T10:00:00');
  const ev = store.upsertEvent({ title: 'F', start: stamp(start), autoReminders: false, reminders: [10] });
  const fired = sched.tick(new Date('2026-03-02T11:00:00')).filter((i) => i.event.id === ev.id);
  assert.equal(fired.length, 0);
});

test('通知强度表：强度越高停留越久、越"硬"，且按剩余时间档位取值', () => {
  const levels = [1, 2, 3, 4].map((k) => sched.NOTIFY_INTENSITY[k].level);
  assert.deepEqual(levels, [1, 2, 3, 4]);
  const durs = [1, 2, 3, 4].map((k) => sched.NOTIFY_INTENSITY[k].durationMs);
  for (let i = 1; i < durs.length; i += 1) assert.ok(durs[i] > durs[i - 1]);
  assert.equal(sched.NOTIFY_INTENSITY[1].requireInteraction, false);
  assert.equal(sched.NOTIFY_INTENSITY[4].requireInteraction, true);
  const audios = [1, 2, 3, 4].map((k) => sched.NOTIFY_INTENSITY[k].audio);
  assert.equal(new Set(audios).size, 4, '四档应使用不同的提示音');

  // 剩余时间越少 → 强度越高（颜色不参与）
  const now = new Date('2026-03-02T10:00:00');
  const at = (hours) => sched.intensityFor({ start: stamp(new Date(now.getTime() + hours * 3_600_000)) }, now).level;
  assert.ok(at(24 * 200) <= at(24 * 3));
  assert.ok(at(24 * 3) <= at(5));
  assert.ok(at(5) < at(0.5));
  assert.equal(at(0.5), 4);
  // 已过期 → 最高
  assert.equal(sched.intensityFor({ start: stamp(new Date(now.getTime() - 3_600_000)) }, now).level, 4);
});

test('课表课程按 weeks 展开后也能算出提醒', () => {
  reset();
  store.updateSettings({ termStart: '2026-03-02', termWeeks: 18 });
  store.importCourses({
    meta: { source: 'test', termStart: '2026-03-02', termWeeks: 18, sectionTimes: [{ index: 1, start: '08:00', end: '08:45' }] },
    courses: [{ title: '高等数学', dayOfWeek: 1, sections: [1], weeks: [1, 2, 3] }],
    mode: 'merge',
  });
  const due = sched.dueReminders(new Date('2026-03-02T07:00:00')).filter((i) => i.event.title === '高等数学');
  assert.ok(due.length >= 1, '课程没有产生提醒点');
  // 课程用设置里的默认提醒（含准点），最早的一个应在开始前
  const earliest = due.reduce((a, b) => (a.fireAt < b.fireAt ? a : b));
  assert.ok(earliest.fireAt.getTime() <= new Date('2026-03-02T08:00:00').getTime());
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});
