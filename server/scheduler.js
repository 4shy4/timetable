// 提醒引擎：服务端常驻通道（即便浏览器关掉也能提醒）。
// 每 TICK_MS 跑一次，计算「未来 HORIZON_HOURS 内应该响、但还没响过」的提醒。
import fs from 'node:fs';
import { FIRED_FILE, HORIZON_HOURS, TICK_MS, ensureDirs } from './paths.js';
import * as store from './store.js';
import { dispatch } from './notify.js';
// 重复展开与「每几周」判定都用 core 的实现（避免多处各写一套、慢慢分叉）
import { occurrences as coreOccurrences, applyPeriodLimit } from '../core/recurrence.js';
// 课程摘要提醒（"前一天晚上提醒明天 / 早上提醒上午…"）
import { dueDigests } from '../core/course-digest.js';
// 「本地活动日记」（第 52 轮）：提醒真的发出去时记一条，并顺手扫一遍逾期
import { readActivitySettings, recordActivity } from '../core/activity-log.js';

export { TICK_MS };

const DAY_KEY = () => new Date().toISOString().slice(0, 10);

/**
 * 通知强度表（v0.4：按**剩余时间档位**，不再按颜色）。
 *
 * 颜色现在表示"事情多大"，跟紧急度无关；紧急度只看还剩多久。
 * 1–4 逐级加强：停留更久 → 加提示音 → 变成"必看"（不自动消失）。
 * 图标也用时间语义（⏳ 还早 / ⏰ 今天 / ⚠️ 几小时 / 🚨 马上到期+已过期）。
 */
export const NOTIFY_INTENSITY = {
  1: { level: 1, durationMs: 5000, requireInteraction: false, audio: 'ms-winsoundevent:Notification.Default', prefix: '⏳' },
  2: { level: 2, durationMs: 8000, requireInteraction: false, audio: 'ms-winsoundevent:Notification.IM', prefix: '⏰' },
  3: { level: 3, durationMs: 12000, requireInteraction: false, audio: 'ms-winsoundevent:Notification.Reminder', prefix: '⚠️' },
  4: { level: 4, durationMs: 20000, requireInteraction: true, audio: 'ms-winsoundevent:Notification.Looping.Alarm2', prefix: '🚨' },
};

/** 强度和图标：按事件当前的剩余时间档位取 */
export function intensityFor(ev, now = new Date()) {
  const info = store.bandForEvent(ev, now);
  const level = Math.min(4, Math.max(1, info.intensity || 1));
  return { ...NOTIFY_INTENSITY[level], band: info.band, overdue: info.overdue, level };
}

let ledger = { day: DAY_KEY(), keys: [] };
let timer = null;
let onFire = null;

function loadLedger() {
  ensureDirs();
  try {
    if (fs.existsSync(FIRED_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(FIRED_FILE, 'utf8'));
      if (parsed && parsed.day === DAY_KEY()) ledger = parsed;
      else ledger = { day: DAY_KEY(), keys: [] };
    }
  } catch { ledger = { day: DAY_KEY(), keys: [] }; }
}

function saveLedger() {
  try {
    fs.writeFileSync(FIRED_FILE, JSON.stringify(ledger, null, 2), 'utf8');
  } catch (err) { console.error('[scheduler] 写账本失败', err.message); }
}

function markFired(key) {
  if (!ledger.keys.includes(key)) ledger.keys.push(key);
  saveLedger();
}

export function firedKeys() { return ledger.keys; }

// ---------------------------------------------------------------------------
// 「本地活动日记」的两个记录点（第 52 轮）
//
// ⚠️ 为什么记在**这里**，而不是浏览器那个提醒适配器（web/adapter/reminder.js）里：
//    提醒真正送出去（Windows Toast）只有这条常驻通道知道。网页端只把服务端
//    **已经响过**的提醒显示成站内条，而它按设计**没有**写设置的通道
//    （适配层刻意不反向依赖状态容器）。所以这里有一个人为划定的边界：
//    **电脑端服务开着时响的提醒会被记下来；只在浏览器里响的那次不会。**
//    这是已知的、诚实的缺口 —— 比"两处各记一遍（日志里出现两条一模一样的）"好。
//
// ⚠️ 两个记录点都过总闸（`settings.activitySettings.enabled`，默认关）：
//    关着时连扫描都不做、一次磁盘写都没有（见 core/activity-log.js 文件头）。
// ---------------------------------------------------------------------------

/**
 * 记一条活动（过总闸；没记成就不 persist —— 省掉一次没必要的磁盘写）。
 * 用 `store.updateSettings` 而不是直接改 `store.load()` 的返回值：**那一步才落盘**。
 */
function logActivity(kind, action, payload, now) {
  const s = store.load().settings;
  const next = recordActivity(s, kind, action, payload, now);
  if (next === s.activityLog) return;
  store.updateSettings({ activityLog: next });
}

/**
 * 已经记过"逾期"的事件 id（**从这个进程启动时的日志里恢复一次**）。
 *
 * ⚠️ 为什么不能只用内存 Set：每次重启服务都会把"所有当前逾期的事"再记一遍，
 *    而"逾期"本来就是一个会持续好几天的状态 —— 一天重启三次就会多出三倍的假账
 *    （摘要里那句"逾期 N 件"直接变成噪音）。所以启动时先从日志恢复，
 *    已经记过的就不再记。日志按 30 天裁剪，所以"这件事这个月一直逾期"过一阵子
 *    会再记一次 —— 那是对的，不是重复。
 */
let overdueLogged = null;
function overdueLoggedSet(settings) {
  if (overdueLogged) return overdueLogged;
  const set = new Set();
  for (const e of (Array.isArray(settings.activityLog) ? settings.activityLog : [])) {
    if (e && e.kind === 'event' && e.action === 'overdue' && e.refId) set.add(String(e.refId));
  }
  overdueLogged = set;
  return set;
}

/**
 * 逾期扫描：把"到期了却还没完成"的事记一条（每颗只记一次）。
 *
 * ⚠️ 判定复用 `store.deadlineOf`（= core/state-ops.js 的 deadlineMsOf：
 *    `deadline > end > start`）—— 和"泡泡变紫"是**同一套**依据。用第二套算法
 *    会出现"界面上是紫的、日志里说没逾期"这种自相矛盾。
 * ⚠️ 这里只回答"要不要记一条"，**不**改任何日程、不发任何通知。
 * ⚠️ 开关关着时**连扫描都不做**，也不往 Set 里塞东西 —— 否则用户"先打开记录"时，
 *    那些早就逾期的事会被当成"已经记过"而永远漏掉。
 */
function recordOverdue(now) {
  const d = store.load();
  const cfg = readActivitySettings(d.settings);
  if (!cfg.enabled) return;
  const seen = overdueLoggedSet(d.settings);
  for (const ev of (d.events || [])) {
    if (!ev || ev.done === true || ev.festival === true) continue;   // 节日泡泡不是"我的事"
    const dl = store.deadlineOf(ev);
    if (dl == null || dl > now.getTime()) continue;
    if (seen.has(String(ev.id))) continue;
    seen.add(String(ev.id));
    logActivity('event', 'overdue', {
      refId: ev.id, title: ev.title, level: store.levelOf(ev), remainingMs: dl - now.getTime(),
    }, now);
  }
}

/**
 * 现在该响的**课程摘要**（还没记过账的那些）。
 *
 * 「逐条分档提醒课程」和摘要共用同一个账本 —— 用户可以把逐条关掉只留摘要，
 * 也可以都开（那时同一门课可能既进摘要、又有"10 分钟后上课"的精确提醒）。
 * 摘要的判定全在 `core/course-digest.js`（纯函数、有单测）。
 */
export function dueDigestItems(now = new Date()) {
  const d = store.load();
  return dueDigests({
    events: d.events,
    settings: d.settings,
    now,
    fired: new Set(ledger.keys),
  });
}

/** 课程摘要一条 = 一次上课时间 = 一条"事件"。
 * 摘要没有单个 event，但通知模板需要，这里造一个够用的替身。 */
function digestAsEvent(dig) {
  return {
    id: `digest:${dig.slot}`,
    title: dig.title,
    location: '',
    type: 'course',
    start: dig.at.toISOString(),
    end: dig.at.toISOString(),
    tags: ['课程'],
  };
}

/** 把摘要也发出原生 toast（和逐条提醒走同一条 dispatch 通道） */
async function fireDigests(now) {
  // 摘要不该像"马上截止"那样吵 —— 用强度 1（最短停留 + 最普通的提示音）。
  // ⚠️ audio 必须是 Windows 的声音事件名，`toast.ps1` 直接塞进 XML 的 <audio src>；
  //    我第一版随手写了 'soft'，那会让 toast 静音或报错。
  const soft = NOTIFY_INTENSITY[1];
  for (const dig of dueDigestItems(now)) {
    markFired(dig.key);
    console.log(`[scheduler] 课程摘要：${dig.title}（${dig.count} 门）`);
    await dispatch({
      title: `📚 ${dig.title}`,
      body: dig.body,
      eventId: `digest:${dig.slot}`,
      minutes: 0,
      band: 'day',
      level: soft.level,
      intensity: soft.level,
      durationMs: soft.durationMs,
      requireInteraction: soft.requireInteraction,
      audio: soft.audio,
    });
    // 摘要也是一次"提醒发出"（它和逐条提醒共用同一个账本，见 dueDigestItems 的注释）
    logActivity('reminder', 'fired', {
      refId: `digest:${dig.slot}`, title: dig.title, minutes: 0,
    }, now);
  }
}

/** 提醒是否允许发送（遵循设置里的开关） */
function channelAllowed(channel) {
  const n = store.load().settings.notify || {};
  if (channel === 'windows') return n.desktop !== false;
  if (channel === 'web') return n.browser !== false;
  return true;
}

/** 回看窗口：至少要能覆盖「最长延后提醒」+ 余量 */
export function defaultLookbackMinutes() {
  const d = store.load();
  const now = new Date();
  const maxLate = Math.max(
    24 * 60,
    ...d.events.filter((e) => !e.done)
      .flatMap((e) => store.effectiveReminders(e, now).map((m) => -Number(m))),
  );
  return maxLate + 5;
}

/**
 * 扫描未来窗口内的提醒点。
 *
 * 关键点：不能只从 now 往后找。提醒点可能在事件开始「之后」（例如"延后 5 分钟提醒"，
 * 或提前量很小、事件已经开始了），所以必须往前回看一段，否则这类提醒永远算不出来。
 */
export function dueReminders(now = new Date(), horizonHours = HORIZON_HOURS, lookbackMinutes) {
  const d = store.load();
  const horizon = new Date(now.getTime() + horizonHours * 3600_000);
  const lookback = Number.isFinite(lookbackMinutes) ? lookbackMinutes : defaultLookbackMinutes();
  const from = new Date(now.getTime() - lookback * 60_000);
  // 「周期」开关：开了之后，被周期收起来的实例连提醒也不发（默认关）。
  // ⚠️ 这里必须和网页端用**同一个锚点规则**（applyPeriodLimit 的 now 参数），
  //    否则会出现"气泡区看不到、电脑却弹了提醒"这种自相矛盾。
  const periodOn = d.settings && d.settings.periodAffectsReminders === true;
  const out = [];

  for (const ev of d.events) {
    if (ev.done) continue;
    // 提醒列表**按当前时间实时算**：事件从"还早"走近成"紧急"时，
    // 自动模式下的提醒会自动加密（这就是"通知强度逐级加强"的落点）。
    const reminders = store.effectiveReminders(ev, now);
    if (!reminders.length) continue;
    const bandKey = store.bandKeyForEvent(ev, now);
    let occs = occurrencesIn(ev, from, horizon);
    if (periodOn && occs.length) {
      // 单个事件的所有实例，直接用同一个 event 包一层过筛
      occs = applyPeriodLimit(occs.map((o) => ({ event: ev, start: o })), now).map((it) => it.start);
    }
    for (const occ of occs) {
      for (const minutes of reminders) {
        // minutes 为提前量：10 表示提前 10 分钟；负值表示在开始之后（如 -5 = 延后 5 分钟提醒）
        const fireAt = new Date(occ.getTime() - Number(minutes) * 60_000);
        const key = `${ev.id}@${occ.toISOString()}@${minutes}`;
        out.push({ event: ev, occurrence: occ.toISOString(), fireAt, minutes: Number(minutes), key, bandKey });
      }
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt);
}

/** 事件是否已经彻底结束（结束时间都过去超过 1 分钟）—— 这种才叫过期，不该再提醒 */
function isOver(ev, now) {
  const end = new Date(ev.end || ev.start).getTime();
  if (!Number.isFinite(end)) return false;
  return end < now.getTime() - 60_000;
}

/**
 * 当前这一 tick 该响的提醒。
 * 判据：fireAt 已到、没迟到超过一个轮询周期、没响过、事件还没结束。
 *
 * 注意不能用「事件是否已开始」来过滤：提前量为负的提醒点本来就在开始之后
 * （例如"开始前 -5 分钟"= 开始后 5 分钟提醒），用开始时间过滤会把它们全丢掉。
 */
export function tick(now = new Date(), lookbackMinutes) {
  const toleranceMs = TICK_MS * 2.5;
  const fired = [];
  for (const item of dueReminders(now, undefined, lookbackMinutes)) {
    const lateness = now.getTime() - item.fireAt.getTime();
    if (lateness < 0 || lateness > toleranceMs) continue;
    if (ledger.keys.includes(item.key)) continue;
    if (isOver(item.event, now)) continue;
    markFired(item.key);
    fired.push(item);
  }
  return fired;
}

async function loop() {
  try {
    const now = new Date();
    const items = tick(now);
    if (process.env.TIMETABLE_DEBUG) {
      const all = dueReminders(now);
      console.log(`[scheduler:debug] now=${now.toISOString()} tzOffset=${now.getTimezoneOffset()} 窗口内提醒点=${all.length} 本次触发=${items.length} 账本=${ledger.keys.length}`);
      all.slice(0, 5).forEach((i) => console.log(`   · ${i.event.title} start=${i.event.start} -> occ=${i.occurrence} fireAt=${i.fireAt.toISOString()} 迟到=${now - i.fireAt}ms`));
    }
    for (const item of items) {
      const body = buildBody(item);
      // 强度按**触发那一刻**的剩余时间算（所以同一条日程越接近截止，弹窗越强）
      const intensity = intensityFor(item.event, now);
      console.log(`[scheduler] 触发提醒：${item.event.title} (-${item.minutes}min) 强度=${intensity.level}(${intensity.band}${intensity.overdue ? ' 已过期' : ''})`);
      await dispatch({
        title: `${intensity.prefix} ${item.event.title}`,
        body,
        eventId: item.event.id,
        minutes: item.minutes,
        // 通知强度随剩余时间档位加强：停留更久、必看、提示音更醒目
        band: intensity.band,
        level: intensity.level,
        intensity: intensity.level,
        durationMs: intensity.durationMs,
        requireInteraction: intensity.requireInteraction,
        audio: intensity.audio,
      });
      // 「本地活动日记」：提醒真的发出去了 → 记一条（只记 id/标题/提前量，开关默认关）
      logActivity('reminder', 'fired', {
        refId: item.event.id, title: item.event.title, minutes: item.minutes,
      }, now);
      if (onFire) { try { onFire(item); } catch { /* ignore */ } }
    }

    // 课程摘要（"前一天晚上提醒明天 / 早上提醒上午…"）走同一条 toast 通道。
    // 放在逐条提醒之后：同一次 tick 里先发精确的，再发汇总的。
    await fireDigests(now);

    // 逾期扫描：到期了却还没完成的事 → 记一条（每颗只记一次，见 recordOverdue）
    recordOverdue(now);
  } catch (err) {
    console.error('[scheduler] tick 出错', err);
  } finally {
    timer = setTimeout(loop, TICK_MS);
  }
}

function buildBody(item) {
  const ev = item.event;
  const when = new Date(item.occurrence);
  const hm = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  const parts = [];
  parts.push(item.minutes === 0 ? `现在开始 · ${hm}` : `${item.minutes} 分钟后（${hm}）`);
  if (ev.location) parts.push(ev.location);
  if (ev.teacher) parts.push(ev.teacher);
  return parts.join(' · ');
}

/**
 * 取出 ev 在 [from, to] 窗口内的实际发生时间。
 *
 * ⚠️ 这里**不再自己实现**展开逻辑，直接委托给 `core/recurrence.js`。
 *
 * 原来这里有一份手抄的复刻，结果是：
 *   · 周级"一周勾满 7 天"会重复生成 7 次（core 修了、这里漏了）
 *   · 加日/月/年级时又得改一处，很容易两端不一致
 * 统一之后只有 core 一处判定，服务端、浏览器、安卓（Kotlin 复刻）都对同一份语义。
 */
export function occurrencesIn(ev, from, to) {
  const termStart = store.load().settings.termStart;
  return coreOccurrences(ev, from, to, termStart);
}

export function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay();
  x.setDate(x.getDate() + (dow === 0 ? -6 : 1 - dow));
  return x;
}

export function start(onFireCb) {
  loadLedger();
  onFire = onFireCb || null;
  if (timer) return;
  console.log(`[scheduler] 已启动，间隔 ${TICK_MS / 1000}s`);
  loop();
}

export function stop() {
  if (timer) { clearTimeout(timer); timer = null; }
}

export { loadLedger, saveLedger };
