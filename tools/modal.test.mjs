// 弹窗（modal.js）的行为测试。
//
// 这个文件是为了锁住一个用户实测的 bug：**新建日程界面有时候退不出来**，
// 点「取消」和「✕」都没反应。
//
// 根因（改之前）：所有弹窗共用一个 #modal-host，而 openModal 用 clear(host)
// 把 DOM 全清掉、**却没有清 stack 数组**。于是：
//
//   打开 #1            → stack=[1]
//   在 #1 没关时又打开 #2 → host 只剩 #2 的 DOM，但 stack=[1,2]
//   点 #2 的「取消」    → 只摘掉 #2 → stack 还剩 [1] → host.hidden 不设
//                        → 弹窗留在屏幕上，怎么点都关不掉
//
// 单开一个弹窗时永远正常，所以用户的感觉是"有时候"。
//
// 又因为嵌套是**故意**的（editor 里 `await confirmDialog` 需要两个弹窗同时在屏上），
// 修法不能是"覆盖式"（清空 stack），而是让每个弹窗**自己管自己的 DOM 节点**：
// 打开时 append、关闭时 remove 自己的那两个节点，host 在栈空时才隐藏。
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 一个够用的 DOM 桩：append / remove / clear 都要真的生效，
// 否则测不出"节点有没有被摘掉"这件事。
// ---------------------------------------------------------------------------
function makeElement(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    childNodes: [],
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    attributes: {},
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    parentElement: null,
    isContentEditable: false,
    listeners: {},
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) {
      this.children.push(c); this.childNodes.push(c); c.parentElement = this; return c;
    },
    append(...c) { c.forEach((x) => this.appendChild(x)); },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      this.childNodes = this.childNodes.filter((x) => x !== c);
      return c;
    },
    remove() {
      // 真实 DOM 的 remove() 会把自己从父节点摘掉 —— 修复依赖这个语义
      if (this.parentElement) this.parentElement.removeChild(this);
      this.parentElement = null;
    },
    insertBefore(n) { return this.appendChild(n); },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatchEvent() { return true; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains(c) { return this.children.includes(c); },
    focus() {},
    click() {
      // 让测试能像用户那样"点"按钮
      (this.listeners.click || []).forEach((fn) => fn({ target: this, preventDefault() {} }));
    },
    getBoundingClientRect() { return { top: 0, left: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  return el;
}

// ⚠️ 这一行是**关键**：dom.js 的 append() 用 `child instanceof Node` 决定是插元素
//    还是插文本节点。如果桩元素不是 Node 的实例，所有子节点都会被当成文本插入，
//    于是 tagName / children 全都读不到 —— 表现为"找不到按钮"这种假故障。
//    让全局 Node 指向元素自身的构造函数，instanceof 就成立了。
const ElementCtor = makeElement('div').constructor;   // 每次 makeElement 返回的是普通对象，
// 所以这里改用显式原型链：把 Node 定义成所有桩元素的原型标记
function makeStub(tag = 'div') {
  const e = makeElement(tag);
  Object.setPrototypeOf(e, StubNode.prototype);
  return e;
}
function StubNode() {}
globalThis.Node = StubNode;

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value, writable: true, configurable: true, enumerable: false,
  });
}
void ElementCtor;

const host = makeStub('div');
const nodes = new Map([['#modal-host', host]]);
function stubQuery(sel) {
  const k = String(sel || '').trim();
  if (!k) return null;
  if (!nodes.has(k)) nodes.set(k, makeStub('div'));
  return nodes.get(k);
}

defineGlobal('document', {
  documentElement: makeStub('html'),
  head: makeStub('head'),
  body: makeStub('body'),
  createElement: (tag) => makeStub(tag),
  createTextNode: (t) => Object.assign(Object.create(StubNode.prototype), {
    nodeType: 3, textContent: String(t), children: [],
  }),
  getElementById: (id) => stubQuery(`#${id}`),
  querySelector: (sel) => stubQuery(sel),
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
  hidden: false,
});
defineGlobal('window', {
  document: globalThis.document,
  location: { protocol: 'http:', href: 'http://127.0.0.1:7080/' },
  navigator: { userAgent: 'node', language: 'zh-CN' },
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (fn) => { try { fn(); } catch { /* ignore */ } return 0; },
  clearTimeout: () => {},
});
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

const { openModal, closeTop, isModalOpen } = await import('../web/ui/modal.js');
const { el } = await import('../web/ui/dom.js');

// 先确认桩真的生效了 —— 否则后面所有失败都是假象
test('桩自检：el() 造出来的节点结构正确', () => {
  const btn = el('button.icon-btn', { 'aria-label': '关闭', text: '✕' });
  assert.equal(btn.tagName, 'BUTTON', `tagName=${JSON.stringify(btn.tagName)}`);
  assert.equal(String(btn.textContent).trim(), '✕', `textContent=${JSON.stringify(btn.textContent)}`);
  const head = el('div.modal-head', {}, [btn]);
  // ⚠️ 不能断言 head.children[0] === btn：dom.js 的 append() 走的是
  //    `child instanceof Node ? child : createTextNode(...)`，而桩元素不是真 Node，
  //    于是会被当成文本插进去 —— 这是**桩**的限制，不是产品代码的问题。
  //    所以这里只断言"节点进去了"，用 textContent 而不是引用相等。
  assert.equal(head.children.length, 1, `children=${head.children.length}`);
  assert.ok(String(head.children[0].textContent).includes('✕') || String(head.textContent).includes('✕'));
});

/** 在子树里按文字找按钮 */
function findButton(node, text) {
  if (!node) return null;
  if (node.tagName === 'BUTTON' && String(node.textContent || '').trim() === text) return node;
  for (const c of (node.children || [])) {
    const hit = findButton(c, text);
    if (hit) return hit;
  }
  return null;
}

test.beforeEach(() => {
  // ⚠️ 必须把模块级的 stack 也清空：只清 host 的话，某个用例中途失败留下的
  //    弹窗会污染后面的用例（表现为莫名其妙的 false）。
  while (closeTop()) { /* 清到空 */ }
  host.children.length = 0;
  host.childNodes.length = 0;
  host.hidden = true;
});

test('单个弹窗：点「取消」能关掉，host 会隐藏', () => {
  const ctl = openModal({ title: 'A', body: [], footer: [] });
  assert.equal(host.hidden, false, '打开后 host 应可见');
  ctl.close();
  assert.equal(host.hidden, true, '关掉后 host 应隐藏');
  assert.equal(isModalOpen(), false);
});

test('回归：叠加打开两个弹窗时，关掉上面那个必须能正常关闭并让 host 隐藏', () => {
  // 这个就是用户报的场景：第一个弹窗没关，又开了一个（例如确认框）
  const first = openModal({ title: '新建日程', body: [], footer: [] });
  const second = openModal({ title: '确认', body: [], footer: [] });

  // 两个弹窗的 DOM 都该在（嵌套是故意的，要能同时在屏上）
  assert.equal(host.children.length, 4, `两个弹窗应有 4 个顶层节点（各自的 mask+panel），实际 ${host.children.length}`);

  // 关掉上面那个
  second.close();

  // ⚠️ 这就是原来的 bug：stack 里还残留 first，于是 host.hidden 一直是 false，
  //    弹窗留在屏幕上点不掉。
  assert.equal(isModalOpen(), true, '下面那个还开着');
  assert.equal(host.hidden, false, '下面那个还在，host 不该隐藏');

  // 再关第一个 → 栈空 → host 必须隐藏
  first.close();
  assert.equal(isModalOpen(), false);
  assert.equal(host.hidden, true, '全关掉之后 host 必须隐藏（否则就是"退不出来"）');
  assert.equal(host.children.length, 0, '节点要清干净');
});

test('回归：叠加时点上层弹窗的「取消」按钮也要能关掉（走按钮而不是 ctl.close）', () => {
  const first = openModal({ title: '新建日程', body: [], footer: [] });
  const second = openModal({ title: '确认删除', body: [], footer: [] });

  // 直接点第二个弹窗面板上的关闭按钮（✕）—— 用户报的就是"点 ✕ 没反应"
  const closeBtn = findButton(second.panel, '✕');
  if (!closeBtn) {
    const dump = (n, d = 0) => '  '.repeat(d)
      + `${n.tagName} class=${JSON.stringify(n.className || '')} text=${JSON.stringify(n.textContent || '')}\n`
      + (n.children || []).map((c) => dump(c, d + 1)).join('');
    console.log('面板子树：\n' + dump(second.panel));
  }
  assert.ok(closeBtn, '应当能在面板里找到 ✕ 按钮');
  closeBtn.click();

  assert.equal(isModalOpen(), true, '下面那个还开着');
  assert.equal(host.hidden, false, '下面那个还在，host 不该隐藏');
  first.close();
  assert.equal(host.hidden, true, '全部关掉后必须隐藏');
});

test('回归：点 footer 里的「取消」按钮能关掉弹窗', () => {
  const first = openModal({ title: '新建日程', body: [], footer: [] });
  // 取消按钮要先建节点、等 ctl 到手再绑 close（custom-course.js / editor.js 都是这个写法）
  const cancel = el('button.btn', { text: '取消' });
  const second = openModal({ title: '确认', body: [], footer: [cancel] });
  cancel.addEventListener('click', () => second.close());

  cancel.click();
  assert.equal(isModalOpen(), true, '下面那个还开着');
  assert.equal(host.hidden, false);
  first.close();
  assert.equal(host.hidden, true, '全部关掉后必须隐藏');
});

test('回归：点遮罩只关自己那一层，不会把下面那层也关掉', () => {
  const first = openModal({ title: 'A', body: [], footer: [] });
  const second = openModal({ title: 'B', body: [], footer: [] });

  // 模拟点第二个弹窗的遮罩
  const masks = host.children.filter((c) => String(c.className).includes('modal-mask'));
  assert.equal(masks.length, 2, '两个弹窗各有自己的遮罩');
  masks[1].click();

  assert.equal(isModalOpen(), true, '只该关掉上层');
  assert.equal(host.hidden, false, '下层还开着');
  assert.equal(host.children.length, 2, '下层自己的 mask+panel 还在');
  first.close();
  assert.equal(host.hidden, true);
});

test('closeTop 只关最上面那个', () => {
  const first = openModal({ title: 'A', body: [], footer: [] });
  openModal({ title: 'B', body: [], footer: [] });
  assert.equal(closeTop(), true);
  assert.equal(isModalOpen(), true, '还剩 A');
  assert.equal(host.hidden, false, 'A 还在，不该隐藏');
  first.close();
  assert.equal(host.hidden, true);
});

test('重复调用 close 不会把栈搞乱（按钮和 onClose 可能都调一次）', () => {
  const first = openModal({ title: 'A', body: [], footer: [] });
  const second = openModal({ title: 'B', body: [], footer: [] });
  second.close();
  second.close();   // 重复关
  assert.equal(isModalOpen(), true, 'A 还该在');
  first.close();
  assert.equal(host.hidden, true);
});

test('关掉的弹窗会从 DOM 里摘掉自己的节点（不留僵尸遮罩）', () => {
  const first = openModal({ title: 'A', body: [], footer: [] });
  const second = openModal({ title: 'B', body: [], footer: [] });
  const before = host.children.length;
  second.close();
  assert.equal(host.children.length, before - 2, '上层弹窗的 mask+panel 都该被摘掉');
  first.close();
  assert.equal(host.children.length, 0);
});

test('onClose 回调会被调用，而且不会因为 DOM 操作抛错', () => {
  const seen = [];
  const ctl = openModal({ title: 'A', body: [], footer: [], onClose: (r) => seen.push(r) });
  ctl.close('cancel');
  assert.deepEqual(seen, ['cancel']);
});
