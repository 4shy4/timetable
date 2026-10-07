// 提前排出"未来该响的提醒"，交给**系统**去守着（而不是靠页面常驻）。
//
// 与 core/reminder-plan.js 的 `dueReminders` 分工不同，别混：
//   `dueReminders` → "**现在**该响哪些"（页面开着时轮询用，只回看一小段容忍窗口）
//   本文件         → "**未来**该响哪些"（一次排好交给系统，进程不在也能响）
//
// 为什么需要它（这是 iOS 上的正路）：
//   iOS 上 App 被切到后台后，你**不能**指望它按时醒来 —— BGAppRefreshTask 的时机
//   由系统决定。所以提醒必须**提前注册**成系统的定时通知
//   （`UNCalendarNotificationTrigger`），由系统在到点时唤醒投递。
//   这正是 docs/IOS.md 里写的"用 UNCalendarNotificationTrigger 预先排好（这才是正路）"。
//
// 输出格式是 **JS ↔ 原生壳的契约**（见 docs/IOS-NATIVE.md），字段刻意小：
//   { id, eventId, title, body, fireAt, intensity }
//   · `fireAt` 是**绝对 UTC ISO 字符串** —— 原生侧转成 DateComponents 直接排，
//     不做任何时区推算（时区是各端自己的事）
//   · `id` 稳定（同一个提醒点每次算出同一个 id）→ 原生侧"重排"时是**替换**不是堆积

import { expandRange, applyPeriodLimit } from './recurrence.js';
import { asDate, DAY_MS } from './time.js';
import { buildReminderText, reminderKey } from './reminder-plan.js';
import { effectiveReminders } from './state-ops.js';
import { notificationPlanForRemaining } from './level.js';

/**
 * iOS 上**待处理的本地通知最多 64 条**（系统硬限制，从 UILocalNotification 时代就是这样）。
 * 安卓的 AlarmManager 没这个限制，但这里统一按 64 收口，让两端行为一致、也好测。
 *
 * ⚠️ 超出 64 时系统具体丢哪几条，各版本说法不完全一致（拿不到 Apple 官方文档原文，
 *    论坛需要人机校验）。所以这里**不依赖系统的丢弃策略**：自己先只留**最早响的 64 条**。
 *    这样无论系统怎么丢，留下的都是"最近要响的那些"。
 *    → 代价是"很远未来的提醒"排不进去；靠**每次打开 App 重排**补上
 *      （重排会把窗口往前推，远处的自然又进来了）。
 */
export const MAX_PENDING = 64;

/** 默认往后排多久。7 天足够覆盖"下次打开 App 之前"，又不会把 64 条名额浪费在很远的将来 */
export const DEFAULT_HORIZON_DAYS = 7;

/**
 * 各档位**默认**用哪个声音文件（就是打进 App 包里的那三档）。
 *
 * ⚠️ 这份表故意放在**网页侧**，而不是留在 Swift 里：
 *   "哪一档配哪个声音"是业务；而且用户换过自定义音之后，那个名字只有网页层知道
 *   （存在 `settings.notify.customSounds`）。壳只做"用哪个文件"这一个翻译动作 ——
 *   这是这个项目一直守的那条线（见 NotificationScheduler.swift 顶部）。
 *
 * 1 档保持**系统默认音**：那是最短的一声"叮"，拿它当"弱"比任何自定义音都合适。
 */
export const BUILTIN_SOUNDS = {
  4: 'timetable-alert-strong.wav',
  3: 'timetable-alert.wav',
  2: 'timetable-alert-soft.wav',
  1: null,
};

/**
 * 这一档到底该用哪个声音文件名（null = 用系统默认音）。
 *
 * @param {number} intensity 1–4（见 core/level.js 的 BAND_INTENSITY）
 * @param {object} [custom] 用户自己导入的：`{ "2": "timetable-custom-t2-….caf", … }`
 *
 * ⚠️ 自定义表里出现空串/非字符串一律当"没有"，**绝不把空名字发给系统** ——
 *    `UNNotificationSound(named: "")` 的结果是"这条通知没声音"，而且不报错
 *    （用户只会觉得"提醒坏了"）。
 */
export function soundForIntensity(intensity, custom = null) {
  const tier = Math.max(1, Math.min(4, Number(intensity) || 1));
  const mine = custom && typeof custom === 'object' ? custom[tier] : null;
  if (typeof mine === 'string' && mine.trim()) return mine.trim();
  return BUILTIN_SOUNDS[tier] || null;
}

/**
 * 过滤出**这台设备上确实存在**的自定义音。
 *
 * ⚠️ 为什么需要它：设置会跟着数据同步到别的设备，但**声音文件只在导入它的那台设备上**
 *    （存在那个 App 容器的 `Library/Sounds` 里）。iPad 拿着电脑同步来的名字去要一个
 *    不存在的文件，系统的行为是"静默降级" —— 用户只会觉得"我的提示音没了"。
 *    所以壳会在启动时/被问时报一份"容器里现在有哪些 .caf"（`soundStatus`），
 *    网页侧用这份名单过滤一遍再决定发什么名字。
 */
export function usableCustomSounds(custom, available) {
  if (!custom || typeof custom !== 'object') return {};
  const have = new Set(Array.isArray(available) ? available : []);
  const out = {};
  for (const [tier, name] of Object.entries(custom)) {
    if (typeof name === 'string' && have.has(name)) out[tier] = name;
  }
  return out;
}

/**
 * 排出未来一段时间内该响的提醒。
 *
 * @param {object} opts
 * @param {Array} opts.events 全部日程
 * @param {string} opts.termStart 学期第一周周一（课表展开要）
 * @param {Date} [opts.now]
 * @param {number} [opts.horizonDays] 往后看几天
 * @param {number} [opts.max] 最多返回几条（默认 MAX_PENDING）
 * @param {boolean} [opts.periodAffectsReminders] 「周期」是否连提醒一起筛（默认关）
 * @param {(ev:object)=>number} [opts.intensityOf] 覆盖强度算法（原生壳可能需要）
 * @param {object} [opts.customSounds] 用户导入的提示音 `{档位: 文件名}`
 * @returns {Array<{id,eventId,title,body,fireAt,intensity}>} 按 fireAt 升序
 */
export function planNotifications({
  events = [], termStart = '', now = new Date(), horizonDays = DEFAULT_HORIZON_DAYS,
  max = MAX_PENDING, periodAffectsReminders = false, intensityOf = null, customSounds = null,
} = {}) {
  const nowMs = asDate(now).getTime();
  const horizonMs = Math.max(0, Number(horizonDays) || 0) * DAY_MS;
  const to = new Date(nowMs + horizonMs);

  // 往前也看一眼：提醒点可能刚好在"现在"之前一点点，容忍窗口内的要算进来
  // （否则 App 每次打开都会漏掉刚刚过去的那个提醒点）
  const from = new Date(nowMs - 60_000);

  let items = expandRange(events.filter((e) => !e.done), from, to, termStart);
  if (periodAffectsReminders) {
    // 与气泡区、日历用**同一个锚点规则**（见 core/recurrence.js: applyPeriodLimit）。
    // 必须传 now —— 锚点是"第一个未来的实例"，三处用同一个 now 才一致。
    items = applyPeriodLimit(items, now);
  }

  const out = [];
  const seen = new Set();
  for (const it of items) {
    const ev = it.event;
    // ---- 提醒钉在哪个时刻上 ----
    //
    // 普通日程：钉在 `start`（"9 点开始 → 提前 10 分钟 = 8:50 响"）。
    // **未来泡泡：钉在 `end`** —— 因为它的 `start` 是**出现日期**，不是事情本身发生的时刻。
    //   `future：true` 时 "提前 10 分钟" 若还按 start 算，就会在"泡泡刚冒出来"那一刻响，
    //   而用户真正要被提醒的是 `end`（到期）。
    //   这也是全 App 唯一一处提醒锚点跟着日程类型变的地方，所以单独写在这里、并由
    //   tools/notify-plan.test.mjs 钉住（测试名里带着"未来泡泡"）。
    const anchor = ev.future === true
      ? (it.deadline instanceof Date && Number.isFinite(it.deadline.getTime()) ? it.deadline : it.end)
      : it.start;
    for (const raw of effectiveReminders(ev, now)) {
      const minutes = Number(raw);
      if (!Number.isFinite(minutes)) continue;
      const fireAt = new Date(anchor.getTime() - minutes * 60_000);
      if (fireAt.getTime() < nowMs - 5_000) continue;   // 已经过去的点不再排
      if (fireAt.getTime() > to.getTime()) continue;
      const id = reminderKey(ev.id, it.start, minutes);
      if (seen.has(id)) continue;
      seen.add(id);

      const intensity = typeof intensityOf === 'function'
        ? intensityOf(ev)
        : notificationPlanForRemaining(anchor.getTime() - fireAt.getTime()).intensity;

      out.push({
        id,
        eventId: ev.id,
        title: ev.title || '(无标题)',
        body: buildReminderText(ev, it.start, minutes),
        fireAt: fireAt.toISOString(),
        intensity,
        // ⚠️ **要不要把这条做成真闹钟**（iOS 26+ 的 AlarmKit）。
        //
        //   为什么由网页侧决定、而不是壳自己判断：这是**用户对某条日程的意愿**
        //   （编辑器里的勾），属于业务，必须和"哪些提醒、什么时候响"一起由
        //   同一份 core 代码算出来 —— 壳只翻译，不复刻业务判断（这是本项目
        //   一直守的那条线，见 NotificationScheduler.swift 顶部）。
        //
        //   壳侧还会再要求 `intensity >= 4` 才会真做成闹钟：勾了但离得还很远时
        //   仍然只是普通通知。也就是"**勾了它，到最后一小时才会炸**"。
        useAlarm: ev.alarm === true,
        // 这一条该用哪个声音文件（null = 系统默认音）。
        // ⚠️ 和 useAlarm 同一个道理：**"哪一档配哪个声音"是业务**，而且用户换过自定义音
        //    之后只有网页层知道那个名字（settings.notify.customSounds）。
        //    壳侧拿到名字只做一次翻译（UNNotificationSound(named:)）。
        sound: soundForIntensity(intensity, customSounds),
      });
    }
  }

  // 只留**最早响的 max 条** —— 名额有限，远处的下次打开再排
  out.sort((a, b) => new Date(a.fireAt) - new Date(b.fireAt));
  return max > 0 ? out.slice(0, max) : out;
}

/** 原生壳要的最小信息：现在该排几条、最近一条什么时候响 */
export function planSummary(plan) {
  if (!Array.isArray(plan) || !plan.length) return { count: 0, nextAt: null };
  return { count: plan.length, nextAt: plan[0].fireAt };
}
