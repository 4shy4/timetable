// 应用外壳：视图注册、路由、导航、全局快捷键、提醒引擎接线。
import { $, clear, el, mount } from './dom.js';
import * as store from '../adapter/store.js';
import * as reminder from '../adapter/reminder.js';
// 本机独立模式（4b）：启动时要先把上次选的模式恢复好
import { applySavedMode } from '../adapter/local-mode.js';
// 原生壳桥（iOS/安卓）：把提醒提前注册给系统；浏览器里这些调用全是空操作
import {
  inShell, announceReady, installShellReceiver, pushNotifications as pushShellNotificationsNow,
  // 写"未来 7 天"的文件给快捷指令/Siri 读（见 core/share-plan.js）
  pushShareData,
  // 语音桥：往系统「提醒事项」写镜像，让 Siri 原生读写（见 core/voice-bridge.js）
  pushVoiceMirror,
  // 自定义提示音：问壳"容器里现在有哪些 .caf"（用来清掉设置里已经不存在的名字）
  refreshCustomSounds,
  // ⚠️ 闹钟板块：启动时要"问一次 AlarmKit 状态"（`refreshAlarmStatus`）与"问一次实际排程"
  //    （`refreshAlarmSchedule`，从 adapter/alarms.js 来）。
  //    2026-09-30 真机抓到一个漏网：`refreshAlarmStatus` 在 **L851/L852 被调用，却没在这里导入**
  //    → 启动时 `ReferenceError: Can't find variable: refreshAlarmStatus`
  //    → 被启动流程的 try/catch 抓住、显示成顶部"启动失败"横幅，**后面的初始化全没跑完**。
  //    测试当时抓不到它：静态断言只查了 `applyShellAlarms` 有没有被 import，
  //    而**没有任何一条断言检查"app.js 调用的每个壳桥函数都真的导入了"**。
  //    → 本次补上导入，并新增一条机械化断言（tools/alarms-view.test.mjs）。
  refreshAlarmStatus,
} from '../adapter/native.js';
// 把「提醒事项」里用户自己加的条目变成日程草稿（纯逻辑，见 core/voice-bridge.js）
import { voiceItemsToEvents } from '../../core/voice-bridge.js';

/** 防抖：数据连着改好几次时，只在停下来之后重排一次系统提醒 */
let shellNotifyTimer = null;
function scheduleShellNotify() {
  if (!inShell()) return;
  if (shellNotifyTimer) clearTimeout(shellNotifyTimer);
  shellNotifyTimer = setTimeout(() => {
    shellNotifyTimer = null;
    pushShellNotifications();
  }, 1500);
}

/**
 * 立刻把待推送的排掉，不等防抖。
 *
 * ⚠️ 为什么必须有这个（用户实测到点不响，很可能就是这个窗口）：
 *   上面那个 1500ms 防抖有个致命窗口 —— **改完日程立刻锁屏/切走**时，
 *   WKWebView 会把页面挂起，那句 `setTimeout` 根本不会执行，
 *   于是**提醒计划从来没交给系统**，到点自然什么都不响。
 *   用户当时的操作正是"建完日程 → 锁屏等着"，正好踩中。
 *
 *   所以页面一旦要隐藏（锁屏、切到别的 App、关掉），立刻推一次。
 *   推送是幂等的（原生侧是整批替换），多推几次没有副作用。
 */
function flushShellNotify() {
  if (!inShell()) return;
  if (!shellNotifyTimer) return;      // 没有待推送的，别白推
  clearTimeout(shellNotifyTimer);
  shellNotifyTimer = null;
  pushShellNotifications();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushShellNotify();
});
window.addEventListener('pagehide', flushShellNotify);

/** 现在就把当前该排的提醒交给系统 */
function pushShellNotifications() {
  if (!inShell()) return;
  const s = store.getState();
  try {
    pushShellNotificationsNow({ events: s.events, settings: s.settings });
  } catch (err) {
    console.warn('[native] 排提醒失败', err);
  }
  // 顺便把"未来 7 天"写成文件，好让快捷指令 / Siri 读到（见 core/share-plan.js）。
  // ⚠️ 挂在这里而不是另起一处，是为了**继承同一套触发时机**：
  //    数据一变（防抖后）、切走/锁屏时、启动时 —— 三处都已经会走到这个函数。
  //    另起一套的话，迟早会出现"提醒更新了，但 Siri 念的还是旧的"。
  try {
    pushShareData({ events: s.events, settings: s.settings });
  } catch (err) {
    console.warn('[native] 写分享文件失败', err);
  }
  // 语音桥：往系统「提醒事项」写一份镜像 —— **这条路才是让 Siri 原生读得到的那个**
  // （写文件那条用户侧摩擦太大，已降级为备选，见 core/voice-bridge.js 顶部）
  try {
    pushVoiceMirror({ events: s.events, settings: s.settings });
  } catch (err) {
    console.warn('[native] 写提醒事项镜像失败', err);
  }
}

/**
 * 「提醒事项」里用户自己用 Siri 加的那些 → 变成真日程。
 *
 * ⚠️ 用**本地账本**记"哪些已经导入过"，而不是去改用户的提醒事项（加标记/删除）。
 *   理由：那是用户自己的数据，能不动就不动；而且账本模式在项目里已有先例
 *   （提醒的"已响过"账本 `timetable.fired.v1`），行为一致、好理解。
 */
const VOICE_LEDGER_KEY = 'timetable.voiceImported.v1';
function voiceLedger() {
  try {
    const raw = JSON.parse(localStorage.getItem(VOICE_LEDGER_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
function voiceLedgerAdd(keys) {
  // 只留最近 300 个，别让账本无限长（提醒账本也是这个思路）
  const next = [...new Set([...voiceLedger(), ...keys])].slice(-300);
  try { localStorage.setItem(VOICE_LEDGER_KEY, JSON.stringify(next)); } catch { /* 存不下就算了 */ }
}

async function importVoiceItems(inbound) {
  const seen = new Set(voiceLedger());
  const fresh = (inbound || []).filter((r) => r && r.key && !seen.has(r.key));
  if (!fresh.length) return;
  const drafts = voiceItemsToEvents(fresh, { now: new Date() });
  const done = [];
  for (const d of drafts) {
    try {
      await store.saveEvent({
        title: d.title,
        start: d.start,
        end: d.end,
        location: d.location || '',
        // 解析里带出来的提前量优先；没有就交回"自动"
        reminders: (d.reminders && d.reminders.length) ? d.reminders : undefined,
        autoReminders: !(d.reminders && d.reminders.length),
      });
      done.push(d.key);
    } catch (err) {
      console.warn('[voice] 导入失败：' + d.title, err);
    }
  }
  if (done.length) {
    voiceLedgerAdd(done);
    toast({
      title: '从「提醒事项」加进来 ' + done.length + ' 条',
      body: '你在 Siri 里说的日程已经变成气泡了',
      timeout: 6500,
    });
    renderAll();
  }
}
import { toast, alertToast } from './toast.js';
import { openEditor } from './editor.js';
import { isModalOpen, openModal } from './modal.js';
import { asDate } from '../../core/time.js';
// 一句话加日程：中文自由文本 → 草稿（离线规则解析，见 core/nl-parse.js）
import { parseNatural, parseDeepLink } from '../../core/nl-parse.js';
// 通知上的「完成」要不要真的标完成 —— 重复日程要拦住（见下面 installShellReceiver 那段）
import { isRecurring } from '../../core/state-ops.js';

import { monthView } from './views/month.js';
import { listView } from './views/list.js';
import { bubbleView } from './views/bubble.js';
import { courseView } from './views/course.js';
import { recycleView } from './views/recycle.js';
import { importView } from './views/import.js';
import { settingsView } from './views/settings.js';
import { helpView } from './views/help.js';
// 「闹钟」板块（计时器 / 定时器 / 铃声 / 诊断）。
//
// ⚠️⚠️ 这是**唯一一个不是所有端都出现的视图**：它只在 iOS 壳里注册
//    （见下面的 `shellViews()` 门控）。用户明确要求"安卓与电脑先不动"，
//    而 AlarmKit 是 iOS 26+ 的能力 —— 在别处放一个入口 = 让用户设一个
//    永远不会响的闹钟，比没有这个功能更糟。
//    ⚠️ 所以它必须**同时**出现在 `allViews`（路由/快捷键能找到它）和
//    `shellViews()` 的返回里（侧栏要显示它）—— 漏一边就是"点了没反应"
//    或者"根本看不见"。
import { alarmsView, alarmsTick, alarmsViewAllowed } from './views/alarms.js';
// 闹钟 ↔ 原生壳的桥（排程/计时器状态机/试响）。**只在这里**接壳回报的事件，
// 由本文件转给适配器（见 native.js 里 'alarms' 那条注释：不让两个适配器互相 import）。
import { applyShellAlarms, pushAlarmSchedule, refreshAlarmSchedule } from '../adapter/alarms.js';
// 「简约版」（0.11.0）首次引导那张**不挡路**的卡片（两个问题 → 一档 + 对应开关）。
// ⚠️ 为什么是横条（#banner-host）而不是弹窗：气泡区是主界面，还要接拖拽/长按手势 ——
//    一个"引导"把它按住是最容易被骂的设计。这一条横条可以整张跳过（跳过什么都不改）。
// ⚠️ 档位语义（两个答案落到哪一档）在 core/presets.js，这里只画和保存。
import { wizardBanner } from './presets-ui.js';

// 气泡视图排在第一位：它是主界面
//
const views = [bubbleView, monthView, listView, courseView, recycleView];
const tools = [importView, settingsView, helpView];
// ⚠️ `allViews` 要**包含闹钟**：它是"路由能找到的视图池"。
//    renderAll 就是靠 `allViews.find(v => v.id === state.view)` 找当前视图的 ——
//    不放进来，`state.view === 'alarms'` 时会被兜底成 bubbleView（看着像"点了没反应"）。
const allViews = [...views, alarmsView, ...tools];

/**
 * 侧栏上该出现哪些视图。
 *
 * ⚠️ 闹钟**只在 iOS 壳里**出现（判定收在 views/alarms.js 的 `alarmsViewAllowed()`，
 *    认的是原生桥 `shellKind()==='ios'`，不确定时一律不显示）。
 *    为什么用函数而不是算一次的常量：`shellKind()` 依赖 `window.webkit`，
 *    而页面刚起来的那一刻它一定在（atDocumentStart 注入），但**测试桩里不在** ——
 *    所以每次渲染时现算，让"门控跟着环境走"，而不是被模块加载顺序钉死。
 */
function shellViews() {
  return alarmsViewAllowed() ? [...views, alarmsView] : views;
}

const navIcons = {
  bubble: '◍', month: '▦', list: '☰', course: '🎓',
  recycle: '🕳', import: '⇪', settings: '⚙', help: '?',
  alarms: '⏰',
};

const ctx = {
  get state() { return store.getState(); },
  setView: (id) => store.setView(id),
  setCursor: (key) => store.setCursor(key),
  setCourseWeek: (w) => store.setCourseWeek(w),
  setLocal: (patch) => store.setState(patch),
  refresh: () => { renderAll(); },
  newEventAt: (dateOrKey, defaults = {}) => {
    const d = dateOrKey instanceof Date ? dateOrKey : asDate(dateOrKey);
    const start = new Date(d);
    if (start.getHours() === 0 && start.getMinutes() === 0) start.setHours(9, 0, 0, 0);
    openEditor(null, { start, type: defaults.type || 'personal' });
  },
  editEvent: (ev) => openEditor(ev),
  /**
   * 在某个容器里加子气泡 —— 由气泡视图"单击背景"触发。
   * 背景就是母气泡，所以这条路径等价于"点母气泡往里面放东西"。
   */
  addChild: (parentId) => {
    const state = store.getState();
    const parent = state.events.find((e) => e.id === parentId);
    if (!parent) {
      // 容器的 id 已经不存在了（比如套娃路径里留了个幽灵 id）。
      // 不能静默 return —— 用户会以为"点了没反应"；也不能拿幽灵 id 去建子气泡
      // （服务端会报「父气泡不存在」，这正是用户遇到的现象）。
      toast({
        title: '这个容器不在了',
        body: '它可能已被删除，已回到最外层',
        kind: 'err',
        timeout: 2500,
      });
      return;
    }
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    openEditor(null, { start, parentId, type: parent.type || 'personal' });
  },
};

/**
 * 一句话加日程：把中文自由文本解析成草稿，然后**打开编辑框让用户确认**。
 *
 * ⚠️ 为什么是"打开编辑框"而不是"直接存"：
 *   规则解析一定会有猜错的时候（"在家写作业"里的"家"、"7点"是早是晚）。
 *   直接存的话用户得事后去列表里找出那条错的再改；
 *   而带进编辑框，用户**在保存之前**就看到"它把地点猜成家了"，顺手改掉。
 *   这也正是 core/nl-parse.js 要返回 warnings 的用途 —— 见下面把它显示出来。
 */
function naturalAdd(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return;
  const r = parseNatural(text, { now: new Date() });
  if (!r.ok) {
    toast({
      title: '没听出要加什么',
      body: '换一句试试，比如「明天下午3点 在图书馆 交作业 提前20分钟」',
      kind: 'err',
      timeout: 4200,
    });
    return;
  }
  const d = r.draft;
  openEditor(null, {
    title: d.title,
    start: d.start,
    end: d.end,
    location: d.location,
    reminders: d.reminders.length ? d.reminders : undefined,
  });
  // 把"我猜了什么"如实说出来，而不是假装解析得很确定
  if (r.warnings.length) {
    toast({ title: '解析好了，看一眼对不对', body: r.warnings.join('；'), kind: 'ok', timeout: 6500 });
  }
}

/**
 * 弹出输入框让用户打/口述一句话。
 *
 * ⚠️⚠️ **绝对不要用 `window.prompt()`**：原生壳（WKWebView）里没有实现
 *   WKUIDelegate 的输入面板回调，`prompt()` 会**静默返回 null** ——
 *   电脑浏览器上一切正常，装到 iPad 上就变成"点了没反应"。
 *   这类"只在真机上坏"的坑最难查，所以一律用项目自己的弹窗。
 */
function openNaturalAdd() {
  const input = el('input', {
    type: 'text',
    placeholder: '例如：明天下午3点 在图书馆 交作业 提前20分钟',
    style: { width: '100%' },
    // 平板上软键盘回车即提交，少点一次
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } },
  });
  const hint = el('p.tiny', {
    text: '认这些说法：今天/明天/下周三 · 3月5日 · 上午/下午/晚上/中午 · 3点半/15:30 · 1小时/半小时 · 在图书馆 · 提前20分钟',
  });
  let close = () => {};
  const go = () => {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    close();
    naturalAdd(v);
  };
  // ⚠️ openModal 返回的是 `{ panel, body, close }` **对象**，不是函数。
  close = openModal({
    title: '✍️ 一句话加日程',
    width: 460,
    body: el('div', {}, [input, hint]),
    footer: [el('button.btn.btn-primary', { text: '解析并确认', onclick: go })],
  }).close;
  // 输入框的自动聚焦由 openModal 负责（它会 focus 第一个 input）
}

/**
 * 收到原生壳送来的深链（快捷指令 / Siri 打开了 timetable://…）。
 * @returns {boolean} 是不是我们认识的深链
 */
function handleDeepLink(url) {
  const link = parseDeepLink(url);
  if (!link) return false;
  if (link.action && link.action !== 'add') {
    console.warn('[deeplink] 不认识的动作：' + link.action);
    return false;
  }
  naturalAdd(link.text);
  return true;
}

// ---- 导航渲染 ----
function renderNav() {
  const state = store.getState();
  const makeItem = (v) => el('button.nav-item', {
    type: 'button',
    'aria-current': String(state.view === v.id),
    onclick: () => {
      if (state.view !== v.id) store.setView(v.id);
    },
  }, [
    el('span.nav-ico', { text: navIcons[v.id] || '•' }),
    el('span.nav-label', { text: v.label }),
  ]);

  mount($('#nav-desk'), shellViews().map(makeItem));
  mount($('#nav-mobile'), shellViews().map(makeItem));

  // 设置 / 帮助放在桌面侧栏底部
  //
  // ⚠️ `navDesk.parentElement` 可能为空：`renderNav()` 是被 store 的**每一次变更**调用的，
  //    而它一旦抛（`Cannot read properties of null`），整条渲染链就断在那里 ——
  //    症状是"侧栏底部的工具入口/一句话加日程全都不见了"，看起来像功能丢了，
  //    其实只是一行防御没写。真实浏览器里 `#nav-desk` 一定有父级，
  //    所以这条防御只在"被当成模块 import 进 node 测试桩"这类环境下生效。
  const navDesk = $('#nav-desk');
  const foot = (navDesk && navDesk.parentElement)
    ? navDesk.parentElement.querySelector('.sidebar-foot')
    : null;
  if (foot && !foot.querySelector('.tool-nav')) {
    const box = el('div.tool-nav', { style: { display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '8px' } },
      tools.map(makeItem));
    foot.insertBefore(box, foot.firstChild);
  } else if (foot) {
    const box = foot.querySelector('.tool-nav');
    clear(box);
    tools.forEach((v) => box.appendChild(makeItem(v)));
  }

  // 「一句话加日程」入口。
  //
  // ⚠️ 为什么放在**侧栏底部**而不是某个视图里：
  //   用户主力是平板，而这个功能要"随手就能用" —— 放进某个视图（比如列表页）的话，
  //   在气泡视图里就用不到；而气泡视图恰恰是他最常用的那个。
  //   侧栏底部常驻，所有视图下都在，和小键盘快捷键（K）是同一个入口。
  if (foot && !foot.querySelector('.nl-add')) {
    const btn = el('button.nav-item.nl-add', {
      type: 'button',
      title: '用一句话加日程（快捷键 K）',
      onclick: () => openNaturalAdd(),
    }, [
      el('span.nav-ico', { text: '✍️' }),
      el('span.nav-label', { text: '一句话加日程' }),
    ]);
    foot.insertBefore(btn, foot.firstChild);
  }

  // 侧栏"展开/收起"按钮。
  //
  // 为什么需要：桌面靠 hover 展开就够了，但**平板/触屏没有 hover** ——
  // 侧栏收成 62px 图标条之后，用户**没有任何办法展开**它（只看到图标，
  // 不知道每个图标是什么）。加一个显式按钮，点一下钉住展开。
  // 桌面也受益：不用"鼠标悬着才能点"。
  const sidebar = $('#sidebar');
  if (sidebar && !sidebar.querySelector('.sidebar-toggle')) {
    const btn = el('button.sidebar-toggle', {
      type: 'button',
      title: '展开 / 收起侧栏',
      'aria-label': '展开或收起侧栏',
      text: '»',
      onclick: () => {
        const open = sidebar.classList.toggle('is-open');
        btn.textContent = open ? '«' : '»';
      },
    });
    const sfoot = sidebar.querySelector('.sidebar-foot') || sidebar;
    sfoot.appendChild(btn);
  }
}

// ---- 周期导航（上一页 / 今天 / 下一页）----
function renderPeriodNav(view) {
  const state = store.getState();
  const host = $('#period-nav');
  clear(host);
  const items = view.nav ? view.nav(state) : [];
  items.forEach((n) => host.appendChild(el(`button.btn.btn-sm${n.className ? '.' + n.className : ''}`, {
    text: n.label,
    title: n.title || '',
    onclick: () => { view.onNav?.(n.action, ctx); },
  })));
}

// ---- 主渲染 ----
let currentViewId = null;

function renderAll() {
  const state = store.getState();
  const view = allViews.find((v) => v.id === state.view) || bubbleView;
  currentViewId = view.id;

  if (state.view !== view.id) { store.setView(view.id); return; }

  document.title = (view.id === 'month' || view.id === 'bubble')
    ? '日程表 · Timetable'
    : `${view.label} · 日程表`;

  // 气泡视图把顶栏压到最小（空间全给气泡），其它视图保持原样
  document.getElementById('app').classList.toggle('view-bubble', view.id === 'bubble');

  const titleEl = $('#view-title');
  const subEl = $('#view-subtitle');
  titleEl.textContent = view.title(state) || view.label;
  subEl.textContent = view.subtitle ? view.subtitle(state) : '';

  renderNav();
  renderPeriodNav(view);

  const host = $('#view-host');
  try {
    view.render(state, ctx, host);
  } catch (err) {
    console.error('视图渲染失败', err);
    mount(host, el('div.empty', {}, [
      el('div.empty-ico', { text: '⚠' }),
      el('h3', { text: '这个视图渲染出错了' }),
      el('p.tiny', { text: String(err.message || err) }),
    ]));
  }

  // 闹钟板块的倒计时刷新（每 250ms 只重画那一行大字）。
  // ⚠️ 它**自己判断该不该跑**（不在闹钟板块 / 没有在跑的计时器 → 立刻停掉），
  //    所以这里无条件调一次是安全的；反过来"在 app.js 里判断"会让
  //    "什么时候停"散落在两个文件里 —— 那种漏停只表现成"越用越卡"。
  try {
    alarmsTick(view.id, state);
  } catch (err) {
    console.warn('[alarms] 倒计时刷新出问题', err);
  }

  renderStatus();
  renderBanners();
}

function renderStatus() {
  const state = store.getState();
  const node = $('#sidebar-status');
  if (!node) return;
  const bits = [];
  bits.push(state.online ? '● 已连接本地服务' : '○ 服务未连接（离线模式）');
  // 有待同步的改动时**优先显示这个** —— 用户最关心的是"我改的东西会不会丢"
  if (state.pending) bits.push(`${state.pending} 条待同步`);
  if (state.error && !state.pending) bits.push(state.error);
  node.textContent = bits.join(' · ');
  node.style.color = state.online ? 'var(--ok)' : 'var(--warn)';
}

// ---- 提示条：首次引导 / 通知权限 / 离线 ----
function renderBanners() {
  const state = store.getState();
  const host = $('#banner-host');
  clear(host);

  // ---- 首次引导（0.11.0「简约版」）----
  //
  // 出现条件就一条：`settings.setupDone !== true`。答完/跳过都会把它置真，
  // 所以它**只会出现一次**（除非用户自己把 db 里那个键改回来）。
  // ⚠️ 在设置页里不显示：那一页最上面就是同一个功能（三档按钮 + 差异预览），
  //    两张卡同时出现只会让人犹豫点哪个。
  // ⚠️ 判据用 `!== true`（不是 falsy）：老库里 `setupDone` 可能是 undefined，
  //    那正是"从没走过引导"的老用户 —— 他们同样该看到这张卡片一次。
  const s = state.settings || {};
  if (state.ready && s.setupDone !== true && state.view !== 'settings') {
    // `onDone` 只需要重画提示条这一块：`store.saveSettings` 内部的 setState
    // 已经会让 store 的订阅者跑一遍完整的 renderAll()（见文件末尾的 store.subscribe）。
    host.appendChild(wizardBanner({ settings: s, onDone: () => renderBanners() }));
  }

  if (!state.online && state.ready) {
    const pending = state.pending || 0;
    host.appendChild(el('div.banner.warn', {}, [
      el('b', { text: '未连接到本地服务' }),
      el('span', {
        text: pending
          // 有离线改动时，文案要说清"改动没丢、只是还没发出去"
          ? `你的改动已存在本机（${pending} 条待同步），服务恢复后会自动补发。`
          : '现在看到的是上次同步的数据。改动会存在本机，服务恢复后自动补发。',
      }),
      el('div.spacer'),
      el('button.btn.btn-sm', {
        text: pending ? '立即同步' : '重试连接',
        onclick: async () => {
          const info = await store.refresh();
          if (info && info.done) {
            toast({ title: `已同步 ${info.done} 条`, kind: 'ok' });
          } else if (info && info.failed) {
            toast({ title: '同步失败', body: info.error || '仍连不上服务', kind: 'err' });
          }
        },
      }),
    ]));
  }

  const perm = reminder.permission();
  const dismissed = sessionStorage.getItem('timetable.hideNotifyBanner') === '1';
  if (state.online && perm === 'default' && !dismissed) {
    host.appendChild(el('div.banner.info', {}, [
      el('b', { text: '开启浏览器通知' }),
      el('span', { text: '开启后，页面开着时可以在到点前精确提醒你。' }),
      el('div.spacer'),
      el('button.btn.btn-sm.btn-primary', {
        text: '开启通知',
        onclick: async () => {
          const p = await reminder.requestPermission();
          toast({
            title: p === 'granted' ? '已开启通知' : '未获得授权',
            body: p === 'granted' ? '到点会弹系统通知' : '可稍后在设置页再试',
            kind: p === 'granted' ? 'ok' : 'err',
          });
          renderBanners();
        },
      }),
      el('button.btn.btn-sm', {
        text: '以后再说',
        onclick: () => { sessionStorage.setItem('timetable.hideNotifyBanner', '1'); renderBanners(); },
      }),
    ]));
  }

  if (!state.events.length && state.ready && state.view !== 'import') {
    host.appendChild(el('div.banner', {}, [
      el('b', { text: '第一次使用？' }),
      el('span', { text: '可以先导入一份课表示例看看效果，再手动补充日程。' }),
      el('div.spacer'),
      el('button.btn.btn-sm.btn-primary', { text: '去导入课表', onclick: () => store.setView('import') }),
      el('button.btn.btn-sm', { text: '手动新建', onclick: () => ctx.newEventAt(new Date()) }),
    ]));
  }
}

// ---- 全局事件 ----
function bindGlobal() {
  document.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'new-event') ctx.newEventAt(new Date());
    if (action === 'open-settings') store.setView('settings');
  });

  document.addEventListener('keydown', (e) => {
    if (isModalOpen()) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;

    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); ctx.newEventAt(new Date()); return; }
    // K = 一句话加日程（"N" 已经被"新建"占了；选 K 是因为它不在任何输入法切换冲突里）
    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); openNaturalAdd(); return; }
    const view = allViews.find((v) => v.id === currentViewId);
    if (e.key === 'ArrowLeft') { e.preventDefault(); view?.onNav?.('prev', ctx); }
    if (e.key === 'ArrowRight') { e.preventDefault(); view?.onNav?.('next', ctx); }
    if (e.key === 't' || e.key === 'T') { view?.onNav?.('today', ctx); }
    const numMap = { '1': 'bubble', '2': 'month', '4': 'list', '5': 'course' };
    if (numMap[e.key]) store.setView(numMap[e.key]);
  });

  window.addEventListener('timetable:open-event', (e) => {
    const ev = store.eventById(e.detail?.id);
    if (ev) openEditor(ev);
  });

  /**
   * （精简版没有祝福草稿卡，所以点了祝福提醒没有可跳的地方 —— 这段监听器整块去掉了。）
   */

  window.addEventListener('timetable:test-toast', () => {
    alertToast({ title: '⏰ 测试提醒', body: '这是一条页内测试提醒（10 分钟后开始 · 教三 305）', minutes: 10 });
  });

  // 原生壳报告了"真闹钟能不能用" → 重画一次，让设置页/闹钟板块立刻显示真实状态。
  // ⚠️ 不重画的话，用户点了「申请闹钟权限」、在系统弹窗里点了允许，
  //    回来看到的还是"还没拿到权限" —— 会以为没成功，然后再点一次。
  // ⚠️ 闹钟板块也要重画：它的诊断区显示的就是这个状态。
  window.addEventListener('timetable:alarmkit', () => {
    const v = store.getState().view;
    if (v === 'settings' || v === 'alarms') renderAll();
  });

  // 壳报告了"闹钟实际排成什么样"（排了几条、每条几点、铃声文件找没找到）
  // ⚠️ 这一份是**唯一**能回答"自定义铃声到底生效没有"的东西：
  //    iOS 找不到声音文件时会静默放默认音，网页这边看不出来。
  window.addEventListener('timetable:alarms', (e) => {
    applyShellAlarms((e && e.detail) || {});
    if (store.getState().view === 'alarms') renderAll();
  });

  // 倒计时跑到 0：界面重画一次，让那条从"还剩 00:00"变成"已结束"
  window.addEventListener('timetable:alarms-tick-done', () => {
    if (store.getState().view === 'alarms') renderAll();
  });

  // 语音桥：壳报回了「提醒事项」的同步结果 ——
  //   · 有用户自己加的 → 变成真日程
  //   · 只是状态（权限/上次同步）→ 设置页重画一下
  window.addEventListener('timetable:voice', (e) => {
    const d = (e && e.detail) || {};
    if (Array.isArray(d.inbound) && d.inbound.length) {
      importVoiceItems(d.inbound).catch((err) => console.warn('[voice] 导入流程出错', err));
    } else if (store.getState().view === 'settings') {
      renderAll();
    }
  });

  // 自定义提示音：壳报回了"导入成功 / 删除结果 / 容器里有哪些文件"
  //
  // ⚠️ **落库和清理由这里做**（壳不改数据）：壳只负责"把用户选的音频转成
  //    Library/Sounds 里那个 .caf"和"容器里现在有哪些文件"这两件事。
  window.addEventListener('timetable:sound', (e) => {
    applySoundEvent((e && e.detail) || {}).catch((err) => {
      console.warn('[sound] 处理壳回报失败', err);
    });
  });

  // 页面重新可见时刷新，避免长时间挂起后数据过期
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') store.refresh({ silent: true });
  });

  window.addEventListener('online', () => store.refresh({ silent: true }));
}

/**
 * 处理壳关于"自定义提示音"的三类回报。
 *
 * 分工说清楚（这个项目一直守的那条线）：**壳不改数据**。
 *   壳负责：把用户选的音频转成 `Library/Sounds/xxx.caf`、告诉我"容器里现在有哪些"
 *   这里负责：把"哪一档用哪个音"记进 settings（那是业务）、并清掉已经不存在的那种名字
 *
 * @param {{kind:string, tier?:number, ok?:boolean, name?:string, reason?:string, files?:string[]}} d
 */
/**
 * 上一次壳报上来的自定义音名单（排序后拼成一把"键"）。
 *
 * ⚠️ 用途：判断**名单真的变了**才重排闹钟 —— `soundStatus` 在启动时、导入后、
 *    删除后都会来一次，每次都无条件重排会白折腾系统（还会和壳形成回环，这个项目栽过）。
 *    `null` = 还没收到过第一次（第一次只记录、不重排：闹钟启动时本来就会重排一遍）。
 */
let lastSoundListKey = null;

async function applySoundEvent(d) {
  const settings = store.getState().settings || {};
  const notify = settings.notify || {};
  const custom = { ...(notify.customSounds || {}) };

  if (d.kind === 'status') {
    // 壳报告容器里现存的 .caf 名单 → 把设置里那些**已经不存在的名字**清掉。
    // ⚠️ 这一步是跨设备的关键：设置会跟着数据同步，但声音文件只在那台设备上。
    //    不清的话，iPad 会拿着电脑上的文件名去要一个不存在的文件，
    //    而 iOS 找不到时**不报错**，只是没声音 —— 用户只会觉得"提醒坏了"。
    const have = new Set(Array.isArray(d.files) ? d.files : []);
    let changed = false;
    for (const [tier, name] of Object.entries(custom)) {
      if (!have.has(name)) { delete custom[tier]; changed = true; }
    }
    // ⚠️ 闹钟铃声那一档**不需要在设置里清任何东西** ——
    //    "有没有得用"的唯一判据是**容器里有没有那个文件**（就是 `d.files` 本身），
    //    而"哪条闹钟用了它"记在每条闹钟自己的 `sound` 字段里（不再另存一份）。
    //    但**名单变了就可能影响闹钟**（比如刚导入的那个文件没了，而还有闹钟指着「自定义」）：
    //    那就重排一次。否则系统里那条会指着一个不存在的文件 ——
    //    iOS 找不到时**不报错**，只是**响默认音**，用户完全无从察觉。
    //    这里做一次**便宜的比较**：名单和上次不同才重排（避免每次 status 都重排一遍）。
    const listKey = [...have].sort().join('\u0000');
    if (listKey !== lastSoundListKey) {
      const first = lastSoundListKey === null;
      lastSoundListKey = listKey;
      // 首次只是"启动时问一次"，不需要重排（闹钟本来就会在启动时重排一遍）
      if (!first) refreshAlarmSchedule();
    }
    // 闹钟板块要重画：铃声列表里「自定义」那一条的存在与否取决于这份名单
    if (store.getState().view === 'alarms') renderAll();
    if (changed) {
      await store.saveSettings({ notify: { customSounds: custom } });
      pushShellNotifications();
      // ⚠️ 只有**真的清掉了东西**才重画。无条件重画会和壳形成回环：
      //    重画设置页 → 再问一次名单 → 又收到 status → 又重画…（这个项目栽过同类）
      if (store.getState().view === 'settings') renderAll();
    }
    return;
  }

  if (d.kind === 'imported') {
    // ⚠️⚠️ 2026-10-02 合并两支：导入进来的音频**永远进「我的铃声」列表**（壳侧不再分档），
    //    所以"它是给闹钟挑的还是给通知某一档挑的"**只剩网页自己知道** ——
    //    那个信息由 `adapter/native.js` 的 `pickSoundTier` 带回来（`d.tier`）。
    //      · `d.tier === 0`（或没给）= 闹钟铃声 → **不写任何 settings**
    //        （"用户导入了哪首"的唯一事实来源是容器里有没有那个文件，
    //          而"哪条闹钟用它"记在每条闹钟自己的 `sound` 字段里；
    //          再存一份只会多一个"和实际不一致"的机会 —— 这个项目栽过好几次同类）。
    //      · `d.tier` 是通知某一档（2/3/4）= **顺手把这一档指向刚导入的这首**。
    //        这一步从 `settings.js` 的按钮回调搬到了这里：那边点完按钮只知道
    //        "消息发出去了"，**拿不到结果**；而"哪一档换成哪个文件"是必须落库的。
    const isAlarm = !(Number(d.tier) > 0);
    if (!d.ok) {
      // 取消也会走到这里 —— 别说成"失败"，用户会以为坏了
      const cancelled = /取消/.test(String(d.reason || ''));
      toast({
        title: cancelled
          ? (isAlarm ? '没有添加铃声' : '没有换提示音')
          : (isAlarm ? '这个音频没法当闹钟铃声' : '这个音频没法用'),
        body: cancelled ? '' : (d.reason || '换一段 wav / m4a / mp3 再试一次'),
        kind: cancelled ? 'ok' : 'err',
        timeout: cancelled ? 2000 : 6000,
      });
      renderAll();
      return;
    }
    if (isAlarm) {
      toast({
        title: '已导入这段音频，可以当闹钟铃声了',
        body: '铃声列表里多了一首（会显示成「自定义 · 」加一串编号）—— 选它、再用「试响」听一下真声音',
        kind: 'ok', timeout: 5200,
      });
    } else {
      custom[String(d.tier)] = d.name;
      await store.saveSettings({ notify: { customSounds: custom } });
      toast({ title: '提示音已换成你选的那段', body: '点「试听当前档」听一下', timeout: 4200 });
    }
    // 两种都要重排：
    //   · 闹钟：已经排在系统里的那条要换成刚导入的音；
    //   · 通知：`customSounds` 变了，通知的 sound 字段跟着变。
    refreshAlarmSchedule();
    pushShellNotifications();
    renderAll();
    return;
  }

  if (d.kind === 'dropped') {
    toast({
      title: d.ok ? '已删掉那个音频' : '文件没删掉',
      body: d.ok ? '' : '它可能还在 App 容器里（不影响使用）',
      kind: d.ok ? 'ok' : 'err',
      timeout: d.ok ? 2200 : 5000,
    });
    // ⚠️ 删掉文件之后要**重排闹钟**：系统里可能还有一条正指着这个文件，
    //    iOS 找不到时**不报错**，只是响默认音 —— 用户完全无从察觉。
    //    （"哪条闹钟用了它"记在每条闹钟的 `sound` 字段里，这里不用改设置；
    //      网页侧看到名单里没有它了，界面自然会提示"自定义铃声不在了"。）
    if (String(d.name || '')) refreshAlarmSchedule();
    if (store.getState().view === 'settings' || store.getState().view === 'alarms') renderAll();
  }
}

// ---- 提醒引擎接线 ----
function startReminder() {
  const settings = store.getState().settings;
  window.__timetableSettings = { sound: (settings.notify || {}).sound !== false };
  reminder.start({
    getEvents: () => store.getState().events,
    getTermStart: () => store.getState().settings.termStart,
    // 强度跟着设置走：'auto' 按剩余时间自动，1–4 强制某一档
    getSettings: () => store.getState().settings,
    alert: (payload) => alertToast(payload),
  });
}

// ---- 启动 ----
async function boot() {
  bindGlobal();

  // ⚠️ 必须在 `store.init()` **之前**把上次的模式恢复好 ——
  //    store.init() 会立刻去读数据，模式晚一步设就白读一次远程。
  const mode = applySavedMode();

  // 原生壳：让"点通知"能跳回对应日程（壳侧调 window.__timetableNative.onMessage）
  installShellReceiver((eventId) => {
    if (store.eventById(eventId)) {
      window.dispatchEvent(new CustomEvent('timetable:open-event', { detail: { id: eventId } }));
    }
  }, (url) => {    // 深链：快捷指令 / Siri 打开 timetable://add?text=…
    // 壳侧**会等网页 ready 之后才送**，所以这里不用再等状态就绪（见 App.swift 的排队注释）
    handleDeepLink(url);
  }, ({ action, eventId }) => {
    // 用户在**通知按钮**上做的动作。壳只转达，改数据在这儿。
    if (action !== 'done' || !eventId) return;
    const ev = store.eventById(eventId);
    if (!ev) {
      toast({ title: '这条日程已经不在了', body: '可能刚被删掉或完成了', kind: 'err', timeout: 4000 });
      return;
    }
    // ⚠️⚠️ **重复日程不自动标完成** —— 这是必须防的一个坑：
    //    `done` 是挂在**整条日程**上的，而重复日程（课表里的课）一条代表一整学期。
    //    在通知上点一下「完成」，会把整门课从气泡区抹掉 —— 那个"惊喜"太大了。
    //    所以重复的只跳过去，让用户自己看着办。
    if (isRecurring(ev)) {
      window.dispatchEvent(new CustomEvent('timetable:open-event', { detail: { id: ev.id } }));
      toast({
        title: '这是重复日程，没有直接标完成',
        body: '它代表一整串（比如每周的课）。想处理请在 App 里打开这一条。',
        kind: 'err',
        timeout: 7000,
      });
      return;
    }
    Promise.resolve(store.patchEvent(ev.id, { done: true }))
      .then(() => {
        toast({ title: '已完成', body: ev.title || '(无标题)', timeout: 3000 });
        renderAll();
      })
      .catch((err) => toast({ title: '标记失败', body: String((err && err.message) || err), kind: 'err', timeout: 5000 }));
  });

  store.subscribe(() => {
    const s = store.getState();
    window.__timetableSettings = { sound: (s.settings.notify || {}).sound !== false };
    renderAll();
    // 数据一变就重排系统提醒（防抖：连续改动只在停下来之后排一次）
    scheduleShellNotify();
  });

  await store.init();
  renderAll();
  startReminder();
  if (mode === 'local') console.log('[timetable] 本机独立模式：数据存在这台设备上');

  // Windows 桌面泡泡双击 → `?open=<事件 id>` → 直接打开那一条的编辑框。
  //
  // ⚠️ 为什么用 query 参数而不是深链（timetable://）：桌面泡泡是**在本机打开浏览器**，
  //    走的是普通 URL；而 `timetable://` 那条路要系统注册协议处理器（iOS 壳里才需要）。
  // ⚠️ 打开之后要把参数**从地址栏清掉**（history.replaceState）：否则用户刷新一下，
  //    编辑框会自己再弹一次 —— 那种"莫名其妙弹窗"最烦人。
  try {
    const openId = new URLSearchParams(location.search).get('open');
    if (openId) {
      const ev = store.eventById(openId);
      if (ev) openEditor(ev);
      else toast({ title: '这条日程已经不在了', body: '桌面上的那颗泡泡可能刚被完成或删掉', kind: 'err', timeout: 4500 });
      history.replaceState(null, '', location.pathname + location.hash);
    }
    // 桌面气泡层里"单击母泡泡背景 = 加子气泡" → `?addChild=<容器 id>`。
    // 走和网页里"单击背景"**同一条** ctx.addChild（它自带"容器不在了"的兜底提示），
    // 不在原生那侧重写一遍"新建子气泡"的逻辑。
    const addChildId = new URLSearchParams(location.search).get('addChild');
    if (addChildId) {
      ctx.addChild(addChildId);
      history.replaceState(null, '', location.pathname + location.hash);
    }
  } catch (err) {
    console.warn('[timetable] ?open=/?addChild= 处理失败', err);
  }

  // 原生壳里"提前把提醒注册给系统"是**唯一**必须由系统守的事（见 adapter/native.js）。
  // 每打开一次就重排一次 —— iOS 待处理本地通知有 64 条上限，
  // 重排会把时间窗往前推，远处本来的提醒又进得来。
  if (inShell()) {
    announceReady({ localMode: mode === 'local' });
    pushShellNotifications();
    // 问一次"容器里现在有哪些自定义提示音"：壳报回来之后，
    // 设置里那些**文件已经不在了**的名字会被清掉（跨设备同步的防护）。
    refreshCustomSounds();
    // 闹钟：排一次 + 问一次状态。
    // ⚠️ 每次打开 App 都重排的理由和提醒一样：**数量上限**（AlarmKit 侧 8 条），
    //    只排最近的那几条，远处的靠"每次打开往前推"补进来。
    //    ⚠️ 这里**只在 iOS 壳里**才会真的发出去（postToShell 对别的端返回 false），
    //       所以不需要额外判断 —— 但"该不该重排"的判断只能靠这个副作用，
    //       真正的门控在侧栏那份（shellViews）。
    pushAlarmSchedule();
    refreshAlarmStatus();
    refreshAlarmSchedule();
  }

  document.getElementById('app').setAttribute('aria-busy', 'false');

  // ---------------------------------------------------------------------------
  // 把"未捕获异常"变成**看得见的东西**
  // ---------------------------------------------------------------------------
  //
  // 为什么必须有这一段（这是踩了三次才补上的）：
  //   本项目已经三次出现"**点了没反应**"，而三次的根因都是**异常被静默吞掉**：
  //     ① `settings.js` 导出备份：忘了 import `openModal` → async 函数里抛 →
  //        变成"未处理的 Promise 拒绝"，界面上什么都没有
  //     ② `bubble.js` 的 rAF 循环里写了 `state.events` → 每帧抛一次，异常**打断帧循环**
  //     ③ `renderPanel` 里引用自由变量 `state` → 抛在 **340ms 的 setTimeout 回调**里，
  //        连控制台都不一定有人看，而它后面那句"加子泡泡"永远不会执行
  //         —— 这就是用户报的"单击母气泡背景无响应"。**我为此白跑了两轮排查。**
  //
  //   规律很清楚：**用户看不到报错，就会把"坏了"说成"没反应"**，
  //   而"没反应"能对应十几种根因。把它弹出来，排查成本立刻从"猜"变成"读"。
  //
  // 只做两件事：控制台照旧输出（给开发看）+ 界面弹一条 toast（给用户/给现场看）。
  // 同一条消息 8 秒内只弹一次，避免帧循环那种"每帧一次"把屏幕刷爆。
  const reported = new Map();
  function reportUncaught(kind, err) {
    const msg = String((err && (err.message || err.reason && err.reason.message)) || err || '未知错误');
    console.error(`[timetable] ${kind}：`, err);
    const now = Date.now();
    if (reported.has(msg) && now - reported.get(msg) < 8000) return;
    reported.set(msg, now);
    try {
      toast({
        title: kind === 'promise' ? '有个操作没做完' : 'App 出了个错',
        body: `${msg}（这条信息是给排查用的，不是你的操作问题）`,
        kind: 'err',
        timeout: 8000,
      });
    } catch { /* toast 自己炸了就不能再抛，否则递归 */ }
  }
  window.addEventListener('error', (e) => reportUncaught('error', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => reportUncaught('promise', e.reason));

  if (!store.getState().online) {
    toast({
      title: '离线模式',
      body: '未连接到本地服务。**你的改动会存在本机**，服务恢复后自动补发。',
      kind: 'warn',
      timeout: 6000,
    });
  }

  // PWA：注册 Service Worker（方案 C 的地基；离线访问用）
  //
  // ⚠️ `'serviceWorker' in navigator` 为真**不代表**它是一个可用的对象：
  //    有的环境（原生壳、被当成模块 import 进 node 测试桩）会把键定义出来但值是 undefined。
  //    不挡这一下，后面那句 `addEventListener` 会在 boot 的**最后一步**抛出去 ——
  //    报出来的是"启动失败"，而实际上整页都好了，只差 SW 没注册。
  if (navigator.serviceWorker && typeof navigator.serviceWorker.addEventListener === 'function'
    && location.protocol.startsWith('http')) {
    // 新版本 SW 接手时自动刷新一次：否则用户会一直被旧页面"钉"住，
    // 界面改了却看不到（缓存是 network-first，但当前这次会话仍是旧 JS）。
    const reloadKey = 'timetable.reloadedForSw';
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (sessionStorage.getItem(reloadKey) === '1') return;
      sessionStorage.setItem(reloadKey, '1');
      location.reload();
    });
    navigator.serviceWorker.register('/sw.js').catch(() => { /* 失败不影响主流程 */ });
  }
}

boot().catch((err) => {
  console.error('启动失败', err);
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:16px;font:14px system-ui">启动失败：${String(err.message || err)}</div>`);
});
