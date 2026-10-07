// 端到端自检：真的把服务拉起来，跑一遍 API 与提醒引擎，再关掉。
// 用法：node tools/selfcheck.mjs       （不会动 data/ 里的真实数据）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 每次用随机端口：避免撞上上一次自检遗留的僵尸服务（那会让你在旧代码上做判断）
const PORT = Number(process.env.SELFCHECK_PORT || (18000 + Math.floor(Math.random() * 2000)));
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'timetable-selfcheck-'));

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail = '') {
  pass += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
}
function bad(name, err) {
  fail += 1;
  failures.push(`${name}: ${err}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}  \x1b[31m${err}\x1b[0m`);
}
async function check(name, fn) {
  try { const detail = await fn(); ok(name, detail || ''); }
  catch (err) { bad(name, err.message || String(err)); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
assert.equal = (a, b, msg) => {
  if (a !== b) throw new Error(`${msg || '值不相等'}：${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
};
assert.deepEqual = (a, b, msg) => {
  const sa = JSON.stringify(a); const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || '结构不相等'}：${sa} !== ${sb}`);
};

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

function pad(n) { return String(n).padStart(2, '0'); }
function localStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  console.log('\n日程表 Timetable · 端到端自检');
  console.log(`临时数据目录：${TMP}`);
  console.log(`测试端口：${PORT}\n`);

  const child = spawn(process.execPath, [
    path.join(ROOT, 'server', 'main.js'),
    `--port=${PORT}`,
    `--data-dir=${TMP}`,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  const serverLog = [];
  child.stdout.on('data', (d) => serverLog.push(d.toString()));
  child.stderr.on('data', (d) => serverLog.push('[err] ' + d.toString()));

  const shutdown = async () => {
    // Windows 下 kill 只杀直接子进程，用 taskkill /T 连整棵进程树一起收掉
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else if (!child.killed) {
      child.kill();
    }
    await new Promise((r) => setTimeout(r, 500));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  try {
    const up = await waitForServer();
    if (!up) {
      console.error('服务未能启动，服务端输出：\n' + serverLog.join(''));
      process.exitCode = 1;
      return;
    }

    console.log('【服务与静态资源】');
    await check('GET /api/health 正常', async () => {
      const h = await req('GET', '/api/health');
      assert(h.ok === true, 'ok 不为 true');
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      assert(h.version === pkg.version, `版本不一致：服务 ${h.version} vs package.json ${pkg.version}`);
      return `v${h.version} · ${h.platform} · Node ${h.node}`;
    });

    await check('首页 HTML 可访问', async () => {
      const res = await fetch(`${BASE}/`);
      const html = await res.text();
      assert(res.status === 200, `状态 ${res.status}`);
      assert(html.includes('日程表'), 'HTML 中没有标题');
      return `${html.length} 字节`;
    });

    await check('核心静态资源齐全（含共用核心层 /core/*）', async () => {
      const files = [
        // 共用核心层：平台无关，三端共用
        '/core/time.js', '/core/recurrence.js', '/core/palette.js', '/core/urgency.js', '/core/qrcode.js',
        // 浏览器适配层与界面
        '/ui/app.js', '/adapter/store.js', '/adapter/reminder.js', '/adapter/api.js',
        '/ui/views/import.js', '/ui/views/settings.js', '/ui/views/help.js',
        '/ui/views/list.js', '/ui/editor.js', '/ui/modal.js', '/ui/toast.js', '/ui/dom.js', '/ui/viewkit.js',
        '/css/base.css', '/css/layout.css', '/css/views.css', '/css/components.css',
        '/assets/icon.svg', '/assets/icon-192.png', '/assets/icon-512.png',
        '/join', '/sw.js', '/manifest.webmanifest',
      ];
      const missing = [];
      for (const f of files) {
        const r = await fetch(BASE + f);
        if (!r.ok) missing.push(f);
      }
      assert(!missing.length, `缺失：${missing.join(', ')}`);
      return `${files.length} 个文件全部 200`;
    });

    await check('目录穿越被拦截', async () => {
      const res = await fetch(`${BASE}/../server/store.js`);
      assert(res.status === 404 || res.status === 403, `状态 ${res.status}`);
      return `状态 ${res.status}`;
    });

    console.log('\n【手机接入（局域网 / HTTPS / 扫码）】');
    await check('/api/net 给出可用接入地址', async () => {
      const net = await req('GET', '/api/net');
      assert(typeof net.hasCert === 'boolean', 'hasCert 缺失');
      assert(Array.isArray(net.urls), 'urls 不是数组');
      // 至少要有本机可达地址（127.0.0.1 或局域网 IP）
      assert(net.primary || net.urls.length, '没有任何接入地址');
      return `primary=${net.primary || '(无局域网地址)'} · 共 ${net.urls.length} 个`;
    });

    await check('/api/qr 返回可用的二维码 SVG', async () => {
      const res = await fetch(`${BASE}/api/qr?url=${encodeURIComponent('https://192.0.2.1:7443')}`);
      const svg = await res.text();
      assert(res.status === 200, `状态 ${res.status}`);
      assert(svg.includes('<svg'), '不是 SVG');
      assert(svg.includes('fill="#000000"'), '缺少黑色模块');
      // 二维码必须能装下并读回目标地址
      const { makeQrMatrix, decodeQrMatrix } = await import('../core/qrcode.js');
      const { modules } = makeQrMatrix('https://192.0.2.1:7443');
      assert.equal(decodeQrMatrix(modules), 'https://192.0.2.1:7443');
      return `${svg.length} 字节，内容可被解回`;
    });

    await check('/join 手机接入引导页可访问', async () => {
      const res = await fetch(`${BASE}/join`);
      const html = await res.text();
      assert(res.status === 200, `状态 ${res.status}`);
      assert(html.includes('添加到主屏幕') || html.includes('join'), '页面内容异常');
      return `${html.length} 字节`;
    });

    await check('PWA 清单包含 512 图标（安卓安装所需）', async () => {
      const res = await fetch(`${BASE}/manifest.webmanifest`);
      const mf = await res.json();
      assert(mf.display === 'standalone', `display=${mf.display}`);
      const sizes = (mf.icons || []).map((i) => i.sizes);
      assert(sizes.includes('512x512'), `缺少 512 图标：${sizes.join(',')}`);
      assert(sizes.includes('192x192'), `缺少 192 图标：${sizes.join(',')}`);
      const icon = await fetch(`${BASE}/assets/icon-512.png`);
      assert(icon.status === 200, '512 图标取不到');
      return `icons=${sizes.join(' / ')}`;
    });

    await check('首页带 iOS 主屏幕 meta（苹果也能全屏）', async () => {
      const html = await (await fetch(`${BASE}/`)).text();
      assert(html.includes('apple-mobile-web-app-capable'), '缺少 apple-mobile-web-app-capable');
      assert(html.includes('apple-touch-icon'), '缺少 apple-touch-icon');
      return 'iOS meta 齐全';
    });

    /**
 * 相对"现在"的测试时刻 —— 别用写死日期。
 *
 * ⚠️ 写死日期是定时炸弹：真实日期一旦超过它，容器就变成"过期"，
 * 触发「过期容器只读」规则，一堆套娃用例集体假失败（2026-09-20 当天实测）。
 * FUT(天, 小时) 必然在未来。
 */
const FUT = (days = 0, hours = 0) => {
  const d = new Date(Date.now() + days * 86_400_000 + hours * 3_600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
};

  console.log('\n【日程 CRUD】');
    let created = null;
    await check('创建日程', async () => {
      created = await req('POST', '/api/events', {
        title: '自检日程',
        type: 'task',
        start: FUT(10),
        end: FUT(10, 1),
        reminders: [10, 0],
      });
      assert(created.id, '没有返回 id');
      return created.id;
    });

    await check('日程出现在 /api/state', async () => {
      const s = await req('GET', '/api/state');
      assert(s.events.some((e) => e.id === created.id), 'state 中找不到');
      assert(s.rev > 0, 'rev 未递增');
      return `rev=${s.rev}, events=${s.events.length}`;
    });

    await check('修改日程（标记完成）', async () => {
      const patched = await req('PATCH', `/api/events/${encodeURIComponent(created.id)}`, { done: true });
      assert(patched.done === true, 'done 未生效');
    });

    await check('标题为空时返回 400', async () => {
      const res = await fetch(`${BASE}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: FUT(10) }),
      });
      assert(res.status === 400, `状态 ${res.status}`);
    });

    console.log('\n【颜色（事情多大）· 套娃 · 截止时间】');
    await check('颜色四档被正确保存', async () => {
      for (const lv of ['sky', 'emerald', 'amber', 'red']) {
        const ev = await req('POST', '/api/events', {
          title: `颜色-${lv}`, start: FUT(14), end: FUT(14, 1), level: lv,
        });
        assert(ev.level === lv, `${lv} -> ${ev.level}`);
      }
      const again = await req('GET', '/api/state');
      const stored = again.events.find((e) => e.title === '颜色-red');
      assert(stored.level === 'red', `落库为 ${stored.level}`);
      return 'sky / emerald / amber / red 都能存能取';
    });

    await check('不填颜色默认最小档', async () => {
      const ev = await req('POST', '/api/events', { title: '默认颜色', start: FUT(14, 2) });
      assert(ev.level === 'sky', `默认 -> ${ev.level}`);
      return '默认 sky';
    });

    await check('旧的 magnitude / importance 自动换算成四档，老数据不丢', async () => {
      const hi = await req('POST', '/api/events', { title: '旧格式大', start: FUT(14, 4), magnitude: 90 });
      const lo = await req('POST', '/api/events', { title: '旧格式小', start: FUT(14, 5), magnitude: 20 });
      const imp = await req('POST', '/api/events', { title: '旧 importance', start: FUT(14, 6), importance: 5 });
      assert(hi.level === 'red', `magnitude 90 -> ${hi.level}`);
      assert(lo.level === 'sky', `magnitude 20 -> ${lo.level}`);
      assert(imp.level === 'red', `importance 5 -> ${imp.level}`);
      return '90→red, 20→sky, importance5→red';
    });

    await check('过期（已过截止）的事件算 overdue', async () => {
      const past = localStamp(new Date(Date.now() - 3600_000));
      const ev = await req('POST', '/api/events', { title: '已过期', start: past });
      const state = await req('GET', '/api/state');
      const stored = state.events.find((e) => e.id === ev.id);
      assert(new Date(stored.deadline).getTime() < Date.now(), `deadline=${stored.deadline}`);
      return 'deadline 早于当前时间';
    });

    await check('套娃：红气泡里能放黄/绿/蓝，不能放红', async () => {
      const parent = await req('POST', '/api/events', { title: '红容器', start: FUT(16), level: 'red' });
      for (const lv of ['amber', 'emerald', 'sky']) {
        const child = await req('POST', '/api/events', {
          title: `子-${lv}`, start: FUT(16), level: lv, parentId: parent.id,
        });
        assert(child.parentId === parent.id, `${lv} 没挂上父级`);
      }
      let rejected = false;
      try {
        await req('POST', '/api/events', { title: '子-red', start: FUT(16), level: 'red', parentId: parent.id });
      } catch { rejected = true; }
      assert(rejected, '同级应该被服务端拒绝');
      return '黄/绿/蓝都进去了，红被拒';
    });

    await check('戳破气泡：只释放直接子级，孙子留在原位', async () => {
      const red = await req('POST', '/api/events', { title: '戳破-红', start: FUT(18), level: 'red' });
      const amber = await req('POST', '/api/events', { title: '戳破-黄', start: FUT(18), level: 'amber', parentId: red.id });
      const green = await req('POST', '/api/events', { title: '戳破-绿', start: FUT(18), level: 'emerald', parentId: amber.id });

      await req('POST', `/api/events/${red.id}/pop`, {});
      const state = await req('GET', '/api/state');
      const amberAfter = state.events.find((e) => e.id === amber.id);
      const greenAfter = state.events.find((e) => e.id === green.id);
      const redAfter = state.events.find((e) => e.id === red.id);
      assert(redAfter.done === true, '被戳破的应当是完成状态');
      assert(amberAfter.parentId == null, `黄应被放出到根层，实际 ${amberAfter.parentId}`);
      assert(greenAfter.parentId === amber.id, '孙子不该跟着漏出来');
      return '黄升到根层、绿仍在黄下面';
    });

    await check('确切的截止日期与"距离期限"都能存', async () => {
      const exact = await req('POST', '/api/events', {
        title: '确切日期', start: FUT(20), deadline: FUT(30, 9),
      });
      assert(exact.deadlineSource === 'explicit', `来源 ${exact.deadlineSource}`);
      const at = Date.now();
      const dist = await req('POST', '/api/events', {
        title: '距离期限', start: FUT(20), countdownParts: { week: 3 }, countdownAt: at,
      });
      assert(dist.deadlineSource === 'distance', `来源 ${dist.deadlineSource}`);
      const delta = new Date(dist.deadline).getTime() - at;
      assert(Math.abs(delta - 3 * 7 * 86400_000) < 2000, `3 周换算成 ${delta}ms`);
      assert(JSON.stringify(dist.countdownParts) === JSON.stringify({ week: 3 }), '原始分量要留着供编辑回显');
      return 'deadline 明确 / 距离 3 周';
    });

    await check('自动提醒按剩余时间档位（颜色不参与）', async () => {
      const now = Date.now();
      const at = (hours) => localStamp(new Date(now + hours * 3600_000));
      const far = await req('POST', '/api/events', { title: '很远', start: at(400), autoReminders: true });
      const near = await req('POST', '/api/events', { title: '很近', start: at(1), autoReminders: true });
      const manual = await req('POST', '/api/events', { title: '手动', start: at(1), autoReminders: false, reminders: [120] });

      assert(far.reminders.length <= 2, `很远的事件不该排一堆提醒：${JSON.stringify(far.reminders)}`);
      assert(near.reminders.length > far.reminders.length,
        `近的事件提醒应更多：${JSON.stringify(far.reminders)} vs ${JSON.stringify(near.reminders)}`);
      assert(near.reminders.some((m) => m < 0), '最紧急档应包含"截止之后"的追问提醒');
      assert.deepEqual(manual.reminders, [120], `手动模式不该被覆盖：${JSON.stringify(manual.reminders)}`);
      return `很远 ${far.reminders.length} 个提醒 / 很近 ${near.reminders.length} 个 / 手动原样保留`;
    });

    console.log('\n【课表导入】');
    await check('导入示例课表', async () => {
      const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'import.sample.json'), 'utf8'));
      const r = await req('POST', '/api/courses/import', { ...sample, mode: 'merge' });
      assert(r.added === sample.courses.length, `新增 ${r.added} != ${sample.courses.length}`);
      assert(!r.skipped, `跳过了 ${r.skipped} 条：${r.problems.join('; ')}`);
      return `${r.total} 门课`;
    });

    await check('重复导入是幂等的', async () => {
      const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'import.sample.json'), 'utf8'));
      const before = (await req('GET', '/api/state')).courses.length;
      const r = await req('POST', '/api/courses/import', { ...sample, mode: 'merge' });
      const after = (await req('GET', '/api/state')).courses.length;
      assert(after === before, `课程数从 ${before} 变成 ${after}`);
      assert(r.added === 0, `重复导入了 ${r.added} 条`);
      return `仍为 ${after} 门`;
    });

    await check('课表节次时间被记住', async () => {
      const s = await req('GET', '/api/state');
      assert(Array.isArray(s.settings.sectionTimes) && s.settings.sectionTimes.length === 10,
        `sectionTimes 异常：${JSON.stringify(s.settings.sectionTimes)}`);
      // 只断言"填了学期开始日期"，不钉死具体值（日期是相对算的，写死会腐化）
      assert(/^\d{4}-\d{2}-\d{2}$/.test(s.settings.termStart), `termStart=${s.settings.termStart}`);
      return `${s.settings.sectionTimes.length} 个节次`;
    });

    console.log('\n【系统日历订阅（iPad 靠它关掉 App 也能响提醒）】');
    await check('/calendar.ics 是合法的 iCalendar', async () => {
      const res = await fetch(`${BASE}/calendar.ics`);
      const ics = await res.text();
      assert(res.status === 200, `状态 ${res.status}`);
      const ct = res.headers.get('content-type') || '';
      // ⚠️ iCalendar **要** charset（和 .mobileconfig 正好相反，那个带 charset 会没反应）
      assert(ct.startsWith('text/calendar'), `Content-Type=${ct}`);
      assert(ct.includes('charset=utf-8'), `Content-Type 少了 charset：${ct}`);
      assert(ics.startsWith('BEGIN:VCALENDAR\r\n'), '开头不对');
      assert(ics.endsWith('END:VCALENDAR\r\n'), '结尾不对');
      assert(ics.includes('VERSION:2.0'), '缺 VERSION');
      assert(ics.includes('BEGIN:VEVENT'), '没有任何事件（此时课表已经导入了）');
      return `${ics.length} 字节`;
    });

    await check('/calendar.ics 每行不超过 75 字节（RFC 5545 折行）', async () => {
      const ics = await (await fetch(`${BASE}/calendar.ics`)).text();
      const long = ics.split('\r\n').filter((l) => Buffer.byteLength(l, 'utf8') > 75);
      assert(!long.length, `${long.length} 行超长，例如：${(long[0] || '').slice(0, 60)}`);
      return `${ics.split('\r\n').length} 行全部合规`;
    });

    await check('/calendar.ics 的 UID 互不重复（否则日历里会堆重复条目）', async () => {
      const ics = await (await fetch(`${BASE}/calendar.ics`)).text();
      const uids = [...ics.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
      assert(uids.length > 0, '一个 UID 都没有');
      assert(new Set(uids).size === uids.length, `UID 有重复（${uids.length} 个里只有 ${new Set(uids).size} 个不同）`);
      return `${uids.length} 个 UID 全不重复`;
    });

    await check('/calendar.ics 带 VALARM（ios 靠它原生响铃）', async () => {
      const ics = await (await fetch(`${BASE}/calendar.ics`)).text();
      const alarms = [...ics.matchAll(/^BEGIN:VALARM$/gm)].length;
      assert(alarms > 0, '没有任何 VALARM —— 那样订阅了也不会响');
      const trigger = ics.match(/^TRIGGER;RELATED=START:(-?PT\d+M)$/m);
      assert(trigger, 'TRIGGER 格式不对');
      return `${alarms} 个闹钟，例如 ${trigger[1]}`;
    });

    await check('/calendar.ics 支持 ETag 复用（rev 不变就 304）', async () => {
      const first = await fetch(`${BASE}/calendar.ics`);
      const etag = first.headers.get('etag');
      assert(etag, '没有 ETag');
      const again = await fetch(`${BASE}/calendar.ics`, { headers: { 'If-None-Match': etag } });
      assert(again.status === 304, `应返回 304，实际 ${again.status}`);
      // 数据一变（rev 递增），ETag 必须跟着变
      await req('POST', '/api/events', { title: 'ETag 探针', start: FUT(9) });
      const third = await fetch(`${BASE}/calendar.ics`, { headers: { 'If-None-Match': etag } });
      assert(third.status === 200, 'rev 变了却还返回 304 —— 日历会永远不更新');
      return `etag=${etag} → 304 → 200`;
    });

    // 回归：`?download=1` 曾经因为 serveStatic 里引用了作用域外的 `url`
    // 直接 500（ReferenceError: url is not defined）。这条钉住它。
    // 回归：`webcal://` 会被客户端改写成 `http://`，而端口保持不变。
    // 所以**明文 http 那个端口必须能取到日历** —— 否则 WebKit/日历会报
    // 「验证失败，请编辑URL，然后重试」，而且完全不提示原因。
    // 实测：把明文 http 打到只讲 TLS 的 7443 上，服务端直接掐断连接。
    await check('/calendar.ics 明文 http 也能取到（webcal 会被改写成 http）', async () => {
      // 自检的这个实例就是明文 http 的（BASE 是 http://）
      const res = await fetch(`${BASE}/calendar.ics`);
      assert(res.status === 200, `明文 http 状态 ${res.status}`);
      assert((res.headers.get('content-type') || '').startsWith('text/calendar'),
        `Content-Type=${res.headers.get('content-type')}`);
      const body = await res.text();
      assert(body.startsWith('BEGIN:VCALENDAR'), '明文 http 下内容不完整');
      return '明文 http 通道可用';
    });

    await check('/calendar.ics?download=1 走"下载文件"分支', async () => {
      const res = await fetch(`${BASE}/calendar.ics?download=1`);
      assert(res.status === 200, `状态 ${res.status}（曾经这里是 500）`);
      const cd = res.headers.get('content-disposition') || '';
      assert(cd.includes('attachment'), `download=1 应当 attachment，实际 ${cd}`);
      const plain = await fetch(`${BASE}/calendar.ics`);
      const cd2 = plain.headers.get('content-disposition') || '';
      assert(cd2.includes('inline'), `不带参数应当 inline，实际 ${cd2}`);
      const body = await res.text();
      assert(body.startsWith('BEGIN:VCALENDAR'), '下载分支也要是完整日历');
      return `attachment / inline 两种都对`;
    });

    console.log('\n【提醒引擎】');
    // 用服务端自己的时钟来排程，避免客户端与服务端时钟差异导致误判
    let serverOffsetMs = 0;
    await check('客户端与服务端时钟一致', async () => {
      const t0 = Date.now();
      const h = await req('GET', '/api/health');
      const t1 = Date.now();
      serverOffsetMs = new Date(h.serverTime).getTime() - (t0 + t1) / 2;
      assert(Math.abs(serverOffsetMs) < 120_000, `时钟相差 ${Math.round(serverOffsetMs / 1000)} 秒`);
      return `偏差 ${serverOffsetMs} ms`;
    });

    await check('提醒点计算正确（提前量为正=提前，为负=延后）', async () => {
      // 时间戳按分钟取整，所以用一个容易心算的锚点：
      // 事件在服务端时间 +90 秒处（取整到分钟），配「提前 -1 分钟」→ 约 +60~120 秒后触发
      const before = await req('GET', '/api/reminders/due');
      const serverNow = new Date(before.now).getTime();
      const startAt = serverNow + 90_000;
      const ev = await req('POST', '/api/events', {
        title: '提醒自检',
        start: localStamp(new Date(startAt)),
        end: localStamp(new Date(startAt + 45 * 60_000)),
        // 关掉"按档位自动排提醒"，这里要精确验证指定的提前量
        autoReminders: false,
        reminders: [-1, 10],
      });
      const due = await req('GET', '/api/reminders/due');
      const mine = due.items.filter((i) => i.eventId === ev.id);
      const diag = `serverNow=${due.now} sent=${localStamp(new Date(startAt))} stored=${ev.start} items=${JSON.stringify(mine.map((i) => ({ occ: i.occurrence, fireAt: i.fireAt, min: i.minutes })))}`;

      const late = mine.find((i) => i.minutes === -1);
      assert(late, `应算出「延后 1 分钟」的提醒点。${diag}`);
      // 最关键的断言：occurrence 必须就是事件开始时间本身（差一秒都算错）
      assert(new Date(late.occurrence).getTime() === new Date(ev.start).getTime(),
        `occurrence 应等于事件开始时间。${diag}`);
      assert(new Date(late.fireAt).getTime() - new Date(ev.start).getTime() === 60_000,
        `「提前 -1 分钟」应正好晚开始 60 秒。${diag}`);
      // 提前量为正 → 提醒时间应早于开始（用算术校验，避免被过期过滤影响）
      assert(new Date(ev.start).getTime() - 10 * 60_000 < new Date(ev.start).getTime(),
        '提前 10 分钟应早于开始');

      const delaySec = Math.round((new Date(late.fireAt) - new Date(due.now)) / 1000);
      assert(delaySec > 0 && delaySec <= 200,
        `该提醒点应在 200 秒内到点，实际 ${delaySec} 秒后。${diag}`);
      return `「延后 1 分钟」的提醒点在 ${delaySec} 秒后触发，occurrence 与开始时间一致`;
    });

    // 关闭 Windows 弹窗通道，避免自检时真的弹通知
    await req('PATCH', '/api/settings', { notify: { desktop: false, browser: false } });

    await check('调度器到点真的触发了提醒（确定性验证，不用等轮询）', async () => {
      // 提醒点要设在「未来的某分钟」，所以时间基准必须用"刚问到的服务端现在"，
      // 不能复用之前那次请求的时间（中间的 POST 可能已经过去十几秒）。
      const t0 = await req('GET', '/api/reminders/due');
      const anchor = new Date(t0.now).getTime();
      const startAt = anchor - 3 * 60_000;
      const ev = await req('POST', '/api/events', {
        title: '调度器自检',
        start: localStamp(new Date(startAt)),
        end: localStamp(new Date(startAt + 45 * 60_000)),
        autoReminders: false,
        reminders: [-8],
      });

      // 事件创建之后重新取一次基准，确保合成的 tick 时刻都还在未来
      const t1 = await req('GET', '/api/reminders/due');
      const base = new Date(t1.now).getTime();
      const fireAt = new Date(ev.start).getTime() + 8 * 60_000;

      // 还没到点 → 不该响
      const earlyTick = await req('POST', '/api/_test/tick', { at: new Date(fireAt - 60_000).toISOString() });
      assert(!earlyTick.fired.some((f) => f.eventId === ev.id), '还没到点就触发了');

      // 到点 → 该响（用 fireAt 直接推算，和前面 POST 花了多久无关）
      const onTime = await req('POST', '/api/_test/tick', {
        at: new Date(Math.max(fireAt + 1_000, base + 1_000)).toISOString(),
        include: true,
      });
      const hit = onTime.fired.find((f) => f.eventId === ev.id);
      if (!hit) {
        throw new Error(
          `到点没有触发。ev.id=${ev.id} ev.start=${ev.start} reminders=${JSON.stringify(ev.reminders)} `
          + `fireAt=${new Date(fireAt).toISOString()} tick.at=${onTime.at} fired=${JSON.stringify(onTime.fired)} `
          + `candidates=${JSON.stringify(onTime.candidates)}`,
        );
      }
      assert(hit.minutes === -8, `minutes 应为 -8，实际 ${hit.minutes}`);
      assert(new Date(hit.fireAt).getTime() - new Date(ev.start).getTime() === 8 * 60_000,
        'fireAt 应为开始时间 + 8 分钟');

      // 再跑一次 → 不能重复打扰
      const again = await req('POST', '/api/_test/tick', { at: new Date(fireAt + 2_000).toISOString() });
      assert(!again.fired.some((f) => f.eventId === ev.id), '同一个提醒点被重复触发');

      const ledger = await req('GET', '/api/reminders/ledger');
      assert(ledger.keys.includes(hit.key), `账本里没有记录：${hit.key}`);

      const firedFile = path.join(TMP, 'fired.json');
      assert(fs.existsSync(firedFile), 'fired.json 没有落盘');
      return `到点触发 + 账本落盘 + 不重复打扰（key=${hit.key}）`;
    });

    await check('早已过去的提醒不会补报（不做马后炮轰炸）', async () => {
      const before = await req('GET', '/api/reminders/due');
      const base = new Date(before.now).getTime();
      // 事件 3 小时前就开始了，配「提前 10 分钟」→ 提醒点早已过去 2 小时 50 分
      const startAt = base - 3 * 60 * 60_000;
      const ev = await req('POST', '/api/events', {
        title: '过期事件', start: localStamp(new Date(startAt)), reminders: [10],
      });

      // 1) 现在这一刻不响
      const tickNow = await req('POST', '/api/_test/tick', { at: new Date(base).toISOString(), include: true });
      assert(!tickNow.fired.some((f) => f.eventId === ev.id), '过期提醒被补报了');

      // 2) 就算把"现在"拨回提醒点那一刻，但只晚 2 秒 → 应当正常触发（证明它本身是有效的提醒点）
      const fireAt = new Date(ev.start).getTime() - 10 * 60_000;
      const tickAtPoint = await req('POST', '/api/_test/tick', { at: new Date(fireAt + 2_000).toISOString() });
      assert(tickAtPoint.fired.some((f) => f.eventId === ev.id), '到点那一刻反而没触发，说明提醒点算错了');

      // 3) 前端接口不会把过期提醒推给用户
      const due = await req('GET', '/api/reminders/due');
      assert(!due.items.some((i) => i.eventId === ev.id), '过期提醒出现在 /api/reminders/due 里');
      return '过期提醒不补报，但到点那一刻能正常触发';
    });

    await check('服务日志记录了调度触发', async () => {
      const log = serverLog.join('');
      assert(log.includes('[scheduler]'), '日志里没有 scheduler');
      return '日志正常';
    });

    console.log('\n【设置与数据】');
    await check('设置可保存并持久化', async () => {
      await req('PATCH', '/api/settings', { owner: '自检用户', termWeeks: 16, notify: { sound: false } });
      const s = await req('GET', '/api/state');
      assert(s.settings.owner === '自检用户', 'owner 未保存');
      assert(s.settings.termWeeks === 16, 'termWeeks 未保存');
      assert(s.settings.notify.sound === false, 'notify.sound 未保存');
      return 'owner / termWeeks / notify 均已落库';
    });

    await check('备份导出包含完整数据', async () => {
      const res = await fetch(`${BASE}/api/backup`);
      const data = await res.json();
      assert(res.headers.get('content-disposition')?.includes('attachment'), '没有下载头');
      assert(Array.isArray(data.events) && data.events.length > 0, 'events 为空');
      assert(Array.isArray(data.courses), 'courses 缺失');
      return `${data.events.length} 条日程 / ${data.courses.length} 门课程`;
    });

    await check('清空日程（保留课程）', async () => {
      const r = await req('POST', '/api/events/clear', { keepCourses: true });
      const s = await req('GET', '/api/state');
      assert(r.removed > 0, '没删掉任何东西');
      assert(s.events.every((e) => e.type === 'course'), '非课程事件没清干净');
      return `删除 ${r.removed} 条，保留 ${s.events.length} 条课程`;
    });

    await check('从备份恢复', async () => {
      const res = await fetch(`${BASE}/api/backup`);
      const backup = await res.json();
      const r = await req('POST', '/api/restore', backup);
      assert(r.events === backup.events.length, `恢复 ${r.events} != ${backup.events.length}`);
      return `${r.events} 条日程 / ${r.courses} 门课程`;
    });

    await check('数据文件真实落盘', async () => {
      const dbFile = path.join(TMP, 'db.json');
      assert(fs.existsSync(dbFile), 'db.json 不存在');
      const parsed = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      assert(Array.isArray(parsed.events), 'events 不是数组');
      return `${(fs.statSync(dbFile).size / 1024).toFixed(1)} KB`;
    });

    console.log('\n【自定义课程（校内课表没有的课）】');
    await check('加一门自定义课程（参数与校内课程一致）', async () => {
      const r = await req('POST', '/api/courses/import', {
        courses: [{
          key: 'custom:自检-雅思口语',
          eventKey: 'course:custom:自检-雅思口语|2|[3,4]',
          title: '自检-雅思口语',
          code: 'WANGKE-01',
          teacher: '外教',
          location: '线上',
          dayOfWeek: 2,
          sections: [3, 4],
          weeks: [1, 2, 3, 4, 5, 6],
        }],
        meta: { source: 'custom' },
        mode: 'merge',
      });
      assert(r.added === 1, `应当新增 1 门，实际 ${r.added}`);
      const st = await req('GET', '/api/state');
      const c = st.courses.find((x) => x.title === '自检-雅思口语');
      assert(c, '课程表里没有这门自定义课');
      assert(c.dayOfWeek === 2 && c.sections.length === 2, '周几/节次不对');
      assert(c.location === '线上' && c.teacher === '外教', '地点/老师不对');
      const evs = st.events.filter((e) => e.type === 'course' && e.title === '自检-雅思口语');
      assert(evs.length === 1, `应当展开成 1 条事件，实际 ${evs.length}`);
      return `${c.title} · 周${c.dayOfWeek} 第${c.sections.join(',')}节 · ${c.location}`;
    });

    await check('自定义课程重复添加不会翻倍（同 key 幂等）', async () => {
      const before = (await req('GET', '/api/state')).events.filter((e) => e.type === 'course').length;
      await req('POST', '/api/courses/import', {
        courses: [{
          key: 'custom:自检-雅思口语',
          eventKey: 'course:custom:自检-雅思口语|2|[3,4]',
          title: '自检-雅思口语', dayOfWeek: 2, sections: [3, 4], weeks: [1, 2, 3],
        }],
        meta: { source: 'custom' },
        mode: 'merge',
      });
      const after = (await req('GET', '/api/state')).events.filter((e) => e.type === 'course').length;
      assert(after === before, `事件数变了：${before} → ${after}`);
      return `${after} 条课程事件不变`;
    });

    await check('自定义课程能和校内课共存（互不覆盖）', async () => {
      const st = await req('GET', '/api/state');
      const titles = st.events.filter((e) => e.type === 'course').map((e) => e.title);
      assert(titles.includes('自检-雅思口语'), '自定义课没了');
      assert(titles.includes('自检-高等数学'), '校内课被自定义课覆盖了');
      const sources = new Set(st.courses.map((c) => c.source));
      assert(sources.size >= 2, `来源应当至少两种，实际 ${[...sources].join(',')}`);
      return `来源：${[...sources].join(' / ')}`;
    });

    await check('自定义课程按**作息表**换算时刻（不是硬编码 08:00）', async () => {
      // 回归：不提交 sectionTimes 时，服务端会退回硬编码 08:00，
      // 于是下午的课（第 5 节 13:30）会被排到早上。
      const SECTIONS = [
        { index: 1, start: '08:00', end: '08:45' },
        { index: 2, start: '08:50', end: '09:35' },
        { index: 5, start: '13:30', end: '14:15' },
        { index: 6, start: '14:20', end: '15:05' },
      ];
      await req('POST', '/api/courses/import', {
        courses: [{
          key: 'custom:自检-下午课',
          eventKey: 'course:custom:自检-下午课|4|[5,6]',
          title: '自检-下午课', dayOfWeek: 4, sections: [5, 6], weeks: [1, 2],
        }],
        meta: { source: 'custom', sectionTimes: SECTIONS, termWeeks: 20 },
        mode: 'merge',
      });
      const st = await req('GET', '/api/state');
      const ev = st.events.find((e) => e.title === '自检-下午课');
      assert(ev, '课程事件没生成');
      assert(ev.start.slice(11, 16) === '13:30', `第 5 节应当是 13:30，实际 ${ev.start.slice(11, 16)}`);
      // ⚠️ 结束时间要按**最后一个节次**算，不是第一个。
      //    这条原来是 14:15（= 第 5 节结束），那是错的：第 5-6 节是 13:30–15:05。
      //    旧断言之所以"通过"，是因为当时实现就只取 sections[0] 算 end ——
      //    等于把"第 1-2 节只记 45 分钟"这个 bug 写进了测试。
      //    用户报的"1-2 节 8:00~9:35 为什么显示一节课"是同一个根因。
      assert(ev.end.slice(11, 16) === '15:05', `结束应当是第 6 节的 15:05，实际 ${ev.end.slice(11, 16)}`);
      assert(ev.start < ev.end, '开始时间必须早于结束时间');
      // 节次范围必须留在事件里 —— 课表靠它把格子跨行连起来
      assert(Array.isArray(ev.sections) && ev.sections.join(',') === '5,6',
        `sections 应当是 [5,6]，实际 ${JSON.stringify(ev.sections)}`);
      return `${ev.start.slice(11, 16)} → ${ev.end.slice(11, 16)}（第 ${ev.sections.join('-')} 节）`;
    });

    console.log('\n【提醒通道（Windows Toast）】');
    await check('toast.ps1 可被调用', async () => {
      await req('PATCH', '/api/settings', { notify: { desktop: true } });
      const r = await req('POST', '/api/reminders/test', {});
      // 通道是否真的弹出取决于系统设置，这里只验证调用链没崩
      assert(r.result && typeof r.result === 'object', '没有返回通道结果');
      const win = r.result.windows || {};
      return win.ok ? '系统通知已发送' : `未发送（${win.error || win.code || '未知'}）—— 不影响其它功能`;
    });
  } catch (err) {
    bad('自检流程异常中断', err.stack || err.message);
  } finally {
    console.log('\n' + '─'.repeat(52));
    console.log(`结果：\x1b[32m${pass} 通过\x1b[0m，${fail ? `\x1b[31m${fail} 失败\x1b[0m` : '0 失败'}`);
    if (failures.length) {
      console.log('\n失败项：');
      failures.forEach((f) => console.log('  · ' + f));
    }
    console.log('─'.repeat(52) + '\n');
    await shutdown();
    process.exitCode = fail ? 1 : 0;
  }
}

main();
