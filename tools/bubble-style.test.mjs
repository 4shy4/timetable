// 气泡样式与"双击能否进入"的契约测试。
//
// 这个文件是为了锁住两个**真机上被用户发现的 bug**：
//
//   ① 红色/紫色的旧气泡双击却提示"蓝色气泡进不去"。
//      原因：渲染走 `levelOf(event)`（会把旧的 magnitude 换成四档颜色），
//      而双击判断读的是原始的 `event.level`，旧数据没有这个字段 → undefined
//      → `|| 'sky'` 兜底成蓝色 → 判定成"叶子档，进不去"。
//      **两个地方必须用同一个解析函数**，这里把这条契约钉住。
//
//   ② 母气泡过期变紫时，子气泡没跟着变紫。
//      用户要求：母泡泡变紫，里面的子泡泡也一起变紫，即使子泡泡的 deadline 更晚。
import test from 'node:test';
import assert from 'node:assert/strict';
import { bubbleStyle, levelOf } from '../core/urgency.js';
import { isLeafLevel, rankOf, LEVELS } from '../core/level.js';

const NOW = new Date('2026-03-02T12:00:00');
const at = (h) => new Date(NOW.getTime() + h * 3_600_000);
const item = (ev) => ({ event: ev, start: at(1), end: at(2) });
const style = (ev, opts) => bubbleStyle(item(ev), { now: NOW, ...opts });

// ---------------------------------------------------------------------------
// bug ①：等级解析只能有一条路径
// ---------------------------------------------------------------------------

test('回归①：只有 magnitude 的旧事件，levelOf 必须换算成对应颜色（不能是 sky）', () => {
  // 真机上的那几条旧数据：交实验报告=100（红）、小组会议=70（黄）、英语角=40（绿）
  const cases = [
    [100, 'red'],
    [90, 'red'],
    [70, 'amber'],
    [40, 'emerald'],
    [25, 'sky'],
    [1, 'sky'],
  ];
  for (const [mag, want] of cases) {
    const ev = { title: 'legacy', magnitude: mag, start: at(1) };
    assert.equal(levelOf(ev), want, `magnitude=${mag} 应当解析成 ${want}`);
    // 关键：渲染出来的颜色档位也必须一致
    assert.equal(style(ev).levelKey, want);
  }
});

test('回归①：旧事件即使没有 level 字段，也不该被判成"进不去"（红/黄/绿都能进）', () => {
  // 双击能否进入的判据是 isLeafLevel(levelOf(event))，所以这里等价地测它
  for (const [mag, canEnter] of [[100, true], [90, true], [70, true], [40, true], [25, false]]) {
    const ev = { title: 'legacy', magnitude: mag, start: at(1) };
    const leaf = isLeafLevel(levelOf(ev));
    assert.equal(!leaf, canEnter, `magnitude=${mag} 的 be able to enter 应当是 ${canEnter}`);
  }
});

test('回归①：显式 level 优先于 magnitude，两者都在时以 level 为准', () => {
  const ev = { title: 'x', level: 'sky', magnitude: 100, start: at(1) };
  assert.equal(levelOf(ev), 'sky', '显式 level 应当盖过 magnitude');
  assert.equal(isLeafLevel(levelOf(ev)), true);
});

test('回归①：显式 level 也支持旧 tier 字段，以及旧 importance 字段', () => {
  assert.equal(levelOf({ tier: 'amber', start: at(1) }), 'amber');
  assert.equal(levelOf({ importance: 5, start: at(1) }), 'red');
  assert.equal(levelOf({ importance: 1, start: at(1) }), 'sky');
  // ⚠️ tierKey 是 bubbleStyle 的**输出**字段，不会存在于存储的事件上，
  //    所以 levelOf 故意不读它 —— 这条断言是防止有人误以为要加进去。
  assert.equal(levelOf({ tierKey: 'red', start: at(1) }), 'sky');
});

test('回归①：完全没信息的旧事件兜底成 sky，而不是崩', () => {
  assert.equal(levelOf({ title: 'nothing', start: at(1) }), 'sky');
  assert.equal(levelOf({}), 'sky');
});

// ---------------------------------------------------------------------------
// bug ②：过期的紫色要"遗传"给子气泡
// ---------------------------------------------------------------------------

test('回归②：母气泡过期时，子气泡也跟着标成过期（即使自己还没到期）', () => {
  const child = { title: '子', level: 'emerald', start: at(1), deadline: at(24 * 5).toISOString() };
  const own = style(child);
  assert.equal(own.overdue, false, '子气泡自己没过期');
  assert.ok(own.radiusRatio < 0.5, `自己没过期时不该占满（实际 ${own.radiusRatio}）`);

  const inherited = style(child, { forceOverdue: true });
  assert.equal(inherited.overdue, true, '传了 forceOverdue 就该算过期');
  assert.equal(inherited.ownOverdue, false, '要能区分"自己过期"和"跟着母气泡过期"');
  assert.equal(inherited.overdueInherited, true);
  assert.equal(inherited.radiusRatio, own.radiusRatio, '继承过期只改颜色，不改尺寸');
});

test('回归②：跟着母气泡过期时，**尺寸保持自己的**（只变紫，不跟着变大）', () => {
  // 这一条是被真机截图逼出来的：一开始让继承的也拉满，结果一个容器里
  // 几个子气泡全变成最大，在那个空间里根本挤不开，文字叠在一起看不清。
  const child = { title: '子', level: 'sky', start: at(1), deadline: at(24 * 5).toISOString() };
  const inherited = style(child, { forceOverdue: true });
  assert.equal(inherited.radiusRatio, style(child).radiusRatio, '继承过期不该改变尺寸');
  assert.ok(inherited.radiusRatio < 1, '不该是最大档');

  // 而"自己过期"的仍然拉满
  assert.equal(style({ title: '母', level: 'red', start: at(-3) }).radiusRatio, 1.45);
});

test('回归②：未设期限的事件不算过期，但母气泡过期时它也跟着变紫', () => {
  const noDeadline = { title: '没期限', level: 'sky' };
  const s = style(noDeadline);
  assert.equal(s.remaining, null);
  assert.equal(s.overdue, false, '未设期限**不能**当成过期（否则没填期限的全变紫）');
  assert.equal(s.radiusRatio, 0.30, '未设期限用 NEUTRAL_SIZE');

  const forced = style(noDeadline, { forceOverdue: true });
  assert.equal(forced.overdue, true);
  assert.equal(forced.overdueInherited, true);
});

test('回归②：forceOverdue 不会改颜色档位（颜色仍表示"事情多大"）', () => {
  const child = { title: '子', level: 'emerald', start: at(1), deadline: at(24 * 5).toISOString() };
  assert.equal(style(child, { forceOverdue: true }).levelKey, 'emerald');
  assert.equal(style(child, { forceOverdue: true }).level.color, LEVELS[1].color);
});

test('回归②：自己过期时 ownOverdue=true 且不是"继承来的"', () => {
  const s = style({ title: 'x', level: 'amber', start: at(-2) });
  assert.equal(s.overdue, true);
  assert.equal(s.ownOverdue, true);
  assert.equal(s.overdueInherited, false);
  assert.equal(s.intensity, 4, '自己过期 → 通知强度拉满');
});

test('回归②：只是"母气泡过期"不把子气泡的通知强度也拉满', () => {
  // 子气泡自己还没到期，强度应当按它自己的剩余时间算
  const child = { title: '子', level: 'sky', start: at(1), deadline: at(24 * 5).toISOString() };
  assert.equal(style(child, { forceOverdue: true }).intensity, style(child).intensity);
});

// ---------------------------------------------------------------------------
// 回归④：「剩余 N 天」的泡泡不能同时被说成「已过期」（用户报的 bug）
//
// 规则分两层，别把它们合并：
//   · **继承** 仍然存在（母泡泡过期 → 子泡泡要有表示，见文件头 ② 的用户要求）
//   · 但**档位与文字只陈述自己**。容器过期交给 `overdueInherited`，
//     由渲染层用另一种视觉表达（暗紫虚线环），而不是整颗变紫。
// ---------------------------------------------------------------------------

test('回归④：继承来的过期不改档位、也不说"已过期"', () => {
  const child = { title: '子', level: 'emerald', start: at(1), deadline: at(24 * 5).toISOString() };
  const own = style(child);
  const inherited = style(child, { forceOverdue: true });

  assert.equal(inherited.overdue, true, '继承仍要能被渲染层看到（虚线环靠它）');
  assert.equal(inherited.overdueInherited, true);
  assert.equal(inherited.band, own.band, '继承不该改档位');
  assert.equal(inherited.bandLabel, own.bandLabel, '继承不该改档位文字');
  assert.notEqual(inherited.bandLabel, '已过期', '他自己没到期，不能说已过期');
});

test('回归④：只有自己过期才说"已过期"，档位压到最紧迫', () => {
  const s = style({ title: 'x', level: 'amber', start: at(-2) });
  assert.equal(s.ownOverdue, true);
  assert.equal(s.band, 'second');
  assert.equal(s.bandLabel, '已过期');
});

// ---------------------------------------------------------------------------
// 顺带守住：颜色与大小是两个独立通道
// ---------------------------------------------------------------------------

test('颜色（事情多大）与大小（还剩多久）互不影响', () => {
  const levels = ['sky', 'emerald', 'amber', 'red'];
  const ratios = levels.map((lv) => style({ title: 't', level: lv, deadline: at(24 * 5).toISOString() }).radiusRatio);
  assert.equal(new Set(ratios).size, 1, '剩余时间相同 → 大小必须相同，与颜色无关');
  assert.equal(rankOf('red') > rankOf('sky'), true);
});
