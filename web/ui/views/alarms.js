// 「闹钟」板块 —— 计时器 / 定时器 / 铃声 三块 + 诊断。
//
// ===========================================================================
// ⚠️ 这个板块**只在原生壳里出现**：iOS 壳，或安卓壳
//   （安卓是 2026-10-xx 按用户要求"能加能删能改能响"放宽的，见 `alarmsViewAllowed()`）。
//
//   判定收在 `alarmsViewAllowed()` 里，**不确定时偏向不显示**：
//     · 在浏览器里跑（开发/测试）→ platformKind() 是 null → 不显示
//     · 通用自建壳                  → 不显示（没有原生排程通道）
//     · 电脑上的网页                → null → 不显示
//   iOS 侧严的理由：AlarmKit 是 iOS 26+ 的框架，别处没有那个"躲不开"的闹钟。
//   ⚠️ 安卓**确实有真闹钟**（系统 AlarmManager），只是形态不同（通知 + 铃声，
//      不是满音量锁屏全屏）—— 所以安卓不该照抄 iOS 的话术，见文件里各处
//      `isAndroidShell()` 的分叉。
//
//   ⚠️ 注意 iOS 侧认的是 **shellKind()**（= 我在 iOS 壳里），不是 `deviceKindOf()`
//      （那个是"像不像设备"，iPad 上的浏览器也算 device）。闹钟这条路要的
//      是**原生排程能力**；安卓侧则由 `platformKind() === 'android'` 认定
//      （壳往 HTML 里注入的标记 —— 安卓没有 JS 桥，只有 HTTP）。
//
// ===========================================================================
// 三块的数据流（一句话各说清）
//
//   ① 计时器：视图上的开始/暂停/继续/取消 → `adapter/alarms.js` 改
//      `alarms[]` 里那条的 `startedAt`（落库）→ 再发 `alarmTimer` 给壳。
//      剩余时间**每一帧由 core 的 `timerRemainingMs` 现算**（不自己记秒表，
//      那样手机会越走越偏）。
//
//   ② 定时器：表单 → `validateAlarm` 先在本地拦一道（错误码 → 人话）→
//      `store.saveAlarm` 落库 → `pushAlarmSchedule()` 把**整批**重排给壳。
//      整批重排的理由和提醒那条路一样：**"删了还响"比"漏一次"更糟**。
//
//   ③ 铃声：`core/alarms.js` 的目录（打进 App 包的文件名）→ 每条闹钟存一个
//      `sound` id → 排程时翻成 `named("文件名.caf")` 交给壳。
//      ⚠️ 「试听」**直接播 App 包里那个文件**（`new Audio('/alarm-xxx.caf')`）——
//      那些文件就在 **bundle 根**、和 `index.html` 同级，本机 HTTP 服务能取到；
//      条件是**壳的 MIME 表必须有音频类型**（2026-10-01 才补上，之前缺席导致
//      "网页取不到真文件"这个错误结论，于是试听改用合成音，最后真机一听就露馅）。
//      取不到时才回落到合成音型，并**如实弹提示**。
//
//   ④ 诊断：显示 AlarmKit 状态 + 壳报回来的"实际排了哪几条"，
//      外加一个「10 秒后试响」——**这个按钮才是唯一能验证铃声的东西**。
import { el, mount } from '../dom.js';
import { toast } from '../toast.js';
// ⚠️ 改名要用项目自己的弹窗，**不能用 `window.prompt()`** ——
//    原生壳（WKWebView）里它**静默返回 null**（电脑浏览器上一切正常，iPad 上"点了没反应"）。
//    这个坑写在 web/ui/app.js 的 openNaturalAdd 上面，这里照办。
import { openModal } from '../modal.js';
import {
  ALARM_SOUNDS, DEFAULT_SOUND_ID, LEGACY_CUSTOM_SOUND_ID, MAX_SCHEDULED, PHASE_LABEL, REPEAT_LABEL,
  TIMER_PRESETS, alarmPhase, customSoundKey, describeAlarm, describeAlarmCount, describeNextFire,
  describeSchedule, formatCountdown, formatDuration, isCustomSoundId, normalizeAlarm, sortAlarmsForDisplay,
  soundAvailable, soundById, soundLabelOf, staleTimers, summarizeAlarms, timerRemainingMs, validateAlarm,
  weekdaysOf,
} from '../../../core/alarms.js';
import { WEEK_SHORT } from '../../../core/time.js';
import { platformKind, shellKind } from '../../adapter/native.js';
import { alarmKitStatus, requestAlarmAuthorization, refreshAlarmStatus } from '../../adapter/native.js';
// ⚠️ 自定义闹钟铃声（2026-10-01）：壳把它转成 PCM 16bit/44.1k/单声道 .caf 存进
//    App 容器的 Library/Sounds，再用 `AlertSound.named(文件名)` 交给 AlarmKit —— 真机实测能响。
//
// ⚠️ 2026-10-02：**`tier 0` 那个说法已经废了**（以前是"闹钟专用槽"）。
//    现在是**一个列表**：容器里有几首就有几首，每首一个 id（`custom:<token>`），
//    引 `customAlarmSounds()` 拿到 `[{id, name, file}]`。别再引 `CUSTOM_ALARM_TIER` —— 已删。
import { CUSTOM_SOUND_PREFIX, customAlarmSounds, pickCustomSound, dropCustomSound } from '../../adapter/native.js';
import * as store from '../../adapter/store.js';
// `bridge.refreshAlarmSchedule()` = 让壳按最新数据重排（换铃声后要立刻重排，否则在跑的那条还是旧音）
import * as bridge from '../../adapter/alarms.js';

/**
 * 「导入音频…」——让**壳**弹系统文件选择器（网页拿不到文件系统）。
 *
 * 分工与通知那条路一致：壳只负责"转码 + 存进容器 + 回报名单"，
 * "哪条闹钟用哪个铃声"是**业务**，由网页记进每条闹钟自己的 `sound` 字段。
 *
 * ⚠️ 2026-10-02 起**不带 tier**（以前传 `CUSTOM_ALARM_TIER = 0`）：
 *    闹钟铃声现在是一个**列表**，导入 = **加一首**，不再"替换第 0 档"。
 *    那个 `tier 0` 的说法在多首共存之后已经没有意义了。
 */
function importCustomAlarmSound() {
  const ok = pickCustomSound();
  toast({
    title: ok ? '去「文件」里选一段音频' : '这个壳不支持换闹钟铃声',
    body: ok
      ? '选好之后会自动转成系统要的格式（只取前 30 秒），存进 App 自己的目录 —— '
        + '**可以导多首**，想给哪条闹钟配哪首都行'
      : '只有 iOS 原生壳里的闹钟才能用自定义铃声',
    kind: ok ? 'ok' : 'err',
    timeout: ok ? 4600 : 4000,
  });
}

/** 用户给自定义铃声起的名字（`settings.customSoundNames`，键是**不带前缀**的 token） */
function customNames() {
  const st = store.getState() || {};
  return (st.settings && st.settings.customSoundNames) || {};
}

/**
 * 交给 core 的"本机有哪些自定义铃声" + "用户给它们起的名字"。
 *
 * ⚠️ 两样都在这里现取，**不许缓存**：壳随时可能报新名单（导入/删掉一首），
 *    用户也随时可能改名 —— 缓存住的表现是"刚导入的那首没出现""名字改完没变"，
 *    而且**都不报错**（本项目最忌讳的那类失败）。
 */
function customSoundOpts(custom) {
  return { customFile: custom == null ? customAlarmSounds() : custom, customNames: customNames() };
}

/**
 * 给一首自定义铃声改名（2026-10-02，用户原话：「列表名我需要可以自己改」）。
 *
 * ⚠️ 为什么名字要存进**设置**（`settings.customSoundNames`）：它是**用户数据**，
 *    要跟着数据同步走；而**音频文件只在那台设备上**（换台 iPad 还得重新导入）。
 *    所以键是壳给的 token（"哪一首"的身份），值是名字。
 *
 * ⚠️ 名字为空 = **删掉这个名字**（回到显示 token 的样子），不是存一个空串：
 *    空串会让"有没有改过名"这件事变得分不清（`nameOf` 会返回空串，
 *    界面又退回显示 token —— 看起来一样，但设置里多了一条垃圾）。
 */
function renameCustomSound(soundId, ctx) {
  // ⚠️ 用 core 的 `customSoundKey`（**不要**在这里再写一遍剥前缀）：
  //    `custom:` 这个前缀是跨三层的约定，"某处少写一个冒号"的后果是名字静默丢了。
  const key = customSoundKey(soundId);
  if (!key) return;
  const current = customNames()[key] || '';
  const input = el('input', {
    type: 'text',
    placeholder: '例如：起床号 / 竹取飛翔',
    maxlength: '20',
    style: { width: '100%' },
    // 给测试用的把手（这个项目里每处可点的东西都有 `data-role`）
    dataset: { role: 'sound-name' },
    'aria-label': '铃声名字',
  });
  input.value = current;
  let close = () => {};
  const save = () => {
    const v = input.value.trim().slice(0, 20);
    const next = { ...customNames() };
    if (v) next[key] = v; else delete next[key];
    close();
    // ⚠️ `saveSettings` 是**整体替换**顶层键（web/adapter/store.js），所以必须
    //    先把现有那张表摊进来再改一处 —— 直接传 `{ [key]: v }` 会把别人的名字全删了。
    store.saveSettings({ customSoundNames: next });
    toast({
      title: v ? `改好了：${v}` : '名字清掉了',
      body: v ? '这个名字会跟着数据同步到别的设备（音频文件还要在那台设备上重新导入）。' : '列表里会显示它自己的编号。',
      kind: 'ok',
      timeout: 3600,
    });
    // 立刻重画：闹钟列表里显示的那个名字也要跟着变（否则"改完没反应"）
    if (ctx && typeof ctx.refresh === 'function') ctx.refresh();
  };
  const clear = () => { input.value = ''; save(); };
  close = openModal({
    title: '✏️ 给这首铃声起个名字',
    width: 420,
    body: el('div', {}, [
      input,
      el('p.tiny', {
        text: '只改显示名 —— 音频本身、以及哪些闹钟用了它，都不会变。留空就是清掉名字。',
      }),
    ]),
    footer: [
      el('button.btn', { text: '清掉名字', onclick: clear }),
      el('button.btn.btn-primary', { text: '保存', onclick: save }),
    ],
  }).close;
}

/**
 * 铃声选择器里**能选的所有选项**（内置 + 本机的自定义）。
 *
 * ⚠️⚠️ 为什么要有这个函数（2026-10-02 多首共存时抽出来的）：
 *    「有没有文件」这件事以前是界面里的一句 `s.id !== 'custom' || customFile`，
 *    只处理"唯一那一首"。多首之后那种写法会漏掉"某一首没了"这种情况 ——
 *    于是列表里列出一首**文件已经不在**的铃声，用户选了、闹钟到点响系统默认音，
 *    而且**没有任何提示**。这是本项目最忌讳的失败方式，所以判定逻辑收到 core
 *    （`soundAvailable`），界面只负责显示 + 在"当前选中的那首没了"时**明说**。
 *
 * 返回的 `missing` = 当前选中的自定义铃声在本机找不到文件（界面要显眼地报警）。
 */
function soundOptions(current) {
  const custom = customAlarmSounds();
  const opts = customSoundOpts(custom);
  const out = ALARM_SOUNDS
    // 老 id `'custom'` 是"自定义这一类"的入口项 —— 多首之后**它不再单独出现**，
    // 而是由下面那些具体的 `custom:<id>` 取代（否则用户会看到两条一模一样的
    // "自定义（我导入的）"，不知道该选哪条）。老闹钟存的就是老 id，见下面 missing 那段。
    .filter((s) => s.id !== LEGACY_CUSTOM_SOUND_ID)
    .filter((s) => soundAvailable(s.id, opts))
    .map((s) => ({ id: s.id, label: `${s.label} · ${s.desc}` }));
  for (const c of custom) {
    if (!soundAvailable(c.id, opts)) continue;
    out.push({ id: c.id, label: soundLabelOf(c.id, opts) });
  }
  // ⚠️ **当前选中的那个必须出现在选项里**，哪怕它已经不可用。
  //    不这么做的话，浏览器会把下拉框显示成**第一项** —— 用户看到的是"我没选过的铃声"，
  //    于是一次"改个标签"的保存就把他的铃声悄悄换掉了（而且是静默的）。
  const key = String(current == null ? '' : current);
  if (key && !out.some((o) => o.id === key)) {
    const legacy = key === LEGACY_CUSTOM_SOUND_ID;
    const gone = (legacy || isCustomSoundId(key)) && !soundAvailable(key, opts);
    out.unshift({
      id: key,
      label: gone
        ? `${soundLabelOf(legacy ? '' : key, opts) || '自定义'}（⚠️ 这个音频不在这台设备上）`
        : (soundLabelOf(key, opts) || '系统默认音'),
      missing: gone,
    });
  }
  return { options: out, missing: out.some((o) => o.id === key && o.missing) };
}

/** 一条闹钟现在会用哪个铃声（界面上显示用）。找不到文件时**如实说明**，不假装没事 */
function soundTextOf(alarm) {
  const id = String((alarm && alarm.sound) || '');
  const custom = customAlarmSounds();
  const opts = customSoundOpts(custom);
  if (isCustomSoundId(id) || id === LEGACY_CUSTOM_SOUND_ID) {
    // ⚠️ 老 id `'custom'`（多首之前存的）语义就是"第一首"。
    //    有文件时**要说清是哪一首**（否则导了《竹取飛翔》，闹钟那行却还写着
    //    "自定义（我导入的）"，用户认不出自己那首歌）；没文件时必须明说会响默认音。
    //    `soundLabelOf('custom')` 故意只回"自定义" —— 它不能替调用方假装文件还在。
    const label = (id === LEGACY_CUSTOM_SOUND_ID)
      ? (custom.length ? (soundLabelOf(custom[0].id, opts) || '自定义') : '自定义')
      : (soundLabelOf(id, opts) || '自定义');
    return soundAvailable(id, opts) ? label : `${label}（⚠️ 音频不在这台设备上，会响默认音）`;
  }
  const s = soundById(id);
  return s ? s.label : '系统默认音';
}

/** 计时器"上一次用的分钟数"记在这台设备上（不跟着数据走：那是每台设备的习惯） */
const LAST_MIN_KEY = 'timetable.alarms.timerMinutes';
/** 有没有已经提示过"这台设备上没有真闹钟"（只提示一次，不反复烦人） */
const WARNED_KEY = 'timetable.alarms.warnedNotIos';

/**
 * 「上一次操作走到哪一步了」—— **只在内存里，不落盘**，专门给诊断区显示。
 *
 * ⚠️ 为什么需要它（2026-09-30 真机排查加的）：
 *   用户报「计时器/试响按下去没反应、也不进库、诊断区还是 0 条」。而这条链路有
 *   三段各自都可能**静默**失败：① 落库（IndexedDB）② 通知壳（postMessage）
 *   ③ 壳真正排上（AlarmKit）。光看诊断区那六行**分不出是哪一段**。
 *   所以每次"开始倒计时 / 试响"都把这三步的结果记下来，直接写在诊断区里 ——
 *   把"用户描述现象"换成"设备自己报出断点"。
 *   刻意**不落盘**：这是一次性的排查信息，重启 App 清空才是对的。
 */
let lastAttempt = null;

const ATTEMPTS_KEY = 'timetable.alarms.attempts';
const ATTEMPTS_MAX = 8;

function rememberAttempt(kind, fields) {
  lastAttempt = { at: new Date().toISOString(), kind, ...fields };
  // ⚠️ 2026-10-02 起**同时**在这台设备上留一份（最近 8 条，新的在前）。
  //    触发这件事的是用户那句："改名之后过了一阵，闹钟自己冒出来，标题是改名后的名字"。
  //    要判断这句话的唯一关键是 ——「改名之后到底有没有再点过一次「10 秒后试响」」，
  //    而原来的 `lastAttempt` **只在内存里**：用户一刷新页面（壳每次启动都刷新）
  //    这份记录就没了，等于把唯一能回答这个问题的证据销毁掉。
  //    ⚠️ 存不进（隐私模式 / 配额满）就算了：**绝不能因为记日志而让"试响"本身失败**。
  try {
    const line = {
      at: lastAttempt.at,
      kind: String(kind || ''),
      label: String(lastAttempt.label || ''),
      step: String(lastAttempt.step || ''),
    };
    const next = [line, ...timerAttemptHistory()].slice(0, ATTEMPTS_MAX);
    globalThis.localStorage?.setItem(ATTEMPTS_KEY, JSON.stringify(next));
  } catch { /* 记不上不影响功能 */ }
}

/** 诊断区用的那行（没有操作过就返回 null，界面据此不显示） */
export function lastTimerAttempt() {
  return lastAttempt ? { ...lastAttempt } : null;
}

/**
 * 这台设备上最近几次「开始倒计时 / 试响」（**新的在前**）。读不出来就返回 `[]`。
 *
 * ⚠️ 它和 `lastTimerAttempt()` 是**两件事**：那个是"这一次操作走到哪一步"（内存、
 *    刷新即失效），这个是"过去几次都在什么时候发生过"（落盘、跨重启）。诊断区两个都显示。
 */
export function timerAttemptHistory() {
  try {
    const raw = globalThis.localStorage?.getItem(ATTEMPTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x === 'object' && typeof x.at === 'string')
      .map((x) => ({
        at: String(x.at),
        kind: String(x.kind || ''),
        label: String(x.label || ''),
        step: String(x.step || ''),
      }))
      .slice(0, ATTEMPTS_MAX);
  } catch {
    return [];   // 脏数据/读不到：当"没有记录"，绝不让诊断区炸掉
  }
}

/** `2026-10-02T16:31:00.000Z` → 本机的 `16:31`（时区就是设备本机时区） */
function clockOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '');
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * ⚠️ 这是整个板块的**门控**：只有它返回 true，侧栏才会出现「闹钟」。
 *
 * 认的是"我在**原生壳**里"，而不是 `deviceKindOf()`
 * （那个会把"iPad 上打开浏览器"也算成设备）。理由见文件头。
 * 认不出来（null / 抛错）一律当**不允许** —— 不确定就不显示。
 *
 * ⚠️ 2026-10-xx 放宽到安卓（用户要求"闹钟随便整整就行，能加能删能改能响"）：
 *    · iOS 壳：真闹钟走 AlarmKit（见文件头）
 *    · 安卓壳：**走的是另一条完全不同的路** —— 网页照常 POST /api/alarms 落进
 *      安卓自己的 Store，由壳的 `ReminderAlarms`（AlarmManager）到点响。
 *      也就是说安卓上"有没有真闹钟"**不取决于这个门控**，门控只决定入口显不显示。
 *    · 用 `platformKind()`（认壳注入的 `window.__timetablePlatform`）而**不是**
 *      `inShell()`：安卓必须留在 remote 模式，理由见 native.js 里 `platformKind`
 *      上面那段长注释（改错了会让数据和闹钟全部静默失效）。
 */
export function alarmsViewAllowed() {
  try {
    const kind = platformKind();
    return kind === 'ios' || kind === 'android';
  } catch {
    return false;   // 没有原生桥的宿主：按"不允许"处理
  }
}

export const alarmsView = {
  id: 'alarms',
  label: '闹钟',
  icon: '⏰',

  title() { return '闹钟'; },

  subtitle(state) {
    // ⚠️ 这一行以前是 `共 N 条，开着 M 条`，两个数都是**数出来的假话**：
    //    · 跑完的计时器 `enabled` 还是 true → 被算进"开着"（实际它什么都不剩）；
    //    · 于是出现过"共 12 条，开着 12 条"，而列表里只有 1 行（下面那条幽灵记录）。
    //    现在一律走 core 的 `describeAlarmCount()` —— 计数与列表**同一份算法**。
    return describeAlarmCount(state.alarms);
  },

  nav() { return []; },

  render(state, ctx, host) {
    // ⚠️ 门控**在 render 里也要再判一次**（不只是侧栏）。
    //    侧栏是"看不看得见"，这里是"能不能直接进" —— 快捷键、深链、
    //    或者上一次留下的 state.view='alarms' 都可能绕过侧栏直接进来。
    if (!alarmsViewAllowed()) {
      return void mount(host, el('div.empty', {}, [
        el('div.empty-ico', { text: '⏰' }),
        el('h3', { text: '闹钟只在 iPhone / iPad / 安卓 App 里能用' }),
        el('p.tiny', {
          // ⚠️ 安卓上**不能说"是 iOS 26 起才有的能力"** —— 那是另一条实现路线，
          //    照搬 iOS 的话术会让安卓用户以为这台设备根本没有闹钟。
          text: platformKind() === 'android'
            ? '本机的闹钟由**安卓系统闹钟排程**（AlarmManager）：到点会发通知、放你选的铃声，'
              + '不依赖界面是否开着。但浏览器里做不到这件事（关掉标签页就没人叫你了），'
              + '所以在电脑浏览器上不显示入口。'
            : '真闹钟（满音量、无视静音、锁屏全屏）是 iOS 26 起才开放的系统能力，'
              + '而且必须由 App 本体调用 —— 浏览器和电脑上做不到。'
              + '所以在这些地方**不显示入口**，免得你设了一个不会响的闹钟。',
        }),
      ]));
    }

    const alarms = Array.isArray(state.alarms) ? state.alarms : [];
    // ⚠️ 这里**故意只分出一个 `timers`**（给大字计时器那段用）：
    //    "定时器"那一份不再单独切出来了 —— 它们已经在「全部闹钟」里，而**两处各切一份**
    //    正是上一版"计数 12 条、列表 1 行"的成因（切出来的那份没人画）。
    //    要数它们用 `summarizeAlarms()`，要和它们一起画用 `sortAlarmsForDisplay()`，
    //    两处都从**同一个数组**出发，所以不可能再对不上。
    const timers = alarms.filter((a) => a && a.kind === 'timer');

    mount(host, el('div.alarms-page', {}, [
      // ⚠️ 顺序是**用户视角**排的（2026-10-02 用户 m03912"我需要一个显示已创建闹钟的地方"）：
      //    ① 全部闹钟**在最上面** —— 打开这一页第一眼要看到"我到底建了哪些"，
      //       而不是先看到一排新增控件（以前正是这样：计数说 12 条，
      //       屏幕上却只有 1 行，用户找不到另外 11 条）。
      //    ② 计时器大字（正在跑的那个）
      //    ③ 定时器表单（加一条 / 改一条）
      //    ④ 铃声 ⑤ 诊断
      blockAll(alarms, ctx),
      blockTimer(timers, ctx),
      blockClocks(ctx),
      blockSounds(ctx),
      blockDiag(alarms),
      footNote(),
    ]));
  },
};

// ---------------------------------------------------------------------------
// ① 计时器
// ---------------------------------------------------------------------------

/** 当前哪一个计时器在跑（同时只允许一个 —— 见下面"为什么"） */
function runningTimer(timers) {
  return timers.find((a) => a && a.enabled && timerRemainingMs(a) > 0) || null;
}

/**
 * ⚠️ 为什么**同时只允许一个**计时器在跑：
 *   两个倒计时一起响的时候，"哪一声是哪件事"就说不清了（而闹钟的用处正是
 *   "我知道这是哪件事"）。而且系统侧每条闹钟都占一个 Live Activity。
 *   要两个就设两个定时器（固定时刻），那个天然不会撞。
 */
function blockTimer(timers, ctx) {
  const running = runningTimer(timers);
  const lastMin = Number(globalThis.localStorage?.getItem(LAST_MIN_KEY)) || 5;

  const big = el('div.al-timer-big', {
    text: running ? formatCountdown(timerRemainingMs(running)) : formatCountdown(lastMin * 60_000),
    dataset: { role: 'al-timer-display' },
  });
  const sub = el('div.al-timer-sub', {
    text: running
      ? (running.paused === true ? '已暂停 · ' : '') + `「${running.label || '计时器'}」还剩 ${formatCountdown(timerRemainingMs(running))}`
      : `准备就绪 · ${formatDuration(lastMin * 60_000)}`,
    dataset: { role: 'al-timer-sub' },
  });

  const quick = el('div.al-quick', {}, TIMER_PRESETS.map((min) => el('button.btn.btn-sm', {
    type: 'button',
    text: `${min} 分钟`,
    dataset: { preset: String(min) },
    onclick: () => startTimerMinutes(min, ctx),
  })));

  const custom = el('input.al-input', {
    type: 'number', min: '1', max: '1440', step: '1',
    value: String(lastMin),
    dataset: { role: 'al-timer-minutes' },
    'aria-label': '自定义分钟数',
  });
  const customBtn = el('button.btn.btn-sm', {
    type: 'button',
    text: '自定义开始',
    onclick: () => {
      const min = Number(custom.value);
      if (!Number.isFinite(min) || min <= 0) {
        return void toast({ title: '分钟数不对', body: '👉 填 1–1440 之间的整数', kind: 'err' });
      }
      startTimerMinutes(min, ctx);
    },
  });

  const controls = runnerControls(running, ctx);

  return section('计时器', isAndroidShell()
    // ⚠️ 安卓上倒计时**还没接**（壳目前只按"固定时刻的闹钟"排，不认计时器）。
    //    这里如实说，不能让用户以为按了就会响。
    ? '倒计时。⚠️ 安卓上倒计时暂时不会响（壳只排固定时刻的闹钟）—— 请用下面的「定时器」。'
    : '倒计时。到点由系统闹钟响（满音量、无视静音）。', [
    big, sub,
    el('div.al-row', {}, [quick, el('div.al-row', {}, [custom, customBtn])]),
    controls,
  ]);
}

function runnerControls(running, ctx) {
  if (!running) return el('div.al-row', {}, []);
  const cur = () => store.alarmById(running.id) || running;
  // ⚠️ "暂停"和"没开始"必须是两种可区分的状态，否则界面没法显示"暂停在 12:34"：
  //    · `left === null`  → 从来没开始过（按钮只有「开始」）
  //    · `left > 0` 且 startedAt 是过去 → 在跑
  //    · 暂停态 → 也是"还剩 left"，但**壳那边已经撤了**（见 bridge.pauseTimer）
  //    这里用"这条在跑吗"来决定显示哪组按钮：跑着 → 暂停/取消；否则 → 继续/取消。
  const left = timerRemainingMs(cur());
  const started = Boolean(normalizeAlarm(cur()).startedAt);
  const paused = normalizeAlarm(cur()).paused === true;
  if (!started || left === null || left <= 0) {
    return el('div.al-row', {}, [
      el('button.btn.btn-sm', {
        type: 'button', text: '✕ 清掉这个计时器',
        onclick: () => runTimerAction(() => bridge.cancelTimer(cur()), ctx),
      }),
    ]);
  }
  return el('div.al-row', {}, [
    paused
      // ⚠️ 暂停时**不显示**「暂停」（那是"已经做了"的状态），只显示继续/取消。
      //    按钮上给"已经暂停"的提示，靠大字下面的副标题（见 blockTimer）。
      ? el('span.al-hint', { text: '已暂停', dataset: { role: 'al-paused' } })
      : el('button.btn.btn-sm', {
        type: 'button', text: '⏸ 暂停',
        onclick: () => runTimerAction(() => bridge.pauseTimer(cur()), ctx),
      }),
    el('button.btn.btn-sm.btn-primary', {
      type: 'button', text: '▶ 继续',
      onclick: () => runTimerAction(() => bridge.resumeTimer(cur()), ctx),
    }),
    el('button.btn.btn-sm', {
      type: 'button', text: '✕ 取消',
      onclick: () => runTimerAction(() => bridge.cancelTimer(cur()), ctx),
    }),
  ]);
}

/**
 * 计时器 / 试响的**同一套流程**：① 落库 → ② 通知壳 → ③ 壳的回报（异步）。
 *
 * ⚠️ 每一步都写进 `rememberAttempt`，出问题时光看诊断区就能知道断在哪一段
 *    （见 `lastAttempt` 那段注释说明的三种静默失败）。
 */
async function runTimerFlow({ label, run, ctx }) {
  const started = Date.now();
  let r;
  try {
    r = await run();
  } catch (err) {
    const code = (err && (err.code || err.status)) || '（无错误码）';
    rememberAttempt('timer', {
      label, step: '落库/调用失败', detail: `${code} ${String((err && err.message) || err)}`,
      sent: false, saved: null, ms: Date.now() - started,
    });
    showAlarmError(err, label);
    if (ctx && typeof ctx.refresh === 'function') ctx.refresh();
    return;
  }

  // ⚠️ 两个真实返回形状（见 web/adapter/alarms.js）：
  //    startTimer → `{ alarm, sent }` ｜ testAlarmSound → `{ sent, file, seconds }`
  //    下面按"有没有 alarm 字段"分别读出"有没有落库"。
  const sent = !!(r && r.sent);
  const hasAlarm = !!(r && r.alarm);
  const saved = hasAlarm ? store.getState().alarms.length : null;
  // ⚠️ 安卓上 `sent` 恒为 false 是**预期**（壳没有 JS 桥，排程由壳自己按库里的数据做，
  //    见 android/.../ReminderAlarms.kt）。所以文案要分开，不能对它说"没有原生桥？"
  //    —— 那会让用户以为闹钟没设上。定时器（倒计时）那条路安卓确实还没接，
  //    这一点必须**如实说**，不能假装会响。
  const android = isAndroidShell();

  rememberAttempt('timer', {
    label,
    step: android
      ? (hasAlarm ? '已落库（安卓由壳自己排到点通知）' : '落库完成（试响在安卓上不可用）')
      : (sent ? '已通知壳（等回报）' : '没能通知壳'),
    detail: android
      ? (hasAlarm
        ? '内容已写进本机库；安卓壳会按库里的闹钟重排系统闹钟，到点发通知并放你选的铃声。'
        : '「试响」是发给 iOS 壳的消息，安卓壳没有这条通道 —— 这一步在安卓上不会响。')
      : (sent
        ? 'postMessage 已发出；壳排上之后会回报，届时"交给系统"那一行会变'
        : 'postToShell 返回 false（这台设备没有原生桥？）'),
    sent, saved, file: (r && r.file) || null, ms: Date.now() - started,
  });

  if (android) {
    if (hasAlarm) {
      toast({ title: label, body: '已保存。⚠️ 倒计时（计时器）这条在安卓上暂时不会自己响 —— 定时器到点会响。', timeout: 6000 });
    } else {
      toast({
        title: '安卓上「试响」用不了',
        body: '👉 那是发给 iOS 壳的消息，安卓壳没有这条通道。'
          + '要确认真会响，设一条 1~2 分钟后的定时器等它响即可。',
        kind: 'err', timeout: 8000,
      });
    }
    if (ctx && typeof ctx.refresh === 'function') ctx.refresh();
    return;
  }

  if (!sent) {
    toast({
      title: '没能交给系统',
      body: '👉 这台设备上拿不到真闹钟（不是 iOS App，或没授权）。它不会响。',
      kind: 'err', timeout: 7000,
    });
  } else {
    toast({ title: label, body: hasAlarm ? '到点会响满音量的闹钟' : '10 秒后用真闹钟通道试响', timeout: 2000 });
  }
  if (ctx && typeof ctx.refresh === 'function') ctx.refresh();
}

/** 计时器：N 分钟后响 */
async function startTimerMinutes(minutes, ctx) {
  try {
    globalThis.localStorage?.setItem(LAST_MIN_KEY, String(minutes));
  } catch { /* localStorage 不可用不影响主流程 */ }

  await runTimerFlow({
    label: `${minutes} 分钟开始`,
    ctx,
    // ⚠️ 顺序由适配器保证：**先落库、再通知壳**（见 adapter 里 startTimer 的注释）
    run: () => bridge.startTimer({ minutes }),
  });
}

async function runTimerAction(fn, ctx) {
  try {
    const r = await fn();
    if (r && r.reason) toast({ title: '没做成', body: r.reason, kind: 'err' });
    ctx.refresh();
  } catch (err) {
    showAlarmError(err, '操作计时器');
  }
}

// ---------------------------------------------------------------------------
// ② 定时器（闹钟）
// ---------------------------------------------------------------------------

/** 表单里正在编辑的那条（在模块级记一下：视图每次重画不该把用户填的东西冲掉） */
let form = null;

function blankForm(now = new Date()) {
  const t = new Date(now.getTime() + 5 * 60_000);
  return {
    id: null,
    atHour: t.getHours(),
    atMinute: t.getMinutes(),
    repeat: 'once',
    weekdays: [],
    label: '',
    sound: DEFAULT_SOUND_ID,
  };
}

function blockClocks(ctx) {
  if (!form) form = blankForm();
  const f = form;
  // 铃声选项**每次重画现算**：壳可能刚报来新名单（导入/删掉一首），缓存住就会慢一拍
  const soundOpts = soundOptions(f.sound);

  const hourInput = el('input.al-input.al-input-sm', {
    type: 'number', min: '0', max: '23', value: String(f.atHour),
    dataset: { role: 'al-hour' }, 'aria-label': '小时',
  });
  const minInput = el('input.al-input.al-input-sm', {
    type: 'number', min: '0', max: '59', value: String(f.atMinute),
    dataset: { role: 'al-minute' }, 'aria-label': '分钟',
  });

  const repeatSel = el('select.al-input', { dataset: { role: 'al-repeat' }, 'aria-label': '重复方式' },
    ['once', 'daily', 'weekdays', 'custom'].map((r) => el('option', {
      value: r, text: REPEAT_LABEL[r], selected: f.repeat === r,
    })));

  const weekdayBox = el('div.al-weekdays', { dataset: { role: 'al-weekdays' } },
    // ⚠️ 顺序按"周一到周日"排（`WEEK_SHORT` 是周日开头的，这里重新排 ——
    //    中文用户勾工作日时看的是"一二三四五"，不是"日一二三四五六"）
    [1, 2, 3, 4, 5, 6, 0].map((d) => el('button.btn.btn-sm' + (f.weekdays.includes(d) ? '.btn-primary' : ''), {
      type: 'button',
      text: WEEK_SHORT[d],
      dataset: { weekday: String(d) },
      onclick: () => {
        const has = form.weekdays.includes(d);
        form.weekdays = has ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d].sort();
        ctx.refresh();
      },
    })));

  const labelInput = el('input.al-input', {
    type: 'text', maxlength: '24', value: f.label, placeholder: '标签（例如：起床 / 吃药）',
    dataset: { role: 'al-label' }, 'aria-label': '标签',
  });

  const soundSel = el('select.al-input', { dataset: { role: 'al-sound' }, 'aria-label': '铃声' },
    soundOpts.options.map((o) => el('option', {
      value: o.id, text: o.label, selected: f.sound === o.id, disabled: o.missing === true,
    })));

  return section('定时器（闹钟）',
    f.id ? '正在改这一条 —— 改完按「保存修改」。（要改另一条，去上面「全部闹钟」里点它）'
      : '固定时刻 + 重复。加完的都会出现在上面「全部闹钟」里，随时能改能删。',
    [
      el('div.al-row', {}, [
        el('div.al-field', {}, [el('label.al-lbl', { text: '时刻' }),
          el('div.al-row', {}, [hourInput, el('span.al-colon', { text: ':' }), minInput])]),
        el('div.al-field', {}, [el('label.al-lbl', { text: '重复' }), repeatSel]),
      ]),
      f.repeat === 'custom'
        ? el('div.al-field', {}, [el('label.al-lbl', { text: '选星期（可多选）' }), weekdayBox])
        : null,
      el('div.al-row', {}, [
        el('div.al-field.al-grow', {}, [el('label.al-lbl', { text: '标签' }), labelInput]),
        el('div.al-field.al-grow', {}, [el('label.al-lbl', { text: '铃声' }), soundSel]),
      ]),
      // ⚠️ 选中一首**本机没有**的铃声时必须明说，并且**不许保存**：
      //    存下来只会在到点时静默响系统默认音（iOS 找不到文件不报错），
      //    用户下次打开还以为"我设的那个铃声好好的"。
      soundOpts.missing
        ? el('p.tiny.al-warn', {
          text: '⚠️ 这条闹钟原先用的那个自定义音频**不在这台设备上**'
            + '（自定义音频不会跟着设置同步，只存在导入它的那台设备里）。'
            + '换一个铃声，或在这台设备上重新导入它。',
        })
        : null,
      el('div.al-row', {}, [
        el('button.btn.btn-sm.btn-primary', {
          type: 'button', text: f.id ? '保存修改' : '＋ 加一条闹钟',
          disabled: soundOpts.missing,
          onclick: () => saveForm(ctx, { hourInput, minInput, repeatSel, labelInput, soundSel }),
        }),
        f.id
          ? el('button.btn.btn-sm', { type: 'button', text: '取消编辑', onclick: () => { form = blankForm(); ctx.refresh(); } })
          : null,
      ]),
      // ⚠️ 这里**不再画一遍列表**（2026-10-02）：列表搬到上面「全部闹钟」那一块。
      //    两份列表的坏处不只是重复 —— 计时器那条路只画"正在跑的"，
      //    于是两份列表的条数天生不一样，那个差值就是用户看到的
      //    "共 12 条却只有 1 行"。**一套数据只画一次**。
    ], { dataset: { role: 'al-clock-form' } });
}

// ---------------------------------------------------------------------------
// ⓪ 全部闹钟：一个地方看到**每一条**已创建的闹钟（2026-10-02 用户 m03912
//    「我需要一个显示已创建闹钟的地方，同时我要可删改」）
// ---------------------------------------------------------------------------
//
// ⚠️ 这一块存在的真正理由（不是"再摆一遍列表"）：
//   改之前，这一页的标题写着"共 12 条，开着 12 条"，屏幕上却只有 1 行 ——
//   因为计时器那一段**只画正在跑的那一条**，而跑完的计时器 `enabled` 仍是 true，
//   于是它们**既数得进去、又画不出来**：看不见 = 删不掉。用户点一次
//   「5 分钟开始」就多一条这样的幽灵记录（`startTimer` 每次都新建一条，只增不减）。
//   修法就一句：**每一条都画出来，每条自带 改 / 开关 / 删**。
//
// ⚠️ 这一块**只画状态、不自己发请求**：动作全部走既有那两条路
//   （改 → 上面的表单；开关/删 → `store.*` + `bridge.pushAlarmSchedule()` 整批重排）。
function blockAll(alarms, ctx) {
  const list = sortAlarmsForDisplay(alarms);
  const stale = staleTimers(alarms);
  const sum = summarizeAlarms(alarms);

  return section(
    '全部闹钟',
    '这里是**每一条**（含已经跑完的计时器）。点一行、或按「改」，就能改它；右边是开关和删除。',
    [
      el('div.al-row', { style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
        el('div.al-summary', { text: describeAlarmCount(alarms), dataset: { role: 'al-all-summary' } }),
        el('button.btn.btn-sm', {
          type: 'button',
          text: stale.length ? `清掉已结束的计时器（${stale.length}）` : '没有要清的计时器',
          // ⚠️ 没得清时**禁用**而不是隐藏：隐藏会让"这里应该有个清理按钮"这件事
          //    在下一次需要它的时候（跑完一条之后）重新变成一次惊喜。
          disabled: stale.length === 0,
          dataset: { role: 'al-clean-timers' },
          onclick: () => cleanStaleTimers(stale, ctx),
        }),
      ]),
      // 为什么要专门说一句"只删计时器"：用户最怕的是"我按了个清理，把我的班表删了"。
      // 这句话就是那条边界，而且它和 `staleTimers()` 的实现**必须一致**（测试钉着）。
      el('p.tiny', {
        text: '「清掉已结束的计时器」只删**计时器**里已经跑完（或从没开始过）的那些；'
          + '定时器（闹钟）一条都不会动 —— 它们是你排的班，只有你自己能删。',
      }),
      list.length
        ? el('div.al-list', { dataset: { role: 'al-all-list' } }, list.map((a) => alarmRow(a, ctx)))
        : el('p.tiny', { text: '还没有闹钟。用下面的表单加一条，或用上面的「计时器」开始一个倒计时。' }),
      sum.timersStale
        ? el('p.tiny.al-warn', {
          text: `⚠️ 有 ${sum.timersStale} 条计时器已经跑完 —— 它们永远不会再响，`
            + '但一直占着记录（以前它们连显示都不显示，所以你删不掉）。'
            + '按上面的按钮一次清干净。',
        })
        : null,
    ],
    { dataset: { role: 'al-all' } },
  );
}

/**
 * 列表里的一行。**两种 kind 共用一行**（定时器 / 计时器）。
 *
 * ⚠️ 为什么计时器也要在这里出现（而不是"计时器有自己的那一段"）：
 *   有自己那一段的结果就是上面注释里那个 bug —— 那一段只画"正在跑的"。
 *   共用一行之后，"库里有几条"与"屏幕上几行"**天生相等**，再也对不上不了。
 *
 * ⚠️ 计时器**不给开关**：`enabled` 对"已经跑完的倒计时"没有意义
 *   （再打开它也不会响 —— 它是"倒计时结束"这个动作留下的记录）。
 *   给一个看起来能用、其实没用的开关，就是在制造下一个"我明明开了它却没响"。
 */
function alarmRow(a, ctx) {
  const phase = alarmPhase(a);
  const enabled = a.enabled !== false;
  const dim = phase === 'off' || phase === 'ended';
  const isTimer = a.kind === 'timer';
  // 动作前再取一次最新那条：列表可能是上一帧画的，而这一帧里它已经被别的按钮改过
  const cur = () => store.alarmById(a.id) || a;

  const hm = `${String(a.atHour).padStart(2, '0')}:${String(a.atMinute).padStart(2, '0')}`;
  const title = isTimer
    ? `计时器　${formatDuration(a.durationMs)}${a.label ? `　${a.label}` : ''}`
    : `${hm}${a.label ? `　${a.label}` : ''}`;
  // ⚠️ 副标题里那句"铃声"必须按**这一条**算（`soundTextOf` 里已经处理了
  //    "这首自定义音频不在这台设备上"）—— 见那个函数的注释。
  const sub = isTimer
    ? `${PHASE_LABEL[phase]}${phase === 'running' ? ` · 还剩 ${formatCountdown(timerRemainingMs(a))}` : ''} · ${soundTextOf(a)}`
    : `${describeNextFire(a)} · ${soundTextOf(a)}`;

  return el('div.al-item' + (dim ? '.is-off' : ''), {
    dataset: { role: 'al-row', alarmId: a.id, kind: a.kind, phase },
  }, [
    el('div.al-item-main', { onclick: () => editAlarm(cur(), ctx) }, [
      el('div.al-item-title', {}, [
        el('span', { text: title }),
        el('span.al-badge' + (dim ? '' : '.on'), {
          text: PHASE_LABEL[phase] || '',
          dataset: { role: 'al-phase' },
        }),
      ]),
      el('div.al-item-sub', { text: sub }),
    ]),
    el('button.btn.btn-sm', {
      type: 'button', text: '✏️ 改',
      'aria-label': `改这条${isTimer ? '计时器' : '闹钟'}`,
      dataset: { role: 'al-edit', alarmId: a.id },
      onclick: (e) => { e.stopPropagation(); editAlarm(cur(), ctx); },
    }),
    isTimer ? null : el('button.al-switch' + (enabled ? '.on' : ''), {
      type: 'button',
      text: enabled ? '开' : '关',
      'aria-label': enabled ? '关掉这条闹钟' : '打开这条闹钟',
      dataset: { role: 'al-toggle', alarmId: a.id },
      onclick: async (e) => {
        e.stopPropagation();
        try {
          await store.toggleAlarm(a.id, !enabled);
          // ⚠️ 开关之后**必须重排**：关掉的不撤，它明天照样响；
          //    打开的没排，它永远不会响。这正是"开关看起来没生效"的成因。
          bridge.pushAlarmSchedule();
          ctx.refresh();
        } catch (err) { showAlarmError(err, '开关闹钟'); }
      },
    }),
    el('button.btn.btn-sm.btn-danger', {
      type: 'button', text: '删', 'aria-label': '删除这条闹钟',
      dataset: { role: 'al-delete', alarmId: a.id },
      onclick: (e) => { e.stopPropagation(); void removeAlarm(cur(), ctx); },
    }),
  ]);
}

/** 「改」——定时器的"改"是**载入上面的表单**（和点一行同一个动作） */
function editAlarm(a, ctx) {
  if (!a) return;
  if (a.kind === 'timer') return void editTimer(a, ctx);
  form = {
    id: a.id, atHour: a.atHour, atMinute: a.atMinute,
    repeat: a.repeat, weekdays: weekdaysOf(a),
    label: a.label, sound: a.sound,
  };
  toast({
    title: '已经载入到下面的表单',
    body: `正在改 ${describeAlarm(a)}　👉 改完按「保存修改」`,
    timeout: 3000,
  });
  ctx.refresh();
  scrollToForm();
}

/**
 * 载入表单之后滚到它那里。
 *
 * ⚠️ `ctx.refresh()` 之后 DOM 是**下一帧**才换的（app.js 那边异步重画），
 *   所以这里必须等一帧再找元素 —— 立刻找的话找到的是旧节点，滚动条会跳回去。
 * ⚠️ 这只是"方便"，不是功能：找不到元素、或宿主没有 rAF，都**不许抛错**
 *   （老代码里一个 scrollIntoView 抛错就会让整次点击看起来"没反应"）。
 */
function scrollToForm() {
  const jump = () => {
    try {
      const node = document.querySelector('[data-role="al-clock-form"]');
      if (node && typeof node.scrollIntoView === 'function') {
        node.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    } catch { /* 滚不动就算了 */ }
  };
  try {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(jump));
    } else {
      globalThis.setTimeout(jump, 0);
    }
  } catch { /* 没有 rAF 也没有 setTimeout 的宿主：不管 */ }
}

/**
 * 计时器的「改」：改分钟数 = 按新时长**重新开始**。
 *
 * ⚠️ 为什么不做"改成 8 分钟但接着现在的进度"：那需要区分"剩余时间"和"总时长"
 *   两个概念，而库里只存 `durationMs` 与 `startedAt` 两个字段（暂停就是靠挪
 *   `startedAt` 实现的，见 `pauseTimer`）。凭空加一个"半程改时长"的语义，
 *   最可能的结果是"暂停过的计时器改完时间算错" —— 那比"重新开始"难查得多。
 *   所以按钮上就直说：**按新时长重新开始**。
 */
function editTimer(a, ctx) {
  const cur = normalizeAlarm(a);
  const minutes = Math.max(1, Math.round(cur.durationMs / 60_000));
  const input = el('input.al-input', {
    type: 'number', min: '1', max: '1440', step: '1', value: String(minutes),
    dataset: { role: 'al-timer-edit-minutes' }, 'aria-label': '计时器分钟数',
  });

  const modal = openModal({
    title: '✏️ 改这个计时器',
    width: 420,
    body: el('div', {}, [
      el('label.al-lbl', { text: '倒计时多少分钟（1–1440）' }),
      input,
      el('p.tiny', {
        text: `现在这个：${formatDuration(cur.durationMs)}。`
          + '改完是按**新时长重新开始**倒数（没有"改成 8 分钟、接着现在的进度"这种操作）。',
      }),
    ]),
    footer: [
      el('button.btn.btn-sm.btn-danger', {
        type: 'button', text: '删掉这个计时器',
        onclick: () => { modal.close(); void removeAlarm(cur, ctx); },
      }),
      el('button.btn.btn-primary', {
        type: 'button', text: '按新时长重新开始',
        onclick: () => { void saveTimerEdit(cur, input, modal, ctx); },
      }),
    ],
  });
}

async function saveTimerEdit(cur, input, modal, ctx) {
  const min = Number(input.value);
  if (!Number.isFinite(min) || min <= 0 || min > 1440) {
    return void toast({ title: '分钟数不对', body: '👉 填 1–1440 之间的整数', kind: 'err' });
  }
  modal.close();
  await runTimerAction(async () => {
    // ⚠️ 两步的顺序不能换：先把新时长落库，再拿**落库后的那条**去开始。
    //    反过来（先开始再落库）会出现"壳按新时长在跑、库里还是旧时长"，
    //    那一刻界面上的剩余时间是按旧时长算的 —— 看着就是"改了没用"。
    const saved = await store.saveAlarm({
      ...cur,
      durationMs: Math.round(min * 60_000),
      enabled: true,
      paused: false,
    });
    // ⚠️ `startTimer({alarm})` 会用 `alarm.durationMs`（新时长），不再用 minutes。
    return bridge.startTimer({ alarm: saved || cur, minutes: min });
  }, ctx);
}

/**
 * 删一条。**失败必须照实报**（这条路上没有离线队列，见 store.saveAlarm 上面那段）。
 *
 * ⚠️ 顺带把"正在编辑的那条"清掉：用户删的正是表单里那条时，表单还留着它的 id，
 *   按「保存修改」会把它**又存回来** —— 那看起来就是"删了又自己回来了"。
 */
async function removeAlarm(a, ctx) {
  if (!a) return false;
  try {
    await store.deleteAlarm(a.id);
  } catch (err) {
    showAlarmError(err, '删除闹钟');
    return false;
  }
  if (form && form.id === a.id) form = blankForm();
  // 删完也要重排：**不重排的话系统里那条照样会响**（"删了还响"是本项目最忌讳的失败）
  bridge.pushAlarmSchedule();
  toast({ title: '已删除', body: describeAlarm(a), timeout: 2500 });
  ctx.refresh();
  return true;
}

/**
 * 一次清掉所有"已经跑完的计时器"。
 *
 * ⚠️ 逐条删、**一条失败不影响其余的**：删除走的是服务端（没有离线队列），
 *   一条网络抖动就把剩下的跳掉，用户会以为"这个按钮只删了一条"。
 *   失败的条数与第一条原因**照实报出来**，别静默。
 */
async function cleanStaleTimers(list, ctx) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return;
  let done = 0;
  const failed = [];
  for (const a of items) {
    try {
      // ⚠️ 逐条 `await`（不是 `Promise.all`）：一次几十个并发请求会被服务端拒，
      //    而且失败时说不清是哪一条 —— 而这里的失败是要报给用户看的。
      await store.deleteAlarm(a.id);
      done += 1;
    } catch (err) {
      failed.push(`${describeAlarm(a)}：${(err && err.message) || err}`);
    }
  }
  try { bridge.pushAlarmSchedule(); } catch { /* 重排失败不该盖住"已经删掉了"这件事 */ }
  toast({
    title: done ? `清掉 ${done} 条计时器` : '一条都没清掉',
    body: failed.length
      ? `${failed.length} 条没删掉（第一条：${failed[0]}）　👉 稍后再按一次`
      : '定时器一条都没动 —— 它们是你排的班。',
    kind: failed.length ? 'err' : 'ok',
    timeout: failed.length ? 7000 : 2600,
  });
  ctx.refresh();
}

async function saveForm(ctx, inputs) {
  const draft = {
    id: form.id,
    kind: 'clock',
    atHour: Number(inputs.hourInput.value),
    atMinute: Number(inputs.minInput.value),
    repeat: inputs.repeatSel.value,
    weekdays: form.weekdays,
    label: inputs.labelInput.value,
    sound: inputs.soundSel.value,
  };

  // ⚠️ 先本地校验（core 那份），只有通过了才发请求。
  //    这样"填错"是**立刻、在字段旁边**知道的，而不是等一个来回再弹 toast。
  const check = validateAlarm(draft);
  if (!check.ok) {
    return void toast({
      title: '这条闹钟还差一点',
      body: check.errors.map((e) => e.message).join('；') + '　👉 改一下再保存',
      kind: 'err', timeout: 6000,
    });
  }

  try {
    const saved = await store.saveAlarm(draft);
    // ⚠️ 存完**立刻整批重排**给壳。不重排的话：
    //    新加的这条永远不会响（系统那边压根不知道它），
    //    而界面看起来"加好了" —— 这是本板块最危险的静默失败。
    const r = bridge.pushAlarmSchedule();
    form = blankForm();
    // ⚠️ 安卓上 `sent` 恒为 false（没有 JS 桥，壳自己按库里的数据排）——
    //    照抄 iOS 那句话等于每次都告诉用户"没能交给系统，它可能不会响"，
    //    而实际上是排上了。所以按平台分开说，且安卓上**不要**把它标成错误。
    const android = isAndroidShell();
    toast({
      title: '已保存',
      body: android
        ? '✅ 已写进本机库，安卓壳会自动重排系统闹钟 —— 到点会发通知并放你选的铃声。'
        : ((r && r.sent)
          ? `已交给系统：${r.count}/${r.total} 条（按时间最近的前 ${MAX_SCHEDULED} 条）`
          : '⚠️ 但没能交给系统排程（见下面「诊断」），它可能不会响'),
      kind: android || (r && r.sent) ? 'ok' : 'err',
      timeout: android || (r && r.sent) ? 2600 : 7000,
    });
    void saved;
    ctx.refresh();
  } catch (err) {
    showAlarmError(err, '保存闹钟');
  }
}

// ---------------------------------------------------------------------------
// ③ 铃声
// ---------------------------------------------------------------------------

function blockSounds(ctx) {
  // ⚠️ 2026-10-01：**「自定义」那一类只在真的导入过音频之后才显示**。
  //    没导入就显示它，用户选了会静默放系统默认音 —— 那正是本项目最讨厌的静默失败。
  //
  // ⚠️ 2026-10-02 多首共存：`custom` 不再是一"档"，而是**一串**（`customAlarmSounds()`）。
  //    这里为每一首单独画一张卡片（试听 / 试响 / 删掉），并给"导入"正名：
  //    它现在是**加一首**，不再是"换掉唯一那首"。
  const custom = customAlarmSounds();
  const opts = customSoundOpts(custom);
  const builtins = ALARM_SOUNDS.filter((s) => s.id !== LEGACY_CUSTOM_SOUND_ID);
  return section('铃声', null, [
    // ⚠️ 2026-10-01 改写：以前这里写着"系统限制只能放打进 App 包里的音频，
    //    暂不支持从「文件」里自选"—— **那句现在是错的**。
    //    真机实测（同一天）：用户导入的音频放进 App 容器的 `Library/Sounds`，
    //    AlarmKit 的 `AlertSound.named()` **真的能读到并响出来**。
    //    所以这条路做成了正门功能 —— 留给以后一个提醒：**别再把"没试过"写成"系统限制"**。
    el('p.tiny', {
      text: '铃声可以是 **App 内置的**，也可以是**你自己导入的**（从「文件」里选，'
        + '30 秒以内，App 会自动截取开头并转成系统要的格式）。'
        + (custom.length
          ? `你自己导入的有 **${custom.length} 首**，每首都能单独给某条闹钟用。`
          : '还没导入过 —— 点下面的「导入音频…」选一段。'),
    }),
    el('div.al-row', { style: { gap: '8px', flexWrap: 'wrap' } }, [
      el('button.btn.btn-sm', {
        type: 'button',
        // ⚠️ 文案从"换一段音频…"改成"加一首…"（2026-10-02）：
        //    旧文案在多首之后是**错的** —— 现在导入不会顶掉任何已有的一首。
        text: custom.length ? '＋ 再加一首…' : '导入音频…',
        dataset: { role: 'al-import-sound' },
        title: '从系统「文件」里选一段音频（wav / m4a / mp3 / aac 都行）—— 可以导多首',
        onclick: () => importCustomAlarmSound(),
      }),
    ]),
    // 用户导入的那些：一首一张卡片，**能在右下角独立删掉**
    custom.length
      ? el('div.al-sounds', {}, custom.map((c) => el('div.al-sound', {}, [
        el('div.al-sound-main', {}, [
          el('div.al-item-title', { text: soundLabelOf(c.id, opts) }),
          el('div.al-item-sub', {
            text: '你自己导入的（存在这台设备上，不会跟着数据同步）',
          }),
        ]),
        el('button.btn.btn-sm', {
          type: 'button', text: '✏️ 改名',
          // ⚠️ 2026-10-02 用户原话：「列表名我需要可以自己改」——
          //    以前名字就是壳生成的编号（`自定义 · 9f3a1c07`），用户没法认。
          dataset: { role: 'al-rename-sound', soundId: c.id },
          onclick: () => renameCustomSound(c.id, ctx),
        }),
        el('button.btn.btn-sm', {
          type: 'button', text: '🔊 试听',
          dataset: { role: 'al-preview', soundId: c.id },
          // ⚠️ 传**真实文件名**：自定义的 `file` 是运行时才知道的
          //    （`timetable-custom-9f3a1c07.caf`），试听走 `/__sounds/` 由壳从容器读。
          onclick: () => previewSound({ ...soundById(c.id), id: c.id, label: soundLabelOf(c.id, opts), file: c.file }),
        }),
        el('button.btn.btn-sm', {
          type: 'button', text: '⏱ 10 秒后试响',
          dataset: { role: 'al-test-sound', soundId: c.id },
          onclick: () => testSound({ id: c.id, label: soundLabelOf(c.id, opts) }, ctx),
        }),
        el('button.btn.btn-sm.btn-danger', {
          type: 'button', text: '删掉',
          // ⚠️ `soundId` 是给**测试和排错**用的（认得出删的是哪一首）：
          //    只靠按钮文字在"两首以上"时根本分不出点的是哪个。
          dataset: { role: 'al-drop-sound', soundId: c.id },
          onclick: async () => {
            // ⚠️ 这里**不需要改 settings**：铃声的"有没有"以容器里的文件为准，
            //    "谁在用它"记在每条闹钟自己的 `sound` 字段里。
            //    删完由壳回报 `soundDropped` → `adapter/native.js` 把这首从名单里摘掉
            //    → `app.js` 据此重排闹钟并重画。
            // ⚠️ 所以这里**必须把文件名（不是 id）交给壳** —— 壳只认文件名。
            dropCustomSound(c.file);
            // ⚠️ 顺手把这首的**名字**也清掉：名字是按 token 存的（`settings.customSoundNames`），
            //    文件没了、那个 token 再也不会出现 —— 留着就是一条永远对不上的垃圾数据。
            //    （名字表是**整体替换**的顶层键，所以必须先摊开再删一个。）
            const names = { ...customNames() };
            const goneKey = customSoundKey(c.id);
            if (goneKey && names[goneKey]) {
              delete names[goneKey];
              store.saveSettings({ customSoundNames: names });
            }
            toast({
              title: '已删掉这首',
              body: '用了它的闹钟会回到内置铃声（那条闹钟自己不会消失）',
              timeout: 3400,
            });
            ctx.refresh();
          },
        }),
      ])))
      : null,
    el('div.al-sounds', {}, builtins.map((s) => el('div.al-sound', {}, [
      el('div.al-sound-main', {}, [
        el('div.al-item-title', { text: `${s.label}${s.sharp ? '（较刺耳）' : ''}` }),
        el('div.al-item-sub', { text: s.desc }),
      ]),
      el('button.btn.btn-sm', {
        type: 'button', text: '🔊 试听',
        dataset: { role: 'al-preview', soundId: s.id },
        onclick: () => previewSound(s),
      }),
      el('button.btn.btn-sm', {
        type: 'button', text: '⏱ 10 秒后试响',
        dataset: { role: 'al-test-sound', soundId: s.id },
        onclick: () => testSound(s, ctx),
      }),
    ]))),
    el('p.tiny', {
      // ⚠️ 2026-10-01 改写：以前这里写的是"真文件在 App 里，网页取不到"——
      //    那个结论**是错的**（错因：壳的 MIME 表没有音频类型，静态文件回落成
      //    `application/octet-stream`，浏览器不肯当音频播）。补上 MIME 之后，
      //    试听**直接播的就是真音频文件**（和真铃声同一个文件）：
      //    内置铃声走包根，自定义铃声走 `/__sounds/`（壳从容器读）。
      //    只有"放不了真文件"（电脑/纯浏览器）时才回落到合成音型，那时会**另弹一个提示**。
      text: '✅ 「试听」放的就是**真铃声那个音频文件**，不是模拟音。'
        + '在电脑/浏览器上如果取不到它，会自动退回"音型示意"并提示你 —— 那种情况下'
        + '要听真声音请用右边的「10 秒后试响」，它会用**真正的闹钟通道**响一次。',
    }),
  ]);
}

/**
 * 「试听」用的**合成音型**表：`core/alarms.js` 里 `ALARM_SOUNDS[].preview` 的合法值就是这里的键。
 *
 * ⚠️ 为什么提成模块级常量并导出（2026-09-30）：
 *   它原来是 `previewSound()` 内部的局部 `const`，外面看不见 → 于是 core 里把
 *   'morning' 写成 `chime`（这个表里根本没有 `chime`）时，**没有任何检查能发现**，
 *   运行时静默落到 `|| patterns.triple` 兜底 → 用户选「晨钟」点试听、响的是「轻快三连」。
 *   导出之后 `tools/alarms-view.test.mjs` 可以逐个核对"每个铃声的 preview 都有对应音型"。
 */
export const SOUND_PATTERNS = Object.freeze({
  morning: [[523, 0.00, 1.1, 0.20], [784, 0.02, 0.9, 0.10]],
  triple: [[659, 0.00, 0.25, 0.22], [784, 0.22, 0.25, 0.22], [988, 0.44, 0.45, 0.22]],
  low: [[165, 0.00, 0.40, 0.30], [131, 0.55, 0.60, 0.30]],
  drop: [[1200, 0.00, 0.16, 0.25], [600, 0.06, 0.30, 0.18]],
  beep: [[1400, 0.00, 0.10, 0.25], [1400, 0.22, 0.10, 0.25], [1400, 0.44, 0.10, 0.25], [1400, 0.66, 0.10, 0.25]],
  // ---------------------------------------------------------------------------
  // 第二批五个的**兜底音型**（2026-10-02 随新铃声一起加）。
  //
  // ⚠️ 它们的真实用途已经变了：真机上「试听」**直接播包里的真文件**
  //    （`playRealSoundFile`），所以这些音型只在**取不到真文件**时才会响
  //    （电脑 / 纯浏览器），而且那时 `playSynthPreview` 会**弹提示说明是示意**。
  // ⚠️ 那为什么还必须有？两条：
  //    ① 有条断言钉着"`ALARM_SOUNDS[].preview` 的每个值都要有对应音型"
  //       （`tools/alarms-view.test.mjs`）—— 没有它，"取不到文件"时就彻底没声音；
  //    ② 它顺便是一份**"这个铃听起来大概是什么形状"的可读说明**。
  // ⚠️ 写这些音型时要**照着真文件的形状写**（不是随便给两个音），否则一旦回落到这里，
  //    用户听到的和真铃声差太远 —— 那就是我们最讨厌的"说的和做的不一样"。
  // ---------------------------------------------------------------------------
  // 心跳：低频双击 ×3（真文件是 8 组 11 秒，示意取前 3 组）
  heartbeat: [[92, 0.00, 0.20, 0.45], [72, 0.26, 0.28, 0.38],
    [92, 1.35, 0.20, 0.45], [72, 1.61, 0.28, 0.38],
    [92, 2.70, 0.20, 0.45], [72, 2.96, 0.28, 0.38]],
  // 警笛：两音硬交替（真文件 14 次 7 秒，示意取前 4 次）
  siren: [[660, 0.00, 0.50, 0.30], [880, 0.50, 0.50, 0.30],
    [660, 1.00, 0.50, 0.30], [880, 1.50, 0.50, 0.30]],
  // 风铃：五声音阶上行（真文件 6 音 3.6 秒，示意取 4 音）
  chime: [[523, 0.00, 0.60, 0.22], [587, 0.22, 0.60, 0.20],
    [659, 0.44, 0.60, 0.20], [784, 0.66, 0.80, 0.18]],
  // 渐急滴：**间隔递减**（示意也要体现"越来越急"，否则就不是同一个专攻）
  accelerate: [[740, 0.00, 0.14, 0.28], [740, 0.50, 0.14, 0.28], [740, 0.92, 0.14, 0.28],
    [740, 1.26, 0.14, 0.28], [740, 1.52, 0.14, 0.28], [740, 1.72, 0.16, 0.30]],
  // 晨曦：低音和弦床 + 高音缓升（和弦那几个音同时起，用 at=0 叠在一起）
  dawn: [[262, 0.00, 1.60, 0.16], [330, 0.00, 1.60, 0.14], [392, 0.00, 1.60, 0.13],
    [523, 0.00, 0.90, 0.18], [659, 0.60, 0.90, 0.18], [784, 1.20, 1.40, 0.20]],
  // ⚠️ 临时条目（2026-10-01）：`custom` = 用户导入的那段音频。
  //    ⚠️ **这只是"放不了真文件时"的兜底占位** —— 真机上试听会**直接播真文件**
  //    （`playRealSoundFile`），所以正常情况下用户听到的就是原曲那 25 秒。
  //    这里放一个"两下短音"只是为了让"取不到文件"时不至于一点声音都没有，
  //    而且 `playSynthPreview` 会**弹提示说明这是示意**，不会假装是真声音。
  custom: [[660, 0.00, 0.18, 0.20], [880, 0.26, 0.22, 0.20]],
});

/**
 * **试听：先播真文件，播不了再退回合成音型**（2026-10-01 重写）。
 *
 * ⚠️⚠️ 原来的注释写的是"真文件在 App 包里，网页取不到，请求它必然 404"——
 *     **那个结论是错的，而且错因已查明**：文件明明就在 **bundle 根**、和 `index.html` 同级，
 *     本机 HTTP 服务能取到；当年之所以"取不到"，是因为壳的 MIME 表里**没有音频类型**，
 *     静态文件一律回落到 `application/octet-stream`，而**浏览器不肯把 octet-stream 当音频播**。
 *     （壳侧已补上 `audio/x-caf` 等，见 `LocalServer.swift` 的 `mimeType(for:)`。）
 *     后果就是用户听到的"试听"和真铃声是**两套各自写死的参数**——
 *     真机上第一次听到真铃声的人立刻发现了对不上（"和下面的试听完全不一样"）。
 *
 * 所以现在的顺序是：
 *   ① **`new Audio('/<file>.caf')` 播真文件** —— 试听 = 真声音，同一个文件，永远不会对不上；
 *   ② 播不了（电脑/纯浏览器上没有这些文件、或解码失败）→ **回落到合成音型**，
 *      并**如实标注**"这是近似示意"，而不是假装播的就是真声音。
 */
function previewSound(s) {
  playRealSoundFile(s, (ok, why) => {
    if (ok) return;                       // 真文件播上了，收工
    playSynthPreview(s, why);             // 回落：合成音型 + 如实告知
  });
}

/**
 * 一个铃声文件对应的**可播放 URL**。
 *
 * ⚠️⚠️ 2026-10-02 修一个真 bug：以前这里写死 `'/' + file + '.caf'`，
 *    那是**内置铃声**的约定（`ALARM_SOUNDS[].file` = `'alarm-morning'`，**不带后缀**）。
 *    而用户自己导入的那首，壳报回来的名字**已经带 `.caf`**
 *    （`timetable-custom-9f3a1c07.caf`），而且它在容器里、**不在包根** ——
 *    拼出来的 `/timetable-custom-….caf.caf` 必然 404 →
 *    「试听」每次都静默回落到合成音型。用户听到的"自己那首歌"其实是假的。
 *    现在按前缀分路：
 *      · 内置：`/alarm-morning.caf`（包根，静态文件）
 *      · 自定义：`/__sounds/timetable-custom-….caf`（壳从容器读，见 LocalServer 那条路由）
 */
function soundUrlOf(file) {
  const name = String(file || '');
  if (!name) return '';
  if (name.startsWith(CUSTOM_SOUND_PREFIX)) return '/__sounds/' + encodeURIComponent(name);
  // 内置：`file` 是不带后缀的词干（`alarm-tone-low`），补上 `.caf`
  return /\.(caf|wav|m4a|mp3|aiff?)$/i.test(name) ? '/' + name : '/' + name + '.caf';
}

/**
 * ① 试播真实音频文件（内置在包根、自定义在容器里，见 `soundUrlOf`）。
 * ⚠️ 浏览器对"不存在/类型不对"的反应是**异步的 error 事件**，所以必须用回调，
 *    不能像同步函数那样"返回布尔值"。
 */
function playRealSoundFile(s, done) {
  try {
    const Audio_ = globalThis.Audio;
    if (!Audio_ || !s || !s.file) return void done(false, '这台设备不支持网页播放');
    const url = soundUrlOf(s.file);
    if (!url) return void done(false, '这个名字认不出来');
    const a = new Audio_(url);
    a.preload = 'auto';
    let settled = false;
    const finish = (ok, why) => { if (!settled) { settled = true; done(ok, why); } };
    a.addEventListener('error', () => finish(false, '拿不到 App 里那个音频文件'));
    // `canplay` 之后才播（直接 play() 在某些 WebView 上会先抛后再补事件）
    a.addEventListener('canplaythrough', () => {
      const p = a.play();
      if (p && typeof p.then === 'function') {
        p.then(() => finish(true)).catch(() => finish(false, '系统不让我在网页里放这个音'));
      } else finish(true);
    });
    // 兜底：3 秒内既没 canplay 也没 error（极少数 WebView），按失败处理，别把按钮卡住
    setTimeout(() => finish(false, '等不到这个音频（超时）'), 3000);
  } catch {
    done(false, '网页播不了这个音');
  }
}

/** ② 回落：合成音型示意（原实现，保留给"没有真文件"的场合） */
function playSynthPreview(s, why) {
  try {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return void toast({ title: '这台设备放不了试听', body: '👉 用「10 秒后试响」听真声音', kind: 'err' });
    if (why) {
      toast({
        title: `放不了「${s.label}」的真声音，改放音型示意`,
        body: `👉 原因：${why}。音型只是**大致像**（合成正弦），真机上请用「10 秒后试响」。`,
        kind: 'err', timeout: 7000,
      });
    }
    const ctx = new Ctx();
    const t0 = ctx.currentTime + 0.02;
    // 音型表在模块级（`SOUND_PATTERNS`）—— 键就是 core 里 `ALARM_SOUNDS[].preview` 的合法值。
    // ⚠️ 认不出来时**要说出来**，不许静默放成别的音（那会让用户以为"这个铃声就长这样"）。
    const notes = SOUND_PATTERNS[s.preview];
    if (!notes) {
      toast({
        title: `「${s.label}」没有对应的试听音型`,
        body: `👉 这是网页侧的配置漏了（preview=${String(s.preview)}）。先按「轻快三连」的音型放给你听；`
          + '要听真声音请用「10 秒后试响」。请把这句话告诉维护者。',
        kind: 'err', timeout: 9000,
      });
    }
    for (const [freq, at, dur, gain] of (notes || SOUND_PATTERNS.triple)) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = t0 + at;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
    setTimeout(() => { try { ctx.close(); } catch { /* 忽略 */ } }, 2500);
  } catch {
    // 浏览器策略（没用户手势 / 音频被禁止）→ 静默失败即可，界面上还有"试响"
  }
}

/**
 * 用**真正的闹钟通道**试响一次当前铃声。这是唯一能验证铃声的操作。
 *
 * ⚠️ 2026-09-30：改走 `runTimerFlow`，这样"按下去之后走到哪一步"会记进诊断区。
 *    原来这里是个同步函数、只弹个 toast —— 真机上"按了没反应"时，
 *    **没有任何地方能看出是没落库、没通知壳、还是壳没排上**。
 */
function testSound(s, ctx) {
  return runTimerFlow({
    label: `10 秒后响「${s.label}」`,
    ctx,
    // ⚠️ 试响**不落库**（它是一次性动作，不该在列表里留一条）——
    //    所以诊断区那一行会显示"落库：—（试响不落库）"，这是**预期**，不是失败。
    run: () => bridge.testAlarmSound({ soundId: s.id, seconds: 10 }),
  });
}

// ---------------------------------------------------------------------------
// ④ 诊断
// ---------------------------------------------------------------------------

/**
 * 这台设备是不是**安卓壳**。
 *
 * ⚠️ 为什么到处要用它：安卓和 iOS 的闹钟是**两条完全不同的路** ——
 *   · iOS：网页把"该排哪几条"发给壳（`postToShell({type:'alarms'})`），壳调 AlarmKit
 *   · 安卓：网页只负责 POST /api/alarms 落库，**壳自己**按库里的数据用 AlarmManager 排
 *     （见 `android/.../ReminderAlarms.kt` 与 `MainActivity` 里的 `store.onChanged`）
 *   所以安卓上 `postToShell` 恒为 false —— 那是**预期**，不是失败。
 *   不区分平台的话，界面上会到处显示"没能交给系统""没有真闹钟通道"，
 *   而实际上闹钟是排上了的（只是走 HTTP 那条路）。
 */
function isAndroidShell() {
  try { return platformKind() === 'android'; } catch { return false; }
}

function blockDiag(alarms) {
  const kit = alarmKitStatus();
  const sched = bridge.scheduleStatus();
  const android = isAndroidShell();

  const lines = android ? [
    // ⚠️ 安卓侧**不要照抄 iOS 那几行**：AlarmKit / 闹钟授权都是 iOS 独有概念，
    //    在安卓上它们恒为"没有"，照抄会让用户以为这台设备不支持闹钟。
    `这台设备：${platformKind() || '不是原生壳（浏览器/电脑）'}`,
    '排程方式：安卓系统闹钟（AlarmManager）—— 由壳按库里的闹钟自己排，不经过网页',
    `库里的闹钟：${alarms.length} 条（其中定时器 ${alarms.filter((a) => a.kind === 'clock').length} 条）`,
    // ⚠️ 壳的回报在安卓上永远是空的（没有那条下行消息），所以这里如实解释，而不是报错
    '交给系统的：安卓不需要网页下发 —— 网页一改动，壳就重新排一次下一次唤醒',
    // ⚠️ 精确闹钟：壳的 `ReminderAlarms.reschedule` 会查 `canScheduleExactAlarms()`
    //    （Android 12+）；用户在系统设置里关掉时它会降级成 `setAndAllowWhileIdle`，
    //    系统可以把唤醒**推迟几分钟**（打盹模式下更久），表现就是"闹钟晚了"。
    //    网页这边没有查询它的通道（壳没把这个结果暴露成 API），所以只能给一句人话 +
    //    指路：真觉得晚了，先去系统设置里把本应用的"闹钟和提醒"权限打开。
    '准点程度：若系统设置里关掉了本应用的「闹钟和提醒」，安卓会把唤醒推后几分钟 —— 觉得"闹钟晚了"先看这里',
    `上次排程：${sched.lastSchedule === 'failed'
      ? `❌ 失败 —— ${sched.lastScheduleError || '（壳没给原因）'}`
      : '看「诊断」里壳记的触发日志（这台设备上不通过网页回报）'}`,
    '铃声：内置铃声用 Android 通知渠道放；渠道声音在安卓 8+ 不可改，换铃声会新建一个渠道',
  ] : [
    `这台设备：${shellKind() || '不是原生壳（浏览器/电脑）'}`,
    `AlarmKit 可用：${kit.known ? (kit.available ? '是' : '否（系统低于 iOS 26）') : '还没收到壳的回报'}`,
    `闹钟权限：${kit.known ? (kit.authorized ? '已授权' : '没授权') : '还没收到壳的回报'}`,
    // ⚠️ 这个计数用的是 `clock`（= 界面上的「定时器（闹钟）」那一块，固定时刻）。
    //    别顺手改成 `timer` —— `timer` 是上面的「计时器」（倒计时），两者在
    //    core/alarms.js 里有明确定义（L18-L19），文案与计数必须对得上。
    `库里的闹钟：${alarms.length} 条（其中定时器 ${alarms.filter((a) => a.kind === 'clock').length} 条）`,
    `交给系统的：${sched.known ? `${sched.count} 条（上限 ${MAX_SCHEDULED}）` : '还没收到壳的回报'}`,
    // ⚠️ 这一行是 2026-09-30 补的**关键分界**：它回答"到底排上了没有"。
    //    `交给系统的` 那一行会被"10 秒计时器响完就没了"骗到（见文档），
    //    而这一行读的是**壳自己记的 schedule() 结果**，不受时间影响。
    `上次排程：${sched.lastSchedule === 'failed'
      ? `❌ 失败 —— ${sched.lastScheduleError || '（壳没给原因）'}`
      : sched.lastSchedule === 'ok'
        ? '✅ 系统收下了（⚠️ 收下 ≠ 会响；到点没响请看下面那行）'
        : '还没排过（或壳太旧、不报这项）'}`,
    sched.soundUnsupported
      ? '⚠️ 铃声：壳回报**有文件没找到**，那几条会放系统默认音'
      : '铃声：壳还没回报"文件有没有找到"（警告要等它回报才准确）',
  ];

  // ⚠️ 这里**转调 core 那同一个函数**（`bridge.planAlarms`），绝不在视图里另算一遍：
  //    诊断区的全部价值就是"网页算的"和"壳排的"能对照，两处算法一分叉，
  //    对照出来的差异就是假的（会带着你去查一个不存在的问题）。
  const planText = (() => {
    try {
      return describeSchedule(bridge.planAlarms(alarms), new Date());
    } catch (e) {
      return '（算不出来：' + String((e && e.message) || e) + '）';
    }
  })();

  const shellLines = android
    ? '（安卓上排程由壳自己做 —— 它按库里的闹钟算出下一次唤醒时刻，'
      + '每次数据变动都重排一次，所以这里没有"网页下发了哪几条"）'
    : (sched.scheduled.length
      ? sched.scheduled.map((s, i) => `${i + 1}. ${s.id}　${s.fireAt}　铃声=${s.sound || '系统默认'}`
        + (s.soundOk ? '' : '　⚠️ 文件没找到')).join('\n')
      : '（壳还没回报具体条目，或现在没有任何已排的闹钟）');

  // ⚠️ 「还没收到壳的回报」**不能只当一句状态显示** —— 用户看到它不知道该干什么。
  //    2026-09-30 真机上就是这个症状：诊断区好几行写着"还没收到壳的回报"，
  //    而用户唯一能做的就是干等。实测定位到最可能的原因是**装的那个包比源码旧**
  //    （旧包的壳不认这几条新消息，或压根不回），其次才是"壳收到了但回报丢了"。
  //    所以这里把"下一步做什么"直接写出来，并给一个**不依赖任何回报**的自证办法：
  //    按「重排全部闹钟」后看提示语是"已重排 N 条"（= 网页→壳 这条路通）
  //    还是"没能交给系统"（= 连发都没发出去）。
  // ⚠️ 「上一次操作走到哪一步」——2026-09-30 真机排查加的。
  //    真机上"按了没反应"时，光看上面那六行**分不出**是①没落库 ②没通知壳
  //    ③壳没排上。这一行直接把断点说出来。
  const att = lastTimerAttempt();
  const attemptLine = att ? el('p.tiny', {
    text: `🔎 上一次操作：${att.label} → **${att.step}**`
      + `（落库：${att.saved === null ? '—（试响不落库）' : `${att.saved} 条`}`
      + `${att.file ? `，铃声文件=${att.file}` : ''}）`
      + `\n${att.detail}`
      + `\n若这行写着"已通知壳"却一直不变、而且"交给系统的"仍是 0 条 ——`
      + `那就是**壳收到了却没排上**，请把这行原样发给我。`,
  }) : null;

  // ⚠️ 落盘的"最近几次"（2026-10-02 加）。和上面那行**分开显示**：
  //    上面那行回答"这次操作走到哪一步"，这一块回答"以前在什么时候发生过几次"
  //    —— 排查"闹钟自己冒出来"时，正是靠它才能排除"改名之后又点过一次试响"。
  //    只在**两条以上**时才显示（只有一条时上面那行已经说了，重复显示反而像噪音）。
  const hist = timerAttemptHistory();
  const historyLine = hist.length > 1 ? el('p.tiny', {
    text: `🕘 这台设备上最近 ${hist.length} 次「开始倒计时 / 试响」（新的在前）：\n`
      + hist.map((h) => `　${clockOf(h.at)}　${h.label || h.kind} → ${h.step}`).join('\n')
      + `\n（这份记录存在本机，重开 App 也在；排查"闹钟自己冒出来"时请把这几行一起发我。）`,
    dataset: { role: 'al-attempts' },
  }) : null;

  const noReplyHint = sched.known ? null : el('p.tiny.al-warn', {
    text: '👉 上面写着"还没收到壳的回报"时，先按下面那个「重排全部闹钟」看提示语：'
      + '说"已重排 N 条"= 网页能发给壳（那问题在壳的回信）；'
      + '说"没能交给系统"= 连发都没发出去。'
      + '两种都请**先确认装的是最新那个包**（旧包里没有这几条消息，永远不会有回报）——'
      + '装包后如果还是这样，把这段文字原样发给我。',
  });

  return section(
    '诊断',
    android
      // ⚠️ 安卓上不能写"只有装到 iPhone/iPad 上才会响" —— 安卓真的会响，
      //    只是走的不是 AlarmKit 那条路。
      ? '出问题先看这里。安卓的闹钟由系统闹钟（AlarmManager）排，到点发通知并放你选的铃声。'
      : '出问题先看这里。真闹钟只有装到 iPhone/iPad 上才会响。',
    [
      el('pre.al-diag', { text: lines.join('\n'), dataset: { role: 'al-status' } }),
      attemptLine,
      historyLine,
      noReplyHint,
      el('div.al-row', {}, [
        // ⚠️ 「申请闹钟权限」是 **iOS 独有**的（AlarmKit 要用户授权）。
        //    安卓那条路用的是普通通知权限，在系统设置里给，页面上没有可申请的入口 ——
        //    留一个按了没用的按钮比没有更糟，所以安卓上**不显示**它。
        android ? null : el('button.btn.btn-sm', {
          type: 'button', text: '申请闹钟权限',
          onclick: () => { requestAlarmAuthorization(); toast({ title: '看一下系统弹窗', body: '点了「允许」才有真闹钟', timeout: 5000 }); },
        }),
        el('button.btn.btn-sm', {
          type: 'button', text: '刷新状态',
          onclick: () => { refreshAlarmStatus(); bridge.refreshAlarmSchedule(); toast({ title: '已问过壳', body: '稍等一下会刷新', timeout: 2500 }); },
        }),
        el('button.btn.btn-sm', {
          type: 'button', text: android ? '重新排一次' : '重排全部闹钟',
          onclick: () => {
            if (android) {
              // 安卓上没有"下发"这回事：壳监听数据库变动自己重排。
              // 这里如实说清，而不是弹一个"没能交给系统"的假失败。
              toast({
                title: '安卓不用手动重排',
                body: '👉 壳会自动跟着库里的闹钟重排下一次唤醒；改动闹钟后立刻生效。'
                  + '真怀疑没排上，重开一次 App 即可（启动时会强制排一次）。',
                timeout: 7000,
              });
              return;
            }
            const r = bridge.pushAlarmSchedule();
            toast({
              title: r.sent ? `已重排 ${r.count} 条` : '没能交给系统',
              body: r.sent ? `库里共 ${r.total} 条，只排最近 ${MAX_SCHEDULED} 条` : '👉 这台设备上没有真闹钟通道',
              kind: r.sent ? 'ok' : 'err',
            });
          },
        }),
      ]),
      el('label.al-lbl', { text: '网页这边算出来的排程（应与"交给系统的"一致）' }),
      el('pre.al-diag', { text: planText, dataset: { role: 'al-plan' } }),
      el('label.al-lbl', { text: android ? '壳里的排程' : '壳回报的实际排程' }),
      el('pre.al-diag', { text: shellLines, dataset: { role: 'al-shell-plan' } }),
      el('p.tiny', {
        text: android
          ? '（安卓上「试响」用不了 —— 那是发给 iOS 壳的消息，安卓壳没有这条通道。'
            + '要确认真会响，设一条 1~2 分钟后的闹钟等它响即可；「试听」按钮放的是网页合成音型。）'
          : '⚠️ 自定义铃声是否真的生效，**只有在真机上按「10 秒后试响」才判得出来**：'
            + 'iOS 找不到声音文件时是**静默放默认音**（不报错）。'
            + '所以如果试响放的是系统默认闹钟音，而这里显示"铃声=alarm-xxx（自定义）"，'
            + '那就是"文件没找到"或系统没支持 —— 请把这两段文字一起告诉我。',
      }),
    ],
  );
}

// ---------------------------------------------------------------------------
// 公共小件
// ---------------------------------------------------------------------------

function section(title, hint, children, attrs = {}) {
  return el('section.al-block', attrs, [
    el('div.al-block-head', {}, [
      el('h3', { text: title }),
      hint ? el('p.tiny', { text: hint }) : null,
    ]),
    ...children.filter(Boolean),
  ]);
}

function footNote() {
  // ⚠️ 安卓**没有 AlarmKit**（那是 iOS 的框架），所以那整段话在安卓上是错的。
  //    安卓的落地方式是"系统闹钟 + 带自定义声音的通知渠道"：到点发通知、放铃声，
  //    但不是满音量、也不会有锁屏全屏界面。这差别必须说出来 ——
  //    否则用户会以为安卓上也能像 iOS 那样"躲不开"。
  if (isAndroidShell()) {
    return el('p.tiny.al-foot', {
      text: '安卓这边闹钟由**系统闹钟（AlarmManager）**到点叫醒：发一条通知并放你选的铃声，'
        + '关掉界面也照响。⚠️ 它**不是** iOS 的 AlarmKit —— 不会满音量盖过静音、也没有锁屏全屏；'
        + '声音受系统通知音量影响，所以重要的事请把通知音量开大一点。',
    });
  }
  return el('p.tiny.al-foot', {
    text: '真闹钟由 iOS 的 AlarmKit 提供：满音量、无视静音开关、穿过专注模式，'
      + '锁屏全屏响到你按掉。⚠️ 也正因为这样，它**压不住也躲不开** —— '
      + '所以每条都要你自己开关，别把不想被吵醒的时间设进去。',
  });
}

/**
 * 把失败说清楚（项目的失败文案范式：**哪一步 + 人话 + 👉 下一步**）。
 *
 * ⚠️ 优先按**错误码**翻译（服务端/cor e 都给码），中文只作兜底 ——
 *    靠中文匹配的话，改一个字文案就会静默退化成"未知错误"。
 */
function showAlarmError(err, what) {
  const code = err && err.code ? String(err.code) : '';
  const map = {
    ALARM_HOUR: ['小时要在 0–23 之间', '👉 改成 0–23'],
    ALARM_MINUTE: ['分钟要在 0–59 之间', '👉 改成 0–59'],
    ALARM_REPEAT: ['重复方式没选对', '👉 选「只响一次 / 每天 / 工作日 / 自定义」之一'],
    ALARM_WEEKDAYS: ['自定义重复一天都没选', '👉 至少勾一天'],
    ALARM_DURATION_MIN: ['时长太短', '👉 至少 1 秒'],
    ALARM_DURATION_MAX: ['时长太长', '👉 最长 24 小时；更长的请用「定时器」'],
    ALARM_DURATION: ['时长没填对', '👉 填一个分钟数'],
    ALARM_SOUND: ['铃声认不出来', '👉 重新选一个内置铃声'],
    ALARM_LABEL: ['标签太长', '👉 最多 24 个字'],
    ALARM_LIMIT: ['闹钟条数满了', '👉 先删掉几条再加'],
    ALARM_NOT_FOUND: ['这条闹钟不在了', '👉 刷新一下页面看看'],
  };
  const hit = map[code];
  toast({
    title: hit ? hit[0] : `${what}失败`,
    body: hit ? hit[1] : String((err && err.message) || err) + '　👉 稍后再试；一直这样请告诉我',
    kind: 'err', timeout: 7000,
  });
}

// ---------------------------------------------------------------------------
// 计时器大字：每 250ms 自己重画（**只在闹钟板块且真有在跑的计时器时**）
// ---------------------------------------------------------------------------

let tick = null;
let lastViewId = null;

/**
 * 由 web/ui/app.js 在每次渲染后调用。
 *
 * ⚠️ 三条纪律，缺一条就会变成"偷偷耗电"：
 *   ① 不在闹钟板块 → **必须停掉**定时器
 *   ② 没有在跑的计时器 → 停掉（静止的画面不需要每 250ms 重画一次）
 *   ③ 重入时先清旧的（`clearInterval`），否则切来切去会攒下一堆 interval
 *      —— 那种漏法在真机上只表现成"越用越卡"，几乎查不出来
 */
export function alarmsTick(viewId, state) {
  const running = Array.isArray(state && state.alarms)
    ? state.alarms.some((a) => a && a.kind === 'timer' && a.enabled && a.paused !== true
      && timerRemainingMs(a) > 0)
    : false;
  const shouldRun = viewId === 'alarms' && running;
  lastViewId = viewId;
  if (!shouldRun) {
    if (tick) { clearInterval(tick); tick = null; }
    return false;
  }
  if (tick) return true;
  tick = setInterval(() => {
    // 只为刷新那一行大字而重画：不动数据、不发请求
    try {
      const host = document.querySelector('.al-timer-big');
      const sub = document.querySelector('.al-timer-sub');
      const st = store.getState();
      const a = (st.alarms || []).find((x) => x && x.kind === 'timer' && x.enabled && timerRemainingMs(x) > 0);
      if (!a) {
        if (tick) { clearInterval(tick); tick = null; }
        return;
      }
      const left = timerRemainingMs(a);
      if (host) host.textContent = formatCountdown(left);
      if (sub) sub.textContent = `「${a.label || '计时器'}」还剩 ${formatCountdown(left)}`;
      // 到点了：清掉 interval 并让界面重画一次（此时那条会变成"已结束"）
      if (left <= 0) {
        if (tick) { clearInterval(tick); tick = null; }
        window.dispatchEvent(new CustomEvent('timetable:alarms-tick-done'));
      }
    } catch { /* 视图已经不在了：下一次 shouldRun 会停掉它 */ }
  }, 250);
  return true;
}
