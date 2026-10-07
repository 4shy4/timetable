// 「批量生成同质泡泡」+「套用母泡泡参数」的规则测试。
//
// 这两件事都是**用户点名要的**（第 44 轮记在 docs/IOS-TODO.md）：
//   1. 批量产生同质化泡泡（哪些参数可选）
//   2. 母泡泡模板：子气泡可以选择套用母泡泡的参数（哪些参数可选）
//
// 跑法：node tools/event-template.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  batchDrafts, applyParentTemplate, describeBatch, durationMsOf,
  BATCH_MAX, BATCH_KNOBS, PARENT_TEMPLATE_FIELDS, PARENT_TEMPLATE_DEFAULTS, GAP_UNITS, unitMinutes,
} from '../core/event-template.js';
import { allowedChildLevels } from '../core/level.js';

/** 一条"编辑器会发出来的"草稿（字段和 store.saveEvent 要的一致） */
function draft(extra = {}) {
  return {
    title: '交作业',
    type: 'personal',
    location: '教三305',
    teacher: '王老师',
    notes: '带草稿纸',
    start: '2026-09-25T09:00:00',
    end: '2026-09-25T10:30:00',
    level: 'emerald',
    reminders: [30, 0],
    autoReminders: true,
    alarm: true,
    parentId: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// ① 批量生成
// ---------------------------------------------------------------------------
test('批量：数量 / 间隔 / 序号 三个旋钮说了算', () => {
  const list = batchDrafts(draft(), { count: 3, gapMinutes: 60, numberTitles: true });
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((e) => e.title), ['交作业 1', '交作业 2', '交作业 3']);
  assert.deepEqual(list.map((e) => e.start), [
    '2026-09-25T09:00:00', '2026-09-25T10:00:00', '2026-09-25T11:00:00',
  ]);
  // 时长保持一致（1.5 小时）
  assert.deepEqual(list.map((e) => e.end), [
    '2026-09-25T10:30:00', '2026-09-25T11:30:00', '2026-09-25T12:30:00',
  ]);
  // **同质**：其余字段一模一样
  for (const e of list) {
    assert.equal(e.location, '教三305');
    assert.equal(e.level, 'emerald');
    assert.equal(e.teacher, '王老师');
    assert.deepEqual(e.reminders, [30, 0]);
  }
  // ⚠️ 每一条都必须是新对象、而且不能带 id（带 id 会变成"改同一条 N 次"）
  assert.equal(new Set(list.map((e) => e)).size, 3, '必须是三个不同的对象');
  for (const e of list) assert.ok(!('id' in e), '批量出来的草稿不能带 id');
});

test('批量：不要序号时标题全都一样；间隔 0 = 同一时段', () => {
  const same = batchDrafts(draft(), { count: 2, gapMinutes: 0, numberTitles: false });
  assert.deepEqual(same.map((e) => e.title), ['交作业', '交作业']);
  assert.deepEqual(same.map((e) => e.start), ['2026-09-25T09:00:00', '2026-09-25T09:00:00']);
  // 同一时段也要把 end 补上（不然 N 条里有的没结束）
  assert.deepEqual(same.map((e) => e.end), ['2026-09-25T10:30:00', '2026-09-25T10:30:00']);
});

test('批量：count=1 就是普通的一条（原样，不加序号）', () => {
  const one = batchDrafts(draft(), { count: 1, gapMinutes: 60, numberTitles: true });
  assert.equal(one.length, 1);
  assert.equal(one[0].title, '交作业');
  assert.equal(one[0].start, '2026-09-25T09:00:00');
});

test('批量：脏输入不许炸，也不许生成成千上万条', () => {
  assert.equal(batchDrafts(draft(), { count: 0 }).length, 1, '0 条 → 当作 1 条');
  assert.equal(batchDrafts(draft(), { count: -5 }).length, 1);
  assert.equal(batchDrafts(draft(), { count: 'abc' }).length, 1);
  assert.equal(batchDrafts(draft(), { count: 9999 }).length, BATCH_MAX, '超过上限要夹住');
  assert.equal(batchDrafts(draft(), { count: 2.6 }).length, 3, '小数四舍五入');
  // 间隔是脏值时当作 0（同一时段），不是 NaN 时间
  const list = batchDrafts(draft(), { count: 2, gapMinutes: 'x' });
  assert.deepEqual(list.map((e) => e.start), ['2026-09-25T09:00:00', '2026-09-25T09:00:00']);
  // 没有 start 的草稿（新建时理论上不会）也不该产出 Invalid Date
  const noStart = batchDrafts(draft({ start: '', end: '' }), { count: 2, gapMinutes: 30 });
  assert.equal(noStart.length, 2);
  for (const e of noStart) assert.equal(e.start, '');
});

test('批量：时长兜底（结束早于开始 / 没结束 → 1 小时）', () => {
  assert.equal(durationMsOf({ start: '2026-09-25T09:00:00', end: '2026-09-25T08:00:00' }), 3600_000);
  assert.equal(durationMsOf({ start: '2026-09-25T09:00:00' }), 3600_000);
  assert.equal(durationMsOf({ start: '2026-09-25T09:00:00', end: '2026-09-25T09:30:00' }), 30 * 60_000);
});

test('批量：预览那句话和真正生成用的是同一套夹取', () => {
  assert.match(describeBatch({ count: 3, gapMinutes: 30, unit: 'minute' }), /将生成 3 条.*每隔 30 分钟/);
  assert.match(describeBatch({ count: 2, gapMinutes: 0 }), /同一时段/);
  assert.match(describeBatch({ count: 2, gapMinutes: 120, unit: 'hour' }), /每隔 120 小时/);
  assert.match(describeBatch({ count: 1 }), /就一条/);
  // 脏值：预览说"3 条"就必须真的生成 3 条（显示和实际不一致最容易骗到用户）
  const dirty = { count: 3.4, gapMinutes: -1 };
  assert.match(describeBatch(dirty), /将生成 3 条/);
  assert.equal(batchDrafts(draft(), dirty).length, 3);
  // 单位表
  assert.equal(unitMinutes('hour'), 60);
  assert.equal(unitMinutes('day'), 1440);
  assert.equal(unitMinutes('nope'), 1);
  assert.deepEqual(GAP_UNITS.map((u) => u.key), ['minute', 'hour', 'day']);
});

test('批量的旋钮清单是"就这三样"（其余参数全都相同 —— 那才是同质化）', () => {
  assert.deepEqual(BATCH_KNOBS.map((k) => k.key), ['count', 'gapMinutes', 'numberTitles']);
});

// ---------------------------------------------------------------------------
// ② 套用母泡泡的参数
// ---------------------------------------------------------------------------
const parent = {
  id: 'p1', title: '跨文化交际', type: 'course', level: 'red',
  location: '外语楼201', teacher: '李老师', notes: '每周一次',
  start: '2026-09-25T14:00:00', end: '2026-09-25T15:40:00',
  reminders: [60, 10], autoReminders: false, alarm: true,
};

test('套用：默认那几项会被搬过来（时间不搬）', () => {
  const out = applyParentTemplate(draft({ parentId: 'p1', level: 'sky' }), parent);
  assert.equal(out.location, '外语楼201');
  assert.equal(out.teacher, '李老师');
  assert.equal(out.notes, '每周一次');
  assert.equal(out.type, 'course');
  assert.deepEqual(out.reminders, [60, 10]);
  assert.equal(out.autoReminders, false, 'autoReminders 必须跟着提醒一起搬');
  assert.equal(out.alarm, true, 'alarm 是提醒的一部分，也要搬');
  // 时间不默认搬：子任务通常有自己的时间（开始照旧）
  assert.equal(out.start, '2026-09-25T09:00:00');
  // ⚠️ 但**时长**在默认勾选里：所以结束 = 自己的开始 + 母泡泡的时长（1h40m），
  //    不是子气泡原来那个 10:30。这正是"套用母泡泡参数"该有的样子。
  assert.equal(out.end, '2026-09-25T10:40:00');
  // 只有时长搬（开始时间照旧）：这里 start 是 09:00，母泡泡时长 1h40m
  const withDur = applyParentTemplate(draft({ level: 'sky' }), parent, { fields: ['duration'] });
  assert.equal(withDur.start, '2026-09-25T09:00:00');
  assert.equal(withDur.end, '2026-09-25T10:40:00');
});

test('套用：勾哪几项就只搬哪几项（时间那项是"整段照搬"）', () => {
  const onlyLoc = applyParentTemplate(draft({ level: 'sky' }), parent, { fields: ['location'] });
  assert.equal(onlyLoc.location, '外语楼201');
  assert.equal(onlyLoc.notes, '带草稿纸', '没勾的字段保持子气泡自己的');
  assert.equal(onlyLoc.start, '2026-09-25T09:00:00');

  const withTime = applyParentTemplate(draft({ level: 'sky' }), parent, { fields: ['time'] });
  assert.equal(withTime.start, '2026-09-25T14:00:00');
  assert.equal(withTime.end, '2026-09-25T15:40:00');
});

test('套用：**颜色不许照抄** —— 子级必须严于母容器（套娃的硬约束）', () => {
  // 红母泡泡里，草稿是红 → 必须收窄到允许档（最大只能到黄）
  const red = applyParentTemplate(draft({ level: 'red' }), parent, { fields: [] });
  assert.equal(red.level, 'amber', '红装不下红，要收到允许的最大档');
  // 本来就是最小的蓝 → 不动
  const sky = applyParentTemplate(draft({ level: 'sky' }), parent, { fields: [] });
  assert.equal(sky.level, 'sky');
  // 黄母泡泡里草稿是红 → 收到绿（允许范围里的最小可用档就在这里）
  const amberParent = { ...parent, level: 'amber' };
  const inAmber = applyParentTemplate(draft({ level: 'red' }), amberParent, { fields: [] });
  assert.ok(allowedChildLevels('amber').map((l) => l.key).includes(inAmber.level),
    '收窄的结果必须落在允许档里：' + inAmber.level);
  // 老数据只有 magnitude 也要认（否则会兜底成蓝，又是一次"红色容器只能选蓝"）
  const legacy = applyParentTemplate(draft({ level: 'red' }), { ...parent, level: undefined, magnitude: 90 }, { fields: [] });
  assert.equal(legacy.level, 'amber');
});

test('套用：纯函数 —— 原草稿和母泡泡都不许被改动', () => {
  const child = draft({ parentId: 'p1', level: 'sky' });
  const before = JSON.stringify(child);
  const pBefore = JSON.stringify(parent);
  applyParentTemplate(child, parent);
  assert.equal(JSON.stringify(child), before, '子气泡草稿被改了');
  assert.equal(JSON.stringify(parent), pBefore, '母泡泡被改了');
  // 提醒数组也不能是同一个引用（否则改一条会影响另一条）
  const out = applyParentTemplate(child, parent);
  out.reminders.push(999);
  assert.deepEqual(parent.reminders, [60, 10], '提醒数组被共享了引用');
});

test('套用：没有母泡泡 / 没有字段时原样返回', () => {
  const child = draft({ level: 'sky' });
  assert.deepEqual(applyParentTemplate(child, null), child);
  const noop = applyParentTemplate(child, parent, { fields: [] });
  assert.equal(noop.location, '教三305');
  assert.equal(noop.start, '2026-09-25T09:00:00');
  assert.equal(noop.level, 'sky');
});

test('字段清单本身就是契约（界面照着它画勾选框）', () => {
  assert.deepEqual(PARENT_TEMPLATE_FIELDS.map((f) => f.key),
    ['time', 'duration', 'location', 'notes', 'teacher', 'type', 'reminders']);
  // ⚠️ 颜色**不在**可套用清单里
  assert.ok(!PARENT_TEMPLATE_FIELDS.some((f) => f.key === 'level'), '颜色不能被套用');
  // 默认勾选：除了"时间"都勾上
  assert.deepEqual(PARENT_TEMPLATE_DEFAULTS,
    ['duration', 'location', 'notes', 'teacher', 'type', 'reminders']);
});

test('两件事可以叠加：先套用母泡泡参数，再铺成 N 条子气泡', () => {
  const one = applyParentTemplate(draft({ parentId: 'p1', level: 'red' }), parent, { fields: ['location', 'duration'] });
  const list = batchDrafts(one, { count: 3, gapMinutes: 30, numberTitles: true });
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((e) => e.title), ['交作业 1', '交作业 2', '交作业 3']);
  assert.deepEqual(list.map((e) => e.start), [
    '2026-09-25T09:00:00', '2026-09-25T09:30:00', '2026-09-25T10:00:00',
  ]);
  for (const e of list) {
    assert.equal(e.location, '外语楼201');
    assert.equal(e.parentId, 'p1', '批量出来的子气泡仍然挂在母泡泡里');
    assert.equal(e.level, 'amber', '颜色还是收窄后的那一档');
  }
});

// ---------------------------------------------------------------------------
// ③ 接线：编辑器必须**只用** core 那两份规则（规则不许在界面里再写一遍）
// ---------------------------------------------------------------------------
//
// 这一条是照项目里"两条路径迟早不一致"的老规矩来的：界面上要是自己算
// "第几条往后挪多久"或者"哪些字段搬过来"，core 那份就会被绕过。
import fs from 'node:fs';

const editorSrc = fs.readFileSync(new URL('../web/ui/editor.js', import.meta.url), 'utf8');

test('编辑器接的是 core 的规则，不是自己又写一份', () => {
  assert.match(editorSrc, /from '\.\.\/\.\.\/core\/event-template\.js'/, '编辑器没引 core/event-template.js');
  assert.match(editorSrc, /batchDrafts\(/, '批量生成没走 core');
  assert.match(editorSrc, /applyParentTemplate\(/, '套用母泡泡参数没走 core');
  // 勾选框和预览都必须**照 core 的清单**画：加一个字段时界面自动跟上
  assert.match(editorSrc, /PARENT_TEMPLATE_FIELDS\.map/, '勾选框应当由 core 的字段清单生成');
  assert.match(editorSrc, /describeBatch\(/, '预览那句话要用 core 的（显示和实际不一致最坑）');
  assert.match(editorSrc, /BATCH_MAX/, '数量上限要用 core 的常量');
});

test('编辑器里那两块只在合适的时候出现', () => {
  // 批量：只在**新建**时（改一条已有日程时"生成 N 条"语义不清）
  assert.match(editorSrc, /const batchBlock = isNew \?/, '批量块应当只在新建成时出现');
  // 套用母泡泡参数：只在**新建子气泡**时（有 parent）
  assert.match(editorSrc, /const inheritBlock = \(isNew && parent\) \?/, '套用块应当只在新建子气泡时出现');
});

test('批量保存不许把失败吞掉（建了 5 条只成 3 条要说出来）', () => {
  assert.match(editorSrc, /const failed = \[\]/, '没有记录失败的那几条');
  assert.match(editorSrc, /failed\.push/, '失败没有被收集');
  assert.match(editorSrc, /有 \$\{failed\.length\} 条没建成|条没建成/, '没有把失败条数告诉用户');
});
