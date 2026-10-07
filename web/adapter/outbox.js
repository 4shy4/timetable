// 离线写队列：服务不可达时把改动存下来，恢复后按顺序补发。
//
// 背景：这个应用是"网页 + 本地服务"的结构，服务端是唯一真相源。
// 服务不在时（电脑关机 / 换了网络），原来**只能看不能改** —— 写操作直接抛错。
// 而 PWA 的价值之一就是"随手记一下，回头再同步"。
//
// 设计要点：
//
// ① **服务端接受客户端给的 id**（`server/store.js`: `id: input.id || id('evt')`），
//    所以离线新建可以立刻给一个本地 id，联网补发时服务端会沿用 —— 不需要
//    "本地临时 id → 服务端真 id" 的映射表。这是整个方案能简单的前提。
//
// ② 队列**独立于数据缓存**（`timetable.cache.v1`）。
//    `refresh()` 会用服务端数据覆盖缓存，如果把队列混在里面就会被冲掉。
//    所以队列单独一个 key，而且 `refresh()` 之后要**把队列重新盖回 state**
//    （否则离线新建的那条会"刷新后消失"）。
//
// ③ 补发**按入队顺序串行**。乱序补发会让"改了又删"这类操作错位。
//
// ④ 补发成功但服务端返回的实体和本地那份不一致时，**以服务端为准**（同步完会 refresh）。
import { api } from './api.js';
// ⚠️ 离线补发要用**和 core 同一份**的"这条事件属于哪门课"判定：
//    自己在这里再写一遍 `id.startsWith('course:' + key)` 看着等价，
//    但课程 key 里本身就含 `|`，将来一改生成规则（或者加"最长匹配"那类修正），
//    这里就会静默分叉 —— 症状是"离线删了课，联网后课程记录没了、课表格子还在"。
import { isCourseEventOf } from '../../core/state-ops.js';

const QUEUE_KEY = 'timetable.outbox.v1';

/** 读队列（坏数据当空，不要因为一条脏记录卡死整个同步）*/
export function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writeQueue(list) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(list));
  } catch { /* 配额满了也不能崩，最多丢待同步 */ }
  notify();
}

/** 入队一条操作。`kind` 见 `replay`。 */
export function enqueue(op) {
  const list = readQueue();
  list.push({ ...op, queuedAt: new Date().toISOString() });
  writeQueue(list);
  // 通知外部（界面上的"待同步 N 条"要立刻变）
  return list.length;
}

export function clearQueue() { writeQueue([]); }
export function queueLength() { return readQueue().length; }

/**
 * 一个**本地 id**，给离线新建用。
 *
 * 前缀 `local_` 便于一眼看出这条是本机建的（服务端生成的是 `evt_`）。
 * 联网补发时服务端会沿用这个 id，所以同步之后它仍然有效。
 */
export function localId() {
  return `local_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 补发队列。返回 `{ done, failed, remaining }`。
 *
 * 遇到失败**立即停止**（不跳过继续）——
 * 队列里后面的操作可能依赖前面那条（比如"新建后改名"）。
 * 跳过会让后面那条打在一个不存在的 id 上，错误更难查。
 */
export async function replay() {
  const list = readQueue();
  if (!list.length) return { done: 0, failed: 0, remaining: 0 };

  let done = 0;
  for (let i = 0; i < list.length; i += 1) {
    const op = list[i];
    try {
      await send(op);
      done += 1;
    } catch (err) {
      // 把已完成的摘掉，剩下的留着下次再试
      writeQueue(list.slice(i));
      return { done, failed: 1, remaining: list.length - i, error: err && err.message };
    }
  }
  clearQueue();
  return { done, failed: 0, remaining: 0 };
}

/** 真正发一条操作 */
async function send(op) {
  switch (op.kind) {
    case 'saveEvent': return api.saveEvent(op.payload);
    case 'patchEvent': return api.patchEvent(op.id, op.patch);
    case 'deleteEvent': return api.deleteEvent(op.id);
    case 'deleteCourse': return api.deleteCourse(op.key);
    case 'popEvent': return api.popEvent(op.id, op.opts);
    case 'restorePopped': return api.restorePopped(op.id, op.opts);
    case 'saveSettings': return api.settings(op.patch);
    default:
      throw new Error(`未知的离线操作：${op.kind}`);
  }
}

/**
 * 把队列里的改动**盖回** state（在 `refresh()` 之后调用）。
 *
 * 为什么需要：`refresh()` 会用服务端数据整体替换 events/settings。
 * 而离线期间建的/改的东西服务端还没有，一 refresh 就"消失"了 ——
 * 用户会以为数据丢了。所以每次拉完服务端数据，都要把本地未同步的改动重新应用一遍。
 *
 * ⚠️ 只做**幂等**的应用（按 id 覆盖 / 追加 / 删除），不重放业务逻辑。
 */
export function applyToState(state) {
  const list = readQueue();
  if (!list.length) return state;

  let events = state.events ? [...state.events] : [];
  let settings = state.settings;
  let courses = Array.isArray(state.courses) ? [...state.courses] : state.courses;

  for (const op of list) {
    if (op.kind === 'saveEvent' && op.payload) {
      const saved = { ...op.payload, id: op.payload.id || op.localId, pending: true };
      const idx = events.findIndex((e) => e.id === saved.id);
      if (idx >= 0) events[idx] = { ...events[idx], ...saved };
      else events.push(saved);
    } else if (op.kind === 'patchEvent') {
      events = events.map((e) => (e.id === op.id ? { ...e, ...op.patch, pending: true } : e));
    } else if (op.kind === 'deleteEvent') {
      events = events.filter((e) => e.id !== op.id);
    } else if (op.kind === 'deleteCourse') {
      // 离线删的课：课程记录 **和它的伴生事件**都要摘掉。
      // ⚠️ 只摘课程记录是不够的：课表格子/气泡/提醒全是从 events 读的，
      //    刷新之后那节课照旧在、照旧提醒 —— 用户看到的是"我删了它没生效"。
      if (Array.isArray(courses)) courses = courses.filter((c) => String(c.key) !== String(op.key));
      events = events.filter((e) => !isCourseEventOf(e, op.key));
    } else if (op.kind === 'saveSettings' && op.patch) {
      settings = { ...settings, ...op.patch };
    }
    // popEvent / restorePopped 的乐观效果由调用方当场做（它要知道是"哪一颗"），
    // 这里不重复应用 —— 免得把已经被服务端处理过的又做一遍。
  }
  return { ...state, events, settings, courses };
}

// ---- 变更通知（界面上的"待同步"标记要跟着变）----
const listeners = new Set();
export function onQueueChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify() { listeners.forEach((fn) => { try { fn(queueLength()); } catch { /* ignore */ } }); }
