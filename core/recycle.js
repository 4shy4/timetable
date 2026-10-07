// 回收气泡站：破裂记录的显示逻辑（纯函数，平台无关）。
//
// 为什么放 core/：`web/ui/views/recycle.js` 会 import `localStorage` 相关的东西，
// 在 Node 里没法直接测。而"符号怎么显示"是纯逻辑，值得单独测 ——
// 符号反了会让人误判"我到底是早了还是晚了"。
//
// 数据来源：事件上的 `popped['YYYY-MM-DD'] = { at, remainingMs }`
// （见 server/store.js 的 popEvent / poppedRecords）。

/**
 * 「破裂那一刻的剩余时间」→ 用户规定的记号。
 *
 * ⚠️ 符号是按**用户语义**定的，不是数学符号：
 *   · `remainingMs > 0`（时间还没到就戳破了）= **提前完成** → 显示成**负数** `-3天`
 *   · `remainingMs < 0`（拖过了才戳破）        = **拖延**     → 显示成**正数** `+2天`
 *   · `remainingMs == 0`                        = 准点       → `0`
 *
 * 用户原话："-3天==提前三天，+2天==拖延两天"。
 *
 * @param {number|null} remainingMs
 * @param {(ms:number)=>string} [humanize] 把毫秒转成"3 天"这种文字（默认用 core/countdown）
 */
export function remainingBadge(remainingMs, humanize) {
  const fmt = humanize || defaultHumanize;
  if (remainingMs == null || !Number.isFinite(Number(remainingMs))) {
    // 老数据（戳破时没记 remainingMs）—— 老实说"未记录"，不能猜成 0
    return { text: '未记录', early: false, late: false };
  }
  const ms = Number(remainingMs);
  const human = fmt(Math.abs(ms));
  if (ms > 0) return { text: `-${human}`, early: true, late: false };   // 提前
  if (ms < 0) return { text: `+${human}`, early: false, late: true };   // 拖延
  return { text: '0（准点）', early: false, late: false };
}

/** 默认的人话化：优先给"天"，再给"小时"/"分钟" */
function defaultHumanize(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} 分钟`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  return `${days} 天`;
}

/**
 * 从事件里抽出"破裂记录"，**每个事件一条**（用户要求"合并"）。
 *
 * 用户原话："合并，你很聪明" —— 重复事件戳破 5 次是**一条**记录，
 * 里面带着 5 次破裂的时间与"破裂那一刻的剩余时间"。
 *
 * 和服务端 `store.poppedRecords()` 同构，但这里用本地 events 算 ——
 * 气泡刚被戳破、界面刷新时不用再等一次网络往返。
 *
 * @param {Array} events
 * @param {(ev:object)=>any} [levelOf] 解析事件等级（视图层注入，core 不依赖调色板）。
 *   第一版我忘了给 `level` 赋值，视图里 `level.color` 直接抛
 *   `Cannot read properties of undefined` —— 核心函数要么自己算全，要么明确要求注入。
 */
export function buildPoppedRecords(events, levelOf) {
  const out = [];
  for (const e of events || []) {
    const entries = [];
    if (e.popped && typeof e.popped === 'object') {
      for (const [date, info] of Object.entries(e.popped)) {
        entries.push({
          occurrence: date,
          at: (info && info.at) || null,
          remainingMs: info && Number.isFinite(info.remainingMs) ? info.remainingMs : null,
        });
      }
    }
    // 非重复事件被戳破：用 done + poppedAt 也算一条
    if (e.done && e.poppedAt) {
      const d = new Date(e.poppedAt);
      entries.push({
        occurrence: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        at: e.poppedAt,
        remainingMs: null,
      });
    }
    if (!entries.length) continue;
    entries.sort((a, b) => String(a.occurrence).localeCompare(String(b.occurrence)));
    out.push({
      event: e,
      eventId: e.id,
      title: e.title,
      level: levelOf ? levelOf(e) : (e.level || null),
      count: entries.length,
      entries,
      lastAt: entries[entries.length - 1].at || '',
      lastOccurrence: entries[entries.length - 1].occurrence,
    });
  }
  out.sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
  return out;
}

/**
 * 把所有破裂记录摊平成"一颗泡泡一个点"，**按时间从新到旧**。
 *
 * 螺旋用它（中心 = 最新，向外 = 越老）；列表式也用它（按时间排布）。
 */
export function flattenPopped(records) {
  const flat = [];
  for (const rec of records || []) {
    for (const entry of rec.entries) {
      flat.push({
        record: rec,
        entry,
        sortKey: entry.at || `${entry.occurrence}T00:00:00`,
      });
    }
  }
  flat.sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey)));
  return flat;
}
