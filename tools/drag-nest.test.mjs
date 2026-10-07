// 拖拽放入气泡的规则测试。
//
// 规则（用户定）：
//   · 红最大、蓝最小；小的能进大的
//   · 过期的紫色气泡**不能进**，也不许装东西
//   · 子气泡拖出母气泡边界 = 拉出来（平级）
// 同一条规则有两处执行：界面拖拽判定，和服务端校验。
// 这里把"判定表"钉死，避免改动后两边不一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { canNestInside, rankOf, LEVELS, isLeafLevel } from '../core/level.js';

const RANK = ['sky', 'emerald', 'amber', 'red'];

test('颜色层级：红 > 黄 > 绿 > 蓝（rank 递增）', () => {
  assert.deepEqual(LEVELS.map((l) => l.rank), [0, 1, 2, 3]);
  assert.equal(rankOf('red') > rankOf('amber'), true);
  assert.equal(rankOf('amber') > rankOf('emerald'), true);
  assert.equal(rankOf('emerald') > rankOf('sky'), true);
});

test('小的能进大的：完整判定表（入参顺序 parent, child）', () => {
  // 期望：child 的 rank 必须严格小于 parent 的 rank
  const expect = (p, c) => rankOf(c) < rankOf(p);
  for (const p of RANK) {
    for (const c of RANK) {
      assert.equal(
        canNestInside(p, c),
        expect(p, c),
        `parent=${p} child=${c} 期望 ${expect(p, c)}`,
      );
    }
  }
});

test('同级不能互相嵌套（红进不了红）', () => {
  for (const k of RANK) {
    assert.equal(canNestInside(k, k), false, `${k} 不该能进 ${k}`);
  }
});

test('蓝色（最小）进不了任何东西，任何东西都能进红色', () => {
  assert.equal(isLeafLevel('sky'), true);
  for (const p of RANK) {
    assert.equal(canNestInside(p, 'sky'), p !== 'sky', `蓝进 ${p} 的判定`);
  }
  for (const c of RANK) {
    assert.equal(canNestInside('red', c), c !== 'red', `红装 ${c} 的判定`);
  }
});

test('能不能"进"与过期无关 —— 过期是在这之上单独一条规则', () => {
  // 界面上是：先看过期（紫），过期直接拒绝，不再走层级判定。
  // 这里确认层级判定本身不掺过期逻辑，免得以后有人把它塞进去。
  const fnStr = canNestInside.toString();
  assert.doesNotMatch(fnStr, /overdue/i, 'canNestInside 不该知道 overdue');
});

test('拖出母气泡的判定：越过边界 1.05 倍才算（留一点死区，避免贴边误判）', () => {
  // 复刻界面上的判定：dist = hypot(x-cx, y-cy); 出去 = dist > r * OUT_MARGIN
  const g = { cx: 500, cy: 300, r: 200 };
  const MARGIN = 1.05;
  const isOut = (x, y) => Math.hypot(x - g.cx, y - g.cy) > g.r * MARGIN;
  assert.equal(isOut(500, 300), false, '圆心处当然没出去');
  assert.equal(isOut(500, 480), false, '距 180 < 210，还在里面');
  assert.equal(isOut(500, 500), false, '距 200，正好在线上 —— 仍算里面（死区）');
  assert.equal(isOut(500, 520), true, '距 220 > 210，拖出去了');
  assert.equal(isOut(740, 300), true, '横向拖出去也算（距 240）');
  assert.equal(isOut(100, 100), true, '拖到角落肯定算出去');
});

test('母气泡半径保证整圆在画布内（否则某一侧没有"外面"可拖）', () => {
  // 复刻 parentBubbleGeom：r = min(w,h) * 0.42, cy = h/2 + 6
  const geom = (w, h) => ({ cx: w / 2, cy: h / 2 + 6, r: Math.min(w, h) * 0.42 });
  for (const [w, h] of [[1260, 697], [400, 320], [1600, 900], [900, 1400]]) {
    const g = geom(w, h);
    assert.ok(g.cy - g.r >= 0, `上边要被裁了 w=${w} h=${h}: ${g.cy - g.r}`);
    assert.ok(g.cy + g.r <= h, `下边要被裁了 w=${w} h=${h}: ${g.cy + g.r} > ${h}`);
    assert.ok(g.cx - g.r >= 0, `左边要被裁了 w=${w}`);
    assert.ok(g.cx + g.r <= w, `右边要被裁了 w=${w}`);
    // 四周要留得出可见的一圈"外面"
    assert.ok((g.cy - g.r) >= h * 0.05, `上方留白太少 w=${w} h=${h}`);
  }
});

test('投放区底色 = 目的地那一层（红→绿→蓝 的完整规则）', async () => {
  // escapeColorFor 在 bubble.js 里；bubble.js 依赖 DOM，Node 里 import 不了，
  // 所以这里复刻同一份规则并钉住它 —— 规则本身是我第一版理解错的地方。
  const LEVEL_COLOR = { sky: '#38bdf8', emerald: '#22c55e', amber: '#f5b301', red: '#ef4444' };
  const escapeColorFor = (parentId, events) => {
    if (!parentId) return null;
    const parent = events.find((e) => e.id === parentId);
    const grand = parent && parent.parentId ? events.find((e) => e.id === parent.parentId) : null;
    return grand ? LEVEL_COLOR[grand.level] : 'var(--surface)';
  };

  const events = [
    { id: 'red', level: 'red', parentId: null, title: '红' },
    { id: 'green', level: 'emerald', parentId: 'red', title: '绿' },
    { id: 'blue', level: 'sky', parentId: 'green', title: '蓝' },
  ];

  // 在外面：没有"拖出去"这回事
  assert.equal(escapeColorFor(null, events), null);
  // 在绿里拖蓝 → 目的地是"红的内部" → 红
  assert.equal(escapeColorFor('green', events), '#ef4444');
  // 在红里拖绿 → 目的地是最外层 → 白（最外层底色）
  assert.equal(escapeColorFor('red', events), 'var(--surface)');
  // 在蓝里（假设蓝也能装东西）→ 目的地是绿那一层 → 绿
  assert.equal(escapeColorFor('blue', events), '#22c55e');
});

test('投放区底色：父级不存在时不要炸（脏数据兜底）', () => {
  const escapeColorFor = (parentId, events) => {
    if (!parentId) return null;
    const parent = events.find((e) => e.id === parentId);
    const grand = parent && parent.parentId ? events.find((e) => e.id === parent.parentId) : null;
    return grand ? '#x' : 'var(--surface)';
  };
  assert.equal(escapeColorFor('不存在', [{ id: 'a' }]), 'var(--surface)');
  assert.equal(escapeColorFor('a', [{ id: 'a', parentId: '也不存在' }]), 'var(--surface)');
});

// ---------------------------------------------------------------------------
// 落点判定（回归：门槛定得太高，实际上永远放不进去）
// ---------------------------------------------------------------------------

test('回归：重叠门槛必须够得着 —— 两个正常大小的气泡轻微重叠就该判为目标', () => {
  // 复刻 bestDropTarget：① 圆心在对方体内 → 命中；② 否则要求"至少盖住小球的一半"。
  //
  // 曾经用"重叠 ≥ 目标半径 × 0.8"，那个门槛**实际到不了**：
  //   半径 68 与 77 的气泡，圆心距 99 时重叠只有 46px，而门槛是 0.8×77=61.6px。
  //   除非几乎同心，否则永远判不出目标 —— 表现就是"在容器里怎么拖都放不进去"。
  const bestDropTarget = (b, bodies) => {
    let byCenter = null;
    let byOverlap = null;
    let best = 0;
    for (const o of bodies) {
      if (o === b) continue;
      const d = Math.hypot(b.x - o.x, b.y - o.y);
      if (d <= o.r && (!byCenter || o.r > byCenter.r)) byCenter = o;
      const overlap = b.r + o.r - d;
      if (overlap > 0 && overlap > best) { best = overlap; byOverlap = o; }
    }
    if (byCenter) return byCenter;
    if (byOverlap && best >= Math.min(b.r, byOverlap.r) * 0.5) return byOverlap;
    return null;
  };

  // 实测坐标：圆心距 82 → 重叠 63 ≥ 34（小球一半）→ 命中
  const small = { x: 1181, y: 191, r: 68, id: 'small' };
  const big = { x: 1099, y: 194, r: 77, id: 'big' };
  assert.equal(bestDropTarget(small, [small, big])?.id, 'big');

  // 当初失败的那个距离：圆心距 99 → 重叠 46 ≥ 34 → 仍然要命中
  const small2 = { x: 1181, y: 191, r: 68, id: 'small2' };
  const big2 = { x: 1082, y: 194, r: 77, id: 'big2' };
  assert.equal(bestDropTarget(small2, [small2, big2])?.id, 'big2', '这个距离以前判不出来');

  // 只是擦到边 → 不命中，避免误触
  const a = { x: 0, y: 0, r: 68, id: 'a' };
  const b = { x: 140, y: 0, r: 77, id: 'b' };   // 重叠只有 5px
  assert.equal(bestDropTarget(a, [a, b]), null, '擦边不该触发嵌套');

  // 圆心落在对方体内 → 直接命中
  const inner = { x: 10, y: 0, r: 20, id: 'i' };
  const host = { x: 0, y: 0, r: 200, id: 'h' };
  assert.equal(bestDropTarget(inner, [inner, host])?.id, 'h');
});
