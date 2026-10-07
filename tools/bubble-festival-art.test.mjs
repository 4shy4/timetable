// 节日图案绘制（`drawFestivalArt`）的**状态栈契约**与"帧内不许抛"回归测试。
//
// ===========================================================================
// 为什么有这个文件（用户补的那条线索："之前长按有效，应该也和节日改动有关"）
// ===========================================================================
//
// 这条线索指向的机制是：
//   节日图案是后来才加进**绘制路径**的 → 它给"帧里抛出"和"canvas 状态错位"
//   多开了几个入口 → 帧循环一旦死掉：
//     · 泡泡不再重画        = 用户之前报的"泡泡隐身了但还能点到"
//     · 长按再也不触发      = 本次报的"长按 2.5 秒无响应"（老实现的计时活在帧循环里）
//     · 单击/双击照旧正常    = 它们在 pointerup 分支里，不经过循环
//   （长按那一半的修法在 web/ui/bubble-gesture.js + tools/bubble-longpress.test.mjs；
//     这里钉的是**绘制这一侧**的两个真问题。）
//
// ── 真问题一：save/restore **不配对** ────────────────────────────────────
//   老代码：`drawFestivalArt()` **内部** save/restore（要 clip 成圆），
//   而调用方 `paintBubble` 的 catch 里又补了一句 `ctx2d.restore()` "兜底"。
//   两者一叠加就成了错位的栈操作：
//     · throw 发生在**内部 save 之前** → 那句 restore 弹掉的是**别人**的 save；
//     · 栈一旦错位，后续所有泡泡都跑在错位的状态里（`clip()` 还在生效 →
//       **后面的泡泡被裁掉 → 看起来就是"泡泡隐身了"**）。
//   ⚠️ 这类 bug 的特点：**不抛异常、代码里也不报错**，只是画面不对。
//      所以必须有一条断言直接盯着"状态栈深度回到 0"，别的测法都抓不到它。
//
// ── 真问题二：形状清单脏了会把**泡体**一起带走 ──────────────────────────
//   图案规格来自 `core/festival-art.js` 的形状清单。清单脏了（坐标是字符串、
//   pts 不是数组、颜色是 undefined 让 fillStyle 收下垃圾…）就可能抛。
//   抛了只该"少一张背景"，不该把这一颗的泡体也丢掉。
//
// 跑法：`node tools/bubble-festival-art.test.mjs`
//
// ⚠️ 这里**从真实源码里抽取函数定义**（`web/ui/views/bubble.js` 的
//    `drawFestivalArt`）在 Node 里跑 —— 不是抄一份形状。
//    照抄一份的话，源码改了、测试还是绿的，那是假测试。
//    抽取方式与 `tools/bubble-finite.test.mjs` 的"假 canvas 当 WebKit"同一个思路。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { festivalArt, allMotifs } from '../core/festival-art.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUBBLE_JS = path.join(HERE, '..', 'web', 'ui', 'views', 'bubble.js');
const SRC = fs.readFileSync(BUBBLE_JS, 'utf8');

/**
 * 从 bubble.js 里抽出 `drawFestivalArt` 的**真实定义**。
 *
 * ⚠️ 抽取必须"要么成功、要么响"：抽不到就直接抛（`assert` 一条明确的错误），
 *    绝不允许悄悄退化成"跳过测试" —— 那会让这个套件变成永远绿的空壳。
 */
function extractFestivalArtSource() {
  const start = SRC.indexOf('function drawFestivalArt(');
  assert.ok(start > 0, '在 bubble.js 里找不到 drawFestivalArt（被改名/搬走了？这个测试必须跟着改）');
  // 从函数体第一个 `{` 开始做花括号配平（deps 里的函数名不会出现裸的 { }，配平是可靠的）
  const bodyStart = SRC.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < SRC.length; i += 1) {
    const ch = SRC[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > 0, 'drawFestivalArt 的花括号没配平（抽取失败）');
  return SRC.slice(start, end);
}

const FESTIVAL_ART_SRC = extractFestivalArtSource();

/** 假 canvas 的状态栈：**只记 save/restore 深度** + 调用了哪些方法 */
function makeStackCtx({ throwOn = [] } = {}) {
  const st = { depth: 0, maxDepth: 0, saves: 0, restores: 0, calls: [], clips: 0 };
  const check = (name) => {
    if (throwOn.includes(name)) throw new Error(`假的 canvas：${name} 按剧本抛了`);
  };
  const rec = (name) => (...args) => {
    void args;
    st.calls.push(name);
    check(name);
  };
  const ctx = {
    get state() { return st; },
    save() { st.depth += 1; st.saves += 1; st.maxDepth = Math.max(st.maxDepth, st.depth); st.calls.push('save'); },
    restore() {
      st.depth -= 1;
      st.restores += 1;
      st.calls.push('restore');
      // 负深度 = "弹了不属于自己的那一层" —— canvas 里不会有异常，但状态从此错位
      assert.ok(st.depth >= 0, 'restore() 比 save() 多了一次（状态栈被弹穿了）——这正是"泡泡隐身"那类错位的来源');
    },
    beginPath: rec('beginPath'),
    closePath: rec('closePath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    arc: rec('arc'),
    ellipse: rec('ellipse'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    drawImage: rec('drawImage'),
    clip() { st.clips += 1; check('clip'); st.calls.push('clip'); },
    setLineDash: rec('setLineDash'),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
  };
  return ctx;
}

const makeDraw = (ctx, { artImageFor } = {}) => {
  // 真函数体 + 两个来自 bubble.js 模块作用域的依赖：颜色常量与图片缓存
  const factory = new Function(
    'festivalArt', 'FESTIVAL_ART_ALPHA', 'artImageFor',
    `${FESTIVAL_ART_SRC}\n return drawFestivalArt;`,
  );
  return factory(
    festivalArt,
    0.42,
    artImageFor || ((src) => ({ src, complete: false, naturalWidth: 0 })),
  );
};

const B = { x: 300, y: 200 };

// ===========================================================================
// ① 契约：`drawFestivalArt` **自己不许碰状态栈**（save/restore 归调用方）
// ===========================================================================
test('契约：drawFestivalArt 内部不许 save/restore（否则调用方的 catch 会弹穿状态栈）', () => {
  const ctx = makeStackCtx();
  const draw = makeDraw(ctx);
  draw(ctx, B, 72, 'spring', {}, 0.88);
  assert.equal(ctx.state.saves, 0, '这个函数里不许有 ctx.save()（它是"对不齐的 restore"的根源）');
  assert.equal(ctx.state.restores, 0, '这个函数里不许有 ctx.restore()');
  assert.equal(ctx.state.depth, 0, '不许改变状态栈深度');
  assert.ok(ctx.state.clips === 1, '但它**必须**把图案裁成圆形（这是它自己的活）');
});

// ===========================================================================
// ② 所有节日图案 × 成功/抛异常 → 状态栈深度必须回到 0
// ===========================================================================
test('每个节日图案都画得出来，而且 clip 被 restore 清掉（栈深度回到 0）', () => {
  const motifs = allMotifs();
  assert.ok(motifs.length >= 8, `图案太少了（${motifs.length}），这个测试会变得没意义`);
  // 用**所有**图案的 key 去画；key 从 motif id 反查不方便，就直接遍历真实节日 key 表
  const keys = ['spring', 'midautumn', 'dragon', 'national', 'christmas', 'newyear', 'lantern', 'qingming', '不存在的节日'];
  for (const key of keys) {
    const ctx = makeStackCtx();
    const draw = makeDraw(ctx);
    // ⚠️ 严格照抄 paintBubble 里的调用形状：
    //      save → 调用 → (catch) → finally restore
    ctx.save();
    try {
      draw(ctx, B, 72, key, {}, 0.88);
    } finally {
      ctx.restore();
    }
    assert.equal(ctx.state.depth, 0, `节日「${key}」画完之后状态栈必须回到 0（实际 ${ctx.state.depth}）`);
    assert.ok(ctx.state.saves === 1 && ctx.state.restores === 1, `节日「${key}」的 save/restore 必须严格配对`);
    assert.ok(ctx.state.calls.length > 3, `节日「${key}」看起来根本没画（只调用了 ${ctx.state.calls.length} 次）`);
    // globalAlpha 不许被留成脏值（真实的 ctx 里它由 restore 恢复；这里只确认赋值是有限数）
    assert.ok(Number.isFinite(ctx.globalAlpha), `节日「${key}」把 globalAlpha 写成了非有限数：${ctx.globalAlpha}`);
    assert.ok(ctx.globalAlpha > 0 && ctx.globalAlpha <= 1, `节日「${key}」的 globalAlpha 越界：${ctx.globalAlpha}`);
  }
});

test('★ 图案画挂了（fill 抛）：栈深度仍然回到 0，而且**绝不弹穿**', () => {
  const ctx = makeStackCtx({ throwOn: ['fill'] });
  const draw = makeDraw(ctx);
  // 严格照抄 paintBubble 的形状（save → try → catch → finally restore）
  ctx.save();
  assert.throws(() => {
    try {
      draw(ctx, B, 72, 'spring', {}, 0.88);
    } finally {
      ctx.restore();
    }
  }, /假的 canvas/);
  assert.equal(ctx.state.depth, 0, '抛了之后状态栈也必须回到 0（clip 不许留下来）');
  assert.equal(ctx.state.saves, 1);
  assert.equal(ctx.state.restores, 1, 'restore 必须恰好一次 —— 多一次就是"弹穿"，后续泡泡全在错位状态里画');
});

test('★ 图案画挂了（clip 抛）：同样不许影响后面的绘制', () => {
  const ctx = makeStackCtx({ throwOn: ['clip'] });
  const draw = makeDraw(ctx);
  ctx.save();
  assert.throws(() => {
    try { draw(ctx, B, 72, 'midautumn', {}, 0.88); } finally { ctx.restore(); }
  });
  assert.equal(ctx.state.depth, 0);
  // 紧接着画一颗"普通泡泡"（模拟同一帧的下一颗）—— 它也必须在干净的状态下画
  const ctx2 = makeStackCtx();
  const draw2 = makeDraw(ctx2);
  ctx2.save();
  try { draw2(ctx2, B, 72, 'dragon', {}, 0.88); } finally { ctx2.restore(); }
  assert.equal(ctx2.state.depth, 0, '下一颗泡泡必须在干净的状态栈里画');
});

// ===========================================================================
// ③ 自定义图片（用户自己换的图）这条路
// ===========================================================================
test('自定义图片：完整的 Image 会画出来；没解码完就跳过（不许抛）', () => {
  const dataUrl = 'data:image/png;base64,AAAA';
  // 没解码完（naturalWidth = 0）：不该抛、也不该 drawImage
  const ctx1 = makeStackCtx();
  makeDraw(ctx1, { artImageFor: () => ({ complete: false, naturalWidth: 0 }) })(
    ctx1, B, 72, 'spring', { spring: dataUrl }, 0.88,
  );
  assert.equal(ctx1.state.calls.includes('drawImage'), false, '没解码完就不该 drawImage');
  // 解码完：必须画，而且是"填满圆形"（cover）
  const ctx2 = makeStackCtx();
  makeDraw(ctx2, { artImageFor: () => ({ complete: true, naturalWidth: 256, naturalHeight: 128 }) })(
    ctx2, B, 72, 'spring', { spring: dataUrl }, 0.88,
  );
  assert.ok(ctx2.state.calls.includes('drawImage'), '解码完之后必须把图铺上');
});

// ===========================================================================
// ④ 脏形状清单：不许把泡体一起带走（要么画出来、要么抛给调用方兜住）
// ===========================================================================
test('脏形状清单（坐标是字符串 / pts 不是数组 / 颜色是 undefined）：不许静默画错，也不许弹穿栈', () => {
  // 直接构造一份"脏图案规格"喂进去：这里绕过 festivalArt()，
  // 用最脏的输入看这个函数的防御边界在哪。
  const factory = new Function(
    'festivalArt', 'FESTIVAL_ART_ALPHA', 'artImageFor',
    `${FESTIVAL_ART_SRC}\n return drawFestivalArt;`,
  );
  const dirty = [
    { shapes: [{ t: 'c', x: '不是数', y: 50, r: 10, color: '#fff' }] },
    { shapes: [{ t: 'l', pts: '不是数组', color: '#fff' }] },
    { shapes: [{ t: 'p', pts: null, color: '#fff' }] },
    { shapes: [{ t: 'e', x: 50, y: 50, rx: 10, ry: 10, color: undefined }] },
    { shapes: [{ t: '不认识', x: 1, y: 1 }] },
    { shapes: null },
    { shapes: undefined },
  ];
  for (const [i, art] of dirty.entries()) {
    const draw = factory(() => art, 0.42, () => ({ complete: false, naturalWidth: 0 }));
    const ctx = makeStackCtx();
    ctx.save();
    let threw = null;
    try {
      draw(ctx, B, 72, 'spring', {}, 0.88);
    } catch (err) {
      threw = err;      // 抛出去也**可以接受**（paintBubble 有 try/catch 兜住这一颗），
                        // 但绝不允许"悄悄画错"或"弄乱状态栈"
    } finally {
      ctx.restore();
    }
    assert.equal(ctx.state.depth, 0,
      `第 ${i} 份脏图案：画完/抛完状态栈必须回到 0（实际 ${ctx.state.depth}）。`
      + '这一条就是"泡泡隐身"的探针：clip 没被 restore 掉，后面的泡泡就会被裁掉。');
    assert.equal(ctx.state.restores, 1, `第 ${i} 份脏图案：restore 必须恰好一次（多一次就是弹穿）`);
    void threw;
  }
});

// ===========================================================================
// ⑤ paintBubble 里的调用形状（源码级）：save 与 finally restore 必须成对出现
// ===========================================================================
test('paintBubble 里的节日图案那一段：save / finally restore 成对（源码级钉住）', () => {
  const i = SRC.indexOf('const festKey = b.item && b.item.event && b.item.event.festivalKey;');
  assert.ok(i > 0, '找不到节日图案那段调用（被重写了？这个断言要跟着改）');
  const seg = SRC.slice(i, i + 900);
  assert.match(seg, /ctx2d\.save\(\)/, '这一段的 save 必须写在调用方（不能靠被调函数自己 save）');
  assert.match(seg, /finally\s*\{[\s\S]*ctx2d\.restore\(\)/, '必须在 finally 里 restore（否则抛了就回不去）');
  // ⚠️ 反面对照：老写法是 catch 里孤立一句 restore —— 那种写法必须不再出现
  assert.ok(!/catch[\s\S]{0,200}?ctx2d\.restore\s*&&/.test(seg),
    '不许再出现"catch 里孤立一句 ctx2d.restore && ctx2d.restore()"——那会弹穿状态栈');
});

// ===========================================================================
// ⑥ 帧循环护栏（frame-guard）与"节日图案"的联动：一帧里图案抛了也不许停循环
// ===========================================================================
import { runGuardedFrame, createOnceReporter } from '../web/ui/frame-guard.js';

test('★ 一帧里节日图案抛异常 → 循环继续（这才是"长按还能用"的前提）', () => {
  let frames = 0;
  let reschedules = 0;
  const errors = [];
  const report = createOnceReporter((e) => errors.push(e));
  const frameBody = () => {
    frames += 1;
    if (frames === 2) {
      // 模拟"节日图案把这一帧搞挂了"（发生在每颗泡泡的 try/catch 之外的那种抛出）
      throw new Error('drawFestivalArt 抛了：形状清单脏了');
    }
  };
  for (let i = 0; i < 6; i += 1) {
    runGuardedFrame(frameBody, { reschedule: () => { reschedules += 1; }, onError: report });
  }
  assert.equal(frames, 6, '第 2 帧抛了，但后面 4 帧必须照样跑');
  assert.equal(reschedules, 6, '每一帧都要续排 —— 循环死掉正是"长按无响应"的机制');
  assert.equal(errors.length, 1, '同一条错误只报一次');
});
