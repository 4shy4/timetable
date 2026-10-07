// Windows 桌面「气泡区」：**画什么**（core）+ 接口 + 形态 + 命中换算 + 原生渲染自检。
//
// 分五层验，因为这条链有五段、而且断哪一段都只会表现成"桌面上什么都没有/点了没反应"：
//   ① core 纯函数：`buildDesktopBubbles` 算出来的每颗泡泡对不对（能在这台机器上直接测）
//   ② 接口：`/api/desktop-bubbles` 真的把它发出去了（起一个临时服务打一次）
//   ③ 契约：C# 的 DTO 字段和 payload 的键完全一致（少一个 = 原生永远读到默认值）
//   ④ 形态：源码静态查 —— 是"全屏透明层 + 空白处点透 + 气泡区手势"，不是面板
//   ⑤ 原生：命中换算（`--hittest`）+ 能把自己画成一张图（`--selftest`）
//
// ⚠️ 第 ⑤ 步刻意**不抓用户的屏幕**：让程序自己渲染到一张 PNG，
//    这样"画得对不对"可验证，又不侵犯隐私。
//
// 跑法：node tools/desktop-bubbles.test.mjs
//   （没有 csc.exe / 不在 Windows 上时跳过原生那两段，不让它拖累其它环境）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  buildDesktopBubbles, stableSeed, resolveBubbleView, BUBBLE_VIEW_DEFAULTS,
} from '../core/desktop-bubbles.js';

const NOW = new Date('2026-09-25T15:00:00');
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function ev(id, title, startOffsetMs, extra = {}) {
  const start = new Date(NOW.getTime() + startOffsetMs);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
  return Object.assign({
    id, title, type: 'personal', level: 'sky',
    start: stamp(start), end: stamp(new Date(start.getTime() + HOUR)), done: false,
  }, extra);
}

const base = { now: NOW, width: 1600, height: 900, settings: { termStart: '' } };

// 原生那几段测试要用的（**声明放前面**：`const` 有 TDZ，
// 下面的 test 回调里引用它们时不能晚于这里的初始化 —— 踩过一次）
const WIN = process.env.WINDIR || 'C:\\Windows';
const CSC = path.join(WIN, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const EXE = path.join('build', 'desktop-bubbles', 'DesktopBubbles.exe');
const isWin = process.platform === 'win32';
const hasNative = isWin && fs.existsSync(CSC);

/** 把 C# 源码里的注释剥掉再查 —— 这个项目的注释"提到什么"就会被自己的检查器抓到 */
function csSource() {
  const raw = fs.readFileSync(path.join('tools', 'desktop-bubbles', 'DesktopBubbles.cs'), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// ① core：算出"画什么"
// ---------------------------------------------------------------------------
test('桌面气泡：该浮的浮、该藏的藏（和网页气泡区同一套规则）', () => {
  const events = [
    ev('soon', '快到了', 2 * HOUR),
    ev('far', '很远的', 30 * DAY),                 // 超出"往前看 14 天" → 不上桌面
    ev('done', '做完的', 3 * HOUR, { done: true }), // 完成的不浮
    ev('future', '未来泡泡', 10 * DAY, { future: true }),  // 还没到出现日期 → 不浮
  ];
  const out = buildDesktopBubbles(events, base);
  const ids = out.bubbles.map((b) => b.id);
  assert.ok(ids.includes('soon'), '两小时后那颗要浮：' + ids.join(','));
  assert.ok(!ids.includes('done'), '完成的不该浮');
  assert.ok(!ids.includes('far'), '30 天后那颗超出窗口，不该浮');
  assert.ok(!ids.includes('future'), '未来泡泡在出现日期之前不该浮');
});

test('桌面气泡：每颗都带原生的画图与手势所需字段（契约）', () => {
  // ⚠️ 这条测的是"一条普通日程"：得**显式关掉节日气泡**，
  //    否则日期恰好落在节日窗口里就会多出一颗（测试会被日历影响 = 定时炸弹）。
  const noFest = Object.assign({}, base, { settings: { termStart: '', bubbleView: { festivalDays: 0 } } });
  const out = buildDesktopBubbles([ev('a', '交作业', 3 * HOUR, { level: 'amber', location: '教三305' })], noFest);
  assert.equal(out.count, 1);
  const b = out.bubbles[0];
  // ⚠️ 字段名就是 C# 那边的契约（DesktopBubbles.cs 的 BubbleDto），改名字要两边一起改
  assert.deepEqual(Object.keys(b).sort(), [
    'canHold', 'childLevels', 'countdown', 'dimmed', 'edge', 'fill', 'fillDark', 'fillLight',
    'id', 'inheritedOverdue', 'key', 'levelKey', 'levelOptions', 'location', 'occurrence',
    'overdue', 'ownOverdue', 'r', 'remainingMs', 'ring', 'seed', 'text', 'title', 'when',
  ]);
  assert.equal(b.title, '交作业');
  assert.match(b.fill, /^#[0-9a-f]{6}$/i, 'fill 必须是十六进制色：' + b.fill);
  assert.ok(b.r > 8 && b.r < 200, '半径要落在合理范围：' + b.r);
  assert.ok(b.countdown.length > 0, '要带上剩余时间那行字');
  assert.match(b.when, /^\d{2}:\d{2}$/, '单次事件只给时刻：' + b.when);
  assert.ok(b.seed >= 0 && b.seed < 1, 'seed 用来定初始位置');
  // 戳破要**按实例记账**：日期 + 当时剩余多久都由 core 给，原生只回传
  assert.equal(b.occurrence, '2026-09-25');
  assert.ok(Number.isFinite(b.remainingMs), 'remainingMs 要是个数（戳破时记进回收站）：' + b.remainingMs);
});

test('桌面气泡：过期的两种紫都传下去了（自己过期 / 只是容器过期）', () => {
  const parent = ev('p', '过期的母泡泡', -3 * DAY, { level: 'red', end: new Date(NOW.getTime() - 2 * DAY).toISOString().slice(0, 19) });
  const child = ev('c', '还没到期的子', 5 * HOUR, { parentId: 'p' });
  const own = ev('o', '自己过期', -5 * HOUR);
  const out = buildDesktopBubbles([parent, child, own], base);
  const byId = Object.fromEntries(out.bubbles.map((b) => [b.id, b]));

  assert.ok(byId.o, '自己过期那颗要浮（它是欠账）');
  assert.equal(byId.o.overdue, true);
  assert.equal(byId.o.ownOverdue, true);
  assert.equal(byId.o.fill, '#5b2a6e', '自己过期 → 泡体暗紫（和网页同一个常量）');
  assert.equal(byId.o.ring, null, '自己过期不用再套一圈"容器过期"的环');

  // ⚠️ 最外层**只画这一层的泡泡**（子泡泡要"双击进去"才看得到）——
  //    这正是用户要的"气泡区的模式"：桌面和软件里是同一套层级语义。
  assert.ok(!byId.c, '最外层不该把子泡泡摊出来');

  // 进到容器里：子泡泡才浮出来，而且带着"容器过期"那圈环
  const inside = buildDesktopBubbles([parent, child, own], Object.assign({}, base, { parentId: 'p' }));
  const fid = Object.fromEntries(inside.bubbles.map((b) => [b.id, b]));
  assert.ok(fid.c, '进容器后子泡泡要浮：' + Object.keys(fid).join(','));
  assert.equal(fid.c.overdue, true, '母泡泡过期 → 子泡泡一起变紫');
  assert.equal(fid.c.ownOverdue, false, '子泡泡自己没到期');
  assert.equal(fid.c.inheritedOverdue, true);
  assert.equal(fid.c.ring, '#5b2a6e', '继承的那种要带环色，原生才知道画环');
});

test('进容器：给的是这一层的子泡泡 + 母泡泡那个圈（含只读与面包屑）', () => {
  const parent = ev('p', '母泡泡', 6 * HOUR, { level: 'amber' });
  const child = ev('c', '子泡泡', 3 * HOUR, { parentId: 'p', level: 'sky' });
  const other = ev('o', '外面的', 4 * HOUR);
  const out = buildDesktopBubbles([parent, child, other], Object.assign({}, base, { parentId: 'p' }));

  assert.deepEqual(out.bubbles.map((b) => b.id), ['c'], '容器里只该有它的子泡泡');
  assert.equal(out.view.parentId, 'p');
  assert.equal(out.view.container.id, 'p');
  assert.equal(out.view.container.title, '母泡泡');
  assert.equal(out.view.container.readOnly, false, '没过期的容器可以往里加东西');
  assert.equal(out.view.container.escapeTo, null, '没有祖父 → 拖出去就是最外层');
  assert.deepEqual(out.view.path.map((p) => p.id), ['p']);
  assert.match(out.view.hint, /单击背景加子气泡/, '容器里的操作提示要由 core 给：' + out.view.hint);

  // 幽灵 id（容器已经被删了）→ 当最外层，绝不能拿它画一个不存在的圈
  const ghost = buildDesktopBubbles([parent, child, other], Object.assign({}, base, { parentId: 'nope' }));
  assert.equal(ghost.view.container, null);
  assert.ok(ghost.bubbles.some((b) => b.id === 'o'), '幽灵容器要退回最外层');
  assert.ok(!ghost.bubbles.some((b) => b.id === 'c'));
});

test('最外层：view 里没有圈，hint 是空的（和软件里 HUD 那一格一样）', () => {
  const out = buildDesktopBubbles([ev('a', '事', 2 * HOUR)], base);
  assert.equal(out.view.container, null);
  assert.equal(out.view.parentId, null);
  assert.deepEqual(out.view.path, []);
  assert.equal(out.view.hint, '');
});

test('过期容器 → 只读：提示也换成"只能看看"（判定和画紫色用同一个函数）', () => {
  const parent = ev('p', '过期母泡泡', -3 * DAY, { level: 'amber' });
  const child = ev('c', '子', 3 * HOUR, { parentId: 'p' });
  const out = buildDesktopBubbles([parent, child], Object.assign({}, base, { parentId: 'p' }));
  assert.equal(out.view.container.overdue, true);
  assert.equal(out.view.container.readOnly, true);
  assert.equal(out.view.container.fill, '#5b2a6e', '过期容器画成暗紫（和网页同一个常量）');
  assert.ok(!/单击背景加子气泡/.test(out.view.hint), '只读的容器不该再教用户"单击背景加子气泡"：' + out.view.hint);
});

test('谁能装下谁：childLevels / canHold 由 core 算好（原生不重写红>黄>绿>蓝）', () => {
  const red = ev('r', '红', 5 * HOUR, { level: 'red' });
  const sky = ev('s', '蓝', 5 * HOUR, { level: 'sky' });
  const out = buildDesktopBubbles([red, sky], base);
  const byId = Object.fromEntries(out.bubbles.map((b) => [b.id, b]));
  assert.deepEqual(byId.r.childLevels, ['sky', 'emerald', 'amber'], '红里只能装比它小的');
  assert.equal(byId.r.canHold, true, '红可以双击进去');
  assert.deepEqual(byId.s.childLevels, [], '蓝是最小档，什么都装不下');
  assert.equal(byId.s.canHold, false, '蓝双击只抖一下（进不去）');
});

test('快速编辑框：能改成哪几档也是 core 算的（levelOptions / 容器的 childLevels）', () => {
  const red = ev('r', '红', 5 * HOUR, { level: 'red' });
  const amber = ev('a', '黄', 5 * HOUR, { level: 'amber', parentId: 'r' });
  const kid = ev('k', '绿', 6 * HOUR, { level: 'emerald', parentId: 'a' });
  const alone = ev('alone', '孤单的', 5 * HOUR, { level: 'sky' });
  const out = buildDesktopBubbles([red, amber, kid, alone], base);
  const byId = Object.fromEntries(out.bubbles.map((b) => [b.id, b]));

  // 没有任何约束的事件：四档都能选
  assert.deepEqual(byId.alone.levelOptions, ['sky', 'emerald', 'amber', 'red'], '没约束 → 四档都能选');
  // ⚠️ 自己装了"黄"子气泡 → **不能再把自己降成黄或更小**（服务端会拒），所以只剩"红"
  assert.deepEqual(byId.r.levelOptions, ['red'], '装了子气泡之后不能把自己降到比它小');

  // 在红里面的事件：只能选比红小的
  const inside2 = buildDesktopBubbles([red, amber, kid, alone], Object.assign({}, base, { parentId: 'r' }));
  const inside2ById = Object.fromEntries(inside2.bubbles.map((b) => [b.id, b]));
  // 而"黄"自己装了"绿" → 只能保持黄（比绿大）
  assert.deepEqual(inside2ById.a.levelOptions, ['amber'], '装了"绿"子气泡 → 只能保持黄');

  // 容器给的"新建子气泡能选哪几档"
  assert.deepEqual(inside2.view.container.childLevels, ['sky', 'emerald', 'amber']);

  // 四档颜色表由 core 给（原生不自己抄一组）
  assert.deepEqual(out.levels.map((l) => l.key), ['sky', 'emerald', 'amber', 'red']);
  assert.equal(out.levels[3].label, '重大');
  assert.match(out.levels[3].color, /^#[0-9a-f]{6}$/i);
});

test('显示设置和软件气泡区**同一份**（默认值不许自己拍）', () => {
  // 这三个数就是网页 readConfig 的默认值（浏览器里没设过时用的）
  assert.deepEqual(BUBBLE_VIEW_DEFAULTS, { horizonDays: 14, showCourse: true, showDone: false, festivalDays: 4 });
  assert.deepEqual(resolveBubbleView({}), {
    horizonDays: 14, showCourse: true, showDone: false, festivalDays: 4, max: 60, scale: 1,
  });

  // 课程：**默认显示**（和软件一致），关掉才不显示
  const course = ev('course1', '高等数学', 4 * HOUR, { type: 'course', weeks: [1, 2, 3], dayOfWeek: 5 });
  const withTerm = { now: NOW, width: 1600, height: 900, settings: { termStart: '2026-09-21' } };
  assert.ok(buildDesktopBubbles([course], withTerm).bubbles.some((b) => b.id === 'course1'),
    '默认要显示课程（软件的默认也是显示）');
  const off = buildDesktopBubbles([course], {
    now: NOW, width: 1600, height: 900,
    settings: { termStart: '2026-09-21', bubbleView: { showCourse: false } },
  });
  assert.ok(!off.bubbles.some((b) => b.id === 'course1'), '关掉之后课程不该上桌面');

  // 时间范围：默认 14 天，改成 3 天之后"10 天后那颗"就该消失
  const far = ev('far', '十天后的', 10 * DAY);
  assert.ok(buildDesktopBubbles([far], base).bubbles.some((b) => b.id === 'far'), '默认 14 天：它还在');
  const narrow = buildDesktopBubbles([far], {
    now: NOW, width: 1600, height: 900,
    settings: { termStart: '', bubbleView: { horizonDays: 3 } },
  });
  assert.ok(!narrow.bubbles.some((b) => b.id === 'far'), '改成 3 天之后它不该在');

  // 显示已完成
  const done = ev('d', '做完的', 3 * HOUR, { done: true });
  assert.ok(!buildDesktopBubbles([done], base).bubbles.some((b) => b.id === 'd'));
  const showDone = buildDesktopBubbles([done], {
    now: NOW, width: 1600, height: 900,
    settings: { termStart: '', bubbleView: { showDone: true } },
  });
  assert.ok(showDone.bubbles.some((b) => b.id === 'd'), '打开"显示已完成"之后它要浮出来');
});

test('桌面气泡：seed 稳定（刷新前后同一颗不会乱跳）', () => {
  assert.equal(stableSeed('evt_a@2026-09-25'), stableSeed('evt_a@2026-09-25'));
  assert.notEqual(stableSeed('evt_a@2026-09-25'), stableSeed('evt_b@2026-09-25'));
  const s = stableSeed('x');
  assert.ok(s >= 0 && s < 1);
});

// ---------------------------------------------------------------------------
// ② 接口：服务端真的发得出去
// ---------------------------------------------------------------------------
test('接口 /api/desktop-bubbles 返回原生要的那份 JSON（含 view / messages）', async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-bubbles-api-'));
  const PORT = 7101;
  const child = spawn(process.execPath, [
    'server/main.js', `--port=${PORT}`, `--https-port=${PORT + 1}`, `--data-dir=${TMP}`,
  ], { stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* wait */ }
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(up, '临时服务没起来');
    // 先塞一条日程，确认它真的会出现在桌面那份数据里
    await fetch(`http://127.0.0.1:${PORT}/api/events`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '接口测试的事', level: 'emerald', start: new Date(Date.now() + 3 * HOUR).toISOString().slice(0, 19) }),
    });
    const r = await fetch(`http://127.0.0.1:${PORT}/api/desktop-bubbles?w=2560&h=1440`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.bubbles), 'bubbles 必须是数组');
    assert.equal(j.canvas.width, 2560);
    assert.equal(j.canvas.height, 1440);
    assert.equal(j.count, j.bubbles.length);
    assert.ok(j.view, '要给 view（原生画母泡泡那个圈要用）');
    assert.equal(j.view.container, null, '没传 parentId 时不在容器里');
    assert.ok(j.messages && j.messages.cannotNest, '那几句人话要由 core 给：' + JSON.stringify(j.messages));
    const hit = j.bubbles.find((b) => b.title === '接口测试的事');
    assert.ok(hit, '刚建的日程要出现在桌面数据里：' + JSON.stringify(j.bubbles.map((b) => b.title)));
    assert.equal(hit.levelKey, 'emerald');
    assert.ok(hit.r > 8);
    assert.equal(hit.canHold, true, '翠绿可以双击进去');

    // parentId 要透传（进容器之后原生就是靠它取这一层）
    const r2 = await fetch(`http://127.0.0.1:${PORT}/api/desktop-bubbles?w=1600&h=900&parentId=${encodeURIComponent(hit.id)}`);
    const j2 = await r2.json();
    assert.equal(j2.view.parentId, hit.id, 'parentId 必须一路透传到 core');
    assert.equal(j2.view.container.title, '接口测试的事');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// ②b 接口：软件里那个入口（开/关桌面气泡层）
// ---------------------------------------------------------------------------
//
// ⚠️⚠️ 测试**绝对不能真的把那一层拉起来**：跑测试的就是用户那台机器，
//     一 spawn 就会在他屏幕上冒出一个全屏（还可能"吃点击"）的窗口。
//     所以服务端支持 `TIMETABLE_NO_SPAWN=1`：只校验、不动进程。
test('接口 /api/desktop-layer：软件里的入口（测试模式不会真的开窗口）', async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-layer-api-'));
  const PORT = 7103;
  const child = spawn(process.execPath, [
    'server/main.js', `--port=${PORT}`, `--https-port=${PORT + 1}`, `--data-dir=${TMP}`,
  ], { stdio: 'ignore', env: { ...process.env, TIMETABLE_NO_SPAWN: '1' } });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* wait */ }
      if (!up) await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(up, '临时服务没起来');

    const st = await (await fetch(`http://127.0.0.1:${PORT}/api/desktop-layer`)).json();
    for (const k of ['supported', 'built', 'running', 'topmost', 'captureBackground', 'autostart']) {
      assert.ok(k in st, '状态里缺字段：' + k + '（界面要照它画开关）');
    }

    // 开：测试模式下只回答 ok，不会真的起进程
    const started = await (await fetch(`http://127.0.0.1:${PORT}/api/desktop-layer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    })).json();
    assert.equal(started.ok, true);
    assert.ok(started.skipped, '测试模式应当"只校验不启动"：' + JSON.stringify(started));
    assert.equal(started.status.running, false, '测试模式绝不能真的把窗口拉起来');

    // 未知动作 → 400 + 一句人话（界面会把它显示出来）
    const bad = await fetch(`http://127.0.0.1:${PORT}/api/desktop-layer`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: '乱写的' }),
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /不知道这个动作/, '错误要说清楚，不能静默');

    // 开关：写进 build/desktop-bubbles.json（就是那一层自己读的那份）
    const cfgFile = path.join('build', 'desktop-bubbles.json');
    const before = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
    try {
      const r = await (await fetch(`http://127.0.0.1:${PORT}/api/desktop-layer`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'topmost', on: false }),
      })).json();
      assert.equal(r.ok, true);
      assert.equal(r.status.topmost, false, '开关要立刻反映到状态里');
      const written = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      assert.equal(written.topmost, false, '要写进那一层读的配置文件');
    } finally {
      // 把我们动过的配置还原，别改变用户那一层的状态
      if (before == null) { try { fs.rmSync(cfgFile, { force: true }); } catch { /* ignore */ } }
      else { try { fs.writeFileSync(cfgFile, before, 'utf8'); } catch { /* ignore */ } }
    }
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 400));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// ③ 契约：C# 的 DTO 字段必须和 payload 一个不多一个不少
// ---------------------------------------------------------------------------
//
// ⚠️ 这类"网页加了字段、壳没读"的漏掉**不会报错**，只会表现成"设了没反应"。
//    所以直接从 .cs 源码里读属性名，和 payload 的键**逐个对齐**。
test('契约：C# 的 BubbleDto 字段和 payload 的键完全一致', () => {
  const cs = csSource();
  // ⚠️ 不能按 `}` 切：每个属性自己就带一个 `}`（`{ get; set; }`）。按下一个类的开头切才稳。
  const block = cs.split('class BubbleDto')[1].split('class CanvasDto')[0];
  // ⚠️ 类型里可能有 `?`（可空，比如 `double? remainingMs`）—— 第一版的正则漏了它，
  //    于是这条测试把"字段其实在"报成"payload 里有、C# 里没读"。正则也要能测得住。
  const props = [...block.matchAll(/public\s+[\w<>\[\]\?]+\s+(\w+)\s*\{\s*get;/g)].map((m) => m[1]);
  assert.ok(props.length > 10, '没从 .cs 里读出字段：' + props.join(','));

  const payloadKeys = Object.keys(buildDesktopBubbles(
    [ev('x', '契约', 2 * HOUR)], base,
  ).bubbles[0]);

  const missingInCs = payloadKeys.filter((k) => !props.includes(k));
  const unusedInCs = props.filter((k) => !payloadKeys.includes(k));
  assert.deepEqual(missingInCs, [], 'payload 里有、C# 里没读的字段（原生不会用到它们）');
  assert.deepEqual(unusedInCs, [], 'C# 里读了、payload 里没有的字段（会永远是 null/default）');
});

test('契约：view / messages 那几个字段 C# 也都在读', () => {
  const cs = csSource();
  const out = buildDesktopBubbles([ev('a', '事', 2 * HOUR, { level: 'amber' })],
    Object.assign({}, base, { parentId: null }));
  // view 的三个 key + messages 的七句话，一个都不能少
  for (const k of Object.keys(out.view)) {
    assert.match(cs, new RegExp('\\b' + k + '\\b'), 'C# 里没读 view.' + k);
  }
  for (const k of Object.keys(out.messages)) {
    assert.match(cs, new RegExp('\\b' + k + '\\b'), 'C# 里没读 messages.' + k);
  }
  // 容器的字段
  const inside = buildDesktopBubbles([ev('p', '母', 3 * HOUR, { level: 'red' }), ev('c', '子', 4 * HOUR, { parentId: 'p' })],
    Object.assign({}, base, { parentId: 'p' }));
  for (const k of Object.keys(inside.view.container)) {
    assert.match(cs, new RegExp('\\b' + k + '\\b'), 'C# 里没读 container.' + k);
  }
});

// ---------------------------------------------------------------------------
// ④ 形态：全屏透明层 + 空白处点透 + 气泡区的手势
// ---------------------------------------------------------------------------
//
// ⚠️⚠️ 用户第 41 轮亲口纠正过形态，这几条是"别再改回去"的守卫：
//   原话："我就是要铺满全屏的透明层，只不过我要气泡区的模式，有双击，有长按，有单击，
//          有母泡泡背景（…拿出去就拿到平级了），只不过背景我要虚化而不挡住壁纸。
//          桌面气泡的显示与软件气泡区设置保持一致"
//   我上一版做成了"一块 520×760 的磨砂面板"，被否掉了。
test('形态：铺满全屏的透明层，空白处点透（不是面板，也不是整屏吃点击）', () => {
  const cs = csSource();
  assert.match(cs, /WindowStyle = WindowStyle\.None/, '全屏无边框');
  assert.match(cs, /AllowsTransparency = true/, '背景要真的是透明的');
  assert.match(cs, /Background = Brushes\.Transparent/, '不能有一层底色把桌面盖住');
  assert.match(cs, /class BubbleLayer/, '主窗口那个类没了');
  assert.match(cs, /SystemParameters\.PrimaryScreenWidth/, '要铺满整块屏幕');

  // 点透：**只用同步的 `HTTRANSPARENT`**。
  //
  // ⚠️⚠️ 这条结论是**实测**来的（`--clickprobe` 的 A/B 对照）：只靠 HTTRANSPARENT，
  //    目标**进程**的窗口拿到了点击（hit）；再加 WS_EX_TRANSPARENT 轮询也是 hit。
  //    既然跨进程也生效，就只用同步的那个 —— 系统在每次点击**之前**现问一次，
  //    用的是此刻的泡泡位置。轮询那套是**异步**的，光标刚移到泡泡上时点击会漏给桌面，
  //    表现就是用户报的"双击有时候能进去，有时候无响应"。
  //    ⚠️ 我曾经用自己的第一次实验"证明" HTTRANSPARENT 跨进程不生效 —— 那个实验是**错的**
  //    （目标窗口被一个开着的浏览器盖住了）。所以这里钉的是"别再退回异步轮询"。
  assert.match(cs, /WM_NCHITTEST/, '命中测试没了');
  assert.match(cs, /HTTRANSPARENT/, '点透返回值没了');
  assert.match(cs, /HitMath\.ToDip/, '物理像素没换算成 DIP（150% 屏上会全点不动）');
  // ⚠️ 只截到**气泡层这个类**为止（后面还有排查用的 ClickProbe，它当然可以用 GetCursorPos）
  const layerBody = cs.split('class BubbleLayer')[1].split('class ClickProbe')[0];
  assert.doesNotMatch(layerBody, /SetClickThrough\(_hwnd/, '别再退回"异步开关窗口样式"那套点透');
  assert.doesNotMatch(layerBody, /GetCursorPos|Win32\.Cursor\(/, '别再退回光标轮询');

  // 上一版"面板"那套必须清干净
  // ⚠️ 只看**气泡层那个类**：编辑框（EditWindow）是个普通小窗口，它当然可以 DragMove
  const layer = layerBody;
  assert.doesNotMatch(layer, /DragMove\(\)/, '拖表头是面板才需要的东西');
  assert.doesNotMatch(cs, /SizeFor\(/, '面板才分大小档');
  assert.doesNotMatch(cs, /SetWindowCompositionAttribute/, '面板才用亚克力当底');
});

test('气泡区的模式：单击 / 双击 / 长按 / 放进去 / 拉出来 都在', () => {
  const cs = csSource();
  // 手势常数必须和网页一致（LONG_PRESS_MS 2500 / 双击窗口 330 / 位移容差 12）
  assert.match(cs, /const double LONG_PRESS_MS = 2500/);
  assert.match(cs, /const double TAP_WINDOW_MS = 330/);
  assert.match(cs, /const double MOVE_SLOP = 12/);
  // 手势实现
  assert.match(cs, /void EnterBubble/, '双击进去没了');
  assert.match(cs, /void PopBubble/, '长按戳破没了');
  assert.match(cs, /void ResolveDrop/, '松手时的归属判定没了');
  assert.match(cs, /void FirePendingTap/, '单击（编辑）没了');
  assert.match(cs, /void ExitOneLevel/, '双击背景出去一层没了');
  assert.match(cs, /\/pop/, '戳破要按实例记账，走服务端的 pop');
  assert.match(cs, /childLevels/, '能不能放进别人身上要用 core 给的 childLevels，不许自己重写');
  assert.match(cs, /escapeTo/, '"拖出去和母泡泡平级"要用 core 给的目的地');
});

test('★ 单击 = 弹**编辑框**，不是弹浏览器（用户第 42 轮的要求）', () => {
  const cs = csSource();
  assert.match(cs, /class EditWindow/, '编辑框那个窗口没了');
  // 单击泡泡 → 编辑框
  const tap = cs.split('void FirePendingTap()')[1].split('void OpenEditor')[0];
  assert.match(tap, /OpenEditor\(b\)/, '单击泡泡没有弹编辑框：' + tap.slice(0, 200));
  assert.doesNotMatch(tap, /index\.html\?open=/, '单击泡泡还在开浏览器');
  // 容器里单击背景 → 编辑框（新建子气泡），也不再开浏览器
  const bg = cs.split('void FirePendingBackgroundTap()')[1].split('void ExitOneLevel')[0];
  assert.match(bg, /OpenChildEditor\(\)/, '单击背景没有弹编辑框：' + bg.slice(0, 200));
  assert.doesNotMatch(bg, /index\.html\?addChild=/, '单击背景还在开浏览器');
  // 编辑框自己会写服务端（保存/新建/戳破/删除都走 API）
  assert.match(cs, /"PATCH", "\/api\/events\//, '保存没走服务端');
  assert.match(cs, /"POST", "\/api\/events"/, '新建没走服务端');
  assert.match(cs, /"DELETE", "\/api\/events\//, '删除没走服务端');
  // ⚠️ 完整编辑器仍留了一个出口（重复/提醒/未来泡泡那些只在网页里有）
  assert.match(cs, /index\.html\?open=/, '"完整编辑器"那个出口不该删');
});

test('★ 背景也要等"双击窗口"：双击背景不能再顺手做单击那件事', () => {
  const cs = csSource();
  assert.match(cs, /readonly DispatcherTimer _bgTimer/, '背景那次点击没有单独的定时器');
  assert.match(cs, /void FirePendingBackgroundTap/, '背景的"单击"动作应该延后到窗口结束才跑');
  // ⚠️ 手势现在全在 `OnWindowUp` 里判（按下的那一刻决定是泡泡还是背景）
  //    切到 `PickBubble` 为止 —— 注意它返回 `Live`，不是 `void`
  const up = cs.split('void OnWindowUp')[1].split('Live PickBubble')[0];
  assert.match(up, /_bgTimer\.Start\(\)/, '背景第一下要先等一个双击窗口');
  assert.match(up, /ExitOneLevel\(\)/, '双击背景要出去一层');
  // ⚠️ "单击背景"那件事必须留给 FirePendingBackgroundTap（延后执行），
  //    在 OnWindowUp 里直接调用它 = 双击的第一下就会误触发
  assert.doesNotMatch(up, /OpenChildEditor\(\)/, '第一下就执行了单击动作（双击的第一下会误触发）');
});

test('★ 双击窗口跟着系统设置走（别再写死 330：鼠标慢一点就会判成两次单击）', () => {
  const cs = csSource();
  assert.match(cs, /GetDoubleClickTime\(\)/, '双击判定窗口要读系统设置');
  assert.match(cs, /_tapWindowMs/, '单击/双击的比较要用这个窗口');
  // ⚠️ 不许再拿那个常量去比时间（那个只是**下限**）
  assert.doesNotMatch(cs, /TotalMilliseconds < TAP_WINDOW_MS/, '比较不该直接用那个下限常量');
});

test('★ 取数据要防"过期响应盖掉刚进去的那一层"', () => {
  const cs = csSource();
  assert.match(cs, /_fetchSeq/, '取数据没有发号：慢的那次回来会把画面盖回去');
  const fetch = cs.split('void FetchAsync()')[1].split('void SendAsync')[0];
  assert.match(fetch, /seq != _fetchSeq/, '回来的号不是最新的就该丢掉');
});

test('★ 圈里"淡化透明"，**不许自己画桌面**（用户第 43 轮的要求）', () => {
  const cs = csSource();
  // 圈还是那个圈（几何和网页 parentBubbleGeom 同一个公式）
  assert.match(cs, /CircleGeom/, '圈几何要和网页 parentBubbleGeom 用同一个公式');
  assert.match(cs, /\* 0\.42/, '半径 = 短边 × 42%（和网页同一个数）');
  // 但要**淡化透明**：一层低透明度的颜色 + 很淡的柔光
  assert.match(cs, /FromArgb\(32, baseCol\.R/, '应该是一层很淡的颜色底（约 12%）');
  assert.match(cs, /radial|RadialGradientBrush/, '还得有那层柔光');
  // ⚠️ 不许再读壁纸 / 模糊 / 贴一张假桌面上去
  assert.doesNotMatch(cs, /static class Wallpaper/, '不该再读系统壁纸');
  assert.doesNotMatch(cs, /Wallpaper\.Blurred|BitmapFrame\.Create\(new MemoryStream/, '不该再解一张壁纸图贴进圈里');
  assert.doesNotMatch(cs, /BlurEffect/, '不该再自己模糊一份"桌面"');
  assert.doesNotMatch(cs, /Registry\.CurrentUser/, '不该再去注册表里找壁纸');
});

// ---------------------------------------------------------------------------
// ⑤ 原生：命中换算 + 能把自己画出来
// ---------------------------------------------------------------------------

/** 跑 exe 并拿回 stdout —— ⚠️ 不用管道：沙箱下 spawnSync 的 stdio:'pipe' 会 EPERM */
function runExe(args) {
  // 按需编译：干净副本 / 新克隆里 `build/desktop-bubbles/DesktopBubbles.exe` 还不存在，
  // 而这几条用例是直接 spawn 它的（原版靠"以前编过一次"才绿）。`--build` 只编译就退出。
  if (!fs.existsSync(EXE)) {
    const b = spawnSync(process.execPath, [path.join('tools', 'desktop-bubbles.mjs'), '--build'], { stdio: 'inherit' });
    if (b.status !== 0) throw new Error(`原生气泡编译失败（status=${b.status}）`);
  }
  const logPath = path.join(os.tmpdir(), `desktop-bubbles-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  const fd = fs.openSync(logPath, 'w');
  let r;
  try {
    r = spawnSync(EXE, args, { stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  let text = '';
  try { text = fs.readFileSync(logPath, 'utf8'); } catch { /* ignore */ }
  try { fs.rmSync(logPath, { force: true }); } catch { /* ignore */ }
  if (r.error) text += `\n（子进程起不来：${r.error.message}）`;
  return { status: r.status, text };
}

// ⚠️⚠️ 这是**整个功能不可用**级别的坑，必须钉死：
//   `WM_NCHITTEST` 给的坐标是**物理像素**，而泡泡位置是 **DIP**。
//   150% 缩放的屏幕上两者差 1.5 倍 —— 不换算就"处处判成没点到"，
//   于是全部返回 HTTRANSPARENT：**泡泡点不动、背景也点不动**（用户报的"完全无法点击"）。
//   这条测试拿同一个物理点、按正确/错误的缩放各算一次，把差异钉出来。
test('命中判定：物理像素必须换算成 DIP（否则一点都点不动）', { skip: !hasNative }, () => {
  const probe = (spec) => JSON.parse(runExe([`--hittest=${spec}`]).text.trim());

  // 合成版面（和 C# 里 HitProbe 用的一致）：泡心在 DIP(400,300) r=80、画布 1706×1066
  const onBubble = probe('600,450,1.5');
  assert.equal(onBubble.dip.x, 400);
  assert.equal(onBubble.dip.y, 300);
  assert.equal(onBubble.hit, 'bubble', '物理(600,450) 在 150% 屏上就是 DIP(400,300) 那颗泡泡');
  assert.equal(onBubble.bubbleId, 'probe-bubble');

  assert.equal(probe('900,900,1.5').hit, 'background', '容器那个圈里算"背景"（背景 = 母泡泡，能点）');
  assert.equal(probe('100,1500,1.5').hit, 'none', '圈外要穿透（桌面照常能用）');

  // ⚠️ 关键的一条：**按 100% 去算同一个物理点，就不该命中那颗泡泡** ——
  //    这正是修复前发生的事（屏幕上处处穿透），所以它同时是"回归探测器"。
  assert.notEqual(probe('600,450,1').hit, 'bubble',
    '不换算（把物理当 DIP）时不该命中泡泡 —— 命中了说明这条测试失去了意义');
});

test('原生渲染自检：整层能把自己画成一张图（不抓屏）', { skip: !hasNative }, () => {
  const png = path.join('build', 'shots', 'desktop-bubbles-selftest.png');
  try { fs.rmSync(png, { force: true }); } catch { /* ignore */ }
  // ⚠️ 不用管道收子进程输出：沙箱下 spawnSync 的 stdio:'pipe' 会 EPERM，
  //    返回的 status 是 null、stdout 是 undefined，看起来像"编译器崩了"。
  const logPath = path.join(os.tmpdir(), `desktop-bubbles-selftest-${process.pid}.log`);
  const fd = fs.openSync(logPath, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, ['tools/desktop-bubbles.mjs', '--selftest'], { stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  let out = '';
  try { out = fs.readFileSync(logPath, 'utf8'); } catch { /* ignore */ }
  try { fs.rmSync(logPath, { force: true }); } catch { /* ignore */ }
  if (r.error) out = `${out}\n（子进程起不来：${r.error.message}）`;
  assert.equal(r.status, 0, '编译/渲染失败：' + out.slice(0, 400));
  assert.ok(fs.existsSync(png), '没产出图片。子进程说：' + out.slice(0, 400));
  const size = fs.statSync(png).size;
  assert.ok(size > 20_000, '图片太小了（可能只画了个背景）：' + size + ' 字节');

  // 图里必须有"泡泡 + 那个圈"：这张样张是**两个场景并排**（最外层 / 在母泡泡里），
  // 所以内容比一张纯色图大得多。⚠️ PNG 是压缩格式，这里不引第三方库解像素 ——
  // 真要看长相就跑 `node tools/desktop-bubbles.mjs --selftest` 打开那张图。
  assert.ok(size > 120_000, '图里的内容太少（两个场景 + 4 颗泡泡应该远大于 120KB）：' + size + ' 字节');
});
