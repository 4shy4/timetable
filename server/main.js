// 入口：静态资源 + REST API + 提醒引擎 + HTTPS（手机接入）+ 单实例保护。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import {
  WEB_DIR, CORE_DIR, DATA_DIR, LOG_FILE, PID_FILE, PORT, HTTPS_PORT, HOST, BASE_URL, LAN,
  CERT_DIR, PFX_FILE, CRT_FILE, ensureDirs, httpsCertAvailable, certInfo, lanUrls,
} from './paths.js';
import { createRouter, json } from './api.js';
import { buildMobileconfig } from './profile.js';
import { buildCalendar } from '../core/ics.js';
import * as store from './store.js';
import * as scheduler from './scheduler.js';
import { readAutoLaunch, upgradeAutoLaunchLan } from './autolaunch.js';

ensureDirs();
const route = createRouter();

// ---- 日志同时写控制台与 data/server.log ----
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const rawLog = console.log.bind(console);
const rawErr = console.error.bind(console);
function stamp() { return new Date().toLocaleString('zh-CN', { hour12: false }); }console.log = (...a) => { rawLog(...a); logStream.write(`[${stamp()}] ${a.join(' ')}\n`); };
console.error = (...a) => { rawErr(...a); logStream.write(`[${stamp()}] ERROR ${a.join(' ')}\n`); };

/**
 * 把 JS 对象转成 Apple plist XML（给 .mobileconfig 用）。
 *
 * 实际实现已挪到 `server/profile.js` —— 那里是唯一真源，`/profile` 路由和
 * `tools/export-profile.mjs` 共用同一份，避免"网页能装、导出的文件装不上"。
 */

const MIME = {
  '.html': 'text/html; charset=utf-8',  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  // /join：手机扫码进来的落地页（教客户怎么"添加到主屏幕"）
  if (pathname === '/join' || pathname === '/join/') {
    const joinFile = path.join(WEB_DIR, 'join.html');
    if (fs.existsSync(joinFile)) {
      const body = fs.readFileSync(joinFile);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      return res.end(body);
    }
  }

  // 证书下载：`timetable-ca.crt`
  //
  // 为什么必须有这个路由：**iOS 装描述文件需要一个能下载到的文件**。
  // 只在页面上写"点高级 → 继续前往"是不够的 —— 不真正信任证书，
  // iOS 上 Service Worker 装不上，PWA 就等于一个空壳（没有离线、没有图标）。
  //
  // 两个路径都给：带扩展名的 (`/timetable-ca.crt`) 让 iOS 按证书处理，
  // 不带扩展名的 (`/cert`) 方便人手动输入。
  if (pathname === '/cert' || pathname === '/timetable-ca.crt' || pathname === '/cert.crt') {
    if (!fs.existsSync(CRT_FILE)) {
      res.writeHead(404, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ error: '证书还没导出（跑一次 tools/make-cert.ps1 再导出 .crt）' }));
    }
    const body = fs.readFileSync(CRT_FILE);
    res.writeHead(200, {
      // iOS 认这个类型；application/x-x509-ca-cert 也行，但 octet-stream 会让 Safari 只当"文件"
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Length': body.length,
      'Content-Disposition': 'attachment; filename="timetable-ca.crt"',
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }

  // `/profile` —— 把证书包成 Apple **配置描述文件**（.mobileconfig）。
  //
  // ⚠️ 为什么必须有这个（踩了很久）：
  //    iOS 的「设置 → 通用 → 关于本机 → 证书信任设置」**只列出通过配置描述文件
  //    安装的证书**。直接下载一个 `.crt` 时，Safari 有可能只把它存成"文件"
  //    （进"文件"App），那种证书进的是证书信任库、**永远不会出现在那个列表里**，
  //    于是你换了多少次证书内容都没用。
  //    `.mobileconfig` 是 iOS 唯一保证走"已下载描述文件 → 安装"流程的格式。
  //
  // 结构（参考 Apple 的 Configuration Profile 规范）：
  //   PayloadType = com.apple.security.root      ← 根证书载荷
  //   PayloadContent = base64(DER 证书)
  //   顶层还需要 PayloadType = Configuration
  if (pathname === '/profile' || pathname === '/timetable.mobileconfig') {
    if (!fs.existsSync(CRT_FILE)) {
      res.writeHead(404, { 'Content-Type': MIME['.json'] });
      return res.end(JSON.stringify({ error: '证书还没导出' }));
    }
    const der = fs.readFileSync(CRT_FILE).toString('base64');
    const xml = buildMobileconfig(der);
    const buf = Buffer.from(xml, 'utf8');
    res.writeHead(200, {
      // ⚠️ Content-Type **不能带参数**（不要 `; charset=utf-8`）。
      //    Apple 只在 MIME 精确等于 `application/x-apple-aspen-config` 时
      //    才把响应交给"配置描述文件"处理器；带 charset 时 iOS 会**毫无反应**
      //    （不弹提示、也不下载）—— 这正是实测到的现象。
      'Content-Type': 'application/x-apple-aspen-config',
      'Content-Length': buf.length,
      // 只给 filename，不加 `attachment`：Safari 对 `attachment` +
      // application/x-apple-aspen-config 的组合有时会当成普通文件下载。
      'Content-Disposition': 'filename="timetable.mobileconfig"',
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  // `/calendar.ics` —— 给 iOS / 系统日历订阅的 iCalendar 源。
  //
  // 为什么需要它（这是"iPad 关掉 App 也能响提醒"的唯一可靠落点）：
  //   网页端提醒是页面里的 setInterval 自查，**页面不开就不检查**；
  //   iOS 又装不了 APK、用不上安卓那套系统闹钟。
  //   于是让 iOS **自己的日历**去管：这里按一份 .ics，iPad 订阅一次，
  //   之后提醒由 iOS 原生发出，**电脑关着也照响**。
  //
  // 订阅地址必须能被 iPad 访问到 —— 用 /api/health 里带回来的局域网地址拼。
  // 三个路径都给：`.ics` 结尾是部分客户端挑食的地方（有的只认扩展名）。
  if (pathname === '/calendar.ics' || pathname === '/timetable.ics' || pathname === '/ics') {
    const st = store.getState();
    // rev 一变日历就变，正好当 ETag 用；客户端据此省掉一次全量传输
    const etag = `"ics-${st.rev}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    const body = Buffer.from(buildCalendar({
      events: st.events,
      settings: st.settings,
      calendarName: `日程表${st.settings && st.settings.owner ? `（${st.settings.owner}）` : ''}`,
      // 「周期」是否也收日历：日历展开 400 天，远超出周期的实例本来都会写进去，
      // 所以**这个开关在日历上是真的看得见效果的**（和提醒那条不同）。
      periodLimit: !!(st.settings && st.settings.periodAffectsCalendar),
    }), 'utf8');
    // `?download=1` → 让浏览器/Safari **下载成文件**而不是当订阅源。
    // 用途见 docs/IPAD-SETUP.md「一次性导入」：iOS 的"添加已订阅的日历"会因为
    // 证书不被信任而报「验证失败，请编辑URL」，但把一个 .ics 文件直接导进日历
    // **完全不碰证书和 URL 校验**，是最不可能失败的兜底路径。
    // ⚠️ `serveStatic` 收到的是 `pathname`，**没有 `url` 对象** ——
    //    那个对象在 `handler()` 里。这里要用 `req.url` 自己解析一次查询串，
    //    否则就是 `ReferenceError: url is not defined`（整条路由 500）。
    const download = new URL(req.url, BASE_URL).searchParams.get('download') === '1';
    res.writeHead(200, {
      // ⚠️ 这里和 .mobileconfig 不同：iCalendar **要** charset，
      //    RFC 5545 的 MIME 类型就是带参数的 `text/calendar; charset=utf-8`。
      //    （描述文件那个不带 charset 是 Apple 特有的挑食行为，别混淆。）
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Length': body.length,
      'Content-Disposition': download
        ? 'attachment; filename="timetable.ics"'
        : 'inline; filename="timetable.ics"',
      'ETag': etag,
      'Cache-Control': 'no-cache',
    });
    return res.end(body);
  }

  // /core/* 是"共用核心层"（仓库根目录的 core/），三端（网页/安卓/iOS）共用同一份源码。
  // 它不在 web/ 里面，所以这里单独映射一次；前端用相对路径 import 就能拿到。
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const baseDir = rel.startsWith('core/') ? CORE_DIR : WEB_DIR;
  const target = path.resolve(baseDir, rel.startsWith('core/') ? rel.slice('core/'.length) : rel);
  // 目录穿越保护
  if (!target.startsWith(baseDir)) return json(res, { error: 'forbidden' }, 403);

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    fs.createReadStream(target).pipe(res);
  });
}

function handler(req, res) {
  const url = new URL(req.url, BASE_URL);
  const started = Date.now();
  Promise.resolve()
    .then(() => (url.pathname.startsWith('/api/') ? route(req, res, url) : serveStatic(req, res, url.pathname)))
    .catch((err) => {
      const status = err.status || 500;
      if (status >= 500) console.error('请求处理失败', req.method, url.pathname, err);
      // ⚠️ 带上 `code`（如果业务错误给了）：网页的失败文案范式是
      //    以前这里只回 `{error}`，于是界面只能拿中文去匹配错误类型 ——
      //    改一个字文案就断。`code` 只增不改，老客户端忽略它即可。
      if (!res.headersSent) json(res, err.code ? { error: err.message, code: err.code } : { error: err.message }, status);
    })
    .finally(() => {
      const ms = Date.now() - started;
      const isCalendar = url.pathname === '/calendar.ics'
        || url.pathname === '/timetable.ics' || url.pathname === '/ics';
      if (ms > 50 || isCalendar || url.pathname.startsWith('/api/')) {
        // ⚠️ 一定要带**客户端 IP**。
        //    没有它的时候，日志里"有请求"根本分不清是平板还是我自己在本机试探 ——
        //    排查「iPad 订阅日历失败」时这一点是致命的：我们要回答的第一个问题是
        //    "iPad 的请求到底有没有到"。只加 /calendar.ics 的无条件日志还不够。
        const ip = (req.socket && req.socket.remoteAddress) || '?';
        // ⚠️ 记**服务端端口**（= 客户端连的是哪个口）。
        //    没有它的时候，"平板来过"这句话是残缺的：7080 是明文 http、7443 是 https，
        //    而本次故障的核心恰恰是「客户端连了 7443 却在讲明文」。
        //    只记 IP 的话，两种情况的日志长得一模一样，还是会误判。
        const lp = (req.socket && req.socket.localPort) || 0;
        const via = `via=${lp === HTTPS_PORT ? 'https' : 'http'}:${lp}`;
        // 日历请求额外记 User-Agent：iOS 的日历客户端是 `dataaccessd`，
        // 而 Safari 是 `Safari/...`。一眼就能看出是"日历在取"还是"人在看"。
        const ua = isCalendar ? ` ua="${String(req.headers['user-agent'] || '').slice(0, 60)}"` : '';
        logStream.write(`[${stamp()}] ${ip} ${req.method} ${url.pathname} -> ${res.statusCode} (${ms}ms) ${via}${ua}\n`);
      }
    });
}

const server = http.createServer(handler);

// ---- HTTPS：手机通过局域网访问时需要安全上下文 ----
let httpsServer = null;
if (httpsCertAvailable()) {
  try {
    const info = certInfo() || {};
    httpsServer = https.createServer({
      pfx: fs.readFileSync(PFX_FILE),
      passphrase: info.passphrase || 'timetable-local',
      minVersion: 'TLSv1.2',
    }, handler);
    httpsServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`HTTPS 端口 ${HTTPS_PORT} 已被占用，手机将无法用 https 访问`);
      } else {
        console.error('HTTPS 服务出错', err.message);
      }
      httpsServer = null;
    });
  } catch (err) {
    console.error('加载 HTTPS 证书失败，将只提供 HTTP：' + err.message);
    httpsServer = null;
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`端口 ${PORT} 已被占用 —— 说明服务可能已经在运行。`);
    console.log(`直接打开 ${BASE_URL} 即可；若要重启，先按 Ctrl+C 关掉。`);
    process.exit(0);
  }
  console.error('服务启动失败', err);
  process.exit(1);
});

function startHttps() {
  if (!httpsServer) return;
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    for (const url of lanUrls(HTTPS_PORT, 'https')) console.log(`  https    : ${url}`);
  });
}

server.listen(PORT, HOST, () => {
  store.ensureDbFile(); // 首次启动即建库，让 data/db.json 立刻可见
  const st = store.getState();
  scheduler.start();
  try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch { /* ignore */ }

  const httpLan = lanUrls(PORT, 'http');
  const httpsLan = httpsServer ? lanUrls(HTTPS_PORT, 'https') : [];

  console.log('─'.repeat(60));
  console.log('  日程表 Timetable 已启动');
  console.log(`  本机地址 : ${BASE_URL}`);
  if (LAN) {
    if (httpLan.length) console.log(`  局域网   : ${httpLan.join('  ')}`);
    if (httpsLan.length) {
      console.log(`  手机扫码 : ${BASE_URL}/join   （或直接输 ${httpsLan[0]}）`);
      console.log('             首次会提示"证书不安全"，点继续即可；安卓只有 https 才允许"添加到主屏幕"');
    } else {
      console.log('  提示     : 没有 HTTPS 证书，手机只能用 http（安卓不允许添加到主屏幕）');
      console.log('             跑 npm run cert 可以补上');
    }
  } else {
    console.log('  手机访问 : 未开启（用 npm run start:lan 启动，或加 --lan 参数）');
  }
  console.log(`  日程数量 : ${st.events.length} 条  课程 ${st.courses.length} 门`);

  // 开机自启：顺手把"老版本写进去的、缺 --lan 的命令"补好。
  // 不补的话重启后服务只听 127.0.0.1，手机/平板连不上，而本机一切正常 ——
  // 正是那种"看起来没坏其实坏了"的故障。见 server/autolaunch.js 文件头。
  const repaired = upgradeAutoLaunchLan();
  if (repaired.changed) {
    console.log(`  自启修正 : ${repaired.reason}`);
    console.log(`             旧: ${repaired.before}`);
    console.log(`             新: ${repaired.after}`);
  }
  const al = readAutoLaunch();
  // 三态显示：读不到就说读不到，不能把"读不到"说成"未开启"（会把人带沟里）
  const alText = !al.ok ? `读取失败（${al.error}）`
    : al.enabled ? `已开启` : '未开启';
  console.log(`  开机自启 : ${alText}`);
  if (al.ok && al.enabled && al.command) console.log(`             注册命令: ${al.command}`);
  console.log(`  数据文件 : ${path.join(DATA_DIR, 'db.json')}`);
  console.log('─'.repeat(60));

  startHttps();
});

// ---- 退出清理 ----
function shutdown(signal) {
  console.log(`收到 ${signal}，正在关闭…`);
  scheduler.stop();
  try { fs.rmSync(PID_FILE, { force: true }); } catch { /* ignore */ }
  let pending = httpsServer ? 2 : 1;
  const done = () => { pending -= 1; if (pending <= 0) { logStream.end(); process.exit(0); } };
  server.close(done);
  if (httpsServer) httpsServer.close(done);
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
