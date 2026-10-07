// 节日泡泡的 style 字段必须**和普通泡泡一样齐**。
//
// 出过的事故（第 48 轮，用户在电脑端填 40 天）：
//   节日泡泡（40 天里只有它会浮出来）一显示，整个气泡区就弹
//   `createRadialGradient: The provided double value is non-finite`，
//   画布一片空白 —— 因为渲染器读了某个节日 style 里**没有**的字段，
//   `undefined` 进算术就变 NaN，NaN 进 canvas 的渐变参数直接抛异常。
//   ⚠️ 这类错最难查的地方在于：**字段缺一个字节都不报错，只在渲染时才炸**，
//   而且炸的是整帧（所有泡泡一起消失），看起来完全不像"少了一个字段"。
//   所以这里用"逐字段对差"把它钉死：普通泡泡有的，节日泡泡必须有，且数值必须有限。
//
// 跑法：node tools/bubble-festival-fields.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBubbleItems, BUBBLE_VIEW_DEFAULTS } from '../core/bubble-select.js';

const now = new Date('2026-09-26T12:00:00');
const at = (h) => new Date(now.getTime() + h * 3_600_000);

/** 一个最小但合法的普通事件 */
function normalEvent() {
  return {
    id: 'ev-normal',
    title: '普通事项',
    start: at(20),
    end: at(22),
    deadline: at(20),
    level: 'amber',
    magnitude: 50,
  };
}

const normalItems = selectBubbleItems([normalEvent()], { now, horizonDays: 40 });
const festItems = selectBubbleItems([], { now, horizonDays: 40, festivalDays: 40 });

test('前置：普通泡泡和节日泡泡都真的选出来了（不然这个测试等于没测）', () => {
  assert.ok(normalItems.length >= 1, '没选出普通泡泡');
  assert.ok(festItems.length >= 1, `没选出节日泡泡（今天 ${now.toISOString()} 起 40 天内应有节日）`);
  assert.ok(festItems.every((i) => i.event && i.event.festival === true), '选出来的不是节日泡泡');
});

test('节日泡泡的 style 字段一个都不许比普通泡泡少', () => {
  const normal = normalItems[0].style;
  const fest = festItems[0].style;
  const missing = Object.keys(normal).filter((k) => !(k in fest));
  assert.deepEqual(missing, [], `节日 style 少了这些字段（渲染器一读就是 NaN → 整帧崩）: ${missing.join(', ')}`);
});

test('节日泡泡的 style 里所有数值都必须是有限数（NaN/Infinity 会直接炸 canvas）', () => {
  for (const item of festItems) {
    for (const [k, v] of Object.entries(item.style)) {
      if (typeof v === 'number') {
        assert.ok(Number.isFinite(v), `节日 style.${k} = ${v} 不是有限数`);
      }
      if (v && typeof v === 'object') {
        for (const [k2, v2] of Object.entries(v)) {
          if (typeof v2 === 'number') {
            assert.ok(Number.isFinite(v2), `节日 style.${k}.${k2} = ${v2} 不是有限数`);
          }
        }
      }
    }
  }
});

test('节日泡泡的事件字段也要齐（start/end 得是合法时间，id 前缀是 festival:）', () => {
  for (const item of festItems) {
    assert.ok(item.event.id.startsWith('festival:'), `id 前缀不对：${item.event.id}`);
    assert.ok(item.start instanceof Date && Number.isFinite(item.start.getTime()), 'start 不是合法时间');
    assert.ok(item.end instanceof Date && Number.isFinite(item.end.getTime()), 'end 不是合法时间');
    assert.ok(item.end.getTime() > item.start.getTime(), 'end 必须晚于 start（方案 C：到期 = 结束）');
    assert.ok(Number.isFinite(item.style.remaining), 'remaining 必须是有限数（气泡大小按它算）');
  }
});
