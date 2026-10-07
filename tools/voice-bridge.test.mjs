// 语音桥（写进系统「提醒事项」让 Siri 原生读写）的单元测试。
//
// 为什么值得测透：这条路上的错**在设备上都表现为"Siri 念得不对/念不出来"**，
//   而用户完全没有办法判断是哪一环 —— 而且它**会写进用户的真实数据**
//   （在人家自己的提醒事项清单里增删）。所以两头都要钉死：
//     · 写出去的：不能漏、不能重复、**不能带闹铃**（否则用户收到双份提醒）
//     · 读回来的：不能把我们自己写的镜像又当成用户输入（否则无限自我繁殖）
//
// 跑法：node tools/voice-bridge.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVoiceMirror, voiceItemsToEvents,
  MIRROR_MARK, IMPORTED_MARK, VOICE_LIST_NAME,
} from '../core/voice-bridge.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  + `T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

// ⚠️ 钉住"现在"，否则跨天/跨周时忽红忽绿（那种测试比没有更坏）
const NOW = new Date(2026, 8, 24, 12, 0, 0);   // 2026-09-24 周四

function ev(id, offsetMs, extra = {}) {
  const start = new Date(NOW.getTime() + offsetMs);
  return {
    id, title: id, type: 'personal',
    start: stamp(start), end: stamp(new Date(start.getTime() + HOUR)),
    done: false, level: 'sky', ...extra,
  };
}

// ===========================================================================
// 写出去（App → 提醒事项）
// ===========================================================================
test('镜像：展开重复日程、按时间升序、带上标记', () => {
  const items = buildVoiceMirror([
    ev('一次性', 1 * HOUR, { location: '图书馆' }),
    ev('每天跑步', 2 * HOUR, { recurrence: { freq: 'daily', interval: 1 } }),
  ], { now: NOW, days: 7 });

  assert.ok(items.length > 2, '重复日程要展开成多个：' + items.length);
  for (const it of items) {
    assert.ok(it.notes.startsWith(MIRROR_MARK), '每条都要带镜像标记：' + it.notes);
    assert.ok(it.key && it.due, 'key/due 不能为空');
  }
  const times = items.map((i) => i.due);
  assert.deepEqual(times, [...times].sort(), '要按时间升序');
  const one = items.find((i) => i.title === '一次性');
  assert.ok(one.notes.includes('图书馆'), '地点要带上，好让 Siri 念出来：' + one.notes);
});

test('⚠️ 镜像**不能带闹铃**（否则用户同时收到 App 和提醒事项两条提醒）', () => {
  // 这条是设计约束，不是实现细节：这个对象里**不允许**出现 alarm/remind 之类的字段。
  const items = buildVoiceMirror([ev('x', 1 * HOUR)], { now: NOW, days: 7 });
  for (const it of items) {
    assert.deepEqual(Object.keys(it).sort(), ['due', 'key', 'notes', 'title'],
      '镜像条目的字段形状就是契约，多一个都可能意味着多了一条提醒');
  }
});

test('镜像：已完成的不写出去', () => {
  const items = buildVoiceMirror([
    ev('做完了', 1 * HOUR, { done: true }),
    ev('没做完', 2 * HOUR),
  ], { now: NOW, days: 7 });
  assert.deepEqual(items.map((i) => i.title), ['没做完']);
});

test('镜像：窗口外的不要（只看未来 N 天）', () => {
  const items = buildVoiceMirror([ev('很远', 30 * 24 * HOUR)], { now: NOW, days: 7 });
  assert.equal(items.length, 0);
});

// ===========================================================================
// 读回来（提醒事项 → App）
// ===========================================================================
test('⚠️ 读回来时**必须跳过我们自己写的镜像**（否则会无限自我繁殖）', () => {
  const mirror = buildVoiceMirror([ev('高数课', 1 * HOUR)], { now: NOW, days: 7 });
  const back = voiceItemsToEvents(mirror.map((m, i) => ({ ...m, key: 'r' + i })), { now: NOW });
  assert.deepEqual(back, [], '镜像条目被当成用户输入了 —— 会无限繁殖');
});

test('已经导入过的（带 IMPORTED_MARK）不再导入', () => {
  const back = voiceItemsToEvents([
    { title: '开会', due: '2026-09-25T15:00:00', notes: IMPORTED_MARK },
  ], { now: NOW });
  assert.deepEqual(back, []);
});

test('有到期时间 → 直接用标题 + 到期时间，**不再解析标题**', () => {
  // 系统/Siri 已经解析过了，我们再去解析会画蛇添足
  // （比如标题里真的带"3点"两个字的书名，会被我们误拆）
  const back = voiceItemsToEvents([
    { title: '小组会议', due: '2026-09-25T15:00:00', notes: '' },
  ], { now: NOW });
  assert.equal(back.length, 1);
  assert.equal(back[0].title, '小组会议', '标题不能被改动');
  assert.equal(back[0].start, '2026-09-25T15:00:00');
  assert.equal(back[0].end, '2026-09-25T16:00:00', '默认持续 1 小时');
  assert.equal(back[0].source, 'due');
});

test('只有日期没有时间（All-day）→ 按当天 9:00 算', () => {
  const back = voiceItemsToEvents([{ title: '交作业', due: '2026-09-26', notes: '' }], { now: NOW });
  assert.equal(back[0].start, '2026-09-26T09:00:00');
});

test('⚠️ 没有到期时间 → 用**我们自己的离线解析器**兜底', () => {
  // 用户在提醒事项里手打"明天下午3点 在图书馆 开会 提前20分钟"，
  // 但没设到期时间 —— 这时候我们的 core/nl-parse.js 就有用了
  const back = voiceItemsToEvents([
    { title: '明天下午3点 在图书馆 开会 提前20分钟', due: '', notes: '' },
  ], { now: NOW });
  assert.equal(back.length, 1);
  assert.equal(back[0].title, '开会');
  assert.equal(back[0].start, '2026-09-25T15:00:00');
  assert.equal(back[0].location, '图书馆');
  assert.deepEqual(back[0].reminders, [20]);
  assert.equal(back[0].source, 'text');
});

test('空标题 / 空条目 → 跳过，不生成垃圾日程', () => {
  const back = voiceItemsToEvents([
    { title: '   ', due: '2026-09-25T15:00:00' },
    { title: '', due: '' },
    null,
    { title: '正常', due: '2026-09-25T10:00:00' },
  ], { now: NOW });
  assert.deepEqual(back.map((b) => b.title), ['正常']);
});

test('清单名字要**好念**（用户会用嘴说它）', () => {
  // 别改成 "timetable-mirror" 这种 —— 用户要能对 Siri 说出来
  assert.equal(VOICE_LIST_NAME, '日程表');
  assert.ok(!/[a-zA-Z]/.test(VOICE_LIST_NAME), '清单名不该含拉丁字母');
});

test('human 字段：给界面显示用，要好读', () => {
  const back = voiceItemsToEvents([{ title: '开会', due: '2026-09-25T15:00:00' }], { now: NOW });
  assert.match(back[0].human, /^09-25 15:00$/, '实际：' + back[0].human);
});
