// 事件模型：截止时间 / 两种填写方式 / 套娃层级 / 戳破释放 / 旧数据迁移
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 用临时 data 目录，避免污染真实 db.json。
// 注意必须在 import store 之前把 --data-dir 塞进 argv：paths.js 在模块加载时就会解析它。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'timetable-evt-'));
process.argv.push(`--data-dir=${TMP}`);

const store = await import('../server/store.js');
const { DAY_MS, WEEK_MS, MONTH_MS, YEAR_MS } = await import('../core/countdown.js');
const { expandRange, applyPeriodLimit } = await import('../core/recurrence.js');

function reset() {
  store.clearEvents({ keepCourses: false });
  store.updateSettings({ termStart: '', sectionTimes: [] });
}

const stamp = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}:00`;
};

/**
 * 相对"现在"算的测试时刻。
 *
 * ⚠️ 原来这里全是用写死的日期（`2026-03-xx`）。等真实日期超过它们之后，
 * 容器就都变成"过期"了，于是触发「过期容器只读」规则 —— 十几个套娃用例
 * 集体假失败。**写死日期 = 定时炸弹**，凡是要"未来"的测试都必须相对算。
 *
 * 约定：F(days, hours) 从"现在"往后推，必然是未来。
 */
const F = (days = 0, hours = 0) => stamp(new Date(Date.now() + days * DAY_MS + hours * 3600_000));

// ---------------------------------------------------------------------------
// 截止时间
// ---------------------------------------------------------------------------
test('不填 deadline 就用 start 当截止时刻', () => {
  reset();
  const ev = store.upsertEvent({ title: 'A', start: F(10) });
  assert.equal(ev.deadlineSource, 'start');
  assert.equal(new Date(ev.deadline).getTime(), new Date(F(10)).getTime());
});

test('填了 deadline 就用它，而且 start 可以另设（例如"周三开始、周五截止"）', () => {
  reset();
  const ev = store.upsertEvent({
    title: 'B',
    start: F(10),
    deadline: F(14, 8),
  });
  assert.equal(ev.deadlineSource, 'explicit');
  assert.equal(new Date(ev.deadline).getTime(), new Date(F(14, 8)).getTime());
});

test('距离期限：分量换算成绝对截止时刻，之后倒计时自己走', () => {
  reset();
  const at = new Date(F(10)).getTime();
  const ev = store.upsertEvent({
    title: 'C',
    start: F(10),
    countdownParts: { week: 3 },
    countdownAt: at,
  });
  assert.equal(ev.deadlineSource, 'distance');
  assert.equal(new Date(ev.deadline).getTime() - at, 3 * WEEK_MS);
  // 原始分量留着，编辑时要能回显"3 周"
  assert.deepEqual(ev.countdownParts, { week: 3 });
  assert.equal(ev.countdownAt, at);
});

test('距离期限：3 年 4 月也能换算（按日历相加，不是 365×3+30×4 天）', () => {
  reset();
  // ⚠️ 这个用例**故意用固定锚点**：它要验的是"按日历相加"，
  //    期望值写成具体的年月日才有意义（相对时间会让期望值失去确定性）。
  //    锚点选在**未来** —— 否则容器会被判成过期，触发"过期容器只读"规则。
  //    原来这里锚的是 2026-01-01（已经过去了），就是踩了这个坑。
  const at = new Date('2030-01-01T12:00:00').getTime();
  const ev = store.upsertEvent({
    title: 'D',
    start: '2030-01-01T12:00:00',
    countdownParts: { year: 3, month: 4 },
    countdownAt: at,
  });
  // 日历落点：2030-01-01 12:00 + 3 年 4 月 = 2033-05-01 12:00
  const expected = new Date(2033, 4, 1, 12, 0, 0).getTime();
  assert.equal(new Date(ev.deadline).getTime(), expected, `落点 ${ev.deadline}`);
  // 固定长度口径会少两天（365×3 + 30×4 = 1455 天 < 3 个日历年 + 4 个月）
  assert.notEqual(new Date(ev.deadline).getTime(), at + 3 * YEAR_MS + 4 * MONTH_MS);
});

test('remainingOf 与 bandForEvent：正常 / 过期', () => {
  reset();
  const now = new Date('2026-03-02T10:00:00');
  const ev = store.upsertEvent({ title: 'E', start: stamp(new Date(now.getTime() + 3 * DAY_MS)) });
  assert.equal(store.remainingOf(ev, now), 3 * DAY_MS);
  assert.equal(store.bandForEvent(ev, now).band, 'day');
  // 过了截止 → 剩余是负数，overdue
  const late = store.upsertEvent({ title: 'F', start: stamp(new Date(now.getTime() - DAY_MS)) });
  assert.ok(store.remainingOf(late, now) < 0);
  assert.equal(store.bandForEvent(late, now).overdue, true);
});

// ---------------------------------------------------------------------------
// 颜色 = 事情多大
// ---------------------------------------------------------------------------
test('颜色四档可存可取；默认蓝', () => {
  reset();
  assert.equal(store.upsertEvent({ title: 'a', start: F(10) }).level, 'sky');
  for (const lv of ['sky', 'emerald', 'amber', 'red']) {
    const ev = store.upsertEvent({ title: `t-${lv}`, start: F(10), level: lv });
    assert.equal(ev.level, lv);
    assert.equal(store.levelOf(ev), lv);
  }
});

test('旧数据迁移：magnitude / importance / tier 都能换算成四档', () => {
  reset();
  assert.equal(store.levelOf({ magnitude: 90 }), 'red');
  assert.equal(store.levelOf({ magnitude: 65 }), 'amber');
  assert.equal(store.levelOf({ magnitude: 45 }), 'emerald');
  assert.equal(store.levelOf({ magnitude: 20 }), 'sky');
  assert.equal(store.levelOf({ importance: 5 }), 'red');
  assert.equal(store.levelOf({ importance: 3 }), 'emerald');
  assert.equal(store.levelOf({ tier: 'amber' }), 'amber');
  // 显式 level 优先于旧字段
  assert.equal(store.levelOf({ level: 'sky', magnitude: 90 }), 'sky');
});

test('upsertEvent 会把旧的 magnitude 字段落成 level', () => {
  reset();
  const ev = store.upsertEvent({ title: 'x', start: F(10), magnitude: 85 });
  assert.equal(ev.level, 'red');
});

// ---------------------------------------------------------------------------
// 套娃层级
// ---------------------------------------------------------------------------
test('套娃：红里能放黄/绿/蓝，不能放红', () => {
  reset();
  const parent = store.upsertEvent({ title: '红', start: F(14), level: 'red' });
  assert.ok(store.upsertEvent({ title: '黄', start: F(14), level: 'amber', parentId: parent.id }));
  assert.ok(store.upsertEvent({ title: '绿', start: F(14), level: 'emerald', parentId: parent.id }));
  assert.ok(store.upsertEvent({ title: '蓝', start: F(14), level: 'sky', parentId: parent.id }));
  assert.throws(
    () => store.upsertEvent({ title: '红2', start: F(14), level: 'red', parentId: parent.id }),
    /只能放更小的东西/,
  );
});

test('过期（紫色）容器只读：能进去看，但不能往里加子泡泡', () => {
  reset();
  // 截止时间在过去 → 过期
  const overdue = store.upsertEvent({ title: '过期的红', start: F(-1), level: 'red' });
  assert.equal(store.isOverdue(overdue, store.load().events), true);

  // 往里加 → 拒
  assert.throws(
    () => store.upsertEvent({ title: '子', start: F(14), level: 'sky', parentId: overdue.id }),
    /过期/,
  );
  // 没过期的照常可以加
  const fresh = store.upsertEvent({ title: '没过期的红', start: F(14), level: 'red' });
  assert.ok(store.upsertEvent({ title: '子2', start: F(14), level: 'sky', parentId: fresh.id }));

  // 拖拽改归属（走 patchEvent）也要拒
  const loose = store.upsertEvent({ title: '游离的蓝', start: F(14), level: 'sky' });
  assert.throws(
    () => store.patchEvent(loose.id, { parentId: overdue.id }),
    /过期/,
  );
});

test('过期容器的子气泡**仍然可以拉出来**（用户明确要过的功能）', () => {
  reset();
  // 先建一个不过期的容器 + 子气泡
  const willExpire = store.upsertEvent({ title: '即将过期', start: F(14), level: 'red' });
  const inner = store.upsertEvent({ title: '里面的子', start: F(14), level: 'sky', parentId: willExpire.id });
  // 把父的截止时间改到过去 → 父变紫
  store.patchEvent(willExpire.id, { deadline: F(-1) });
  const nowOverdue = store.load().events.find((e) => e.id === willExpire.id);
  assert.equal(store.isOverdue(nowOverdue, store.load().events), true, '父应当已过期');
  // 拉出来 → 必须允许（否则子气泡会被永久锁在紫容器里）
  const out = store.patchEvent(inner.id, { parentId: null });
  assert.equal(out.parentId, null);
});

test('套娃：黄里只有绿/蓝；绿里只有蓝；蓝什么都放不下', () => {
  reset();
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber' });
  assert.ok(store.upsertEvent({ title: '绿', start: F(14), level: 'emerald', parentId: amber.id }));
  assert.throws(() => store.upsertEvent({ title: '黄2', start: F(14), level: 'amber', parentId: amber.id }), /只能放更小的东西/);
  assert.throws(() => store.upsertEvent({ title: '红', start: F(14), level: 'red', parentId: amber.id }), /只能放更小的东西/);

  const emerald = store.upsertEvent({ title: '绿', start: F(14), level: 'emerald' });
  assert.ok(store.upsertEvent({ title: '蓝', start: F(14), level: 'sky', parentId: emerald.id }));
  assert.throws(() => store.upsertEvent({ title: '绿2', start: F(14), level: 'emerald', parentId: emerald.id }), /只能放更小的东西/);

  const sky = store.upsertEvent({ title: '蓝', start: F(14), level: 'sky' });
  assert.throws(() => store.upsertEvent({ title: 'x', start: F(14), level: 'sky', parentId: sky.id }), /只能放更小的东西/);
});

test('父容器不存在时**降级为最外层新建**，而不是报错', () => {
  // ⚠️ 这是**有意的行为变更**，不是放松校验。
  //
  // 原来这里抛 400「父气泡不存在」，结果用户遇到的是"只要创建就失败"：
  // 客户端（旧缓存 / 套娃路径残留）会把一个已经删掉的容器 id 一直发上来，
  // 一条 400 就把**创建这件事整个**堵死了，用户没有任何自救手段。
  //
  // 用户的意图是"新建一条日程"，父容器没了不该阻止这件事 —— 当最外层建出来，
  // 比失败有用得多。"父不存在"属于状态过期，能自愈就自愈；
  // 真正要拒绝的是**层级不符**（那才是用户能懂的约束）。
  reset();
  const ev = store.upsertEvent({ title: 'x', start: F(14), level: 'sky', parentId: 'evt_nope' });
  assert.equal(ev.parentId, null, '应当被当成最外层');
  assert.ok(ev.id, '应当照常创建成功');
});

test('childrenOf 只取直接子级，不含孙子', () => {
  reset();
  const red = store.upsertEvent({ title: '红', start: F(14), level: 'red' });
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber', parentId: red.id });
  const green = store.upsertEvent({ title: '绿', start: F(14), level: 'emerald', parentId: amber.id });
  void green;
  assert.deepEqual(store.childrenOf(red.id).map((e) => e.title), ['黄']);
  assert.deepEqual(store.childrenOf(amber.id).map((e) => e.title), ['绿']);
});

test('改颜色时也要过层级校验：把自己改得比父还大 → 报错', () => {
  reset();
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber' });
  const green = store.upsertEvent({ title: '绿', start: F(14), level: 'emerald', parentId: amber.id });
  assert.throws(() => store.patchEvent(green.id, { level: 'red' }), /只能放更小的东西/);
  // 改小是允许的
  assert.equal(store.patchEvent(green.id, { level: 'sky' }).level, 'sky');
});

// ---------------------------------------------------------------------------
// 拖拽移动（用户新加的功能）：拖动改归属、拉出来变平级
// ---------------------------------------------------------------------------

test('拖动改归属：patchEvent 传 parentId 能把气泡放进另一个气泡', () => {
  reset();
  const red = store.upsertEvent({ title: '红', start: F(14), level: 'red' });
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber' });
  assert.equal(amber.parentId, null, '一开始是平级');
  const moved = store.patchEvent(amber.id, { parentId: red.id });
  assert.equal(moved.parentId, red.id, '应当已放进红里');
  assert.deepEqual(store.childrenOf(red.id).map((e) => e.title), ['黄']);
});

test('拖动拉出来：patchEvent 传 parentId=null 变成平级', () => {
  reset();
  const red = store.upsertEvent({ title: '红', start: F(14), level: 'red' });
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber', parentId: red.id });
  const out = store.patchEvent(amber.id, { parentId: null });
  assert.equal(out.parentId, null, '应当已经拉出来');
  assert.deepEqual(store.childrenOf(red.id), [], '红里面应当空了');
});

test('只是改别的字段时，parentId 必须保持不变（"只挪位置"不能改归属）', () => {
  reset();
  // 这条很关键：界面上"把子气泡在母气泡里挪个位置"不该改归属。
  // 服务端在 patch 没带 parentId 时保留原值，是整个拖拽语义的前提。
  const red = store.upsertEvent({ title: '红', start: F(14), level: 'red' });
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber', parentId: red.id });
  const after = store.patchEvent(amber.id, { title: '黄（改名）' });
  assert.equal(after.parentId, red.id, 'parentId 被意外清掉了');
  assert.equal(after.title, '黄（改名）');
  assert.deepEqual(store.childrenOf(red.id).map((e) => e.title), ['黄（改名）']);
});

test('拖到比自己小的气泡上：服务端也要拦住（界面会抖一下，服务端是最后一道）', () => {
  reset();
  const green = store.upsertEvent({ title: '绿', start: F(14), level: 'emerald' });
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber' });
  assert.throws(() => store.patchEvent(amber.id, { parentId: green.id }), /只能放更小的东西/);
});

test('防套环：不能把气泡放进它自己的后代里（显式挡一道，不靠等级排序的巧合）', () => {
  reset();
  const red = store.upsertEvent({ title: '红', start: F(14), level: 'red' });
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber', parentId: red.id });
  const green = store.upsertEvent({ title: '绿', start: F(14), level: 'emerald', parentId: amber.id });

  // 说明：严格按等级排序时，环其实不可能形成（那会要求某一级严格小于自己）。
  // 但那是"靠巧合成立"的，所以 store 里显式做了后代检查。
  // 这里不去断言具体报错文案（等级校验可能先命中），只要求"必须失败且结构不被改乱"。
  assert.throws(() => store.patchEvent(red.id, { parentId: green.id }), undefined, '塞进孙子应当失败');
  assert.throws(() => store.patchEvent(red.id, { parentId: amber.id }), undefined, '塞进儿子应当失败');
  assert.throws(() => store.patchEvent(red.id, { parentId: red.id }), /自己/, '塞进自己应当失败');

  const st = store.getState();
  assert.equal(st.events.find((e) => e.id === red.id).parentId, null, '红不该被塞进任何地方');
  assert.equal(st.events.find((e) => e.id === amber.id).parentId, red.id, '层级不该被改乱');
  assert.equal(st.events.find((e) => e.id === green.id).parentId, amber.id, '层级不该被改乱');
});

test('后代检查本身有效：直接验证 isDescendant 的行为（通过 patchEvent 间接观察）', () => {
  reset();
  // 造一条"等级上允许、但会成环"的场景不容易（等级排序天然防环），
  // 所以退一步验证：合法的移动仍然畅通，非法的都不通。
  const red = store.upsertEvent({ title: '红', start: F(14), level: 'red' });
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber' });
  const green = store.upsertEvent({ title: '绿', start: F(14), level: 'emerald' });

  // 绿 → 进红（合法）
  assert.equal(store.patchEvent(green.id, { parentId: red.id }).parentId, red.id);
  // 红 → 想进绿（绿现在是红的儿子；成环 + 等级都不允许）
  assert.throws(() => store.patchEvent(red.id, { parentId: green.id }));
  // 黄 → 进绿（绿是绿，等级 1<1 不允许）
  assert.throws(() => store.patchEvent(amber.id, { parentId: green.id }));
  // 绿 → 拉出来（合法）
  assert.equal(store.patchEvent(green.id, { parentId: null }).parentId, null);
});

test('改颜色时不能把自己改得比里面的子气泡还小', () => {
  reset();
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber' });
  store.upsertEvent({ title: '绿', start: F(14), level: 'emerald', parentId: amber.id });
  assert.throws(() => store.patchEvent(amber.id, { level: 'sky' }), /装不下它们/);
});

test('不能把自己放进自己里', () => {
  reset();
  const a = store.upsertEvent({ title: 'a', start: F(14), level: 'red' });
  assert.throws(() => store.patchEvent(a.id, { parentId: a.id }), /不能把自己放进自己里/);
});

// ---------------------------------------------------------------------------
// 戳破：只释放直接子级
// ---------------------------------------------------------------------------
test('戳破只释放**直接子级**，孙子不动（用户明确要求）', () => {
  reset();
  const red = store.upsertEvent({ title: '红', start: F(14), level: 'red' });
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber', parentId: red.id });
  const green = store.upsertEvent({ title: '绿', start: F(14), level: 'emerald', parentId: amber.id });
  const sky = store.upsertEvent({ title: '蓝', start: F(14), level: 'sky', parentId: green.id });

  const res = store.popEvent(red.id);
  assert.equal(res.event.done, true);
  assert.deepEqual(res.released, [amber.id]);

  // 黄被放到了根层（原本红的层级就是根）
  const after = store.getState().events;
  const amberAfter = after.find((e) => e.id === amber.id);
  assert.equal(amberAfter.parentId, null);
  // 绿还在黄下面，蓝还在绿下面 —— 孙子没漏出来
  assert.equal(after.find((e) => e.id === green.id).parentId, amber.id);
  assert.equal(after.find((e) => e.id === sky.id).parentId, green.id);
});

test('戳破嵌套里的气泡：子级升到祖父那一层', () => {
  reset();
  const red = store.upsertEvent({ title: '红', start: F(14), level: 'red' });
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber', parentId: red.id });
  const green = store.upsertEvent({ title: '绿', start: F(14), level: 'emerald', parentId: amber.id });

  store.popEvent(amber.id);
  const after = store.getState().events;
  assert.equal(after.find((e) => e.id === green.id).parentId, red.id, '绿应该升到红下面');
});

test('删除容器也把子级放出一级，不连带删除', () => {
  reset();
  const red = store.upsertEvent({ title: '红', start: F(14), level: 'red' });
  const amber = store.upsertEvent({ title: '黄', start: F(14), level: 'amber', parentId: red.id });
  store.deleteEvent(red.id);
  const after = store.getState().events;
  assert.equal(after.length, 1);
  assert.equal(after[0].id, amber.id);
  assert.equal(after[0].parentId, null);
});

// ---------------------------------------------------------------------------
// 提醒：按剩余时间档位，与颜色无关
// ---------------------------------------------------------------------------
test('提醒强度只看剩余时间，跟颜色无关', () => {
  reset();
  const now = new Date('2026-03-02T10:00:00');
  const soon = stamp(new Date(now.getTime() + 30 * 60_000)); // 30 分钟 → 分档
  const small = store.upsertEvent({ title: '小事', start: soon, level: 'sky' });
  const big = store.upsertEvent({ title: '大事', start: soon, level: 'red' });
  assert.deepEqual(store.effectiveReminders(small, now), store.effectiveReminders(big, now));
  assert.equal(store.bandForEvent(small, now).intensity, 4);
  assert.equal(store.bandForEvent(big, now).intensity, 4);
});

// ---------------------------------------------------------------------------
// 保存往返：编辑器写进去的字段，一个都不能被静默丢掉
// ---------------------------------------------------------------------------
//
// ⚠️ upsertEvent 的 `base` 是**逐字段列举**的字面量：不在那里写一句的字段会被丢掉，
//    而且**哪儿都不报错**。这个坑已经踩了两次，两次的用户表现都是"**编辑无效**"：
//      · alarm：勾了"到点用真闹钟"，重开一看没勾
//      · periodDays：填了"周期（天）"，重开还是旧值；而且 applyPeriodLimit 读不到它，
//        于是**超限的重复泡泡不消失**（用户报的就是这个）
//    教训：**"枚举"这种东西靠记性是守不住的，必须有往返测试钉住。**
test('保存往返：periodDays / alarm 存得进去也读得回来（这两个字段踩过"编辑无效"）', () => {
  reset();
  const ev = store.upsertEvent({
    title: '每周一交作业',
    start: F(3),
    end: F(3, 1),
    recurrence: { freq: 'weekly', byDay: [1] },
    periodDays: 3,
    alarm: true,
  });
  assert.equal(ev.periodDays, 3, 'periodDays 必须落库（否则"周期"编辑无效）');
  assert.equal(ev.alarm, true, 'alarm 必须落库（否则真闹钟开关无效）');

  // 再读一次（走真正的读路径，不是刚返回的那个对象）
  const back = store.getState().events.find((e) => e.id === ev.id);
  assert.equal(back.periodDays, 3);
  assert.equal(back.alarm, true);

  // 归一化：空值必须是 null（不是 0 —— 0 会让 applyPeriodLimit 把重复筛到只剩第一颗）
  const cleared = store.upsertEvent({ ...back, periodDays: '', alarm: false });
  assert.equal(cleared.periodDays, null, '空 → null，不能是 0');
  assert.equal(cleared.alarm, false);

  // 脏值也要收好：'2.9' → 2，'0'/'x' → 至少 1
  assert.equal(store.upsertEvent({ ...back, periodDays: '2.9' }).periodDays, 2);
  assert.equal(store.upsertEvent({ ...back, periodDays: 0 }).periodDays, 1);
  assert.equal(store.upsertEvent({ ...back, periodDays: 'x' }).periodDays, 1);
});

test('重复日程只有一份状态：改任何一颗实例 = 改整条系列', () => {
  reset();
  const ev = store.upsertEvent({
    title: '每周一交作业',
    start: F(3),
    end: F(3, 1),
    recurrence: { freq: 'weekly', byDay: [1] },
    periodDays: 3,
  });
  assert.equal(store.getState().events.length, 1, '重复日程在库里就是**一条**，不是每次发生一条');

  // 气泡区的每颗实例引用的都是这条基础事件（expandRange 返回的 item.event 就是它本身）。
  // 所以"在某一颗上改" = "拿这条基础事件去 upsert" —— 校验这条链真的只有一份状态。
  const expanded = expandRange(store.getState().events, new Date(), new Date(Date.now() + 60 * DAY_MS));
  assert.ok(expanded.length >= 2, '一个月内至少有两颗实例，才谈得上多编辑器');
  assert.ok(expanded.every((it) => it.event.id === ev.id), '所有实例都指向同一条基础事件');

  // 在第二颗上把「周期」改成 8 天 → 整条系列都是 8 天，不存在"这颗 3 天那颗 8 天"
  const second = expanded[1];
  const saved = store.upsertEvent({ ...second.event, periodDays: 8 });
  const all = store.getState().events;
  assert.equal(all.length, 1, '编辑实例不能新增出一条');
  assert.equal(all[0].periodDays, 8);
  assert.equal(saved.id, ev.id);
});

test('周期（periodDays）真的会筛掉超限的实例 —— 端到端：存进去 → 展开 → 筛', () => {
  reset();
  const ev = store.upsertEvent({
    title: '每周一交作业',
    start: F(3),
    end: F(3, 1),
    recurrence: { freq: 'weekly', byDay: [1] },
    periodDays: 3,
  });
  const items = expandRange(store.getState().events, new Date(), new Date(Date.now() + 60 * DAY_MS));
  const kept = applyPeriodLimit(items, new Date());
  assert.ok(kept.length < items.length,
    `周期 3 天必须把后面的实例筛掉（原本 ${items.length} 颗，筛后 ${kept.length} 颗）`);
  assert.equal(kept[0].event.id, ev.id);

  // 周期改大 → 又冒出来（用户原话："周期改成 8 天又会出来"）
  store.upsertEvent({ ...ev, periodDays: 14 });
  const items2 = expandRange(store.getState().events, new Date(), new Date(Date.now() + 60 * DAY_MS));
  assert.ok(applyPeriodLimit(items2, new Date()).length > kept.length, '周期放大后实例要变多');
});

// ---------------------------------------------------------------------------
// 未来泡泡：`start` = 出现日期（到那天之前只在气泡区不显示），`end` = 到期
// ---------------------------------------------------------------------------
test('保存往返：future 存得进去也读得回来', () => {
  reset();
  const ev = store.upsertEvent({
    title: '期末考试周',
    start: F(30),      // 出现日期（30 天后才开始在意）
    end: F(45),        // 到期
    future: true,
  });
  assert.equal(ev.future, true);
  assert.equal(store.getState().events.find((e) => e.id === ev.id).future, true);
  // 不填截止时间 → 到期自动落到 `end`（方案 C：deadline > end > start）
  assert.equal(new Date(ev.deadline).getTime(), new Date(ev.end).getTime());
});

test('未来泡泡：出现日期之前"还没出现"，到了就照常可见', () => {
  const ev = { id: 'f1', title: '未来', start: '2026-03-10T09:00:00', end: '2026-03-20T18:00:00', future: true };
  assert.equal(store.isNotYetVisible(ev, new Date('2026-03-01T00:00:00')), true, '还没到 → 不显示');
  assert.equal(store.isNotYetVisible(ev, new Date('2026-03-09T23:59:00')), true, '前一天 → 不显示');
  assert.equal(store.isNotYetVisible(ev, new Date('2026-03-10T09:00:00')), false, '到点那一刻 → 显示');
  assert.equal(store.isNotYetVisible(ev, new Date('2026-03-15T00:00:00')), false, '之后 → 显示');

  // 不是未来泡泡的一律可见（默认行为不能被这条改动影响）
  assert.equal(store.isNotYetVisible({ ...ev, future: false }, new Date('2026-03-01T00:00:00')), false);
  assert.equal(store.isNotYetVisible({ ...ev, future: undefined }, new Date('2026-03-01T00:00:00')), false);
  // 脏数据（start 不是时间）→ 当作可见，别把泡泡藏没了
  assert.equal(store.isNotYetVisible({ ...ev, start: '' }, new Date('2026-03-01T00:00:00')), false);
});

// ---------------------------------------------------------------------------
// 「容器过期」的判据只看祖先链，绝不看自己（用户截图里那圈紫齿轮）
// ---------------------------------------------------------------------------
//
// ⚠️ 这是一个**被用户一眼看出来**的 bug：一颗"上周建的、每周重复"的日程，
//    本周/下周那两颗明明写着"剩余 N 天"，却挂着一圈暗紫虚线（"容器过期"标记）。
//    根因：渲染层把 `isOverdueEvent(ev)`（读 **base** 的期限 = 第一次发生那次）
//    当成"容器过期"的判据，而屏幕上这颗是**本次发生**（期限在将来）。
test('容器过期只看祖先：自己的 base 期限过了也不算（那圈紫齿轮的根因）', () => {
  const now = new Date('2026-03-10T12:00:00');
  // 上周建的每周日程：base 的期限早就过了（这就是误报的来源）
  const weekly = {
    id: 'w1', title: '每周阅读', start: '2026-03-02T15:32:00', end: '2026-03-03T15:32:00',
    recurrence: { freq: 'weekly', interval: 1, byDay: [1] },
  };
  // 它自己**确实**是过期的（base 期限在 3-03）——这正是"不能拿它当容器判据"的原因
  assert.equal(store.isOverdue(weekly, [weekly], now), true, 'base 判据本身是 true');
  assert.equal(store.inheritedOverdueOf(weekly, [weekly], now), false,
    '没有父级 → 不算"容器过期"（否则将来那颗会被画成紫齿轮）');

  // 真正的"母气泡过期"：父级过期，子级自己没到期 → `inheritedOverdueOf` 必须判 true
  const parent = { id: 'p1', title: '过期的母泡泡', start: '2026-03-01T09:00:00', end: '2026-03-02T09:00:00', level: 'red' };
  const child = { id: 'c1', title: '还没到期的子泡泡', start: '2026-03-20T09:00:00', end: '2026-03-20T10:00:00', parentId: 'p1' };
  // ⚠️ 注意 `isOverdue`（= core 的 isOverdueEvent）**含继承**：
  //    它在这里返回 true 是因为父级过期，不是因为子级自己到期了。
  //    所以它**不能**直接当"容器过期"的判据 —— 那正是紫齿轮误报的来源。
  assert.ok(store.remainingOf(child, now) > 0, '子级自己还剩好几天（自己没到期）');
  assert.equal(store.isOverdue(child, [parent, child], now), true, 'isOverdue 含继承 → true');
  assert.equal(store.inheritedOverdueOf(child, [parent, child], now), true, '父级过期 → 继承');
  assert.equal(store.inheritedOverdueOf(child, [child], now), false, '父级不在库里 → 不硬说它继承了');

  // 祖父过期也算（链上任意一层）
  const grand = { id: 'g1', title: '祖父', start: '2026-03-01T09:00:00', end: '2026-03-02T09:00:00', level: 'red' };
  const mid = { id: 'm1', title: '中间', start: '2026-03-20T09:00:00', end: '2026-03-20T10:00:00', parentId: 'g1' };
  const leaf = { id: 'l1', title: '叶子', start: '2026-03-21T09:00:00', end: '2026-03-21T10:00:00', parentId: 'm1' };
  assert.equal(store.inheritedOverdueOf(leaf, [grand, mid, leaf], now), true, '祖父过期 → 孙子也继承');

  // 谁都没过期 → false
  const p2 = { id: 'p2', title: '没过期的母泡泡', start: '2026-03-20T09:00:00', end: '2026-03-20T10:00:00', level: 'red' };
  const c2 = { id: 'c2', title: '子', start: '2026-03-21T09:00:00', end: '2026-03-21T10:00:00', parentId: 'p2' };
  assert.equal(store.inheritedOverdueOf(c2, [p2, c2], now), false);

  // 防环：脏数据里 parentId 成环也不能死循环
  const a = { id: 'a', title: 'A', start: '2026-03-01T09:00:00', end: '2026-03-02T09:00:00', parentId: 'b' };
  const b = { id: 'b', title: 'B', start: '2026-03-01T09:00:00', end: '2026-03-02T09:00:00', parentId: 'a' };
  assert.equal(typeof store.inheritedOverdueOf(a, [a, b], now), 'boolean', '成环也要能返回');
});
