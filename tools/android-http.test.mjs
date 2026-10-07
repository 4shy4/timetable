// 端到端验证本地 HTTP 服务：在普通 JVM 上跑真正的 LocalServer，
// 然后用 fetch 打它，检查静态资源与全部 API 的响应。
//
// 覆盖的正是**没有安卓设备时最危险的那块**：ServerSocket 手写的 HTTP、
// 资源路径映射、状态码、JSON 形状。这些以前一行都没测过。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const PORT = 17855;

/** 相对"现在"的测试时刻（写死日期会随真实日期腐化，见 event-model.test.mjs 的说明） */
const FUT = (days = 0, hours = 0) => {
  const d = new Date(Date.now() + days * 86_400_000 + hours * 3_600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
};
let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✔ ${name}`); } else {
    fail += 1;
    failures.push(name + (detail ? `  → ${detail}` : ''));
    console.log(`  ✖ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

// ---- 启动 Kotlin 服务器 -----------------------------------------------------
const dataDir = path.join(repo, 'build', 'android-http-test');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const java = path.join(repo, 'android', 'toolchain', 'jdk', 'bin', 'java.exe');
const classes = path.join(os.tmpdir(), 'timetable-parity-stage', 'http-classes');
const m2 = path.join(os.homedir(), '.gradle', 'caches', 'modules-2', 'files-2.1');
function findJar(group, pattern) {
  const root = path.join(m2, group);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.includes('sources') || e.name.includes('javadoc') ? [] : [p];
  });
  const hit = walk(root).filter((f) => new RegExp(pattern).test(path.basename(f)));
  if (!hit.length) throw new Error(`jar not found: ${group}/${pattern}`);
  return hit[0];
}
const stdlib = findJar('org.jetbrains.kotlin/kotlin-stdlib', '^kotlin-stdlib-2\\.0\\.21\\.jar$');
const jsonJar = path.join(repo, 'build', 'json-20240303.jar');

// ⚠️ 沙箱后备通道（和 tools/android-parity.test.mjs 是同一套理由，那边写得更细）：
//    DSH 的 workspace-write 沙箱**禁止 node 用管道 spawn 子进程**
//    （实测 `spawnSync java … EPERM`，errno -4048，status=null、stdout/stderr 全空），
//    所以本文件在沙箱里默认起不来那个 JVM。
//    设了 TIMETABLE_HTTP_BASE（形如 http://127.0.0.1:17855）就**跳过 spawn**，
//    直接打外面已经起好的那一份 —— 服务器仍然是**同一份真代码**
//    （tools/android-http.ps1 编译出来的 http-classes，由调用方自己 java -cp 起）。
//    这不是"跳过测试"，也不是代码坏了；能从管道起的机器上，原路径一行没变。
const externalBase = (process.env.TIMETABLE_HTTP_BASE || '').replace(/\/+$/, '');

// The merged source file is HttpMerged.kt, so Kotlin puts main() in HttpMergedKt.
const child = externalBase ? null : spawn(java, ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8',
  '-cp', `${classes};${stdlib};${jsonJar}`, 'com.timetable.app.HttpMergedKt',
  repo, dataDir, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });

let out = '';
if (child) {
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = externalBase || `http://127.0.0.1:${PORT}`;

function cleanup() {
  try { child?.kill(); } catch { /* ignore */ }
}

try {
  // 等 READY
  let ready = false;
  if (externalBase) {
    // 外部起的服务器：轮询 /api/health 判断"起来了没有"
    for (let i = 0; i < 120; i += 1) {
      try {
        const r = await fetch(`${base}/api/health`);
        if (r.ok) { ready = true; break; }
      } catch { /* 还没起来 */ }
      await sleep(250);
    }
  } else {
    for (let i = 0; i < 60; i += 1) {
      if (out.includes('READY')) { ready = true; break; }
      if (!child.killed && out.includes('Exception')) break;
      await sleep(250);
    }
  }
  if (!ready) {
    console.log('服务器没起来。输出：');
    console.log(out.slice(0, 1500));
    cleanup();
    process.exit(1);
  }
  console.log(`服务器已启动 ${base}\n`);

  // ---- 1) 静态资源 ----
  console.log('静态资源：');
  const idx = await fetch(`${base}/`);
  const idxText = await idx.text();
  check('GET / 200', idx.status === 200, `status=${idx.status}`);
  check('GET / 是 HTML', (idx.headers.get('content-type') || '').includes('text/html'),
    idx.headers.get('content-type'));
  check('GET / 内容含 index 标记', idxText.includes('<div id="app"'), idxText.slice(0, 80));

  const appJs = await fetch(`${base}/ui/app.js`);
  const appJsText = await appJs.text();
  check('GET /ui/app.js 200', appJs.status === 200, `status=${appJs.status}`);
  check('app.js 是 JS mime', (appJs.headers.get('content-type') || '').includes('javascript'),
    appJs.headers.get('content-type'));
  check('app.js 内容非空且像模块', appJsText.length > 500 && appJsText.includes('import'),
    `len=${appJsText.length}`);

  const css = await fetch(`${base}/css/base.css`);
  check('GET /css/base.css 200 且是 css mime',
    css.status === 200 && (css.headers.get('content-type') || '').includes('css'),
    `status=${css.status} ct=${css.headers.get('content-type')}`);

  // core/ 也要能取到（网页里 import 的是 ../../core/...）
  const coreFile = await fetch(`${base}/core/countdown.js`);
  check('GET /core/countdown.js 200', coreFile.status === 200, `status=${coreFile.status}`);

  const svg = await fetch(`${base}/assets/icon.svg`);
  check('GET /assets/icon.svg 200 且是 svg mime',
    svg.status === 200 && (svg.headers.get('content-type') || '').includes('svg'),
    `status=${svg.status} ct=${svg.headers.get('content-type')}`);

  const spa = await fetch(`${base}/some/deep/route`);
  const spaText = await spa.text();
  check('未知路径回退到 index.html（SPA 兜底）',
    spa.status === 200 && spaText.includes('<div id="app"'), `status=${spa.status}`);

  // 安卓**没有 JS 桥**（MainActivity 里没有 addJavascriptInterface），网页想让
  // adapter 知道"我在壳里"，唯一可行的同步信号就是壳自己在 HTML 里注入一个标记。
  // 漏了这行 → web/adapter/native.js 的 platformKind() 恒 null → 闹钟板块又不见了。
  const MARKER = "<script>window.__timetablePlatform='android';</script>";
  check('GET / 注入了平台标记', idxText.includes(MARKER), idxText.slice(0, 200));
  check('平台标记在 <head> 之后（不能跑到 <!DOCTYPE> 前面，否则怪异模式）',
    idxText.indexOf(MARKER) > idxText.indexOf('<head'), `marker@${idxText.indexOf(MARKER)}`);
  check('SPA 兜底也注入标记（刷新子路由不能丢）', spaText.includes(MARKER),
    spaText.slice(0, 200));
  check('注入是幂等的（响应里只出现一次）',
    idxText.split(MARKER).length - 1 === 1, `n=${idxText.split(MARKER).length - 1}`);
  check('非 HTML 资源不被动过（app.js 里没有标记）', !appJsText.includes(MARKER),
    appJsText.slice(0, 80));

  // ---- 2) 健康检查 ----
  console.log('\n健康检查：');
  const health = await (await fetch(`${base}/api/health`)).json();
  check('platform 是 android', health.platform === 'android', JSON.stringify(health));
  check('version 存在', typeof health.version === 'string' && health.version.length > 0);

  // ---- 3) 状态与事件 CRUD ----
  console.log('\n事件 CRUD：');
  const st0 = await (await fetch(`${base}/api/state`)).json();
  check('初始 events 是空数组', Array.isArray(st0.events) && st0.events.length === 0,
    `len=${st0.events?.length}`);
  check('初始 courses 是空数组', Array.isArray(st0.courses) && st0.courses.length === 0);
  check('settings 是对象', st0.settings && typeof st0.settings === 'object');

  const created = await fetch(`${base}/api/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '红容器', start: FUT(10), level: 'red' }),
  });
  const redEv = await created.json();
  check('POST /api/events 200', created.status === 200, `status=${created.status}`);
  check('返回带 id', typeof redEv.id === 'string' && redEv.id.length > 0, JSON.stringify(redEv).slice(0, 120));
  check('level 归一为 red', redEv.level === 'red');
  check('deadline 落到 start', String(redEv.deadline).startsWith(FUT(10).slice(0, 10)));

  const greenRes = await fetch(`${base}/api/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '绿', start: FUT(10, 1), level: 'emerald', parentId: redEv.id }),
  });
  const greenEv = await greenRes.json();
  check('绿色放进红容器', greenRes.status === 200 && greenEv.parentId === redEv.id,
    `status=${greenRes.status} parent=${greenEv.parentId}`);

  const badNest = await fetch(`${base}/api/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '红2', start: FUT(10, 2), level: 'red', parentId: redEv.id }),
  });
  const badNestBody = await badNest.json();
  check('红色放进红色被拒（400）', badNest.status === 400, `status=${badNest.status}`);
  check('拒绝时带可读的 error 文案',
    typeof badNestBody.error === 'string' && badNestBody.error.length > 0,
    JSON.stringify(badNestBody));

  const missingTitle = await fetch(`${base}/api/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ start: FUT(10, 2), level: 'sky' }),
  });
  check('缺 title 被拒（400）', missingTitle.status === 400, `status=${missingTitle.status}`);

  const patched = await fetch(`${base}/api/events/${encodeURIComponent(greenEv.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '绿改名' }),
  });
  const patchedEv = await patched.json();
  check('PATCH 改标题成功', patched.status === 200 && patchedEv.title === '绿改名',
    `status=${patched.status} title=${patchedEv.title}`);
  check('改标题不动 parentId（只挪位置不该改归属）', patchedEv.parentId === redEv.id,
    `parent=${patchedEv.parentId}`);

  const unparent = await fetch(`${base}/api/events/${encodeURIComponent(greenEv.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentId: null }),
  });
  const unparentEv = await unparent.json();
  check('PATCH parentId=null 拉出来', unparent.status === 200 && !unparentEv.parentId,
    `parent=${unparentEv.parentId}`);

  // 装回去，后面测 pop
  await fetch(`${base}/api/events/${encodeURIComponent(greenEv.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parentId: redEv.id }),
  });

  const popped = await fetch(`${base}/api/events/${encodeURIComponent(redEv.id)}/pop`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const popBody = await popped.json();
  check('POST /pop 200', popped.status === 200, `status=${popped.status}`);
  check('pop 标记 done', popBody.event?.done === true, JSON.stringify(popBody.event || {}).slice(0, 100));
  check('pop 返回 released 数组且释放了 1 个',
    Array.isArray(popBody.released) && popBody.released.length === 1,
    JSON.stringify(popBody.released));

  const st1 = await (await fetch(`${base}/api/state`)).json();
  const greenAfter = st1.events.find((e) => e.id === greenEv.id);
  check('被释放的子级 parentId 变空', greenAfter && !greenAfter.parentId,
    `parent=${greenAfter?.parentId}`);

  const del = await fetch(`${base}/api/events/${encodeURIComponent(greenEv.id)}`, { method: 'DELETE' });
  check('DELETE 200', del.status === 200, `status=${del.status}`);
  const st2 = await (await fetch(`${base}/api/state`)).json();
  check('删掉后只剩 1 条', st2.events.length === 1, `len=${st2.events.length}`);

  const del404 = await fetch(`${base}/api/events/evt_nope`, { method: 'DELETE' });
  check('删不存在的事件 → 404', del404.status === 404, `status=${del404.status}`);

  // ---- 4) 设置 ----
  console.log('\n设置：');
  const setRes = await fetch(`${base}/api/settings`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ termStart: FUT(7).slice(0, 10), termWeeks: 16 }),
  });
  const setBody = await setRes.json();
  check('PATCH /api/settings 200', setRes.status === 200, `status=${setRes.status}`);
  check('termStart 写入成功', setBody.termStart === FUT(7).slice(0, 10), JSON.stringify(setBody).slice(0, 120));

  // ---- 5) 课表导入 ----
  console.log('\n课表导入：');
  const importRes = await fetch(`${base}/api/courses/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'merge',
      meta: {
        source: 'httptest', termStart: FUT(7).slice(0, 10), termWeeks: 16,
        sectionTimes: [
          { index: 1, start: '08:00', end: '08:45' },
          { index: 2, start: '08:50', end: '09:35' },
          { index: 5, start: '13:30', end: '14:15' },
          { index: 6, start: '14:20', end: '15:05' },
        ],
      },
      courses: [
        { key: 'k1', title: '高等数学', dayOfWeek: 1, sections: [1, 2], weeks: [1, 2, 3, 4], location: '广楼G309', eventKey: 'course:k1|1|1,2' },
        { key: 'k1', title: '高等数学', dayOfWeek: 3, sections: [5, 6], weeks: [1, 2, 3, 4], location: '广楼G309', eventKey: 'course:k1|3|5,6' },
      ],
    }),
  });
  const importBody = await importRes.json();
  check('导入 200', importRes.status === 200, `status=${importRes.status}`);
  check('报了 added=1（一门课）', importBody.added === 1, JSON.stringify(importBody));

  const courses = await (await fetch(`${base}/api/courses`)).json();
  check('courses 表有 1 门', Array.isArray(courses.courses) && courses.courses.length === 1,
    `len=${courses.courses?.length}`);
  check('meetings 有 2 段', courses.courses?.[0]?.meetings?.length === 2,
    `len=${courses.courses?.[0]?.meetings?.length}`);

  const st3 = await (await fetch(`${base}/api/state`)).json();
  const courseEvs = st3.events.filter((e) => e.type === 'course');
  check('两段上课 = 两条事件', courseEvs.length === 2, `len=${courseEvs.length}`);
  const starts = courseEvs.map((e) => e.start.slice(11, 16)).sort();
  check('节次时间按作息表（08:00 / 13:30）',
    starts.join(',') === '08:00,13:30', starts.join(','));
  check('开始 ≠ 结束', courseEvs.every((e) => e.start !== e.end));

  // ---- 6) 提醒端点 ----
  // 设置页的「发送一条测试通知」打 /api/reminders/test；
  // 网页里的页内提醒循环打 /api/reminders/due。
  // 之前 /api/reminders/test **根本没实现** —— 点了就是"测试失败"。
  console.log('\n提醒端点：');
  const due = await fetch(`${base}/api/reminders/due`);
  const dueBody = await due.json();
  check('GET /api/reminders/due 200', due.status === 200, `status=${due.status}`);
  check('due 返回 items 数组（形状要与桌面版一致）', Array.isArray(dueBody.items),
    JSON.stringify(dueBody).slice(0, 120));

  const testNoti = await fetch(`${base}/api/reminders/test`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  check('/api/reminders/test 不再是 404', testNoti.status !== 404, `status=${testNoti.status}`);
  const testBody = await testNoti.json();
  // harness 里注入了一个**假的通知出口**（RecordingNotifier），所以这条走的是
  // "发得出去"的成功路径 —— 不注入的话只能测到失败分支，成功分支一行都覆盖不到。
  check('有通知出口时 ok=true', testBody.ok === true, JSON.stringify(testBody).slice(0, 160));
  check('响应 200', testNoti.status === 200, `status=${testNoti.status}`);

  // 不塞 debug 路由进生产代码：直接用 store 自己的**账本**来验证
  // —— 账本里出现了 key，就说明确实有一条提醒到点并触发了。
  const ledger = await (await fetch(`${base}/api/reminders/ledger`)).json();
  check('ledger 接口可用且返回 keys', Array.isArray(ledger.keys),
    JSON.stringify(ledger).slice(0, 120));

  // ---- 6b) 闹钟（形状对标桌面版 server/api.js:690-710）----
  // 之前安卓**一条 /api/alarms 路由都没有** → 网页保存闹钟直接 404，闹钟板块也
  // 被 alarmsViewAllowed() 挡掉。这一节钉住新加的四个路由的形状与错误码。
  console.log('\n闹钟：');
  const stA0 = await (await fetch(`${base}/api/state`)).json();
  check('新库里 alarms 是空数组（老库升级也不能是 undefined）',
    Array.isArray(stA0.alarms) && stA0.alarms.length === 0, JSON.stringify(stA0.alarms));

  const mkAlarm = await fetch(`${base}/api/alarms`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'clock', atHour: 7, atMinute: 30, repeat: 'daily', label: '起床' }),
  });
  const alarm = await mkAlarm.json();
  check('POST /api/alarms 200', mkAlarm.status === 200, `status=${mkAlarm.status}`);
  check('闹钟返回带 id', typeof alarm.id === 'string' && alarm.id.startsWith('alarm_'),
    JSON.stringify(alarm).slice(0, 120));
  check('默认铃声是 triple（与 core/alarms.js 的 DEFAULT_SOUND 一致）',
    alarm.sound === 'triple', `sound=${alarm.sound}`);
  check('enabled 默认 true', alarm.enabled === true, `enabled=${alarm.enabled}`);
  check('带 createdAt', typeof alarm.createdAt === 'string' && alarm.createdAt.length > 0);

  const stA1 = await (await fetch(`${base}/api/state`)).json();
  check('GET /api/state 带上了 alarms', Array.isArray(stA1.alarms) && stA1.alarms.length === 1,
    `len=${stA1.alarms?.length}`);

  // 校验失败必须带机器可读的 code —— 前端靠它把错误定位到具体那一栏
  const badHour = await fetch(`${base}/api/alarms`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'clock', atHour: 25, atMinute: 0, repeat: 'daily' }),
  });
  const badHourBody = await badHour.json();
  check('atHour=25 → 400', badHour.status === 400, `status=${badHour.status}`);
  check('400 带 code=ALARM_HOUR', badHourBody.code === 'ALARM_HOUR', JSON.stringify(badHourBody));
  check('400 带人话 error', typeof badHourBody.error === 'string' && badHourBody.error.length > 0,
    JSON.stringify(badHourBody).slice(0, 120));

  const badSound = await fetch(`${base}/api/alarms`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'clock', atHour: 7, atMinute: 0, repeat: 'daily', sound: 'nope' }),
  });
  check('怪铃声 → 400 ALARM_SOUND',
    badSound.status === 400 && (await badSound.json()).code === 'ALARM_SOUND',
    `status=${badSound.status}`);

  const alarmId = encodeURIComponent(alarm.id);

  const off = await fetch(`${base}/api/alarms/${alarmId}/toggle`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  const offBody = await off.json();
  check('toggle 关掉 200 且 enabled=false',
    off.status === 200 && offBody.enabled === false,
    `status=${off.status} enabled=${offBody.enabled}`);
  check('toggle 后还在库里（关掉 ≠ 删除）',
    (await (await fetch(`${base}/api/state`)).json()).alarms.length === 1);

  // 没有 body 的 toggle 当"开"处理（与桌面版一致，网页那颗开关发的就是 {enabled:bool}）
  const onNoBody = await fetch(`${base}/api/alarms/${alarmId}/toggle`, { method: 'POST', body: '{}' });
  check('toggle 不带 body 视为开启',
    onNoBody.status === 200 && (await onNoBody.json()).enabled === true, `status=${onNoBody.status}`);

  const toggle404 = await fetch(`${base}/api/alarms/alarm_nope/toggle`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const toggle404Body = await toggle404.json();
  check('toggle 不存在的闹钟 → 404', toggle404.status === 404, `status=${toggle404.status}`);
  check('404 带 code=ALARM_NOT_FOUND', toggle404Body.code === 'ALARM_NOT_FOUND',
    JSON.stringify(toggle404Body));

  const pa = await fetch(`${base}/api/alarms/${alarmId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ atHour: 8, atMinute: 5, label: '改成八点' }),
  });
  const paBody = await pa.json();
  check('PATCH 200 且改了时间', pa.status === 200 && paBody.atHour === 8 && paBody.atMinute === 5,
    `status=${pa.status} ${paBody.atHour}:${paBody.atMinute}`);
  check('PATCH 保留 id（编辑不能变成新增）', paBody.id === alarm.id, `id=${paBody.id}`);
  check('PATCH 保留 createdAt', paBody.createdAt === alarm.createdAt);
  check('PATCH 后库里仍是 1 条',
    (await (await fetch(`${base}/api/state`)).json()).alarms.length === 1);

  // URL 里的 id 是权威：body 里塞别的 id 也不许把它改成另一条（或者说凭空造一条）
  const idHijack = await fetch(`${base}/api/alarms/${alarmId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'alarm_hijack', label: '试图改 id' }),
  });
  const idHijackBody = await idHijack.json();
  check('PATCH 的 id 以 URL 为准（body 里的 id 被覆盖）',
    idHijackBody.id === alarm.id, `id=${idHijackBody.id}`);

  // PATCH 一个**不存在**的 id，在桌面版是"新建"而不是 404：server/api.js:708 走的是
  // store.saveAlarm({...body, id}) → core/state-ops.upsertAlarm，本来就是 upsert。
  // 安卓必须同语义，这里故意钉住它 —— 免得以后有人"顺手"改成 404 而让两端分叉。
  const patchNew = await fetch(`${base}/api/alarms/alarm_nope`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'clock', atHour: 9, atMinute: 0, repeat: 'daily', label: '新建' }),
  });
  const patchNewBody = await patchNew.json();
  check('PATCH 不存在的 id = 新建（与桌面版 upsert 同语义，不是 404）',
    patchNew.status === 200 && patchNewBody.id === 'alarm_nope',
    `status=${patchNew.status} id=${patchNewBody.id}`);
  const delNope = await fetch(`${base}/api/alarms/alarm_nope`, { method: 'DELETE' });
  check('收尾把这条误建的删掉', delNope.status === 200 && (await delNope.json()).removed === 1,
    `status=${delNope.status}`);

  // 铃声列表：LocalServer 刻意不 import android.*，所以这个能力是**注入**进来的。
  // harness 没注入 provider —— 这里正好钉住"没注入时回空数组、不炸"这条契约。
  const sounds = await fetch(`${base}/api/alarms/sounds`);
  const soundsBody = await sounds.json();
  check('GET /api/alarms/sounds 200', sounds.status === 200, `status=${sounds.status}`);
  check('没有注入 provider 时回空数组（不是 404、不是崩溃）',
    Array.isArray(soundsBody.sounds) && soundsBody.sounds.length === 0,
    JSON.stringify(soundsBody).slice(0, 120));

  const delAlarm = await fetch(`${base}/api/alarms/${alarmId}`, { method: 'DELETE' });
  const delAlarmBody = await delAlarm.json();
  check('DELETE 200 且 removed=1',
    delAlarm.status === 200 && delAlarmBody.removed === 1,
    `status=${delAlarm.status} ${JSON.stringify(delAlarmBody)}`);
  const delAgain = await fetch(`${base}/api/alarms/${alarmId}`, { method: 'DELETE' });
  check('再删一次是幂等的（removed=0，不报 404）',
    delAgain.status === 200 && (await delAgain.json()).removed === 0, `status=${delAgain.status}`);
  check('删完库里 alarms 为空',
    (await (await fetch(`${base}/api/state`)).json()).alarms.length === 0);

  const alarmWrongMethod = await fetch(`${base}/api/alarms/${alarmId}`, { method: 'PUT', body: '{}' });
  check('闹钟路径上的怪方法 → 405（不是静默 404）',
    alarmWrongMethod.status === 405, `status=${alarmWrongMethod.status}`);

  // ---- 7) 明确未实现的接口要给可读错误（而不是静默 200）----
  console.log('\n未实现接口的契约：');
  const tj = await fetch(`${base}/api/courses/tj/meta`, { method: 'POST', body: '{}' });
  check('已移除的在线接口 → 501', tj.status === 501, `status=${tj.status}`);
  const tjBody = await tj.json();
  check('501 带可读说明', typeof tjBody.error === 'string' && tjBody.error.length > 5,
    JSON.stringify(tjBody).slice(0, 120));

  const bogus = await fetch(`${base}/api/not-a-real-route`);
  check('未知 API → 404', bogus.status === 404, `status=${bogus.status}`);

  // ---- 8) 落盘：重启后数据还在 ----
  console.log('\n落盘：');
  // 留一条闹钟在库里，好检查它真的写进了 db.json（而不是只活在内存里）
  const keepAlarm = await fetch(`${base}/api/alarms`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'clock', atHour: 6, atMinute: 45, repeat: 'once', label: '留一条' }),
  });
  check('收尾再建一条闹钟 200', keepAlarm.status === 200, `status=${keepAlarm.status}`);
  const dbFile = path.join(dataDir, 'db.json');
  check('db.json 已写出', fs.existsSync(dbFile));
  const dbRaw = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  check('db.json 里 events 数量对', Array.isArray(dbRaw.events) && dbRaw.events.length === st3.events.length,
    `disk=${dbRaw.events?.length} mem=${st3.events.length}`);
  check('db.json 里 courses 数量对', dbRaw.courses?.length === 1, `len=${dbRaw.courses?.length}`);
  check('db.json 里 alarms 也落了盘', Array.isArray(dbRaw.alarms) && dbRaw.alarms.length === 1,
    `len=${dbRaw.alarms?.length}`);
} catch (err) {
  fail += 1;
  failures.push(`未捕获异常: ${err.message}`);
  console.log(`\n✖ 未捕获异常: ${err.stack}`);
} finally {
  cleanup();
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
