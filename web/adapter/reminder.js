// 浏览器端提醒适配器（方案 A）
//
// 分工：
//   core/reminder-plan.js  —— 判定"该不该提醒"（平台无关，三端共用）
//   本文件                 —— "怎么把提醒送出去"（浏览器专属）
//
// 两条通道互补：
//   通道 A（本文件）：页面开着时秒级精确，点通知能跳转到日程；
//   通道 B（服务端）：页面关掉后由 Windows Toast 兜底，前端只把服务端已响的提醒显示成站内条。
import { api } from './api.js';
import { createReminderEngine } from '../../core/reminder-plan.js';
import { asDate, hhmm } from '../../core/time.js';
// 通知强度：档位表与"设置 × 自动"的合成规则都在 core（三端共用同一套语义）
import { NOTIFY_INTENSITY, notificationPlanForRemaining, resolveIntensity } from '../../core/level.js';

const FIRED_KEY = 'timetable.fired.v1';
// 页面开着时的轮询间隔。这个值**直接决定站内提醒的准不准**：
// 提醒只会在一次轮询的瞬间被判定，所以误差最坏 = 一个间隔。
// 原来 15 秒 → 用户实测"设置提前 1 分钟，剩 48 秒就弹了"（60-48=12s，正是被 15 秒量化掉了）。
// 改成 2 秒：前台误差压到 2 秒内，代价是每秒多跑一次纯内存的判定（可忽略）。
// ⚠️ 只影响**前台站内弹窗**；锁屏/后台走系统通知，本来就是秒级精确。
const CHECK_MS = 2_000;
const SERVER_POLL_MS = 30_000;

let checkTimer = null;
let serverTimer = null;
let onAlert = null; // (item) => void，由 UI 注入以显示站内提示
/** 取当前设置。由 start() 注入，避免适配层反向依赖 store。 */
let getSettingsFn = null;

/**
 * 这次提醒该用多强的力度。
 *
 * 「自动」档按离开始还有多久算（core/level.js 的 notificationPlanForRemaining：
 * 越临近越强）；用户也可以在设置里**强制**某一档 —— 见 resolveIntensity 的注释。
 */
export function intensityFor(item) {
  const settings = (getSettingsFn && getSettingsFn()) || {};
  const notify = settings.notify || {};
  const startMs = asDate(item.occurrence || item.start).getTime();
  const auto = notificationPlanForRemaining(startMs - Date.now()).intensity;
  return resolveIntensity(notify.intensity, auto);
}

/** 强度 → 这一次该用的完整投递参数 */
export function styleFor(item) {
  const level = intensityFor(item);
  return { level, ...NOTIFY_INTENSITY[level] };
}

// ---- 账本：浏览器用 localStorage；安卓/iOS 换成各自平台的存储即可 ----
function todayKey() { return new Date().toISOString().slice(0, 10); }

const ledger = {
  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(FIRED_KEY) || 'null');
      if (raw && raw.day === todayKey()) return raw.keys || [];
    } catch { /* ignore */ }
    return [];
  },
  save(keys) {
    try {
      localStorage.setItem(FIRED_KEY, JSON.stringify({ day: todayKey(), keys }));
    } catch { /* ignore */ }
  },
};

// 判定与去重全部交给核心层；这里只实现"怎么投递"
const engine = createReminderEngine({
  ledger,
  deliver: (item) => emit(item),
});

export function notificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function permission() {
  // 注意：必须用 typeof 探测，不能直接写 Notification.permission ——
  // 在不支持该 API 的环境（老浏览器、内嵌 WebView、测试进程）会抛 ReferenceError
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

export async function requestPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    const p = await Notification.requestPermission();
    return p;
  } catch {
    return Notification.permission;
  }
}

function shouldUseSystemNotification(doc) {
  const d = doc || document;
  return permission() === 'granted' && d.visibilityState !== 'visible';
}

function showSystem(item, style) {
  try {
    const lv = style ? style.level : 1;
    const n = new Notification(item.title, {
      body: item.body,
      icon: '/assets/icon-192.png',
      badge: '/assets/icon-192.png',
      tag: item.eventId,
      renotify: true,
      // ⚠️ 下面两条以前是**写死**的（requireInteraction: false），
      //    于是网页端的提醒永远是"最弱"那一档、还不可调 —— 用户报的"力度不够大"。
      //    现在跟着强度走：4 档 = 不自动消失，必须手动关（对齐电脑端 Toast 的 urgent）。
      requireInteraction: !!(style && style.requireInteraction),
      silent: !(style ? style.sound !== false : true),
      // 震动：安卓 Chrome 认，iOS 忽略（无害）。强档给一个"长-短"的明显节奏。
      ...(lv >= 3 ? { vibrate: lv >= 4 ? [400, 120, 400, 120, 400] : [300, 150, 300] } : {}),
    });
    n.onclick = () => {
      window.focus();
      if (item.eventId) {
        window.dispatchEvent(new CustomEvent('timetable:open-event', { detail: { id: item.eventId } }));
      }
      n.close();
    };
    return true;
  } catch (err) {
    console.warn('系统通知失败，回退站内提示', err);
    return false;
  }
}

/** 投递：优先系统通知（页面不可见时），否则走站内提示条 */
function emit(item) {
  const style = styleFor(item);
  const usedSystem = shouldUseSystemNotification() && showSystem(item, style);
  if (onAlert) {
    onAlert({
      title: item.title,
      body: item.body,
      eventId: item.eventId,
      minutes: item.minutes,
      mirror: usedSystem,
      // 站内提示也带上强度，UI 可以据此加视觉重量 / 延长停留
      intensity: style.level,
      requireInteraction: style.requireInteraction,
    });
  }
  playChime(style.level);
}

let audioCtx = null;
/**
 * 提示音。**强度决定音量与重复次数**（以前音量固定 0.14、只响一遍，
 * 所以强提醒和弱提醒听起来一模一样）。
 */
export function playChime(level = 1) {
  try {
    const enabled = (window.__timetableSettings || {}).sound !== false;
    if (!enabled) return;
    const style = NOTIFY_INTENSITY[Math.min(4, Math.max(1, Math.round(Number(level) || 1)))];
    const volume = Number.isFinite(style.volume) ? style.volume : 0.14;
    // repeats 是"额外再响几遍"：1 档 1 遍，4 档 4 遍
    const times = 1 + (Number(style.repeats) || 0);
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;
    const GAP = 0.34;               // 每一遍之间的间隔
    for (let i = 0; i < times; i += 1) {
      const t = t0 + i * GAP;
      [880, 1174].forEach((freq, j) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.0001, t + j * 0.18);
        gain.gain.exponentialRampToValueAtTime(volume, t + j * 0.18 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + j * 0.18 + 0.16);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t + j * 0.18);
        osc.stop(t + j * 0.18 + 0.18);
      });
    }
  } catch { /* 浏览器策略限制，静默失败 */ }
}

/**
 * 试听某个强度（设置页用）。
 *
 * 为什么要"试听"而不是只写个数字：力度是**听觉**属性，
 * 用户看"强度 3"完全无法预期它有多响。让他直接听一遍最快。
 */
export function previewIntensity(level) {
  const lv = Math.min(4, Math.max(1, Math.round(Number(level) || 1)));
  const style = NOTIFY_INTENSITY[lv];
  playChime(lv);
  if (shouldUseSystemNotification()) {
    showSystem({
      title: `🔔 强度 ${lv} 的提醒长这样`,
      body: style.requireInteraction
        ? '这条**不会自动消失**，要手动关掉'
        : `大约停留 ${Math.round(style.durationMs / 1000)} 秒`,
      eventId: null,
    }, { level: lv, ...style });
  }
  return { level: lv, ...style };
}

/** 通道 B 的补充：把服务端已经响过的提醒显示成站内条（不重复弹系统通知） */
async function serverTick() {
  try {
    const res = await api.dueReminders();
    const items = (res && res.items) || [];

    // 课程摘要（"前一天晚上提醒明天 / 早上提醒上午…"）
    // 标题和正文都是服务端算好的整段汇总，直接用，不像逐条提醒那样再拼一遍时间。
    // 记账前缀避免和逐条提醒的 key 撞车、也避免重复展示。
    for (const d of (res && res.digests) || []) {
      const key = `srv:${d.key}`;
      const seen = engine.firedKeys();
      if (seen.includes(key)) continue;
      ledger.save([...seen, key]);
      if (onAlert) {
        onAlert({
          title: `📚 ${d.title}`,
          body: d.body,
          eventId: `digest:${d.slot}`,
          minutes: 0,
          fromServer: true,
        });
      }
    }

    for (const it of items) {
      if (!it.fired) continue;
      const key = `srv:${it.key}`;
      const seen = engine.firedKeys();
      if (seen.includes(key)) continue;
      // 借用同一个账本记账，避免重复
      ledger.save([...seen, key]);
      if (onAlert) {
        const occ = asDate(it.occurrence);
        const when = it.minutes === 0
          ? `现在开始（${hhmm(occ)}）`
          : it.minutes > 0
            ? `${it.minutes} 分钟后（${hhmm(occ)}）`
            : `已开始 ${-it.minutes} 分钟（${hhmm(occ)}）`;
        onAlert({
          title: `⏰ ${it.title}`,
          body: it.location ? `${when} · ${it.location}` : when,
          eventId: it.eventId,
          minutes: it.minutes,
          fromServer: true,
        });
      }
    }
  } catch { /* 服务不可用时忽略 */ }
}

/**
 * @param {object} opts
 * @param {Function} opts.getEvents
 * @param {Function} opts.getTermStart
 * @param {Function} opts.alert
 * @param {Function} [opts.getSettings] 取当前设置（`notify.intensity` 等）。
 *   注入而不是直接 import store —— 适配层不该反向依赖状态容器。
 *   不传时退化为"自动强度"，不会报错。
 */
export function start({ getEvents, getTermStart, alert, getSettings }) {
  onAlert = alert;
  getSettingsFn = typeof getSettings === 'function' ? getSettings : null;
  stop();
  const run = () => {
    Promise.resolve()
      .then(() => {
        const settings = (getSettingsFn && getSettingsFn()) || {};
        return engine.tick({
          events: getEvents(),
          termStart: getTermStart(),
          now: new Date(),
          // 「周期」开关：开了之后，被周期收起来的实例也不再提醒（默认关）
          periodAffectsReminders: settings.periodAffectsReminders === true,
        });
      })
      .catch((err) => console.error('[reminder] 本地检查失败', err));
  };
  run();
  checkTimer = setInterval(run, CHECK_MS);
  serverTimer = setInterval(serverTick, SERVER_POLL_MS);
}

/**
 * （精简版没有祝福提醒：投递层只剩事件提醒这一条路。）
 */

export function stop() {
  if (checkTimer) { clearInterval(checkTimer); checkTimer = null; }
  if (serverTimer) { clearInterval(serverTimer); serverTimer = null; }
}

/** 清空账本（例如"重新演示一遍"） */
export function resetLedger() {
  engine.reset();
}

/** 当前账本（调试/测试用） */
export function firedKeys() {
  return engine.firedKeys();
}
