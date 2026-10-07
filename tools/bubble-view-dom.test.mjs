// 气泡视图的**接线回归测试**（假 DOM + 假 canvas + 假 fetch，把真视图真的跑起来）。
//
// ===========================================================================
// 为什么必须有这个（它是"用户在真机上看到什么"与源码之间唯一的桥）
// ===========================================================================
//
// `web/ui/views/bubble.js` 有近三千行，绝大多数测试只能测它的**纯函数那一半**
// （core/ 里的），因为它在浏览器里才跑得起来。于是"视图层自己抛异常/接线接错"
// 这类问题**只能靠真机发现** —— 而那正是用户报的"泡泡隐身 + 长按无响应"的形状：
//
//   节日图案是后来加进**绘制路径**的 → 帧里多开了几个可能抛的入口
//   → 帧回调抛出 → 末尾那句 `raf = requestAnimationFrame(frame)` 不再执行
//   → ① 泡泡不再重画（"隐身但能点到"） ② 长按再也不触发（老实现的计时活在循环里）
//      ③ 单击/双击照旧（在 pointerup 分支里，不经过循环）
//
// 所以这个文件做一件很土但很有效的事：**用假 DOM + 假 canvas 把这一页真的加载起来**、
// 装上真的事件流，然后断言：
//   ① 渲染这一棵树不会抛；
//   ② 五种指针监听 + 失焦/可见性**真的挂上了**（旧版没有 contextmenu，
//      而且 pointercancel 复用了 pointerup 的处理）；
//   ③ 合成指针长按 2.5 秒 → **真的发出戳破请求**（端到端走通）；
//   ④ 打断（pointercancel / contextmenu / 多指 / 切后台）之后状态复位，再长按仍能戳破。
//
// ⚠️⚠️ 这个文件**抓到过一个真实缺陷**（不是测试自己写错）：
//    第 ③ 条最初是绿的，第 ④ 条里的"短按 = 单击"却是红的 —— 因为
//    `createBubbleGesture({ onPressBubble: () => { bgTapAt = 0; } })` 把回调写成了
//    **空壳**：泡泡被按下时 `dragBody` 从来没被设上，于是短按松开之后什么都不发生
//    （不弹编辑框、不拖、不戳破）—— 正是用户描述的"无响应"那一类。
//    只测"长按能不能戳破"是**测不出来**的：长按走的是手势模块自己的计时器，
//    压根不需要 `dragBody`。所以这两条断言必须都在。
//
// 跑法：`node tools/bubble-view-dom.test.mjs`
//
// ⚠️ 一个文件一个进程：这个沙箱里 `node --test` 多文件会 `spawn EPERM`。
import test from 'node:test';
import assert from 'node:assert/strict';

// ===========================================================================
// 假 DOM —— 只做到"足以让 bubble.js 的 render() 活下来"的最小面
// ===========================================================================
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this.attributes = {};
    /**
     * ⚠️ `className` 与 `classList` **必须是同一份数据的两个视图**。
     *    第一版把它们做成两个独立字段（className 字符串 + classList 里的一个 Set），
     *    于是 `el('canvas.bubble-canvas')`（它写的是 `node.className = ...`）
     *    在 classList 里**查不到** —— 测试报"没找到画布"，看起来像产品把画布删了。
     *    真实 DOM 里它们互相反映，假 DOM 也必须这样，否则假失败会浪费一整轮排查。
     */
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
    this.listeners = new Map();     // 类型 → [处理器]（测试要能数出挂了几个）
    this.hidden = false;
    this.textContent = '';
    this.width = 0;
    this.height = 0;
  }

  get className() { return [...this._classes].join(' '); }
  set className(v) {
    // ⚠️ 必须 `clear()` 之后复用**同一个** Set 对象：classList 的三个闭包捕的是它。
    //    换成 `this._classes = new Set(...)` 会让它们指向旧集合（第一版就是这么假失败的）。
    this._classes.clear();
    for (const c of String(v || '').split(/\s+/)) if (c) this._classes.add(c);
  }

  get children() { return this.childNodes; }
  // ⚠️ `parentElement` 与 `parentNode` 在真实 DOM 里是两个属性。
  //    bubble.js 两处都用到（resize 读 parentElement）。假 DOM 少了这个 getter，
  //    render() 会在 resize 那一行抛 —— 那是**测试环境缺陷**，报错位置却在 bubble.js 里，
  //    极容易被误读成真 bug。
  get parentElement() { return this.parentNode; }
  get firstChild() { return this.childNodes[0] || null; }
  get offsetWidth() { return 900; }
  get offsetHeight() { return 640; }
  get clientWidth() { return 900; }
  get isConnected() { return true; }

  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  removeChild(n) { this.childNodes = this.childNodes.filter((c) => c !== n); return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { if (n === this) return true; return this.childNodes.some((c) => c.contains && c.contains(n)); }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }
  setPointerCapture() {}
  releasePointerCapture() {}
  hasPointerCapture() { return false; }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, []);
    this.listeners.get(t).push(fn);
  }
  removeEventListener(t, fn) {
    const a = this.listeners.get(t) || [];
    this.listeners.set(t, a.filter((x) => x !== fn));
  }
  /** 测试用：这一层挂了这个类型几个监听 */
  countListeners(t) { return (this.listeners.get(t) || []).length; }
  /** 测试用：按真实语义派发（带冒泡的简化版） */
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
    return { x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 640, width: 900, height: 640 };
  }
  getContext() { return makeFakeCtx(); }
  focus() {}
  blur() {}
}

/** 假 2D 上下文：未知属性一律当"可调用的空方法"；measureText 给一个稳定宽度。 */
function makeFakeCtx() {
  const calls = [];
  return new Proxy(function ctx() {}, {
    get(_t, prop) {
      if (prop === '__calls') return calls;
      if (prop === 'measureText') return (s) => { calls.push('measureText'); return { width: String(s || '').length * 7 }; };
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
        return (...a) => { void a; calls.push(String(prop)); return { addColorStop: () => {} }; };
      }
      if (prop === 'canvas') return null;
      if (typeof prop === 'symbol') return undefined;
      // ⚠️ 对**任何**未知属性都返回函数：写操作（fillStyle = x）走 set 陷阱，
      //    所以未来 canvas 多一个方法也不需要改这个桩。
      return (...a) => { void a; calls.push(String(prop)); return undefined; };
    },
    set() { return true; },
  });
}

/** 极简 window/document —— bubble.js 的模块体里就读 window/location，必须先装好 */
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
    /**
     * `getElementById` / `querySelector('#id')` 都要**懒建**。
     * ⚠️ 戳破成功之后会调 `toast()`，而 `web/ui/toast.js` 找的是 `#toast-host`
     *    （用 `$('#toast-host')`，也就是 querySelector）。真实 index.html 里有它，
     *    假 DOM 里没有 → `host().appendChild` 在 null 上抛 → 整页崩，
     *    看起来像"戳破把页面搞崩了"（**测试环境缺陷**，不是产品 bug）。
     */
    getElementById: (id) => {
      if (!byId.has(id)) { const n = new FakeNode('div'); n.id = id; body.appendChild(n); byId.set(id, n); }
      return byId.get(id);
    },
    querySelector: (sel) => {
      const s = String(sel);
      if (s.startsWith('#')) return document.getElementById(s.slice(1));
      return null;
    },
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
    __fire: (t, e) => { for (const fn of winListeners.get(t) || []) fn(e || {}); },
  };
  class ResizeObserverStub {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  globalThis.document = document;
  globalThis.window = window;
  // ⚠️ Node 24 里 `globalThis.navigator` 是**只读 getter**，直接赋会
  //    "Cannot set property navigator"（第一版就死在这一行）。Node 自带的
  //    navigator 已经够 adapter/native.js 用，所以只在不存在时补。
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node-probe' }, configurable: true });
  }
  globalThis.localStorage = makeStorage();
  globalThis.sessionStorage = makeStorage();
  globalThis.ResizeObserver = ResizeObserverStub;
  // ⚠️ MutationObserver 也要有：bubble.js 用它监听"画布被移出 DOM"然后停掉自己。
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
  globalThis.requestAnimationFrame = () => 1;     // 探针不推进帧循环（要看的不是画面）
  globalThis.cancelAnimationFrame = () => {};
  globalThis.Image = class { constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; } };
  globalThis.Node = FakeNode;
  globalThis.Element = FakeNode;
  globalThis.Event = class { constructor(t) { this.type = t; } };
  globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
  globalThis.location = window.location;
  /**
   * 假 `fetch` —— "戳破真的走到服务端了吗"的唯一可靠观察点。
   *
   * ⚠️ 为什么不直接给 `store.popEvent` 打桩：ES 模块的命名空间对象是**只读**的，
   *    `store.popEvent = ...` 在 Node 里抛 `Cannot assign to read only property`
   *    （第一版就死在这一行，报错位置还在测试自己身上，极易被误读成"视图抛了"）。
   *    打桩 fetch 反而更接近真实：验证的是"**真 store 代码**最后发了哪个请求"。
   */
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body });
    const u = String(url);
    let payload = {};
    if (u.includes('/api/state')) payload = { events: [], settings: {}, courses: [] };
    else if (u.includes('/pop')) payload = { released: [], mode: 'single' };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    };
  };
  return { document, window, calls };
}

// ⚠️ 环境必须在**动态 import 之前**装好（模块体里就读 window）。
const env = installFakeGlobals();
const { bubbleView } = await import('../web/ui/views/bubble.js');

const resetCalls = () => { env.calls.length = 0; };
/** 戳破请求发了几次（POST /api/events/<id>/pop） */
const popRequests = () => env.calls.filter((c) => c.method === 'POST' && /\/pop$/.test(c.url));
const allRequests = () => env.calls.map((c) => `${c.method} ${c.url}`).join(' ; ');

/**
 * 从只读快照里挑出**我们那颗**泡泡。
 *
 * ⚠️ 不能拿 `bodies[0]`：气泡区默认还会浮出**节日泡泡**（中秋/国庆…），
 *    而 `pick()` 是从后往前找的 —— 第一版就长按到了"国庆"那颗节日泡泡上，
 *    断言报"戳破的是 festival:guoqing"，看起来像产品选错了泡泡。
 */
const bubbleByTitle = (title) => {
  const all = globalThis.window.__bubbleBodies ? globalThis.window.__bubbleBodies() : [];
  const hit = all.find((b) => b.title === title);
  assert.ok(hit, `快照里找不到标题为「${title}」的泡泡；实际有：${JSON.stringify(all.map((b) => b.title))}`);
  return hit;
};

const flush = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEvent(id, title, extra = {}) {
  const now = Date.now();
  return {
    id, title, level: 'red', done: false,
    start: new Date(now + 3 * 3600_000).toISOString(),
    end: new Date(now + 4 * 3600_000).toISOString(),
    ...extra,
  };
}

/** 把 render() 跑起来，返回画布 */
function renderView({ events, editEvent }) {
  const host = new FakeNode('div');
  const ctx = {
    newEventAt: () => {},
    addChild: () => {},
    editEvent: editEvent || (() => {}),
    toast: () => {},
    refresh: () => {},
  };
  bubbleView.render({ events, settings: {}, courses: [] }, ctx, host);
  const walk = (n) => {
    if (n.tagName === 'CANVAS' && n.classList.contains('bubble-canvas')) return n;
    for (const c of n.childNodes) { const hit = walk(c); if (hit) return hit; }
    return null;
  };
  const canvas = walk(host);
  assert.ok(canvas, '渲染结果里必须有 .bubble-canvas（渲染路径变了？）');
  return { host, canvas, ctx };
}

const pointer = (canvas, type, e = {}) => ({
  type, pointerId: 1, pointerType: 'touch', isPrimary: true, target: canvas, ...e,
});

// ===========================================================================
// ① 渲染这一棵树不会抛
// ===========================================================================
test('渲染气泡视图（两颗泡泡）不会抛异常', () => {
  assert.doesNotThrow(() => {
    renderView({ events: [makeEvent('e1', '交实验报告'), makeEvent('e2', '例会', { level: 'sky' })] });
  });
});

test('渲染之后暴露的只读快照里有我们的泡泡（后面的用例都靠它取坐标）', () => {
  renderView({ events: [makeEvent('e1', '交实验报告')] });
  const b = bubbleByTitle('交实验报告');
  assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y) && b.r > 0, `快照坐标必须有效：${JSON.stringify(b)}`);
});

// ===========================================================================
// ② 监听必须真的挂上（旧版没有 contextmenu，pointercancel 还复用了 pointerup）
// ===========================================================================
test('canvas 上 pointerdown/move/up/cancel + contextmenu 各挂了 1 个监听', () => {
  const { canvas } = renderView({ events: [makeEvent('e1', '交实验报告')] });
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'contextmenu']) {
    assert.equal(canvas.countListeners(t), 1,
      `canvas 上 ${t} 的监听数不对（${canvas.countListeners(t)}）：`
      + '少了 pointercancel 状态就复位不了；少了 contextmenu，iOS 的系统菜单会抢走长按');
  }
});

test('visibilitychange / window blur 都挂上了（iOS 上 pointerup 可能永远不来）', () => {
  renderView({ events: [makeEvent('e1', '交实验报告')] });
  assert.equal(env.document.__count('visibilitychange'), 1);
  assert.equal(env.window.__count('blur'), 1);
});

test('长按提示条在 DOM 树里（"被系统打断"时用户才能看到一句话）', () => {
  const { host } = renderView({ events: [makeEvent('e1', '交实验报告')] });
  const find = (n) => n.classList.contains('bubble-hold-hint') || n.childNodes.some(find);
  assert.ok(find(host), '提示条必须进 DOM 树：只 createElement 不 append 是看不见的');
});

// ===========================================================================
// ③ 端到端：长按 2.5 秒 → 真的发出戳破请求
// ===========================================================================
test('★ 合成 touch 指针长按 2.6 秒 → 真的发出 POST /api/events/e1/pop，恰好 1 次', async () => {
  resetCalls();
  const { canvas } = renderView({ events: [makeEvent('e1', '长按要戳破的泡泡')] });
  const b = bubbleByTitle('长按要戳破的泡泡');
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', { clientX: b.x, clientY: b.y }));
  // 刻意用**真定时器**等 2.6 秒：要验证"真 setTimeout 这条路"也走通，
  // 而不是只在注入的假时钟下成立（假时钟那一条在 bubble-longpress.test.mjs）。
  await sleep(2600);
  await flush();
  const pops = popRequests();
  assert.equal(pops.length, 1,
    `长按 2.6 秒后戳破请求应恰好 1 次，实际 ${pops.length} 次；全部请求：${allRequests()}`);
  assert.match(pops[0].url, /\/api\/events\/e1\/pop$/, `戳破的必须是 e1，实际 ${pops[0].url}`);
});

// ===========================================================================
// ④ 端到端对照：短按 = 单击（**这条抓到过真 bug**）
// ===========================================================================
test('★ 按住 1 秒就松 → 不戳破，且判成单击（editEvent 恰好 1 次）', async () => {
  resetCalls();
  const edits = [];
  const { canvas } = renderView({ events: [makeEvent('e1', '短按的泡泡')], editEvent: (e) => edits.push(e) });
  const b = bubbleByTitle('短按的泡泡');
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', { clientX: b.x, clientY: b.y }));
  await sleep(1000);
  canvas.dispatchEvent(pointer(canvas, 'pointerup', { clientX: b.x, clientY: b.y }));
  await sleep(700);                       // 等过双击窗口（330ms）
  assert.equal(popRequests().length, 0, `按 1 秒不该戳破；实际请求：${allRequests()}`);
  /**
   * ⚠️⚠️ 这一条是**真 bug 的探针**，别因为"改了它就绿了"而放松它。
   *
   * 曾经的错法：`createBubbleGesture({ onPressBubble: () => { bgTapAt = 0; } })`
   * —— 把回调写成空壳，泡泡被按下时 `dragBody` 从来没设上，
   * 于是短按松开之后**什么都不发生**（不弹编辑框、不拖、不戳破），
   * 正是用户描述的"无响应"。
   * **只测"长按能不能戳破"是抓不到它的**：长按走的是手势模块自己的定时器，
   * 压根不需要 `dragBody`。所以这一条必须和上面那条同时存在。
   */
  assert.equal(edits.length, 1, '按 1 秒松手应当判成单击 → editEvent 1 次（这就是"点了没反应"的探针）');
});

// ===========================================================================
// ⑤ 端到端：被掐断之后复位，再长按仍能戳破
// ===========================================================================
test('★ pointercancel 掐断一次之后，再长按仍然戳破（状态复位干净）', async () => {
  resetCalls();
  const { canvas } = renderView({ events: [makeEvent('e1', '被掐断的泡泡')] });
  const b = bubbleByTitle('被掐断的泡泡');
  const at = (type, id) => pointer(canvas, type, { pointerId: id, clientX: b.x, clientY: b.y });
  canvas.dispatchEvent(at('pointerdown', 3));
  await sleep(1000);
  canvas.dispatchEvent(at('pointercancel', 3));
  await sleep(1900);                      // 残留定时器（若有）也早该到点了
  assert.equal(popRequests().length, 0, `被掐断不该戳破；实际请求：${allRequests()}`);
  // 换一根手指（新 pointerId）再长按 —— 必须能破
  canvas.dispatchEvent(at('pointerdown', 9));
  await sleep(2600);
  await flush();
  assert.equal(popRequests().length, 1,
    `掐断之后再长按必须仍然能戳破，实际 ${popRequests().length} 次（复位没做干净就会死在这里）`);
});

// ===========================================================================
// ⑥ 端到端：多指 → 不戳破
// ===========================================================================
test('长按期间第二根手指按下 → 不戳破', async () => {
  resetCalls();
  const { canvas } = renderView({ events: [makeEvent('e1', '多指')] });
  const b = bubbleByTitle('多指');
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', { pointerId: 1, isPrimary: true, clientX: b.x, clientY: b.y }));
  await sleep(800);
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', { pointerId: 2, isPrimary: false, clientX: b.x, clientY: b.y }));
  await sleep(2200);
  await flush();
  assert.equal(popRequests().length, 0, `多指不该戳破；实际请求：${allRequests()}`);
});

// ===========================================================================
// ⑦ 端到端：contextmenu → 拦掉 + 复位 + 后续仍能戳破
// ===========================================================================
test('contextmenu 被拦 + 打断后复位 + 再长按仍能戳破', async () => {
  resetCalls();
  const { canvas } = renderView({ events: [makeEvent('e1', '菜单打断')] });
  const b = bubbleByTitle('菜单打断');
  const at = (type, id) => pointer(canvas, type, { pointerId: id, clientX: b.x, clientY: b.y });
  canvas.dispatchEvent(at('pointerdown', 4));
  await sleep(900);
  let prevented = false;
  canvas.dispatchEvent({ type: 'contextmenu', preventDefault: () => { prevented = true; }, target: canvas });
  assert.equal(prevented, true, 'contextmenu 必须被拦（iOS 上它会弹系统菜单抢走长按）');
  await sleep(2000);
  assert.equal(popRequests().length, 0, `被菜单打断后不该戳破；实际请求：${allRequests()}`);
  canvas.dispatchEvent(at('pointerdown', 11));
  await sleep(2600);
  await flush();
  assert.equal(popRequests().length, 1, `菜单打断之后再长按必须能戳破，实际 ${popRequests().length} 次`);
});

// ===========================================================================
// ⑧ 端到端：切后台 → 取消
// ===========================================================================
test('切后台（visibilitychange）→ 取消长按并复位，不戳破', async () => {
  resetCalls();
  const { canvas } = renderView({ events: [makeEvent('e1', '切后台')] });
  const b = bubbleByTitle('切后台');
  canvas.dispatchEvent(pointer(canvas, 'pointerdown', { pointerId: 5, clientX: b.x, clientY: b.y }));
  await sleep(900);
  env.document.hidden = true;
  env.document.visibilityState = 'hidden';
  env.document.__fire('visibilitychange', {});
  await sleep(2000);
  await flush();
  env.document.hidden = false;
  env.document.visibilityState = 'visible';
  assert.equal(popRequests().length, 0, `切后台之后不该戳破；实际请求：${allRequests()}`);
});
