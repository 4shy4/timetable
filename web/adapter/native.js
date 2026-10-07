// 原生壳桥（iOS/安卓 WebView 外的那层 Swift/Kotlin）。
//
// 原生壳里**只有一件事**是 JS 做不了、必须交给系统的：**把提醒提前注册好**。
// 气泡、编辑器、课表全都是同一份 web/ 代码在 WebView 里跑；数据在本地（4b）。
// 所以这个文件只负责：
//   ① 认出"我在原生壳里"（而不是浏览器/PWA）
//   ② 把 core/notify-plan.js 排出来的提醒计划**交给系统**
//      （iOS 侧转成 UNCalendarNotificationTrigger，安卓侧转成 AlarmManager）
//
// ⚠️ 为什么提醒必须由系统守：iOS 上 App 切到后台后不能指望它按时醒来
//    （BGAppRefreshTask 的时机由系统决定）。见 docs/IOS.md 与 docs/IOS-NATIVE.md。
//
// 协议（JS → 原生），两端共用一份，见 docs/IOS-NATIVE.md：
//   { type: 'notifications', items: [{id, eventId, title, body, fireAt, intensity, useAlarm}] }
//   { type: 'writeShare', json, text }     ← 写成文件，给快捷指令/Siri 读（见 core/share-plan.js）
//   { type: 'ready', localMode: boolean, count: number }
//   { type: 'openEvent', eventId }        ← 用户点通知后回跳（原生侧回灌）
//   { type: 'log', message }

import { planNotifications, soundForIntensity, usableCustomSounds } from '../../core/notify-plan.js';
import { notificationPlanForRemaining, resolveIntensity } from '../../core/level.js';
// ⚠️ 自定义铃声的清单**必须先过 core 的规则**再进内存（`normalizeCustomSounds`）：
//    壳报回来的是一堆文件名，而"文件名 → id"这条规则是**跨三层**的约定，
//    在这里自己解析一遍就会出现"两个地方各有一套规则、慢慢长歪"。
//    方向也对：adapter 依赖 core，反过来会成环（core 不认 adapter）。
import { normalizeCustomSounds } from '../../core/alarms.js';
// 「给 Siri 看的计划」——文本由 core 生成，壳只负责写文件（见该文件顶部的说明）
import { buildSharePlan } from '../../core/share-plan.js';
// 语音桥：往系统「提醒事项」写镜像，让 Siri 原生读写（见该文件顶部的说明）
import { buildVoiceMirror, VOICE_LIST_NAME, MIRROR_MARK } from '../../core/voice-bridge.js';

/** 在哪一层壳里跑。没有壳 → null（普通浏览器/PWA） */
export function shellKind() {
  if (typeof window === 'undefined') return null;
  // iOS：WKWebView 注入的 messageHandlers
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.timetable) return 'ios';
  // ⚠️ 兼容标记：App.swift 也在文档开头注入 `window.__timetableInShell = 'ios'`。
  //
  //    原来这里**只**认 messageHandlers，而 App.swift 的注释却写着
  //    "网页据此知道'我在 App 里'" —— 那句话**不成立**：
  //    这个变量当时没有任何 JS 读它（实测全仓确认）。
  //    功能上没问题（真机上 messageHandlers 一定存在），但它是个陷阱：
  //    **万一以后有人觉得 `controller.add(self, name:"timetable")` 多余而删掉**，
  //    应用就会静默退回 remote 模式，首次打开显示"未连接到本地服务"。
  //    两个标记都认，就不存在"删一个还能跑、删另一个就崩"这种隐患。
  if (window.__timetableInShell === 'ios') return 'ios';
  // 安卓：LocalServer 之外的壳（如果将来加一条桥）；也兼容任何自建壳
  if (window.timetableNative && typeof window.timetableNative.post === 'function') return 'generic';
  return null;
}

/** 在原生壳里吗 */
export function inShell() { return shellKind() !== null; }

/**
 * "我在哪个平台的壳里" —— 安卓壳**唯一**能认出来的标记。
 *
 * ⚠️⚠️ **千万不要拿它去改 `shellKind()` / `inShell()`**，这是本文件最容易踩的坑：
 *   `web/adapter/local-mode.js` 的 `savedMode()` 写的是
 *   `inShell() ? 'local' : 'remote'` —— 安卓壳里**必须**留在 `remote` 模式，
 *   因为它的数据只走 `http://127.0.0.1:17800`（壳自己的 Store）。
 *   一旦 `inShell()` 在安卓上变成 true，数据就会写进 WebView 的 IndexedDB，
 *   壳的 Store 永远收不到 → **提醒和闹钟全都不会响**，而且界面上一点错都不报
 *   （这正是本项目最怕的那种静默失败）。
 *   所以安卓的标记**另起一个函数**，只给"闹钟板块要不要显示"这类
 *   **纯显示判断**用。
 *
 * 标记的来源：安卓壳的 `LocalServer.handleStatic()` 在返回 HTML 入口时
 * 往 `<head>` 后面注入了一行 `<script>window.__timetablePlatform='android';</script>`
 * （安卓没有 JS 桥，这是它唯一能做到的**同步**信号 —— 异步问一次
 * `/api/health` 的话，首次渲染时门控已经判完了）。
 *
 * 返回：`'android'` / `'ios'` / `null`（不是原生壳）。
 */
export function platformKind() {
  if (typeof window === 'undefined') return null;
  if (window.__timetablePlatform === 'android') return 'android';
  // iOS 壳也报一下：它同时还有 messageHandlers，但调用方常常只想知道"是哪个平台"。
  if (shellKind() === 'ios') return 'ios';
  return null;
}

/**
 * 往原生侧发一条消息。
 * 没有壳时**静默忽略** —— 这样同一个 web/ 在浏览器里也跑得通，不需要到处判断。
 */
export function postToShell(msg) {
  const kind = shellKind();
  if (!kind) return false;
  try {
    if (kind === 'ios') window.webkit.messageHandlers.timetable.postMessage(msg);
    else window.timetableNative.post(msg);
    return true;
  } catch (err) {
    // 壳那边出问题不该把网页带崩 —— 退化成"没有提醒"，但界面照常能用
    console.warn('[native] 发给原生壳失败', err);
    return false;
  }
}

/**
 * 上一次"把提醒交给系统"的结果 —— 给界面显示用。
 *
 * 为什么要记这个（用户实测场景）：
 *   到点了没响，而"没响"有好几种完全不同的原因：
 *     · 根本不在原生壳里（`postToShell` 静默返回 false）
 *     · 计划是空的（没有可排的提醒）
 *     · 权限没给（这一层 JS 看不到，只能靠"测试通知"反推）
 *   不把结果露出来，就只能靠猜。所以每次推送都留一份，界面直接显示。
 */
let lastPush = null;
export function lastPushStatus() { return lastPush; }

/**
 * 把当前该排的提醒交给系统。
 *
 * @param {object} opts
 * @param {Array} opts.events
 * @param {object} opts.settings
 * @returns {{sent:boolean, count:number, nextAt:string|null}}
 */
export function pushNotifications({ events = [], settings = {} } = {}) {
  if (!inShell()) {
    lastPush = { at: new Date().toISOString(), sent: false, count: 0, nextAt: null, reason: '不在原生壳内' };
    return lastPush;
  }
  const plan = planFor({ events, settings });
  const ok = postToShell({ type: 'notifications', items: plan });
  lastPush = {
    at: new Date().toISOString(),
    sent: ok,
    count: plan.length,
    nextAt: plan.length ? plan[0].fireAt : null,
    reason: ok ? null : '发给原生壳失败',
  };
  return lastPush;
}

/**
 * 立刻让系统发一条**测试通知**（默认 5 秒后响）。
 *
 * 为什么必须有这个（用户到点没响，而原因只能靠猜）：
 *   这一条走的是**和真实提醒完全相同的通道**（同一个 postToShell → 同一个
 *   `replaceAll` → 同一个 `UNCalendarNotificationTrigger`）。所以：
 *     · 它响了  → 权限、通道、解析、投递全都没问题，那问题在"计划里有没有东西"
 *     · 它不响  → 权限没给，或者原生那侧没工作 —— 与日程数据无关
 *   一次点击就能把"到底是哪一段坏了"劈成两半。
 *
 * ⚠️ 原生侧的 `replaceAll` 是**整批替换**，所以这里把测试条目**并进真实计划**里
 *    一起送，而不是单独发一条 —— 否则会把真实提醒全冲掉。
 *    并且按 fireAt 排序（测试条目最早），保证它不会被"只留最早 64 条"挤出去。
 */
export function sendTestNotification({ events = [], settings = {}, delayMs = 5000 } = {}) {
  if (!inShell()) return { sent: false, reason: '不在原生壳内（测试通知只对原生 App 有意义）' };
  const notify = settings.notify || {};
  const plan = planFor({ events, settings });
  plan.push({
    id: 'shell-test-' + Date.now(),
    eventId: '__shell_test__',
    title: '测试通知',
    body: '看到这条说明系统通知是通的（在这条之后 ' + Math.round(delayMs / 1000) + ' 秒内）',
    fireAt: new Date(Date.now() + delayMs).toISOString(),
    intensity: 3,
    // 测试条目**永远不勾真闹钟** —— 否则点一下测试就会拉响一个满音量的系统闹钟
    useAlarm: false,
    // ⚠️ 测试通知要**带上真实的声音**，否则它证明不了"提示音是通的"：
    //    用户换过自定义音之后，点测试正是他想确认"我那个音到底响不响"的时候。
    sound: soundForIntensity(3, usableCustomSounds(notify.customSounds, soundFiles.known ? soundFiles.files : [])),
  });
  plan.sort((a, b) => new Date(a.fireAt) - new Date(b.fireAt));
  const ok = postToShell({ type: 'notifications', items: plan });
  return { sent: ok, count: plan.length, nextAt: plan[0].fireAt };
}

/** 只算不发（测试与调试用） */
export function planFor({ events = [], settings = {}, now = new Date() } = {}) {
  const notify = settings.notify || {};
  return planNotifications({
    events,
    termStart: settings.termStart || '',
    now,
    periodAffectsReminders: settings.periodAffectsReminders === true,
    // 强度设置在这里也生效 —— 原生壳弹通知时要按同一档走
    intensityOf: (ev) => resolveIntensity(
      notify.intensity,
      remainingIntensity(ev, now),
    ),
    // ⚠️ 自定义提示音必须**先过滤成"这台设备上真的有的"**再传下去：
    //    设置会跟着数据同步，但声音文件只在导入它的那台设备上（App 容器里）。
    //    把一个不存在的名字发给系统，iOS 的行为是**静默降级**（没声音/默认音），
    //    用户只会觉得"我的提示音怎么没了"。
    customSounds: usableCustomSounds(notify.customSounds, soundFiles.known ? soundFiles.files : []),
  });
}

/**
 * 把"未来几天的安排"交给原生壳**写成文件**，让快捷指令 / Siri 能读到。
 *
 * ⚠️⚠️ 为什么是"写文件"而不是"让 Siri 问 App"：
 *   原生 Siri 集成（App Intents）需要 `com.apple.developer.siri`，免费账号拿不到，
 *   而且侧载缺它会让 App **一启动就崩**（transcripts/0015 有那次调研）。
 *   在没有任何 entitlement 的前提下，**文件是 Siri 唯一能读到我们数据的通道**：
 *     App 写 `Documents/timetable-plan.txt` → 快捷指令「获取文件」→ Siri 念出来。
 *   （打开 `UIFileSharingEnabled` 之后，这个文件在「文件」App 里也能直接看到。）
 *
 * ⚠️ 内容由 core/share-plan.js 生成（业务在网页层，壳只翻译）——
 *    这里只是搬运，不要在这里拼字符串。
 *
 * @returns {{sent:boolean, count?:number, reason?:string}}
 */
export function pushShareData({ events = [], settings = {}, now = new Date() } = {}) {
  if (!inShell()) return { sent: false, reason: '不在原生壳内（写文件只对原生 App 有意义）' };
  let payload;
  try {
    payload = buildSharePlan(events, {
      now,
      days: 7,
      termStart: settings.termStart || '',
    });
  } catch (err) {
    // ⚠️ 这里绝不能把异常丢成"未处理的拒绝"：调用它的是 setInterval/事件回调，
    //    没人 await —— 那样就变成**完全静默**，用户只会发现"Siri 念的是旧的"。
    console.warn('[native] 生成分享计划失败', err);
    return { sent: false, reason: String((err && err.message) || err) };
  }
  const ok = postToShell({ type: 'writeShare', json: payload.json, text: payload.text });
  return ok ? { sent: true, count: payload.count } : { sent: false, reason: '发给原生壳失败' };
}

/**
 * 语音桥（往系统「提醒事项」写一份镜像，让 **Siri 原生**读得到）。
 *
 * ⚠️ 为什么换到这条路：见 core/voice-bridge.js 顶部 ——
 *   "写文件 + 快捷指令"用户侧摩擦太大（动作名、类型过滤、运行时显示），
 *   而「提醒事项」是苹果原生支持 Siri 的，**一个快捷指令都不用建**。
 *
 * ⚠️ 内容由 core/voice-bridge.js 算好（清单名、标记、每条写什么）——
 *    这里只搬运，不在这里拼字符串、也不判断"该不该写"。
 */
export function pushVoiceMirror({ events = [], settings = {}, now = new Date() } = {}) {
  if (!inShell()) return { sent: false, reason: '不在原生壳内' };
  let items;
  try {
    items = buildVoiceMirror(events, { now, termStart: settings.termStart || '' });
  } catch (err) {
    // ⚠️ 绝不能丢成"未处理的拒绝"：调用方是 setInterval/事件回调，没人 await，
    //    那样就完全静默 —— 用户只会发现"Siri 念的是旧的"。
    console.warn('[native] 组装语音镜像失败', err);
    return { sent: false, reason: String((err && err.message) || err) };
  }
  const ok = postToShell({
    type: 'voiceMirror',
    listName: VOICE_LIST_NAME,
    mirrorMark: MIRROR_MARK,
    items,
  });
  return ok ? { sent: true, count: items.length } : { sent: false, reason: '发给原生壳失败' };
}

/** 最近一次语音桥状态（壳报回来的） */
let voiceStatus = { known: false, authorized: false, last: null };
export function voiceBridgeStatus() { return { ...voiceStatus }; }

/** 申请「提醒事项」权限（**由用户手势触发**最可靠，所以做成按钮） */
export function requestVoiceAccess() {
  return postToShell({ type: 'voiceAuth' });
}

/** 让壳重报一次状态（只读，不弹窗） */
export function refreshVoiceStatus() {
  return postToShell({ type: 'voiceStatus' });
}

// ---------------------------------------------------------------------------
// 自定义提示音（用户把自己的一段音频换成提醒的声音）
// ---------------------------------------------------------------------------
//
// ⚠️ 分工（和这个文件其它桥一样）：**业务在网页层，壳只做翻译**。
//   · "哪一档用哪个声音"由 core/notify-plan.js 的 soundForIntensity 决定
//   · "容器里到底有哪些文件"只有壳知道 → 它报一份名单上来（soundStatus），
//     网页层用名单过滤（usableCustomSounds），避免把一个不存在的名字发给系统
//     （那种情况 iOS **不报错**，只是没声音 —— 用户只会觉得"提醒坏了"）
//   · 转换/落盘（30 秒以内的 .caf 写进 Library/Sounds）是壳的活

/**
 * 让用户挑一段音频。
 *
 * 两种用途（2026-10-02 起）：
 *   · **不带参数** —— 加进「我的铃声」**列表**（闹钟用的那个列表，可以有多首）
 *   · **带 tier**（2 柔和 / 3 中等 / 4 强烈）—— 替换通知的对应档位
 *
 * ⚠️ 用真实文件名的前缀（`timetable-custom-`）区分，**不是**用 `tier: 0` 那个老约定：
 *    壳侧现在也按这个名字区分（见 `App.swift` 的 `case "pickSound"`）。
 *    老约定的问题是"0 档"这个名字在"多首共存"之后已经没有意义了 —— 留着它，
 *    将来谁看到 `tier: 0` 都会以为还有"第 0 档"这个概念。
 */
export const CUSTOM_SOUND_PREFIX = 'timetable-custom-';

/**
 * 文件名 → id（**只留给"老壳没报 id"那条兼容路**）。
 *
 * ⚠️ 为什么在这里又写了一遍 core 那个 `fileStemOf`：那个是 `core/alarms.js` 的**内部函数**
 *    （没导出），而这里是在处理**壳的原始消息**（还没进 core 的模型）。
 *    两边规则必须一致：`timetable-custom-` + 8 位小写十六进制 + `.caf`。
 *    `tools/ios-bundle-check.mjs` 会核对这一行与前缀常量仍然一致。
 */
function soundIdOfName(name) {
  const s = String(name || '');
  if (!s.startsWith(CUSTOM_SOUND_PREFIX) || !s.endsWith('.caf')) return '';
  const stem = s.slice(CUSTOM_SOUND_PREFIX.length, -4);
  // ⚠️ 规则必须和 `core/alarms.js` 的 `fileStemOf()` **逐字一致**（两处都要能认出
  //    壳报上来的文件名）。老壳的文件名是 `timetable-custom-t0-1696….caf`（带 `-`），
  //    新壳是 `timetable-custom-9f3a1c07.caf`（正好 8 位小写十六进制）——
  //    只认后者的话，**老壳 + 老文件**那一组会得到空 id，用户那首歌就"看不见了"。
  //    （这条一致性由 `tools/ios-bundle-check.mjs` 对着 core 的正则核对。）
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(stem) ? stem : '';
}

/**
 * 让用户挑一段音频（不带参数 = **加进「我的铃声」列表**；带 tier = 顺便记下"这是给通知第几档挑的"）。
 *
 * ⚠️ 返回值只表示"消息有没有发出去"，**不代表用户选好了** ——
 *    真正的结果要等壳回报 `soundImported`（见下面 `installShellReceiver`）。
 *    界面必须按"异步"用（先弹一条"去『文件』里选"，别装作已经导入好了）。
 *
 * ⚠️⚠️ 2026-10-02：**`tier` 已经不再发给壳了**（用户要"一个自定义列表"，
 *    而"替换第几档"正是"导第二首顶掉第一首"的病根）。
 *    但通知那一侧（`settings.notify.customSounds` 记的是"第几档用哪个文件名"）
 *    仍然需要知道"这次是给哪一档挑的"，所以这里把它**记在本地**，
 *    等壳回报时**原样带回给界面**（见 `pickSoundTier`）。
 *    这样两边都不用改协议，通知那三档的"换了哪一档"也不会串。
 */
let pickSoundTier = 0;

export function pickCustomSound(tier) {
  // `Number(tier)` 对 `undefined` 是 NaN → 0 = **闹钟铃声列表**模式。这是有意的：
  // 调用方"忘了传 tier"应当得到**加进列表**（安全、可撤销），而不是**悄悄覆盖某一档通知音**。
  const n = Number(tier);
  pickSoundTier = Number.isFinite(n) && n > 0 ? n : 0;
  return postToShell({ type: 'pickSound' });
}

/** 删掉一个已经导入的提示音文件（网页侧同时要把设置里那条记录去掉） */
export function dropCustomSound(name) {
  if (!name) return false;
  return postToShell({ type: 'dropSound', name: String(name) });
}

/** 问壳"容器里现在有哪些自定义提示音"（启动时问一次，导入之后也会收到回报） */
export function refreshCustomSounds() {
  return postToShell({ type: 'soundStatus' });
}

/**
 * 最近一次壳报回来的"容器里有哪些自定义音"。
 *
 * ⚠️ `alarmFile` = **闹钟列表里的第一首**（老壳只报这一个字段时就是它报的那个）。
 *    为什么还需要它：网页只记"用户选了哪首自定义铃声"这个**意图**，
 *    而真实文件名是**运行时**才有的（`timetable-custom-9f3a1c07`）——
 *    排闹钟时网页得把这个名字交给壳去 `AlertSound.named(...)`。
 *
 * ⚠️ `sounds` = **闹钟铃声列表**（可以有多首，2026-10-02 起）。
 *    与 `files`（容器里**所有**自定义音，含通知那三档）**不是一回事**：
 *    `files` 是"用来核对设置里记的名字还在不在"的，`sounds` 是"能当闹钟铃声选的"。
 *    混用会出现"用户把通知音也看成闹钟铃声"这种错。
 */
let soundFiles = { known: false, files: [], sounds: [], alarmFile: '' };

/** 壳报回来的原始名单（`files` = 容器里所有自定义音；改前先想清楚要哪个） */
export function customSoundStatus() {
  return {
    ...soundFiles,
    files: [...soundFiles.files],
    sounds: soundFiles.sounds.map((s) => ({ ...s })),
    alarmFile: String(soundFiles.alarmFile || ''),
  };
}

/** 能当**闹钟铃声**选的那些（`[{ id, name, file }, …]`）—— 界面的铃声列表按这个过滤 */
export function customAlarmSounds() {
  return soundFiles.sounds.map((s) => ({ ...s }));
}

/** 事件按"还剩多久"算出的自动强度 */function remainingIntensity(ev, now) {
  const raw = ev && (ev.deadline || ev.end || ev.start);
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t)) return 1;
  return notificationPlanForRemaining(t - now.getTime()).intensity;
}

/** 告诉壳"网页准备好了"，顺便把当前模式报上去（壳可以据此决定要不要接管通知） */
export function announceReady({ localMode = false } = {}) {
  return postToShell({ type: 'ready', localMode, count: 0 });
}

/**
 * 接收壳回灌的事件（至少要有"用户点了通知 → 打开对应日程"）。
 * 壳侧调用：`window.__timetableNative.onMessage({type:'openEvent', eventId})`
 */
export function installShellReceiver(onOpenEvent, onOpenUrl, onAction) {
  if (typeof window === 'undefined') return;
  window.__timetableNative = {
    onMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'openEvent' && msg.eventId && typeof onOpenEvent === 'function') {
        onOpenEvent(msg.eventId);
      }
      // 深链（快捷指令 / Siri 打开 timetable://…）—— 见 core/nl-parse.js 的 parseDeepLink
      if (msg.type === 'openUrl' && msg.url && typeof onOpenUrl === 'function') {
        onOpenUrl(String(msg.url));
      }
      // 用户在**通知按钮**上做了动作（「完成」）—— 壳只转达意图，改数据归这里
      if (msg.type === 'action' && typeof onAction === 'function') {
        onAction({ action: String(msg.action || ''), eventId: msg.eventId ? String(msg.eventId) : '' });
      }
      // 壳把「提醒事项」的同步结果报回来（含**用户自己用 Siri 加的那些**）
      if (msg.type === 'voiceImported') {
        voiceStatus = { known: true, authorized: true, last: msg };
        try { window.dispatchEvent(new CustomEvent('timetable:voice', { detail: msg })); } catch { /* 老浏览器 */ }
      }
      if (msg.type === 'voiceStatus') {
        voiceStatus = {
          known: true,
          authorized: msg.authorized === true,
          last: msg.last || voiceStatus.last,
        };
        try { window.dispatchEvent(new CustomEvent('timetable:voice', { detail: voiceStatus })); } catch { /* 老浏览器 */ }
      }
      // 壳报告"真闹钟（AlarmKit）能不能用" —— 设置页要据此告诉用户
      // "最高档现在到底会不会真响"，而不是让用户以为设了就一定有。
      if (msg.type === 'alarmkit') {
        alarmKit = { known: true, available: msg.available === true, authorized: msg.authorized === true };
        // 通知一下界面，免得设置页停在旧状态上
        try { window.dispatchEvent(new CustomEvent('timetable:alarmkit', { detail: alarmKit })); } catch { /* 老浏览器 */ }
      }
      // 壳报告**闹钟板块**的实际排程（排了几条 / 每条几点 / 铃声文件找没找到）。
      //
      // ⚠️ 这里只把消息**转发**给界面，不做任何业务判断（和这个文件其它桥同一条线）：
      //    "该排哪些"由 core/alarms.js 算好，壳只是如实回报它排成了什么样。
      // ⚠️ 为什么不在这里直接 import adapter/alarms.js 的 applyShellAlarms：
      //    alarms.js → native.js（用 postToShell）已经是一条单向依赖，
      //    反向 import 会成环；ES 模块的循环依赖在"模块加载时就要用"的场景下
      //    炸得很隐蔽。所以这里只派发事件，由 app.js 那一层转给 alarms.js。
      if (msg.type === 'alarms') {
        try {
          window.dispatchEvent(new CustomEvent('timetable:alarms', { detail: msg }));
        } catch { /* 老浏览器 */ }
      }
      // 自定义提示音：壳报了"容器里有哪些文件" / 导入成功 / 删除结果
      // ⚠️ 三类都发同一个事件名，界面只需要"重新渲染一下设置页"这一种反应。
      if (msg.type === 'soundStatus') {
        // ⚠️ 两种形状都认（老壳只报 `alarmFile` 一个字符串；新壳报 `sounds` 数组）：
        //    老壳只有在"用户旧版本装过、新版本还没更新"的窗口里出现，
        //    但那个窗口里**必须**还能认出那一首 —— 否则用户的铃声会"看起来没了"。
        const raw = Array.isArray(msg.sounds) && msg.sounds.length
          ? msg.sounds
          : (typeof msg.alarmFile === 'string' && msg.alarmFile ? [msg.alarmFile] : []);
        soundFiles = {
          known: true,
          files: Array.isArray(msg.files) ? msg.files.map(String) : [],
          sounds: normalizeCustomSounds(raw),
          // 老字段继续维护（第一首）—— 还有别处在读它，突变字段名的成本远大于留一个兼容值
          alarmFile: typeof msg.alarmFile === 'string' ? msg.alarmFile : '',
        };
        try { window.dispatchEvent(new CustomEvent('timetable:sound', { detail: { kind: 'status', ...soundFiles } })); } catch { /* 老浏览器 */ }
      }
      if (msg.type === 'soundImported') {
        try {
          // ⚠️ 导入成功时，**先把这一首塞进内存里的名单**，再派发事件。
          //    为什么不能只等壳下次 `soundStatus`：用户导完常常**立刻**去建闹钟选它，
          //    而"重新问壳"是一次异步往返 —— 那个窗口里列表少一首，用户会以为没导进去。
          //    （壳也会顺手带一份全量 `sounds`，那就直接采信它、别自己拼。）
          if (Array.isArray(msg.sounds) && msg.sounds.length) {
            soundFiles = { ...soundFiles, known: true, sounds: normalizeCustomSounds(msg.sounds) };
          } else if (msg.ok === true && msg.name) {
            const added = normalizeCustomSounds([String(msg.name)]);
            if (added.length && !soundFiles.sounds.some((s) => s.id === added[0].id)) {
              soundFiles = { ...soundFiles, known: true, sounds: [...soundFiles.sounds, ...added] };
            }
          }
          // ⚠️ 顺手把壳带回来的 `alarmFile` 也更新掉（新壳才有这个字段）——
          //    否则"刚导入完就排闹钟"会用到**旧名字**（甚至还没有名字）。
          if (typeof msg.alarmFile === 'string') {
            soundFiles = { ...soundFiles, known: true, alarmFile: msg.alarmFile };
          }
          window.dispatchEvent(new CustomEvent('timetable:sound', {
            detail: {
              kind: 'imported',
              // ⚠️ 这个 `tier` 是**网页自己刚记下的那个**（"用户是从哪一档点的导入"），
              //    不是壳报的（壳已经不报 tier 了，见 `pickSoundTier` 的注释）。
              tier: pickSoundTier,
              ok: msg.ok === true,
              name: msg.name ? String(msg.name) : '',
              // 新壳会直接给 id（文件名里的 token）；老壳不给就现算（同一条规则，见 `soundIdOfName`）
              id: msg.id ? String(msg.id) : soundIdOfName(msg.name),
              reason: msg.reason ? String(msg.reason) : '',
              alarmFile: typeof msg.alarmFile === 'string' ? msg.alarmFile : '',
            },
          }));
        } catch { /* 老浏览器 */ }
      }
      if (msg.type === 'soundDropped') {
        try {
          // ⚠️ 删掉之后**必须从内存名单里摘掉**（不只是等下次 status）：
          //    还留在名单里 → 用户可以选中一首**已经不在的文件** → 那条闹钟静默响默认音。
          if (msg.name) {
            const gone = String(msg.name);
            soundFiles = {
              ...soundFiles,
              known: true,
              sounds: soundFiles.sounds.filter((s) => s.file !== gone),
              alarmFile: soundFiles.alarmFile === gone ? '' : soundFiles.alarmFile,
            };
          }
          window.dispatchEvent(new CustomEvent('timetable:sound', {
            detail: { kind: 'dropped', ok: msg.ok === true, name: msg.name ? String(msg.name) : '' },
          }));
        } catch { /* 老浏览器 */ }
      }
    },
  };
}

/**
 * 真闹钟（AlarmKit / iOS 26+）的可用状态。
 *
 * ⚠️ 这三个字段各有各的意思，界面**不能混着说**：
 *   · `known:false`      → 还没收到壳的报告（可能是浏览器、也可能还没就绪）
 *   · `available:false`  → 系统低于 26，这台设备**根本没有**真闹钟
 *   · `authorized:false` → 有这能力，但用户没给权限 → 最高档会**退回普通通知**
 */
let alarmKit = { known: false, available: false, authorized: false };

export function alarmKitStatus() { return { ...alarmKit }; }

/** 请求壳去申请闹钟权限（**由用户手势触发**最可靠，所以做成按钮） */
export function requestAlarmAuthorization() {
  return postToShell({ type: 'alarmAuth' });
}

/** 让壳重新报告一次状态（从系统读真状态，比缓存准） */
export function refreshAlarmStatus() {
  return postToShell({ type: 'alarmStatus' });
}

