// 「本地模式」的 api 实现 —— 与 `api.js`（remote）**接口形状完全一致**。
//
// 这是 4b 的核心，也是 4a 存在的理由：
//   `adapter/store.js` 只认 `api` 这个对象上的方法，不关心数据是从网络来还是从本地来。
//   所以只要下面的方法名/签名/返回结构与 `api.js` 对齐，
//   **store.js 一行都不用改**，本地模式就能直接跑起来（气泡区、编辑器、课表全部就地可用）。
//
// 业务逻辑一律调 `core/state-ops.js` —— 和服务端**同一份**，不会两端分叉。
//
// 能力边界（哪些能在本地做、哪些不能）：
//   ✅ 日程增删改、戳破/还原、回收站、设置、课表导入（文件/粘贴）、备份恢复、清空
//   ⚠️ `net` / `qr` / `healthUrl` / `backupUrl` 是"接入电脑"相关的东西，
//      本地模式下没有意义，给一个说明性的占位，不抛错（界面会用到）。

import * as ops from '../../core/state-ops.js';
import { loadDb, saveDb, clearDb } from './idb.js';

/** 每次写操作：读 → 改 → 写 → 返回。整份读写保证不会半截 */
async function mutate(fn) {
  const db = await loadDb();
  const out = fn(db);
  await saveDb(db);
  return out;
}

/**
 */
function snapshot(db) {
  return {
    rev: Number(db.rev) || 0,
    settings: db.settings,
    events: db.events || [],
    courses: db.courses || [],
    // ⚠️ 闹钟**必须**在这里回出去（和 server/store.js 的 getState 一一对应）：
    //    漏了它，iPad 本地模式下闹钟列表永远是空的 —— 而数据其实好好躺在
    //    IndexedDB 里（写进去了、读不出来）。这种"看着像没保存"的 bug 最气人。
    alarms: Array.isArray(db.alarms) ? db.alarms : [],
  };
}

const NOT_LOCAL = (what) => Object.assign(
  new Error(`${what}需要连着电脑才能用（本机离线模式做不到）`),
  { status: 400, offlineUnsupported: true },
);

export const localApi = {
  // ---- 健康 / 状态 ----
  health: async () => {
    const db = await loadDb();
    return {
      ok: true,
      mode: 'local',
      name: 'timetable',
      rev: Number(db.rev) || 0,
      events: (db.events || []).length,
      courses: (db.courses || []).length,
      serverTime: new Date().toISOString(),
    };
  },
  state: async () => snapshot(await loadDb()),

  // ---- 日程 CRUD（全部走 core/state-ops.js）----
  saveEvent: (ev) => mutate((db) => ops.upsertEvent(db, ev)),
  patchEvent: (id, patch) => mutate((db) => ops.patchEvent(db, id, patch)),
  deleteEvent: (id) => mutate((db) => ops.deleteEvent(db, id)),
  // 戳破：直接子级放出一级、孙子留在原位；带 occurrence 时按实例记账
  popEvent: (id, body) => mutate((db) => ops.popEvent(db, id, body || {})),
  restorePopped: (id, body) => mutate((db) => ops.restorePopped(db, id, body || {})),
  recycle: async () => ({ items: ops.poppedRecords(await loadDb()) }),

  // ---- 闹钟（计时器 / 定时器）----
  //
  // ⚠️ 与 remote 那一份**同名同签名**（见 adapter/api.js）。
  //    逻辑同样在 core（state-ops 的 upsertAlarm/removeAlarm/toggleAlarm）——
  //    这里只做"读库 → 改 → 写库 → 回那条"，一行业务判定都不复刻。
  //
  // ⚠️ 回的是**那一条**（不是整份列表）：和 server/store.js 的 saveAlarm 对齐，
  //    网页只重画受影响的那一行。回整份会让"离线/在线两条路的返回值形状不同"，
  //    而那种分叉在 store 里迟早炸。
  saveAlarm: (alarm) => mutate((db) => {
    const { alarms, alarm: saved } = ops.upsertAlarm(db, alarm);
    db.alarms = alarms;
    return saved;
  }),
  patchAlarm: (id, patch) => mutate((db) => {
    const { alarms, alarm: saved } = ops.upsertAlarm(db, { ...(patch || {}), id });
    db.alarms = alarms;
    return saved;
  }),
  deleteAlarm: (id) => mutate((db) => {
    const before = (db.alarms || []).length;
    db.alarms = ops.removeAlarm(db, id);
    return { ok: true, removed: before - db.alarms.length };
  }),
  toggleAlarm: (id, enabled) => mutate((db) => {
    const { alarms, alarm: saved } = ops.toggleAlarm(db, id, enabled !== false);
    db.alarms = alarms;
    return saved;
  }),

  // ---- 设置 ----
  settings: (patch) => mutate((db) => ops.updateSettings(db, patch)),
  /** 开机自启是**操作系统**的事，本地模式下没有意义（iOS 上也不存在这个概念） */
  setAutoLaunch: async () => ({ autoLaunch: false, unsupported: true }),

  // ---- 提醒 ----
  /**
   * 本地模式下没有"服务端已响过的提醒"这回事 ——
   * 提醒由页面内的 core/reminder-plan.js 直接判定并投递（见 adapter/reminder.js）。
   * 返回空数组而不是抛错：调用方（serverTick）会把它当成"这次没有要补的"。
   */
  dueReminders: async () => ({ items: [], now: new Date().toISOString() }),
  testNotification: async () => ({ ok: true, result: { local: { ok: true } } }),

  // ---- 课表 ----
  courses: async () => ({ courses: (await loadDb()).courses || [] }),
  importCourses: (payload) => mutate((db) => ops.importCourses(db, payload)),
  /**
   * 删除一门课（连同它的课程事件）。
   *
   * ⚠️ 本地模式**必须**有这个方法：`web/adapter/store.js` 的 `deleteCourse`
   *    只认方法名，切到 local 之后要是少了它，课表页那个删除按钮会直接抛
   *    `api.deleteCourse is not a function`（和 4b 当初"接口形状一致 ⇒ 上层零改动"
   *    是同一个前提，见文件头）。逻辑同样在 core，不会和服务端分叉。
   */
  deleteCourse: (key) => mutate((db) => ops.deleteCourse(db, key)),
  clearEvents: (keepCourses = false) => mutate((db) => ops.clearEvents(db, { keepCourses })),
  restore: (payload) => mutate((db) => ops.restoreBackup(db, payload)),
  /**
   * 把全部数据导出成 JSON 文本（备份用）。
   *
   * ⚠️⚠️ 为什么本地模式**必须**有这个方法（这是踩出来的）：
   *   `backupUrl` 在本地模式返回**空串**（它是给浏览器 `<a download>` 用的直链，
   *   本地没有服务端可直链）。而设置页那个"下载全部数据备份"直接拿它当 href ——
   *   于是 **iPad 上那个按钮是个死按钮**（`href=""`，点了什么都不发生）。
   *   偏偏 iPad 才是数据的主场：用户的全部日程都在那台设备的 IndexedDB 里，
   *   而"重装 App / 换设备"前最需要的就是**一份能拿出来的备份**。
   *
   *   所以这里给一个不依赖服务端的导出：直接读本地库、序列化成和
   *   `restoreBackup` 兼容的形状（`{settings, events, courses}`，
   *   和 `snapshot()` 完全一致 —— 别自己另发明一份，否则"备份能导出但恢复不了"）。
   */
  exportText: async () => JSON.stringify(snapshot(await loadDb()), null, 2),

  // ---- 接入信息：本地模式下没有"接入电脑"这回事 ----
  net: async () => ({
    lan: false, hasCert: false, urls: [], httpUrls: [], httpsUrls: [],
    primary: null, joinUrl: '', localMode: true,
  }),
  /** 二维码：本地模式下没有要扫的地址。返回一个空 SVG，界面不会崩 */
  qr: async () => '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',

  // ---- 课表导入：在线拉取做不到（见文件头的说明）----
  tj: {
    meta: () => { throw NOT_LOCAL('在线获取课表'); },
    majors: () => { throw NOT_LOCAL('在线获取课表'); },
    courses: () => { throw NOT_LOCAL('在线获取课表'); },
    import: () => { throw NOT_LOCAL('在线导入课表'); },
  },

  // ---- 原生直链：本地模式没有服务端 URL ----
  backupUrl: () => '',
  healthUrl: () => '',

  exportAll: async () => snapshot(await loadDb()),
  /** 本地模式专属：清空本地库 */
  wipe: async () => { await clearDb(); return { ok: true }; },
};
