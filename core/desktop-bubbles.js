// 「Windows 桌面气泡层」要画什么 —— 一个**纯数据**模块。
//
// ⚠️⚠️ 为什么要有它（这是这个项目一直在守的那条线）：
//   Windows 那边是一个原生窗口（C# / WPF），它**只负责画**。
//   "哪些泡泡该浮出来、每颗多大、什么颜色、文字写什么、过没过期、能不能装下别人"
//   全部在这里算 —— 用的还是网页端同一份 core（`selectBubbleItems` + `core/urgency.js`
//   的 `bubbleStyle` + `core/level.js` 的档位/套娃规则）。
//
//   绝不允许在 C# 里重写一遍"还剩多久 / 过没过期 / 谁能套谁"：
//   那种分叉的表现是"桌面上的泡泡和 iPad 上的说的不一样"，
//   而没人会想到去查原生那半边。iOS 壳的规矩（NotificationScheduler.swift 顶部）
//   在这里一字不改地成立：**原生只翻译，业务在 core。**
//
// ⚠️⚠️ 用户第 41 轮的原话（形态就是照它做的，改之前先读一遍）：
//   "我就是要铺满全屏的透明层，只不过我要气泡区的模式，有双击，有长按，有单击，
//    有母泡泡背景（这次就得像你之前那样搞一个圈圈，拿出去就拿到平级了），
//    只不过背景我要虚化而不挡住壁纸。桌面气泡的显示与软件气泡区设置保持一致"
//
//   对应到这里的三件事：
//     ① **全屏一层**、空白处**点透**（原生那侧的事，见 DesktopBubbles.cs）
//     ② **和软件气泡区同一份显示设置**：`settings.bubbleView`（= 网页那三个开关），
//        默认值也必须和网页一样（14 天 / 显示课程 / 不显示已完成）——
//        这就是 `BUBBLE_VIEW_DEFAULTS`，它和 `web/ui/views/bubble.js` 的 readConfig 一一对应
//     ③ **母泡泡背景那一圈**：`parentId` 是"当前在第几层容器"（和网页同名的概念），
//        进到容器里就给出 `view.container`，原生照着画圈、算"拖出去 = 平级"
//
// 输出形状（就是 JS ↔ 原生窗口的契约，改字段要两边一起改）：
//   { generatedAt, count, canvas:{width,height},
//     view:{ parentId, path:[…], container: null | {…} },
//     messages:{…}, bubbles:[{ id, key, title, countdown, when, location, r, seed,
//       fill, fillLight, fillDark, edge, text, ring, overdue, inheritedOverdue,
//       levelKey, dimmed, canHold, childLevels }] }

import { selectBubbleItems } from './bubble-select.js';
import { BUBBLE_VIEW_DEFAULTS } from './bubble-select.js';
import { hhmm } from './time.js';
import { LEVELS, allowedChildLevels, isLeafLevel, levelByKey, rankOf } from './level.js';
import { isOverdueEvent, levelOf } from './state-ops.js';
import {
  tierByKey, tierTextColor, radiusRangeForCanvas, areaScaleForCanvas, mixColor,
  OVERDUE_COLOR, OVERDUE_EDGE,
} from './palette.js';

/**
 * 桌面气泡的显示设置**默认值和网页气泡区一模一样**（真值就在 core，见那里的说明）。
 *
 * ⚠️ 用户明确要求"桌面气泡的显示与软件气泡区设置保持一致"，
 *    所以这里不能有"桌面更短、桌面不显示课程"这类自作聪明的默认值 ——
 *    那样表现就是"桌面上少了几颗"，而且没人会想到去查默认值。
 */
export { BUBBLE_VIEW_DEFAULTS };

/**
 * 安全阀，不是显示策略：真超过这么多颗，WPF 那侧的物理模拟会开始卡。
 * （网页气泡区没有上限，所以这里给得很大 —— 正常用量碰不到。）
 */
export const DEFAULT_MAX_BUBBLES = 60;

/** 从 id 稳定地算一个 0..1 的数（原生侧拿它定初始位置和漂浮方向，刷新后不会乱跳） */
export function stableSeed(id) {
  const s = String(id || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // 取无符号后归一到 0..1
  return ((h >>> 0) % 100000) / 100000;
}

/** 正数才认，否则回答默认值（设置里一个脏值不该把气泡区弄空） */
function positiveInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * 把 `settings` 里的"气泡区显示设置"和"桌面专属微调"解析出来。
 *
 * ⚠️ 分成两拨，别混：
 *   · `bubbleView`（网页那三个开关）→ **必须**和软件里一致
 *   · `desktopBubbles`（`max` / `scale`）→ 只影响桌面这一层的物理与手感
 */
export function resolveBubbleView(settings = {}) {
  const view = (settings && settings.bubbleView) || {};
  const pref = (settings && settings.desktopBubbles) || {};
  return {
    horizonDays: positiveInt(view.horizonDays, BUBBLE_VIEW_DEFAULTS.horizonDays),
    // 这两个是布尔：**只有显式的 false / true 才算数**，缺省回到和网页一样的默认
    showCourse: view.showCourse === false ? false : BUBBLE_VIEW_DEFAULTS.showCourse,
    showDone: view.showDone === true ? true : BUBBLE_VIEW_DEFAULTS.showDone,
    // 节日气泡：还剩几天时浮出来（和软件里同一份设置）
    festivalDays: Number.isFinite(Number(view.festivalDays)) && Number(view.festivalDays) >= 0
      ? Math.min(60, Math.floor(Number(view.festivalDays))) : BUBBLE_VIEW_DEFAULTS.festivalDays,
    max: Number.isFinite(Number(pref.max)) && Number(pref.max) > 0
      ? Math.floor(Number(pref.max)) : DEFAULT_MAX_BUBBLES,
    scale: Number(pref.scale) > 0 ? Math.min(1.4, Math.max(0.4, Number(pref.scale))) : 1,
  };
}

/**
 * 算出"这一刻桌面上该浮哪些泡泡、每颗长什么样"。
 *
 * @param {Array} events 全部日程
 * @param {object} opts
 * @param {object} [opts.settings] 当前设置（`termStart` / `bubbleView` / `desktopBubbles`）
 * @param {Date}   [opts.now]
 * @param {number} [opts.width] 画布宽（DIP；决定半径上限，和网页同一套曲线）
 * @param {number} [opts.height] 画布高
 * @param {string|null} [opts.parentId] 当前在第几层容器里（null = 最外层）——
 *        和网页气泡区的 `currentParentId()` 是同一个概念，所以"双击进去"在两端表现一致
 * @returns {{generatedAt:string, count:number, canvas:object, view:object, messages:object, bubbles:Array}}
 */
export function buildDesktopBubbles(events = [], {
  settings = {}, now = new Date(), width = 1600, height = 900, parentId = null,
} = {}) {
  const cfg = resolveBubbleView(settings);

  const canvas = {
    width: Math.max(320, Math.floor(Number(width) || 1600)),
    height: Math.max(240, Math.floor(Number(height) || 900)),
  };

  // 当前容器（套娃那一层）。幽灵 id（容器已经被删了）→ 当作最外层，
  // 不能拿它去画一个"不存在的母泡泡"。
  const containerEvent = parentId ? events.find((e) => e.id === parentId) || null : null;
  const effectiveParentId = containerEvent ? containerEvent.id : null;

  const items = selectBubbleItems(events, {
    now,
    termStart: (settings && settings.termStart) || '',
    parentId: effectiveParentId,
    horizonDays: cfg.horizonDays,
    showCourse: cfg.showCourse,
    showDone: cfg.showDone,
    // 节日气泡：和软件里同一份设置（默认 4 天）
    festivalDays: cfg.festivalDays,
    max: cfg.max,
  });

  // 半径用**和网页同一套**的换算（core/palette 的 radiusRangeForCanvas），
  // 所以"还剩一天"的泡泡在桌面上和在 iPad 上是一样大的。
  const { min: minR, max: maxR } = radiusRangeForCanvas(canvas.width, canvas.height);
  // 泡泡太多/太大时整体缩一档 —— 用的是网页同一个面积预算函数
  const areaScale = areaScaleForCanvas(
    items.map((it) => minR + (maxR - minR) * (Number(it.style && it.style.radiusRatio) || 0)),
    canvas.width, canvas.height,
  ) * cfg.scale;

  const bubbles = items.map((it) => {
    const st = it.style || {};
    const tierKey = st.tierKey || st.levelKey || 'sky';
    const tier = tierByKey(tierKey) || { color: '#38bdf8', colorDeep: '#0284c7' };
    const ownOverdue = !!st.ownOverdue;
    const inheritedOverdue = !!st.overdueInherited;
    // 自己过期 → 泡体暗紫（和网页同一个常量）
    // ⚠️ 存在 st.tier.color 就用它：节日气泡的**专用颜色**就是通过 style.tier 覆盖的，
    //    这里要是读 tierByKey(tierKey).color，节日就会退成普通的红（#ef4444）。
    const tierColor = (st.tier && st.tier.color) || tier.color;
    const base = ownOverdue ? OVERDUE_COLOR : tierColor;
    const r = minR + (maxR - minR) * Math.max(0, Math.min(1, Number(st.radiusRatio) || 0));
    const level = levelByKey(levelOf(it.event));
    return {
      id: it.event.id,
      // 事件 id + 这次发生的日期：同一颗泡泡刷新前后要能对上（原生侧靠它保住位置）
      key: it.key,
      title: String(it.event.title || '(无标题)'),
      countdown: String(st.countdownText || ''),
      when: whenText(it),
      location: String(it.event.location || ''),
      r: Math.round(r * areaScale),
      seed: stableSeed(it.key),
      // 颜色（原生侧直接填椭圆；渐变用 fillLight → fill → fillDark）
      fill: base,
      fillLight: mixColor(base, '#ffffff', 0.42),
      fillDark: mixColor(base, '#0b1220', 0.45),
      edge: ownOverdue ? OVERDUE_EDGE : mixColor(base, '#0b1220', 0.25),
      // 过期时泡体是暗紫 → 用白字；否则按对比度算（和网页同一个函数）
      text: ownOverdue ? '#ffffff' : tierTextColor(tierKey),
      // 「容器过期」那圈暗紫虚线（自己没过期、只是母泡泡过期）——
      // null = 不画。原生侧按它决定要不要套那圈环。
      ring: inheritedOverdue ? OVERDUE_COLOR : null,
      overdue: !!st.overdue,
      ownOverdue,
      inheritedOverdue,
      levelKey: tierKey,
      dimmed: !!st.dimmed,
      // 「戳破」（长按 2.5 秒）要**按实例记账**：服务端 popEvent 需要这一颗的日期
      // 和"戳破时还剩多久"（回收气泡站会显示它）。两者都由 core 算好、原生只是回传，
      // 绝不在 C# 里重算"还剩多久"。
      occurrence: (it.key.indexOf('@') >= 0 ? it.key.slice(it.key.indexOf('@') + 1) : null),
      remainingMs: Number.isFinite(Number(st.remaining)) ? Number(st.remaining) : null,
      // 双击能不能进去：蓝色（最小档）装不下东西，双击只抖一下（网页同一句提示）
      canHold: !isLeafLevel(tierKey),
      // **谁能装下它**由 core 算好交给原生，绝不在 C# 里重写"红>黄>绿>蓝"：
      // 这几档等级可以放进这颗泡泡里（core/level.js 的 allowedChildLevels）
      childLevels: allowedChildLevels(tierKey).map((l) => l.key),
      // 「快速编辑框」里能把这颗事件改成哪几档 —— 也是 core 算的：
      //   · 有父容器 → 必须比父容器小
      //   · 自己装了子气泡 → 不能把自己降到比子气泡还小（服务端也会拒）
      // 原生只照着这几个按钮画，不自己判断"哪一档合法"。
      levelOptions: levelOptionsFor(it.event, events),
      // ⚠️ 这里**故意没有** `done`：`showDone` 已经保证完成的不会进来，
      //    带上它就是一个"原生永远读到 false"的死字段。
      //    （是 tools/desktop-bubbles.test.mjs 那条"两端字段必须一致"的契约测试抓出来的）
    };
  });

  return {
    generatedAt: new Date(now).toISOString(),
    count: bubbles.length,
    canvas,
    // 四档等级的**键/名字/颜色**（核心数据，`core/level.js` 那一份）——
    // 桌面那个"快速编辑框"要拿它画等级按钮，而不是在 C# 里再抄一组颜色。
    levels: LEVELS.map((l) => ({ key: l.key, label: l.label, color: l.color })),
    view: buildView(containerEvent, events, now),
    messages: MESSAGES,
    bubbles,
  };
}

/**
 * 这颗事件**能改成哪几档**（快速编辑框里画几个按钮）。
 *
 * ⚠️ 这段判断必须留在 core：它是"套娃等级"这条规则的一部分，
 *    和 `canNestInside` / `allowedChildLevels` 是同一件事的三种问法。
 *    写进 C# 就又是"两条路径迟早不一致"。
 */
function levelOptionsFor(ev, events) {
  const parent = ev.parentId ? events.find((e) => e.id === ev.parentId) : null;
  const parentRank = parent ? rankOf(levelOf(parent)) : Number.POSITIVE_INFINITY;
  const kids = events.filter((c) => c.parentId === ev.id);
  const minKidRank = kids.length
    ? Math.max.apply(null, kids.map((c) => rankOf(levelOf(c))))
    : -1;
  return LEVELS
    .filter((l) => l.rank < parentRank && l.rank > minKidRank)
    .map((l) => l.key);
}

/**
 * 当前这一层的"母泡泡"信息（原生拿它画那个圈圈）+ 面包屑。
 *
 * ⚠️ 过期容器**只读**（能进去看，不能往里加子泡泡）—— 判据必须用 core 的
 *    `isOverdueEvent`，和"画成紫色"用的是同一个函数，否则会出现
 *    "看着是紫的、逻辑却认为没过期"这种两条路径不一致的老毛病。
 */
function buildView(containerEvent, events, now) {
  if (!containerEvent) {
    return { parentId: null, path: [], container: null, hint: '' };
  }
  const level = levelByKey(levelOf(containerEvent));
  const overdue = isOverdueEvent(containerEvent, events, now);
  const base = overdue ? OVERDUE_COLOR : level.color;

  // 面包屑：从最外层一路到当前容器（外层在前）——原生拿它画"我在哪一层"
  const path = [];
  let cur = containerEvent;
  let guard = 0;
  while (cur && guard < 32) {
    const lv = levelByKey(levelOf(cur));
    const od = isOverdueEvent(cur, events, now);
    path.unshift({ id: cur.id, title: String(cur.title || '(无标题)'), levelKey: lv.key, fill: od ? OVERDUE_COLOR : lv.color });
    cur = cur.parentId ? events.find((e) => e.id === cur.parentId) || null : null;
    guard += 1;
  }

  return {
    parentId: containerEvent.id,
    path,
    container: {
      id: containerEvent.id,
      title: String(containerEvent.title || '(无标题)'),
      levelKey: level.key,
      fill: base,
      fillLight: mixColor(base, '#ffffff', 0.42),
      fillDark: mixColor(base, '#0b1220', 0.45),
      edge: overdue ? OVERDUE_EDGE : mixColor(base, '#0b1220', 0.25),
      // 容器过期 → 泡壁画成**虚线**（和网页 .bubble-inside-overdue 一致）
      overdue,
      // 只读：过期容器不能往里面加子气泡（判据同上，不另写一份）
      readOnly: overdue,
      // 往这个容器里新建子气泡时**能选哪几档**（和上面每颗泡泡的 childLevels 同一份规则）
      childLevels: allowedChildLevels(level.key).map((l) => l.key),
      // 目的地：拖出去之后会落到哪一层（没有祖父 = 最外层）。
      // 原生只用它做提示文字，真正的归属由服务端 PATCH 决定。
      escapeTo: containerEvent.parentId
        ? (events.find((e) => e.id === containerEvent.parentId) || null)
        : null,
    },
    hint: overdue
      ? '这个紫泡泡过期了，只能看看 · 拖动气泡到别的气泡上可放进去 · 拖到圈外就是拉出来 · 双击背景出去'
      : '单击背景加子气泡 · 拖动气泡到别的气泡上可放进去 · 拖到圈外就是拉出来 · 双击背景出去',
  };
}

/**
 * 原生那侧要说的几句人话。
 *
 * ⚠️ 放在这里（而不是 C# 里 hardcode）的理由：这些话是**规则的解释**，
 *    规则本身在 core；哪天规则变了，"解释"必须跟着变。
 *    措辞和网页气泡区的提示保持一致（用户要的就是两端一样）。
 */
const MESSAGES = Object.freeze({
  cannotEnterLeaf: '元泡泡无法添加泡泡了哦·-·',
  cannotEnterLeafBody: '最小档的泡泡装不下东西，双击只抖一下',
  cannotNest: '放不进去 —— 它比这个泡泡小，装不下',
  cannotNestOverdue: '紫色气泡不能套 —— 过期了的气泡不能放进去，也不能被放进去',
  nested: '已放进气泡',
  escaped: '已拉出来 —— 现在和母气泡平级',
  pop: '戳破了 —— 里面的子气泡已经放出来',
});

/** 「周五 15:32」/「09:02」——重复事件才带周几（和网页上那行字一致） */
function whenText(item) {
  const t = hhmm(item.start);
  const wd = item.style && item.style.weekdayLabel;
  return wd ? `周${wd} ${t}` : t;
}
