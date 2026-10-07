// 日/周/月/年级的展开测试（用户要求"严格遵循级别单位"）。
import test from 'node:test';
import assert from 'node:assert/strict';

const { occurrences, freqLabelOf, recurLevelOf } = await import('../core/recurrence.js');

const mk = (start, rec, endHourOffset = 1) => ({
  id: 'x', title: 'x', start, end: start, recurrence: rec,
});
const keys = (ev, from, to) => occurrences(ev, new Date(from), new Date(to)).map((d) => d.toISOString().slice(0, 10));
// 本地日期（toISOString 会按 UTC 偏，跨零点时容易看错）
const localKeys = (ev, from, to) => occurrences(ev, new Date(from), new Date(to))
  .map((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

// ---------- 级别归一化 ----------

test('recurLevelOf：四种级别 + 间隔归一化 + 旧写法兼容', () => {
  assert.deepEqual(recurLevelOf({ freq: 'daily' }), { freq: 'daily', interval: 1 });
  assert.deepEqual(recurLevelOf({ freq: 'daily', interval: 3 }), { freq: 'daily', interval: 3 });
  assert.deepEqual(recurLevelOf({ freq: 'weekly', interval: 2 }), { freq: 'weekly', interval: 2 });
  assert.deepEqual(recurLevelOf({ freq: 'monthly' }), { freq: 'monthly', interval: 1 });
  assert.deepEqual(recurLevelOf({ freq: 'yearly' }), { freq: 'yearly', interval: 1 });
  // 旧写法
  assert.deepEqual(recurLevelOf({ freq: 'biweekly' }), { freq: 'weekly', interval: 2 });
  // 不重复 / 垃圾值
  assert.equal(recurLevelOf({ freq: 'none' }), null);
  assert.equal(recurLevelOf(null), null);
  assert.equal(recurLevelOf({ freq: 'wat' }), null);
  // 边界：0 / 负数 / 非数字 → 1
  assert.equal(recurLevelOf({ freq: 'daily', interval: 0 }).interval, 1);
  assert.equal(recurLevelOf({ freq: 'daily', interval: -3 }).interval, 1);
  assert.equal(recurLevelOf({ freq: 'daily', interval: 'x' }).interval, 1);
  // 各别上限
  assert.equal(recurLevelOf({ freq: 'daily', interval: 9999 }).interval, 365);
  assert.equal(recurLevelOf({ freq: 'monthly', interval: 9999 }).interval, 60);
  assert.equal(recurLevelOf({ freq: 'yearly', interval: 9999 }).interval, 20);
});

test('freqLabelOf：如实显示级别与间隔', () => {
  assert.equal(freqLabelOf({ freq: 'daily' }), '每天');
  assert.equal(freqLabelOf({ freq: 'daily', interval: 3 }), '每 3 天');
  assert.equal(freqLabelOf({ freq: 'weekly' }), '每周');
  assert.equal(freqLabelOf({ freq: 'biweekly' }), '每两周');
  assert.equal(freqLabelOf({ freq: 'weekly', interval: 2 }), '每两周');
  assert.equal(freqLabelOf({ freq: 'weekly', interval: 3 }), '每 3 周');
  assert.equal(freqLabelOf({ freq: 'monthly' }), '每月');
  assert.equal(freqLabelOf({ freq: 'monthly', interval: 2 }), '每 2 月');
  assert.equal(freqLabelOf({ freq: 'yearly' }), '每年');
  assert.equal(freqLabelOf({ freq: 'none' }), '不重复');
});

// ---------- 日级 ----------

test('日级：每天一次', () => {
  const ev = mk('2026-03-02T07:00:00', { freq: 'daily' });
  assert.deepEqual(
    localKeys(ev, '2026-03-02T00:00:00', '2026-03-06T00:00:00'),
    ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'],
  );
});

test('日级：每 3 天', () => {
  const ev = mk('2026-03-02T07:00:00', { freq: 'daily', interval: 3 });
  assert.deepEqual(
    localKeys(ev, '2026-03-01T00:00:00', '2026-03-15T00:00:00'),
    ['2026-03-02', '2026-03-05', '2026-03-08', '2026-03-11', '2026-03-14'],
  );
});

test('日级：不早于事件开始时间（窗口从更早开始时）', () => {
  const ev = mk('2026-03-05T07:00:00', { freq: 'daily' });
  assert.deepEqual(
    localKeys(ev, '2026-03-01T00:00:00', '2026-03-08T00:00:00'),
    ['2026-03-05', '2026-03-06', '2026-03-07'],
  );
});

// ---------- 月级 ----------

test('月级：每月同一天', () => {
  const ev = mk('2026-03-15T09:00:00', { freq: 'monthly' });
  assert.deepEqual(
    localKeys(ev, '2026-03-01T00:00:00', '2026-07-01T00:00:00'),
    ['2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15'],
  );
});

test('月级：每 2 月', () => {
  const ev = mk('2026-03-15T09:00:00', { freq: 'monthly', interval: 2 });
  assert.deepEqual(
    localKeys(ev, '2026-03-01T00:00:00', '2026-10-01T00:00:00'),
    ['2026-03-15', '2026-05-15', '2026-07-15', '2026-09-15'],
  );
});

test('月级：31 号的事件，只有 31 天的月份才新生（2 月跳过，不硬凑）', () => {
  // 用户原话："不要用 31 号死规矩做判定，每个月特殊的灵活来，特殊的分开判断就ok"
  const ev = mk('2026-01-31T09:00:00', { freq: 'monthly' });
  const got = localKeys(ev, '2026-01-01T00:00:00', '2026-06-01T00:00:00');
  // 1/31 ✓、2 月没有 31 → 跳过、3/31 ✓、4 月没有 31 → 跳过、5/31 ✓
  assert.deepEqual(got, ['2026-01-31', '2026-03-31', '2026-05-31']);
  assert.ok(!got.some((k) => k.startsWith('2026-02')), '2 月不该有');
  assert.ok(!got.some((k) => k.startsWith('2026-04')), '4 月（30 天）不该有');
});

test('月级：29/30/31 号在不同月份各按各的来', () => {
  const d29 = mk('2026-01-29T09:00:00', { freq: 'monthly' });
  // 2026 不是闰年 → 2 月只有 28 天 → 2 月跳过
  assert.deepEqual(
    localKeys(d29, '2026-01-01T00:00:00', '2026-04-01T00:00:00'),
    ['2026-01-29', '2026-03-29'],
  );
  const d30 = mk('2026-01-30T09:00:00', { freq: 'monthly' });
  assert.deepEqual(
    localKeys(d30, '2026-01-01T00:00:00', '2026-05-01T00:00:00'),
    ['2026-01-30', '2026-03-30', '2026-04-30'],
  );
});

// ---------- 年级 ----------

test('年级：每年同一天', () => {
  const ev = mk('2026-03-15T09:00:00', { freq: 'yearly' });
  assert.deepEqual(
    localKeys(ev, '2026-01-01T00:00:00', '2029-01-01T00:00:00'),
    ['2026-03-15', '2027-03-15', '2028-03-15'],
  );
});

test('年级：每 2 年', () => {
  const ev = mk('2026-03-15T09:00:00', { freq: 'yearly', interval: 2 });
  assert.deepEqual(
    localKeys(ev, '2026-01-01T00:00:00', '2031-01-01T00:00:00'),
    ['2026-03-15', '2028-03-15', '2030-03-15'],
  );
});

test('年级：2/29 起的事件，只在闰年新生', () => {
  // 2028 是闰年，2027 / 2029 不是
  const ev = mk('2028-02-29T09:00:00', { freq: 'yearly' });
  const got = localKeys(ev, '2028-01-01T00:00:00', '2033-01-01T00:00:00');
  assert.deepEqual(got, ['2028-02-29', '2032-02-29']);
  assert.ok(!got.some((k) => k.startsWith('2029')), '平年不该硬凑成 3/1');
  assert.ok(!got.some((k) => k.startsWith('2030')), '平年不该有');
});

// ---------- until 与级别组合 ----------

test('各级别都遵守 until', () => {
  // ⚠️ until 是**含当天**的（内部按 `until + T23:59:59` 比较）。
  //    这条和 `recurrence.test.mjs` 里「重复在 until 之后停止」的既有约定一致。
  const d = mk('2026-03-02T07:00:00', { freq: 'daily', until: '2026-03-04' });
  assert.deepEqual(localKeys(d, '2026-03-01T00:00:00', '2026-03-10T00:00:00'),
    ['2026-03-02', '2026-03-03', '2026-03-04']);
  const m = mk('2026-03-15T09:00:00', { freq: 'monthly', until: '2026-05-20' });
  assert.deepEqual(localKeys(m, '2026-03-01T00:00:00', '2026-12-01T00:00:00'),
    ['2026-03-15', '2026-04-15', '2026-05-15']);
  const y = mk('2026-03-15T09:00:00', { freq: 'yearly', until: '2027-04-01' });
  assert.deepEqual(localKeys(y, '2026-01-01T00:00:00', '2030-01-01T00:00:00'),
    ['2026-03-15', '2027-03-15']);
});

test('日级在大窗口下不会重复膨胀（对照周级那个 bug）', () => {
  const ev = mk('2026-03-02T07:00:00', { freq: 'daily' });
  const hit = occurrences(ev, new Date('2026-03-01T00:00:00'), new Date('2026-04-01T00:00:00'));
  assert.equal(hit.length, 30, `3 月 2 日起 30 天应当是 30 次，实际 ${hit.length}`);
  assert.equal(new Set(hit.map((d) => d.getTime())).size, 30, '不能有重复');
  assert.ok(hit.every((d, i) => i === 0 || d > hit[i - 1]), '必须严格递增');
});
