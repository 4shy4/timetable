// 数据层：单文件 JSON 存储 + 原子写入 + 变更版本号。
// 之所以不用 SQLite：零依赖、可读可改、方便你直接备份/迁移。
import fs from 'node:fs';
// 缺省值深合并（老库补新增字段），与安卓端同一套语义
import { mergeDefaults } from '../core/defaults.js';
import path from 'node:path';
import { DB_FILE, ensureDirs } from './paths.js';
import {
  LEVELS, DEFAULT_LEVEL, levelByKey, canNestInside, levelFromLegacyMagnitude,
  notificationPlanForRemaining,
} from '../core/level.js';
import { deadlineFromParts as deadlineFromDistance } from '../core/countdown.js';
// 课程摘要的缺省槽位：已随 `defaultDb()` 一起搬到 core/defaults.js（唯一真源）
// 4a：状态操作层已搬到 core，三端共用一份。
// 这里保留原有的导出名与签名（api.js / scheduler.js 都依赖它们），只是**转调**过去 ——
// 于是"服务端"和"iPad 本地"跑的是同一段判定，不会再各自漂移。
import * as stateOps from '../core/state-ops.js';
// 缺省库的**唯一**定义搬到了 core —— 服务端（data/db.json）和 iPad 本地模式
// （IndexedDB）必须用同一份，否则两边形状会分叉。
import { defaultDb } from '../core/defaults.js';
// 同步（4c）：合并规则在 core/sync.js，和 iPad 端同一份
import { syncPayloadOf, filterPayload, mergeSync, applySync } from '../core/sync.js';

const LEVEL_BY_KEY = new Map(LEVELS.map((l) => [l.key, l]));

const DEFAULT_DB = defaultDb;

let db = null;

function read() {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) return DEFAULT_DB();
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    // ⚠️ 必须用**深**合并：`{...DEFAULT_DB(), ...parsed}` 只能补顶层键，
    //    补不上新增的嵌套设置（比如 `settings.courseDigest` —— 老库里
    //    `settings` 存在、但里面没这个键，浅合并读出来是 undefined）。
    return mergeDefaults(parsed, DEFAULT_DB());
  } catch (err) {
    // 文件损坏时不静默清空：备份后重建，避免丢数据
    const bak = `${DB_FILE}.broken-${Date.now()}`;
    try { fs.copyFileSync(DB_FILE, bak); } catch { /* ignore */ }
    console.error('[store] db.json 解析失败，已备份到', bak, err.message);
    return DEFAULT_DB();
  }
}

export function load() {
  if (!db) db = read();
  return db;
}

/**
 * 首次启动时把 db.json 落盘。
 * 好处：打开程序就能在 data/ 下看到数据文件，备份/迁移时不会"找不到文件"。
 */
export function ensureDbFile() {
  ensureDirs();
  if (!fs.existsSync(DB_FILE)) {
    const data = load();
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  }
  return false;
}

/** 原子写：先写临时文件再 rename，断电也不会写坏 */
export function persist() {
  ensureDirs();
  const data = load();
  data.rev += 1;
  data.updatedAt = new Date().toISOString();
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
  return data;
}

export function getState() {
  const d = load();
  return {
    rev: d.rev, updatedAt: d.updatedAt, settings: d.settings,
    events: d.events, courses: d.courses,
    // 闹钟（计时器/定时器）—— **必须**在这里回给网页：
    // 它和 events/courses 一样是顶层数据，而网页只从 /api/state 读一次。
    // 漏了这一行，iOS 上会表现成"闹钟列表永远是空的"（而写进去的数据其实在库里）。
    alarms: Array.isArray(d.alarms) ? d.alarms : [],
  };
}

export function id(prefix) { return stateOps.id(prefix); }

/** 旧的 magnitude/importance → 四档等级，保证老数据不丢（实现在共用核心层） */
export function clampMagnitude(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 60;
  return Math.min(100, Math.max(1, n));
}

/**
 * 事件等级归一化 + 老数据迁移（见下方 `levelOf`）。
 * 老版本用 magnitude(1–100) / importance(1–5) 表达"事情多大"，
 * 现在换成四档颜色，按区间映射，信息不丢。
 */
export function migrateImportance(value) {
  return levelFromLegacyMagnitude(value);
}

// ---------------------------------------------------------------------------
// 提醒计划（v0.4：改按**剩余时间档位**算，不再按颜色）
//
// 颜色现在表示"事情多大"，跟紧急度无关了；紧急度只看还剩多久。
// 所以提醒强度改由 core/level.js 的 BAND_INTENSITY / BAND_REMINDER_PLAN 决定。
// 那份定义放在共用核心层，这里直接引用 —— 不开页面也能按档位提醒（后台调度器用）。
// ---------------------------------------------------------------------------

/** 事件的"截止时刻"（毫秒）。三条优先级：显式 deadline > 开始时间 > end */
export function deadlineOf(ev) { return stateOps.deadlineMsOf(ev); }

/** 还剩多久（毫秒）。没有期限 → null（表示"未设期限"，不是 0） */
export function remainingOf(ev, now = new Date()) { return stateOps.remainingMsOf(ev, now); }

/**
 * 这个事件是不是"过期"（紫色）。
 *
 * 与网页端 `core/urgency.js` 的 `isOverdueEvent` 同义：剩余时间到 0 就算过期；
 * **父级过期时子级也算过期**（紫会往下传）。
 *
 * 用途：过期容器**只读** —— 能进去看，但不能往里加子泡泡（用户要求）。
 * 安卓端（Kotlin 的 Store）已经守了这道，这里必须一起守，
 * 否则同一个规则在两端行为不一致 —— 而这个项目的原则就是"判定和显示用同一套依据"。
 */
export function isOverdue(ev, allEvents, now = new Date()) {
  return stateOps.isOverdueEvent(ev, allEvents, now);
}

/**
 * 分层版本：渲染层靠它区分"自己过期"和"容器过期"。
 * 见 core/state-ops.js 的 overdueStateOf —— 那是"剩余 N 天却显示紫色"那个矛盾的修法。
 */
export function overdueStateOf(ev, allEvents, now = new Date()) {
  return stateOps.overdueStateOf(ev, allEvents, now);
}

/** 事件实际生效的提醒列表（自动模式：按当前剩余时间档位实时生成） */
export function effectiveReminders(ev, now = new Date()) {
  return stateOps.effectiveReminders(ev, now);
}

/**
 * 「未来泡泡」现在该不该出现（`start` = 出现日期）。
 * 判定本体在 core/state-ops.js —— 气泡区和将来的列表角标必须共用同一份。
 */
export function isNotYetVisible(ev, now = new Date()) {
  return stateOps.isNotYetVisible(ev, now);
}

/**
 * 这一颗的**祖先容器**里有没有过期的（不看它自己）。
 * ⚠️ 别用 `isOverdueEvent(ev)` 代替它：后者读的是 base 的期限（第一次发生那次），
 * 会让"上周建的每周日程"在本周/下周那两颗上画出一圈紫虚线（用户报的"紫齿轮"）。
 * 详见 core/state-ops.js 里的长注释。
 */
export function inheritedOverdueOf(ev, allEvents, now = new Date()) {
  return stateOps.inheritedOverdueOf(ev, allEvents, now);
}

/** 事件当前的紧急档位（用于调试面板与"按档位分色"的图例） */
export function bandForEvent(ev, now = new Date()) {
  return stateOps.bandForEvent(ev, now);
}

/** 旧接口兼容：以前是 tierForStart，现在返回"剩余时间档位"，语义更准 */
export function bandKeyForEvent(ev, now = new Date()) {
  return stateOps.bandKeyForEvent(ev, now);
}

/**
 * 事件等级（颜色）归一化 + 老数据迁移。
 * 优先级：显式 level > 旧 tier 字段 > 旧 magnitude/importance 换算 > 默认。
 */
export function levelOf(ev) { return stateOps.levelOf(ev); }


export function upsertEvent(input) {
  const d = load();
  const out = stateOps.upsertEvent(d, input);   // 纯逻辑在 core，三端共用
  persist();
  return out;
}

export function patchEvent(eventId, patch) {
  const d = load();
  const out = stateOps.patchEvent(d, eventId, patch);   // 套娃/防环校验都在 core
  persist();
  return out;
}

/**
 * 戳破一个气泡（= 完成）。
 * 里面的子气泡**只放出一级**：直接挂到被戳破那层的父级去，
 * 更深层的孙子不动（用户明确要求"气泡里的气泡里的气泡不要漏出来"）。
 */
/**
 * 这个事件会不会展开出**多个实例**（也就是需要"按实例记账"）。
 *
 * 重复日程（有 freq）和课表课程（有 weeks）都算。
 */
export function isRecurring(ev) { return stateOps.isRecurring(ev); }

/** 实例的账本键（'YYYY-MM-DD'，本地日期）*/
export function occurrenceKey(date) { return stateOps.occurrenceKey(date); }

/**
 * 戳破一颗泡泡。
 *
 * ⚠️ **按实例记账**是这里的关键改动。
 *
 * 原来无论什么事件都写 `e.done = true` —— 作用于**整个事件**。
 * 后果：戳破"这周的跑步"，整条重复就结束了，下周不再新生。
 * 而用户要的是**每颗实例独立**（"如果提前完成任务，那么 10.5 该浮"）。
 *
 * 数据落在事件上：
 *   · `popped['YYYY-MM-DD'] = { at, remainingMs }` —— 哪几颗被戳破了、戳破时还剩多久
 *   · 非重复事件仍然用 `done`（语义清楚，也兼容老数据）
 *
 * `remainingMs` 由**调用方**（前端气泡）传入 —— 它算的剩余时间带上了"这次发生"的
 * 截止时刻（见 core/recurrence.js 的 occurrenceDeadline），服务端算不出来。
 */
export function popEvent(eventId, opts = {}) {
  const d = load();
  const out = stateOps.popEvent(d, eventId, opts);   // 纯逻辑在 core，三端共用
  persist();
  return out;
}

/**
 * 还原一颗被戳破的泡泡（用户要求"还原可以有"）。
 *
 * 传 `occurrence` 只还原那一颗；不传则把这条事件的**全部**破裂记录清掉。
 */
export function restorePopped(eventId, opts = {}) {
  const d = load();
  const out = stateOps.restorePopped(d, eventId, opts);   // 纯逻辑在 core
  persist();
  return out;
}

/**
 * 回收气泡站的数据：**每个事件一条**（用户要求"合并"）。
 *
 * 用户原话："合并，你很聪明" —— 重复事件戳破 5 次是**一条**记录，
 * 里面带着 5 次破裂的时间与"破裂那一刻的剩余时间"。
 */
export function poppedRecords() {
  return stateOps.poppedRecords(load());   // 纯读，不用 persist
}

/** 某个气泡的直接子气泡 */
export function childrenOf(eventId) {
  return stateOps.childrenOf(load(), eventId);
}

// ---------------------------------------------------------------------------
// 同步（4c）
//
// 服务端在同步里是**被动的一方**：平板（客户端）够得着它，它够不着平板。
// 所以同步一律由客户端发起：客户端送上来它的载荷，服务端合并进自己的库、
// 落盘，再把合并结果回给客户端。两边用的是 core/sync.js 里**同一套**合并规则。
// ---------------------------------------------------------------------------

/** 取出本机（服务端）的同步载荷，按客户端给的筛选规则过滤 */
export function syncPayload(filter) {
  return syncPayloadOf(load(), filter);
}

/**
 * 合并客户端送上来的载荷。
 * @returns {object} 合并后的结果（客户端拿它写回自己的本地库）
 */
export function syncMerge(remotePayload, filter) {
  const d = load();
  // ⚠️ 服务端**也要按 filter 裁一遍**收到的载荷，不能只信客户端自觉 ——
  //    否则"我明明选了只同步课表"仍可能被旧客户端把气泡推上来覆盖掉。
  const safeRemote = filterPayload(remotePayload, filter);
  const merged = mergeSync(syncPayloadOf(d, filter), safeRemote);
  applySync(d, merged, filter);
  // ⚠️ **故意不清理墓碑**（原来这里调了 pruneTombstones）。
  //    清理是"删除会复活"这个 bug 的成因：对端超过清理期限没同步的话，
  //    它那边的旧记录还在、这边的墓碑却没了，合并时又分不开了。
  //    而墓碑只有 76 字节/条（一万条才 ~1 MB），留着换正确性是白赚的。
  //    详见 core/sync.js 里 PRUNE_DAYS 的注释。
  persist();
  return merged;
}

export function deleteEvent(eventId) {
  const d = load();
  const out = stateOps.deleteEvent(d, eventId);   // 纯逻辑在 core
  persist();
  return out;
}

/**
 * 删除一门课（**连同它的课程事件**）。
 *
 * 逻辑在 `core/state-ops.js` 的 `deleteCourse` —— 和 iPad 本地模式（api-local.js）
 * 共用同一份：按 key 删、按 `course:<key>|…` 精确匹配伴生事件、记墓碑。
 * 这里的职责只有 load → 调 core → persist（与上面所有方法一致）。
 */
export function deleteCourse(courseKey) {
  const d = load();
  const out = stateOps.deleteCourse(d, courseKey);
  persist();
  return out;
}

export function updateSettings(patch) {
  const d = load();
  const out = stateOps.updateSettings(d, patch);   // notify 的嵌套合并在 core 里
  persist();
  return out;
}

// ---------------------------------------------------------------------------
// 闹钟（计时器 / 定时器）
//
// ⚠️ 和上面每一个方法同一个形状：load → 调 core → persist。
//    **一行业务判断都不许写在这里** —— 判定全在 core/alarms.js 与
//    core/state-ops.js 的 upsertAlarm/removeAlarm/toggleAlarm 里（三端共用一份）。
//
// ⚠️ 为什么**不**加一条 `GET /api/alarms`：网页本来就整份拉 /api/state
//    （那是它唯一的读通道），多一条读路由只会多一个"两条路返回的列表不一致"
//    的机会（而那种不一致最难查）。写路由则必须有，否则本地模式和服务端
//    没法各自落盘。
// ---------------------------------------------------------------------------

/** 新建/更新一条闹钟，回**那一条**（网页只重画受影响的那一行） */
export function saveAlarm(input) {
  const d = load();
  const { alarms, alarm } = stateOps.upsertAlarm(d, input);
  d.alarms = alarms;
  persist();
  return alarm;
}

export function deleteAlarm(alarmId) {
  const d = load();
  const before = (d.alarms || []).length;
  d.alarms = stateOps.removeAlarm(d, alarmId);
  persist();
  return { ok: true, removed: before - d.alarms.length };
}

export function toggleAlarm(alarmId, enabled) {
  const d = load();
  const { alarms, alarm } = stateOps.toggleAlarm(d, alarmId, enabled);
  d.alarms = alarms;
  persist();
  return alarm;
}

/**
 * 课表导入：写入 courses 并把每门课展开成可提醒的 events。
 * 幂等 —— 同一 courseKey 重复导入会覆盖而不是堆积。
 */
export function importCourses({ courses = [], meta = {}, mode = 'merge' }) {
  const d = load();
  const out = stateOps.importCourses(d, { courses, meta, mode });   // 纯逻辑在 core
  persist();
  return out;
}

function pad(n) { return String(n).padStart(2, '0'); }

// ⚠️ 这里原来还有 isDescendant / buildCourseStart / buildCourseEnd / mondayOf / pad
//    五份**和 core 重复的实现**（4a 把它们搬进 core/state-ops.js 后就没人调了）。
//    已成死代码，删掉 —— 留着只会让下一次改动漏改一边，然后两端行为悄悄分叉。
//    对应实现现在在：core/state-ops.js（isDescendant / buildCourseStart）、
//    core/time.js（mondayOf）。

export function resetForTests() { db = null; }

/** 清空全部日程（保留课程记录时可传 keepCourses） */
export function clearEvents(opts = {}) {
  const d = load();
  const out = stateOps.clearEvents(d, opts);
  persist();
  return out;
}

/** 从备份恢复（整体覆盖；用于换电脑迁移） */
export function restoreBackup(payload) {
  const d = load();
  const out = stateOps.restoreBackup(d, payload);
  persist();
  return out;
}

export { DB_FILE, path };
