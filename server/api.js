// REST 路由层。前端只认这些接口，换前端框架不用改服务端。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import * as store from './store.js';
import * as scheduler from './scheduler.js';
import { dispatch } from './notify.js';
import {
  BASE_URL, PORT, HTTPS_PORT, LAN, DATA_DIR, DB_FILE,
  httpsCertAvailable, certInfo, lanUrls,
} from './paths.js';
import { qrToSvg } from '../core/qrcode.js';
// Windows 桌面泡泡要画什么（纯数据；原生窗口只画不做判断）
import { buildDesktopBubbles } from '../core/desktop-bubbles.js';
import { setAutoLaunch, getAutoLaunch } from './autolaunch.js';
// 桌面气泡层（Windows 那一层）的**进程开关** —— 网页界面里那个入口就是调它
import * as desktopLayer from './desktop-layer.js';

/**
 */

const STARTED_AT = new Date().toISOString();

/**
 * 版本号从 package.json 读，**不要在这里写死**：
 * 写死过一次，结果 package.json 升到 0.4.0 而 /api/health 还报 0.3.0。
 */
const APP_VERSION = (() => {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// ---------------------------------------------------------------------------
// 出口掩码：老库里可能还留着 `settings.ai.apiKey`，它绝不出现在**任何 HTTP 响应**里
//
// 背景（这是一条真实存在的泄漏，不是理论风险）：`GET /api/state` 原来把 `settings`
// 原样回给前台，而那个 key 在库里是**明文**。这个 App 支持 `--lan`（同一局域网里给
// 平板用），于是同网段任何一台设备只要请求一次 `/api/state` 就能把 key 读走 ——
// 浏览器缓存、页面源码、任何一次 `console.log(settings)`、任何一张 devtools 截图，
// 也都会把它带到别处。用户的硬底线是**凭证绝不外泄**。
//
// ⚠️ 库里存明文是这个应用的既定前提（纯本地、零依赖、用户手改 db.json 是常见操作）。
//    要改的是"它能从哪出去"，不是"它存在哪"。
// ---------------------------------------------------------------------------

/** 掩码前缀（尾 4 位前面那四个点）。生成与识别共用，但**识别放宽到 2 个点**，见下 */
const MASK_PREFIX = '••••';
/**
 * 识别"客户端把掩码回写回来了"用的前缀。
 * ⚠️ 特意比 MASK_PREFIX 宽松（2 个点）：不同前端/旧版本可能只画两个点，
 *    而**多认一种掩码形状的代价是 0，认不出来的代价是一个真 Key 被掩码字符串覆盖**
 *    （界面上"我明明配过，怎么又没配置了"，且再也查不出原因）。宁可错认成掩码。
 */
const MASK_LEAD = '••';

/**
 * 出口掩码：settings.ai 只以「尾 4 位」的形式出现在响应里。
 *
 * 返回形状（其余设置一个字都不动）：
 *   ai: { baseUrl, model, apiKey: '', apiKeyMasked: '••••1234', apiKeySet: true }
 * 没配时 `apiKeyMasked: ''`、`apiKeySet: false`。
 *
 * ⚠️ `apiKey` 字段**一律置空**（保留键、清掉值）：前端如果写的是
 *    `ai.apiKey`，拿到的是空串而不是 undefined —— 少一类"undefined 渲染成
 *    文字 'undefined'"的界面毛病；而 `apiKeySet` 才是"配没配"的判据。
 */
// ⚠️ `maskSecrets` / `maskState` **导出**是给测试用的（tools/ai-share.test.mjs
//    会直接打它们验"纯函数、不就地改入参"）。这条约束不能只靠 HTTP 层间接验：
//    就地改内存里那份活对象是个静默的坑（下一次 persist 就把掩码写进 db.json），
//    而 HTTP 测法看不见"入参被改了没有"。
export function maskSecrets(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  // ⚠️ 三种 key 写法都要抹：手写过 db.json 的用户很可能用的是 `api_key` / `key`，
  //    只抹 `apiKey` 等于那条路照样漏。
  const ai = (settings.ai && typeof settings.ai === 'object') ? settings.ai : {};
  const plain = [ai.apiKey, ai.api_key, ai.key]
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .find((v) => v) || '';
  const maskedAi = {
    ...ai,
    apiKey: '',
    // 尾 4 位不是凭证（不知道前 20 位毫无用处），但足够让用户确认"我配的那个还在"
    apiKeyMasked: plain ? `${MASK_PREFIX}${plain.slice(-4)}` : '',
    // 单独给一个布尔：界面不必去解析掩码字符串就知道配没配
    apiKeySet: !!plain,
  };
  for (const alias of ['api_key', 'key']) {
    // 只在**本来就有**这个键时清空 —— 不凭空往响应里加字段（别的设置的形状别乱动）
    if (alias in maskedAi) maskedAi[alias] = '';
  }
  return { ...settings, ai: maskedAi };
}

/**
 * 整个 state 里只有 `settings` 藏着凭证，其余字段原样带出去。
 *
 * ⚠️ 所有"会返回整份 state/settings"的路由都必须过这道（漏一个等于没做）：
 *    · `GET  /api/state`     → store.getState()
 *    · `GET  /api/backup`    → store.getState()
 *    · `PATCH /api/settings` → store.updateSettings() 回的就是整份 settings
 * ⚠️ 掩码必须是**纯函数**（返回新对象，绝不改入参）：`store.getState()` 返回的是内存里
 *    那一份活对象，就地删改会被下一次 persist 写进 db.json —— 真 Key 被永久冲掉。
 */
export function maskState(state) {
  if (!state || typeof state !== 'object') return state;
  return { ...state, settings: maskSecrets(state.settings) };
}

/**
 * 从备份恢复时，守住本机已有的真 Key。
 *
 * ⚠️ 为什么需要（和上面 ② 是同一类坑，只是入口换成了"恢复备份"）：
 *    `/api/backup` 现在导出的是**掩码后**的设置（`apiKey:''` + `apiKeyMasked`），
 *    而 `core/state-ops.js` 的 restoreBackup 是 `{...db.settings, ...payload.settings}`
 *    —— `settings.ai` 是**整份替换**。于是"导出备份 → 恢复一下"就会把本机真 Key
 *    冲成空串：界面上显示"还没配置 AI"，而用户只会觉得"恢复备份怎么会把 key 弄没"。
 *    所以：备份里带回来的 key 只要是空的或掩码，就当作"这次不动 Key"。
 *    ⚠️ 老版本导出的**真 key 备份**照旧能恢复（值看起来是真 key → 原样写进去），
 *       行为不变；掩码辅助字段则一律不写进 db。
 */
function sanitizeRestorePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const s = payload.settings;
  if (!s || typeof s !== 'object') return payload;
  const next = { ...s };
  if (next.ai && typeof next.ai === 'object') {
    const ai = { ...next.ai };
    delete ai.apiKeyMasked;  // 掩码辅助字段不是设置，绝不写进 db
    delete ai.apiKeySet;
    const incoming = typeof ai.apiKey === 'string' ? ai.apiKey.trim() : '';
    if (!incoming || incoming.startsWith(MASK_LEAD)) {
      // 本机现有的 key 也要按**三种写法**找（和 ai.js / maskSecrets 同一套理由：
      // 手写过 db.json 的用户可能用的是 api_key）。找不到就说明本来没配 → 不补字段。
      const cur = (store.getState().settings || {}).ai || {};
      const current = [cur.apiKey, cur.api_key, cur.key]
        .find((v) => typeof v === 'string' && v.trim()) || '';
      if (current) ai.apiKey = current;
      else delete ai.apiKey;
    } else {
      ai.apiKey = incoming;
    }
    next.ai = ai;
  }
  // ⚠️ 共享令牌和 apiKey 是**同一类坑**（入口换成了"恢复备份"）：
  //    `/api/backup` 导出的是**掩码后**的设置，而 restoreBackup 里
  //    平板那边从此全部 401，而用户只会觉得"恢复备份怎么会把平板弄断"。
  //    ⚠️ 掩码辅助字段（tokenMasked / tokenSet）一律不写进 db。
  return { ...payload, settings: next };
}

// ---------------------------------------------------------------------------
export function createRouter() {
  return async function route(req, res, url) {
    const { pathname } = url;
    const method = req.method.toUpperCase();


    if (pathname === '/api/health') {
      const nets = lanUrls(PORT, 'http');
      const httpsNets = httpsCertAvailable() ? lanUrls(HTTPS_PORT, 'https') : [];
      return json(res, {
        ok: true,
        name: 'timetable',
        version: APP_VERSION,
        port: PORT,
        httpsPort: HTTPS_PORT,
        lan: LAN,
        baseUrl: BASE_URL,
        lanUrls: nets,
        httpsUrls: httpsNets,
        hasCert: httpsCertAvailable(),
        cert: certInfo(),
        platform: `${os.platform()} ${os.release()}`,
        node: process.version,
        hostname: os.hostname(),
        dataDir: DATA_DIR,
        dbFile: DB_FILE,
        startedAt: STARTED_AT,
        rev: store.getState().rev,
        serverTime: new Date().toISOString(),
      });
    }

    // 手机接入信息：给界面显示二维码用
    if (pathname === '/api/net') {
      const preferHttps = httpsCertAvailable();
      const urls = preferHttps ? lanUrls(HTTPS_PORT, 'https') : lanUrls(PORT, 'http');
      return json(res, {
        lan: LAN,
        hasCert: preferHttps,
        httpsPort: HTTPS_PORT,
        httpPort: PORT,
        // 首选地址：二维码就用它
        primary: urls[0] || null,
        urls,
        httpUrls: lanUrls(PORT, 'http'),
        httpsUrls: preferHttps ? lanUrls(HTTPS_PORT, 'https') : [],
        joinUrl: `${BASE_URL}/join`,
      });
    }

    // 二维码（SVG）：手机上扫码即达，省得手输 IP
    if (pathname === '/api/qr') {
      const target = url.searchParams.get('url')
        || (httpsCertAvailable() ? lanUrls(HTTPS_PORT, 'https')[0] : lanUrls(PORT, 'http')[0])
        || BASE_URL;
      try {
        const svg = qrToSvg(target, { ecl: 'M' });
        res.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        return res.end(svg);
      } catch (err) {
        return json(res, { error: `二维码生成失败：${err.message}` }, 400);
      }
    }

    if (pathname === '/api/state' && method === 'GET') {
      // ⚠️ **必须**走 maskState：这里回的是整份 state（老库里可能还留着 `settings.ai.apiKey`）
      return json(res, maskState(store.getState()));
    }

    // ---- Windows 桌面泡泡要画什么 ----
    //
    // ⚠️ 这一条是给**原生窗口**用的（`tools/desktop-bubbles.mjs` 起的那只）。
    //    它只画不做判断：哪些泡泡、多大、什么颜色、文字写什么，全部由 core 算好
    //    （core/desktop-bubbles.js → core/bubble-select.js → core/urgency.js）。
    //    和 iOS 壳同一条线：**原生只翻译，业务在 core**。
    //
    // 参数：`?w=&h=` 桌面画布尺寸（决定半径上限，和网页同一套曲线）；
    //      可选 `?parentId=` 当前在第几层容器里（和网页气泡区的 currentParentId 同一个概念 ——
    //        "双击进去"在两端表现一致）；可选 `?max=` 覆盖"最多几颗"。
    if (pathname === '/api/desktop-bubbles' && method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams;
      const state = store.getState();
      const payload = buildDesktopBubbles(state.events, {
        settings: state.settings,
        width: Number(q.get('w')) || 1600,
        height: Number(q.get('h')) || 900,
        parentId: q.get('parentId') || null,
      });
      const maxOverride = Number(q.get('max'));
      if (Number.isFinite(maxOverride) && maxOverride > 0) {
        payload.bubbles = payload.bubbles.slice(0, Math.floor(maxOverride));
        payload.count = payload.bubbles.length;
      }
      return json(res, payload);
    }

    // ---- 日程 ----
    if (pathname === '/api/events' && method === 'POST') {
      const body = await readJson(req);
      return json(res, store.upsertEvent(body));
    }

    if (pathname === '/api/events/bulk' && method === 'POST') {
      const body = await readJson(req);
      const list = Array.isArray(body.events) ? body.events : [];
      return json(res, { events: list.map((e) => store.upsertEvent(e)) });
    }

    if (pathname === '/api/events/clear' && method === 'POST') {
      const body = await readJson(req);
      return json(res, store.clearEvents({ keepCourses: !!body.keepCourses }));
    }

    if (pathname.startsWith('/api/events/')) {
      const rest = decodeURIComponent(pathname.slice('/api/events/'.length));
      // 戳破气泡（= 完成）：只放出**直接子级**，孙子留在原位。
      // body 里带 `occurrence` + `remainingMs` 时是**按实例记账**（重复事件只结束这一颗）。
      if (rest.endsWith('/pop') && method === 'POST') {
        const eventId = rest.slice(0, -'/pop'.length);
        const body = await readJson(req).catch(() => ({}));
        return json(res, store.popEvent(eventId, body || {}));
      }
      // 还原一颗被戳破的泡泡（回收气泡站用）
      if (rest.endsWith('/restore') && method === 'POST') {
        const eventId = rest.slice(0, -'/restore'.length);
        const body = await readJson(req).catch(() => ({}));
        return json(res, store.restorePopped(eventId, body || {}));
      }
      const eventId = rest;
      if (method === 'PATCH') return json(res, store.patchEvent(eventId, await readJson(req)));
      if (method === 'DELETE') return json(res, store.deleteEvent(eventId));
    }

    // ---- 回收气泡站：每个事件一条（合并）----
    if (pathname === '/api/recycle' && method === 'GET') {
      return json(res, { items: store.poppedRecords() });
    }

    // ---- 闹钟（计时器 / 定时器）----
    //
    // ⚠️ 形状**照抄 /api/events 那一组**（POST 建、PATCH 改、DELETE 删）：
    //    适配器（web/adapter/api.js）和 iPad 本地模式（adapter/api-local.js）
    //    就是按这个形状写的。新造一套"闹钟专用"的路径风格，
    //    等于让两端各写一遍，迟早分叉 —— 而分叉的症状是"某个端上闹钟不见了"。
    //
    // ⚠️ 故意**没有** `GET /api/alarms`：读通道只有 /api/state 一条
    //    （见 store.getState 里那段注释）。少一条读路由就少一个
    //    "两处列表不一致"的机会。
    //
    // ⚠️ 业务判定一律在 core（store.saveAlarm 只是 load→调 core→persist）：
    //    校验、重复规则、归一化都不在这里复刻。
    if (pathname === '/api/alarms' && method === 'POST') {
      const body = await readJson(req);
      return json(res, store.saveAlarm(body));
    }

    if (pathname.startsWith('/api/alarms/')) {
      const rest = decodeURIComponent(pathname.slice('/api/alarms/'.length));
      // 开关：`POST /api/alarms/:id/toggle {enabled:boolean}`
      // ⚠️ 单独一条（而不是让网页 PATCH 整条）的理由见 core/state-ops.toggleAlarm：
      //    开关是最高频的操作，它不该把时刻/标签/铃声一起"重发一遍" ——
      //    那样一次开关就等于把网页手上的旧副本覆盖到服务端。
      if (rest.endsWith('/toggle') && method === 'POST') {
        const alarmId = rest.slice(0, -'/toggle'.length);
        const body = await readJson(req).catch(() => ({}));
        return json(res, store.toggleAlarm(alarmId, body && body.enabled !== false));
      }
      const alarmId = rest;
      // PATCH 时把路径上的 id 钉进 body：URL 是权威（body 里带别人的 id 不算数）
      if (method === 'PATCH') return json(res, store.saveAlarm({ ...(await readJson(req)), id: alarmId }));
      if (method === 'DELETE') return json(res, store.deleteAlarm(alarmId));
    }

    // ---- 设置 ----
    if (pathname === '/api/settings' && method === 'PATCH') {
      const patch = await readJson(req);
      if (typeof patch.autoLaunch === 'boolean') {
        setAutoLaunch(patch.autoLaunch);
        patch.autoLaunch = getAutoLaunch();
      }
      // ⚠️ `updateSettings` 回的是**整份 settings**，所以出口一样要过掩码 ——
      //    不然修好了 /api/state，却从这条路上漏出去。
      return json(res, maskSecrets(store.updateSettings(patch)));
    }

    if (pathname === '/api/system/autolaunch' && method === 'POST') {
      const body = await readJson(req);
      const enabled = setAutoLaunch(!!body.enable);
      store.updateSettings({ autoLaunch: enabled });
      return json(res, { autoLaunch: enabled });
    }


    // ---- 桌面气泡层（Windows）：网页里的那个入口 ----
    //
    // ⚠️ 为什么由服务端来开：浏览器没法启动本机程序，而服务端就跑在这台电脑上。
    // ⚠️ 其它端（iPad / 安卓）请求这个接口会 404 —— 界面那边据此**整块不显示**，
    //    所以这里不需要"平台判断"的分支给它。
    if (pathname === '/api/desktop-layer' && method === 'GET') {
      return json(res, desktopLayer.status());
    }

    if (pathname === '/api/desktop-layer' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      const out = desktopLayer.act(body.action, body.on);
      const st = desktopLayer.status();
      return json(res, { ...out, status: st }, out.ok ? 200 : 400);
    }

    // ---- 同步（4c）----
    //
    // 同步由**客户端（平板）发起** —— 它够得着电脑，电脑够不着它。
    // 所以这里只有两个动作：给载荷、收载荷并合并。
    //
    // `filter` 由客户端给（"只同步课表"之类的选择），服务端**照做**：
    // 被排除的类别既不取也不写，两边的数据各管各的。
    if (pathname === '/api/sync' && method === 'GET') {
      const filterRaw = url.searchParams.get('filter');
      let filter = null;
      try { filter = filterRaw ? JSON.parse(filterRaw) : null; } catch { filter = null; }
      return json(res, store.syncPayload(filter));
    }

    if (pathname === '/api/sync' && method === 'POST') {
      const body = await readJson(req);
      const filter = body && body.filter;
      const payload = body && body.payload;
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.events)) {
        return json(res, { error: 'payload 不合法：缺少 events 数组' }, 400);
      }
      return json(res, store.syncMerge(payload, filter));
    }

    // ---- 提醒 ----
    if (pathname === '/api/reminders/due') {
      const now = new Date();
      const items = scheduler.dueReminders(now).map((i) => ({
        key: i.key,
        eventId: i.event.id,
        title: i.event.title,
        location: i.event.location,
        minutes: i.minutes,
        fireAt: i.fireAt.toISOString(),
        occurrence: i.occurrence,
        fired: scheduler.firedKeys().includes(i.key),
      })).filter((i) => new Date(i.fireAt) >= new Date(now.getTime() - 60_000));
      // 课程摘要（"前一天晚上提醒明天 / 早上提醒上午…"）单独一段。
      // 它的标题/正文是自己算好的整段汇总，不是某个 event 的提醒，
      // 所以不硬塞进 items 的形状里 —— 前端按 digests 单独展示。
      const digests = scheduler.dueDigestItems(now).map((d) => ({
        key: d.key,
        slot: d.slot,
        title: d.title,
        body: d.body,
        count: d.count,
      }));
      return json(res, {
        now: now.toISOString(),
        tickMs: scheduler.TICK_MS,
        toleranceMs: scheduler.TICK_MS * 2.5,
        ledgerSize: scheduler.firedKeys().length,
        items,
        digests,
      });
    }

    if (pathname === '/api/reminders/ledger') {
      return json(res, { day: new Date().toISOString().slice(0, 10), keys: scheduler.firedKeys() });
    }

    // 测试钩子：用给定的"当前时间"跑一次调度判定，用来确定性地验证提醒链路，
    // 不必等真实的 20 秒轮询（自检与排错都靠它）。
    if (pathname === '/api/_test/tick' && method === 'POST') {
      const body = await readJson(req);
      const at = body.at ? new Date(body.at) : new Date();
      if (Number.isNaN(at.getTime())) throw Object.assign(new Error('at 不是合法时间'), { status: 400 });
      const toleranceMs = scheduler.TICK_MS * 2.5;
      // 用自定义的 at 作为"现在"时，回看窗口必须以 at 为基准：
      // 事件可能在 at 之前就开始了，但提醒点在 at 之后（延后提醒）。
      const lookbackMinutes = Math.max(scheduler.defaultLookbackMinutes(), 48 * 60);
      const candidates = scheduler.dueReminders(at, undefined, lookbackMinutes).map((i) => ({
        eventId: i.event.id,
        title: i.event.title,
        minutes: i.minutes,
        occurrence: i.occurrence,
        fireAt: i.fireAt.toISOString(),
        latenessMs: at.getTime() - i.fireAt.getTime(),
        alreadyFired: scheduler.firedKeys().includes(i.key),
      }));
      const fired = scheduler.tick(at, lookbackMinutes).map((i) => ({
        key: i.key, eventId: i.event.id, title: i.event.title,
        minutes: i.minutes, fireAt: i.fireAt.toISOString(), occurrence: i.occurrence,
      }));
      return json(res, {
        at: at.toISOString(),
        toleranceMs,
        fired,
        ledgerSize: scheduler.firedKeys().length,
        // include=1 时返回候选与「为什么没响」，排错用
        candidates: body.include ? candidates : undefined,
        events: body.include ? store.getState().events.map((e) => ({
          id: e.id,
          title: e.title,
          start: e.start,
          startIso: new Date(e.start).toISOString(),
          type: e.type,
          weeks: (e.weeks || []).length,
          reminders: e.reminders,
        })) : undefined,
      });
    }

    if (pathname === '/api/reminders/test' && method === 'POST') {
      const result = await dispatch({
        title: '⏰ 提醒通道测试',
        body: '如果你看到这条通知，说明系统通知可用。',
        eventId: 'test',
        minutes: 0,
      }, ['console', 'windows']);
      return json(res, { ok: !!(result.windows && result.windows.ok), result });
    }

    // ---- 课表导入 ----
    if (pathname === '/api/courses/import' && method === 'POST') {
      const body = await readJson(req);
      return json(res, store.importCourses(body));
    }

    if (pathname === '/api/courses' && method === 'GET') {
      return json(res, { courses: store.getState().courses });
    }

    /**
     * 删除一门课：`DELETE /api/courses/:key`
     *
     * 形状与已有的事件删除（`DELETE /api/events/:id`）保持一致：
     * 路径参数就是主键、方法就是 DELETE、业务错误由 core 抛 `{status}` 交给 main.js 翻。
     *
     * ⚠️ **URL 编码**是这条路由最容易写错的地方，所以按顺序说清三件事：
     *   ① 课程 key 长这样：`大学物理|3|1,2||1,2` —— 含中文、`|`、逗号、空段，
     *      客户端只能 `encodeURIComponent(key)` 之后拼进路径（见 web/adapter/api.js）。
     *   ② `new URL(req.url).pathname` **不会**帮你解码（它是编码状态的原样字符串），
     *      所以服务端必须 `decodeURIComponent` —— 上面 `/api/events/` 那条也是这么做的。
     *      漏了这一步的症状是"课程不存在"，而库里明明有这门课（key 变成了 %E5…）。
     *   ③ 反过来，路径里若有**非法的百分号序列**（`%zz`、被截断的多字节 `%E4%B8`），
     *      `decodeURIComponent` 会抛 `URIError`。不接住它就是一个 500（"请求处理失败"），
     *      而真正的原因是"这个 key 编得不对"—— 所以这里接住并回 400 说清。
     *      注意 `%` 本身在合法编码里是 `%25`，所以这条判断不会误伤真 key。
     *
     * 错误码：
     *   400 `{error}` —— key 缺失/空（`DELETE /api/courses/`）或编码非法
     *   404 `{error:'课程不存在'}` —— key 没对上任何一门课（由 core 抛，**不改任何数据**，
     *        连 rev 都不动：`store.deleteCourse` 在 core 抛错时根本走不到 `persist()`）
     */
    if (pathname.startsWith('/api/courses/') && method === 'DELETE') {
      const raw = pathname.slice('/api/courses/'.length);
      let courseKey = '';
      try {
        courseKey = decodeURIComponent(raw);
      } catch {
        return json(res, { error: `课程 key 的 URL 编码不对（${raw}）—— 请用 encodeURIComponent 编一遍` }, 400);
      }
      if (!courseKey) return json(res, { error: '缺少课程 key' }, 400);
      return json(res, store.deleteCourse(courseKey));
    }

    // ---- 数据备份 / 恢复 ----
    //
    // ⚠️ 备份这条路**也必须**过掩码：它和 /api/state 一样挂在局域网上、一样没有鉴权，
    //    所以"忘了它"等于整个修复白做（换一个路径名照样能把 key 读走）。
    //    代价是备份文件里的 AI Key 变成掩码 —— 这是刻意的：凭证不该跟着一个
    //    能被任意下载的 JSON 走。恢复时本机原有的 Key 由 sanitizeRestorePayload 保住。
    if (pathname === '/api/backup' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="timetable-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      });
      return res.end(JSON.stringify(maskState(store.getState()), null, 2));
    }

    if (pathname === '/api/restore' && method === 'POST') {
      // ⚠️ 掩码后的备份整份喂回来时，别把本机真 Key 冲成空串（详见 sanitizeRestorePayload）
      return json(res, store.restoreBackup(sanitizeRestorePayload(await readJson(req))));
    }

    return json(res, { error: 'not found', pathname }, 404);
  };
}

export function json(res, data, status = 200) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(Object.assign(e, { status: 400 })); }
    });
    req.on('error', reject);
  });
}
