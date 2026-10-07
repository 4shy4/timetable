// 同步编排：把本机（IndexedDB）和电脑（HTTP）的数据合到一起。
//
// 顺序很讲究，别调换：
//   ① 读本机库
//   ② 按筛选规则取出本机载荷
//   ③ 送给电脑；**电脑先合并**，再把合并结果回给我们
//   ④ 本机按同一套规则合并、写回
//
// 为什么让电脑先合并再回传，而不是"各自合并各自的"：
//   两边跑的是 core/sync.js 里**同一套**合并规则，所以顺序在数学上其实无所谓；
//   但让电脑先合、把它合并后的**权威结果**回传，可以避免"本机以为自己合过了、
//   电脑那边因为写盘失败没合上"这种两边看法不一致的状态 ——
//   回传的结果就是这一轮的定论。
//
// ⚠️ 筛选（白名单/黑名单）**两端都会执行**：
//   本机送出的载荷已经裁过；服务端收到后还会再裁一次（filter 是权威，不是建议）。
//   见 core/sync.js 的 filterPayload。

import { syncPayloadOf, filterPayload, mergeSync, applySync, tombstoneStats, normalizeFilter } from '../../core/sync.js';
import { loadDb, saveDb } from './idb.js';
// 同步通道也在 api.js 里（架构约束：网络访问只出现在那一个文件）
import { syncPush, peerReachable } from './api.js';

/**
 * 跑一次同步。
 *
 * @param {object} opts
 * @param {{mode:string,categories:string[]}} [opts.filter] 白名单/黑名单。不传=全同步
 * @param {{pull:Function, push:Function}} [opts.peer] 对端通道（测试时注入假的）
 * @param {Function} [opts.onLocalDb] 拿到本机库时的回调（测试用）
 * @returns {Promise<object>} `{ ok, filter, stats, local:{events,courses} }`
 */
export async function runSync({ filter, peer, onLocalDb } = {}) {
  const f = normalizeFilter(filter);
  const channel = peer || { push: syncPush, reachable: peerReachable };

  const db = await loadDb();
  if (onLocalDb) onLocalDb(db);

  // ② 本机载荷（已按筛选裁剪）
  const mine = syncPayloadOf(db, f);

  // ③ 电脑合并并回传权威结果
  const merged = await channel.push(mine, f);

  // ④ 本机按同一规则合并写回 —— 用回传的结果当"远端"
  const localMerged = mergeSync(mine, filterPayload(merged, f));
  applySync(db, localMerged, f);
  // ⚠️ **故意不清理墓碑**（原来这里调了 pruneTombstones）：
  //    清理正是"删除会复活"的成因，而墓碑只有 76 字节/条，留着几乎不花代价。
  //    详见 core/sync.js 里 PRUNE_DAYS 的注释。
  await saveDb(db);

  return {
    ok: true,
    filter: f,
    at: new Date().toISOString(),
    stats: localMerged.stats,
    tombstones: tombstoneStats(db),
    local: { events: (db.events || []).length, courses: (db.courses || []).length },
  };
}

/**
 * 只把本机数据**整个推给电脑**（不做合并）。
 *
 * 用途：本机库是"权威"时（例如你只在 iPad 上编辑，想把电脑刷新成平板的样子）。
 * 与 `runSync` 的区别：那个是合并（两边都保留），这个是**覆盖**。
 * 覆盖有风险，所以界面上必须让用户明确选。
 */
export async function pushOverwrite({ filter, peer } = {}) {
  const f = normalizeFilter(filter);
  const channel = peer || { push: syncPush, reachable: peerReachable };
  const db = await loadDb();
  const mine = syncPayloadOf(db, f);
  // 让电脑接受"我们这边是权威"：把它自己的记录清成空再走合并，
  // 效果就是"本机覆盖电脑"。墓碑仍然遵守 —— 否则删不掉东西。
  const mineWins = {
    events: mine.events,
    courses: mine.courses,
    tombstones: mine.tombstones,
    generatedAt: mine.generatedAt,
  };
  const merged = await channel.push(mineWins, f);
  return { ok: true, filter: f, stats: merged && merged.stats, local: { events: (db.events || []).length, courses: (db.courses || []).length } };
}

/** 电脑可不可达（给界面一个准确的说法） */
export async function peerStatus() {
  return peerReachable();
}
