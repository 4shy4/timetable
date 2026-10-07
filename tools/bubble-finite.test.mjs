// 「喂给 canvas 的每一个数都必须是有限数」——**回归测试**。
//
// 为什么必须有一个这样的套件（用户报的真实现象，iPad 0.10.11）：
//   错误条：`The provided value is non-finite`（这是 WebKit 对 canvas 的原话）
//   现象：**整个气泡区不显示泡泡了，可是还能点到**（命中判定走几何模型，绘制走 canvas）
//   → 绘制循环在某一颗泡泡上抛异常、**整帧中断**。`createRadialGradient`/`arc`/`ellipse`
//     只要收到 NaN 或 Infinity 就抛；**一颗坏泡泡能让整块气泡区变空白**。
//
// 历史上同一类事故（第 48 轮）：节日泡泡的 style 是**手写**的、漏了 `radius`
//   → `mass = Math.max(1, NaN) = NaN` → 位置全变 NaN → 同一个报错。
//   当时的修法是"节日泡泡改走 bubbleStyle()" + "渲染器给 r 加兜底"。
//   **这次是另一个触发源**（实测：`style.level` 变成字符串/缺 rank），所以这里不是
//   只测某一处兜底，而是把**整条链**钉住：
//     ① 覆盖矩阵：各种真实/脏数据下，core 算出来的每个数都必须是有限数（或明确的兜底值）
//     ② 上一类事故那条链：`radius` 缺失 → `mass` NaN → 位置 NaN → canvas 抛
//     ③ 三个高危写法逐个审（见下面 HIGH-1/HIGH-2/HIGH-3 的注释与断言）
//     ④ 真画一遍：用"拿到非有限数就抛"的假 canvas 当尺子（对着真实绘制代码的形状）
//
// 跑法：node tools/bubble-finite.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  drawNumbersOf, bubbleDrawDiagnostic, sanitizeDrawNumber, finiteOr, safeLevelOf,
  alphaOfStyle, SAFE_RADIUS, SAFE_FALLBACK_ALPHA,
} from '../core/bubble-draw-numbers.js';
import { bubbleStyle, TYPE_DEFAULT_LEVEL, defaultLevelForType, defaultLevelObjectForType, notifyStyleForIntensity } from '../core/urgency.js';
import { selectBubbleItems } from '../core/bubble-select.js';
import { levelByKey, rankOf, clampIntensity, DEFAULT_LEVEL, LEVELS } from '../core/level.js';
// ⚠️ 这里原来 import 了 bandForRemaining，只用来把"没期限 → 秒档"那个 bug 当真值断言。
//    那条断言已经改成按正确期望断言（见下面高危3b），import 一并去掉。
//    "没期限 → unset" 本身由 tools/bubble-band-unset.test.mjs 逐档钉住。
import { safeRgba } from '../core/palette.js';

const NOW = new Date('2026-09-27T12:00:00');
const at = (h) => new Date(NOW.getTime() + h * 3_600_000);

/**
 * 造一颗 item：先走**真**的 `bubbleStyle()`（生产里就是这么来的），
 * 再允许按用例把它弄脏 —— 这样测的就是"真产物 + 真脏值"。
 */
function makeItem(ev, extra = {}) {
  const item = {
    event: { id: ev.id || 'ev', title: '测试', level: 'amber', ...ev },
    start: at(20),
    end: at(22),
    key: (ev.id || 'ev') + '@2026-09-28',
  };
  // 「期限」的优先级和 `core/state-ops.js` 的 deadlineMsOf 一致：deadline > end > start。
  // ⚠️ 事件级和 item 级**都要**按这个优先级给，否则"没有期限"那个用例根本造不出来
  //    （item.end 还留着 → 照样算得出剩余时间）。
  const dl = ev.deadline !== undefined ? ev.deadline : (ev.end !== undefined ? ev.end : ev.start);
  if (dl !== undefined) item.event.deadline = dl;
  if (ev.start !== undefined) item.start = ev.start;
  if (ev.end !== undefined) item.end = ev.end;
  item.deadline = (dl === undefined || dl === null) ? null : dl;
  item.style = bubbleStyle(item, { now: NOW });
  Object.assign(item, extra);
  return item;
}

/** 造一颗**真·没有期限**的 item（deadline/end/start 全没有 → remaining 必须是 null） */
function makeNoDeadlineItem() {
  const item = { event: { id: 'nodl', title: '没期限', level: 'sky' }, start: at(20), end: at(22), deadline: null };
  item.style = bubbleStyle(item, { now: NOW });
  return item;
}

const GEO = {
  x: 640, y: 400, r: 72, theta: 0.3, squash: 0.08, hold: 0.4, shakeX: 1.5,
};
/** measure 桩：不依赖 canvas，但会**故意**对某些输入返回 NaN，看兜底有没有生效 */
const measureStub = (title, maxWidth, fontSize, maxLines) => {
  void maxWidth;
  const t = String(title || '');
  const lines = [];
  for (let i = 0; i < t.length && lines.length < maxLines; i += 1) lines.push(t[i]);
  return { lines: lines.length ? lines : [t || '(无标题)'], fontSize };
};

/** 一个字段一个字段地断言"有限数"（`problems` 里点名的字段允许是被兜底过的） */
function assertAllFinite(values, label, problems) {
  const repaired = new Set((problems || []).map((p) => p.field));
  for (const [k, v] of Object.entries(values)) {
    if (typeof v !== 'number') continue;
    assert.ok(
      Number.isFinite(v),
      `${label}: values.${k} = ${v} 不是有限数（兜底字段：${[...repaired].join(',') || '无'}）`,
    );
  }
}

// ===========================================================================
// ① 覆盖矩阵：每种输入下，全部数字都必须是有限数
// ===========================================================================

/** [名字, 事件, 额外的脏化操作] —— 每一项都会进 `drawNumbersOf` */
const MATRIX = [
  ['普通事件', { id: 'm-normal', title: '交实验报告', level: 'amber' }, null],
  ['没有 deadline（remaining == null）', { id: 'm-nodl', title: '没期限', level: 'sky' }, (it) => {
    delete it.event.deadline; delete it.event.end; delete it.event.start;
    it.deadline = null;
    it.style = bubbleStyle(it, { now: NOW });
  }],
  ['已 done', { id: 'm-done', title: '已完成', level: 'sky', done: true, start: at(-5), end: at(-4), deadline: at(-4) }, null],
  ['已逾期', { id: 'm-over', title: '逾期了', level: 'red', start: at(-30), end: at(-28), deadline: at(-28) }, null],
  ['未来泡泡', { id: 'm-future', title: '未来', level: 'sky', future: true, start: at(400), end: at(402), deadline: at(402) }, null],
  ['重复日程的某一次发生', { id: 'm-rep', title: '每周例会', level: 'emerald', recurrence: { freq: 'weekly', byDay: [1, 3, 5] } }, null],
  ['缺少 level', { id: 'm-nolevel', title: '缺 level', start: at(10), end: at(12), deadline: at(12) }, null],
  ['level 是空对象（没有 rank）', { id: 'm-emptyobj', title: '空 level 对象', level: {} }, (it) => {
    it.style = bubbleStyle(it, { now: NOW });
  }],
  ['style.level 是字符串（本次事故那条链）', { id: 'm-strlevel', title: '周五交材料', level: 'red' }, (it) => {
    it.style.level = 'red';
  }],
  ['style.level 是 null', { id: 'm-nulllvl', title: 'level 为 null', level: 'red' }, (it) => { it.style.level = null; }],
  ['style.level 缺 rank 但有 key', { id: 'm-norank', title: '缺 rank', level: 'red' }, (it) => {
    it.style.level = { key: 'red' };
  }],
  ['style.radiusRatio 是 NaN', { id: 'm-ratio', title: '坏 ratio', level: 'sky' }, (it) => {
    it.style.radiusRatio = Number.NaN;
  }],
  ['style.radius 被删掉（上一类事故）', { id: 'm-norad', title: '没有 radius', level: 'sky' }, (it) => {
    delete it.style.radius;
  }],
  ['style.tier 被删掉', { id: 'm-notier', title: '没有 tier', level: 'sky' }, (it) => { delete it.style.tier; }],
  ['deadline 是 Invalid Date', { id: 'm-baddl', title: '脏 deadline', level: 'sky' }, (it) => {
    it.deadline = new Date('不是日期');
  }],
  ['start/end 是脏值', { id: 'm-badstart', title: '脏 start/end', level: 'sky' }, (it) => {
    it.start = new Date('x'); it.end = new Date('x'); it.deadline = new Date('x');
  }],
  ['start/end 是空串', { id: 'm-empty', title: '空 start', level: 'sky' }, (it) => {
    it.event.start = ''; it.event.end = ''; it.start = new Date(''); it.end = new Date('');
  }],
  ['极大值（1e15 小时之后）', { id: 'm-huge', title: '极大', level: 'sky', start: at(1e15), end: at(1e15), deadline: at(1e15) }, (it) => {
    it.style = bubbleStyle(it, { now: NOW });
  }],
  ['极小值（1e15 小时之前）', { id: 'm-tiny', title: '极小', level: 'sky', start: at(-1e15), end: at(-1e15), deadline: at(-1e15) }, (it) => {
    it.style = bubbleStyle(it, { now: NOW });
  }],
  ['手工把 NaN 塞进 style 各字段', { id: 'm-allnan', title: '全是 NaN', level: 'red' }, (it) => {
    it.style.radius = Number.NaN;
    it.style.radiusRatio = Number.NaN;
    it.style.remaining = Number.NaN;
    it.style.intensity = Number.NaN;
    it.style.magnitude = Number.NaN;
    it.style.level = { key: 'red', rank: Number.NaN };
  }],
  ['手工把 Infinity 塞进 style', { id: 'm-inf', title: '无穷大', level: 'sky' }, (it) => {
    it.style.radius = Number.POSITIVE_INFINITY;
    it.style.radiusRatio = Number.POSITIVE_INFINITY;
    it.style.remaining = Number.NEGATIVE_INFINITY;
  }],
  ['几何模型全是 NaN（物理状态被污染）', { id: 'm-geomnan', title: '几何全坏', level: 'sky' }, (it) => {
    it.__geom = true;
  }],
  ['level.rank 是字符串 "3"', { id: 'm-rankstr', title: 'rank 字符串', level: 'red' }, (it) => {
    it.style.level = { key: 'red', rank: '3', label: '重大', color: '#ef4444' };
  }],
];

test(`覆盖矩阵：${MATRIX.length} 种输入下，所有绘制数字都必须是有限数`, () => {
  for (const [name, ev, dirty] of MATRIX) {
    const item = makeItem(ev);
    if (dirty) dirty(item);
    const geom = item.__geom
      ? { x: Number.NaN, y: Number.NaN, r: Number.NaN, theta: Number.NaN, squash: Number.NaN, hold: Number.NaN, shakeX: Number.NaN }
      : GEO;
    const calc = drawNumbersOf(item, geom, { measure: measureStub });
    assertAllFinite(calc.values, name, calc.problems);
    assert.ok(Number.isFinite(calc.r), `${name}: r 必须是有限数（实际 ${calc.r}）`);
    assert.ok(Number.isFinite(calc.alpha), `${name}: alpha 必须是有限数（实际 ${calc.alpha}）`);
    assert.ok(Array.isArray(calc.lines) && calc.lines.length, `${name}: 文字行不能为空`);
    assert.ok(Number.isFinite(Number(calc.levelRank)), `${name}: levelRank 必须是有限数`);
    assert.equal(typeof calc.level, 'object', `${name}: level 必须是对象（不是键字符串）`);
  }
});

test('覆盖矩阵：矩阵本身要够大（防止有人把用例删空让测试变绿）', () => {
  assert.ok(MATRIX.length >= 20, `矩阵只有 ${MATRIX.length} 条，太少了`);
});

// ===========================================================================
// ② 上一类事故那条链：radius 缺失 → mass NaN → 位置 NaN → canvas 抛非有限
// ===========================================================================

test('回归：style.radius 缺失/NaN/undefined 时，半径必须被兜成一个有限的正数', () => {
  const cases = [
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['0', 0],
    ['-5', -5],
    ['null', null],
    ['字符串 "72"', '72'],
  ];
  for (const [label, bad] of cases) {
    const item = makeItem({ id: 'r-' + label, title: '半径坏掉', level: 'sky' });
    item.style.radius = bad;
    const calc = drawNumbersOf(item, GEO, { measure: measureStub });
    assert.ok(Number.isFinite(calc.values.r) && calc.values.r > 0,
      `radius=${label} 时必须兜成有限正数（实际 ${calc.values.r}）`);
    // 上一类事故的算式：`mass = Math.max(1, (r*r)/900)` 里的 Math.max **不吞 NaN**
    const mass = Math.max(1, (calc.values.r * calc.values.r) / 900);
    assert.ok(Number.isFinite(mass), `radius=${label} → mass = ${mass}（历史上这里就是 NaN 的诞生地）`);
    // 位置也必须有限（NaN 半径会顺着物理积分把位置全染成 NaN）
    assert.ok(Number.isFinite(calc.values.x) && Number.isFinite(calc.values.y));
  }
});

test('回归：几何模型（x/y/r）是 NaN 时**必须**被兜住，并记进 problems', () => {
  const item = makeItem({ id: 'geom', title: '几何坏了', level: 'sky' });
  const calc = drawNumbersOf(item, {
    x: Number.NaN, y: Number.NaN, r: Number.NaN, theta: Number.NaN, squash: Number.NaN, hold: Number.NaN,
  }, { measure: measureStub });
  const fields = calc.problems.map((p) => p.field);
  for (const f of ['x', 'y', 'r', 'theta', 'squash', 'hold']) {
    assert.ok(fields.includes(f), `problems 里应该点名 ${f}（实际：${fields.join(',')}）`);
  }
  assert.equal(calc.values.r, SAFE_RADIUS, 'r 坏了就用 SAFE_RADIUS 兜');
  assertAllFinite(calc.values, '几何全 NaN', calc.problems);
});

test('回归：measure（wrapTextToFit）抛异常时，退化成兜底排版而不是把整帧带走', () => {
  const item = makeItem({ id: 'measure', title: '排版坏掉', level: 'sky' });
  const calc = drawNumbersOf(item, GEO, { measure: () => { throw new Error('measureText 挂了'); } });
  assertAllFinite(calc.values, 'measure 抛异常', calc.problems);
  assert.ok(calc.problems.some((p) => String(p.field).includes('measure')), '要把 measureText 失败记下来');
});

test('回归：measure 返回 NaN 字号时也要兜住', () => {
  const item = makeItem({ id: 'measure2', title: '字号 NaN', level: 'sky' });
  const calc = drawNumbersOf(item, GEO, { measure: () => ({ lines: ['标题'], fontSize: Number.NaN }) });
  assertAllFinite(calc.values, 'measure 返回 NaN 字号', calc.problems);
  assert.ok(calc.values.measuredFontSize > 0);
});

// ===========================================================================
// ③ 三个高危写法，逐个审
// ===========================================================================

test('高危1：`1.16 + (st.level ? st.level.rank : 0)/40` —— level 存在但没有 rank 时是 NaN', () => {
  // 先把这个写法**本身**钉住：它确实会变 NaN（这是本次事故最可疑的一处）
  const st = { level: { key: 'red' } };            // 也有可能是字符串 'red'、或者 {}
  const naive = 1.16 + (st.level ? st.level.rank : 0) / 40;
  assert.ok(Number.isNaN(naive), '朴素写法在"level 缺 rank"时必须得到 NaN（说明这条链是真的）');

  // 再证明"过了 drawNumbersOf 就一定不是 NaN"，且**坏字段被点名**
  //   兜底策略：损坏的 level **按它的 key 查回真档**（key 才是数据真源），
  //   所以 `{key:'red'}` 仍然是红档（rank=3 → 1.235），而不是一路降到 sky。
  //   要修的只是"rank 没算出来"，不是"把这颗泡泡改成别的档"。
  const expectByInput = [
    // ⚠️ 期望值写成 `1.16 + n / 40` 的**算式**，不写成 1.235：
    //    浮点下 `1.16 + 3/40 !== 1.235`（浮点误差），断言值必须和产出的算式同源。
    [{ key: 'red' }, 1.16 + 3 / 40],
    ['red', 1.16 + 3 / 40],
    [{}, 1.16],                       // 没有 key 可用 → 回到默认档（rank 0）
    [[], 1.16],
    [true, 1.16],
  ];
  for (const [badLevel, expectGlow] of expectByInput) {
    const item = makeItem({ id: 'hl1', title: '周五交材料', level: 'red' });
    item.style.level = badLevel;
    const calc = drawNumbersOf(item, GEO, { measure: measureStub });
    assert.ok(Number.isFinite(calc.values.glowScale),
      `level=${JSON.stringify(badLevel)} 时 glowScale 必须有限（实际 ${calc.values.glowScale}）`);
    assert.equal(calc.values.glowScale, expectGlow,
      `level=${JSON.stringify(badLevel)} 的兜底结果不对`);
    assert.ok(calc.problems.some((p) => String(p.field).startsWith('level')),
      `必须点名 level 这个坏字段（实际：${calc.problems.map((p) => p.field).join(',')}）`);
  }
});

test('高危1a：损坏的 level 要按 key 查回真档，而不是一路降到默认档（不然颜色会变）', () => {
  // `{ key:'emerald' }`（缺 rank）必须仍然是**翠绿**，不能变天蓝
  const item = makeItem({ id: 'hl1a', title: '缺 rank 的绿', level: 'emerald' });
  item.style.level = { key: 'emerald' };
  const calc = drawNumbersOf(item, GEO, { measure: measureStub });
  assert.equal(calc.levelKey, 'emerald', '按 key 查回真档');
  assert.equal(calc.levelRank, 1);
  assert.equal(calc.values.glowScale, 1.16 + 1 / 40);
});

test('高危1b：正常数据的 glowScale 必须和原式逐位相同（不许改变观感）', () => {
  for (const lv of LEVELS) {
    const item = makeItem({ id: 'hl1b', title: '正常', level: lv.key });
    const calc = drawNumbersOf(item, GEO, { measure: measureStub });
    const old = 1.16 + lv.rank / 40;                 // 重构前那一行的原式
    assert.equal(calc.values.glowScale, old, `${lv.key}: glowScale 变了（观感会变）`);
  }
});

test('高危2：`??` 挡不住 NaN —— 所以源头必须用 Number.isFinite 判断', () => {
  // 这两条断言把这个坑写在测试里，防止有人"顺手改成 ?? 更简洁"
  assert.ok(Number.isNaN(Number.NaN ?? 26), '`NaN ?? 26` 还是 NaN（?? 只在 null/undefined 时替换）');
  assert.equal(Number.NaN || 26, 26, '`||` 才会替换掉 NaN');

  // 我们的 finiteOr / sanitizeDrawNumber 用的是 isFinite，两种非法值都换掉
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, 'x']) {
    assert.equal(finiteOr(bad, 26, 'f').value, 26, `${String(bad)} 应该被换成 26`);
    assert.equal(finiteOr(bad, 26, 'f').bad, true, `${String(bad)} 应该被标记成"坏"`);
  }
  const problems = [];
  assert.equal(sanitizeDrawNumber(Number.NaN, 13, 'r', problems), 13);
  assert.deepEqual(problems.map((p) => p.field), ['r'], '坏字段要被记下来（现场诊断靠它）');
});

test('高危2b：bubbleStyle 里不许有"NaN 从 ?? 漏过去"的字段', () => {
  // 把"能喂进算式的数值字段"逐个用脏数据过的思路：
  // 只要 bubbleStyle 输出的数值字段全是有限数（remaining 除外，null 是合法语义），
  // 就不可能从 core 这一侧漏 NaN 进 canvas。
  const dirtyEvents = [
    { id: 'd1', title: 'mag NaN', magnitude: Number.NaN, start: at(1) },
    { id: 'd2', title: 'mag 字符串', magnitude: 'x', start: at(1) },
    { id: 'd3', title: 'imp NaN', importance: Number.NaN, start: at(1) },
    { id: 'd4', title: 'level 对象', level: {}, start: at(1) },
    { id: 'd5', title: 'tier 对象', tier: {}, start: at(1) },
    { id: 'd6', title: '脏 start', start: 'x', end: 'x' },
    { id: 'd7', title: '空 start', start: '', end: '' },
  ];
  for (const ev of dirtyEvents) {
    const item = { event: ev, start: at(1), end: at(2), deadline: at(2) };
    const st = bubbleStyle(item, { now: NOW });
    for (const [k, v] of Object.entries(st)) {
      // ⚠️ `urgency` 是个**例外，而且是有意的**：它的 `score/hours` 在"没有期限/脏时间"
      //    时就是 NaN（`urgencyOf(脏 start)` 的自然结果）.它只用来**排序**，
      //    不参与任何绘制算式（渲染器读的是 radiusRatio / remaining）。
      //    把它也要求成有限数，等于逼着 core 去伪造一个假的紧迫度 —— 那才是真的会改观感。
      //    这里只钉住"它**不会**流进绘制"（下面的 drawNumbersOf 那几条断言就是这条）。
      if (k === 'urgency') continue;
      if (typeof v === 'number') {
        assert.ok(Number.isFinite(v), `bubbleStyle(${ev.title}).${k} = ${v} 不是有限数`);
      }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) {
          if (typeof v2 === 'number') {
            assert.ok(Number.isFinite(v2), `bubbleStyle(${ev.title}).${k}.${k2} = ${v2} 不是有限数`);
          }
        }
      }
    }
    // 唯一的例外是 remaining：**null 是合法语义**（未设期限），NaN 不行
    assert.ok(st.remaining === null || Number.isFinite(st.remaining), `${ev.title}: remaining 只能是 null 或有限数`);
    // 而"排序用的 urgency"即使算出 NaN，也不许把它带进这颗泡泡的绘制数字
    const calc = drawNumbersOf({ ...item, style: st }, GEO, { measure: measureStub });
    assertAllFinite(calc.values, `${ev.title} → 绘制`, calc.problems);
  }
});

test('高危3a：`Math.max(1, (r*r)/900)` 不吞 NaN（上一类事故的算式本体）', () => {
  assert.ok(Number.isNaN(Math.max(1, (Number.NaN * Number.NaN) / 900)),
    'Math.max 不会救 NaN —— 所以"r 先兜底"是唯一正确的顺序');
  // 我们的顺序：先兜 r，再算 mass
  const item = makeItem({ id: 'hl3', title: '半径 NaN', level: 'sky' });
  item.style.radius = Number.NaN;
  const calc = drawNumbersOf(item, { ...GEO, r: Number.NaN }, { measure: measureStub });
  const mass = Math.max(1, (calc.values.r * calc.values.r) / 900);
  assert.ok(Number.isFinite(mass) && mass >= 1);
});

test('高危3b：sizeRatioForRemaining(null) / bandForRemaining(null) 必须给明确兜底值', () => {
  // 真·没有期限：deadline / end / start 三样都没有（期限优先级是 deadline > end > start，
  // 只删 deadline 是不够的 —— 那样 item.end 还在，照样算得出剩余时间）
  const item = makeNoDeadlineItem();
  const st = bubbleStyle(item, { now: NOW });
  assert.equal(st.remaining, null, '未设期限 → remaining 是 null（不是 NaN、不是 0）');
  assert.equal(st.radiusRatio, 0.30, '未设期限 → 用 NEUTRAL_SIZE(0.30)');
  /**
   * ⚠️ 档位这条断言**改过**，改的是"错的期望值"，不是松绑：
   *
   *   上一版写的是 `assert.equal(st.band, bandForRemaining(Infinity).key)` ——
   *   它把 bubbleStyle 里"`remaining == null` 就喂 `Infinity`"当成真值钉住了。
   *   而 `bandForRemaining()` 对**非有限数**恰恰是兜底到**最紧迫的秒档**，
   *   所以旧期望是 `'second'`（= "秒"，最紧急）—— 意思是"没设期限"被标成"马上到期"。
   *   那正是要修的口径矛盾：同一颗泡泡上 radiusRatio 是中性 0.30、intensity 是 1(不催)、
   *   timeText 是"未设期限"，只有档位在喊最紧急。
   *   所以现在按**正确的**期望断言：`'unset'` / "未设期限"，和另外三支一致。
   *   有期限那七档的断言在 tools/bubble-band-unset.test.mjs 里逐档钉着，一个都没放松。
   */
  assert.equal(st.band, 'unset', '未设期限 → 中性档 unset，不是最紧迫的秒档');
  assert.equal(st.bandLabel, '未设期限');
  assert.equal(st.intensity, 1, '未设期限 → 不催（和 bandLabel/尺寸 同一口径）');
  assert.ok(Number.isFinite(st.radius) && st.radius > 0);
  const calc = drawNumbersOf(item, GEO, { measure: measureStub });
  assertAllFinite(calc.values, '未设期限', calc.problems);
});

test('高危3c：asDate(脏值) → Invalid Date —— 不许把 NaN 带进绘制', () => {
  for (const bad of ['x', '', null, undefined, {}, Number.NaN, '2026-13-45T99:99']) {
    const item = { event: { id: 'as', title: '脏时间', level: 'sky', start: bad }, start: new Date(bad), end: new Date(bad), deadline: new Date(bad) };
    const st = bubbleStyle(item, { now: NOW });
    assertAllFinite(st, `asDate(${JSON.stringify(bad)})`, []);
    const calc = drawNumbersOf({ ...item, style: st }, GEO, { measure: measureStub });
    assertAllFinite(calc.values, `asDate(${JSON.stringify(bad)}) → 绘制`, calc.problems);
  }
});

// ===========================================================================
// ④ 真画一遍：拿到非有限数就抛（模拟 WebKit）
// ===========================================================================

/** 假 canvas：**任何**非有限数参数都当场抛，和 WebKit 的行为一致 */
function makeStrictCtx(calls) {
  const guard = (name, args) => {
    for (let i = 0; i < args.length; i += 1) {
      const v = args[i];
      if (typeof v === 'number' && !Number.isFinite(v)) {
        throw new Error(`Failed to execute '${name}': The provided double value is non-finite（第 ${i} 个参数 = ${v}）`);
      }
    }
  };
  const rec = (name) => (...args) => { calls.push(name); guard(name, args); };
  const gradient = (name) => (...args) => {
    guard(name, args);
    return { addColorStop: (offset, color) => {
      if (!Number.isFinite(offset)) throw new Error(`${name}: 色标 offset 非有限`);
      if (!safeRgba(color)) throw new Error(`${name}: 色标不是合法颜色：${color}`);
    } };
  };
  return {
    calls,
    save: rec('save'), restore: rec('restore'), beginPath: rec('beginPath'), closePath: rec('closePath'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), arc: rec('arc'), ellipse: rec('ellipse'),
    rect: rec('rect'), roundRect: rec('roundRect'),
    fill: rec('fill'), stroke: rec('stroke'), clip: rec('clip'),
    fillRect: rec('fillRect'), clearRect: rec('clearRect'), setLineDash: rec('setLineDash'),
    fillText: rec('fillText'), strokeText: rec('strokeText'), drawImage: rec('drawImage'),
    createRadialGradient: gradient('createRadialGradient'),
    createLinearGradient: gradient('createLinearGradient'),
    setLineDashValue: rec('setLineDash'),
  };
}

/**
 * 复刻绘制代码里"把数字交给 canvas"的那一组调用（形状与 web/ui/views/bubble.js 一致）。
 * ⚠️ 它测的是"**我们产出的数字**在真绘制形状下不会抛"；
 *    真绘制代码本身的止血（try/catch + 补一颗圆）由工位在浏览器里另行验收。
 */
function paintShape(ctx, v, lines) {
  ctx.createRadialGradient(v.x, v.y, v.r * 0.7, v.x, v.y, v.r * v.glowScale).addColorStop(0, 'rgba(1,2,3,0.5)');
  ctx.beginPath(); ctx.arc(v.x, v.y, v.r * v.glowScale, 0, Math.PI * 2); ctx.fill();
  ctx.createRadialGradient(v.lx, v.ly, v.bodyInnerR, v.x, v.y, v.bodyOuterR).addColorStop(0, '#ffffff');
  ctx.beginPath(); ctx.ellipse(v.drawX, v.y, v.r * v.scalePerp, v.r * v.scaleAlong, v.theta, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(v.x, v.y, v.outlineR * v.scalePerp, v.outlineR * v.scaleAlong, v.theta, 0, Math.PI * 2);
  ctx.lineWidth = v.outlineWidth; ctx.stroke();
  ctx.createLinearGradient(v.x + v.r, v.y, v.x - v.r, v.y).addColorStop(0, 'rgba(255,255,255,0.5)');
  ctx.createRadialGradient(v.glintX, v.glintY, 0, v.glintX, v.glintY, v.glintR).addColorStop(0, 'rgba(255,255,255,0.2)');
  ctx.beginPath(); ctx.arc(v.glintX, v.glintY, v.sparkR, 0, Math.PI * 2); ctx.fill();
  ctx.createRadialGradient(v.centerGlowX, v.centerGlowY, 0, v.centerGlowX, v.centerGlowY, v.centerGlowR).addColorStop(0, 'rgba(0,0,0,0)');
  ctx.createRadialGradient(v.innerX, v.innerY, v.innerInnerR, v.x, v.y, v.innerOuterR).addColorStop(1, 'rgba(0,0,0,0.1)');
  ctx.beginPath(); ctx.rect(v.innerRectX, v.innerRectY, v.innerRectW, v.innerRectH); ctx.fill();
  ctx.setLineDash([v.inheritedDashA, v.inheritedDashB]);
  ctx.beginPath(); ctx.arc(v.x, v.y, v.inheritedRingR, 0, Math.PI * 2); ctx.lineWidth = v.inheritedRingWidth; ctx.stroke();
  ctx.beginPath(); ctx.arc(v.x, v.y, v.holdRingR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * v.holdProgress);
  ctx.lineWidth = v.holdWidth; ctx.stroke();
  ctx.createRadialGradient(v.x, v.y, v.spikeInnerR, v.x, v.y, v.spikeOuterR).addColorStop(0.55, 'rgba(1,2,3,0.5)');
  for (const line of lines) { ctx.strokeText(line, v.x, v.textTop + v.titleSize / 2); ctx.fillText(line, v.x, v.textTop); }
  ctx.createRadialGradient(v.x, v.plateCY, 0, v.x, v.plateCY, v.plateR).addColorStop(0, 'rgba(1,2,3,0.3)');
  ctx.beginPath(); ctx.arc(v.x, v.plateCY, v.plateR, 0, Math.PI * 2); ctx.fill();
  ctx.fillText('● 重大', v.x, v.tagY);
}

test('真画一遍：覆盖矩阵里每一颗都不会让 canvas 抛"非有限"', () => {
  for (const [name, ev, dirty] of MATRIX) {
    const item = makeItem(ev);
    if (dirty) dirty(item);
    const geom = item.__geom
      ? { x: Number.NaN, y: Number.NaN, r: Number.NaN, theta: Number.NaN, squash: Number.NaN, hold: Number.NaN, shakeX: Number.NaN }
      : GEO;
    const calc = drawNumbersOf(item, geom, { measure: measureStub });
    const calls = [];
    const ctx = makeStrictCtx(calls);
    assert.doesNotThrow(() => paintShape(ctx, calc.values, calc.lines), `${name}: 绘制抛异常了`);
    assert.ok(calls.length > 20, `${name}: 只调用了 ${calls.length} 次 canvas（看起来没真画）`);
  }
});

test('真画一遍：把 values 里任意一个数值字段换成 NaN，sanitize 之后仍然画得出来', () => {
  const item = makeItem({ id: 'poison', title: '逐个毒化', level: 'red' });
  const base = drawNumbersOf(item, GEO, { measure: measureStub });
  const numericKeys = Object.keys(base.values).filter((k) => typeof base.values[k] === 'number');
  assert.ok(numericKeys.length >= 45, `数值字段只有 ${numericKeys.length} 个，矩阵太薄`);
  for (const k of numericKeys) {
    const values = { ...base.values, [k]: Number.NaN };
    const problems = [];
    for (const key of Object.keys(values)) {
      if (typeof values[key] === 'number' && !Number.isFinite(values[key])) {
        // 这就是绘制前那道闸（web 层同一个函数）
        values[key] = sanitizeDrawNumber(values[key], key === 'r' ? SAFE_RADIUS : 1, key, problems);
      }
    }
    assert.ok(problems.some((p) => p.field === k), `${k} 坏了却没被记进 problems`);
    const ctx = makeStrictCtx([]);
    assert.doesNotThrow(() => paintShape(ctx, values, base.lines), `${k} = NaN 时绘制抛了`);
  }
});

// ===========================================================================
// ⑤ 诊断文案：平板上没有控制台，界面必须自己说是哪个字段坏了
// ===========================================================================

test('诊断文案必须含：泡泡标题、坏掉的量、以及 style 里相关字段的值', () => {
  const item = makeItem({ id: 'diag', title: '周五交材料', level: 'red' });
  item.style.level = 'red';
  const calc = drawNumbersOf(item, GEO, { measure: measureStub });
  const msg = bubbleDrawDiagnostic(item, calc.problems);

  assert.ok(msg.includes('周五交材料'), `文案里必须有标题：${msg}`);
  assert.ok(msg.includes('level'), `文案里必须点名坏掉的字段 level：${msg}`);
  assert.ok(msg.includes('兜底值') || msg.includes('继续画'), `要说清"已经补救了"：${msg}`);
  for (const field of ['radius', 'radiusRatio', 'remaining', 'levelKey', 'tierKey', 'festival', 'deadline']) {
    assert.ok(msg.includes(field), `现场证据缺了 ${field}：${msg}`);
  }
  // 整颗画挂那种（没有具体字段）也要说清"已补画一颗圆"
  const safeMsg = bubbleDrawDiagnostic(item, [], 'safe');
  assert.ok(safeMsg.includes('安全的圆'), `整颗画挂时要说明补画了什么：${safeMsg}`);
  assert.ok(safeMsg.includes('没有记录到具体字段'), safeMsg);
  assert.ok(safeMsg.includes('周五交材料') && safeMsg.includes('radiusRatio'), safeMsg);
});

test('诊断文案：没有标题时退化成 id/key，也绝不能是空串', () => {
  const item = makeItem({ id: 'no-title', title: '', level: 'sky' });
  const msg = bubbleDrawDiagnostic(item, [{ field: 'r', value: Number.NaN }]);
  assert.ok(msg.length > 20, `文案太短：${msg}`);
  assert.ok(msg.includes('no-title') || msg.includes('@'), `没有标题时要给出 id/key：${msg}`);
  assert.ok(msg.includes('NaN'), `要写明坏值是什么：${msg}`);

  // 完全空的 item 也不能抛
  assert.doesNotThrow(() => bubbleDrawDiagnostic(null, []));
  assert.doesNotThrow(() => bubbleDrawDiagnostic({}, []));
  assert.ok(bubbleDrawDiagnostic({}, []).length > 10);
});

test('诊断文案：各个相关字段的取值形态都要能读出来（Date / 对象 / 超长字符串）', () => {
  const msg = bubbleDrawDiagnostic({
    event: { id: 'x', title: '形状测试' },
    deadline: new Date('2026-09-28T00:00:00'),
    style: { radius: Number.NaN, radiusRatio: 0.72, remaining: null, levelKey: 'red', tierKey: 'red', festival: true, done: false, level: { key: 'red', rank: 3, label: '重大', color: '#ef4444' } },
  }, [{ field: 'r', value: Number.NaN }]);
  // ⚠️ 断言要按**本地时刻**比，不能用 toISOString()：
  //    `2026-09-28T00:00:00` 是本地时间，转成 UTC 会变成前一天 16:00（东八区），
  //    拿 UTC 字符串去断言就是一条"过了零点就红"的糙测试（这个项目踩过这种坑）。
  assert.ok(msg.includes('2026-09-28'), `Date 要能按本地时刻读出来：${msg}`);
  assert.ok(msg.includes('null'), `null 要能读：${msg}`);
  assert.doesNotThrow(() => bubbleDrawDiagnostic({ event: { title: 'x' }, style: { level: { toString() { throw new Error('boom'); } } } }, []));
});

// ===========================================================================
// ⑥ 等级对象的类型契约（"键字符串当对象用"那个雷）
// ===========================================================================

test('safeLevelOf：字符串/空对象/什么都没有，都必须变成**有数字 rank 的对象**', () => {
  for (const input of ['red', 'sky', '', null, undefined, {}, [], 3, { key: 'red' }, { rank: 'x' }]) {
    const lv = safeLevelOf(input);
    assert.equal(typeof lv, 'object', `safeLevelOf(${JSON.stringify(input)}) 必须给对象`);
    assert.ok(Number.isFinite(lv.rank), `safeLevelOf(${JSON.stringify(input)}).rank 必须是有限数`);
    assert.equal(typeof lv.key, 'string');
  }
  // 合法的等级对象原样返回（不许悄悄换成别的档）
  const red = levelByKey('red');
  assert.equal(safeLevelOf(red), red, '合法对象要原样返回（不然颜色会变）');
});

test('bubbleStyle 的输出：level 必须是对象且 rank 是有限数（本次事故的直接防线）', () => {
  const cases = [
    { id: 'a', title: '普通', level: 'red' },
    { id: 'b', title: '缺 level' },
    { id: 'c', title: 'level 空对象', level: {} },
    { id: 'd', title: 'level 字符串键', level: 'emerald' },
  ];
  for (const ev of cases) {
    const item = { event: ev, start: at(1), end: at(2), deadline: at(2) };
    const st = bubbleStyle(item, { now: NOW });
    assert.equal(typeof st.level, 'object', `${ev.title}: style.level 必须是对象`);
    assert.ok(Number.isFinite(st.level.rank), `${ev.title}: style.level.rank 必须是有限数`);
    assert.ok(Number.isFinite(st.magnitude), `${ev.title}: style.magnitude 必须是有限数（旧字段也别留 NaN）`);
    assert.equal(st.levelKey, st.level.key, `${ev.title}: levelKey 和 level.key 必须是同一个档`);
  }
});

test('DEFAULT_LEVEL 是**字符串**，levelByKey() 才返回对象 —— 这个区别要一直显式存在', () => {
  assert.equal(typeof DEFAULT_LEVEL, 'string', 'DEFAULT_LEVEL 是键字符串（文档与测试都要靠它提醒）');
  assert.equal(typeof levelByKey(DEFAULT_LEVEL), 'object');
  assert.equal(typeof levelByKey('不存在的档'), 'object', '未知 key 也要回落到对象');
});

test('defaultLevelForType 给的是**键字符串**（不是等级对象）—— 用它必须再过 levelByKey', () => {
  // 这是同一个雷的另一半：`core/urgency.js` 里 `levelOf()` 返回键、`levelByKey()` 返回对象。
  // 谁把前者当后者用（`.rank`）就会得到 undefined → NaN → 整帧抛非有限。
  for (const [type, key] of Object.entries(TYPE_DEFAULT_LEVEL)) {
    assert.equal(typeof defaultLevelForType(type), 'string', `${type} 应当给键字符串`);
    assert.equal(defaultLevelForType(type), key);
    assert.equal(levelByKey(defaultLevelForType(type)).key, key, '过了 levelByKey 才是对象');
    assert.ok(Number.isFinite(rankOf(defaultLevelForType(type))));
  }
  assert.equal(defaultLevelForType('festival'), DEFAULT_LEVEL, '没有 festival 这个类型 → 回落默认档（字符串）');
  assert.equal(typeof defaultLevelForType('不存在'), 'string');
  // 而且这个字符串喂给 safeLevelOf 之后必须是**对象 + 数字 rank**
  const lv = safeLevelOf(defaultLevelForType('exam'));
  assert.equal(lv.key, 'red');
  assert.ok(Number.isFinite(lv.rank));
  // 需要对象的地方用 defaultLevelObjectForType（它的存在就是为了别再"记得再过一道"）
  const obj = defaultLevelObjectForType('exam');
  assert.equal(typeof obj, 'object');
  assert.equal(obj.key, 'red');
  assert.ok(Number.isFinite(obj.rank));
  assert.equal(typeof defaultLevelObjectForType('festival'), 'object', '没有 festival 这个类型也要给对象');
});

test('clampIntensity / notifyStyleForIntensity 这类"强度"函数也不许吐 NaN', () => {
  // 同一类风险面：只要是"进算式的数"，脏输入就必须有兜底
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'x', null, undefined, -5, 99]) {
    const s = notifyStyleForIntensity(bad);
    assert.ok(Number.isFinite(s.intensity) && s.intensity >= 1 && s.intensity <= 4,
      `notifyStyleForIntensity(${String(bad)}) → ${s.intensity}`);
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} = ${v}`);
    }
    assert.ok(Number.isFinite(clampIntensity(bad)));
  }
});

// ===========================================================================
// ⑦ 节日泡泡（上一类事故的主场）
// ===========================================================================

test('节日泡泡：style 字段齐全、数值全是有限数、且和其它泡泡一样能算出绘制数字', () => {
  const fest = selectBubbleItems([], { now: NOW, horizonDays: 40, festivalDays: 40 });
  assert.ok(fest.length >= 1, `这 40 天里应该有节日（当前 ${NOW.toISOString()}）`);
  for (const it of fest) {
    assert.equal(it.festival, true);
    assert.equal(typeof it.style.level, 'object', `节日泡泡「${it.event.title}」的 level 必须是对象`);
    assert.ok(Number.isFinite(it.style.level.rank), `节日泡泡「${it.event.title}」的 level.rank 必须是有限数`);
    assert.equal(it.style.levelKey, it.style.level.key, 'levelKey 与 level.key 必须一致（两个字段是一对）');
    assert.ok(Number.isFinite(it.style.radius) && it.style.radius > 0, '节日泡泡必须有 radius');
    const calc = drawNumbersOf(it, GEO, { measure: measureStub });
    assertAllFinite(calc.values, `节日「${it.event.title}」`, calc.problems);
    assert.equal(calc.problems.length, 0, `节日泡泡不该触发任何兜底：${JSON.stringify(calc.problems)}`);
    const ctx = makeStrictCtx([]);
    assert.doesNotThrow(() => paintShape(ctx, calc.values, calc.lines), `节日「${it.event.title}」绘制抛了`);
  }
});

test('节日泡泡：glowScale 和普通红泡泡一致（专用颜色不许顺带改了发光半径）', () => {
  const fest = selectBubbleItems([], { now: NOW, horizonDays: 40, festivalDays: 40 })[0];
  const normal = makeItem({ id: 'n', title: '普通红', level: 'red' });
  const a = drawNumbersOf(fest, GEO, { measure: measureStub });
  const b = drawNumbersOf(normal, GEO, { measure: measureStub });
  assert.equal(a.values.glowScale, b.values.glowScale, '节日和"重大"档的发光半径必须一样');
});

// ===========================================================================
// ⑧ 正常数据：观感不许变（逐字段与原式对齐）
// ===========================================================================

test('不许改变观感：正常数据下每个字段都等于重构前的原式', () => {
  const item = makeItem({ id: 'look', title: '观感对齐', level: 'amber' });
  const r = GEO.r;
  const v = drawNumbersOf(item, GEO, { measure: measureStub }).values;
  const s = Math.min(0.2, Math.max(-0.2, GEO.squash));
  assert.equal(v.alpha, 0.88);
  assert.equal(v.r, r);
  assert.equal(v.lx, GEO.x - r * 0.32);
  assert.equal(v.ly, GEO.y - r * 0.38);
  assert.equal(v.bodyInnerR, r * 0.04);
  assert.equal(v.bodyOuterR, r * 1.03);
  assert.equal(v.rimInnerR, r * 0.74);
  assert.equal(v.rimOuterR, r * 1.0);
  assert.equal(v.outlineR, r * 0.955);
  assert.equal(v.outlineWidth, Math.max(1.1, r * 0.030));
  assert.equal(v.shadowArcR, r * 0.90);
  assert.equal(v.glintX, GEO.x - r * 0.523);
  assert.equal(v.glintY, GEO.y - r * 0.523);
  assert.equal(v.glintR, r * 0.34);
  assert.equal(v.sparkR, r * 0.07);
  assert.equal(v.centerGlowX, GEO.x - r * 0.10);
  assert.equal(v.centerGlowY, GEO.y - r * 0.12);
  assert.equal(v.centerGlowR, r * 0.9);
  assert.equal(v.innerX, GEO.x + r * 0.18);
  assert.equal(v.innerY, GEO.y + r * 0.30);
  assert.equal(v.innerInnerR, r * 0.30);
  assert.equal(v.innerOuterR, r * 1.08);
  assert.equal(v.innerRectX, GEO.x - r * 1.2);
  assert.equal(v.innerRectW, r * 2.4);
  assert.equal(v.strokeWidth, Math.max(0.8, r * 0.018));
  assert.equal(v.selectStrokeWidth, 2.5 + Math.abs(s) * 8);
  assert.equal(v.scaleAlong, Math.min(1.22, Math.max(0.78, 1 - s)));
  assert.equal(v.scalePerp, Math.min(1.2, Math.max(0.8, 1 + s * 0.8)));
  assert.equal(v.holdRingR, r * 1.22);
  assert.equal(v.holdWidth, Math.max(2.5, r * 0.09));
  assert.equal(v.inheritedRingR, r * 1.03);
  assert.equal(v.inheritedDashA, Math.max(3, r * 0.16));
  assert.equal(v.inheritedDashB, Math.max(3, r * 0.13));
  assert.equal(v.inheritedRingWidth, Math.max(2, r * 0.055));
  assert.equal(v.spikeInnerR, r * (1 - 0.16));
  assert.equal(v.spikeHalfW, Math.max(1.2, r * 0.055));
  assert.equal(v.titleSize, Math.max(10, Math.min(19, r * 0.30)));
  assert.equal(v.lineH, v.measuredFontSize + 3);
  assert.equal(v.showSub, r >= 34);
  assert.equal(v.showLevel, r >= 56);
  assert.equal(v.subSize, Math.max(10, Math.min(13, v.titleSize * 0.74)));
  assert.equal(v.gap, 3);
  assert.equal(v.plateCY, (v.textTop + v.textBottom) / 2);
  assert.equal(v.subY, v.textTop + v.blockH + 3 + v.subSize / 2);
  assert.equal(v.tagPostSize, Math.max(9, v.titleSize * 0.62));
  assert.equal(v.tagY, GEO.y - r * 0.62);
  assert.equal(v.drawX, GEO.x + GEO.shakeX);
  assert.equal(v.titleStrokeWidth, Math.max(2, v.titleSize * 0.24));
  assert.equal(v.tagStrokeWidth, Math.max(2, v.titleSize * 0.2));
  // 兜底一律**不生效**
  assert.equal(drawNumbersOf(item, GEO, { measure: measureStub }).problems.length, 0);
});

test('不许改变观感：三种透明度（已完成 / 超出预览范围 / 正常）与原来一致', () => {
  assert.equal(alphaOfStyle({ done: true }), 0.34);
  assert.equal(alphaOfStyle({ dimmed: true }), 0.42);
  assert.equal(alphaOfStyle({}), 0.88);
  assert.equal(alphaOfStyle({ done: true, dimmed: true }), 0.34, 'done 优先（和原式一致）');
  // 没传 alpha 时按风格算；传了就用传的（未来要淡出动画也不用改 core）
  const item = makeItem({ id: 'alpha', title: '透明度', level: 'sky' });
  assert.equal(drawNumbersOf(item, GEO, { measure: measureStub }).values.alpha, 0.88);
  item.style.alpha = 0.2;
  assert.equal(drawNumbersOf(item, GEO, { measure: measureStub }).values.alpha, 0.2);
  item.style.alpha = Number.NaN;
  const calc = drawNumbersOf(item, GEO, { measure: measureStub });
  assert.equal(calc.values.alpha, 0.88, 'alpha 坏了要退回风格默认值');
  assert.ok(calc.problems.some((p) => p.field === 'alpha'));
});

test('封面数：SAFE_* 这几个兜底常量本身必须是有限数（它们会直接进 canvas）', () => {
  for (const [name, v] of [['SAFE_RADIUS', SAFE_RADIUS], ['SAFE_FALLBACK_ALPHA', SAFE_FALLBACK_ALPHA]]) {
    assert.ok(Number.isFinite(v), `${name} = ${v} 必须有限`);
  }
  assert.ok(SAFE_RADIUS > 0);
  assert.ok(SAFE_FALLBACK_ALPHA > 0 && SAFE_FALLBACK_ALPHA < 1);
});
