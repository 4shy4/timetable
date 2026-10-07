// iCalendar 生成的自检。
//
// 直接跑：node tools/ics.test.mjs
//
// 为什么这些断言值得写：ICS 的失败模式全是**静默的** ——
//   · 行太长 → 客户端截断或整份拒绝（不报错，只是"订阅了但没条目"）
//   · UID 每次都变 → 日历里不断堆重复条目（越刷新越乱，很难归因）
//   · 时间没写对（少了 Z / 用错时区）→ 提醒差 8 小时，只有到点了才发现
// 所以这里把"形状"钉死，而不是只测"函数没抛异常"。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCalendar, icsItems, foldLine, escapeText, utcStamp, dateStamp,
  triggerValue, hash32, MAX_ALARMS,
} from '../core/ics.js';

const bytes = (s) => Buffer.byteLength(s, 'utf8');

/** 物理行（按 CRLF 切） */
const physicalLines = (ics) => ics.replace(/\r\n$/, '').split('\r\n');

/** 展开折行，还原成逻辑行 */
const logicalLines = (ics) => ics.replace(/\r\n[ \t]/g, '').split('\r\n');

// ---------------------------------------------------------------- 折行

test('折行：每行不超过 75 个八位组', () => {
  // 全中文：一个字符 3 字节，按**字符**折会到 225 字节
  const line = `SUMMARY:${'很长的中文标题'.repeat(30)}`;
  for (const l of physicalLines(foldLine(line))) {
    assert.ok(bytes(l) <= 75, `行超长（${bytes(l)} 字节）: ${l.slice(0, 40)}…`);
  }
});

test('折行：续行以空格开头，且展开后与原文逐字相同', () => {
  const line = `DESCRIPTION:${'内容'.repeat(100)}`;
  const folded = foldLine(line);
  assert.ok(folded.includes('\r\n '), '应该产生了续行');
  assert.equal(folded.replace(/\r\n /g, ''), line, '展开后必须与原行一致');
});

test('折行：不会把一个 UTF-8 字符切成两半', () => {
  // 74 个 ASCII + 汉字，边界正好落在多字节字符前面
  const line = `${'a'.repeat(74)}中`;
  const folded = foldLine(line);
  assert.equal(folded.replace(/\r\n /g, ''), line);
  for (const l of folded.split('\r\n')) {
    // 能独立解码回原文说明没切坏（Buffer 解出替换字符 U+FFFD 就是切坏了）
    assert.ok(!Buffer.from(l, 'utf8').toString('utf8').includes('\uFFFD'), '有字符被截断');
  }
});

test('折行：不吃掉首字符，空行也安全', () => {
  assert.equal(foldLine(''), '');
  assert.equal(foldLine('A'), 'A');
  assert.equal(foldLine('中'), '中');
});

// ---------------------------------------------------------------- 转义

test('转义：反斜杠必须先处理，否则会把后面的转义再转一遍', () => {
  // 输入一个字面量 `\;`（反斜杠 + 分号）
  assert.equal(escapeText('\\;'), '\\\\\\;');
  assert.equal(escapeText('a;b'), 'a\\;b');
  assert.equal(escapeText('a,b'), 'a\\,b');
  assert.equal(escapeText('a\nb'), 'a\\nb');
  assert.equal(escapeText('a\r\nb'), 'a\\nb');
  assert.equal(escapeText(null), '');
  assert.equal(escapeText(undefined), '');
});

test('转义：逗号和分号在 UID/SUMMARY 里不会把字段切断', () => {
  const ics = buildCalendar({
    events: [{
      id: 'x1', title: '高数, 线代; 概率', start: '2026-09-21T08:00:00', end: '2026-09-21T09:00:00',
    }],
    settings: { termStart: '2026-09-21' },
    now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-09-22T00:00:00'),
  });
  const summary = logicalLines(ics).find((l) => l.startsWith('SUMMARY:'));
  assert.equal(summary, 'SUMMARY:高数\\, 线代\\; 概率');
});

// ---------------------------------------------------------------- 时间

test('时间戳：DTSTART 用 UTC，全天用 DATE', () => {
  const d = new Date(2026, 8, 21, 15, 30, 0); // 本地 2026-09-21 15:30
  assert.match(utcStamp(d), /^\d{8}T\d{6}Z$/);
  assert.equal(dateStamp(d), '20260921');
});

test('时间戳：UTC 换算跟着本地时区走（不写死 +8）', () => {
  const d = new Date(2026, 8, 21, 15, 30, 0);
  // 与 Date 自己算的 UTC 一致，说明没有手动加减时区
  const expect = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  assert.equal(utcStamp(d), expect);
});

test('TRIGGER：本项目"正数=提前"要翻成 ICS"负数=之前"', () => {
  assert.equal(triggerValue(10), '-PT10M');
  assert.equal(triggerValue(60), '-PT60M');
  assert.equal(triggerValue(0), 'PT0M');
  assert.equal(triggerValue(-5), 'PT5M', '负数=延后 → 正的 DURATION');
  assert.equal(triggerValue('30'), '-PT30M', '字符串也要认');
  // ⚠️ Number(null) === 0，而 0 是合法值。不显式挡掉的话，数据里一个缺失的
  //    提醒会变成"开始那一刻响一次" —— 用户没设过的闹钟凭空出现。
  assert.equal(triggerValue(null), null, 'null 是"没设提醒"，不是"0 分钟前"');
  assert.equal(triggerValue(undefined), null);
  assert.equal(triggerValue(''), null);
  assert.equal(triggerValue('abc'), null);
});

test('TRIGGER：超过 7 天会被夹住（客户端会丢弃离谱的提前量）', () => {
  assert.equal(triggerValue(999999), '-PT10080M');
  assert.equal(triggerValue(-999999), 'PT10080M');
});

// ---------------------------------------------------------------- UID

test('UID：跨刷新必须稳定（否则日历里会不断堆重复条目）', () => {
  const ev = { id: 'evt_abc', title: '每周例会', start: '2026-09-21T09:00:00', end: '2026-09-21T10:00:00', recurrence: { freq: 'none' } };
  const settings = { termStart: '2026-09-21' };
  const at = (now) => icsItems([ev], { settings, now, from: new Date('2026-09-21T00:00:00'), to: new Date('2026-09-22T00:00:00') })[0].uid;
  // 两次生成的"当前时间"完全不同，UID 必须一模一样
  assert.equal(at(new Date('2026-09-21T08:00:00')), at(new Date('2027-01-01T08:00:00')));
});

test('UID：同一事件的各个实例互不相同', () => {
  const ev = {
    id: 'evt_rec', title: '打卡', start: '2026-09-21T09:00:00', end: '2026-09-21T09:30:00',
    recurrence: { freq: 'weekly', interval: 1, byDay: [1] },
  };
  const items = icsItems([ev], {
    settings: { termStart: '2026-09-21' }, now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-10-20T00:00:00'),
  });
  assert.ok(items.length >= 4, `应该有多次发生，实际 ${items.length}`);
  assert.equal(new Set(items.map((i) => i.uid)).size, items.length, 'UID 必须互不相同');
});

test('UID：换 id 就会换 UID，改标题不会', () => {
  const base = { start: '2026-09-21T09:00:00', end: '2026-09-21T10:00:00' };
  const uid = (o) => icsItems([{ ...base, ...o }], {
    settings: {}, now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-09-22T00:00:00'),
  })[0].uid;
  assert.equal(uid({ id: 'a', title: '一' }), uid({ id: 'a', title: '二' }), '改标题不该换 UID');
  assert.notEqual(uid({ id: 'a' }), uid({ id: 'b' }), '换 id 必须换 UID');
});

test('hash32：稳定、定长、对长 id 也够短', () => {
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abd'));
  assert.match(hash32('x'.repeat(500)), /^[0-9a-f]{8}$/);
});

// ---------------------------------------------------------------- 结构

const SAMPLE_EVENTS = [
  { id: 'e1', title: '交作业', start: '2026-09-22T23:59:00', end: '2026-09-22T23:59:00', reminders: [60, 30, 10, 0, -5], location: '线上', notes: '第二章' },
  { id: 'e2', title: '已完成的', start: '2026-09-23T10:00:00', end: '2026-09-23T11:00:00', done: true },
  { id: 'c1', title: '高等数学', type: 'course', location: '广楼G309', teacher: '单鑫',
    start: '2026-09-24T18:30:00', end: '2026-09-24T20:05:00', weeks: [1, 2, 3], recurrence: { freq: 'none' } },
];

function sampleIcs(extra = {}) {
  return buildCalendar({
    events: SAMPLE_EVENTS,
    settings: { termStart: '2026-09-21', defaultReminders: [10, 0] },
    now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'),
    to: new Date('2026-12-31T00:00:00'),
    ...extra,
  });
}

test('结构：VCALENDAR 外壳、CRLF、必有 VERSION/PRODID', () => {
  const ics = sampleIcs();
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'), '开头必须是 BEGIN:VCALENDAR + CRLF');
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'), '结尾必须是 END:VCALENDAR + CRLF');
  const L = logicalLines(ics);
  assert.ok(L.includes('VERSION:2.0'));
  assert.ok(L.some((l) => l.startsWith('PRODID:')));
  assert.ok(L.includes('CALSCALE:GREGORIAN'));
  assert.ok(L.includes('METHOD:PUBLISH'));
  assert.ok(L.some((l) => l.startsWith('X-WR-CALNAME:')));
  // 不许出现裸 LF（必须全是 CRLF）
  assert.ok(!/[^\r]\n/.test(ics), '有裸 LF —— RFC 5545 要求 CRLF');
});

test('结构：生成出来的每一物理行都不超过 75 字节', () => {
  const ics = sampleIcs();
  const bad = physicalLines(ics).filter((l) => bytes(l) > 75);
  assert.equal(bad.length, 0, `超长行:\n${bad.slice(0, 3).join('\n')}`);
});

test('结构：BEGIN/END 配对', () => {
  const L = logicalLines(sampleIcs());
  const count = (p) => L.filter((l) => l === p).length;
  assert.equal(count('BEGIN:VEVENT'), count('END:VEVENT'), 'VEVENT 不配对');
  assert.equal(count('BEGIN:VALARM'), count('END:VALARM'), 'VALARM 不配对');
  assert.ok(count('BEGIN:VEVENT') >= 1);
});

test('结构：每个 VEVENT 都有 UID / DTSTAMP / SUMMARY', () => {
  const L = logicalLines(sampleIcs());
  const starts = L.map((l, i) => (l === 'BEGIN:VEVENT' ? i : -1)).filter((i) => i >= 0);
  assert.equal(starts.length, 4, '1 个普通 + 3 个课程实例 = 4（done 那条被排除）');
  for (const start of starts) {
    const block = L.slice(start, L.indexOf('END:VEVENT', start));
    for (const key of ['UID:', 'DTSTAMP:', 'SUMMARY:']) {
      assert.ok(block.some((l) => l.startsWith(key)), `VEVENT 缺 ${key}`);
    }
  }
});

test('结构：TRANSP 必须是 OPAQUE（TRANSPARENT 会被 Apple 日历画成淡色）', () => {
  const L = logicalLines(sampleIcs());
  assert.ok(L.includes('TRANSP:OPAQUE'), '缺少 TRANSP:OPAQUE');
  assert.ok(!L.includes('TRANSP:TRANSPARENT'),
    'TRANSPARENT = 空闲，Apple 日历会把整份日历画成淡色/空心');
});

// ---------------------------------------------------------------- 过滤

test('过滤：整条 done 的事件不进日历', () => {
  const L = logicalLines(sampleIcs());
  assert.ok(!L.some((l) => l.includes('已完成的')), 'done 的事件不该出现');
});

test('过滤：被戳破的那一颗不进日历，同一事件别的颗要留着', () => {
  const ev = {
    id: 'evt_p', title: '跑步', start: '2026-09-21T07:00:00', end: '2026-09-21T07:30:00',
    recurrence: { freq: 'weekly', interval: 1, byDay: [1] },
    popped: { '2026-09-28': { at: '2026-09-28T06:00:00Z', remainingMs: -3600000 } },
  };
  const items = icsItems([ev], {
    settings: {}, now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-10-06T00:00:00'),
  });
  const days = items.map((i) => i.occurrenceKey);
  assert.ok(days.includes('2026-09-21'), '没被戳破的颗要在');
  assert.ok(!days.includes('2026-09-28'), '被戳破的那颗要消失');
  assert.ok(days.includes('2026-10-05'), '之后的颗不受影响');
});

test('过滤：includeDone 时都放回来（给"整份导出"用）', () => {
  const items = icsItems(SAMPLE_EVENTS, {
    settings: { termStart: '2026-09-21' }, now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-12-31T00:00:00'),
    includeDone: true,
  });
  assert.ok(items.some((i) => i.summary === '已完成的'));
});

// ---------------------------------------------------------------- 课表

test('课表：按 weeks + termStart 展开成对应周数', () => {
  const items = icsItems([SAMPLE_EVENTS[2]], {
    settings: { termStart: '2026-09-21' }, now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-12-31T00:00:00'),
  });
  assert.equal(items.length, 3, 'weeks=[1,2,3] 应该正好 3 次');
  assert.deepEqual(items.map((i) => i.occurrenceKey), ['2026-09-24', '2026-10-01', '2026-10-08']);
});

test('课表：缺 termStart 时不展开（宁可不显示，也不要显示错日期）', () => {
  const items = icsItems([SAMPLE_EVENTS[2]], {
    settings: {}, now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-12-31T00:00:00'),
  });
  // occurrences() 在没有 termStart 时落到"只给 start 那一天"
  assert.ok(items.length <= 1, `不该凭空展开成 ${items.length} 次`);
});

// ---------------------------------------------------------------------------
// 「周期」筛选在日历上（这条**真的有效**，和提醒那条不同）
//
// 日历一次展开 400 天，远超出周期的重复实例本来都会被写进 .ics，
// 所以 periodLimit 打开后 VEVENT 数量会明显变少。这就是设置里那个开关的作用点。
// ---------------------------------------------------------------------------

test('周期筛选：periodLimit 打开后，日历里远期重复实例被收起来', () => {
  // 每天的重复事件，展开 400 天 → 会有一大堆；周期 3 天 → 只留最近那颗之后 3 天内的
  const ev = {
    id: 'daily', title: '每天打卡', start: '2026-09-21T09:00:00', end: '2026-09-21T09:30:00',
    recurrence: { freq: 'daily', interval: 1 }, periodDays: 3,
  };
  const opts = {
    settings: {}, now: new Date('2026-09-21T08:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-12-31T00:00:00'),
  };
  const all = icsItems([ev], opts);
  const limited = icsItems([ev], { ...opts, periodLimit: true });
  assert.ok(all.length > 50, `不筛时应当有很多颗，实际 ${all.length}`);
  assert.equal(limited.length, 4, `周期 3 天 → 9/21…9/24 共 4 颗，实际 ${limited.length}`);
  assert.deepEqual(limited.map((i) => i.occurrenceKey),
    ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24']);
});

test('周期筛选：没设周期的事件，periodLimit 不影响它', () => {
  const withP = { id: 'a', title: 'A', start: '2026-09-21T09:00:00', end: '2026-09-21T10:00:00', recurrence: { freq: 'daily', interval: 1 }, periodDays: 3 };
  const without = { id: 'b', title: 'B', start: '2026-09-21T14:00:00', end: '2026-09-21T15:00:00', recurrence: { freq: 'daily', interval: 1 } };
  const opts = {
    settings: {}, now: new Date('2026-09-21T08:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-12-31T00:00:00'),
  };
  const limited = icsItems([withP, without], { ...opts, periodLimit: true });
  const bCount = limited.filter((i) => i.eventId === 'b').length;
  const bAll = icsItems([without], opts).length;
  assert.equal(bCount, bAll, '没设周期的事件不该被筛');
});

// ---------------------------------------------------------------- 提醒

test('提醒：每个事件带上 VALARM，且按 maxAlarms 截断', () => {
  const items = icsItems(SAMPLE_EVENTS, {
    settings: { termStart: '2026-09-21', defaultReminders: [10, 0] }, now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-12-31T00:00:00'),
  });
  const first = items.find((i) => i.eventId === 'e1');
  // 给了 5 个，默认只留 3 个，且留的是提前量最大的（最早响的）
  assert.equal(first.alarms.length, MAX_ALARMS);
  assert.deepEqual(first.alarms.map((a) => a.trigger), ['-PT60M', '-PT30M', '-PT10M']);
});

test('提醒：没写 reminders 就回退到 defaultReminders', () => {
  const items = icsItems([{ id: 'z', title: 'z', start: '2026-09-21T09:00:00', end: '2026-09-21T10:00:00' }], {
    settings: { defaultReminders: [15] }, now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-09-22T00:00:00'),
  });
  assert.deepEqual(items[0].alarms.map((a) => a.trigger), ['-PT15M']);
});

test('提醒：VALARM 结构完整（TRIGGER + ACTION + DESCRIPTION）', () => {
  const L = logicalLines(sampleIcs());
  const starts = L.map((l, i) => (l === 'BEGIN:VALARM' ? i : -1)).filter((i) => i >= 0);
  assert.ok(starts.length >= 3, `应该有闹钟，实际 ${starts.length}`);
  for (const s of starts) {
    const block = L.slice(s, L.indexOf('END:VALARM', s));
    assert.ok(block.some((l) => l.startsWith('TRIGGER')), 'VALARM 缺 TRIGGER');
    assert.ok(block.includes('ACTION:DISPLAY'), 'VALARM 缺 ACTION:DISPLAY');
    assert.ok(block.some((l) => l.startsWith('DESCRIPTION:')), 'DISPLAY 动作必须带 DESCRIPTION');
  }
});

// ---------------------------------------------------------------- 时间与时长

test('时长：零时长事件只写 DTSTART，不写 DTEND', () => {
  const ics = buildCalendar({
    events: [{ id: 't', title: '交作业', start: '2026-09-21T23:59:00', end: '2026-09-21T23:59:00' }],
    settings: {}, now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-09-22T00:00:00'),
  });
  const L = logicalLines(ics);
  assert.ok(L.some((l) => l.startsWith('DTSTART:')), '要有 DTSTART');
  assert.ok(!L.some((l) => l.startsWith('DTEND')), '零时长不该写 DTEND（会被当成非法区间）');
});

test('时长：有结束时间的照常写 DTSTART/DTEND', () => {
  const L = logicalLines(sampleIcs());
  assert.ok(L.some((l) => l.startsWith('DTSTART:')), '要有 DTSTART');
  assert.ok(L.some((l) => l.startsWith('DTEND:')), '要有 DTEND');
});

test('全天事件：用 VALUE=DATE，且 DTEND 是次日（排他）', () => {
  const ics = buildCalendar({
    events: [{ id: 'a', title: '放假', allDay: true, start: '2026-10-01T00:00:00', end: '2026-10-01T00:00:00' }],
    settings: {}, now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-10-10T00:00:00'),
  });
  const L = logicalLines(ics);
  assert.ok(L.includes('DTSTART;VALUE=DATE:20261001'), '全天要用 VALUE=DATE');
  // 零时长的全天：只写 DTSTART，不写次日的 DTEND
  assert.ok(!L.some((l) => l.startsWith('DTEND')), '零时长全天不写 DTEND');
});

test('全天事件：跨天时 DTEND 写次日', () => {
  const ics = buildCalendar({
    events: [{ id: 'a2', title: '旅行', allDay: true, start: '2026-10-01T00:00:00', end: '2026-10-03T00:00:00' }],
    settings: {}, now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-10-10T00:00:00'),
  });
  const L = logicalLines(ics);
  assert.ok(L.includes('DTSTART;VALUE=DATE:20261001'));
  assert.ok(L.includes('DTEND;VALUE=DATE:20261003'), 'DTEND 应该等于 end（排他语义下正好覆盖 1-2 号）');
});

// ---------------------------------------------------------------- 健壮性

test('健壮：空事件列表也能产出合法的空日历', () => {
  const ics = buildCalendar({ events: [], settings: {}, now: new Date('2026-09-21T00:00:00') });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!ics.includes('BEGIN:VEVENT'));
});

test('健壮：坏日期/缺字段不会抛异常', () => {
  const ics = buildCalendar({
    events: [
      { id: 'bad1', title: '坏日期', start: 'not-a-date' },
      { id: 'bad2', start: '2026-09-21T09:00:00' },           // 没标题
      { id: 'bad3', title: '空', start: '2026-09-21T09:00:00', reminders: ['x', null, 5] },
    ],
    settings: {}, now: new Date('2026-09-21T00:00:00'),
    from: new Date('2026-09-21T00:00:00'), to: new Date('2026-09-22T00:00:00'),
  });
  const L = logicalLines(ics);
  assert.ok(L.some((l) => l === 'SUMMARY:(无标题)'), '没标题要有兜底');
  // 坏提醒值被丢掉，合法的 5 分钟留下
  assert.ok(L.includes('TRIGGER;RELATED=START:-PT5M'));
  assert.ok(!L.some((l) => l.includes('TRIGGER;RELATED=START:-PTNaNM')));
  // `null` / `'x'` 不能变成"开始那一刻"的闹钟（它们只是脏数据）
  assert.ok(!L.some((l) => l === 'TRIGGER;RELATED=START:PT0M'),
    'null 不该变成 PT0M 闹钟');
});

test('健壮：VEVENT 数量有上限（防止每天重复 × 一年撑爆文件）', () => {
  const events = Array.from({ length: 40 }, (_, i) => ({
    id: `d${i}`, title: `每天${i}`, start: '2026-01-01T09:00:00', end: '2026-01-01T09:30:00',
    recurrence: { freq: 'daily', interval: 1 },
  }));
  const ics = buildCalendar({
    events, settings: {}, now: new Date('2026-01-01T00:00:00'),
    from: new Date('2026-01-01T00:00:00'), to: new Date('2027-01-01T00:00:00'),
  });
  const n = logicalLines(ics).filter((l) => l === 'BEGIN:VEVENT').length;
  assert.ok(n <= 3000, `VEVENT 数量应被限制，实际 ${n}`);
  assert.ok(n > 0);
});

test('默认窗口：不传 from/to 也能生成（以 now 为基准）', () => {
  const ics = buildCalendar({
    events: [{ id: 'n', title: '近期', start: '2026-09-25T09:00:00', end: '2026-09-25T10:00:00' }],
    settings: {}, now: new Date('2026-09-21T00:00:00'),
  });
  assert.ok(logicalLines(ics).some((l) => l.startsWith('SUMMARY:近期')));
});
