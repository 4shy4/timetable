// 回收气泡站：破裂记录的符号约定与合并逻辑。
//
// 用户原话："-3天==提前三天，+2天==拖延两天"
// 符号反了会让人误判"我到底是早了还是晚了"，值得单独钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

const { remainingBadge, buildPoppedRecords, flattenPopped } = await import('../core/recycle.js');

const DAY = 86_400_000;

test('提前完成 → 负数（用户约定）', () => {
  const b = remainingBadge(3 * DAY);
  assert.match(b.text, /^-/, `提前应当是负数，实际 ${b.text}`);
  assert.equal(b.early, true);
  assert.equal(b.late, false);
});

test('拖延 → 正数（用户约定）', () => {
  const b = remainingBadge(-2 * DAY);
  assert.match(b.text, /^\+/, `拖延应当是正数，实际 ${b.text}`);
  assert.equal(b.late, true);
  assert.equal(b.early, false);
});

test('准点 → 0', () => {
  const b = remainingBadge(0);
  assert.match(b.text, /^0/);
  assert.equal(b.early, false);
  assert.equal(b.late, false);
});

test('没记录剩余时间时不乱猜', () => {
  // 老数据（戳破时没记 remainingMs）显示"未记录"，不能猜成 0 或负数
  for (const v of [null, undefined, NaN, 'x']) {
    const b = remainingBadge(v);
    assert.equal(b.text, '未记录', `输入 ${String(v)} 应当显示未记录，实际 ${b.text}`);
  }
});

test('量级读得出来（天 / 小时 / 分钟）', () => {
  assert.match(remainingBadge(5 * DAY).text, /天/);
  assert.match(remainingBadge(-3 * 3_600_000).text, /小时/);
  assert.match(remainingBadge(10 * 60_000).text, /分钟/);
});

test('合并：重复事件戳破多次 → 一条记录，count 是次数', () => {
  const ev = {
    id: 'e1', title: '每天跑步',
    popped: {
      '2026-09-10': { at: '2026-09-10T12:00:00Z', remainingMs: 2 * DAY },
      '2026-09-11': { at: '2026-09-11T12:00:00Z', remainingMs: -1 * DAY },
      '2026-09-12': { at: '2026-09-12T12:00:00Z', remainingMs: 0 },
    },
  };
  const recs = buildPoppedRecords([ev]);
  assert.equal(recs.length, 1, '同一条事件应当合并成一条记录');
  assert.equal(recs[0].count, 3);
  assert.equal(recs[0].entries.length, 3);
  // entries 按发生日期升序（显示时再按破裂时间排）
  assert.deepEqual(recs[0].entries.map((x) => x.occurrence),
    ['2026-09-10', '2026-09-11', '2026-09-12']);
  assert.equal(recs[0].entries[0].remainingMs, 2 * DAY);
});

test('非重复事件被戳破（done + poppedAt）也算一条', () => {
  const ev = { id: 'e2', title: '交报告', done: true, poppedAt: '2026-09-20T08:30:00Z' };
  const recs = buildPoppedRecords([ev]);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].count, 1);
  assert.equal(recs[0].entries[0].remainingMs, null, '这种没有记录剩余时间');
});

test('没破裂过的事件不出现在回收站', () => {
  const recs = buildPoppedRecords([
    { id: 'a', title: '没戳过' },
    { id: 'b', title: '戳过', popped: { '2026-09-01': { at: '2026-09-01T00:00:00Z', remainingMs: 0 } } },
  ]);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].title, '戳过');
});

test('摊平后按时间从新到旧（螺旋的中心是最新）', () => {
  const recs = buildPoppedRecords([{
    id: 'e1', title: 'x',
    popped: {
      '2026-09-10': { at: '2026-09-10T12:00:00Z', remainingMs: 0 },
      '2026-09-12': { at: '2026-09-12T12:00:00Z', remainingMs: 0 },
      '2026-09-11': { at: '2026-09-11T12:00:00Z', remainingMs: 0 },
    },
  }]);
  const flat = flattenPopped(recs);
  assert.equal(flat.length, 3);
  assert.deepEqual(flat.map((x) => x.entry.occurrence),
    ['2026-09-12', '2026-09-11', '2026-09-10'], '最新在前');
  // 第一颗就是螺旋中心那颗
  assert.equal(flat[0].sortKey > flat[1].sortKey, true);
});
