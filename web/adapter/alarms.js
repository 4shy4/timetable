// 闹钟 ↔ 原生壳的桥（iOS：AlarmKit 真闹钟）+ 计时器状态机。
//
// ⚠️ 分工（和 web/adapter/native.js 一个规矩）：**业务在 core，壳只翻译**。
//   · "下一次几点响""哪些该排"由 core/alarms.js 算好（三端共用一份）
//   · "倒计时的开始/暂停/继续"是**状态机**，也住在 core 能表达的字段上
//     （`startedAt` + `durationMs`），这里只负责"改哪个字段、什么时候通知壳"
//   · 壳那边只知道"把这个 fireAt / 这个时长 交给系统，用这个铃声"
//
// ⚠️ 为什么这些不放 web/adapter/native.js：那个文件的职责是"提醒"那条路
//   （计划 → 系统通知）。闹钟是一条**独立的链路**（有自己的数据、自己的壳消息、
//   自己的失败模式），混进去会让那个已经很大的文件更难读；
//   而且 native.js 里的 `soundFiles` 那一套（自定义提示音）和闹钟的
//   "内置铃声文件"是**两件事**（前者是通知音、后者是闹钟音，查找位置不同）。

import { platformKind, postToShell, shellKind, customAlarmSounds } from './native.js';
import {
  ALARM_SOUNDS, MAX_SCHEDULED, planAlarmSchedule, soundById, soundFileOf, soundLabelOf,
  normalizeAlarm, timerRemainingMs,
} from '../../core/alarms.js';
import * as store from './store.js';

/**
 * 把铃声 id 翻成**真正交给系统的文件名**（2026-10-01 新增；2026-10-02 改成多首）。
 *
 * ⚠️ 为什么不直接用 `soundFileOf(id)` 就完事：**自定义铃声的文件名是运行时才知道的** ——
 *    用户在「文件」里导入的音频存进 App 容器的 `Library/Sounds`，
 *    名字由壳生成（`timetable-custom-9f3a1c07`），**只有壳知道**，
 *    它通过 `soundStatus` 的 `sounds` 字段报上来。所以这里要把它读出来填进去。
 *
 * ⚠️ 壳还没回报过（`known:false`）时**不要猜** —— `soundFileOf` 会返回 null，
 *    含义是"用系统默认闹钟音"。宁可响默认音，也别传一个不存在的名字
 *    （`named("")` 在 iOS 上是"这条没声音"而且不报错，是最糟的静默失败）。
 */
export function alarmSoundFile(soundId) {
  return soundFileOf(soundId, customSoundOpts());
}

/**
 * 交给 core 的"本机有哪些自定义铃声"。
 *
 * ⚠️ 每次**现取**（不缓存成模块级常量）：壳可能在任何时候报新名单
 *    （导入一首、删掉一首）—— 缓存住就会出现"刚导入的那首排不出去"。
 *
 * ⚠️ 同时把**用户起的名字**带上（`settings.customSoundNames`）：
 *    那是"哪一首"的显示名，跟着设置同步走，而**文件**只在这台设备上 ——
 *    两者来源不同，所以在这里汇合（core 的 `normalizeCustomSounds` 负责合并）。
 *    ⚠️ 这两样**不能缓存**：改名字走的是同一份设置，缓存住就会出现
 *    "名字改完，列表上还是旧的"（而这种不一致最难查，因为它不报错）。
 */
function customSoundOpts() {
  const st = store.getState() || {};
  const names = (st.settings && st.settings.customSoundNames) || {};
  return { customFile: customAlarmSounds(), customNames: names };
}

/**
 * 能不能用真闹钟（AlarmKit）。
 *
 * ⚠️ 三个字段各有各的意思，**界面不能混着说**（和 native.js 的 alarmKitStatus 同源）：
 *   · `shell:'ios'`       —— 只有 iOS 壳有 AlarmKit。安卓/电脑**没有**这条路，
 *                            所以那边连"闹钟板块"都不该出现（见 web/ui/app.js 的门控）
 *   · `available:false`   —— 系统低于 iOS 26：这台设备**根本没有**真闹钟
 *   · `authorized:false`  —— 有这能力但没给权限 → 排了也不会响
 */
export function alarmKitInfo() {
  const kind = shellKind();
  const status = typeof store.getState === 'function' ? store.getState() : {};
  const kit = status.alarmKit || { known: false, available: false, authorized: false };
  return {
    shell: kind,
    inShell: kind === 'ios',
    known: kit.known === true,
    available: kit.available === true,
    authorized: kit.authorized === true,
    ...scheduleStatus(),
  };
}

// ---------------------------------------------------------------------------
// 壳回报的状态（排了几条、哪些生效、铃声是不是真的用上了）
// ---------------------------------------------------------------------------

/**
 * ⚠️ 为什么要壳回报"铃声有没有真的用上"：
 *   `AlertSound.named(名字)` 找不到文件时，iOS 的行为是**静默放默认闹钟音**
 *   （不报错、不抛异常）。所以"设了铃声却听到系统音"这件事，**只能靠壳回报**。
 *   没有这个字段，用户只会觉得"这 App 的铃声功能是坏的"，
 *   而我们连"它到底有没有找到文件"都答不上来。
 */
let scheduleState = {
  known: false,
  scheduled: [],      // [{ id, fireAt, sound, soundOk }]
  count: 0,
  soundUnsupported: false,   // 壳明确回报"自定义铃声没生效"（文件找不到）
  error: null,
};

export function scheduleStatus() {
  return {
    known: scheduleState.known,
    count: scheduleState.count,
    scheduled: scheduleState.scheduled.map((s) => ({ ...s })),
    soundUnsupported: scheduleState.soundUnsupported,
    error: scheduleState.error,
    lastSchedule: scheduleState.lastSchedule,
    lastScheduleError: scheduleState.lastScheduleError,
  };
}

/** 壳回灌一条 `alarms` 消息时调这里（由 web/ui/app.js 装上） */
export function applyShellAlarms(msg) {
  const m = (msg && typeof msg === 'object') ? msg : {};
  const list = Array.isArray(m.scheduled) ? m.scheduled : [];
  scheduleState = {
    known: true,
    scheduled: list.map((s) => ({
      id: s && s.id ? String(s.id) : '',
      fireAt: s && s.fireAt ? String(s.fireAt) : '',
      sound: s && s.sound ? String(s.sound) : null,
      // 壳侧逐个核对"这个文件在不在包里"；false = 它会放默认音
      soundOk: !(s && s.soundOk === false),
    })),
    count: Number.isFinite(Number(m.count)) ? Number(m.count) : list.length,
    soundUnsupported: m.soundUnsupported === true
      || list.some((s) => s && s.soundOk === false),
    error: m.error ? String(m.error) : null,
    // ⚠️ 壳侧**上一次 `schedule()` 的结果**（2026-09-30 补，见 App.swift 的注释）。
    //    'ok' = 系统收下了（但**不代表会响**）；'failed' = 压根没排上。
    //    非本机（旧壳 / 电脑）不会带这两个字段 → 一律当"不知道"（null），
    //    **不要默认成成功**（那正是本项目最忌讳的那种绿）。
    lastSchedule: m.lastSchedule === 'ok' || m.lastSchedule === 'failed' ? m.lastSchedule : null,
    lastScheduleError: m.lastScheduleError ? String(m.lastScheduleError) : null,
  };
  return scheduleStatus();
}

// ---------------------------------------------------------------------------
// 把"该排的闹钟"交给壳
// ---------------------------------------------------------------------------

/**
 * 把当前该排的闹钟整批交给壳（重排）。
 *
 * ⚠️ 和提醒那条路一样是**整批替换**（壳侧 `replaceAll`）：
 *    "删了还响"比"漏一次"更糟，所以每次数据一变就整批重排。
 * ⚠️ 为什么这里**不上报就静默成功**：不在 iOS 壳里时 `postToShell` 返回 false，
 *    这里如实返回 `{ sent:false, reason }`，界面据此说"这台设备上没有真闹钟"
 *    （而不是假装排好了）。
 */
export function pushAlarmSchedule({ now = new Date() } = {}) {
  const state = store.getState();
  const alarms = Array.isArray(state.alarms) ? state.alarms : [];
  const plan = planAlarmSchedule(alarms, { now, max: MAX_SCHEDULED, ...customSoundOpts() });

  // ⚠️ 安卓：**故意什么都不发**，而且要说清原因。
  //
  //   安卓壳没有 JS 桥（没有 addJavascriptInterface，只有 127.0.0.1 的 HTTP），
  //   所以"把排程交给壳"这件事在安卓上根本不存在 —— 排程由**壳自己**做：
  //   它在 `MainActivity` 里把 `store.onChanged` 挂到了 `ReminderAlarms.reschedule`，
  //   每次数据变动就按 Store 里的 alarms 重算下一次唤醒（见 android/.../ReminderAlarms.kt）。
  //
  //   所以这里**不能**改成走 HTTP（那会变成"网页指挥原生排程"，两条真源必然分叉）；
  //   也不能照旧返回 sent:false —— 界面会据此说"没能交给系统，它可能不会响"，
  //   而实际上闹钟排上了。返回 `handled:'shell'` 让调用方能区分"安卓的另一条路"。
  if (platformKind() === 'android') {
    return { sent: false, handled: 'shell', count: plan.length, total: alarms.length, plan };
  }

  const ok = postToShell({
    type: 'alarms',
    items: plan,
    // 顺带把"全部闹钟条数"报上去：诊断区要显示"库里 5 条、排出去 3 条"，
    // 两个数不一样时用户才知道"有 2 条没排上"（而不是以为都排好了）。
    total: alarms.length,
    max: MAX_SCHEDULED,
  });
  return { sent: ok, handled: ok ? 'shell' : null, count: plan.length, total: alarms.length, plan };
}

/** 让壳重报一次状态（从系统读真状态，比缓存准）。安卓上排程不由网页下发，故无事可做 */
export function refreshAlarmSchedule() {
  // 安卓没有这条下行通道（理由见 pushAlarmSchedule），如实返回 false。
  if (platformKind() === 'android') return false;
  return postToShell({ type: 'alarmScheduleStatus' });
}

/**
 * 只算不发：网页这边算出的排程。
 *
 * ⚠️ 诊断区要拿它和**壳回报的实际排程**对照着显示 —— 两边不一致就说明
 *    "有一条没排上"，而那才是最需要被看见的信息（用户只会感觉"某条不响"）。
 *    所以这里必须转调 core 那**同一个**函数，不许在视图里另算一遍。
 */
export function planAlarms(alarms, { now = new Date() } = {}) {
  return planAlarmSchedule(alarms, { now, max: MAX_SCHEDULED, ...customSoundOpts() });
}

// ---------------------------------------------------------------------------
// 计时器（倒计时）—— 状态机
//
// ⚠️ 计时器**不走** `alarms` 那条"整批重排"的路（见 core/alarms.js 的注释）：
//    它是"按了才开始"的一次性动作，混进重排链路的话，每次数据变动都会把
//    正在跑的倒计时重置一遍。所以它有自己的几条消息。
// ---------------------------------------------------------------------------

/** 开始/继续：把 startedAt 设成"现在 − 已经过去的时间"，通知壳在剩余时间后响 */
function startTimerMessage(alarm) {
  const remain = Math.max(0, Number(alarm.durationMs) || 0);
  return postToShell({
    type: 'alarmTimer',
    action: 'start',
    id: alarm.id,
    // ⚠️ 传**秒**（系统 API 就是秒），而且由网页算好 —— 壳不做算术
    durationSec: Math.round(remain / 1000),
    // ⚠️ 用 `alarmSoundFile`（不是 `soundFileOf`）：自定义铃声的文件名要现查壳报的 `alarmFile`
    sound: alarmSoundFile(alarm.sound),
    title: alarm.label || '计时器',
  });
}

/**
 * 开始一个计时器。
 *
 * @param {object} opts.alarm 已经存在的那条（可省）
 * @param {number} opts.minutes 新计时器的分钟数（没给 alarm 时用它）
 *
 * ⚠️ 时序：**先落库、再通知壳**。
 *   反过来的话，壳已经开始倒计时了、而库里还没记 —— App 一重启就出现
 *   "系统里有个倒计时，列表里却没有"的幽灵条目。
 */
export async function startTimer({ alarm = null, minutes = 25, now = new Date() } = {}) {
  const base = alarm
    ? normalizeAlarm(alarm, now)
    : normalizeAlarm({ kind: 'timer', durationMs: Math.round(minutes * 60_000), label: '' }, now);
  const startedAt = now.toISOString();
  const saved = await store.saveAlarm({
    ...base,
    kind: 'timer',
    enabled: true,
    startedAt,
    paused: false,
    // 重新开始时**重置时长**：用户点的"开始"是"再倒计时这么长"，
    // 而不是"接着上次剩下的那点继续"（那是"继续"按钮的语义）。
    durationMs: alarm ? base.durationMs : Math.round(minutes * 60_000),
  });
  const sent = startTimerMessage(saved);
  return { alarm: saved, sent };
}

/** 暂停：算出剩多少，把 startedAt 往回挪（倒计时就冻住了） */
export async function pauseTimer(alarm, now = new Date()) {
  const a = normalizeAlarm(alarm, now);
  if (!a.startedAt) return { alarm: a, sent: false, reason: '这条计时器没在跑' };
  const end = new Date(a.startedAt).getTime() + a.durationMs;
  const left = Math.max(0, end - now.getTime());
  const saved = await store.saveAlarm({
    ...a,
    // ⚠️ 这个式子的含义：`startedAt + durationMs - now = left` ⇒ 解出 startedAt。
    //    于是"暂停"不需要新字段（不用 `remainMs`），删除/同步/归一化都不用管它。
    //    startedAt 是过去的时刻，nextFireAt 会算出 end = 现在 + left。
    //    ⚠️ 暂停之后 `timerRemainingMs` **照样返回那个 left**（不是 null）——
    //       "暂停"和"没开始"必须是两种可区分的状态，否则界面没法显示
    //       "暂停在 12:34"（那正是用户暂停时想看到的）。
    startedAt: new Date(now.getTime() - (a.durationMs - left)).toISOString(),
    // ⚠️ 显式记下"这是用户主动暂停的"（见 core/alarms.js 里 paused 那段注释）：
    //    只有它能区分"暂停"和"在跑"——两者算出来的剩余时间完全一样。
    paused: true,
  });
  const sent = postToShell({ type: 'alarmTimer', action: 'cancel', id: saved.id });
  return { alarm: saved, sent };
}

/**
 * 继续：把 startedAt 挪到"现在 − (总时长 − 剩余时长)"，然后重新交给壳。
 *
 * ⚠️ 这里**不能**调 `startTimer`（那个会把 startedAt 设成 now、并且重置时长）——
 *    那样"继续"就变成了"从头再来"，用户会觉得"我按了继续，怎么又从头开始数"。
 */
export async function resumeTimer(alarm, now = new Date()) {
  const a = normalizeAlarm(alarm, now);
  const left = timerRemainingMs(a, now);
  if (left === null) return { alarm: a, sent: false, reason: '这条计时器没在跑，请按"开始"' };
  const startedAt = new Date(now.getTime() - (a.durationMs - left)).toISOString();
  const saved = await store.saveAlarm({ ...a, enabled: true, startedAt, paused: false });
  const end = new Date(startedAt).getTime() + a.durationMs;
  const sent = postToShell({
    type: 'alarmTimer',
    action: 'start',
    id: saved.id,
    durationSec: Math.max(1, Math.round((end - now.getTime()) / 1000)),
    sound: alarmSoundFile(saved.sound),
    title: saved.label || '计时器',
  });
  return { alarm: saved, sent };
}

/** 取消：把 startedAt 清掉，并让壳撤掉那个倒计时 */
export async function cancelTimer(alarm, now = new Date()) {
  const a = normalizeAlarm(alarm, now);
  const saved = await store.saveAlarm({ ...a, startedAt: null, paused: false });
  const sent = postToShell({ type: 'alarmTimer', action: 'cancel', id: saved.id });
  return { alarm: saved, sent };
}

// ---------------------------------------------------------------------------
// 诊断 + 试响
// ---------------------------------------------------------------------------

/**
 * 「10 秒后试响（用当前选的铃声）」。
 *
 * ⚠️ 为什么这个按钮是这个板块**最重要的一个按钮**：
 *   铃声这条链路的每一段都有"静默失败"的可能（授权没给 / 低于 26 /
 *   文件没进包 / 名字给错 / 26.1 到底修没修）。而**每一段的失败方式都是
 *   "响一声默认音"或"什么都不响"** —— 从结果上看一模一样。
 *   所以必须有一个"立刻、只用当前铃声、10 秒后响"的最小实验：
 *   它把"板块本身通不通"和"铃声对不对"一次问完。
 *
 * ⚠️ 默认 **10 秒**（用户要求）：够他锁屏、把手机放下。
 */
export function testAlarmSound({ soundId, seconds = 10 } = {}) {
  const s = soundById(soundId) || null;
  // ⚠️ 自定义铃声要现查壳报的文件名（`s.file` 对自定义那一类是空串）
  const file = s ? alarmSoundFile(s.id) : null;
  const sent = postToShell({
    type: 'alarmTimer',
    action: 'start',
    id: 'alarm_test_' + Date.now(),
    durationSec: Math.max(3, Math.round(Number(seconds) || 10)),
    sound: file,
    // ⚠️ 标题用**用户能认出的那首的名字**（"试响：自定义 · 竹取飛翔"），
    //    不用 `s.label`（那对所有自定义 id 都是同一句"自定义（我导入的）"）——
    //    这条通知是用户判断"我选的到底是不是这首"的唯一依据。
    title: s ? `试响：${soundLabelOf(soundId, customSoundOpts()) || s.label}` : '试响：系统默认音',
    // ⚠️ `test: true` 是给壳看的**唯一区别**（2026-10-02 加）：壳侧据此在响过之后
    //    自动把这条从系统里撤掉（见 ios/Timetable/AlarmClockScheduler.swift 的
    //    `isTest` 与 `sweepOne`）。为什么非要这个字段：用户报「试响过了一阵又
    //    自己冒出来」——真正的倒计时和试响走的是**同一个** `alarmTimer` 消息，
    //    壳侧不能靠 id 前缀猜（那是隐式耦合），所以由发送方明说。
    test: true,
  });
  return { sent, file, seconds };
}

/** 内置铃声列表（给 UI 直接渲染；含"认不出来"的兜底） */
export function builtinSounds() {
  return ALARM_SOUNDS.map((s) => ({ ...s }));
}
