// 同步层（4c）的单元测试。
//
// 重点是**删除**：`tools/sync-to-phone.ps1` 的文件头写过"删除无法用合并表达 ——
// 删掉的东西会被合回来"。这块测试就是钉住"墓碑让删除能传播"这件事，
// 以及"按类别筛选时不会误删不该动的数据"。
//
// 跑法：node tools/sync.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SYNC_CATEGORIES, SYNC_FILTER_ALL, normalizeFilter, categoryEnabled, categoryOfEvent,
  syncPayloadOf, mergeSync, applySync, markDeleted, clearTombstone, tombstonesOf,
  pruneTombstones, graveAt, PRUNE_DAYS, filterPayload, tombstoneStats,
} from '../core/sync.js';
import * as ops from '../core/state-ops.js';
import { defaultDb } from '../core/defaults.js';

/** 两台设备的模拟：各自一份库 */
function deviceA() { return defaultDb(); }
function deviceB() { return defaultDb(); }

/**
 * 两端对跑一次同步（客户端将来也是这个顺序：各自出载荷 → 合并 → 各自写回）。
 * @returns {object} 合并结果
 */
function syncTwo(a, b, filter) {
  const merged = mergeSync(syncPayloadOf(a, filter), syncPayloadOf(b, filter));
  applySync(a, merged, filter);
  applySync(b, merged, filter);
  return merged;
}

const T = (iso) => new Date(iso);
const ev = (id, title, extra = {}) => ({
  id, title, type: 'personal',
  start: '2026-03-02T09:00:00', end: '2026-03-02T10:00:00',
  ...extra,
});
const course = (key, title, extra = {}) => ({
  key, title, dayOfWeek: 1, sections: [1, 2], weeks: [1, 2, 3, 4],
  importedAt: '2026-03-01T00:00:00.000Z', ...extra,
});

// ---------------------------------------------------------------- 筛选语义

test('筛选：三种模式的语义', () => {
  const all = SYNC_FILTER_ALL;
  assert.equal(categoryEnabled(all, 'courses'), true);
  assert.equal(categoryEnabled(all, 'bubbles'), true);

  // 用户的原话："只同步课表（白名单）"
  const onlyCourses = { mode: 'whitelist', categories: ['courses'] };
  assert.equal(categoryEnabled(onlyCourses, 'courses'), true);
  assert.equal(categoryEnabled(onlyCourses, 'bubbles'), false);

  // 用户的原话："只不同步气泡区（黑名单）"
  const noBubbles = { mode: 'blacklist', categories: ['bubbles'] };
  assert.equal(categoryEnabled(noBubbles, 'courses'), true);
  assert.equal(categoryEnabled(noBubbles, 'bubbles'), false);
});

test('筛选：脏值退回"全同步"，而不是把数据卡住', () => {
  // ⚠️ 宁可多同步，也别因为一个坏设置让用户以为"同步坏了"
  assert.deepEqual(normalizeFilter(null), { mode: 'all', categories: [] });
  assert.deepEqual(normalizeFilter({ mode: 'nonsense' }), { mode: 'all', categories: [] });
  assert.deepEqual(normalizeFilter({ mode: 'whitelist' }).categories, []);
  assert.equal(categoryEnabled({ mode: 'weird', categories: [] }, 'bubbles'), true);
  // 类别名也过滤：只认白名单里的两个
  assert.deepEqual(normalizeFilter({ mode: 'whitelist', categories: ['courses', 'nope'] }).categories, ['courses']);
});

test('筛选：一条事件属于哪个类别由 type 决定', () => {
  assert.equal(categoryOfEvent({ type: 'course' }), 'courses');
  assert.equal(categoryOfEvent({ type: 'personal' }), 'bubbles');
  assert.equal(categoryOfEvent({}), 'bubbles');
  assert.equal(categoryOfEvent(null), 'bubbles');
});

test('筛选：载荷里不含被排除的类别（对方才不会去动它）', () => {
  const a = deviceA();
  ops.upsertEvent(a, ev('e1', '气泡'), T('2026-03-02T00:00:00'));
  ops.importCourses(a, {
    courses: [course('k1', '课')],
    meta: { source: 't', termStart: '2026-03-02', sectionTimes: [] },
  }, T('2026-03-02T00:00:00'));

  const p = syncPayloadOf(a, { mode: 'whitelist', categories: ['courses'] });
  assert.equal(p.courses.length, 1, '课程要带上');
  assert.equal(p.events.filter((e) => e.type !== 'course').length, 0, '气泡不该出现');
  assert.ok(p.events.filter((e) => e.type === 'course').length >= 1, '课程事件要带上');
});

// ---------------------------------------------------------------- 墓碑

test('墓碑：删除会记下来，复活会撤掉', () => {
  const a = deviceA();
  ops.upsertEvent(a, ev('e1', '要删的'), T('2026-03-02T00:00:00'));
  ops.deleteEvent(a, 'e1', T('2026-03-02T01:00:00'));
  // ⚠️ 期望值要用 T(...).toISOString()，**不能写死 UTC 字面量**：
  //    `new Date('2026-03-02T01:00:00')` 是**本地时间**（这台机器 +08:00），
  //    转成 UTC 是前一天 17:00。写死 '2026-03-02T01:00:00.000Z' 会假失败。
  assert.equal(graveAt(tombstonesOf(a).events.e1), T('2026-03-02T01:00:00').toISOString());

  // 用同一个 id 重建 → 墓碑必须撤掉，否则同步时会被对方再删一次
  ops.upsertEvent(a, ev('e1', '又建回来了'), T('2026-03-02T02:00:00'));
  assert.equal(tombstonesOf(a).events.e1, undefined, '复活后不该还有墓碑');
  assert.equal(a.events.length, 1);
});

test('墓碑：清空与"替换式导入"都会记', () => {
  const a = deviceA();
  ops.upsertEvent(a, ev('e1', '气泡'), T('2026-03-02T00:00:00'));
  ops.importCourses(a, { courses: [course('k1', '课')], meta: { source: 't', termStart: '2026-03-02' } }, T('2026-03-02T00:00:00'));
  ops.clearEvents(a, {}, T('2026-03-02T03:00:00'));
  const g = tombstonesOf(a);
  assert.ok(g.events.e1, '清空要记气泡的墓碑');
  assert.ok(g.courses.k1, '清空的课程也要记');
});

test('墓碑：太老的会被清理', () => {
  const a = deviceA();
  markDeleted(a, 'events', 'old', '2020-01-01T00:00:00.000Z');
  markDeleted(a, 'events', 'new', new Date().toISOString());
  const removed = pruneTombstones(a, new Date(), PRUNE_DAYS);
  assert.equal(removed, 1);
  assert.equal(tombstonesOf(a).events.old, undefined);
  assert.ok(tombstonesOf(a).events.new, '新鲜的墓碑要留着');
});

test('★ 墓碑默认**不清理** —— 清理正是"删除会复活"的成因', () => {
  // 这场测试记录一个**有实测依据的设计决定**（2026-09-22 量的）：
  //   单条墓碑 76 字节 → 1000 条 74 KB、10000 条 742 KB，而 db.json 才 72 KB。
  //   清理省下的空间基本是零，却会让"超过期限没同步的设备"把已删记录带回来。
  //   所以同步**不再自动清理**，只保留显式的 pruneTombstones()。
  const a = deviceA();
  const b = deviceB();
  ops.upsertEvent(a, ev('e1', '两台都有'), T('2026-03-02T00:00:00'));
  syncTwo(a, b);
  ops.deleteEvent(a, 'e1', T('2026-03-02T05:00:00'));
  // 把两台设备的"现在"拨到很久以后，再同步
  const farFuture = new Date(Date.now() + 400 * 86_400_000);
  const merged = mergeSync(syncPayloadOf(a, null, farFuture), syncPayloadOf(b, null, farFuture));
  applySync(a, merged, null);
  applySync(b, merged, null);
  assert.equal(tombstonesOf(a).events.e1.at || tombstonesOf(a).events.e1, T('2026-03-02T05:00:00').toISOString(),
    '过了 400 天墓碑也要还在 —— 自动清理已经去掉了');
  assert.equal(b.events.length, 0, '删除仍然生效');
});

test('tombstoneStats：给出规模和粗略字节数（判断"要不要清理"的依据）', () => {
  const a = deviceA();
  assert.deepEqual(tombstoneStats(a), { events: 0, courses: 0, total: 0, approxBytes: 0 });
  markDeleted(a, 'events', 'x1', '2026-03-02T00:00:00.000Z');
  markDeleted(a, 'events', 'x2', '2026-03-02T00:00:00.000Z');
  markDeleted(a, 'courses', 'k1', '2026-03-02T00:00:00.000Z');
  const s = tombstoneStats(a);
  assert.equal(s.total, 3);
  assert.equal(s.events, 2);
  assert.equal(s.courses, 1);
  assert.equal(s.approxBytes, 3 * 76);
  // 一万条才 ~740KB：这就是"不值得为省空间而冒复活风险"的量化依据
  assert.ok(10000 * 76 < 800 * 1024, '一万条墓碑不到 800KB');
});

// ---------------------------------------------------------------- 合并的核心

test('★ 删除能传播：A 删掉的，同步后 B 也没有了', () => {
  // 这是整件事的意义所在 —— 没有墓碑时 B 会把它合回来
  const a = deviceA();
  const b = deviceB();
  ops.upsertEvent(a, ev('e1', '两台都有'), T('2026-03-02T00:00:00'));
  syncTwo(a, b);   // 先同步成两边都有
  assert.equal(b.events.length, 1);

  ops.deleteEvent(a, 'e1', T('2026-03-02T05:00:00'));
  syncTwo(a, b);
  assert.equal(a.events.length, 0);
  assert.equal(b.events.length, 0, 'B 那边也必须没了（这就是墓碑的作用）');
});

test('★ 只同步课表时，气泡两台各管各的（互不影响）', () => {
  const a = deviceA();
  const b = deviceB();
  const onlyCourses = { mode: 'whitelist', categories: ['courses'] };

  // 两边各有自己的气泡，内容不同
  ops.upsertEvent(a, ev('a1', 'A 的气泡'), T('2026-03-02T00:00:00'));
  ops.upsertEvent(b, ev('b1', 'B 的气泡'), T('2026-03-02T00:00:00'));
  // A 有课表
  ops.importCourses(a, { courses: [course('k1', '高数')], meta: { source: 't', termStart: '2026-03-02' } }, T('2026-03-02T00:00:00'));

  syncTwo(a, b, onlyCourses);

  assert.equal(a.courses.length, 1);
  assert.equal(b.courses.length, 1, '课表要同步过去');
  assert.deepEqual(a.events.filter((e) => e.type !== 'course').map((e) => e.id), ['a1'], 'A 的气泡不被 B 覆盖');
  assert.deepEqual(b.events.filter((e) => e.type !== 'course').map((e) => e.id), ['b1'], 'B 的气泡不被 A 覆盖');
});

test('★ 黑名单"不同步气泡区"：白名单/黑名单两种写法结果一致', () => {
  const onlyCourses = { mode: 'whitelist', categories: ['courses'] };
  const noBubbles = { mode: 'blacklist', categories: ['bubbles'] };

  const run = (filter) => {
    const a = deviceA();
    const b = deviceB();
    ops.upsertEvent(a, ev('a1', 'A 的气泡'), T('2026-03-02T00:00:00'));
    ops.upsertEvent(b, ev('b1', 'B 的气泡'), T('2026-03-02T00:00:00'));
    ops.importCourses(a, { courses: [course('k1', '高数')], meta: { source: 't', termStart: '2026-03-02' } }, T('2026-03-02T00:00:00'));
    syncTwo(a, b, filter);
    return {
      aBubbles: a.events.filter((e) => e.type !== 'course').map((e) => e.id).sort(),
      bBubbles: b.events.filter((e) => e.type !== 'course').map((e) => e.id).sort(),
      aCourses: a.courses.length, bCourses: b.courses.length,
    };
  };
  assert.deepEqual(run(onlyCourses), run(noBubbles), '两种写法对这件事应当等价');
});

test('合并：两边各自新增的记录都会留下', () => {
  const a = deviceA();
  const b = deviceB();
  ops.upsertEvent(a, ev('a1', 'A 新增'), T('2026-03-02T00:00:00'));
  ops.upsertEvent(b, ev('b1', 'B 新增'), T('2026-03-02T00:00:01'));
  syncTwo(a, b);
  const ids = a.events.map((e) => e.id).sort();
  assert.deepEqual(ids, ['a1', 'b1']);
  assert.deepEqual(b.events.map((e) => e.id).sort(), ['a1', 'b1']);
});

test('合并：同一条两边都改了 → 时间新的赢', () => {
  const a = deviceA();
  const b = deviceB();
  ops.upsertEvent(a, ev('e1', '旧标题'), T('2026-03-02T00:00:00'));
  ops.upsertEvent(b, ev('e1', '旧标题'), T('2026-03-02T00:00:00'));
  // 各自改
  ops.patchEvent(a, 'e1', { title: 'A 改的' }, T('2026-03-02T01:00:00'));
  ops.patchEvent(b, 'e1', { title: 'B 改的' }, T('2026-03-02T02:00:00'));
  syncTwo(a, b);
  assert.equal(a.events[0].title, 'B 改的', 'B 的改动更晚，应当赢');
  assert.equal(b.events[0].title, 'B 改的');
});

test('合并：墓碑比记录新才删；记录比墓碑新就复活', () => {
  const a = deviceA();
  const b = deviceB();
  // B 这边有记录（较旧）
  ops.upsertEvent(b, ev('e1', 'B 的记录'), T('2026-03-02T00:00:00'));
  // A 这边把它删了（较新）
  markDeleted(a, 'events', 'e1', '2026-03-02T05:00:00.000Z');
  let merged = mergeSync(syncPayloadOf(a), syncPayloadOf(b));
  assert.equal(merged.events.length, 0, '墓碑更新 → 删掉');

  // 反过来：墓碑较旧、记录较新 → 保留
  const a2 = deviceA();
  markDeleted(a2, 'events', 'e1', '2026-03-01T00:00:00.000Z');
  const b2 = deviceB();
  ops.upsertEvent(b2, ev('e1', '后来重建的'), T('2026-03-02T00:00:00'));
  merged = mergeSync(syncPayloadOf(a2), syncPayloadOf(b2));
  assert.equal(merged.events.length, 1, '记录比墓碑新 → 复活');
  assert.equal(merged.events[0].title, '后来重建的');
});

test('合并：是纯函数（不改入参）', () => {
  const a = deviceA();
  ops.upsertEvent(a, ev('e1', 'x'), T('2026-03-02T00:00:00'));
  const pa = syncPayloadOf(a);
  const snapshot = JSON.stringify(pa);
  mergeSync(pa, syncPayloadOf(deviceA()));
  assert.equal(JSON.stringify(pa), snapshot, 'mergeSync 不该修改传进去的载荷');
});

test('合并：课表按 key 聚合，两边各自导入的课都在', () => {
  const a = deviceA();
  const b = deviceB();
  ops.importCourses(a, { courses: [course('k1', 'A 的课')], meta: { source: 't', termStart: '2026-03-02' } }, T('2026-03-02T00:00:00'));
  ops.importCourses(b, { courses: [course('k2', 'B 的课')], meta: { source: 't', termStart: '2026-03-02' } }, T('2026-03-02T00:00:01'));
  syncTwo(a, b);
  assert.deepEqual(a.courses.map((c) => c.key).sort(), ['k1', 'k2']);
  assert.deepEqual(b.courses.map((c) => c.key).sort(), ['k1', 'k2']);
});

test('★ 幂等：连同步两次结果不变（不会越同步越多/越少）', () => {
  const a = deviceA();
  const b = deviceB();
  ops.upsertEvent(a, ev('a1', 'A'), T('2026-03-02T00:00:00'));
  ops.upsertEvent(b, ev('b1', 'B'), T('2026-03-02T00:00:01'));
  ops.deleteEvent(b, 'b1', T('2026-03-02T03:00:00'));
  syncTwo(a, b);
  const first = {
    a: a.events.map((e) => e.id).sort(),
    b: b.events.map((e) => e.id).sort(),
  };
  syncTwo(a, b);
  assert.deepEqual(a.events.map((e) => e.id).sort(), first.a, '第二次同步不该改变 A');
  assert.deepEqual(b.events.map((e) => e.id).sort(), first.b, '第二次同步不该改变 B');
});

test('★ 收敛：三轮乱序改动之后两边完全一致', () => {
  const a = deviceA();
  const b = deviceB();
  ops.upsertEvent(a, ev('e1', '一'), T('2026-03-02T00:00:00'));
  syncTwo(a, b);
  // A 改 e1、加 e2；B 改 e1（更晚）、加 e3、删 e2 的位置不同步
  ops.patchEvent(a, 'e1', { title: 'A 改' }, T('2026-03-02T01:00:00'));
  ops.upsertEvent(a, ev('e2', 'A 加的'), T('2026-03-02T01:00:00'));
  ops.patchEvent(b, 'e1', { title: 'B 改' }, T('2026-03-02T02:00:00'));
  ops.upsertEvent(b, ev('e3', 'B 加的'), T('2026-03-02T02:00:00'));
  syncTwo(a, b);
  const dump = (d) => JSON.stringify(d.events.map((e) => [e.id, e.title, e.updatedAt]).sort());
  assert.equal(dump(a), dump(b), '同步后两边必须完全一致');
  assert.deepEqual(a.events.map((e) => e.id).sort(), ['e1', 'e2', 'e3']);
  assert.equal(a.events.find((e) => e.id === 'e1').title, 'B 改', '更晚的改动赢');
});

test('★ 被筛掉的类别不会被对方的墓碑误删', () => {
  // 场景：只同步课表。A 把一条气泡删了（产生墓碑），B 的同类气泡**不能**跟着消失。
  const a = deviceA();
  const b = deviceB();
  ops.upsertEvent(b, ev('b1', 'B 的气泡（要保住）'), T('2026-03-02T00:00:00'));
  ops.upsertEvent(a, ev('b1', '同名 id 的气泡'), T('2026-03-02T00:00:00'));
  ops.deleteEvent(a, 'b1', T('2026-03-02T05:00:00'));

  syncTwo(a, b, { mode: 'whitelist', categories: ['courses'] });
  assert.equal(b.events.length, 1, '气泡类别不同步 → B 的气泡必须原样保留');
  assert.equal(b.events[0].title, 'B 的气泡（要保住）');
});

test('载荷：带上"生成了什么时间"和一个规范化后的筛选', () => {
  const a = deviceA();
  const p = syncPayloadOf(a, { mode: 'blacklist', categories: ['bubbles'] }, T('2026-03-02T00:00:00'));
  assert.equal(p.generatedAt, T('2026-03-02T00:00:00').toISOString(), '要显式用 T().toISOString()，别写死 UTC 字面量');
  assert.deepEqual(p.filter, { mode: 'blacklist', categories: ['bubbles'] });
  assert.deepEqual(Object.keys(p).sort(), ['courses', 'events', 'filter', 'generatedAt', 'tombstones']);
});

test('SYNC_CATEGORIES 就是那两个（改动会被这里提醒）', () => {
  assert.deepEqual(SYNC_CATEGORIES, ['courses', 'bubbles']);
});

// ---------------------------------------------------------------- filterPayload

test('★ filterPayload：服务端也要裁 —— filter 是权威不是建议', () => {
  // 场景：客户端声称"只同步课表"，却把气泡也塞进载荷里（旧版本客户端/手写请求）。
  // 服务端必须把它裁掉，否则用户"我明明选了只同步课表"仍会被覆盖。
  const a = deviceA();
  ops.upsertEvent(a, ev('b1', '不该被同步的气泡'), T('2026-03-02T00:00:00'));
  ops.importCourses(a, { courses: [course('k1', '课')], meta: { source: 't', termStart: '2026-03-02' } }, T('2026-03-02T00:00:00'));

  const unfiltered = syncPayloadOf(a, SYNC_FILTER_ALL);
  assert.ok(unfiltered.events.some((e) => e.type !== 'course'), '前置：未裁的载荷里有气泡');

  const cut = filterPayload(unfiltered, { mode: 'whitelist', categories: ['courses'] });
  assert.equal(cut.events.filter((e) => e.type !== 'course').length, 0, '气泡必须被裁掉');
  assert.equal(cut.courses.length, 1, '课程要留着');
  assert.deepEqual(Object.keys(cut).sort(), ['courses', 'events', 'filter', 'generatedAt', 'tombstones']);
});

test('★ filterPayload：被裁掉的类别，连墓碑一起裁', () => {
  const a = deviceA();
  ops.upsertEvent(a, ev('b1', '气泡'), T('2026-03-02T00:00:00'));
  ops.deleteEvent(a, 'b1', T('2026-03-02T01:00:00'));   // 气泡墓碑
  ops.importCourses(a, { courses: [course('k1', '课')], meta: { source: 't', termStart: '2026-03-02' } }, T('2026-03-02T00:00:00'));

  const p = syncPayloadOf(a, SYNC_FILTER_ALL);
  const cut = filterPayload(p, { mode: 'whitelist', categories: ['courses'] });
  assert.equal(cut.tombstones.events.b1, undefined, '气泡的墓碑不能跟着过去（否则会删掉对方的气泡）');
});

test('filterPayload：空/坏载荷不炸', () => {
  const cut = filterPayload(null, SYNC_FILTER_ALL);
  assert.deepEqual(cut.events, []);
  assert.deepEqual(cut.courses, []);
  assert.deepEqual(cut.tombstones, { events: {}, courses: {} });
  const cut2 = filterPayload({ events: 'not-an-array' }, SYNC_FILTER_ALL);
  assert.deepEqual(cut2.events, []);
});
