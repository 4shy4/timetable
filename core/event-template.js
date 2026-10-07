// 「批量生成同质泡泡」+「套用母泡泡参数」—— 两条规则本体，**平台无关**。
//
// 用户第 44 轮点名要的两个功能（原文在 docs/IOS-TODO.md）：
//   1. 批量产生同质化泡泡：几个参数相同的泡泡，方便批量设计任务（哪些参数可选）
//   2. 母泡泡模板：在母泡泡内部添加的子泡泡可以选择套用母泡泡的参数生成（哪些参数可选）
//
// 为什么放在 core 而不是编辑器里（这个项目的老规矩）：
//   · "哪些字段能被复制/被继承" 是一个**字段清单**，它同时决定了编辑器的 UI（勾选框）
//     和生成出来的数据。写死在 UI 里，将来加一个字段就会漏掉它 —— 而且没人会发现。
//   · 这两件事最后都要走服务端同一份 `upsertEvent` 校验（等级套娃、期限、提醒），
//     所以本体必须是纯函数、能被单元测试直接钉住。
//
// ⚠️ 这个模块必须保持平台无关（core/ 的规矩，tools/core.test.mjs 守着）：
//    不碰 document / window / localStorage / node:*。所有"界面上的选择"由调用方传进来。

import { LEVELS, allowedChildLevels, rankOf } from './level.js';
// ⚠️ `levelOf` 在 core 里有**两份**（urgency.js 和 state-ops.js，语义一样但实现各写了一遍）。
//    这里跟**编辑器**用同一份（urgency.js），保证"母泡泡是什么颜色"两边判断一致 ——
//    挑错那一份正是当年"红色容器的子气泡只能选蓝"那个 bug 的来源。
import { levelOf } from './urgency.js';

/** 一次最多批量生成多少条（防手滑：输入框里敲个 5000 会把服务和界面一起拖死） */
export const BATCH_MAX = 50;

/**
 * 批量生成的三个旋钮 —— 界面上就是这三样。
 *
 * ⚠️ 只有这三样是"可选"的：用户问过"哪些参数可选"。
 *    答案是**其余参数全都相同**（那才是"同质化"的意思），差别只可能在
 *    时间（总要错开吧）、标题（不然一模一样分不清）、数量。
 */
export const BATCH_KNOBS = Object.freeze([
  { key: 'count', label: '一次生成几个', hint: '1 = 就是普通的一条' },
  { key: 'gapMinutes', label: '每隔多久', hint: '0 = 同一时段（全部同一时刻）' },
  { key: 'numberTitles', label: '标题加序号', hint: '勾上 → "交作业 1 / 交作业 2…"' },
]);

/** 每个间隔单位是多少分钟（界面上的下拉） */
export const GAP_UNITS = Object.freeze([
  { key: 'minute', label: '分钟', minutes: 1 },
  { key: 'hour', label: '小时', minutes: 60 },
  { key: 'day', label: '天', minutes: 60 * 24 },
]);

/**
 * 子气泡可以从母泡泡**套用**的字段清单（用户问的"哪些参数可选"就是这一份）。
 *
 * ⚠️ `level`（颜色/等级）**故意不在里面**：套娃规则要求子级**严于**父容器
 *    （core/level.js 的 canNestInside），照抄母泡泡的等级会被服务端直接拒掉。
 *    编辑器的颜色默认值已经取"容器允许的最大档"，这里不参与。
 */
export const PARENT_TEMPLATE_FIELDS = Object.freeze([
  { key: 'time', label: '和母泡泡同一时段', hint: '开始/结束都照母泡泡的来' },
  { key: 'duration', label: '时长（结束 = 开始 + 母泡泡的时长）', hint: '开始时间还是自己填' },
  { key: 'location', label: '地点' },
  { key: 'notes', label: '备注' },
  { key: 'teacher', label: '老师' },
  { key: 'type', label: '类别（个人/任务/活动/课程）' },
  { key: 'reminders', label: '提醒（含"自动提醒"和"到点用真闹钟"）' },
]);

/** 默认勾上的：常用的那几项（时间不默认，因为子任务通常有自己的时间） */
export const PARENT_TEMPLATE_DEFAULTS = Object.freeze(
  PARENT_TEMPLATE_FIELDS.map((f) => f.key).filter((k) => k !== 'time'),
);

/** 间隔单位换算成分钟；认不出来就当中文里的"分钟" */
export function unitMinutes(unit) {
  const u = GAP_UNITS.find((x) => x.key === unit);
  return u ? u.minutes : 1;
}

/** 夹一个整数（界面上填 0 / 空 / 乱七八糟的东西都不该炸） */
function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** 本地时间戳（和编辑器、core/time.js 的写法一致：不带时区的本地时间） */
function stampOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function msOf(s) {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 两个时间戳之间差多少毫秒（结束 - 开始）；拿不到就给 1 小时 */
export function durationMsOf(payload) {
  const a = msOf(payload && payload.start);
  const b = msOf(payload && payload.end);
  if (a == null) return 3600_000;
  if (b == null || b <= a) return 3600_000;
  return b - a;
}

/**
 * 把一条"草稿"铺成 N 条**同质**的草稿。
 *
 * @param {object} payload 编辑器准备好的那条（字段和 `store.saveEvent` 要的一样）
 * @param {object} opts
 * @param {number} [opts.count] 几条（1 = 原样返回一条）
 * @param {number} [opts.gapMinutes] 每条之间隔多少分钟（0 = 同一时段）
 * @param {boolean} [opts.numberTitles] 标题要不要加序号
 * @returns {Array<object>} 新数组；**原对象不会被改**（纯函数）
 */
export function batchDrafts(payload, { count = 1, gapMinutes = 0, numberTitles = true } = {}) {
  const n = clampInt(count, 1, BATCH_MAX, 1);
  const gap = clampInt(gapMinutes, 0, 60 * 24 * 365, 0);
  const out = [];
  const startMs = msOf(payload && payload.start);
  const dur = durationMsOf(payload);
  const baseTitle = String((payload && payload.title) || '').trim();

  for (let i = 0; i < n; i += 1) {
    const one = { ...payload };
    // ⚠️ 每一条都必须是**新对象**，而且 id 要清掉：
    //    留着上一轮的 id 会让服务端"更新那一条"而不是新建（第一条就没有 id，
    //    但调用方可能拿一个已有事件来铺 —— 那时候不清 id 就会把同一条改 N 次）。
    delete one.id;
    if (n > 1 && numberTitles) {
      // 序号从 1 开始；标题为空时不加（让上层自己的必填校验去报错）
      one.title = baseTitle ? `${baseTitle} ${i + 1}` : baseTitle;
    }
    if (startMs != null && gap > 0) {
      const s = startMs + i * gap * 60_000;
      one.start = stampOf(s);
      one.end = stampOf(s + dur);
    } else if (startMs != null) {
      // 同一时段：照原样（但把结束补成"开始 + 时长"，免得 N 条里有的没结束）
      one.start = stampOf(startMs);
      one.end = stampOf(startMs + dur);
    }
    out.push(one);
  }
  return out;
}

/**
 * 把母泡泡的参数**套用**到一条子气泡草稿上。
 *
 * @param {object} payload 子气泡草稿（编辑器准备好的）
 * @param {object} parent 母泡泡（一条正常的事件）
 * @param {object} opts
 * @param {string[]} [opts.fields] 要套用哪几项（`PARENT_TEMPLATE_FIELDS` 里的 key）
 * @returns {object} 新的草稿；**原对象不会被改**
 */
export function applyParentTemplate(payload, parent, { fields = PARENT_TEMPLATE_DEFAULTS } = {}) {
  if (!parent) return { ...payload };
  const want = new Set(Array.isArray(fields) ? fields : []);
  const one = { ...payload };

  if (want.has('time')) {
    // 同一时段：连日期一起照搬（"和母泡泡同一天同一段"）
    if (parent.start) one.start = parent.start;
    if (parent.end) one.end = parent.end;
  }
  if (want.has('duration')) {
    const s = msOf(one.start) ?? msOf(parent.start);
    if (s != null) one.end = stampOf(s + durationMsOf(parent));
  }
  if (want.has('location')) one.location = parent.location || '';
  if (want.has('notes')) one.notes = parent.notes || '';
  if (want.has('teacher')) one.teacher = parent.teacher || '';
  if (want.has('type') && parent.type) one.type = parent.type;
  if (want.has('reminders')) {
    one.reminders = Array.isArray(parent.reminders) ? [...parent.reminders] : [];
    // ⚠️ 这两个是**提醒的一部分**，必须跟 reminders 一起搬：
    //    只搬 reminders 而 autoReminders=true 的话，服务端会按剩余时间重新生成，
    //    用户看到的"套用了母泡泡的提醒"其实没生效（那种"设了没反应"最难查）。
    one.autoReminders = parent.autoReminders !== false;
    one.alarm = parent.alarm === true;
  }

  // 收尾：颜色必须**严于**母容器 —— 不照抄，只在允许的档里收窄
  const allowed = allowedChildLevels(levelOf(parent)).map((l) => l.key);
  if (allowed.length && !allowed.includes(one.level)) {
    // 取允许范围内**最接近**的那一档（比它大的都允许时，取最大；否则取最近的）
    const rank = rankOf(one.level);
    const sorted = allowed.slice().sort((a, b) => rankOf(a) - rankOf(b));
    one.level = rank > rankOf(sorted[sorted.length - 1]) ? sorted[sorted.length - 1] : sorted[0];
  }
  return one;
}

/**
 * 给界面用的一句话预览（"将生成 3 条 · 每隔 30 分钟 · 标题加序号"）。
 * 放在 core 里是为了和 batchDrafts 的**同一套夹取规则**保持一致 ——
 * 界面显示的和真正生成的不一样，是最容易骗到用户的那种 bug。
 */
export function describeBatch({ count = 1, gapMinutes = 0, numberTitles = true, unit = 'minute' } = {}) {
  const n = clampInt(count, 1, BATCH_MAX, 1);
  const gap = clampInt(gapMinutes, 0, 60 * 24 * 365, 0);
  if (n <= 1) return '就一条（想批量就把数量调到 2 以上）';
  const parts = [`将生成 ${n} 条`];
  if (gap > 0) parts.push(`每隔 ${gap} ${(GAP_UNITS.find((u) => u.key === unit) || GAP_UNITS[0]).label}`);
  else parts.push('同一时段');
  parts.push(numberTitles ? '标题加序号' : '标题都一样');
  return parts.join(' · ');
}

/** 四档等级表（界面画颜色按钮/预览用；和 core/level.js 是同一份） */
export function levelTable() {
  return LEVELS.map((l) => ({ key: l.key, label: l.label, color: l.color }));
}
