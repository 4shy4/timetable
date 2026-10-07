// 删除一门课：`DELETE /api/courses/:key`（core 纯逻辑 + HTTP 路由 + web 接线）。
//
// 直接跑：`node --test tools/course-delete.test.mjs`
//
// ⚠️ 为什么这个套件值得单独存在（它盯的是**静默的数据损坏**，不是语法错）：
//   删课要同时做对四件事，做错任何一件都不会报错，只会表现成"用户觉得数据不对"：
//     ① 按 **key** 删，不是按标题 —— 库里 `大学物理B1(I)` 有 3 条（老师/节次/周次不同），
//        按标题删会一锅端；
//     ② **伴生事件**必须一起删 —— 课表格子/气泡/提醒全是从 `events` 读的，
//        只删 `courses` 里那一行的话，那节课照旧显示、照旧提醒（"我删了它还在"）；
//     ③ 匹配**不能过宽** —— 课程 key 是 `标题|星期|节次|老师|周次`，**自己就含 `|`**，
//        而且一门课的 key 可能是另一门课 key 的前缀（`物理` vs `物理|3|1,2||1,2`）；
//     ④ 必须记**墓碑**（既有范式：硬删 + 墓碑，见 core/state-ops.js 的 deleteCourse 注释），
//        否则下一次同步对端会把删掉的课**合回来**。
//   所以下面每个用例都对应上面一条，另外还钉住"删不存在的东西不许动任何数据"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// ⓪ 数据隔离 —— **必须放在任何 server import 之前**
//
// ⚠️ 这是刚修过的"测试污染真库"事故的同一道防线（见 tools/test-isolation.test.mjs）：
//    `server/paths.js` 在**模块加载那一刻**算出 DATA_DIR 常量，之后再设就晚了；
//    而静态 `import` 会被提升到文件顶部，所以下面只能用**动态** `await import`。
//    本套件会真的调 store.importCourses / store.deleteCourse（两者结尾都是 persist()），
//    不隔离就会往用户真实的 data/db.json 里写课、删课。
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'timetable-course-delete-'));
process.env.TIMETABLE_DATA_DIR = TEST_DATA_DIR;
process.on('exit', () => {
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

const ops = await import('../core/state-ops.js');
const { defaultDb } = await import('../core/defaults.js');
const sync = await import('../core/sync.js');
const store = await import('../server/store.js');
const { createRouter } = await import('../server/api.js');
const { DATA_DIR, DB_FILE } = await import('../server/paths.js');

// 立刻自证隔离生效 —— 不成立就必须当场停机（后面每一行写入都在动真实数据）
if (DATA_DIR !== path.resolve(TEST_DATA_DIR)) {
  throw new Error(`测试没有隔离数据目录：DATA_DIR=${DATA_DIR}，应当指向临时目录 —— 拒绝继续`);
}

// ---------------------------------------------------------------------------
// ① 夹具
//
// ⚠️ 主夹具刻意**照抄用户库里那条脏数据**（tools/import-stats.test.mjs 早前写进真库的
//    `大学物理`）：key = `大学物理|3|1,2||1,2`，含中文、含 `|`、含**空字段**。
//    它正是"删课最容易匹配错"的那种形状 —— 用真形状测，比用 `k1/k2` 有意义得多。
// ---------------------------------------------------------------------------
const T = (s) => new Date(s);
const AT = T('2026-09-27T03:28:56.923Z');

/** 一门课（字段与 core/state-ops.js 的 importCourses 一致） */
function course(key, title, extra = {}) {
  return { key, title, dayOfWeek: 3, sections: [1, 2], weeks: [1, 2], ...extra };
}

const META = {
  source: 'test',
  termStart: '2026-09-21',
  termWeeks: 16,
  sectionTimes: [
    { index: 1, start: '08:00', end: '08:45' },
    { index: 2, start: '08:50', end: '09:35' },
  ],
};

/** 这门课在事件里应当长什么样（生成规则见 state-ops.js：`course:${key}|${day}|${sections}`） */
const eventIdOf = (key, day = 3, sections = [1, 2]) => `course:${key}|${day}|${sections.join(',')}`;

/** 造一个干净库并导入若干门课 */
function dbWith(list, now = AT) {
  const db = defaultDb();
  ops.importCourses(db, { courses: list, meta: META }, now);
  return db;
}

/** 深拷贝（比较"其余记录逐字段不变"用） */
const clone = (v) => JSON.parse(JSON.stringify(v));

const byKey = (db, key) => db.courses.find((c) => c.key === key);
const eventIds = (db) => db.events.map((e) => e.id).sort();

/** 清空临时库并让 store 重新读一遍（每个 store 级用例都从零开始） */
function resetStore() {
  try { fs.rmSync(DB_FILE, { force: true }); } catch { /* ignore */ }
  store.resetForTests();
}

// ---------------------------------------------------------------------------
// ② core：纯函数层
// ---------------------------------------------------------------------------

test('归属判定 isCourseEventOf：精确前缀，空 key 不许匹配任何东西', () => {
  const KEY = '大学物理|3|1,2||1,2';
  assert.equal(ops.isCourseEventOf(eventIdOf(KEY), KEY), true);
  assert.equal(ops.isCourseEventOf({ id: eventIdOf(KEY) }, KEY), true);
  // 兜底：万一某条课事件没带 meeting 后缀，它同样属于这门课
  assert.equal(ops.isCourseEventOf(`course:${KEY}`, KEY), true);

  // 别的课一条都不许蹭上
  assert.equal(ops.isCourseEventOf(eventIdOf('大学物理B1(I)|3|3,4|朱杰|1,3,5'), KEY), false, '别的课的事件不该匹配');
  assert.equal(ops.isCourseEventOf('evt_abc', KEY), false, '非课事件不该匹配');
  assert.equal(ops.isCourseEventOf('', KEY), false);

  // ⚠️ 空 key 是最危险的一个输入：`course:` 是每一门课事件的前缀，
  //    判成 true 就等于"一次手滑清空整张课表"。
  assert.equal(ops.isCourseEventOf(eventIdOf(KEY), ''), false, '空 key 必须不匹配任何事件');
  assert.equal(ops.isCourseEventOf(eventIdOf(KEY), null), false);
  assert.equal(ops.isCourseEventOf(eventIdOf(KEY), undefined), false);
  // 前缀但**不是**同一门课（少了 `|` 分隔）→ 不算 —— 否则删 `物理` 会带走 `物理B1`
  assert.equal(ops.isCourseEventOf(eventIdOf('物理B1|3|1,2||1,2'), '物理'), false);
});

test('按 key 删课：courses 少 1，**伴生事件也一并消失**', () => {
  const KEY = '大学物理|3|1,2||1,2';
  const db = dbWith([course(KEY, '大学物理')]);
  assert.equal(db.courses.length, 1);
  assert.deepEqual(eventIds(db), [eventIdOf(KEY)], '导入后应当有一条课程事件');

  const out = ops.deleteCourse(db, KEY, AT);
  assert.equal(out.ok, true);
  assert.equal(out.key, KEY, '返回的 key 要原样（含 `|` 与中文）');
  assert.equal(out.title, '大学物理');
  assert.deepEqual(out.removedEvents, [eventIdOf(KEY)]);
  assert.equal(db.courses.length, 0, '课程记录要少 1');
  assert.equal(db.events.length, 0, '⭐ 伴生事件必须一起消失（否则课表/气泡里还显示它）');
});

test('删不存在的 key：明确报错（404「课程不存在」），且**一个字段都不动**', () => {
  const db = dbWith([course('k1', '留着的课')]);
  const before = JSON.stringify(db);

  assert.throws(
    () => ops.deleteCourse(db, '根本没有这门课', AT),
    (err) => {
      assert.equal(err.status, 404, '要沿用既有的 {status} 约定（api.js/main.js 依赖它）');
      assert.match(err.message, /课程不存在/, '报错要说清是"课程"，不能拿"日程不存在"糊弄');
      return true;
    },
  );

  // 深度对比：连 key 顺序、字段顺序都不许变（deleteCourse 若在 findByKey 之前
  // 就动了数组/墓碑，这里会红）
  assert.equal(JSON.stringify(db), before, '删不存在的课**不许**留下任何改动');
});

test('★ 只删目标课程：3 门课各带事件，删中间那门，其余两门与其事件**逐字段不变**', () => {
  const A = '高数A|1|1,2|张老师|1,2,3,4';
  const B = '大学物理|3|1,2||1,2';              // 中间那条（也就是用户库里那条脏数据）
  const C = '英语读写|5|3,4|李老师|1,2';

  const db = dbWith([course(A, '高数A', { dayOfWeek: 1 }), course(B, '大学物理'), course(C, '英语读写', { dayOfWeek: 5, sections: [3, 4] })]);
  // 再放一条**非课事件**：删课绝不能碰它
  ops.upsertEvent(db, { id: 'evt_keep', title: '我自己的事', start: '2026-09-23T20:00:00', end: '2026-09-23T21:00:00' }, AT);

  const aBefore = clone(byKey(db, A));
  const cBefore = clone(byKey(db, C));
  const aEventBefore = clone(db.events.find((e) => e.id === eventIdOf(A, 1)));
  const cEventBefore = clone(db.events.find((e) => e.id === eventIdOf(C, 5, [3, 4])));
  const keepBefore = clone(db.events.find((e) => e.id === 'evt_keep'));
  assert.ok(aEventBefore && cEventBefore, '夹具要先确认另外两门的事件都在');

  ops.deleteCourse(db, B, AT);

  assert.deepEqual(byKey(db, A), aBefore, 'A 的课程记录必须逐字段不变');
  assert.deepEqual(byKey(db, C), cBefore, 'C 的课程记录必须逐字段不变');
  assert.deepEqual(db.events.find((e) => e.id === eventIdOf(A, 1)), aEventBefore, 'A 的事件必须逐字段不变');
  assert.deepEqual(db.events.find((e) => e.id === eventIdOf(C, 5, [3, 4])), cEventBefore, 'C 的事件必须逐字段不变');
  assert.deepEqual(db.events.find((e) => e.id === 'evt_keep'), keepBefore, '普通事件必须逐字段不变');
  assert.equal(byKey(db, B), undefined, 'B 本身要被删掉');
  assert.deepEqual(eventIds(db), ['evt_keep', eventIdOf(A, 1), eventIdOf(C, 5, [3, 4])].sort(), '事件集合只剩另外两门 + 那条普通事件');
});

test('★ 前缀歧义：删短 key 不许带走"以它为前缀"的那门课', () => {
  // 真实会出现的形状：同一门课被手工补过一次信息 → `物理` 与 `物理|3|1,2||1,2` 并存。
  // 只按前缀判的话，删 `物理` 会把后者的事件一起删掉（那就是"匹配过宽把别人的课也删了"）。
  const SHORT = '物理';
  const LONG = '物理|3|1,2||1,2';
  const db = dbWith([course(SHORT, '物理'), course(LONG, '物理')]);

  const longBefore = clone(byKey(db, LONG));
  const longEvent = clone(db.events.find((e) => e.id === eventIdOf(LONG)));
  assert.ok(longEvent, '长 key 那门课的事件要在');

  ops.deleteCourse(db, SHORT, AT);

  assert.equal(byKey(db, SHORT), undefined, '短 key 那门要删掉');
  assert.deepEqual(byKey(db, LONG), longBefore, '长 key 那门课必须原封不动');
  assert.deepEqual(db.events.find((e) => e.id === eventIdOf(LONG)), longEvent, '长 key 的事件必须原封不动');
  assert.equal(db.events.length, 1);
});

test('回收语义 = 既有范式（硬删 + 墓碑），重新导入就能复活', () => {
  // ⚠️ 本项目的「回收站」是**戳破的泡泡**的账本（core/recycle.js / /api/recycle），
  //    和"删除"不是一回事；删除的既有范式就是 deleteEvent：splice + markDeleted 墓碑。
  //    所以课删除**没有**"移入回收站"这一说，可回滚性靠的是"幂等导入 + 撤销墓碑"。
  const KEY = '大学物理|3|1,2||1,2';
  const db = dbWith([course(KEY, '大学物理')]);

  ops.deleteCourse(db, KEY, AT);

  const graves = sync.tombstonesOf(db);
  assert.ok(graves.courses[KEY], '⭐ 课程的墓碑必须记下（同步时"我删了"和"对方没有"就靠它区分）');
  assert.equal(sync.graveCategory(graves.courses[KEY], 'courses'), 'courses', '课程墓碑的类别必须是 courses');
  assert.ok(graves.events[eventIdOf(KEY)], '事件的墓碑同样要记');
  assert.equal(sync.graveCategory(graves.events[eventIdOf(KEY)], 'events'), 'courses',
    '⭐ 课程事件的墓碑必须记成 categories=courses，否则"只同步课表"时会漏发/误发');

  // 复活（= 用户"删错了"的退路）：重新导入同一份课表
  ops.importCourses(db, { courses: [course(KEY, '大学物理')], meta: META }, T('2026-09-28T00:00:00'));
  assert.equal(db.courses.length, 1, '重新导入要把课加回来');
  assert.deepEqual(eventIds(db), [eventIdOf(KEY)], '课程事件也要回来');
  assert.equal(sync.tombstonesOf(db).courses[KEY], undefined,
    '⭐ 复活后课程墓碑必须撤销 —— 否则下一次同步对端会按墓碑把它再删一次');
});

test('★ 删课能传播：A 删掉的课，同步后 B 也没有了（墓碑起作用）', () => {
  const KEY = '大学物理|3|1,2||1,2';
  const a = dbWith([course(KEY, '大学物理')]);
  const b = defaultDb();

  const syncTwo = () => {
    const merged = sync.mergeSync(sync.syncPayloadOf(a, null), sync.syncPayloadOf(b, null));
    sync.applySync(a, merged, null);
    sync.applySync(b, merged, null);
  };

  syncTwo();
  assert.equal(b.courses.length, 1, '先同步成两边都有');
  assert.equal(b.events.length, 1);

  ops.deleteCourse(a, KEY, T('2026-09-28T00:00:00'));
  syncTwo();

  assert.equal(a.courses.length, 0);
  assert.equal(b.courses.length, 0, '⭐ B 那边也必须没了 —— 没有墓碑的话这里会被合回来');
  assert.equal(b.events.length, 0, '⭐ B 的课程事件也要一起没（否则 B 的课表上还留着那节课）');
});

// ---------------------------------------------------------------------------
// ③ server + HTTP：真起一个进程内服务，走**真实的 URL 编码**
//
// 为什么非要起 HTTP：课程 key 里同时有中文、`|`、逗号、空段、还可能有一个 `%`，
// 编解码链路（encodeURIComponent → Node 的 req.url → decodeURIComponent）只有
// 真发一次请求才能验。直接调 core 是验不出"路由把 key 解坏了"这类问题的。
// ---------------------------------------------------------------------------

const route = createRouter();

/**
 * ⚠️ 必须自己包这层 handler：`createRouter()` 返回的是 `(req, res, url)` **三**参数，
 *    而 `http.createServer(route)` 只给两个 —— 少一个的后果是每个请求都挂到超时
 *    （ai-key-mask.test.mjs / ai-proxy.test.mjs 里都踩过）。
 *    这里顺便把 main.js 里那段 catch（`err.status → 状态码`）照搬过来，
 *    否则测不到"业务错误翻成 404"这一步。
 */
function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  Promise.resolve()
    .then(() => route(req, res, url))
    .catch((err) => {
      if (res.headersSent) return;
      res.writeHead(err.status || 500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
}

const srv = http.createServer(handle);
await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${srv.address().port}`;
srv.on('clientError', () => {});
srv.on('error', () => {});

test.after(() => {
  srv.closeAllConnections?.();   // 排空 keep-alive，否则 close() 要等几秒
  srv.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

/** 发一次 DELETE（key 由调用方决定是否编码） */
async function del(pathAfterCourses) {
  const res = await fetch(`${BASE}/api/courses/${pathAfterCourses}`, { method: 'DELETE' });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { res, status: res.status, body, text };
}

test('★ DELETE 路由：含 `|`/中文/空格/`%` 的 key 编码往返，删完课程与事件都没了', async () => {
  resetStore();
  // `%` 是这里的关键一条：合法编码里它是 `%25`，**解码两次**的实现会把它弄坏
  // （症状：回「课程不存在」，而库里明明有这门课）。
  const KEY = '运筹学 导论|2|3,4|王 老师|1,3,5 %';
  store.importCourses({ courses: [course(KEY, '运筹学 导论', { dayOfWeek: 2, sections: [3, 4], weeks: [1, 3, 5] })], meta: META });

  const encoded = encodeURIComponent(KEY);
  assert.notEqual(encoded, KEY, '这个 key 本来就该被编码（否则这条测试没意义）');
  assert.ok(encoded.includes('%7C'), '`|` 要编成 %7C');
  assert.equal(decodeURIComponent(encoded), KEY, '编码往返本身要恒等');

  assert.equal(store.getState().courses.length, 1);

  const ok = await del(encoded);
  assert.equal(ok.status, 200, `删除应当 200，实际 ${ok.status} ${ok.text}`);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.key, KEY, '⭐ 服务端解出来的 key 必须和原文一模一样（错一个字符就删错课）');
  assert.equal(ok.body.title, '运筹学 导论');
  assert.deepEqual(ok.body.removedEvents, [eventIdOf(KEY, 2, [3, 4])]);

  const st = store.getState();
  assert.equal(st.courses.length, 0, '课程要少 1');
  assert.equal(st.events.length, 0, '伴生事件要一起没了');

  // 走 HTTP 再确认一遍（不是只看内存）
  const list = await (await fetch(`${BASE}/api/courses`)).json();
  assert.deepEqual(list.courses, [], 'GET /api/courses 也要看到它没了');
});

test('DELETE 路由的错误码：404 课程不存在 / 400 空 key / 400 编码非法，且都不改数据', async () => {
  resetStore();
  const KEY = '大学物理|3|1,2||1,2';
  store.importCourses({ courses: [course(KEY, '大学物理')], meta: META });
  const revBefore = store.getState().rev;
  const snapBefore = JSON.stringify(store.getState());

  // ① 不存在的 key → 404 + 中文原因
  const miss = await del(encodeURIComponent('根本没有这门课'));
  assert.equal(miss.status, 404);
  assert.match(miss.body.error || '', /课程不存在/);

  // ② 空 key（`DELETE /api/courses/`）→ 400
  const empty = await del('');
  assert.equal(empty.status, 400);
  assert.match(empty.body.error || '', /缺少课程 key/);

  // ③ 非法百分号序列 → 400（不接住的话 decodeURIComponent 抛 URIError → 500，
  //    而真正的原因是"key 编得不对"，报 500 会把排查方向带偏）
  const bad = await del('%E4%B8');
  assert.equal(bad.status, 400);
  assert.match(bad.body.error || '', /编码/);

  // ④ 三次失败都不许碰到数据（rev 不动 = persist() 根本没跑）
  assert.equal(store.getState().rev, revBefore, '失败路径不许写盘（rev 变了就说明 persist 跑了）');
  assert.equal(JSON.stringify(store.getState()), snapBefore, '失败路径不许改任何字段');

  // ⑤ 顺带确认别的路由没被这条新路由抢走：GET /api/courses 照旧
  const res = await fetch(`${BASE}/api/courses`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).courses.length, 1);

  // ⑥ 也确认「删两次」第二次是 404（幂等语义：不假装成功）
  assert.equal((await del(encodeURIComponent(KEY))).status, 200);
  assert.equal((await del(encodeURIComponent(KEY))).status, 404);
});

test('store 层：删课走 persist（rev +1），删不存在的课不动 rev', () => {
  resetStore();
  const KEY = '大学物理|3|1,2||1,2';
  store.importCourses({ courses: [course(KEY, '大学物理')], meta: META });

  const revBefore = store.getState().rev;
  const out = store.deleteCourse(KEY);
  assert.equal(out.ok, true);
  assert.ok(store.getState().rev > revBefore, '⭐ 必须走 persist()（rev 要涨），否则重启就回来了');

  const revAfterDelete = store.getState().rev;
  assert.throws(() => store.deleteCourse(KEY), /课程不存在/);
  assert.equal(store.getState().rev, revAfterDelete, '删不存在的课不许 persist');
});

// ---------------------------------------------------------------------------
// ③′ 离线（outbox）：服务不可达时删课要能入队，并在刷新后**盖回** state
//
// ⚠️ 这一段为什么不放在真浏览器里测（tools/outbox.test.mjs 是 CDP + Edge 那套）：
//    这里整条链路（enqueue → replay 发 DELETE → applyToState 摘掉课程和伴生事件）
//    都是纯 JS，Node 里给 localStorage 和 fetch 两个桩就能验 ——
//    而真浏览器那套依赖本机 Edge/CDP，跑不起来时它自己会先炸（与本改动无关）。
//    漏测这一段的具体后果：离线删了课 → 一刷新**课又回来了**（`refresh()` 用服务端
//    数据整体替换 state，而服务端还不知道你删过），用户会以为"删除没保存上"。
// ---------------------------------------------------------------------------

test('离线：删课入队 → 补发走 DELETE → 刷新后课程与伴生事件一起被盖掉', async () => {
  // localStorage 桩：outbox 的队列就存在里面。
  // ⚠️ 用 defineProperty 而不是直接赋值：较新的 Node 里 `localStorage` 可能是
  //    只读的全局属性，而 ESM 是严格模式 —— 直接赋值会抛 TypeError。
  const mem = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: (k) => { mem.delete(k); },
    },
  });

  const outbox = await import('../web/adapter/outbox.js');
  const KEY = '大学物理|3|1,2||1,2';
  const EV = eventIdOf(KEY);
  outbox.clearQueue();
  outbox.enqueue({ kind: 'deleteCourse', key: KEY });

  // ① 刷新（refresh → applyToState）不许让删掉的课"又回来"
  const after = outbox.applyToState({
    settings: {}, rev: 1,
    courses: [{ key: KEY, title: '大学物理' }, { key: 'k2', title: '别的课' }],
    events: [{ id: EV, type: 'course' }, { id: eventIdOf('k2'), type: 'course' }, { id: 'evt_keep' }],
  });
  assert.deepEqual(after.courses.map((c) => c.key), ['k2'], '离线删的课不许被服务端数据盖回来');
  assert.deepEqual(after.events.map((e) => e.id).sort(), [eventIdOf('k2'), 'evt_keep'].sort(),
    '它的伴生事件同样不许回来');

  // ② 补发：必须真发一条 `DELETE /api/courses/<encodeURIComponent(key)>`
  let seen = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    seen = { url: String(url), method: (opts && opts.method) || 'GET' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, key: KEY }) };
  };
  try {
    const r = await outbox.replay();
    assert.equal(r.failed, 0, `补发不该失败：${JSON.stringify(r)}`);
    assert.equal(outbox.queueLength(), 0, '补发成功就要出队');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(seen, '补发必须真的发一次请求（不能只在本地改改）');
  assert.equal(seen.method, 'DELETE');
  assert.match(seen.url, /^\/api\/courses\//, `路径形状不对：${seen.url}`);
  assert.equal(decodeURIComponent(seen.url.slice('/api/courses/'.length)), KEY,
    '⭐ key 必须编码往返一致（漏了 encodeURIComponent 服务端就会回"课程不存在"）');
});

// ---------------------------------------------------------------------------
// ④ web 接线（源码级守卫）
//
// 界面没法在 Node 里真点（视图要 DOM + fetch），但"按钮有没有接上正确的适配器方法、
// 有没有用**既有的**确认弹窗"是能静态钉住的 —— 漏了任何一环，用户看到的就是
// "点了没反应"或者"删了但界面没变"。
// ---------------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readWeb = (rel) => fs.readFileSync(path.join(ROOT, 'web', rel), 'utf8');

test('web 接线：适配器（remote/local）+ store + 视图都接上了', () => {
  const api = readWeb('adapter/api.js');
  assert.match(api, /deleteCourse:\s*\(key\)\s*=>\s*request\('DELETE',\s*`\/api\/courses\/\$\{encodeURIComponent\(key\)\}`\)/,
    'adapter/api.js 里的路径必须 encodeURIComponent（key 含 `|`/中文）');

  const local = readWeb('adapter/api-local.js');
  assert.match(local, /deleteCourse:\s*\(key\)\s*=>\s*mutate\(\(db\)\s*=>\s*ops\.deleteCourse\(db,\s*key\)\)/,
    '本地模式必须也有 deleteCourse（形状一致 ⇒ 上层零改动）');

  const st = readWeb('adapter/store.js');
  assert.match(st, /export async function deleteCourse/, 'store.js 要导出 deleteCourse');
  assert.match(st, /isCourseEventOf/, 'store 的乐观更新必须用 core 的归属判定，别自己写前缀匹配');

  const outbox = readWeb('adapter/outbox.js');
  assert.match(outbox, /case 'deleteCourse':/, '离线队列要认得 deleteCourse（否则补发时抛"未知的离线操作"）');
  assert.match(outbox, /op\.kind === 'deleteCourse'/, '离线期间删的课要能盖回 state（不然刷新又回来了）');

  const view = readWeb('ui/views/course.js');
  assert.match(view, /store\.deleteCourse\(/, '课程视图要真的调用它');
  assert.match(view, /confirmDialog\(\{/, '必须用既有的 confirmDialog 做二次确认（别自己写弹窗）');
  assert.match(view, /openModal\(\{/, '清单用既有的 openModal');
  assert.ok(!/modal-mask/.test(view), '不许自己拼一个 modal 遮罩');

  // ⚠️ 视图 import 的 core API **名字要真的存在** —— 写错名字不会当场报错，
  //    只会在真机上"点了没反应"（本项目栽过三次的那类故障）。
  assert.equal(typeof ops.isCourseEventOf, 'function', 'core 里要真的有 isCourseEventOf');
  assert.equal(typeof ops.deleteCourse, 'function', 'core 里要真的有 deleteCourse');

  // CSS 类名同理：拼错了不会报错，只会让弹窗里那些行挤成一坨。
  const css = readWeb('css/views.css');
  for (const cls of ['.course-del-list', '.course-del-row', '.cdr-main', '.cdr-title', '.cdr-meta']) {
    assert.ok(css.includes(cls), `views.css 里缺少 ${cls}（课程删除清单的样式）`);
  }
});
