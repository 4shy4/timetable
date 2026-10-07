// 气泡区的**手势接线 + 环 + 诊断角标**回归测试（假 DOM + 假 canvas + 真定时器 + 手动帧）。
//
// ===========================================================================
// 为什么必须有这个文件（它钉住的是"25 条全绿却真机失效"的那个盲区）
// ===========================================================================
//
// 上一轮的报障是：**iPad 上长按 2.5 秒完全没看到进度环**，用户补了一句关键线索
// "只有长按不行"（单击弹编辑器、双击进母泡泡都正常），而且**电脑上用鼠标长按也一样没环**。
//
// `tools/bubble-longpress.test.mjs`（25 条）与 `tools/bubble-view-dom.test.mjs`（11 条）
// 当时**全是绿的** —— 因为它们测的是"手势状态机会不会戳破"，而**环是画出来的**，
// 没有任何一条断言看过"画了什么"。真凶就在这个缝里：
//
//   · 那些数字现在集中产在 `core/bubble-draw-numbers.js`，名字叫 **`holdProgress`**；
//   · 而 `web/ui/views/bubble.js` 画进度环时读的是 **`v.hold`** ——
//     读错名字**不会抛**，只会让 `v.hold === undefined`，
//     于是 `undefined > 0.001` **恒为 false**，那两句 arc/stroke **一次都没执行过**；
//   · `tools/bubble-finite.test.mjs` 里复刻绘制形状时用的是**正确**名字
//     （它写 `v.holdProgress`）→ **产出方被测住了，消费方读错名字没人管**。
//   症状：跨设备、跨平台、所有泡泡都一样 —— 静默、无害、只丢一个视觉反馈。
//
// 所以这个文件做三件别处没做的事：
//   ① **字段对账**：把 `drawNumbersOf()` 真返回的键，和 `paintBubble` 里读的每一个
//      `v.<字段>` 逐个比对 —— 少一个就红。这类 bug 从此不靠人眼（★ 第 3 组）。
//   ② **真的看那一笔**：用手动帧驱动真帧循环，在假 canvas 上找"进度环那一笔"
//      （唯一以 `-π/2` 起笔的 arc），断言它**确实被画出来了**。
//   ③ **按在泡泡圆心**：普通泡泡 / 节日泡泡各一组，断言 `holding` 被置起
//      （不是被判成背景）、通道是哪条、以及环真的画出来。
//
// 另外还钉住这次新加的三样：**touch 兜底通道**（pointer 一条都不发也能长按）、
// **诊断角标**（计数/取消原因/版本，且 `pointer-events: none` 不吃手势）、
// 以及 `stop()` 真的把 9 个监听（含 4 个 touch）全摘掉。
//
// 跑法：`node tools/bubble-longpress-hooks.test.mjs`
//
// ⚠️ 一个文件一个进程：这个沙箱里 `node --test` 多文件会 `spawn EPERM`。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { drawNumbersOf } from '../core/bubble-draw-numbers.js';
import { selectBubbleItems } from '../core/bubble-select.js';
import { festivalEvents } from '../core/holidays.js';
import { DIAG_KEY } from '../web/ui/bubble-diag.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ===========================================================================
// 假 DOM —— 刻意做成**和真机一样"不友好"**，别改回"一切都从 0,0 开始"
// ===========================================================================
//
// ⚠️⚠️ 三条刻意的设置，每一条都是为了"让假 DOM 不再比真机宽松"：
//   ① **画布不在原点**（left=120, top=64）：真页面上画布左边有侧栏、上边有顶栏。
//      假 DOM 里所有盒子从 0,0 开始的话，"把视口坐标和画布内坐标混用"这类错误
//      永远测不出来（混着用还刚好能对上）。
//   ② **DPR = 2**：真平板上就是 2/3。`setTransform(dpr,…)` 之后坐标口径必须还是 CSS px。
//   ③ **假 canvas 会抛**：任何非有限数参数当场抛，和 WebKit 一样。
//      未知属性一律"可调用的空方法"（这样 canvas 将来多一个方法也不用改桩）。
const VIEW = { left: 120, top: 64, width: 900, height: 640 };

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this.attributes = {};
    this._classes = new Set();
    const classes = this._classes;
    this.classList = {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on === undefined
        ? (classes.has(c) ? classes.delete(c) : classes.add(c))
        : (on ? classes.add(c) : classes.delete(c))),
    };
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = '';
    this.width = 0;
    this.height = 0;
  }

  // ⚠️ `className` 与 `classList` 必须是同一份数据的两个视图（第一版做成两份，
  //    `el('canvas.bubble-canvas')` 在 classList 里查不到，假失败浪费过一整轮）。
  get className() { return [...this._classes].join(' '); }
  set className(v) {
    this._classes.clear();
    for (const c of String(v || '').split(/\s+/)) if (c) this._classes.add(c);
  }

  get children() { return this.childNodes; }
  get parentElement() { return this.parentNode; }
  get firstChild() { return this.childNodes[0] || null; }
  get offsetWidth() { return VIEW.width; }
  get offsetHeight() { return VIEW.height; }
  get clientWidth() { return VIEW.width; }
  get isConnected() { return true; }

  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  removeChild(n) { this.childNodes = this.childNodes.filter((c) => c !== n); return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { if (n === this) return true; return this.childNodes.some((c) => c.contains && c.contains(n)); }
  setAttribute(k, v) {
    this.attributes[k] = v;
    /**
     * ⚠️⚠️ `hidden` 属性与 `hidden` 这个 IDL 属性在真 DOM 里是**同一份数据**
     *    （设属性 = 元素真的 `display:none`）。第一版把它们当成两件事，
     *    于是 `el(..., { hidden: true })`（走的是 setAttribute）在假 DOM 里
     *    **根本不隐身** —— 命中测试就报"最上层是 .bubble-panel"，
     *    看起来像产品有个大 bug，其实是假 DOM 不够真。
     *    和 `className`/`classList` 那一条是同一类教训（见上面 get className 的注释）。
     */
    if (k === 'hidden') this.hidden = true;
  }
  getAttribute(k) {
    if (k === 'hidden') return this.hidden ? '' : undefined;
    return this.attributes[k];
  }
  removeAttribute(k) {
    delete this.attributes[k];
    if (k === 'hidden') this.hidden = false;
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return false; }
  // ⚠️ 第 3 个参数（`{passive:true}` / capture）故意忽略：真实 DOM 里
  //    removeEventListener 只按 (type, fn, capture) 匹配，我们没用 capture，所以按类型数就够。
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, []);
    this.listeners.get(t).push(fn);
  }
  removeEventListener(t, fn) {
    const a = this.listeners.get(t) || [];
    this.listeners.set(t, a.filter((x) => x !== fn));
  }
  countListeners(t) { return (this.listeners.get(t) || []).length; }
  dispatchEvent(e) {
    e.target = e.target || this;
    let node = this;
    while (node) {
      for (const fn of [...(node.listeners.get(e.type) || [])]) fn(e);
      node = node.parentNode;
    }
    return true;
  }
  querySelector(sel) {
    const want = String(sel).replace(/^\./, '');
    const walk = (n) => {
      if (n.classList.contains(want)) return n;
      for (const c of n.childNodes) { const hit = walk(c); if (hit) return hit; }
      return null;
    };
    for (const c of this.childNodes) { const hit = walk(c); if (hit) return hit; }
    return null;
  }
  querySelectorAll() { return []; }
  getBoundingClientRect() {
    return {
      x: VIEW.left, y: VIEW.top, left: VIEW.left, top: VIEW.top,
      right: VIEW.left + VIEW.width, bottom: VIEW.top + VIEW.height,
      width: VIEW.width, height: VIEW.height,
    };
  }
  getContext() { return recorder.ctx; }
  focus() {}
  blur() {}
}

/** 记录每一次 canvas 调用；**非有限数参数当场抛**（和 WebKit 行为一致） */
function makeRecorder() {
  const calls = [];
  const push = (name, args) => {
    calls.push({ name, args });
    for (const a of args) {
      if (typeof a === 'number' && !Number.isFinite(a)) {
        throw new Error(`Failed to execute '${name}': The provided double value is non-finite`);
      }
    }
  };
  const ctx = new Proxy({ calls }, {
    get(_t, prop) {
      if (prop === 'calls') return calls;
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'measureText') return (s) => { calls.push({ name: 'measureText', args: [s] }); return { width: String(s || '').length * 7 }; };
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
        return (...a) => { push(String(prop), a); return { addColorStop: () => {} }; };
      }
      if (prop === 'canvas') return null;
      return (...a) => { push(String(prop), a); return undefined; };
    },
    set(_t, prop, v) {
      if (typeof v === 'number' && !Number.isFinite(v)) {
        throw new Error(`给 canvas.${String(prop)} 赋了非有限数`);
      }
      return true;
    },
  });
  return { ctx, calls };
}
const recorder = makeRecorder();

/** 手动帧：`requestAnimationFrame` 只入队，由 `runFrames()` 精确推进（可复现） */
const rafQueue = [];
function runFrames(n) {
  for (let i = 0; i < n; i += 1) {
    const cb = rafQueue.shift();
    if (!cb) return i;                 // 循环已经停了（stop() 之后就是这样）
    cb(performance.now());
  }
  return n;
}
/** 驱动一帧并等到"进度真的走了一点"——`gesture.progress()` 读的是真 `performance.now()` */
async function frameAfter(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(20);
    runFrames(1);
  }
}

function installFakeGlobals() {
  const kv = new Map();
  const makeStorage = () => ({
    getItem: (k) => (kv.has(k) ? kv.get(k) : null),
    setItem: (k, v) => kv.set(k, String(v)),
    removeItem: (k) => kv.delete(k),
    clear: () => kv.clear(),
  });
  const docListeners = new Map();
  const winListeners = new Map();
  const body = new FakeNode('body');
  const byId = new Map();
  const document = {
    body,
    hidden: false,
    visibilityState: 'visible',
    createElement: (t) => new FakeNode(t),
    createTextNode: (t) => { const n = new FakeNode('#text'); n.textContent = String(t); return n; },
    getElementById: (id) => {
      if (!byId.has(id)) { const n = new FakeNode('div'); n.id = id; body.appendChild(n); byId.set(id, n); }
      return byId.get(id);
    },
    querySelector: (sel) => (String(sel).startsWith('#') ? document.getElementById(String(sel).slice(1)) : null),
    querySelectorAll: () => [],
    addEventListener: (t, fn) => {
      if (!docListeners.has(t)) docListeners.set(t, []);
      docListeners.get(t).push(fn);
    },
    removeEventListener: (t, fn) => {
      const a = docListeners.get(t) || [];
      docListeners.set(t, a.filter((x) => x !== fn));
    },
    __count: (t) => (docListeners.get(t) || []).length,
    __fire: (t, e) => { for (const fn of docListeners.get(t) || []) fn(e || {}); },
  };
  const window = {
    devicePixelRatio: 2,
    location: { search: '', href: 'http://127.0.0.1:17801/index.html' },
    addEventListener: (t, fn) => {
      if (!winListeners.has(t)) winListeners.set(t, []);
      winListeners.get(t).push(fn);
    },
    removeEventListener: (t, fn) => {
      const a = winListeners.get(t) || [];
      winListeners.set(t, a.filter((x) => x !== fn));
    },
    __count: (t) => (winListeners.get(t) || []).length,
  };
  globalThis.document = document;
  globalThis.window = window;
  // ⚠️ Node 的 `navigator` 是只读 getter，直接赋会抛（第一版就死在这一行）
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node-probe' }, configurable: true });
  }
  globalThis.localStorage = makeStorage();
  globalThis.sessionStorage = makeStorage();
  globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; } };
  globalThis.Node = FakeNode;
  globalThis.Element = FakeNode;
  globalThis.Event = class { constructor(t) { this.type = t; } };
  globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  globalThis.location = window.location;
  /**
   * 假 `fetch` —— "戳破真的走到服务端了吗"的唯一可靠观察点。
   * ⚠️ 不给 `store.popEvent` 打桩：ES 模块的命名空间对象是**只读**的，
   *    赋值会抛 `Cannot assign to read only property`（第一版就死在这一行）。
   */
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
    const u = String(url);
    let payload = {};
    if (u.includes('/api/state')) payload = { events: [], settings: {}, courses: [] };
    else if (u.includes('/pop')) payload = { released: [], mode: 'single' };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  };
  return { document, window, calls, storage: globalThis.localStorage };
}

// ⚠️ 环境必须在**动态 import 之前**装好（bubble.js 模块体里就读 window/location）。
const env = installFakeGlobals();
const { bubbleView } = await import('../web/ui/views/bubble.js');

/**
 * 收尾：**无论上面的用例红不红**，都要把诊断心跳停掉。
 *
 * ⚠️ 为什么必须有：角标开着时会起一个 200ms 的 `setInterval`。如果某条断言在
 *    "关掉角标"那一步之前就失败了，这个定时器就会一直活着 ——
 *    **测试全绿也永不退出**（node:test 打完结语还在等事件循环）。
 *    这个项目在 reminder 的两个定时器上踩过同一个坑（见 tools/web-modules.test.mjs）。
 *    再渲染一次（带一颗泡泡）会 `stopActiveSimulation()` 把上一个视图停掉 ——
 *    定时器在 `stop()` 里被清。注意**不能**用空 events 渲染：那条路径会在
 *    `stopActiveSimulation()` **之前**就 return（走空状态）。
 */
test.after(() => {
  try {
    env.storage.setItem(DIAG_KEY, '0');
    const host = new FakeNode('div');
    bubbleView.render(
      { events: [makeEvent('cleanup', '收尾')], settings: { ...BASE_SETTINGS }, courses: [], health: {} },
      { newEventAt() {}, addChild() {}, editEvent() {}, toast() {}, refresh() {} },
      host,
    );
  } catch { /* 收尾自己不许把结果搅浑 */ }
});

// ===========================================================================
// 小工具
// ===========================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = () => new Promise((r) => setTimeout(r, 0));
const popRequests = () => env.calls.filter((c) => c.method === 'POST' && /\/pop$/.test(c.url));
const resetCalls = () => { env.calls.length = 0; };

const BASE_SETTINGS = {
  termStart: '2026-03-02', termWeeks: 18, defaultReminders: [10, 0],
  notify: { desktop: true, browser: true, sound: true }, sectionTimes: [{ index: 1, start: '08:00', end: '08:45' }],
};

function makeEvent(id, title, extra = {}) {
  const now = Date.now();
  return {
    id, title, level: 'red', done: false,
    start: new Date(now + 3 * 3600_000).toISOString(),
    end: new Date(now + 4 * 3600_000).toISOString(),
    ...extra,
  };
}

/** 把 render() 跑起来，返回画布（以及便于断言的小工具） */
function renderView({ events, settings, editEvent, refresh, health } = {}) {
  const host = new FakeNode('div');
  const ctx = {
    newEventAt() {}, addChild() {},
    editEvent: editEvent || (() => {}),
    toast() {},
    refresh: refresh || (() => {}),
  };
  bubbleView.render(
    { events: events || [], settings: { ...BASE_SETTINGS, ...(settings || {}) }, courses: [], health: health || {} },
    ctx,
    host,
  );
  const canvas = findByClass(host, 'bubble-canvas');
  assert.ok(canvas, '渲染结果里必须有 .bubble-canvas（渲染路径变了？）');
  return { host, canvas, ctx };
}

function findByClass(node, cls) {
  if (node.classList && node.classList.contains(cls)) return node;
  for (const c of node.childNodes || []) { const hit = findByClass(c, cls); if (hit) return hit; }
  return null;
}

/** 只读快照里按标题挑我们那颗泡泡（气泡区默认还会浮出节日泡泡，拿 bodies[0] 会挑错） */
function bubbleByTitle(title) {
  const all = (globalThis.window.__bubbleBodies ? globalThis.window.__bubbleBodies() : []);
  const hit = all.find((b) => b.title === title);
  assert.ok(hit, `快照里找不到「${title}」；实际有：${JSON.stringify(all.map((b) => b.title))}`);
  return hit;
}

/** 画布内坐标 → 视口坐标（假 DOM 里画布**不在原点**，正是为了抓"两套坐标混用"） */
const atBubble = (b) => ({ clientX: VIEW.left + b.x, clientY: VIEW.top + b.y });
const pointer = (canvas, type, e = {}) => ({
  type, pointerId: 1, pointerType: 'mouse', isPrimary: true, target: canvas, ...e,
});
/** 归一化的触摸事件（形状与真实 TouchEvent 一致：touches / changedTouches / identifier） */
const touch = (canvas, type, t, others = 0) => {
  const list = [{ identifier: t.id === undefined ? 7 : t.id, clientX: t.x, clientY: t.y }];
  return {
    type,
    target: canvas,
    touches: type === 'touchend' || type === 'touchcancel' ? [] : list,
    changedTouches: list,
    __others: others,
  };
};
const gestureState = () => globalThis.window.__bubbleGestureState();
const diagState = () => globalThis.window.__bubbleDiag();

/** 从 canvas 调用记录里挑"进度环那一笔"：唯一以 `-π/2` 起笔的 arc（bubble.js 的 7b 段） */
const ringArcs = (calls) => calls.filter((c) => c.name === 'arc' && c.args[3] === -Math.PI / 2);

/** 读真 CSS 里某条规则的声明块（只取第一个 `{…}`，所以 `.bubble-diag[hidden]` 不会被误抓） */
function cssDecls(file, selector) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`).exec(text);
  assert.ok(m, `在 ${file} 里找不到规则 ${selector}（改了名？这条断言要靠它定位）`);
  return m[1];
}
const cssProp = (file, selector, prop) => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(cssDecls(file, selector));
  return m ? m[1].trim() : '';
};

// ===========================================================================
// ① 监听必须真的挂上（这次多了一整条 touch 通道）
// ===========================================================================
test('① canvas 上 pointer 四条 + touch 四条 + contextmenu 各挂了 1 个监听', () => {
  const { canvas } = renderView({ events: [makeEvent('e1', '交实验报告')] });
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel',
    'touchstart', 'touchmove', 'touchend', 'touchcancel', 'contextmenu']) {
    assert.equal(canvas.countListeners(t), 1,
      `canvas 上 ${t} 的监听数不对（${canvas.countListeners(t)}）：`
      + 'pointer 少了长按可能压根进不来；touch 少了"只给 touch 不给 pointer"的设备就彻底没反应；'
      + 'cancel 少了状态复位不干净（掐断一次之后再也不灵）');
  }
  assert.equal(env.document.__count('visibilitychange'), 1);
  assert.equal(env.window.__count('blur'), 1);
});

test('①b stop() 之后 9 个监听**全部**摘掉（含 4 个 touch）', () => {
  const first = renderView({ events: [makeEvent('e1', '旧视图')] });
  // 再渲染一次 → 内部 stopActiveSimulation() 会停掉上一个视图
  renderView({ events: [makeEvent('e2', '新视图')] });
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel',
    'touchstart', 'touchmove', 'touchend', 'touchcancel', 'contextmenu']) {
    assert.equal(first.canvas.countListeners(t), 0,
      `停掉的视图上 ${t} 还挂着监听：旧视图会继续驱动一个已经死掉的手势状态机`
      + '（"已经不在屏幕上的泡泡被戳破"那类怪事就是这么来的）');
  }
});

// ===========================================================================
// ② 命中测试：画布中央最上层必须是 canvas（不是面板/提示/母泡泡层）
// ===========================================================================
//
// ⚠️ 假 DOM 没有排版引擎，"盒子在哪"只能手写（下面 BOXES）；但**"谁在上、谁能吃事件"
//    这两条是从真 CSS 里读出来的**（`pointer-events` / `z-index`），不是抄的常量 ——
//    所以"谁哪天把 `.bubble-inside-hint` 的 pointer-events 去掉"，这里立刻红。
test('② 画布中央的最上层元素是 canvas（覆盖层要么 hidden，要么 pointer-events:none）', () => {
  const { host, canvas } = renderView({ events: [makeEvent('e1', '命中测试')] });
  const stage = canvas.parentNode;
  assert.ok(stage && stage.classList.contains('bubble-stage'), '画布必须挂在 .bubble-stage 里');

  /**
   * 每个覆盖层的盒子（画布内坐标，单位 px）。**只写几何**；能不能吃事件、谁在上面，
   * 一律去真 CSS 里查。数值来自各条规则本身（见注释）。
   */
  const BOXES = {
    'bubble-canvas': { x: 0, y: 0, w: VIEW.width, h: VIEW.height },
    'bubble-tap-ripple': { x: 0, y: 0, w: 34, h: 34 },                      // width/height:34px，位置由内联 style 给（按下前在 0,0）
    'bubble-hud': { x: 0, y: 0, w: VIEW.width, h: 38 },                     // left/top/right:10px + 胶囊高约 28
    'bubble-inside-hint': { x: 0, y: 0, w: VIEW.width, h: VIEW.height },    // inset: 0（**盖满整个画布**）
    'bubble-panel': { x: 0, y: VIEW.height * 0.38, w: VIEW.width, h: VIEW.height * 0.62 },  // bottom:0 + max-height:62%
    'bubble-hold-hint': { x: VIEW.width / 2 - 120, y: VIEW.height - 44, w: 240, h: 30 },    // bottom:14px 居中
    'bubble-diag': { x: 0, y: VIEW.height - 34, w: 300, h: 30 },            // left/bottom: 8px
    'bubble-dropzone': { x: -240, y: 0, w: 240, h: VIEW.height },           // position:fixed 盖左侧栏（在画布**外面**）
  };
  const CSS_FILE = {
    'bubble-canvas': 'web/css/views.css',
    'bubble-tap-ripple': 'web/css/views.css',
    'bubble-hud': 'web/css/views.css',
    'bubble-inside-hint': 'web/css/views.css',
    'bubble-panel': 'web/css/views.css',
    'bubble-hold-hint': 'web/css/views.css',
    'bubble-diag': 'web/css/views.css',
    'bubble-dropzone': 'web/css/layout.css',
  };

  const point = { x: VIEW.width / 2, y: VIEW.height / 2 };
  const candidates = [];
  stage.childNodes.forEach((node, i) => {
    const cls = [...node._classes][0];
    const box = BOXES[cls];
    assert.ok(box, `覆盖层 .${cls} 没有登记盒子 —— 新加图层的工位请补一行（否则命中测试看不见它）`);
    if (node.hidden) return;                                          // display:none：浏览器不参与命中
    const pe = cssProp(CSS_FILE[cls], `.${cls}`, 'pointer-events');
    if (pe === 'none') return;                                        // 明确不吃事件
    const covers = point.x >= box.x && point.x <= box.x + box.w
      && point.y >= box.y && point.y <= box.y + box.h;
    if (!covers) return;
    const z = Number(cssProp(CSS_FILE[cls], `.${cls}`, 'z-index')) || 0;
    candidates.push({ cls, z, i });
  });

  candidates.sort((a, b) => (a.z - b.z) || (a.i - b.i));
  const top = candidates[candidates.length - 1];
  assert.ok(top, '画布中央一个候选元素都没有？—— 说明画布自己都没被算进来');
  assert.equal(top.cls, 'bubble-canvas',
    `画布中央最上层是 .${top.cls}（z-index ${top.z}）而不是 canvas —— `
    + '它会把长按手势吃掉（"没反应"），而单击/双击也会一起废，用户报的正是"只有长按不行"');

  // 顺带把"不许挡住画布"的硬规矩逐条钉住：这几层平时必须是收起来的
  for (const cls of ['bubble-panel', 'bubble-hold-hint', 'bubble-inside-hint', 'bubble-diag', 'bubble-dropzone']) {
    const node = stage.childNodes.find((n) => n.classList.contains(cls));
    assert.ok(node && node.hidden === true, `.${cls} 默认必须是 hidden（它会盖在画布上）`);
  }
  // 而"装饰/提示"这条线绝不能吃手势（改掉就是更糟的 bug：为了看见反应而挡住反应）
  for (const cls of ['bubble-tap-ripple', 'bubble-hold-hint', 'bubble-inside-hint', 'bubble-diag']) {
    assert.equal(cssProp('web/css/views.css', `.${cls}`, 'pointer-events'), 'none',
      `.${cls} 必须 pointer-events: none（它是装饰/提示/诊断，绝不能吃掉长按）`);
  }
  // HUD 的**容器**也不吃手势（只有它里面那几颗胶囊吃）
  assert.equal(cssProp('web/css/views.css', '.bubble-hud', 'pointer-events'), 'none');
});

// ===========================================================================
// ③ ★ 字段对账：paintBubble 读的字段必须由 drawNumbersOf 提供
// ===========================================================================
//
// 这一组是"环永远不出现"的**根治**：那种错（读错名字）不抛、不报、只让条件恒假，
// 任何"行为测试"都抓不到，只有"把两边名字对一遍"能抓。
test('③ ★ 字段对账：paintBubble 里每个 v.<字段> 都必须是 drawNumbersOf 真返回的键', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web/ui/views/bubble.js'), 'utf8');
  const start = src.indexOf('function paintBubble');
  assert.ok(start > 0, '找不到 paintBubble —— 这个断言靠它定位');
  const rest = src.slice(start + 'function paintBubble'.length);
  const nextFn = rest.indexOf('\nfunction ');
  const body = rest.slice(0, nextFn > 0 ? nextFn : rest.length)
    // ⚠️ 必须先去注释：注释里会出现 `v.hold === undefined` 这种**说明文字**，
    //    不去掉就会把说明当成一次真实读取（本文件第一版就是这么假红的）。
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');

  const reads = new Set();
  for (const m of body.matchAll(/\bv\.([A-Za-z_$][\w$]*)/g)) reads.add(m[1]);
  for (const m of body.matchAll(/const\s*\{([^}]*)\}\s*=\s*v\b/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim().split('=')[0].trim();
      if (name) reads.add(name);
    }
  }
  assert.ok(reads.size > 40, `只扫到 ${reads.size} 个字段读取，扫描逻辑可能失效了`);

  const item = {
    event: { id: 'e1', title: '交实验报告', level: 'red' },
    style: { tierKey: 'red', level: { key: 'red', rank: 4 }, magnitude: 4, alpha: 1, done: false, dimmed: false },
  };
  const calc = drawNumbersOf(item, { x: 300, y: 200, r: 80, theta: 0, squash: 0, hold: 0.5, shakeX: 0 }, {
    measure: (t) => ({ lines: [t], fontSize: 18 }),
  });
  const have = new Set(Object.keys(calc.values));
  const missing = [...reads].filter((k) => !have.has(k)).sort();
  assert.deepEqual(missing, [],
    `paintBubble 读了 drawNumbersOf **不提供**的字段：${missing.join(', ')} —— `
    + '读错名字不会抛异常，只会让判断恒为 false（"长按那圈红环从 v17 起一次都没画出来"就是这么来的）');

  // 再把这一条本身钉死：进度环必须读 holdProgress
  assert.ok(/\bv\.holdProgress\s*>/.test(body), '进度环的判据必须读 v.holdProgress');
  assert.ok(have.has('holdProgress') && have.has('holdRingR') && have.has('holdWidth'),
    'drawNumbersOf 必须提供 holdProgress / holdRingR / holdWidth 三件');
});

// ===========================================================================
// ④ ★ 按在**普通泡泡**圆心：hold 被置起 + 环真的画出来
// ===========================================================================
test('④ ★ 按普通泡泡圆心 → pointerdown 到达、hold 置起（通道=pointer）、环真的画出来', async () => {
  recorder.calls.length = 0;
  const { canvas } = renderView({ events: [makeEvent('e1', '长按要看见环')] });
  const b = bubbleByTitle('长按要看见环');
  const p = atBubble(b);

  canvas.dispatchEvent(pointer(canvas, 'pointerdown', p));
  const st = gestureState();
  assert.equal(st.holding, true, '按在泡泡圆心上却没进 hold —— 说明被当成背景了（长按永远不会开始）');
  assert.ok(st.target, 'hold 的目标必须是那颗泡泡');
  assert.equal(st.channel, 'pointer', '这次手势应归 pointer 通道');
  assert.equal(diagState().down, 1, 'pointerdown 必须被记到（角标是"事件到没到"的唯一证据）');
  assert.equal(diagState().ev, 'pointer');

  // ⚠️ 这一段专治"两套坐标混用 → 第一次 pointermove 就把长按取消"那一类假设。
  //    假画布刻意**不在原点**（left=120, top=64）：如果实现把 `clientX`（视口坐标）
  //    和画布内坐标混着比，那么**第一条 pointermove** 算出的"离按下点的距离"就会是 ~120px
  //    → 立刻 > `MAX_HOLD_SLOP_PX`(60) → `clearHold('drifted-too-far')` →
  //    **环还没出现就没了**，而单击/双击毫发无损（正是用户报的形状）。
  //    这里连发 5 条 1px 抖动：既不许取消，也不许出现任何"结束"记录。
  for (let i = 1; i <= 5; i += 1) {
    canvas.dispatchEvent(pointer(canvas, 'pointermove', { clientX: p.clientX + i, clientY: p.clientY }));
    assert.equal(gestureState().holding, true,
      `第 ${i} 次 1px 抖动就把长按取消了 —— 坐标口径混了（视口 vs 画布内）`);
    assert.equal(diagState().holdOutcome, '',
      `按住最初这一段里**不许有任何 clearHold/reset**，却留下了「${diagState().holdOutcome}」`);
  }

  // 按住期间推进几帧（进度读真 performance.now，所以要真的等一点时间）
  recorder.calls.length = 0;
  await frameAfter(220);
  const arcs = ringArcs(recorder.calls);
  assert.ok(arcs.length > 0,
    '按住 220ms 后**没有画出进度环那一笔** —— 这就是用户报的"完全没看到环"'
    + '（环的判据读错字段名时，这条会是红的；§3 的字段对账是它的根治）');
  const ring = arcs[arcs.length - 1];
  assert.ok(Math.abs(ring.args[2] - b.r * 1.22) < 2,
    `环的半径应该是 r*1.22≈${(b.r * 1.22).toFixed(1)}，实际 ${ring.args[2]}`);
  const sweep = ring.args[4] - ring.args[3];
  assert.ok(sweep > 0 && sweep < Math.PI * 2, `环的弧长必须"走了一部分"（0–2π），实际 ${sweep}`);
  assert.equal(gestureState().holding, true, '推进几帧不该取消长按（"按下就被清掉"是另一个经典故障）');

  canvas.dispatchEvent(pointer(canvas, 'pointerup', p));
  assert.equal(gestureState().holding, false);
  assert.match(diagState().holdOutcome, /^结束:pointerup@/, `按住结束的结局要写进角标，实际 ${diagState().holdOutcome}`);
});

// ===========================================================================
// ⑤ ★ 按在**节日泡泡**圆心：同样三条
// ===========================================================================
//
// ⚠️ 为什么这么造数据（而不是等日历上真有节日）：
//    日历生成的节日泡泡要看**当天日期**（`festivalEvents(now)`），测试会时灵时不灵。
//    这里从 `festivalEvents()` 里取一条**真的节日事件**（真的 id 形如
//    `festival:<key>:<date>`、真的有 `festivalKey`），把它的时间挪到眼前塞进 state ——
//    于是"节日泡泡特有的那两件事"（**节日图案绘制** + **特殊 id**）都真的走到了，
//    而日期是确定的。日历那一支的字段是否齐全由 `bubble-select` 的测试钉着。
test('⑤ ★ 按节日泡泡圆心 → hold 置起 + 环画出来（节日图案那条链不会把它吃掉）', async () => {
  const found = (() => {
    // 从一个固定日期往后找，第一个能拿到节日事件的日子（确定、可复现）
    for (let i = 0; i < 400; i += 1) {
      const d = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000);
      const list = festivalEvents(d, { days: 4, majorOnly: true });
      if (list.length) return { list, at: d };
    }
    return null;
  })();
  assert.ok(found, 'festivalEvents 在 400 天里一个节日都没给出来 —— 日历模块坏了？');

  // 日历生成的节日 **item**：字段是否齐全（id 前缀 / style.festival / 三个环的数字）
  const calItem = selectBubbleItems([], { now: found.at, festivalDays: 4 })[0];
  assert.ok(calItem, '固定 now 下 selectBubbleItems 必须产出节日泡泡');
  assert.match(calItem.event.id, /^festival:/, `节日事件的 id 必须有 festival: 前缀，实际 ${calItem.event.id}`);
  assert.equal(calItem.style.festival, true);
  const calCalc = drawNumbersOf(calItem, { x: 300, y: 200, r: 72, theta: 0, squash: 0, hold: 0.4, shakeX: 0 },
    { measure: (t) => ({ lines: [t], fontSize: 18 }) });
  for (const k of ['holdProgress', 'holdRingR', 'holdWidth']) {
    assert.ok(Number.isFinite(calCalc.values[k]), `节日泡泡的 ${k} 必须是有限数（实际 ${calCalc.values[k]}）`);
  }

  // 真视图：注入一条**节日形状**的事件，并关掉日历那一支（避免标题重名挑错泡泡）
  const ev = found.list[0];
  const now = Date.now();
  const fest = {
    ...ev,
    start: new Date(now + 3600_000).toISOString(),
    end: new Date(now + 7200_000).toISOString(),
  };
  env.storage.setItem('timetable.bubble.festivalDays', '0');   // 只留我们注入的这一颗
  recorder.calls.length = 0;
  const { canvas } = renderView({ events: [fest] });
  const items = globalThis.window.__bubbleItems();
  assert.ok(items.some((it) => it.event && it.event.id === fest.id),
    `注入的节日事件没进 items：${JSON.stringify(items.map((it) => it.event && it.event.id))}`);

  const b = bubbleByTitle(fest.title);
  const p = atBubble(b);
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', p));
  assert.equal(gestureState().holding, true,
    '按在节日泡泡圆心上没进 hold —— 如果只有这一条红，那"节日改动"就真的是根因');
  assert.equal(diagState().down, 1);

  recorder.calls.length = 0;
  await frameAfter(220);
  assert.ok(ringArcs(recorder.calls).length > 0,
    '节日泡泡按住时**没有画出进度环** —— 检查节日图案的 save/clip 有没有把后面的 arc 裁掉');
  canvas.dispatchEvent(pointer(canvas, 'pointerup', p));
  env.storage.setItem('timetable.bubble.festivalDays', '4');
});

// ===========================================================================
// ⑥ ★ pointer 一条都不发 → touch 兜底通道照样能长按戳破
// ===========================================================================
test('⑥ ★ pointer 完全不发时，touchstart/touchend 仍能长按 2.6 秒戳破', async () => {
  resetCalls();
  const { canvas } = renderView({ events: [makeEvent('e1', '只给 touch 的设备')] });
  const b = bubbleByTitle('只给 touch 的设备');
  const p = atBubble(b);

  canvas.dispatchEvent(touch(canvas, 'touchstart', { id: 7, x: p.clientX, y: p.clientY }));
  const st = gestureState();
  assert.equal(st.holding, true, 'touch 通道必须能起手（"只给 touch 不给 pointer"的设备就靠它）');
  assert.equal(st.channel, 'touch');
  assert.equal(st.activeId, 7, 'activeId 要用 touch.identifier（不是 pointerId）');
  assert.equal(diagState().touch.down, 1, '角标要单独记 touch 通道的计数（这是"设备给不给 pointer"的唯一证据）');

  await sleep(2600);              // 真定时器：验证的是"真 setTimeout 这条路"
  await flush();
  assert.equal(popRequests().length, 1,
    `touch 长按 2.6 秒应恰好 1 次戳破请求，实际 ${popRequests().length}；全部请求：${env.calls.map((c) => c.method + ' ' + c.url).join(' ; ')}`);
  assert.match(popRequests()[0].url, /\/api\/events\/e1\/pop$/);
  canvas.dispatchEvent(touch(canvas, 'touchend', { id: 7, x: p.clientX, y: p.clientY }));
  assert.equal(gestureState().holding, false);
});

test('⑥b 两条通道**同一次触摸**不会各处理一遍（否则会被自己判成"多指"而自杀）', async () => {
  resetCalls();
  const { canvas } = renderView({ events: [makeEvent('e1', '两条通道都发')] });
  const b = bubbleByTitle('两条通道都发');
  const p = atBubble(b);

  // Safari 的真实顺序：pointerdown → touchstart（同一次触摸）
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', p));
  canvas.dispatchEvent(touch(canvas, 'touchstart', { id: 7, x: p.clientX, y: p.clientY }));
  const st = gestureState();
  assert.equal(st.holding, true, '第二次投递把长按取消了 —— 通道锁没生效（这正是"自己人打自己人"）');
  assert.equal(st.channel, 'pointer', '先送到的那条通道拥有整次手势');
  // touch 的 up 也不许把 pointer 的手势提前结束
  canvas.dispatchEvent(touch(canvas, 'touchend', { id: 7, x: p.clientX, y: p.clientY }));
  assert.equal(gestureState().holding, true, '另一条通道的 touchend 不该结束 pointer 的手势');

  await sleep(2600);
  await flush();
  assert.equal(popRequests().length, 1, '通道锁生效时长按照样要能戳破');
  canvas.dispatchEvent(pointer(canvas, 'pointerup', p));
});

// ===========================================================================
// ⑦ touchcancel 与 pointercancel 同一条：取消 + 复位 + 之后仍能长按
// ===========================================================================
test('⑦ touchcancel → 取消并复位，紧接着再触摸长按仍能戳破', async () => {
  resetCalls();
  const { canvas } = renderView({ events: [makeEvent('e1', '被系统掐断')] });
  const b = bubbleByTitle('被系统掐断');
  const p = atBubble(b);

  canvas.dispatchEvent(touch(canvas, 'touchstart', { id: 1, x: p.clientX, y: p.clientY }));
  await sleep(400);
  canvas.dispatchEvent(touch(canvas, 'touchcancel', { id: 1, x: p.clientX, y: p.clientY }));
  assert.equal(gestureState().holding, false, 'touchcancel 必须取消长按');
  assert.equal(gestureState().activeId, null,
    'touchcancel 必须把 activeId 也清掉 —— 漏了它，下一次触摸会被当成"第二根手指"直接忽略');
  assert.equal(diagState().holdOutcome, `结束:touchcancel@${(diagState().holdOutcome.match(/@(.*)$/) || [])[1]}`);
  assert.match(diagState().holdOutcome, /^结束:touchcancel@/, '角标要显示取消**原因**（这一格是排障的关键）');
  await sleep(2400);
  assert.equal(popRequests().length, 0, '被掐断之后不许"延迟爆炸"');

  // 掐断一次之后**再触摸一次**必须仍然能长按 —— 这条才是"复位干不干净"的判据
  canvas.dispatchEvent(touch(canvas, 'touchstart', { id: 2, x: p.clientX, y: p.clientY }));
  assert.equal(gestureState().holding, true, '掐断之后再按必须还能进 hold');
  await sleep(2600);
  await flush();
  assert.equal(popRequests().length, 1, `掐断之后再长按必须能戳破，实际 ${popRequests().length} 次`);
  canvas.dispatchEvent(touch(canvas, 'touchend', { id: 2, x: p.clientX, y: p.clientY }));
});

test('⑦b pointercancel 的取消原因也进角标（桌面/鼠标那条路）', async () => {
  resetCalls();
  const { canvas } = renderView({ events: [makeEvent('e1', '鼠标被掐断')] });
  const b = bubbleByTitle('鼠标被掐断');
  const p = atBubble(b);
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', p));
  await sleep(300);
  canvas.dispatchEvent(pointer(canvas, 'pointercancel', p));
  assert.equal(gestureState().holding, false);
  assert.match(diagState().holdOutcome, /^结束:pointercancel@/,
    '角标必须能说出"是 pointercancel 掐断的"——用户念这一句就能定位');
  assert.equal(diagState().cancel, 1);
});

// ===========================================================================
// ⑦c 诊断角标：默认关闭；打开后计数/原因/版本都对，而且**绝不吃手势**
// ===========================================================================
test('⑦c 诊断角标：默认关闭、开了能报计数与取消原因、`pointer-events: none`', async () => {
  // 默认关闭（否则平时会在屏幕上多一块东西，而且 200ms 心跳会一直跑）
  assert.equal(env.storage.getItem(DIAG_KEY), null, '诊断角标默认必须是关的');

  env.storage.setItem(DIAG_KEY, '1');
  const { host, canvas } = renderView({
    events: [makeEvent('e1', '角标要说话')],
    health: { version: '9.9.9' },        // 版本真源：电脑端 /api/health 给的就是它
  });
  const badge = findByClass(host, 'bubble-diag');
  assert.ok(badge, '角标必须进 DOM 树（只 createElement 不 append 是看不见的）');
  assert.equal(badge.hidden, false, '开关打开时角标必须可见');

  const b = bubbleByTitle('角标要说话');
  const p = atBubble(b);
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', p));
  const text = globalThis.window.__bubbleDiagText();
  assert.match(text, /down=1 move=\d+ cancel=0 up=0/, `计数不对：${text}`);
  assert.match(text, /last=pointerdown/, `最后一次原始事件名不对：${text}`);
  assert.match(text, /hold=\d+\.\d+s\/2\.5s/, `长按那一格要"自己走"（x.xs/2.5s）：${text}`);
  assert.match(text, /ev=pointer/, `通道那一格不对：${text}`);
  assert.match(text, /v=9\.9\.9/, `版本标记必须带上（用户要能确认装的是不是新包）：${text}`);
  assert.equal(diagState().touch.down, 0, '这次没走 touch 通道，touch 计数必须是 0');

  // ⚠️ 角标的刷新**不经过 rAF**（见 bubble-diag.js 文件头：要诊断的恰恰可能是"帧循环不动了"）。
  //    所以这里**一帧都不跑**，只推真实时间 —— 秒数必须自己涨。
  //    （下面这句 assert 同时也说明了为什么不能写 `assert.equal(badge.textContent, 诊断文本)`：
  //     角标是"上一次重画时的快照"，而诊断文本是**现算**的，秒数天然会差一点。）
  const secOf = (s) => Number((/hold=(\d+\.\d+)s/.exec(s) || [])[1]);
  const badgeText = badge.textContent;
  assert.match(badgeText, /^down=1 move=0 cancel=0 up=0 · last=pointerdown · hold=\d+\.\d+s\/2\.5s · ev=pointer · v=9\.9\.9/,
    `角标那一行的形状不对（用户就是照它念的）：${badgeText}`);
  await sleep(340);
  assert.ok(secOf(badge.textContent) > secOf(badgeText),
    `按住时角标里 hold= 那一格必须自己走（而且不靠渲染帧）：${badgeText} → ${badge.textContent}`);
  assert.equal(gestureState().holding, true, '心跳推进不该影响长按状态');

  canvas.dispatchEvent(pointer(canvas, 'pointercancel', p));
  assert.match(globalThis.window.__bubbleDiagText(), /hold=结束:pointercancel@\d/,
    '角标必须把**取消原因**写出来 —— 这是"用户念一句就能定位"的核心那一格');
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', p));
  canvas.dispatchEvent(pointer(canvas, 'pointerup', p));
  assert.match(globalThis.window.__bubbleDiagText(), /up=1/, '抬手也要计数');

  // 角标的样式：诊断器绝不能把长按吃掉（这条是硬要求，和 tapRipple/holdHint 同一规矩）
  assert.equal(cssProp('web/css/views.css', '.bubble-diag', 'pointer-events'), 'none');
  assert.match(cssDecls('web/css/views.css', '.bubble-diag[hidden]'), /display:\s*none/,
    '必须显式写 [hidden] —— 本项目在 .bubble-hud-chip / .bubble-inside-hint 上踩过'
    + '"display 盖过 [hidden] 留下一个空盒子"的坑');

  // 关掉之后必须真的收起来，而且**心跳要停**（否则测试进程/真机会被它一直吊着）
  env.storage.setItem(DIAG_KEY, '0');
  const second = renderView({ events: [makeEvent('e2', '角标关掉之后')] });
  const badge2 = findByClass(second.host, 'bubble-diag');
  assert.ok(badge2 && badge2.hidden === true, '关掉之后角标必须 hidden');
});

// ===========================================================================
// ⑧ 单击 / 双击**没有**被这次改动碰坏（"只有长按不行"的反面判据）
// ===========================================================================
test('⑧ 按住 1 秒松手 = 单击（editEvent 一次）；连点两次 = 双击进母泡泡（refresh 一次）', async () => {
  const edits = [];
  const { canvas } = renderView({ events: [makeEvent('e1', '单击的泡泡')], editEvent: (e) => edits.push(e) });
  const b = bubbleByTitle('单击的泡泡');
  const p = atBubble(b);
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', p));
  await sleep(600);
  canvas.dispatchEvent(pointer(canvas, 'pointerup', p));
  await sleep(500);                       // 等过双击窗口（330ms）
  assert.equal(edits.length, 1, `按住 1 秒松手应判成单击 → editEvent 1 次，实际 ${edits.length}`);
  assert.equal(popRequests().length, 0, '按 1 秒不该戳破');
});

// ⚠️ 双击这一条必须**放在文件最后**：进入容器会改掉模块级的"当前在第几层"，
//    之后再渲染气泡区就只剩容器内部（没有画布了），后面的用例会全部失效。
test('⑧b 连点两次同一个泡泡 = 双击 → 进入容器（ctx.refresh 一次 + 路径被写入）', async () => {
  let refreshes = 0;
  const { canvas } = renderView({
    events: [makeEvent('e1', '双击进去')],
    refresh: () => { refreshes += 1; },
  });
  const b = bubbleByTitle('双击进去');
  const p = atBubble(b);
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', p));
  await sleep(60);
  canvas.dispatchEvent(pointer(canvas, 'pointerup', p));
  await sleep(120);                       // 落在 320ms 双击窗口内
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', p));
  await sleep(60);
  canvas.dispatchEvent(pointer(canvas, 'pointerup', p));
  assert.ok(refreshes >= 1, '双击必须进入容器（ctx.refresh 至少一次）');
  const pathRaw = env.storage.getItem('timetable.bubble.path') || '';
  assert.match(pathRaw, /e1/, `双击之后"当前在第几层"要写进 sessionStorage，实际 ${pathRaw}`);
});
