// IndexedDB 持久化：让 iPad / 浏览器**自己存数据**，不再依赖电脑。
//
// 这是 4b 的存储层。上层 `api-local.js` 用 core/state-ops.js 跑业务逻辑，
// 只把"存哪"交给这里 —— 换存储（IndexedDB / 原生桥 / 内存）不影响业务逻辑。
//
// ⚠️ 为什么用 IndexedDB 而不是 localStorage：
//   · localStorage 只有 ~5MB，而且**同步阻塞**主线程。整份 db（含全部事件 + 课表）
//     很容易超；日程越多越卡。
//   · IndexedDB 容量按磁盘比例给，且是异步的。
//   代价是 API 啰嗦、必须在真浏览器里测（Node 里没有 IndexedDB）——
//   所以这条链路的测试放在 tools/local-mode.test.mjs，用真 Chrome 跑。
//
// ⚠️ 单条记录存整份 db（一个 key），不做细粒度表。理由：
//   本应用的数据量（几百条事件）整体读写完全够用，而**整份原子写**天然不会出现
//   "事件写进去了、courses 没写进去"这种半截状态。细粒度拆分只在数据量很大时
//   才有必要，现在引入只会增加出错面。

import { defaultDb, mergeDefaults } from '../../core/defaults.js';

const DB_NAME = 'timetable';
const DB_VERSION = 1;
const STORE = 'kv';
const KEY = 'db';

let dbPromise = null;

/** 打开（或建）库。失败时抛错 —— 调用方要能区分"没数据"和"存不了" */
function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('这个环境没有 IndexedDB（本地模式只能在浏览器里用）'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains(STORE)) idb.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then((idb) => new Promise((resolve, reject) => {
    const t = idb.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    try { out = fn(store); } catch (err) { reject(err); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error || new Error('IndexedDB 事务失败'));
    t.onabort = () => reject(t.error || new Error('IndexedDB 事务被中止'));
  }));
}

/**
 * 读出整份 db。
 *
 * ⚠️ 一定要过 `mergeDefaults`：老版本存下的库缺新增的设置项，
 *    直接返回会让界面读到 `undefined`（`courseDigest` 就这么整块显示不出来过）。
 *    传入的缺省用 `defaultDb()` —— 和服务端**同一份**。
 */
export async function loadDb() {
  const raw = await tx('readonly', (s) => s.get(KEY));
  if (!raw || typeof raw !== 'object') return defaultDb();
  return mergeDefaults(raw, defaultDb());
}

/** 整份写回。原子 —— 不会出现半截状态 */
export async function saveDb(db) {
  const next = { ...db, updatedAt: new Date().toISOString() };
  await tx('readwrite', (s) => s.put(next, KEY));
  return next;
}

/** 本地模式下的"版本号"：每次写 +1，用来判断"和上次同步相比变没变" */
export function bumpRev(db) {
  db.rev = (Number(db.rev) || 0) + 1;
  return db.rev;
}

/** 清空本地库（"重置"/"退出本地模式"时用） */
export async function clearDb() {
  await tx('readwrite', (s) => s.delete(KEY));
}

/** 仅供测试：把连接缓存清掉，让下一次 load 重新打开 */
export function _resetConnection() {
  dbPromise = null;
}
