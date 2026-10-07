// **长按戳破**的手势回归测试 —— 用**合成事件序列**跑真实的手势代码。
//
// ===========================================================================
// 为什么有这个文件（用户报的 iPad bug）
// ===========================================================================
//
// 用户报（0.10.13，iPad 真机）：**"iOS 端长按 2.5 秒无响应"**。
// 而且补了一句关键线索：**"之前长按有效，应该也和节日改动有关"**。
//
// 老实现的形状（这次被拆掉的那一版）：长按的**计时、进度、以及"到点了没有"的判定**
// 全都活在 `requestAnimationFrame` 的帧回调里（`stepHold`），而帧回调最后一句才是
// `raf = requestAnimationFrame(frame)`。于是：
//   · 帧里任何一处抛出 → 续排那句不执行 → **整个循环死掉**
//   · 泡泡不再重画 → "隐身但还能点到"（用户之前报的）
//   · **长按再也不触发** → "长按 2.5 秒无响应"（本次报的）
//   · 单击/双击照旧正常 → 它们在 pointerup 分支里，不经过循环
//     （这正是"为什么只有长按坏了"的答案）
//
// 所以这个套件钉的是**修复后的两条硬规矩**：
//   ① 长按只依赖"时钟 + 事件"，**rAF 一次都不跑也必须能戳破**；
//   ② 任何打断（pointercancel / 多指 / contextmenu / 失焦）都要
//      **取消 + 彻底复位**，复位不干净就会出现"掐断一次之后再也不灵"。
//
// 跑法：`node tools/bubble-longpress.test.mjs`
//
// ⚠️ 命名与摆位的讲究：**一个文件、一个进程**。这个项目的沙箱里
//    `node --test` 多文件会 `spawn EPERM`，只能一个文件一个进程跑。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBubbleGesture, LONG_PRESS_MS, MAX_TAP_SLOP_PX, MAX_HOLD_SLOP_PX,
} from '../web/ui/bubble-gesture.js';
import { runGuardedFrame, createOnceReporter } from '../web/ui/frame-guard.js';

// ===========================================================================
// 试验台：一个**手动时钟** + 一个**假泡泡** + 事件喂入器
// ===========================================================================
//
// ⚠️ 为什么用手动时钟而不是真 `setTimeout` + `sleep`：
//    · 真等 2.5 秒 × 十几条用例 = 一个套件跑几十秒，没人愿意跑就不会有人跑；
//    · 更要紧的是**"rAF 一次都不跑"这条断言**必须是**确定性**的 ——
//      用真定时器时，"到底跑了几帧"取决于机器忙不忙，测出来的是机器的性能，不是代码。
//   手动时钟把"时间"变成一个可以精确推进的数：推 2500ms 就是推了 2500ms。
function makeHarness({ longPressMs = LONG_PRESS_MS } = {}) {
  let clock = 1000;                      // 起始值随便挑一个**非 0**的（暴露"忘了赋值"这类错）
  const timers = new Map();              // id → { at, fn }
  let nextTimerId = 1;
  const pops = [];
  const cancels = [];
  const holdCancels = [];
  const releases = [];
  const extras = [];
  const holdStarts = [];
  const bubbles = [];

  const bubbleAt = (x, y) => bubbles.find((b) => Math.hypot(b.x - x, b.y - y) <= b.r) || null;

  const g = createBubbleGesture({
    longPressMs,
    now: () => clock,
    setTimer: (ms, fn) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => { timers.delete(id); },
    pick: (x, y) => bubbleAt(x, y),
    onPressBubble: () => {},
    onPressBackground: () => {},
    onMove: () => {},
    onRelease: (c) => releases.push(c),
    onCancel: (info) => cancels.push(info),
    onHoldStart: (b) => holdStarts.push(b),
    onHoldCancel: (reason) => holdCancels.push(reason),
    onHoldFire: (e, b) => pops.push(b),
    onExtraPointer: (e) => extras.push(e),
  });

  /** 推进虚拟时间，按到点顺序触发定时器（模拟浏览器/Node 的定时器语义） */
  const advance = (ms) => {
    const target = clock + ms;
    // 循环：可能有定时器在回调里又排了新的（这里没有，但语义保持一致）
    for (;;) {
      let due = null;
      for (const [id, t] of timers) if (t.at <= target && (!due || t.at < due.t.at)) due = { id, t };
      if (!due) break;
      timers.delete(due.id);
      clock = due.t.at;
      due.t.fn();
    }
    clock = target;
  };

  const ev = (x, y, extra = {}) => ({ pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, ...extra });

  return {
    g,
    advance,
    pops,
    cancels,
    holdCancels,
    releases,
    extras,
    holdStarts,
    bubbles,
    get clock() { return clock; },
    /** 待触发的长按定时器个数（用来断言"取消之后计时器真的清掉了"） */
    get pendingTimers() { return timers.size; },
    down: (x, y, extra) => g.onPointerDown(ev(x, y, extra)),
    move: (x, y, extra) => g.onPointerMove(ev(x, y, extra)),
    up: (x, y, extra) => g.onPointerUp(ev(x, y, extra)),
    cancel: (extra) => g.onPointerCancel(ev(0, 0, extra)),
    /** 造一颗泡泡（pick 用圆心 + 半径的几何命中，和 bubble.js 一致） */
    addBubble(x, y, r = 60) { const b = { x, y, r }; bubbles.push(b); return b; },
  };
}

/** 手指按住不动的常见真机现象：坐标在 1–2px 内抖（不是"完全不动"） */
const jitter = (h, x, y, seconds = 2.5, stepMs = 100, amp = 1.5) => {
  for (let t = 0; t < seconds; t += stepMs / 1000) {
    // 用确定的三角波而不是随机数 —— 测试要可复现
    const dx = Math.sin(t * 7) * amp;
    const dy = Math.cos(t * 5) * amp;
    h.move(x + dx, y + dy);
    h.advance(stepMs);
  }
};

// ===========================================================================
// ① 基线：按住 3 秒不动 → 恰好戳破 1 次
// ===========================================================================
test('按住 3 秒不动 → popEvent 恰好被调用 1 次', () => {
  const h = makeHarness();
  const b = h.addBubble(200, 200);
  h.down(200, 200);
  assert.equal(h.holdStarts.length, 1, '按下就该进入长按（这是"按到了"的即时反馈起点）');

  h.advance(1500);
  assert.equal(h.pops.length, 0, '1.5 秒还不该戳破（阈值是 2.5 秒）');
  h.advance(1000);           // 累计 2.5 秒
  assert.equal(h.pops.length, 1, '到 2.5 秒必须戳破');
  assert.equal(h.pops[0], b, '戳破的必须是按下的那一颗');
  assert.equal(h.pendingTimers, 0, '触发过了就不该再有挂在身上的定时器');

  // 继续按着（手指还没抬）也不能再戳破一次
  h.advance(2000);
  assert.equal(h.pops.length, 1, '按住更久**不能**重复戳破（必须只算一次）');
  h.up(200, 200);
  assert.equal(h.pops.length, 1);
  assert.equal(h.releases.length, 0, '长按已经戳破了，抬手不该再被当成单击/拖动');
});

test('长按阈值就是用户指定的 2.5 秒（边界：2499 不破、2500 破）', () => {
  assert.equal(LONG_PRESS_MS, 2500);
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200);
  h.advance(LONG_PRESS_MS - 1);
  assert.equal(h.pops.length, 0, '差 1ms 不能破（不许为了好看提前触发）');
  h.advance(1);
  assert.equal(h.pops.length, 1);
});

// ===========================================================================
// ② 按住 2 秒就松 → 不戳破，而且**不能**被误判成"拖动"
// ===========================================================================
test('按住 2 秒就松 → 不戳破，且判成单击（不是拖动、不是嵌套）', () => {
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200);
  h.advance(2000);
  h.up(200, 200);
  assert.equal(h.pops.length, 0, '还没到 2.5 秒，不能戳破');
  assert.equal(h.pendingTimers, 0, '抬手必须把长按定时器清掉（否则松手后还会破）');
  assert.equal(h.releases.length, 1, '松手要交给上层判定"单击/双击"');
  const c = h.releases[0];
  assert.equal(c.holdFired, false);
  assert.ok(c.moved < MAX_TAP_SLOP_PX, `位移 ${c.moved} 应该算轻点`);
  assert.equal(Math.round(c.heldMs), 2000, '按住的时长要如实报给上层（它用来挡"拖过又松手"）');
  // 松手之后时间再走多久都不许破 —— 这是"清定时器"最直接的证据
  h.advance(5000);
  assert.equal(h.pops.length, 0, '松手后 5 秒都不许再戳破（定时器没清干净就会出现这个 bug）');
});

// ===========================================================================
// ③ 手指漂移：30px 仍要戳破；超过阈值则取消
// ===========================================================================
test('按住期间漂移 30px（真机手抖）→ 仍必须戳破', () => {
  const h = makeHarness();
  h.addBubble(200, 200, 80);          // 半径够大，30px 漂移还在泡泡里
  h.down(200, 200);
  // 漂移 30px：分 15 步走完，每步 2px（真实手指的漂移就是这种小步累积）
  for (let i = 1; i <= 15; i += 1) {
    h.move(200 + i * 2, 200 + i);     // x 走 30px，y 走 15px → 直线距离 ≈ 33.5px
    h.advance(160);
  }
  assert.ok(h.cancels.length === 0, `漂移不该取消长按（阈值 ${MAX_HOLD_SLOP_PX}px）`);
  h.advance(300);                     // 累计超过 2.5 秒
  assert.equal(h.pops.length, 1, `漂移 ${MAX_HOLD_SLOP_PX}px 以内必须照样戳破（手指不是鼠标）`);
});

test('漂移 80px（明确想拖走）→ 取消长按，不戳破', () => {
  const h = makeHarness();
  h.addBubble(200, 200, 200);         // 半径很大，保证 80px 之外仍"按在泡泡上"
  h.down(200, 200);
  for (let i = 1; i <= 16; i += 1) { h.move(200 + i * 5, 200); h.advance(150); }   // 80px
  h.advance(1500);
  assert.equal(h.pops.length, 0, '拖走 80px 之后不该再戳破');
  // ⚠️ 取消长按有**两个**回调，别混：
  //    · `onHoldCancel` = "长按这件事结束了"（手指挪太远/抬手/被掐断）——每次都会来
  //    · `onCancel`     = "整次手势被系统打断了"（要复位 dragBody）——只在打断时来
  //    两者名字像、作用完全不同；测试里必须分开收，否则会写出"看起来通过、
  //    其实什么都没断言到"的假测试。
  assert.equal(h.holdCancels.length, 1, '长按被取消必须通知上层（否则泡泡会僵在拖动态）');
  assert.equal(h.holdCancels[0], 'drifted-too-far', `取消原因要说清是"漂移太远"，实际 ${h.holdCancels[0]}`);
});

test('拖动阈值与长按漂移阈值是**两个数**，而且后者明显更宽', () => {
  // 这一条是"把手指的阈值当成鼠标的写"那个历史 bug 的防复发断言：
  // 只要有人把 MAX_HOLD_SLOP_PX 调成 MAX_TAP_SLOP_PX（或者删掉其中一个），这里就红。
  assert.ok(MAX_HOLD_SLOP_PX > MAX_TAP_SLOP_PX * 2,
    `长按漂移阈值(${MAX_HOLD_SLOP_PX}) 必须明显宽于点击/拖动阈值(${MAX_TAP_SLOP_PX})：`
    + '手指按 2.5 秒必然漂移十几像素，用点击阈值当长按门槛等于把长按做废');
  assert.equal(MAX_TAP_SLOP_PX, 12, '点击/拖动阈值保持原来的手感（12px）');
});

// ===========================================================================
// ④ 被掐断（pointercancel）→ 不戳破 + **状态复位** + 下一次仍然能戳破
// ===========================================================================
test('按住 1 秒后 pointercancel → 不戳破、状态复位、紧接着再按 3 秒仍能戳破', () => {
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200);
  h.advance(1000);
  h.cancel();                                        // iOS 把手势接管了
  assert.equal(h.pops.length, 0, '被掐断不能戳破');
  assert.equal(h.pendingTimers, 0, '被掐断必须清掉长按定时器');
  assert.equal(h.cancels.length, 1, '要通知上层"这次手势被取消了"（它要复位 dragBody）');
  assert.equal(h.cancels[0].reason, 'pointercancel');
  // 掐断之后即使时间再走很久也不许"延迟爆炸"
  h.advance(5000);
  assert.equal(h.pops.length, 0);

  // ⚠️⚠️ 这一条是本次报障最关键的回归：**掐断一次之后，下一次长按还灵不灵**。
  //    老实现只清 hold、不清 dragBody/dragging，于是"被系统掐断一次之后，
  //    下一次怎么按都没反应"。
  const s1 = h.g.state();
  assert.equal(s1.activeId, null, '掐断后 activeId 必须清空（否则下一次 pointerdown 会被当成"第二根手指"直接忽略）');
  assert.equal(s1.holding, false);
  assert.equal(s1.target, null);

  h.down(200, 200, { pointerId: 7 });                // 换一个 pointerId，模拟真机上新一轮触摸
  h.advance(3000);
  assert.equal(h.pops.length, 1, '掐断之后**再按一次必须仍然能戳破**（复位不干净就会死在这里）');
});

test('pointercancel 的 pointerId 不匹配时不能误伤正在进行的手势', () => {
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200, { pointerId: 3 });
  h.advance(500);
  h.cancel({ pointerId: 9 });                        // 别的触点的 cancel
  h.advance(2500);
  assert.equal(h.pops.length, 1, '无关指针的 cancel 不该取消这次长按');
});

// ===========================================================================
// ⑤ contextmenu（iOS 长按菜单）→ 不戳破、不崩、计时器清掉
// ===========================================================================
test('长按期间来 contextmenu → 不戳破、计时器清掉、状态复位、下一次仍能戳破', () => {
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200);
  h.advance(1200);
  let prevented = false;
  h.g.onContextMenu({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, '必须拦掉系统菜单（否则它会盖住泡泡区、还抢走手势）');
  assert.equal(h.pops.length, 0);
  assert.equal(h.pendingTimers, 0, '菜单之后不许留下计时器（否则会"延迟爆炸"）');
  assert.equal(h.g.state().activeId, null, '状态要复位');
  h.advance(4000);
  assert.equal(h.pops.length, 0, '被菜单打断后不许再戳破');
  // 再按一次照样得行
  h.down(200, 200, { pointerId: 5 });
  h.advance(2600);
  assert.equal(h.pops.length, 1);
});

test('contextmenu 的事件对象没有 preventDefault 也不许抛', () => {
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200);
  h.advance(600);
  assert.doesNotThrow(() => h.g.onContextMenu({}));
  assert.doesNotThrow(() => h.g.onContextMenu(null));
  assert.equal(h.pops.length, 0);
  assert.equal(h.pendingTimers, 0);
});

// ===========================================================================
// ⑥ 多指：第二根手指按上来一律取消
// ===========================================================================
test('长按期间第二根手指按下 → 取消长按、不戳破，且第二根手指不会接管', () => {
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200, { pointerId: 1 });
  h.advance(1500);
  h.down(210, 210, { pointerId: 2, isPrimary: false });   // 掌根/第二根手指
  assert.equal(h.pops.length, 0, '多指必须取消长按（不能继续数着秒）');
  assert.equal(h.pendingTimers, 0, '多指要清掉计时器');
  assert.equal(h.extras.length, 1, '要告诉上层"多碰了一根手指"（界面要给个说法）');
  h.advance(4000);
  assert.equal(h.pops.length, 0);
  // 第一根手指抬起来也不该被当成正常松手 → 否则会误触"单击 = 编辑"
  const releasesBefore = h.releases.length;
  h.up(200, 200, { pointerId: 1 });
  assert.equal(h.releases.length, releasesBefore, '被多指取消的手势，抬手不该再派发"单击"');
});

test('非主指针（isPrimary=false）单独按下不开始手势', () => {
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200, { pointerId: 2, isPrimary: false });
  h.advance(3000);
  assert.equal(h.pops.length, 0, '非主指针不该触发长按');
  assert.equal(h.pendingTimers, 0);
  assert.equal(h.extras.length, 1);
});

test('别的指针的 pointerup 不会提前结束长按', () => {
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200, { pointerId: 1 });
  h.advance(1000);
  h.up(50, 50, { pointerId: 8 });          // 另一个触点的抬手
  assert.equal(h.pendingTimers, 1, '无关指针抬手不该清掉长按计时器');
  h.advance(1600);
  assert.equal(h.pops.length, 1, '长按照样要破');
});

// ===========================================================================
// ⑦ 失焦 / 切后台 → 取消并复位（iOS 上 pointerup 可能永远不来）
// ===========================================================================
test('失焦（blur）→ 取消长按并复位', () => {
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200);
  h.advance(1000);
  h.g.onBlur();
  assert.equal(h.pops.length, 0);
  assert.equal(h.pendingTimers, 0);
  assert.equal(h.g.state().activeId, null);
  h.advance(4000);
  assert.equal(h.pops.length, 0);
});

// ===========================================================================
// ⑧ 进度环：按住 1 秒 ≈ 40%，松手归零
// ===========================================================================
test('进度环：按住 1 秒时进度 ≈ 40%（±10%），松手后归零', () => {
  const h = makeHarness();
  h.addBubble(200, 200);
  assert.equal(h.g.progress(), 0, '没按的时候进度是 0');
  h.down(200, 200);
  assert.equal(h.g.progress(), 0, '刚按下是 0（但已经是"按到了"的状态）');
  h.advance(1000);
  const p = h.g.progress();
  assert.ok(p > 0.3 && p < 0.5, `按住 1 秒的进度应该在 40%±10%，实际 ${p}`);
  assert.ok(Math.abs(p - 1000 / LONG_PRESS_MS) < 1e-9, '进度必须严格等于 已按毫秒/阈值');
  h.advance(1500);                                   // 到点
  assert.equal(h.pops.length, 1);
  assert.equal(h.g.progress(), 0, '戳破之后进度归零');
  h.up(200, 200);
  assert.equal(h.g.progress(), 0, '松手后进度必须是 0（那圈红环不能留在屏幕上）');
});

test('背景上的按下**没有**进度环（长按戳破只对泡泡有效）', () => {
  const h = makeHarness();
  h.addBubble(600, 600);                 // 泡泡在别处
  h.down(100, 100);                      // 按在空白处
  h.advance(1000);
  assert.equal(h.g.progress(), 0, '背景上没有长按，进度必须一直是 0');
  h.advance(3000);
  assert.equal(h.pops.length, 0, '背景上按住多久都不该戳破任何泡泡');
  h.up(100, 100);
  assert.equal(h.releases.length, 1, '背景抬手要交给上层判"单击/双击背景"');
  assert.equal(h.releases[0].target, null);
});

// ===========================================================================
// ⑨ **rAF 一次都不跑**也照样戳破（本次报障的核心断言）
// ===========================================================================
test('★ rAF 一次都不回调 → 长按 3 秒**仍然**戳破（长按与渲染循环解耦）', () => {
  // 这条断言就是"节日改动 → 帧循环死 → 长按失效"那条链的回归测试。
  // 场景：帧循环已经死了（没有任何一帧回调），此时用户长按泡泡。
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200);
  // ⚠️ 注意：这里**故意**不调用任何"推进一帧"的东西（没有 progress()、没有 paint）。
  //    长按的触发只挂在注入的定时器上，所以推进虚拟时间就够了。
  h.advance(3000);
  assert.equal(h.pops.length, 1,
    '渲染循环死了也必须能戳破 —— 长按的判定绝不能依赖 requestAnimationFrame');
});

test('★ 帧循环死了的时候，进度环只是"不动"，但戳破照旧（两者的分工要说清）', () => {
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200);
  // 模拟"帧循环死了"：没有任何人调用 progress()（画笔不跑）。
  h.advance(1000);
  assert.equal(h.pops.length, 0);
  // 循环即便活着也只是"读进度来画"，它读不读都不影响判定
  const p = h.g.progress();
  assert.ok(p > 0.3 && p < 0.5, '进度是"读出来"的，不是"被推进"的');
  h.advance(1600);
  assert.equal(h.pops.length, 1);
});

test('★ 帧回调抛异常时，循环**继续**（runGuardedFrame 的 finally 续排）', () => {
  // 用户补的线索把这条推到第一嫌疑：帧里任何一处抛出都会让
  // `raf = requestAnimationFrame(frame)` 不再执行 → 长按（老实现）永远不触发。
  let frames = 0;
  let reschedules = 0;
  let bodyThrows = 0;
  const errors = [];
  const report = createOnceReporter((e) => errors.push(e));

  const body = () => {
    frames += 1;
    if (frames <= 3) { bodyThrows += 1; throw new Error('同一帧错误'); }
  };
  // 跑 10 帧：前 3 帧抛，后 7 帧正常。**无论抛不抛都必须续排**。
  for (let i = 0; i < 10; i += 1) {
    runGuardedFrame(body, { reschedule: () => { reschedules += 1; }, onError: report });
  }
  assert.equal(frames, 10, '帧回调必须每次都真的跑了（没人能吞掉它）');
  assert.equal(bodyThrows, 3);
  assert.equal(reschedules, 10,
    '★ 每一帧都必须续排下一次 —— 抛异常的帧**也**必须续排（这就是"循环死掉"的修法）');
  assert.equal(errors.length, 1, '同一条错误只报一次（每帧弹 toast 会把屏幕刷满、盖住真问题）');

  // 换了错误内容就要再报一次（换错误 = 换了新根因，不能一起被"只报一次"吞掉）
  const report2 = createOnceReporter((e) => errors.push(e));
  runGuardedFrame(() => { throw new Error('另一条错误'); }, { reschedule: () => {}, onError: report2 });
  assert.equal(errors.length, 2, '错误内容变了必须再报（否则第二个根因永远查不到）');
});

test('runGuardedFrame：body 提前 return / onError 自己抛 / onError 没给，都不许停下循环', () => {
  let reschedules = 0;
  const reschedule = () => { reschedules += 1; };

  // body 提前 return
  runGuardedFrame(() => {}, { reschedule });
  assert.equal(reschedules, 1);

  // onError 自己抛
  reschedules = 0;
  assert.doesNotThrow(() => {
    runGuardedFrame(() => { throw new Error('frame'); }, {
      reschedule,
      onError: () => { throw new Error('连上报都炸了'); },
    });
  });
  assert.equal(reschedules, 1, '上报炸了也必须续排（否则"报错"本身变成了"循环死掉"的原因）');

  // 没给 onError
  reschedules = 0;
  assert.doesNotThrow(() => runGuardedFrame(() => { throw new Error('x'); }, { reschedule }));
  assert.equal(reschedules, 1);
});

test('runGuardedFrame：视图已停掉时**不续排**（否则旧循环和新视图的循环一起跑）', () => {
  let reschedules = 0;
  let stopped = false;
  const run = () => runGuardedFrame(() => { throw new Error('x'); }, {
    reschedule: () => { reschedules += 1; },
    isStopped: () => stopped,
  });
  run();
  assert.equal(reschedules, 1);
  stopped = true;
  run();
  assert.equal(reschedules, 1, '停掉之后不许再续排');
});

// ===========================================================================
// ⑩ 长按到点的回调**自己抛**时，手势不许卡死
// ===========================================================================
test('onHoldFire 抛异常 → 手势仍然复位，下一次长按照样能破', () => {
  let fired = 0;
  let clock = 0;
  const timers = new Map();
  let id = 0;
  const g = createBubbleGesture({
    now: () => clock,
    setTimer: (ms, fn) => { id += 1; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimer: (i) => timers.delete(i),
    pick: () => ({ x: 0, y: 0, r: 1 }),
    onHoldFire: () => { fired += 1; if (fired === 1) throw new Error('popEvent 同步抛了'); },
    onError: () => {},
  });
  const ev = { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 0, clientY: 0 };
  g.onPointerDown(ev);
  const run = () => { for (const [i, t] of timers) { timers.delete(i); clock = t.at; t.fn(); } };
  clock = 3000; run();
  assert.equal(fired, 1);
  assert.equal(g.state().activeId, null, '回调抛了也必须复位（否则"戳破失败一次"= 长按从此报废）');
  g.onPointerDown(ev);
  clock = 7000; run();
  assert.equal(fired, 2, '再按一次必须仍然能戳破');
});

// ===========================================================================
// ⑪ destroy：视图销毁时必须清掉定时器
// ===========================================================================
test('destroy() 清掉长按定时器（视图销毁后不许再有"戳破"请求发出）', () => {
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200);
  h.advance(1000);
  h.g.destroy('view-stopped');
  assert.equal(h.pendingTimers, 0, 'destroy 必须清定时器');
  h.advance(6000);
  assert.equal(h.pops.length, 0, '视图没了之后不许再戳破泡泡');
});

// ===========================================================================
// ⑫ 时钟口径：全程只有一个时钟（混用 Date.now / performance.now 会让差值荒谬）
// ===========================================================================
test('整个状态机只用注入的那一个时钟（不给 now 时有兜底，但不会混用）', () => {
  // 手动时钟从 1000 起（故意不用 0）：如果代码里偷偷用了 Date.now()，
  // 算出来的差值会是"1.7e12 这么大"，判定就永远不会成立 —— 这条就是抓它。
  const h = makeHarness();
  h.addBubble(200, 200);
  h.down(200, 200);
  h.advance(2500);
  assert.equal(h.pops.length, 1,
    '时钟必须统一：混用 Date.now()/performance.now() 会让"按了多久"算成天文数字 → 永远不触发');
  assert.equal(Math.round(h.g.state().elapsed), 0, '戳破之后 elapsed 归零（状态已复位）');
});

// ===========================================================================
// ⑬ 阈值本身：默认参数不许被人偷偷调成鼠标值
// ===========================================================================
test('默认阈值与模块导出一致（防止有人只改一处）', () => {
  const h = makeHarness();
  assert.equal(h.g.longPressMs, LONG_PRESS_MS);
  assert.equal(h.g.maxTapSlop, MAX_TAP_SLOP_PX);
  assert.equal(h.g.maxHoldSlop, MAX_HOLD_SLOP_PX);
});
