// 「本地模式」的单元测试（4b）。
//
// 为什么需要一个 IndexedDB shim：
//   Node 里**没有** IndexedDB，而 idb.js 就靠它。没有 shim 的话这条链路只能靠
//   真 Chrome 跑 —— 那样每次调业务接线都要起浏览器，太慢。
//   `web/adapter/idb.js` 用到的 IndexedDB 表面**很窄**（open / transaction /
//   objectStore.get|put|delete / oncomplete），所以 shim 只有几十行。
//
// ⚠️ shim 只保证"idb.js 用到的那个子集"行为一致，**不能**替代真浏览器验证。
//    真正要确认"iPad 上确实存下来了"，还得在真 Safari/Chrome 里跑一次。
//    但**业务接线**（哪个操作有没有落盘、设置有没有被嵌套合并、戳破是不是按实例记账）
//    在这里能测得很透，而那些才是最容易写错的地方。

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 极简 IndexedDB shim（只实现 idb.js 用到的子集）
// ---------------------------------------------------------------------------
function installIdbShim() {
  const stores = new Map();          // storeName -> Map(key -> value)
  const storeOf = (n) => {
    if (!stores.has(n)) stores.set(n, new Map());
    return stores.get(n);
  };

  function makeDb() {
    const nameList = { contains: (n) => stores.has(n) };
    return {
      objectStoreNames: nameList,
      createObjectStore(n) { storeOf(n); return { name: n }; },
      transaction(storeName) {
        const data = storeOf(storeName);
        const t = { _pending: 0, _done: false };
        const finish = () => { if (t._done && t._pending === 0 && t.oncomplete) t.oncomplete(); };
        /** 一个请求：结果异步给出，并且让事务知道"还有一个请求没结束" */
        const track = (run) => {
          t._pending += 1;
          const r = {};
          setTimeout(() => {
            try {
              r.result = run();
              if (r.onsuccess) r.onsuccess();
            } catch (err) {
              r.error = err;
              if (r.onerror) r.onerror();
            } finally {
              t._pending -= 1;
              finish();
            }
          }, 0);
          return r;
        };
        t.objectStore = () => ({
          get: (k) => track(() => data.get(k)),
          put: (v, k) => track(() => { data.set(k, v); return k; }),
          delete: (k) => track(() => { data.delete(k); return undefined; }),
        });
        // 事务体（同步那段）跑完了；等排队的请求都结束再 oncomplete
        setTimeout(() => { t._done = true; finish(); }, 2);
        return t;
      },
    };
  }

  globalThis.indexedDB = {
    open() {
      const req = {};
      setTimeout(() => {
        const db = makeDb();
        // ⚠️ 真 IndexedDB 在 `onupgradeneeded` **期间**就能读 `request.result`，
        //    所以必须先赋值再回调 —— 反过来（先回调后赋值）会报
        //    "Cannot read properties of undefined (reading 'objectStoreNames')"。
        req.result = db;
        if (!stores.has('kv') && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);
      return req;
    },
  };
  return {
    stores,
    /** 模拟"关掉应用再打开"：清掉连接缓存，数据仍在 stores 里 */
    uninstall() { delete globalThis.indexedDB; },
  };
}

const shim = installIdbShim();

// 必须在装好 shim 之后再 import
const { localApi } = await import('../web/adapter/api-local.js');
const { _resetConnection } = await import('../web/adapter/idb.js');
const { api, setApiMode, getApiMode } = await import('../web/adapter/api.js');
const { defaultDb } = await import('../core/defaults.js');

/** 每次测试前清空本地库 */
async function reset() {
  shim.stores.clear();
  _resetConnection();
  await localApi.wipe();
}

// ---------------------------------------------------------------------------

test('本地模式：首次打开得到一份和服务端同形状的空库', async () => {
  await reset();
  const st = await localApi.state();
  const server = defaultDb();
  // ⚠️ 这个形状清单要和服务端 /api/state 回的**逐字一致**（含闹钟）：
  //    少一个键 = 那一类数据在 iPad 本地模式下永远读不出来
  //    （数据其实写进去了，只是回不出去 —— 表现成"我明明存了，怎么没了"）。
  assert.deepEqual(Object.keys(st).sort(), ['alarms', 'courses', 'events', 'rev', 'settings']);
  // 服务端缺省库也要有 alarms（core/defaults.js 里登记的那一份）——
  // ⚠️ 这条断言守的是"两边形状分叉"：本地有、服务端没有（或反过来），
  //    就会有一个端读不到闹钟，而数据其实好好躺在库里。
  assert.deepEqual(server.alarms, [], 'core/defaults.js 的缺省库要有 alarms: []');
  assert.deepEqual(Object.keys(st.settings).sort(), Object.keys(server.settings).sort(),
    '本地库的 settings 必须和服务端缺省同形状，否则界面某处会读到 undefined');
  assert.ok(st.settings.courseDigest, 'courseDigest 这个嵌套项最容易漏（曾经整个设置页显示不出来）');
  assert.deepEqual(st.events, []);
  assert.deepEqual(st.courses, []);
  assert.deepEqual(st.alarms, [], '闹钟也要有这个键（闹钟视图读 state.alarms.length）');
});

test('本地模式：新建日程 → 落盘 → 重新读还在（模拟关掉应用再打开）', async () => {
  await reset();
  const saved = await localApi.saveEvent({
    title: '本地模式的日程', start: '2026-03-02T09:00:00', end: '2026-03-02T10:00:00',
  });
  assert.ok(saved.id, '要返回 id');
  assert.equal(saved.title, '本地模式的日程');

  // 模拟"关掉应用再打开"：清连接缓存，数据应当从存储里读回来
  _resetConnection();
  const st = await localApi.state();
  assert.equal(st.events.length, 1);
  assert.equal(st.events[0].title, '本地模式的日程');
  assert.equal(st.events[0].id, saved.id);
});

test('本地模式：修改 / 删除日程', async () => {
  await reset();
  const ev = await localApi.saveEvent({ title: '改我', start: '2026-03-02T09:00:00' });
  await localApi.patchEvent(ev.id, { title: '改过了', level: 'amber' });
  let st = await localApi.state();
  assert.equal(st.events[0].title, '改过了');
  assert.equal(st.events[0].level, 'amber');

  await localApi.deleteEvent(ev.id);
  st = await localApi.state();
  assert.equal(st.events.length, 0);
});

test('本地模式：戳破按**实例**记账（重复事件只结束这一颗）', async () => {
  await reset();
  const ev = await localApi.saveEvent({
    title: '每周跑步', start: '2026-03-02T07:00:00', end: '2026-03-02T07:30:00',
    recurrence: { freq: 'weekly', byDay: [1] },
  });
  // 只戳破 3/2 那一颗
  const out = await localApi.popEvent(ev.id, { occurrence: '2026-03-02T07:00:00', remainingMs: -3600_000 });
  assert.equal(out.mode, 'instance', '重复事件必须走"按实例记账"');
  const st = await localApi.state();
  const saved = st.events.find((e) => e.id === ev.id);
  assert.ok(saved.popped['2026-03-02'], '那一颗要记进 popped');
  assert.notEqual(saved.done, true, '整条重复不该被结束');

  // 回收站里能看到，且带"提前/拖延"的剩余时间
  const rec = await localApi.recycle();
  assert.equal(rec.items.length, 1);
  assert.equal(rec.items[0].count, 1);
  assert.equal(rec.items[0].entries[0].remainingMs, -3600_000);
});

test('本地模式：还原一颗 / 全部', async () => {
  await reset();
  const ev = await localApi.saveEvent({
    title: '还原测试', start: '2026-03-02T07:00:00',
    recurrence: { freq: 'weekly', byDay: [1] },
  });
  await localApi.popEvent(ev.id, { occurrence: '2026-03-02T07:00:00' });
  await localApi.popEvent(ev.id, { occurrence: '2026-03-09T07:00:00' });
  let st = await localApi.state();
  assert.equal(Object.keys(st.events[0].popped).length, 2);

  await localApi.restorePopped(ev.id, { occurrence: '2026-03-02T07:00:00' });
  st = await localApi.state();
  assert.deepEqual(Object.keys(st.events[0].popped), ['2026-03-09']);

  await localApi.restorePopped(ev.id, {});
  st = await localApi.state();
  assert.deepEqual(Object.keys(st.events[0].popped), []);
});

test('本地模式：改设置时 notify 要嵌套合并（不能把别的开关抹掉）', async () => {
  await reset();
  await localApi.settings({ notify: { intensity: 4 } });
  let st = await localApi.state();
  assert.equal(st.settings.notify.intensity, 4);
  assert.equal(st.settings.notify.desktop, true, '只改 intensity 不该影响 desktop');
  assert.equal(st.settings.notify.browser, true);
  assert.equal(st.settings.notify.sound, true);

  await localApi.settings({ notify: { desktop: false } });
  st = await localApi.state();
  assert.equal(st.settings.notify.desktop, false);
  assert.equal(st.settings.notify.intensity, 4, '反过来也一样：intensity 要留着');
});

test('本地模式：课表导入是幂等的（重复导入不翻倍）', async () => {
  await reset();
  const payload = {
    courses: [{
      key: 'k1', title: '高等数学', dayOfWeek: 1, sections: [1, 2], weeks: [1, 2, 3, 4],
      location: '北101', teacher: '黄老师',
    }],
    meta: { source: 'test', termStart: '2026-03-02', termWeeks: 16, sectionTimes: [{ index: 1, start: '08:00', end: '08:45' }, { index: 2, start: '08:50', end: '09:35' }] },
    mode: 'merge',
  };
  const r1 = await localApi.importCourses(payload);
  assert.equal(r1.added, 1);
  assert.equal(r1.total, 1);

  const r2 = await localApi.importCourses(payload);
  assert.equal(r2.added, 0, '第二次导入不该新增');
  const st = await localApi.state();
  assert.equal(st.courses.length, 1);
  assert.equal(st.events.filter((e) => e.type === 'course').length, 1);
  // 节次范围要按**最后一节**算（1-2 节 → 08:00–09:35），并保留 sections
  const ce = st.events.find((e) => e.type === 'course');
  assert.equal(ce.start.slice(11, 16), '08:00');
  assert.equal(ce.end.slice(11, 16), '09:35');
  assert.deepEqual(ce.sections, [1, 2]);
});

test('本地模式：清空（可保留课程）', async () => {
  await reset();
  await localApi.importCourses({
    courses: [{ key: 'k', title: '课', dayOfWeek: 1, sections: [1], weeks: [1] }],
    meta: { source: 't', termStart: '2026-03-02' },
  });
  await localApi.saveEvent({ title: '日程', start: '2026-03-02T09:00:00' });

  const r = await localApi.clearEvents(true);
  assert.equal(r.removed, 1);
  const st = await localApi.state();
  assert.ok(st.events.every((e) => e.type === 'course'), '保留课程时只删非课程');
  assert.equal(st.courses.length, 1, '课程记录要留着');
});

test('本地模式：备份导出 → 恢复（跨设备迁移的路子）', async () => {
  await reset();
  await localApi.saveEvent({ title: '要备份的', start: '2026-03-02T09:00:00' });
  const dump = await localApi.exportAll();
  assert.equal(dump.events.length, 1);

  await localApi.clearEvents(false);
  assert.equal((await localApi.state()).events.length, 0);

  const back = await localApi.restore(dump);
  assert.equal(back.events, 1);
  const st = await localApi.state();
  assert.equal(st.events[0].title, '要备份的');
});

test('本地模式：在线拉取课表给出**明确**报错，不静默失败', async () => {
  await reset();
  // 「本地模式下做不到」和「操作失败」必须区分得开：
  // 静默返回空课表会让用户以为"课表导进来了但没显示"。
  for (const m of ['meta', 'majors', 'courses', 'import']) {
    await assert.rejects(
      async () => { await localApi.tj[m](); },
      (err) => {
        assert.equal(err.offlineUnsupported, true, `${m} 应当标 offlineUnsupported`);
        assert.match(err.message, /需要连着电脑/, `${m} 的报错要说人话`);
        return true;
      },
    );
  }
});


// ---------------------------------------------------------------------------
// 模式切换：上层（store.js）不该感觉到差别
// ---------------------------------------------------------------------------

test('模式切换：默认 remote（不能把既有用户的数据变空）', () => {
  setApiMode('remote');
  assert.equal(getApiMode(), 'remote');
});

test('模式切换：切到 local 后，api.saveEvent 落到本地库', async () => {
  await reset();
  try {
    setApiMode('local');
    assert.equal(getApiMode(), 'local');
    assert.equal(await api.backupUrl(), '', '本地模式没有服务端备份 URL');

    const ev = await api.saveEvent({ title: '走 api 的本地写入', start: '2026-03-02T09:00:00' });
    assert.ok(ev.id);

    // 确认真的落到了本地库（而不是发了个 404 被忽略）
    _resetConnection();
    const st = await localApi.state();
    assert.equal(st.events.length, 1);
    assert.equal(st.events[0].title, '走 api 的本地写入');

    // 经由 api 读回来也要一致 —— 证明"形状一致 ⇒ 上层零改动"这个前提成立
    const viaApi = await api.state();
    assert.equal(viaApi.events.length, 1);
    const health = await api.health();
    assert.equal(health.mode, 'local');
  } finally {
    setApiMode('remote');
  }
});

test('模式切换：切回 remote 后不再碰本地库', async () => {
  await reset();
  setApiMode('local');
  await api.saveEvent({ title: '只该在本地', start: '2026-03-02T09:00:00' });
  setApiMode('remote');
  assert.equal(getApiMode(), 'remote');
  // remote 的 backupUrl 是服务端路径，说明确实换回了远程实现
  assert.equal(api.backupUrl(), '/api/backup');
  // 本地库里的那条还在（没被清掉）
  _resetConnection();
  assert.equal((await localApi.state()).events.length, 1);
});

// ---------------------------------------------------------------------------
// 同步编排（4c）：本机 ↔ 电脑
//
// 用一个**假的对端**来测 —— 它逐字照抄服务端 `/api/sync` 的做法
// （`filterPayload` → `mergeSync` → `applySync`），所以测到的顺序和真的一样，
// 只是不用起 HTTP。真正的跨进程验证在 tools/local-browser.test.mjs 里。
// ---------------------------------------------------------------------------

const { runSync } = await import('../web/adapter/sync.js');
const coreSync = await import('../core/sync.js');
const { defaultDb: freshDb } = await import('../core/defaults.js');

/** 假电脑：行为和 server/main.js 的 /api/sync 一致 */
function fakePc(pcDb, filter) {
  return {
    async push(payload) {
      const safe = coreSync.filterPayload(payload, filter);
      const merged = coreSync.mergeSync(coreSync.syncPayloadOf(pcDb, filter), safe);
      coreSync.applySync(pcDb, merged, filter);
      return merged;
    },
    async reachable() { return true; },
  };
}

async function localDbNow() { _resetConnection(); return localApi.state(); }

test('同步：两边各自新增的日程，同步后都有了', async () => {
  await reset();
  const pc = freshDb();
  // 电脑上有一条
  await import('../core/state-ops.js').then((ops) => {
    ops.upsertEvent(pc, { id: 'pc1', title: '电脑上的', start: '2026-03-02T09:00:00', end: '2026-03-02T10:00:00', updatedAt: '2026-03-02T00:00:00.000Z' });
  });
  setApiMode('local');
  try {
    // 本机加一条
    await localApi.saveEvent({ id: 'ipad1', title: 'iPad 上的', start: '2026-03-03T09:00:00', end: '2026-03-03T10:00:00' });

    const r = await runSync({ peer: fakePc(pc, null) });
    assert.equal(r.ok, true);
    // 电脑那边两条都要有
    assert.deepEqual(pc.events.map((e) => e.id).sort(), ['ipad1', 'pc1']);
    // 本机这边也要有两条
    const st = await localDbNow();
    assert.deepEqual(st.events.map((e) => e.id).sort(), ['ipad1', 'pc1']);
  } finally { setApiMode('remote'); }
});

test('★ 同步：本机删掉的，同步后电脑上也没了（墓碑生效）', async () => {
  await reset();
  const pc = freshDb();
  const ops = await import('../core/state-ops.js');
  ops.upsertEvent(pc, { id: 'x1', title: '两台都有的', start: '2026-03-02T09:00:00', end: '2026-03-02T10:00:00', updatedAt: '2026-03-02T00:00:00.000Z' });
  setApiMode('local');
  try {
    // 先把电脑那条同步到本机
    await runSync({ peer: fakePc(pc, null) });
    assert.equal((await localDbNow()).events.length, 1);

    // 本机删掉它 → 再同步
    await localApi.deleteEvent('x1');
    await runSync({ peer: fakePc(pc, null) });

    assert.equal(pc.events.length, 0, '电脑那边也必须没了（这就是墓碑的作用）');
    assert.equal((await localDbNow()).events.length, 0);
  } finally { setApiMode('remote'); }
});

test('★ 同步：白名单"只同步课表"时，气泡各管各的', async () => {
  await reset();
  const pc = freshDb();
  const ops = await import('../core/state-ops.js');
  ops.upsertEvent(pc, { id: 'pc-bubble', title: '电脑的气泡', start: '2026-03-02T09:00:00', end: '2026-03-02T10:00:00' });
  ops.importCourses(pc, {
    courses: [{ key: 'k1', title: '电脑导入的课', dayOfWeek: 1, sections: [1], weeks: [1], importedAt: '2026-03-02T00:00:00.000Z' }],
    meta: { source: 't', termStart: '2026-03-02' },
  });
  const onlyCourses = { mode: 'whitelist', categories: ['courses'] };

  setApiMode('local');
  try {
    await localApi.saveEvent({ id: 'ipad-bubble', title: 'iPad 的气泡', start: '2026-03-04T09:00:00', end: '2026-03-04T10:00:00' });
    await runSync({ filter: onlyCourses, peer: fakePc(pc, onlyCourses) });

    // 课表同步过来了
    assert.equal((await localDbNow()).courses.length, 1, '课表要过来');
    assert.equal(pc.courses.length, 1);
    // 气泡两边各管各的
    const st = await localDbNow();
    assert.ok(st.events.some((e) => e.id === 'ipad-bubble'), 'iPad 的气泡还在');
    assert.ok(!st.events.some((e) => e.id === 'pc-bubble'), '电脑的气泡不该被拉过来');
    assert.ok(pc.events.some((e) => e.id === 'pc-bubble'), '电脑的气泡还在');
    assert.ok(!pc.events.some((e) => e.id === 'ipad-bubble'), 'iPad 的气泡不该推过去');
  } finally { setApiMode('remote'); }
});

test('同步：对端不可达时报错说人话（不静默假装成功）', async () => {
  await reset();
  setApiMode('local');
  try {
    await assert.rejects(
      () => runSync({ peer: { push: async () => { throw new Error('电脑不在'); } } }),
      /电脑不在/,
    );
  } finally { setApiMode('remote'); }
});

test('同步：连跑两次是幂等的', async () => {
  await reset();
  const pc = freshDb();
  const ops = await import('../core/state-ops.js');
  ops.upsertEvent(pc, { id: 'p1', title: 'P', start: '2026-03-02T09:00:00', end: '2026-03-02T10:00:00' });
  setApiMode('local');
  try {
    await localApi.saveEvent({ id: 'l1', title: 'L', start: '2026-03-03T09:00:00', end: '2026-03-03T10:00:00' });
    await runSync({ peer: fakePc(pc, null) });
    const a = (await localDbNow()).events.map((e) => e.id).sort();
    const b = pc.events.map((e) => e.id).sort();
    await runSync({ peer: fakePc(pc, null) });
    assert.deepEqual((await localDbNow()).events.map((e) => e.id).sort(), a, '本机不该变');
    assert.deepEqual(pc.events.map((e) => e.id).sort(), b, '电脑不该变');
  } finally { setApiMode('remote'); }
});
