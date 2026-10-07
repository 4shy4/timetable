// iCalendar（RFC 5545）生成 —— 让 iPad/iPhone 用**系统日历**订阅我们的日程。
//
// 为什么要有这条路（背景，别删）：
//   网页端的提醒是页面里的 `setInterval` 每隔几秒自查一次（web/adapter/reminder.js
//   的 CHECK_MS，现在是 2 秒）—— 但**页面不开就完全不检查**，而且间隔决定误差。
//   iOS 上又没法像安卓那样用系统闹钟（装不了 APK）。所以"关掉 App 还能响"这件事，
//   在 iOS 上最可靠的落点是**让 iOS 自己的日历去管**：
//   电脑按一份 .ics，iPad 订阅一次，之后提醒由 iOS 原生发出，**电脑关着也照响**。
//
// 关键设计：
//   · **时间一律用 UTC（带 Z）**。ICS 里本地时间要靠 VTIMEZONE 才不歧义，
//     而生成正确的 VTIMEZONE 需要时区数据库。用 UTC 就没有这个问题：
//     `new Date(y,m,d,hh,mm)` 按运行环境的本地时区解释，`.toISOString()` 得到
//     该时刻正确的 UTC —— JS 引擎自己会套用那一天的夏令时规则，不需要 tz 库。
//   · **每个实例一个 VEVENT，不用 RRULE**。因为本项目的重复语义（周级 byDay+间隔、
//     月/年级"该月不存在就跳过"、课表按周次）映射成 RRULE 很别扭，
//     而且"某一颗被戳破了要单独消失"用 RRULE 根本表达不了（要上 RECURRENCE-ID 例外）。
//     直接展开成具体实例最简单，也永远正确。
//   · **UID 必须跨刷新稳定**。iOS 靠 UID 判断"这是同一条的新版本"还是"一条新事件"。
//     UID 每次刷新都变 → 日历里会**不断堆重复条目**。所以 UID 来自
//     (事件 id 的哈希 + 发生日期)，而不是当前时间或序号。
//   · **必须折行**：RFC 5545 规定一行不超过 75 个**八位组**（不含 CRLF），
//     续行以一个空格开头。按字节折，不能按字符 —— 一个汉字 3 字节，
//     按字符折会超限，某些解析器（包括 Apple 的）会拒绝或截断。
//
// ⚠️ core/ 必须平台无关：不能用 Buffer / TextEncoder 之外的宿主对象，
//    所以下面自己算 UTF-8 字节数。

import { expandRange, applyPeriodLimit } from './recurrence.js';
import { addDays, asDate, pad, startOfDay, toDateKey } from './time.js';

/** 日历名（iOS 订阅后显示的名字） */
const DEFAULT_CALENDAR_NAME = '日程表';

/** UID 的域名后缀。不要求真实存在，只要求全局唯一。 */
const UID_DOMAIN = 'timetable.local';

/**
 * 单个事件最多带几个闹钟。
 *
 * 实测提醒数组可能是 `[60,30,10,0,-5]`（5 个）。但 VEVENT 里塞太多 VALARM
 * 有些客户端会忽略或截断，而且对用户来说 5 个闹钟本来也是噪音。
 * 取前 N 个"提前量最大的"（最早响的），保证重要提醒不被砍掉。
 */
export const MAX_ALARMS = 3;

/** 提前量上限：超过 7 天的提醒没有意义，而且容易被客户端丢弃 */
const MAX_LEAD_MINUTES = 7 * 24 * 60;

/** 展开的时间窗默认长度（天）。课程一学期 16 周，一年足够覆盖。 */
const DEFAULT_HORIZON_DAYS = 400;

/** 一个日历最多输出多少条 VEVENT —— 防止"每天重复 × 一年"把文件撑爆 */
const MAX_VEVENTS = 3000;

/** 字符串的 UTF-8 字节数（不用 TextEncoder，保持零宿主依赖） */
function utf8Len(s) {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) n += 1;
    else if (cp < 0x800) n += 2;
    else if (cp < 0x10000) n += 3;
    else n += 4;
  }
  return n;
}

/**
 * RFC 5545 §3.1 折行：每行不超过 75 个八位组，续行以空格开头。
 * 按**码点**遍历、按**字节**计数，保证不会把一个 UTF-8 字符切成两半。
 */
export function foldLine(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of String(line)) {
    const b = utf8Len(ch);
    if (bytes + b > 75) {
      out.push(cur);
      cur = ` ${ch}`;   // 续行前导空格也算进 75 字节
      bytes = 1 + b;
    } else {
      cur += ch;
      bytes += b;
    }
  }
  out.push(cur);
  return out.join('\r\n');
}

/** TEXT 值转义：反斜杠 → 分号 → 逗号 → 换行（顺序不能反） */
export function escapeText(v) {
  return String(v == null ? '' : v)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** "20260921T153000Z"（UTC，ICS 的 DATE-TIME 形式） */
export function utcStamp(d) {
  return asDate(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** "20260921"（ICS 的 DATE 形式，用**本地**日历日） */
export function dateStamp(d) {
  const x = asDate(d);
  return `${x.getFullYear()}${pad(x.getMonth() + 1)}${pad(x.getDate())}`;
}

/**
 * 提醒"提前多少分钟" → VALARM 的 TRIGGER 值。
 *
 * 本项目的符号约定（见 server/store.js）：**正数 = 提前，负数 = 延后，0 = 正好**。
 * ICS 的 TRIGGER 反过来：负的 DURATION 表示"在开始之前"。
 */
export function triggerValue(minutesBefore) {
  // ⚠️ 必须先挡掉 null/undefined/''：`Number(null)` 是 **0**，而 0 是合法值
  //    （"正好开始时提醒"）。不挡的话，数据里一个缺失的提醒会静默变成
  //    "开始那一刻响一次" —— 用户没设过的闹钟凭空出现。
  if (minutesBefore === null || minutesBefore === undefined || minutesBefore === '') return null;
  const raw = Number(minutesBefore);
  if (!Number.isFinite(raw)) return null;
  const m = Math.max(-MAX_LEAD_MINUTES, Math.min(MAX_LEAD_MINUTES, Math.round(raw)));
  if (m === 0) return 'PT0M';
  return m > 0 ? `-PT${m}M` : `PT${-m}M`;
}

/** FNV-1a 32 位哈希 → 8 位十六进制。用来把长 id 压成短而稳定的 UID 片段。 */
export function hash32(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 某个事件的所有实例是否被戳破过。
 * 服务端把按实例的破裂记在 `popped['YYYY-MM-DD']`（见 server/store.js:425）。
 */
function isPopped(ev, dateKey) {
  return !!(ev.popped && typeof ev.popped === 'object' && ev.popped[dateKey]);
}

/** 取这次实例该用的提醒数组 */
function alarmsFor(ev, settings) {
  const list = Array.isArray(ev.reminders) && ev.reminders.length
    ? ev.reminders
    : (settings && Array.isArray(settings.defaultReminders) ? settings.defaultReminders : []);
  const seen = new Set();
  const out = [];
  for (const m of list) {
    const t = triggerValue(m);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({ trigger: t, minutes: Number(m) });
  }
  // 提前量大的排前面（最早响的在前），再按上限截断
  out.sort((a, b) => b.minutes - a.minutes);
  return out;
}

/** DESCRIPTION 内容：把有用但不在标题里的信息拼起来 */
function descriptionFor(ev, occ) {
  const parts = [];
  if (ev.type === 'course' && ev.teacher) parts.push(`老师：${ev.teacher}`);
  else if (ev.teacher) parts.push(`老师：${ev.teacher}`);
  if (ev.notes) parts.push(String(ev.notes));
  // 截止时间和开始时间不同才值得写出来（"周三开始、周五截止"）
  if (ev.deadline && ev.deadline !== ev.start) {
    const dl = asDate(ev.deadline);
    if (!Number.isNaN(dl.getTime())) {
      parts.push(`截止：${dl.getFullYear()}-${pad(dl.getMonth() + 1)}-${pad(dl.getDate())} ${pad(dl.getHours())}:${pad(dl.getMinutes())}`);
    }
  }
  if (Array.isArray(ev.tags) && ev.tags.length) parts.push(ev.tags.join(' '));
  // 戳破这条实例时它还剩多久（负数=提前完成）—— 回收站里有，日历里也带上便于回看
  const info = ev.popped && ev.popped[toDateKey(occ)];
  if (info && Number.isFinite(info.remainingMs)) {
    const mins = Math.round(info.remainingMs / 60000);
    parts.push(mins < 0 ? `提前 ${-mins} 分钟完成` : `超时 ${mins} 分钟完成`);
  }
  return parts.join('\n');
}

/**
 * 把事件展开成"日历条目"（不生成文本，方便测试断言）。
 *
 * 过滤规则：
 *   · 整条 `done` 的（非重复事件被戳破）→ 不要
 *   · 某一颗被戳破的（`popped[日期]`）→ 只要那一颗不要
 *   这样日历反映的是"还没做的事"，和气泡界面一致。
 *
 * @returns {Array<object>}
 */
export function icsItems(events, {
  settings = {}, now = new Date(), from, to, maxAlarms = MAX_ALARMS, includeDone = false,
  periodLimit = false,
} = {}) {
  const fromD = from ? asDate(from) : addDays(startOfDay(now), -7);
  const toD = to ? asDate(to) : addDays(fromD, DEFAULT_HORIZON_DAYS);
  const termStart = settings.termStart || '';
  const items = [];

  let expanded = expandRange(events, fromD, toD, termStart, (ev) => includeDone || !ev.done);
  // ⚠️ 「周期」筛选在**这里**才真正有效。
  //    日历一次展开 400 天，远超出周期的实例本来都会被写进 .ics —— 筛掉立竿见影。
  //    （对比：提醒那条路的扫描窗口只有 26 小时，周期根本够不着，见
  //      tools/reminder-plan.test.mjs 里那条结论性测试。）
  //    ⚠️ now 必须传：锚点 = "第一个未来的实例"，两个调用点必须用同一个 now 才一致。
  if (periodLimit) expanded = applyPeriodLimit(expanded, now);

  for (const it of expanded) {
    const dateKey = toDateKey(it.start);
    if (!includeDone && isPopped(it.event, dateKey)) continue;
    const start = it.start;
    const end = it.end;
    const allDay = !!it.event.allDay;
    const hasDuration = end && end.getTime() > start.getTime();
    items.push({
      uid: `evt-${hash32(it.event.id)}-${dateKey}@${UID_DOMAIN}`,
      eventId: it.event.id,
      occurrenceKey: dateKey,
      summary: it.event.title || '(无标题)',
      location: it.event.location || '',
      description: descriptionFor(it.event, start),
      allDay,
      start,
      end: hasDuration ? end : null,
      alarms: alarmsFor(it.event, settings).slice(0, maxAlarms),
      updatedAt: it.event.updatedAt || null,
    });
    if (items.length >= MAX_VEVENTS) break;
  }
  return items;
}

/** 一个 VEVENT 的文本（已折行、以 CRLF 分隔，不含结尾 CRLF） */
function vevent(item, now) {
  const lines = ['BEGIN:VEVENT'];
  lines.push(`UID:${escapeText(item.uid)}`);
  lines.push(`DTSTAMP:${utcStamp(now)}`);
  if (item.updatedAt) {
    const u = asDate(item.updatedAt);
    if (!Number.isNaN(u.getTime())) lines.push(`LAST-MODIFIED:${utcStamp(u)}`);
  }
  if (item.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${dateStamp(item.start)}`);
    // DTEND 是**排他的**：全天事件的结束要写"次日"
    if (item.end) lines.push(`DTEND;VALUE=DATE:${dateStamp(item.end)}`);
  } else {
    lines.push(`DTSTART:${utcStamp(item.start)}`);
    if (item.end) lines.push(`DTEND:${utcStamp(item.end)}`);
  }
  lines.push(`SUMMARY:${escapeText(item.summary)}`);
  if (item.location) lines.push(`LOCATION:${escapeText(item.location)}`);
  if (item.description) lines.push(`DESCRIPTION:${escapeText(item.description)}`);
  lines.push('SEQUENCE:0');
  lines.push('STATUS:CONFIRMED');
  // ⚠️ 必须是 OPAQUE（"占用时间"），不能是 TRANSPARENT。
  //    TRANSPARENT 是"空闲"，而 Apple 日历**把空闲事件画成淡色/空心** ——
  //    整份订阅日历会看起来灰蒙蒙的。OPAQUE 也是 RFC 5545 的默认值。
  lines.push('TRANSP:OPAQUE');
  for (const a of item.alarms) {
    lines.push('BEGIN:VALARM');
    // RELATED=START 是默认值，写出来更明确（"在开始之前/之后多久"）
    lines.push(`TRIGGER;RELATED=START:${a.trigger}`);
    lines.push('ACTION:DISPLAY');
    lines.push(`DESCRIPTION:${escapeText(item.summary)}`);
    lines.push('END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

/**
 * 生成整份 iCalendar 文本。
 *
 * @param {object} opts
 * @param {Array} opts.events      全部事件
 * @param {object} opts.settings   设置（要 termStart / defaultReminders）
 * @param {Date}  [opts.now]       生成时刻（DTSTAMP；测试里固定住方便断言）
 * @param {Date}  [opts.from]      展开起点，默认 now-7 天
 * @param {Date}  [opts.to]        展开终点，默认起点 + 400 天
 * @param {string}[opts.calendarName]
 * @param {number}[opts.ttlMinutes] 建议客户端多久刷新一次
 */
export function buildCalendar({
  events = [], settings = {}, now = new Date(), from, to,
  calendarName = DEFAULT_CALENDAR_NAME, maxAlarms = MAX_ALARMS,
  ttlMinutes = 60, includeDone = false, periodLimit = false,
} = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//Timetable//Local Timetable//CN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `X-WR-CALDESC:${escapeText('来自本机「日程表」应用，随电脑上的改动自动更新')}`,
    // 刷新提示：iOS 不保证照做，但桌面端（macOS / Thunderbird / Google）会参考
    `REFRESH-INTERVAL;VALUE=DURATION:PT${Math.max(1, Math.round(ttlMinutes))}M`,
    `X-PUBLISHED-TTL:PT${Math.max(1, Math.round(ttlMinutes))}M`,
  ];

  for (const item of icsItems(events, { settings, now, from, to, maxAlarms, includeDone, periodLimit })) {
    for (const l of vevent(item, now)) lines.push(l);
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
