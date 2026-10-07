// 提醒决策层（平台无关）
//
// 这里只回答一个问题：**"现在该提醒哪几条"**。
// 至于提醒怎么送出去（浏览器 Notification / 安卓通知 / iOS UNUserNotificationCenter
// / Windows Toast / 声音），一律由各端适配器负责 —— 那是平台相关的。
//
// 这样三端共用同一套判定：轮询窗口、去重账本、"过太久不补报"、提前量为负的语义等。
import { expandRange, applyPeriodLimit } from './recurrence.js';
import { asDate, hhmm, toLocalStamp } from './time.js';

/** 扫描窗口：往后看多久（提前量可能很大，所以要留够） */
export const SCAN_AHEAD_MS = 26 * 3_600_000;
/** 容忍"刚过去一点"的提醒（避免定时器抖动漏掉） */
export const LATE_TOLERANCE_MS = 90_000;
/** 已经结束这么久的事件不再提醒 */
export const EVENT_GRACE_MS = 60_000;

/**
 * 组装提醒文案（各端可以直接用，也可以自己再包一层）。
 * @param {{title?:string, location?:string, teacher?:string}} ev
 * @param {Date} start
 * @param {number} minutes 提前量；负值表示开始之后
 */
export function buildReminderText(ev, start, minutes) {
  const when = minutes === 0
    ? `现在开始（${hhmm(start)}）`
    : minutes > 0
      ? `${minutes} 分钟后（${hhmm(start)}）`
      : `已开始 ${-minutes} 分钟（${hhmm(start)}）`;
  const extra = [ev && ev.location, ev && ev.teacher].filter(Boolean).join(' · ');
  return extra ? `${when} · ${extra}` : when;
}

/**
 * 提醒点的稳定 key（三端必须一致，否则去重会失效）。
 * 形如 `evt_xxx@2026-03-02T08:00:00@10`
 */
export function reminderKey(eventId, occurrence, minutes) {
  return `${eventId}@${toLocalStamp(occurrence)}@${minutes}`;
}

/**
 * 扫描出「截至 now 应该已经触发、但还没触发过」的提醒。
 *
 * 判定规则（与服务端调度器保持一致）：
 *   1. 事件未完成、且尚未结束超过 EVENT_GRACE_MS；
 *   2. 提醒点 fireAt = 开始时间 − 提前量×分钟（提前量为负 → 晚于开始）；
 *   3. fireAt 已经到点，且没有迟到超过 LATE_TOLERANCE_MS（太久的直接丢弃，不补报）；
 *   4. key 不在已触发账本里。
 *
 * ⚠ 扫描起点必须往前回看**足够远**：提前量大的提醒，它的 fireAt 可能远早于 now − 容忍窗口。
 * 例如「提前 2 小时」的提醒，事件 1 小时前开始时它就该响了；如果只从 now − 90s 开始找，
 * 事件开始时间会落在窗口之外，这条提醒就被整个丢掉了。
 * 所以回看长度 = max(容忍窗口, 最大提前量) + 一点余量。
 *
 * @param {object} opts
 * @param {Array} opts.events 全部日程
 * @param {string} opts.termStart 学期第一周周一（课表用）
 * @param {Date} opts.now
 * @param {Set<string>|Array<string>} opts.fired 已触发账本
 * @param {boolean} [opts.periodAffectsReminders] 「周期」是否连提醒一起筛。
 *   关（默认）= 周期只影响气泡区的显示，提醒照旧全发；
 *   开        = 被周期收起来的那些实例也不再提醒。
 *   这是用户要的那个开关（"不开是 1，开是 2"）。见 core/recurrence.js: applyPeriodLimit。
 * @returns {Array<{key:string,eventId:string,title:string,body:string,minutes:number,fireAt:Date,occurrence:Date,event:object}>}
 */
export function dueReminders({
  events, termStart, now = new Date(), fired = new Set(), periodAffectsReminders = false,
}) {
  const has = (k) => (typeof fired.has === 'function' ? fired.has(k) : fired.includes(k));

  // 回看长度：必须覆盖「提前量的绝对值」最大的那个。
  //
  // 为什么要取绝对值：提前量为负表示"开始之后再提醒"（例如 -4 = 开始后 4 分钟）。
  // 这类提醒的 fireAt 落在开始时间**之后**，但事件本身可能早就开始了；
  // 如果回看不看负值，这种提醒会被整个漏掉（踩过一次）。
  const maxAbsLeadMinutes = (events || [])
    .filter((e) => !e.done)
    .flatMap((e) => (e.reminders || []).map((m) => Math.abs(Number(m))))
    .filter((m) => Number.isFinite(m))
    .reduce((a, b) => (b > a ? b : a), 0);
  const lookbackMs = Math.max(LATE_TOLERANCE_MS, maxAbsLeadMinutes * 60_000) + 60_000;

  const from = new Date(now.getTime() - lookbackMs);
  const to = new Date(now.getTime() + SCAN_AHEAD_MS);

  let items = expandRange(events || [], from, to, termStart, (ev) => !ev.done);
  // 「周期」开关打开时，提醒也要跟着筛 —— 被收起来的那几颗不再提醒。
  // 注意这里必须传 `now`，才能和气泡区算出**同一个锚点**（锚点 = 第一个未来的实例）。
  if (periodAffectsReminders) items = applyPeriodLimit(items, now);
  const out = [];

  for (const item of items) {
    const ev = item.event;
    const endAt = asDate(ev.end || ev.start);
    if (endAt.getTime() < now.getTime() - EVENT_GRACE_MS) continue;

    for (const raw of ev.reminders || []) {
      const minutes = Number(raw);
      if (!Number.isFinite(minutes)) continue;
      const fireAt = new Date(item.start.getTime() - minutes * 60_000);
      if (fireAt > now) continue;                      // 还没到点
      if (now - fireAt > LATE_TOLERANCE_MS) continue;  // 迟到太久 → 直接跳过（不补报）

      const key = reminderKey(ev.id, item.start, minutes);
      if (has(key)) continue;

      out.push({
        key,
        eventId: ev.id,
        event: ev,
        title: `⏰ ${ev.title}`,
        body: buildReminderText(ev, item.start, minutes),
        minutes,
        fireAt,
        occurrence: item.start,
      });
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt);
}

/**
 * 平台无关的提醒引擎骨架：把「扫描 → 记账 → 投递」串起来。
 *
 * 各端只需要注入两件事：
 *   - ledger：账本持久化（浏览器用 localStorage，原生用 SharedPreferences/UserDefaults 等）
 *   - deliver：真正把提醒送出去（通知中心 / 站内提示 / 声音）
 *
 * @param {object} opts
 * @param {object} opts.ledger  { load(): string[], save(keys: string[]): void }
 * @param {(item:object)=>void|Promise<void>} opts.deliver
 */
export function createReminderEngine({ ledger, deliver }) {
  if (!ledger || typeof ledger.load !== 'function' || typeof ledger.save !== 'function') {
    throw new Error('createReminderEngine 需要 { ledger: { load, save } }');
  }
  if (typeof deliver !== 'function') {
    throw new Error('createReminderEngine 需要 deliver 回调');
  }

  let fired = new Set(ledger.load() || []);

  return {
    /** 当前账本快照 */
    firedKeys: () => [...fired],

    /** 清空账本（例如"重新演示一遍"） */
    reset() {
      fired = new Set();
      ledger.save([]);
    },

    /**
     * 跑一次判定并把命中的提醒投递出去。
     * @param {object} [opts]
     * @param {boolean} [opts.periodAffectsReminders] 见 dueReminders 的说明
     * @returns {Promise<Array>} 本次投递的提醒
     */
    async tick({ events, termStart, now = new Date(), periodAffectsReminders = false } = {}) {
      const due = dueReminders({ events, termStart, now, fired, periodAffectsReminders });
      const delivered = [];
      for (const item of due) {
        // 先记账再投递：投递失败也不该反复重试同一个提醒点
        fired.add(item.key);
        try {
          await deliver(item);
          delivered.push(item);
        } catch (err) {
          // 投递失败只记录，不影响其它提醒
          // eslint-disable-next-line no-console
          console.warn('[reminder] 投递失败', item.key, err && err.message);
        }
      }
      // ⚠️⚠️ 2026-10-01 修：原来是 `if (due.length) ledger.save([...fired])` ——
      //    **只在有到期日程时才落盘**。加了 `markFired()`（外部投递走它记账）之后，
      //    这条件就成了一个真 bug：如果这一轮没有到期日程，账本**根本不会被保存**，
      //    于是"刚刚投递过的那个 key"只活在内存里 —— 一旦内存里的 `fired` 被重建
      //    （刷新页面 / 第二天账本轮换 / 任何重新 load 的路径），那个 key 就会被再投递一次。
      //    账本本来就是"今天已经提醒过哪些"，整份落盘没有任何副作用（就那么几 KB），
      //    所以**无条件保存**才是对的。
      ledger.save([...fired]);
      return delivered;
    },
    /**
     * 把**外部已经投递过的 key** 记进同一个账本（2026-10-01 新增）。
     *
     * ⚠️⚠️ 为什么必须走引擎、不能在调用方自己 `ledger.save(...)`：
     *    引擎内部有一个**内存 `fired` Set**，`tick()` 结束时会用**内存快照**回写账本
     *    （`if (due.length) ledger.save([...fired])`）。所以调用方直接写 localStorage
     *    是**写了个寂寞** —— 下一轮 `tick()` 会把内存里的旧快照盖回去，
     *    于是那些 key 又变回"没发过"，**同一个 key 会被重复投递**。
     */
    markFired(keys = []) {
      let changed = false;
      for (const k of keys) {
        // ⚠️ 空串也要挡掉：它不是"合法的提醒 key"，进了账本毫无意义，
        //    而且会让 `firedKeys()` 里多一个空条目（账本是"今天提醒过哪些"的凭据，
        //    凭据里不该有看不懂的东西）。`k == null` 挡不住 `''`，所以显式判一次。
        if (k == null || k === '') continue;
        if (!fired.has(k)) { fired.add(k); changed = true; }
      }
      if (changed) ledger.save([...fired]);
      return changed;
    },
  };
}
