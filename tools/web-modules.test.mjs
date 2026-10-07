// 浏览器模块加载性检查
//
// 为什么需要它：前端模块平时只在浏览器里跑，路径写错 / 顶层用到不存在的 API，
// 单测和服务端自检都发现不了。这里用一套最小 DOM 桩把每个模块 import 一遍，
// 确认：① 模块路径都存在；② 顶层代码不会直接崩。
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- 最小 DOM 桩 ----------
const listeners = [];
function makeElement(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    childNodes: [],
    // ⚠️ CSS 自定义属性只能走 `style.setProperty` —— `Object.assign(style, {'--c':…})`
    //    是**无效**的（见 web/ui/dom.js:38）。
    //    以前这里的 style 只是个普通对象，于是所有会设 `--c`（等级颜色）的视图
    //    在有数据的冒烟里全报 "style.setProperty is not a function"，
    //    month/week/three/list/course 这 5 个视图的渲染冒烟**等于白跑**。
    //    补上之后它们才真的被执行到（并且真的崩了会被发现）。
    style: {
      _custom: {},
      setProperty(k, v) { this._custom[k] = String(v); this[k] = String(v); },
      getPropertyValue(k) {
        return Object.prototype.hasOwnProperty.call(this._custom, k) ? this._custom[k] : '';
      },
      removeProperty(k) { delete this._custom[k]; delete this[k]; },
    },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    attributes: {},
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    firstChild: null,
    parentElement: null,
    isContentEditable: false,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); c.parentElement = this; this.firstChild = this.childNodes[0]; return c; },
    append(...c) { c.forEach((x) => this.appendChild(x)); },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      this.childNodes = this.childNodes.filter((x) => x !== c);
      this.firstChild = this.childNodes[0] || null;
      return c;
    },
    remove() {},
    insertBefore(n) { return this.appendChild(n); },
    addEventListener(type, fn) { listeners.push([this, type, fn]); },
    removeEventListener() {},
    dispatchEvent() { return true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return true; },
    focus() {},
    click() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
    setPointerCapture() {},
    releasePointerCapture() {},
    insertAdjacentHTML() {},
    scrollIntoView() {},
    getContext() { return null; }, // 让 Canvas 相关逻辑走"不可用"分支
    toDataURL() { return 'data:,'; },
  };
  return el;
}

/** Node 里 navigator / location 等是只读 getter，必须用 defineProperty 覆盖 */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value, writable: true, configurable: true, enumerable: false,
  });
}

const head = makeElement('head');
const body = makeElement('body');
const knownNodes = new Map(); // 选择器 -> 桩元素，保证同一个选择器总是拿到同一个实例

/** 按选择器返回桩元素（真实 DOM 里 #view-title 这类节点必须稳定存在） */
function stubQuery(selector) {
  const key = String(selector || '').trim();
  if (!key) return null;
  if (!knownNodes.has(key)) knownNodes.set(key, makeElement('div'));
  return knownNodes.get(key);
}

globalThis.Node = class Node {};
defineGlobal('document', {
  documentElement: makeElement('html'),
  head,
  body,
  createElement: (tag) => makeElement(tag),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  createDocumentFragment: () => makeElement('fragment'),
  getElementById: (id) => stubQuery(`#${id}`),
  querySelector: (sel) => stubQuery(sel),
  querySelectorAll: () => [],
  addEventListener: (type, fn) => listeners.push([null, type, fn]),
  removeEventListener: () => {},
  visibilityState: 'visible',
  hidden: false,
  title: '',
  cookie: '',
  readyState: 'complete',
});
defineGlobal('window', {
  document: globalThis.document,
  location: { protocol: 'http:', href: 'http://127.0.0.1:7080/' },
  navigator: { userAgent: 'node', serviceWorker: undefined, language: 'zh-CN' },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  addEventListener: (type, fn) => listeners.push([null, type, fn]),
  removeEventListener: () => {},
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
  setInterval: (...a) => setInterval(...a),
  clearInterval: (...a) => clearInterval(...a),
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
  devicePixelRatio: 1,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  focus() {},
  open() {},
  Notification: undefined,
  AudioContext: undefined,
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
});
defineGlobal('navigator', globalThis.window.navigator);
defineGlobal('location', globalThis.window.location);
defineGlobal('CustomEvent', globalThis.window.CustomEvent);
defineGlobal('localStorage', {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
  clear() { this._m.clear(); },
});
defineGlobal('sessionStorage', globalThis.localStorage);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;
globalThis.fetch = async () => { throw new Error('测试环境不联网'); };
globalThis.performance = globalThis.performance || { now: () => Date.now() };

// ⚠️ **定时器也必须桩掉**（这是补的一个坑，不是调优）：
//    `web/ui/app.js` 在模块顶层就 `boot()`，boot 最后会 `startReminder()` →
//    `web/adapter/reminder.js` 里两个 `setInterval`。原来这里的桩只覆盖了
//    `window.setInterval`，而 reminder.js 调的是**裸的全局** `setInterval` ——
//    于是这个测试进程会被两个"永远不会被清掉"的定时器吊住：**测试全绿也永不退出**
//    （跑起来表现为"卡在那里、最后连汇总行都不打印"，在 CI 上就是超时）。
//    以前没暴露，是因为 boot() 更早一步就崩了（见下面的 #nav-desk 说明），
//    严格说那是"靠崩溃挡住挂起"。这里给一个不挂事件循环的桩，
//    让"模块能加载、视图能渲染"这件事被测得干干净净。
defineGlobal('setInterval', () => 0);
defineGlobal('clearInterval', () => {});

// ---------- 要加载的模块 ----------
const MODULES = [
  // 共用核心层（平台无关，三端共用）
  '../core/time.js',
  '../core/recurrence.js',
  '../core/palette.js',
  '../core/urgency.js',
  '../core/qrcode.js',
  // AI 那两块的纯逻辑（服务商预设 / 失败翻译）与界面（引导式三步 + 一键自检）
  // 浏览器适配层（依赖 localStorage / fetch / Notification 等平台 API）
  '../web/adapter/api.js',
  '../web/adapter/store.js',
  '../web/adapter/reminder.js',
  '../web/ui/dom.js',
  '../web/ui/modal.js',
  '../web/ui/toast.js',
  '../web/ui/editor.js',
  '../web/ui/viewkit.js',
  '../web/ui/views/bubble.js',
  '../web/ui/views/month.js',
  '../web/ui/views/list.js',
  '../web/ui/views/course.js',
  '../web/ui/views/import.js',
  '../web/ui/views/settings.js',
  '../web/ui/views/help.js',
  '../web/ui/app.js',
];

for (const path of MODULES) {
  test(`前端模块可加载：${path.replace('../web/', '')}`, async () => {
    const mod = await import(path);
    assert.ok(mod, '模块没有导出内容');
    assert.equal(typeof mod, 'object');
  });
}

test('视图模块都导出了符合约定的视图对象', async () => {
  const names = [
    ['bubble', '../web/ui/views/bubble.js', 'bubbleView'],
    ['month', '../web/ui/views/month.js', 'monthView'],
    ['list', '../web/ui/views/list.js', 'listView'],
    ['course', '../web/ui/views/course.js', 'courseView'],
    ['import', '../web/ui/views/import.js', 'importView'],
    ['settings', '../web/ui/views/settings.js', 'settingsView'],
    ['help', '../web/ui/views/help.js', 'helpView'],
  ];
  for (const [id, path, exportName] of names) {
    const mod = await import(path);
    const view = mod[exportName];
    assert.ok(view, `${path} 没有导出 ${exportName}`);
    assert.equal(view.id, id, `${exportName}.id 应为 ${id}`);
    assert.equal(typeof view.label, 'string');
    assert.equal(typeof view.render, 'function', `${exportName} 缺少 render`);
    assert.equal(typeof view.title, 'function', `${exportName} 缺少 title`);
  }
});

// ---------- 渲染冒烟：每个视图在"有数据"和"没数据"两种状态下都要能画出来 ----------
const EMPTY_STATE = {
  ready: true, online: true, error: null, health: {}, rev: 1,
  settings: { owner: '测试', termStart: '2026-03-02', termWeeks: 18, todayTodo: '', defaultReminders: [10, 0], notify: { desktop: true, browser: true, sound: true }, autoLaunch: false, sectionTimes: [{ index: 1, start: '08:00', end: '08:45' }] },
  events: [],
  courses: [],
  view: 'month', cursor: '2026-03-05', courseWeek: 1,
};

const SAMPLE_EVENTS = [
  { id: 'e1', title: '高等数学', type: 'course', importance: 3, start: '2026-03-02T08:00:00', end: '2026-03-02T09:40:00', location: '教三 305', teacher: '李老师', recurrence: { freq: 'none' }, weeks: [1, 2, 3], reminders: [10], done: false },
  { id: 'e2', title: '交作业', type: 'task', importance: 4, start: '2026-03-05T23:59:00', end: '2026-03-06T00:00:00', recurrence: { freq: 'none' }, reminders: [30], done: false },
  { id: 'e3', title: '周会', type: 'activity', importance: 2, start: '2026-03-05T10:00:00', end: '2026-03-05T11:00:00', recurrence: { freq: 'weekly', byDay: [4] }, reminders: [5], done: false },
  { id: 'e4', title: '已完成的跑步', type: 'personal', importance: 2, start: '2026-03-04T19:00:00', end: '2026-03-04T19:30:00', recurrence: { freq: 'none' }, reminders: [], done: true },
];

const makeCtx = (state) => ({
  state,
  setView() {}, setCursor() {}, setCourseWeek() {}, setLocal() {}, refresh() {},
  newEventAt() {}, editEvent() {},
});

const VIEWS = [
  ['bubble', '../web/ui/views/bubble.js', 'bubbleView'],
  ['month', '../web/ui/views/month.js', 'monthView'],
  ['list', '../web/ui/views/list.js', 'listView'],
  ['course', '../web/ui/views/course.js', 'courseView'],
  ['import', '../web/ui/views/import.js', 'importView'],
  ['settings', '../web/ui/views/settings.js', 'settingsView'],
  ['help', '../web/ui/views/help.js', 'helpView'],
];

for (const [id, path, exportName] of VIEWS) {
  test(`视图渲染冒烟（空数据）：${id}`, async () => {
    const view = (await import(path))[exportName];
    const host = makeElement('main');
    assert.doesNotThrow(() => view.render(EMPTY_STATE, makeCtx(EMPTY_STATE), host), `${id} 在空数据下渲染崩了`);
  });

  test(`视图渲染冒烟（有数据）：${id}`, async () => {
    const view = (await import(path))[exportName];
    const state = { ...EMPTY_STATE, events: SAMPLE_EVENTS, courses: [
      { key: 'k1', title: '高等数学', teacher: '李老师', location: '教三 305', dayOfWeek: 1, sections: [1], weeks: [1, 2, 3] },
    ] };
    const host = makeElement('main');
    assert.doesNotThrow(() => view.render(state, makeCtx(state), host), `${id} 在有数据下渲染崩了`);
  });

  test(`视图标题/副标题可求值：${id}`, async () => {
    const view = (await import(path))[exportName];
    const state = { ...EMPTY_STATE, events: SAMPLE_EVENTS };
    assert.equal(typeof view.title(state), 'string');
    if (view.subtitle) assert.equal(typeof view.subtitle(state), 'string');
    if (view.nav) assert.ok(Array.isArray(view.nav(state)));
  });
}
