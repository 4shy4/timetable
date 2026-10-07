// 「给 Siri 看的那份计划」的单元测试。
//
// 为什么值得测：这条通道是**没有 entitlement 的情况下唯一能让 Siri 读到我们数据的路**
//   （原生 Siri 集成要 com.apple.developer.siri，免费账号拿不到、侧载还会崩）。
//   它错了不会有报错 —— 只会"Hey Siri 说明天有什么，它念出来是错的/是空的"，
//   而用户在设备上完全看不出是哪一环的问题。
//
// 跑法：node tools/share-plan.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSharePlan } from '../core/share-plan.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  + `T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

/** 一次性日程：相对 now 的偏移，避免写死日期变成定时炸弹 */
function ev(id, startOffsetMs, extra = {}) {
  const start = new Date(NOW.getTime() + startOffsetMs);
  return {
    id, title: id, type: 'personal',
    start: stamp(start), end: stamp(new Date(start.getTime() + HOUR)),
    done: false, level: 'sky', ...extra,
  };
}

// ⚠️ 钉住"现在"，否则测试会在跨天/跨周时忽红忽绿 —— 那种测试比没有更坏
//    （它会训练人忽略红色）。2026-09-24 是周四。
const NOW = new Date(2026, 8, 24, 12, 0, 0);

test('未来 N 天：展开重复日程，并按时间升序', () => {
  const r = buildSharePlan([
    ev('一次性的', 1 * HOUR, { location: '图书馆' }),
    // 每天重复 → 7 天窗口内应该出现多次（这正是"只列 events 不展开"会漏掉的东西）
    ev('每天跑步', 2 * HOUR, { recurrence: { freq: 'daily', interval: 1 } }),
  ], { now: NOW, days: 7 });

  assert.ok(r.count > 2, `重复日程必须被展开成多个实例，实际只有 ${r.count} 条`);
  // 升序
  for (let i = 1; i < r.json.events.length; i += 1) {
    const a = r.json.events[i - 1];
    const b = r.json.events[i];
    assert.ok((a.day + a.start) <= (b.day + b.start), '必须按时间升序：' + a.day + a.start + ' vs ' + b.day + b.start);
  }
  // 一次性那条必须在里面，且带地点
  const one = r.json.events.find((e) => e.title === '一次性的');
  assert.ok(one, '一次性日程不见了');
  assert.equal(one.location, '图书馆');
  assert.equal(one.day, '2026-09-24');
  assert.equal(one.start, '13:00');
  assert.equal(one.end, '14:00');
});

test('窗口边界：只看未来 days 天，更远的不出现', () => {
  const r = buildSharePlan([
    ev('今天', 1 * HOUR),
    ev('第3天', 3 * 24 * HOUR),
    ev('第20天', 20 * 24 * HOUR),   // 远超 7 天
  ], { now: NOW, days: 7 });
  const titles = r.json.events.map((e) => e.title);
  assert.ok(titles.includes('今天'));
  assert.ok(titles.includes('第3天'));
  assert.ok(!titles.includes('第20天'), '超出窗口的不该出现');
});

test('已完成的不出现', () => {
  const r = buildSharePlan([
    ev('已做完', 1 * HOUR, { done: true }),
    ev('没做完', 2 * HOUR),
  ], { now: NOW, days: 7 });
  assert.deepEqual(r.json.events.map((e) => e.title), ['没做完']);
});

test('什么都没安排 → 仍然给一句人话（不是空字符串）', () => {
  // ⚠️ Siri 念一段空白是很糟的体验；必须有一句明确的"没有安排"
  const r = buildSharePlan([], { now: NOW, days: 7 });
  assert.equal(r.count, 0);
  assert.ok(r.text.includes('没有安排'), '空白时也要有一句人话：' + JSON.stringify(r.text));
});

test('人念的文本：带日期表头、时间、地点', () => {
  const r = buildSharePlan([
    ev('高数课', 1 * HOUR, { location: '教三305' }),
  ], { now: NOW, days: 7 });
  assert.ok(r.text.includes('高数课'), r.text);
  assert.ok(r.text.includes('教三305'), '地点要被念出来：' + r.text);
  assert.ok(r.text.includes('13:00'), '时间要被念出来：' + r.text);
  assert.match(r.text, /【.+】/, '每天要有个表头：' + r.text);
});

test('⚠️ 表头不能出现「周一 周一」这种重复', () => {
  // ⚠️ 这是用**用户的真实数据**导出时才发现的：`friendlyDay` 对前三天返回
  //    "今天/明天/后天"，更远的**直接返回"周一"** —— 第一版又无脑补了一个"周X"，
  //    于是第 4 天开始全变成「周一 周一」「周二 周二」。
  //    只跑"未来 3 天"的测试**永远发现不了**它，所以这里特意看到第 6 天。
  const r = buildSharePlan([ev('每天', 1 * HOUR, { recurrence: { freq: 'daily', interval: 1 } })],
    { now: NOW, days: 6 });
  assert.ok(!/【周[一二三四五六日] 周/.test(r.text), '表头重复了：\n' + r.text);
  // 前三天仍然是好读的相对说法
  assert.ok(r.text.includes('【今天 周四】'), r.text);
  assert.ok(r.text.includes('【明天 周五】'), r.text);
  // 更远的天用日期 + 星期，比"周一 周一"有用
  assert.match(r.text, /【\d{2}-\d{2} 周[一二三四五六日]】/, '更远的天应当是"日期 周X"：\n' + r.text);
});

test('JSON 形状是给快捷指令用的契约（字段名别随手改）', () => {
  const r = buildSharePlan([ev('x', 1 * HOUR)], { now: NOW, days: 7 });
  assert.deepEqual(Object.keys(r.json).sort(),
    ['count', 'days', 'events', 'from', 'generatedAt', 'to']);
  assert.deepEqual(Object.keys(r.json.events[0]).sort(),
    ['day', 'end', 'level', 'location', 'start', 'title']);
  // ⚠️ generatedAt 用 UTC ISO —— 和提醒计划里 fireAt 的约定一致
  assert.match(r.json.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('样张（人眼看一眼，别只看断言）', () => {
  const r = buildSharePlan([
    ev('高数课', 1 * HOUR, { location: '教三305' }),
    ev('组会', 26 * HOUR, { location: '线上' }),
    ev('每天跑步', 2 * HOUR, { recurrence: { freq: 'daily', interval: 1 } }),
  ], { now: NOW, days: 3 });
  console.log('\n--- Siri 会念到的内容样张 ---');
  console.log(r.text);
  console.log('--- 样张结束 ---\n');
});
