// 气泡"套娃路径"的回归测试（需要桌面服务在 7080 上跑着）。
//
// 锁住一个用户报的真 bug：**"我一添加就显示父气泡不存在"**。
//
// 根因：`timetable.bubble.path` 存在 sessionStorage 里用来跨刷新保持"我在第几层容器里"，
// 但恢复时**从不校验那个容器是否还存在**。容器一旦被删（清空数据 / 导入替换 / 戳破），
// 路径里就留下一个幽灵 id，于是：
//   · 气泡视图仍以为你在容器里
//   · 单击背景 → addChild(幽灵 id) → 保存 → 服务端报「父气泡不存在」
// 用户看到的就是"一添加就报"，而且怎么试都这样（路径一直留着）。
//
// 修法：渲染时用真实事件修剪路径（`pruneBubblePath`），并把失效容器的提示说清楚。
//
// 为什么用真实浏览器：这个 bug 只在"sessionStorage + 视图渲染 + 真实请求"整条链上
// 才出现，纯函数单测测不到。**没装 Edge 就跳过**，不让它拖累别的环境。
//
// 跑法：先起服务，再 `node tools/bubble-path.test.mjs`（或 `npm run verify:web`）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!fs.existsSync(EDGE)) {
  console.log('跳过：没找到 Edge（这个测试需要一个真实浏览器内核）');
  process.exit(0);
}
try {
  const h = await fetch('http://127.0.0.1:7080/api/health');
  if (!h.ok) throw new Error('bad status');
} catch {
  console.log('跳过：桌面服务没在 7080 上跑（先 npm start 或启动 Timetable.exe）');
  process.exit(0);
}
const PORT = 9370;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; let fail = 0;
const check = (n, ok, d = '') => {
  if (ok) { pass += 1; console.log(`  ✔ ${n}`); } else { fail += 1; console.log(`  ✖ ${n}${d ? '  → ' + d : ''}`); }
};

const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

try {
  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i += 1) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl || null; } catch { /* wait */ }
    if (!wsUrl) await sleep(250);
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  };
  const send = (method, params = {}, sid) => { id += 1; const p = { id, method, params }; if (sid) p.sessionId = sid; ws.send(JSON.stringify(p)); return new Promise((r) => pending.set(id, r)); };
  const { result: t } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: a } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const sid = a.sessionId;
  await send('Runtime.enable', {}, sid);
  await send('Page.enable', {}, sid);
  // 关键：页面脚本运行**之前**塞一个幽灵路径
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { sessionStorage.setItem('timetable.bubble.path', JSON.stringify(['evt_ghost_not_exist'])); } catch(e){}`,
  }, sid);
  await send('Page.navigate', { url: 'http://127.0.0.1:7080/index.html?ghost=1' }, sid);
  await sleep(8000);
  const q = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid)).result?.result?.value;

  console.log('① 注入幽灵路径后加载页面');
  const stored = await q(`sessionStorage.getItem('timetable.bubble.path')`);
  console.log('   sessionStorage 里的路径:', stored);
  check('幽灵 id 已被修剪掉（路径变空数组）', stored === '[]', String(stored));

  console.log('\n② 视图是否回到最外层（而不是"在容器里"）');
  const inside = await q(`!!document.querySelector('.bubble-stage.bubble-inside')`);
  check('不在容器里（无 bubble-inside 标记）', inside === false, `inside=${inside}`);

  console.log('\n③ 单击背景 → 应走"最外层新建"，不该拿幽灵 id 建子气泡');
  const before = await q(`(await (await fetch('/api/state')).json()).events.length`);
  // ⚠️ 不能写死坐标。气泡是**浮动**的，布局一变 (500,400) 就可能压在泡泡上，
  //    于是"点空白"变成"点某颗泡泡" → 弹的是「编辑日程」而不是「新建日程」。
  //    这个断言以前就偶发失败，我一开始当成"测试脆弱"，其实是**测试用错了前提**。
  //    现在用 bubble.js 暴露的只读快照，先算出一个真正没有泡泡的位置再点。
  //
  //    ③ 和 ③b 都要找空位，所以抽成一份 —— 抄两份迟早在"余量"这种细节上漂移。
  const findSpotExpr = `(() => {
    const sz = window.__bubbleCanvasSize ? window.__bubbleCanvasSize() : { width: 900, height: 600 };
    const bodies = window.__bubbleBodies ? window.__bubbleBodies() : [];
    const rect = document.querySelector('.bubble-canvas').getBoundingClientRect();
    for (let gy = 0.12; gy <= 0.9; gy += 0.06) {
      for (let gx = 0.06; gx <= 0.94; gx += 0.06) {
        const x = sz.width * gx, y = sz.height * gy;
        // 离所有泡泡都要留出余量（pick 的判定半径 = r + 一点）
        if (bodies.every((b) => Math.hypot(b.x - x, b.y - y) > b.r + 24)) {
          return JSON.stringify({ x: Math.round(rect.x + x), y: Math.round(rect.y + y), found: true });
        }
      }
    }
    return JSON.stringify({ found: false });
  })()`;
  const empty = await q(findSpotExpr);
  const spot = JSON.parse(empty);
  console.log('   找到的空白位置:', empty);
  if (!spot.found) {
    check('能找到一个空白位置来点', false, '整个画布都被泡泡盖满了');
  } else {
    await q(`(() => {
      const c = document.querySelector('.bubble-canvas');
      const opt = { bubbles: true, clientX: ${spot.x}, clientY: ${spot.y} };
      c.dispatchEvent(new MouseEvent('pointerdown', opt));
      c.dispatchEvent(new MouseEvent('pointerup', opt));
    })()`);
  }
  await sleep(900);
  const editorOpen = await q(`!document.getElementById('modal-host').hidden`);
  check('编辑器打开了（走的是新建日程这条路）', editorOpen === true, `open=${editorOpen}`);
  const hasParentHint = await q(`(() => { const m = document.getElementById('modal-host'); return m ? m.innerText.slice(0,200) : ''; })()`);
  console.log('   弹窗标题区:', JSON.stringify(String(hasParentHint).split('\n')[0]));
  check('是「新建日程」而不是「添加子气泡」', /新建日程/.test(String(hasParentHint)), String(hasParentHint).slice(0, 60));
  const after = await q(`(await (await fetch('/api/state')).json()).events.length`);
  check('没有产生新事件（只是打开了编辑器）', after === before, `${before} -> ${after}`);

  // ---------------------------------------------------------------------------
  // ③b iPad 上"按住一会儿再松手"也必须算单击
  // ---------------------------------------------------------------------------
  //
  // 用户报的原文是："在平板上，单击母泡泡的背景想加子泡泡，**一点反应都没有**"。
  //
  // 根因：判断"这是不是轻点"用的是 **按住的时长 < 400ms**。
  //   · 鼠标点一下是几十毫秒 → 永远过关，所以电脑上一切正常
  //   · **手指按在玻璃上普遍 100–300ms，犹豫一下/等反馈就超过 400ms** → 直接 return，
  //     不报错、不提示、连 toast 都没有 —— 用户看到的就是"无响应"
  //   （而且那句话里的"位移"分支其实是恒等于 0 的：背景这一支不设 dragBody，
  //     onMove 直接 return，lastPos 永远等于按下的位置 —— 它就是个纯时长闸门。）
  //
  // 修法：背景上没有"长按"这个手势，时长不携带信息，只有"移动多远"才有意义。
  // 所以这条测试**故意按住 700ms**（远超旧的 400ms 闸门）再松手。
  // 用真浏览器跑是因为这条逻辑活在 pointerdown/pointerup 之间，纯函数测不到。
  console.log('\n③b 「按住一会儿再松手」也必须算单击（iPad 上"单击背景无响应"的根因）');
  // 先把 ③ 打开的那个编辑器关掉（✕ 按钮，见 web/ui/modal.js）
  await q(`(() => { const b = document.querySelector('#modal-host button[aria-label="关闭"]'); if (b) b.click(); return true; })()`);
  await sleep(500);
  const closed = await q(`document.getElementById('modal-host').hidden`);
  check('编辑器已关掉（准备第二次点击）', closed === true, `hidden=${closed}`);

  const empty2 = await q(findSpotExpr);
  const spot2 = JSON.parse(empty2);
  if (!spot2.found) {
    check('能再找到一个空白位置来点', false, '整个画布都被泡泡盖满了');
  } else {
    // 按下 → 立刻看涟漪有没有出来（这是"点到了"的即时反馈）
    const ripple = await q(`(() => {
      const c = document.querySelector('.bubble-canvas');
      const opt = { bubbles: true, clientX: ${spot2.x}, clientY: ${spot2.y} };
      c.dispatchEvent(new MouseEvent('pointerdown', opt));
      const r = document.querySelector('.bubble-tap-ripple');
      return r ? r.classList.contains('on') : 'no-element';
    })()`);
    check('按下背景立刻有反馈（涟漪 .on）', ripple === true, String(ripple));
    // ⚠️ 这 700ms 就是测试本体：模拟手指按久一点。旧实现在这里已经放弃这次点击了。
    await sleep(700);
    await q(`(() => {
      const c = document.querySelector('.bubble-canvas');
      const opt = { bubbles: true, clientX: ${spot2.x}, clientY: ${spot2.y} };
      c.dispatchEvent(new MouseEvent('pointerup', opt));
    })()`);
  }
  await sleep(1000);
  const editorOpen2 = await q(`!document.getElementById('modal-host').hidden`);
  check('按住 700ms 再松手，编辑器照样打开（手指不是鼠标）', editorOpen2 === true, `open=${editorOpen2}`);

  console.log('④ 关键：不应出现"父气泡不存在"的报错');
  const errs = logs.filter((l) => /父气泡不存在/.test(String(l)));
  check('无「父气泡不存在」错误', errs.length === 0, errs.join(' | '));

  // ⑤ 对照：**手工把幽灵路径塞回去并直接拿它建子气泡**。
  //    这里同时锁住两层防护：
  //      · 服务端：不再 400「父气泡不存在」，而是丢弃失效的 parentId、按最外层建
  //        （否则陈旧客户端会把"创建"这件事整个堵死 —— 那正是用户遇到的）
  //      · 客户端：编辑器不再把已失效的容器 id 发出去
  //    返回 2xx 且 parentId 为 null，就说明"创建永远能成功"。
  console.log('\n⑤ 对照：拿幽灵 id 建子气泡（模拟陈旧客户端）');
  const direct = await q(`(async () => {
    sessionStorage.setItem('timetable.bubble.path', JSON.stringify(['evt_ghost2']));
    const r = await fetch('/api/events', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ title: 'ghost-probe', start: new Date(Date.now()+86400000).toISOString().slice(0,19), level: 'sky', parentId: 'evt_ghost2' }),
    });
    const j = await r.json();
    return r.status + '|' + JSON.stringify(j.parentId) + '|' + j.id + '|' + (j.error || '');
  })()`);
  console.log('   服务端回复:', direct);
  const [st, pid, newId, err] = String(direct).split('|');
  check('不再报「父气泡不存在」（不会堵死创建）', st === '200', `status=${st} err=${err}`);
  check('失效的 parentId 被丢弃（parentId=null）', pid === 'null', `parentId=${pid}`);
  check('事件照常创建成功（有 id）', !!newId, `id=${newId}`);
  // 清理探针事件
  if (newId) await q(`fetch('/api/events/${newId}', { method: 'DELETE' })`);

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  ws.close();
} finally {
  child.kill();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(fail ? 1 : 0);
