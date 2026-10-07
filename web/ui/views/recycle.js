// 回收气泡站：被戳破的泡泡在这里"停尸"，不再浮动。
//
// 用户原话（这一轮的完整要求）：
//   「增加回收气泡站，气泡破裂后保存为气泡站中的历史，此区域泡泡不再浮动，
//     被嵌入界面即可，且泡泡保留外观，目前我觉得该按时间从左到右从上到下排布泡泡，
//     且我认为解决位置不够的可以有两条路，一是列表式，二是缩放式。
//     注，破裂泡泡大小统一但要保存其破裂时剩余的时间，紫色泡泡显示负数即可。」
//
//   「1.还原可以有；2.合并，你很聪明」
//   两条路「你都做，用户可自选」
//   螺旋排布：中心最新 → 向外越老，装满后整体缩放（与页面缩放无关）
//
// 记号的约定（用户指定）：
//   `-3天` = **提前** 3 天完成；`+2天` = **拖延** 2 天；`0` = 准点
//
// 数据来自 `/api/recycle`（服务端 `poppedRecords()`，**每个事件一条**，合并计数）。
import { el, mount } from '../dom.js';
import * as store from '../../adapter/store.js';
import { toast } from '../toast.js';
import { emptyState } from '../viewkit.js';
import { LEVELS, levelByKey } from '../../../core/level.js';
// 纯逻辑放 core/（可单测）：符号约定、合并、摊平
import {
  remainingBadge, buildPoppedRecords, flattenPopped,
} from '../../../core/recycle.js';

const LAYOUT_KEY = 'timetable.recycle.layout';   // 'list' | 'spiral'

/**
 * 方块统一大小（用户要求"破裂泡泡大小统一"）。
 *
 * ⚠️ 这里原来是**圆形**（`BUBBLE_R = 46`，`border-radius: 50%`）——
 *    我一开始理解错了：用户画的草图里是**圆角方块**（方块里写编号），不是圆泡泡。
 *    改回方块。名字仍叫 bubble（界面/文档里"泡泡"这个词还在用），但形状是方的。
 */
const BLOCK_W = 78;
const BLOCK_H = 62;
/** 方块的对角线（仅诊断用；网格螺旋不靠它算间距）*/
const BLOCK_DIAG = Math.round(Math.hypot(BLOCK_W, BLOCK_H));

/**
 * 螺旋排布在**网格**上：横/纵每步这么大。
 *
 * ⚠️ 为什么从"连续螺旋"改成"网格螺旋"（踩过）：
 *    连续螺旋（半径 ∝ √序号、角度每步转固定值）在方块身上会**重叠** ——
 *    实测最紧的一对中心距只有 115px，而方块对角线 127px。
 *    方块下面还有"剩余时间/日期"两行，容器实际约 90px 高、比方块本身大，
 *    连续螺旋更难算准。
 *
 *    网格螺旋（用户画的草图其实就是这个 —— 方块排在格子上一圈圈绕）：
 *    · **天然不重叠**：同一环上横纵坐标都是格步长的整数倍
 *    · 间距精确可控，不需要调角度
 *    · 更贴近那张图
 */
const STEP_X = BLOCK_W + 14;
const STEP_Y = 94;   // 方块 62 + 下面两行文字 + 间隙

/** 方形螺旋（Ulam spiral）的走法：右 1 → 下 1 → 左 2 → 上 2 → 右 3 → … */
const SPIRAL_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/** 第 i 个方块的网格坐标（(0,0) = 中心 = 最新那块）*/
function spiralCell(i) {
  let x = 0;
  let y = 0;
  let d = 0;     // 当前方向
  let len = 1;   // 当前这一段走几步
  let left = 0;  // 这一段还剩几步
  for (let k = 0; k < i; k += 1) {
    if (left === 0) {
      // 每两个方向一段（1,1,2,2,3,3…）
      if (d % 2 === 0 && d > 0) len += 1;
      left = len;
      d += 1;
    }
    const dir = SPIRAL_DIRS[(d - 1 + 4) % 4];
    x += dir[0];
    y += dir[1];
    left -= 1;
  }
  return { x, y };
}

export const recycleView = {
  id: 'recycle',
  label: '回收站',
  icon: '🕳',

  title() { return '回收气泡站'; },
  subtitle(state) {
    const n = state.events.filter((e) => (e.popped && Object.keys(e.popped).length) || (e.done && e.poppedAt)).length;
    return n ? `${n} 条记录` : '还没有戳破过泡泡';
  },

  nav() {
    const layout = localStorage.getItem(LAYOUT_KEY) || 'list';
    return [
      { label: layout === 'list' ? '列表式' : '螺旋式', action: 'toggle-layout', className: 'today-btn' },
      { label: '全部还原', action: 'restore-all', className: 'danger-btn' },
    ];
  },

  onNav(action, ctx) {
    if (action === 'toggle-layout') {
      const next = (localStorage.getItem(LAYOUT_KEY) || 'list') === 'list' ? 'spiral' : 'list';
      localStorage.setItem(LAYOUT_KEY, next);
      ctx.refresh();
      return;
    }
    if (action === 'restore-all') {
      restoreAll(ctx);
    }
  },

  render(state, ctx, host) {
    const layout = localStorage.getItem(LAYOUT_KEY) || 'list';
    // 先从本地 state 里取出有破裂记录的事件（不用等接口），再渲染。
    const records = buildPoppedRecords(state.events, (e) => levelByKey(e.level) || LEVELS[0]);

    if (!records.length) {
      return void mount(host, emptyState({
        title: '回收气泡站是空的',
        hint: '长按气泡 2.5 秒戳破它，它就会落到这里 —— 不再浮动，但保留外观和"戳破时还剩多久"。',
      }));
    }

    const head = el('div.recycle-head', {}, [
      el('h3', { text: `共 ${records.length} 条 · ${records.reduce((n, r) => n + r.count, 0)} 次破裂` }),
      el('p.tiny', {
        text: layout === 'list'
          ? '列表式：按时间从上到下。破裂时剩余时间写在泡泡下方 — 负数是提前完成，正数是拖延。'
          : '螺旋式：中心是最新破裂的，越往外越早。装不下会自动整体缩放。',
      }),
    ]);

    mount(host, el('div.recycle-wrap', {}, [
      head,
      layout === 'list' ? renderList(records, ctx) : renderSpiral(records, ctx),
    ]));
  },
};

// ---------------------------------------------------------------------------
// 单个方块（列表和螺旋共用，保证"大小统一 + 保留外观"）
// ---------------------------------------------------------------------------

function bubbleNode(rec, ctx, opts = {}) {
  const { w = BLOCK_W, h = BLOCK_H } = opts;
  const badge = remainingBadge(rec.remainingMs);
  const color = rec.level.color;

  const node = el('div.recycle-block', {
    style: {
      '--c': color,
      width: `${w}px`,
      height: `${h}px`,
    },
    title: `${rec.title}\n破裂于 ${rec.occurrence}\n戳破时还剩 ${badge.text}`,
    onclick: () => ctx.editEvent(rec.event, new Date(rec.occurrence + 'T00:00:00')),
  }, [
    el('span.recycle-block-name', { text: rec.title }),
    // 事件合并的角标：这条事件一共被戳破了几次（用户要求"合并"）
    rec.count > 1 ? el('span.recycle-block-count', { text: `×${rec.count}` }) : null,
  ]);

  return el('div.recycle-item', {}, [
    node,
    el(`span.recycle-badge${badge.early ? '.early' : badge.late ? '.late' : ''}`, { text: badge.text }),
    el('span.recycle-when', { text: rec.occurrence.slice(5) }),
  ]);
}

// ---------------------------------------------------------------------------
// 布局 ①：列表式（泡泡按时间从上到下 / 从左到右）
// ---------------------------------------------------------------------------

/**
 * 列表式：**按破裂时间排布**（用户明确："按时间从左到右从上到下排布泡泡"）。
 *
 * ⚠️ 不是"按事件分组" —— 我第一版按事件分了三组，那是理解错了。
 *    分组信息没有丢：泡泡上带「破裂 N 次」的角标（事件合并），
 *    但**排布顺序**听时间的。
 */
function renderList(records, ctx) {
  // 摊平 + 按破裂时间从新到旧（和螺旋的"中心最新"一致）
  const flat = flattenPopped(records);

  return el('div.recycle-grid', {}, flat.map(({ record: rec, entry, sortKey }) => {
    const wrap = bubbleNode({
      title: rec.title,
      level: rec.level,
      event: rec.event,
      occurrence: entry.occurrence,
      remainingMs: entry.remainingMs,
      entryAt: entry.at,
      count: rec.count,
    }, ctx);
    // 每颗都能单独还原
    const btn = el('button.recycle-restore', {
      type: 'button',
      title: '还原这一颗',
      text: '↩',
      onclick: (e) => { e.stopPropagation(); restoreOne(rec.eventId, entry.occurrence, ctx, rec.title); },
    });
    wrap.appendChild(btn);
    wrap.dataset.sortKey = sortKey;
    return wrap;
  }));
}

// ---------------------------------------------------------------------------
// 布局 ②：螺旋式（中心最新 → 向外越老，装满自动整体缩放）
// ---------------------------------------------------------------------------

function renderSpiral(records, ctx) {
  // 摊平成"每颗破裂一个点"，按时间**从新到旧**（中心最新）
  const points = flattenPopped(records).map(({ record: rec, entry }) => ({
    title: rec.title,
    level: rec.level,
    event: rec.event,
    occurrence: entry.occurrence,
    remainingMs: entry.remainingMs,
    count: rec.count,
  }));

  const layer = el('div.recycle-spiral-layer');
  const stage = el('div.recycle-spiral', {}, [
    layer,
    el('div.recycle-spiral-hint', { text: '中心 = 最新 · 向外 = 越早' }),
  ]);

  /**
   * 摆位 + 自动缩放（**网格螺旋**）。
   *
   * ⚠️ 关键：**不要**用 stage 的实际尺寸来算布局 —— 那会变成循环依赖
   *    （布局决定高度 → 高度决定布局），实测结果是"最新那块"被摆到了容器底部、
   *    而不是正中心。
   *
   * 改成单向：
   *   ① 先按数量算出**固有**尺寸（与容器无关）
   *   ② 用外层给定宽度算缩放比（装不下就整体缩小）
   *   ③ 用缩放后的尺寸设 stage 高度，再把整层居中
   */
  function layout() {
    // ① 固有尺寸：把网格坐标换算成像素，求出外接矩形的半径
    const cells = points.map((p, i) => {
      const c = spiralCell(i);
      return { p, x: c.x * STEP_X, y: c.y * STEP_Y };
    });
    let need = 0;
    for (const c of cells) {
      need = Math.max(need, Math.abs(c.x) + BLOCK_W / 2, Math.abs(c.y) + STEP_Y / 2);
    }
    need += 10;

    // ② 可用宽度 → 缩放比
    const availW = Math.max(240, stage.parentElement ? stage.parentElement.clientWidth : window.innerWidth - 80);
    const scale = Math.min(1, (availW / 2) / need);

    // ③ 整层以容器为参照居中（用 transform 而不是算 left/top，缩放时不会跑偏）
    const span = need * 2;
    layer.style.width = `${span}px`;
    layer.style.height = `${span}px`;
    layer.style.left = '50%';
    layer.style.top = '0';
    layer.style.transform = `translate(-50%, 0) scale(${scale.toFixed(3)})`;
    layer.style.transformOrigin = 'center top';

    const items = cells.map(({ p, x, y }, i) => {
      const node = bubbleNode({
        title: p.title,
        level: p.level,
        event: p.event,
        occurrence: p.occurrence,
        remainingMs: p.remainingMs,
        count: p.count,
      }, ctx);
      node.style.position = 'absolute';
      // 以层中心为原点摆放（层本身已经居中 + 缩放过了）
      node.style.left = `${need + x - BLOCK_W / 2}px`;
      node.style.top = `${need + y - STEP_Y / 2}px`;
      node.style.zIndex = String(1000 - i);   // 新的压在旧的上面
      return node;
    });
    mount(layer, items);
    // 高度按**缩放后**的尺寸给，装不下时容器不会撑得过高
    stage.style.height = `${Math.max(360, span * scale + 40)}px`;
  }

  // 首次渲染 + 尺寸变化时重排
  requestAnimationFrame(() => {
    layout();
    const ro = new ResizeObserver(() => layout());
    ro.observe(stage);
  });

  return stage;
}

// ---------------------------------------------------------------------------
// 还原
// ---------------------------------------------------------------------------

async function restoreOne(eventId, occurrence, ctx, title) {
  try {
    await store.restorePopped(eventId, occurrence ? { occurrence } : {});
    toast({
      title: occurrence ? '已还原这一颗' : `「${title}」全部还原`,
      body: '它回到气泡区了',
      timeout: 2200,
    });
    ctx.refresh();
  } catch (err) {
    toast({ title: '还原失败', body: err.message, kind: 'err' });
  }
}

async function restoreAll(ctx) {
  const events = ctx.state.events.filter((e) => (e.popped && Object.keys(e.popped).length) || (e.done && e.poppedAt));
  if (!events.length) return;
  try {
    for (const e of events) await store.restorePopped(e.id, {});
    toast({ title: `已还原 ${events.length} 条`, kind: 'ok' });
    ctx.refresh();
  } catch (err) {
    toast({ title: '还原失败', body: err.message, kind: 'err' });
  }
}
