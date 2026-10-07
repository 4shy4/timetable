// 前端状态容器：内存态 + 本地缓存 + 服务端同步。
// 订阅模型极简：state 任何变化 -> 通知所有 listener。
import { api } from './api.js';
// 离线写队列：服务不可达时把改动存下来，恢复后按顺序补发（见 outbox.js 的注释）
import * as outbox from './outbox.js';
// ⚠️ "这条事件属于哪门课"的判定只认 core 那一份（课程 key 自己含 `|`，
//    在这里重写一个前缀匹配迟早和 core 分叉 —— 见 core/state-ops.js 的长注释）。
import { isCourseEventOf } from '../../core/state-ops.js';

/**
 * 把界面上来的值转成数字（`<select>` 的 value 永远是字符串）。
 *
 * 空值统一给 undefined，让 JSON.stringify 直接省略该字段。
 */
const toNum = (v) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

/** 专业代码：上游要字符串（实测），但界面传来也是字符串，这里只做空值归一 */
const toStr = (v) => (v === undefined || v === null || v === '' ? undefined : String(v));

const CACHE_KEY = 'timetable.cache.v1';

/** 冷启动时把"缓存的待同步条数"也算出来（界面要显示"待同步 N 条"）*/
function initialPending() {
  try { return outbox.queueLength(); } catch { return 0; }
}

const state = {
  ready: false,
  online: false,
  error: null,
  health: null,
  rev: 0,
  /** 待同步的离线改动条数（0 = 全部已同步）*/
  pending: initialPending(),
  settings: {
    owner: '我',
    termStart: '',
    termWeeks: 20,
    todayTodo: '',
    notify: { desktop: true, browser: true, sound: true, intensity: 'auto' },
    autoLaunch: false,
    lan: false,
    defaultReminders: [10, 0],
    // 「周期」是否连提醒一起筛（开关：关 = 只影响气泡显示，开 = 连提醒）
    periodAffectsReminders: false,
    periodAffectsCalendar: false,
  },
  events: [],
  courses: [],
  // 闹钟（计时器 / 定时器）。⚠️ 这里必须有初值：闹钟视图读 `state.alarms.length`，
  // 而在第一次 refresh 回来之前（或离线冷启动、缓存里没有这个键时）
  // 它是 undefined → 整块视图渲染不出来（`courseDigest` 炸过一次的同款坑）。
  alarms: [],
  // 视图状态（不属于服务端数据）
  view: localStorage.getItem('timetable.view') || 'bubble',
  cursor: new Date().toISOString().slice(0, 10),
  courseWeek: null,
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function getState() { return state; }
export function setState(patch) {
  Object.assign(state, patch);
  listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } });
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      rev: state.rev,
      settings: state.settings,
      events: state.events,
      courses: state.courses,
      // ⚠️ 闹钟也要进缓存：冷启动时先用缓存渲染（离线也要能看到自己的闹钟），
      //    漏了它会出现"断网打开 App，闹钟列表是空的" —— 而用户会以为闹钟丢了。
      alarms: state.alarms,
      cachedAt: new Date().toISOString(),
    }));
  } catch { /* 配额满了也不影响使用 */ }
}

/** 冷启动：先用缓存立刻渲染，再拉服务端真数据 */
export async function init() {
  const cached = readCache();
  if (cached) {
    // 缓存 + **未同步的改动**一起渲染（否则离线建的那条会看着像丢了）
    setState({ ...outbox.applyToState(cached), ready: true, online: false });
  }
  await refresh({ silent: !!cached });
  return state;
}

export async function refresh({ silent = false } = {}) {
  try {
    // 先补发离线期间的改动 —— **在拉服务端数据之前**。
    // 顺序反了会有一个窗口期：服务端数据把本地改动冲掉、看起来像"数据丢了"。
    let replayInfo = null;
    if (outbox.queueLength()) {
      replayInfo = await outbox.replay();
    }

    const [health, data] = await Promise.all([api.health(), api.state()]);
    const merged = outbox.applyToState({
      rev: data.rev,
      settings: data.settings,
      events: data.events,
      courses: data.courses,
      // ⚠️ 离线补发的队列里**没有**闹钟（闹钟不做离线写，见下面的 saveAlarm），
      //    所以这里不会被队列覆盖，直接取服务端/本机库里的那份。
      alarms: Array.isArray(data.alarms) ? data.alarms : [],
    });
    setState({
      ready: true,
      online: true,
      error: null,
      health,
      pending: outbox.queueLength(),
      ...merged,
    });
    writeCache();
    return replayInfo;
  } catch (err) {
    if (!silent) setState({ ready: true, online: false, error: err.message });
    else setState({ online: false, error: err.message });
    return null;
  }
}

/**
 * 写操作的统一包装：**先试服务端，失败就入队 + 本地乐观更新**。
 *
 * 这是"离线可写"的落点。原来每个写函数都是 `await api.xxx()` 直接抛错，
 * 于是离线时用户只能看着数据不能改。
 *
 * @param {object} op      入队用的操作描述（kind/id/payload…）
 * @param {Function} call  真正打服务端的函数
 * @param {Function} apply 本地乐观更新：拿到"本地版本的实体"并写进 state
 */
async function writeThrough(op, call, apply) {
  try {
    const result = await call();
    setState({ online: true, error: null, pending: outbox.queueLength() });
    return { result, queued: false };
  } catch (err) {
    // 网络层面的失败才入队；业务错误（400 参数不对之类）要照实报错，
    // 否则会往队列里塞一条永远补发不成功的记录。
    if (!isNetworkError(err)) throw err;
    const local = apply ? apply(op) : null;
    outbox.enqueue(op);
    setState({ online: false, error: err.message, pending: outbox.queueLength() });
    writeCache();
    return { result: local, queued: true };
  }
}

/** 是不是"连不上服务"这类错误（而不是服务端明确拒绝）*/
function isNetworkError(err) {
  const msg = String((err && err.message) || '');
  return /failed to fetch|networkerror|load failed|connection|econnrefused|timeout|xhr/i.test(msg)
    || (err && err.name === 'TypeError');
}

// ---- 写操作：先试服务端；连不上就入队 + 本地乐观更新（离线可写）----

export async function saveEvent(input) {
  // 离线新建要**先有 id**（服务端接受客户端给的 id，见 outbox.js 的①）
  const withId = input.id ? input : { ...input, id: outbox.localId() };
  const { result, queued } = await writeThrough(
    { kind: 'saveEvent', payload: withId },
    () => api.saveEvent(withId),
    () => ({ ...withId, pending: true }),
  );
  const saved = result || withId;
  const idx = state.events.findIndex((e) => e.id === saved.id);
  const events = idx >= 0
    ? state.events.map((e) => (e.id === saved.id ? saved : e))
    : [...state.events, saved];
  setState({ events });
  writeCache();
  return saved;
}

export async function patchEvent(id, patch) {
  const { result, queued } = await writeThrough(
    { kind: 'patchEvent', id, patch },
    () => api.patchEvent(id, patch),
    () => ({ id, ...patch, pending: true }),
  );
  const saved = result || { id, ...patch, pending: true };
  setState({ events: state.events.map((e) => (e.id === id ? { ...e, ...saved } : e)) });
  writeCache();
  return saved;
}

export async function deleteEvent(id) {
  await writeThrough(
    { kind: 'deleteEvent', id },
    () => api.deleteEvent(id),
    null,
  );
  setState({ events: state.events.filter((e) => e.id !== id) });
  writeCache();
}

/**
 * 删除一门课：课程记录 **和它的课程事件**一起删。
 *
 * 与 `deleteEvent` 同一套路（先试服务端，连不上就入队 + 本地乐观更新），
 * 但**必须连伴生事件一起摘**：课表格子/气泡/提醒全是从 `events` 读的，
 * 只摘 `courses` 里那一行的话，界面上那节课照旧显示 —— 用户看到的是
 * "我删了它还在"（服务端的 core/state-ops.js 也是这么成对删的，两边保持一致）。
 *
 * ⚠️ 判定"这条事件属于这门课"用的是 core 的 `isCourseEventOf`，
 *    不在这里另写一份前缀匹配 —— 课程 key 自己含 `|`，重写一遍必然漂移。
 */
export async function deleteCourse(key) {
  const { result, queued } = await writeThrough(
    { kind: 'deleteCourse', key },
    () => api.deleteCourse(key),
    null,
  );
  setState({
    courses: state.courses.filter((c) => String(c.key) !== String(key)),
    events: state.events.filter((e) => !isCourseEventOf(e, key)),
  });
  writeCache();
  return result || { ok: true, key, queued: !!queued };
}

export async function toggleDone(id) {
  const ev = state.events.find((e) => e.id === id);
  if (!ev) return;
  return patchEvent(id, { done: !ev.done });
}

/**
 * 戳破气泡（= 完成）。服务端会把**直接子级**放出一级、孙子留在原位，
 * 所以返回后要重新拉一次全量状态，而不是本地猜。
 *
 * 离线时也允许戳破：入队，并**就地**把它标成已完成（含这次发生的账），
 * 让用户当下看得到反馈。
 */
export async function popEvent(id, opts) {
  const { result, queued } = await writeThrough(
    { kind: 'popEvent', id, opts },
    () => api.popEvent(id, opts),
    () => {
      // 乐观效果：重复事件只标这一颗的 popped，非重复事件整条 done
      const ev = state.events.find((e) => e.id === id) || {};
      const occ = opts && opts.occurrence
        ? String(opts.occurrence).slice(0, 10)
        : null;
      if (occ) {
        const popped = { ...(ev.popped || {}) };
        popped[occ] = { at: new Date().toISOString(), remainingMs: opts.remainingMs ?? null };
        return { ...ev, popped, pending: true };
      }
      return { ...ev, done: true, pending: true };
    },
  );
  if (queued) {
    const local = result;
    if (local && local.id) {
      setState({ events: state.events.map((e) => (e.id === id ? { ...e, ...local } : e)) });
      writeCache();
    }
    return { ok: true, queued: true, event: local, released: [] };
  }
  await refresh();
  return result;
}

/** 还原一颗（或全部）被戳破的泡泡 —— 回收气泡站用 */
export async function restorePopped(id, opts) {
  const { result, queued } = await writeThrough(
    { kind: 'restorePopped', id, opts },
    () => api.restorePopped(id, opts),
    () => {
      const ev = state.events.find((e) => e.id === id) || {};
      if (opts && opts.occurrence) {
        const popped = { ...(ev.popped || {}) };
        delete popped[String(opts.occurrence).slice(0, 10)];
        return { ...ev, popped, pending: true };
      }
      return { ...ev, popped: {}, done: false, pending: true };
    },
  );
  if (queued) {
    if (result && result.id) {
      setState({ events: state.events.map((e) => (e.id === id ? { ...e, ...result } : e)) });
      writeCache();
    }
    return { ok: true, queued: true };
  }
  await refresh();
  return result;
}

/** 回收气泡站的数据（每个事件一条，合并）*/
export async function recycle() {
  const res = await api.recycle();
  return (res && res.items) || [];
}

/**
 * 桌面气泡层的状态 —— **只有 Windows 的 PC 版有**。
 *
 * ⚠️ 别的端（iPad / 安卓 / 离线）上这个接口不存在，会 404。
 *    这里**故意把错误咽掉、回答 null**：调用方据此"整块不显示"，
 *    而不是弹一个用户看不懂的红色错误（"桌面气泡区"在平板上本来就没意义）。
 */
export async function desktopLayerStatus() {
  try {
    const st = await api.desktopLayer();
    if (!st || !st.supported) return null;
    return st;
  } catch {
    return null;
  }
}

/** 对桌面气泡层做一件事（start / stop / topmost / capture / autostart） */
export async function desktopLayerAct(action, on) {
  const res = await api.desktopLayerAct(action, on);
  return res || null;
}

/** 某个气泡的直接子气泡 */
export function childrenOf(id) {
  return state.events.filter((e) => e.parentId === id);
}

/** 根层气泡（没有父级的） */
export function rootEvents() {
  return state.events.filter((e) => !e.parentId && !e.done);
}

// ---------------------------------------------------------------------------
// 闹钟（计时器 / 定时器）
//
// ⚠️ 为什么不照 events 那样做**离线写队列**（`writeThrough` 那套）：
//   离线时"新建一条闹钟"看起来成功、其实**系统那边排不进去**（iOS 壳没拿到数据），
//   而闹钟的全部价值就在"到点会响"。给用户一个"已保存"的假象，
//   换来的是一次**不会响的闹钟** —— 那比直接报错糟糕得多。
//   所以这里的失败**照实抛出去**，界面按错误码说清是哪一种（见 alarms-view 的文案）。
//   （events 可以离线写是因为它只是"记下来"，而闹钟是"交待给系统"。）
// ---------------------------------------------------------------------------

/** 新建或更新一条闹钟。返回服务端/本机库落库后的**那一条**。 */
export async function saveAlarm(input) {
  const saved = await api.saveAlarm(input);
  const one = saved && saved.id ? saved : { ...input };
  const idx = state.alarms.findIndex((a) => a && a.id === one.id);
  const alarms = idx >= 0
    ? state.alarms.map((a) => (a.id === one.id ? one : a))
    : [...state.alarms, one];
  setState({ alarms, online: true, error: null });
  writeCache();
  return one;
}

/** 开关一条闹钟。**只改那一条**（其余引用不动 —— 视图据此只重画一行）。 */
export async function toggleAlarm(id, enabled) {
  const saved = await api.toggleAlarm(id, enabled !== false);
  const one = saved && saved.id ? saved : null;
  const alarms = one
    ? state.alarms.map((a) => (a.id === one.id ? one : a))
    : state.alarms;
  setState({ alarms });
  writeCache();
  return one;
}

export async function deleteAlarm(id) {
  const res = await api.deleteAlarm(id);
  setState({ alarms: state.alarms.filter((a) => !(a && a.id === id)) });
  writeCache();
  return res;
}

/** 按 id 找一条闹钟 */
export function alarmById(id) {
  return state.alarms.find((a) => a && a.id === id) || null;
}

export async function saveSettings(patch) {
  const { result, queued } = await writeThrough(
    { kind: 'saveSettings', patch },
    () => api.settings(patch),
    () => ({ ...state.settings, ...patch, pending: true }),
  );
  const saved = result || { ...state.settings, ...patch };
  setState({ settings: saved });
  writeCache();
  return saved;
}

/**
 * 导入课程 —— **故意不支持离线**。
 *
 * 导入是"把一整份课表交给服务端按周次展开"的批量操作，离线补发的语义很别扭
 * （用户可能已经改了别的），而且它本来就是"坐下来一次做完"的事。
 * 所以这里直接照实报错，不要给假的"已暂存"。
 */
export async function importCourses(payload) {
  const result = await api.importCourses(payload);
  await refresh({ silent: true });
  return result;
}

/**
 */

export function setView(view) {
  state.view = view;
  localStorage.setItem('timetable.view', view);
  setState({ view });
}

export function setCursor(dateKey) { setState({ cursor: dateKey }); }
export function setCourseWeek(week) { setState({ courseWeek: week }); }

/** 按 id 找事件 */
export function eventById(id) { return state.events.find((e) => e.id === id) || null; }
