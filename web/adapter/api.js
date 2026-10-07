// 与本地服务通信。所有写操作都走服务端，服务端是唯一真相源。
//
// ⚠️ 本文件是**唯一**允许出现 API 路径的地方（守门测试 tools/api-boundary.test.mjs 盯着）。
//    视图层不许自己 fetch —— 否则换传输就得满仓库找。
import { localApi } from './api-local.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * 一次 JSON 请求。
 *
 * ⚠️ 有一层**必须**的防护：API 响应如果拿到的是 **HTML**，绝不能当数据用。
 *
 * 什么时候会拿到 HTML？典型是 Service Worker / 中间层把请求**回落到了
 * `index.html`**（离线兜底写错就会这样）。此时 `JSON.parse` 失败，
 * 而原来的 `catch { data = { raw: text } }` 会把它变成一个**看起来正常的对象** ——
 * 于是 `data.events` 是 undefined、界面显示"0 条日程"，
 * **用户以为数据丢了**（实际只是响应不对）。这种"静默降级"比报错危险得多。
 *
 * 所以：内容不像 JSON 时**直接抛错**，让上层按"服务不可用"处理
 * （离线横幅 + 本地缓存），而不是显示空数据。
 */
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? JSON_HEADERS : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();

  // HTML（或明显不是 JSON 的文本）→ 报错，不要静默当成数据
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) {
    const err = new Error('服务返回的不是数据（可能是缓存回落到了页面）');
    err.status = res.status;
    err.notJson = true;
    throw err;
  }

  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {
    // 不是 JSON、也不是 HTML —— 同样不该当成数据
    const err = new Error(`响应无法解析（${res.status}）`);
    err.status = res.status;
    err.notJson = true;
    throw err;
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 ${res.status}`);
    err.status = res.status;
    err.payload = data;
    // ⚠️ 把服务端的**业务错误码**带出来（服务端 main.js 会回 `{error, code}`）。
    //    靠中文匹配的话，改一个字文案就会静默退化成"未知错误"。
    if (data && data.code) err.code = String(data.code);
    throw err;
  }
  return data;
}

/** 远程实现（服务端）。**只**允许在这个文件里出现 API 路径字面量 */
const remoteApi = {
  health: () => request('GET', '/api/health'),
  state: () => request('GET', '/api/state'),
  saveEvent: (ev) => request('POST', '/api/events', ev),
  patchEvent: (id, patch) => request('PATCH', `/api/events/${encodeURIComponent(id)}`, patch),
  deleteEvent: (id) => request('DELETE', `/api/events/${encodeURIComponent(id)}`),
  // 戳破气泡（= 完成）：服务端负责把直接子级放出一级，孙子留在原位。
  // 传 `{occurrence, remainingMs}` 时是**按实例记账**（重复事件只结束这一颗）。
  popEvent: (id, body) => request('POST', `/api/events/${encodeURIComponent(id)}/pop`, body || {}),
  // 还原一颗被戳破的泡泡（回收气泡站）
  restorePopped: (id, body) => request('POST', `/api/events/${encodeURIComponent(id)}/restore`, body || {}),
  // 回收气泡站的数据（每个事件一条，合并）
  recycle: () => request('GET', '/api/recycle'),
  // ---- 闹钟（计时器 / 定时器）----
  //
  // ⚠️ 形状照抄 events 那一组（POST 建 / PATCH 改 / DELETE 删），因为
  //    iPad 本地模式（api-local.js）必须能用同样的形状实现一遍 ——
  //    "接口形状一致 ⇒ store.js 零改动"是 4b 的核心前提。
  //
  // ⚠️ 故意**没有** `alarms()` 这个读方法：读通道是 `state()`（见上面 api.state）。
  //    多一个读方法就多一个"它和 state 不一致"的地方，而那种不一致最难查。
  //
  // ⚠️ 开关单独一条路由（`/toggle`）而不是 PATCH 整条：开关是最高频操作，
  //    它不该把时刻/标签/铃声一起重发一遍（那等于用本地旧副本覆盖服务端）。
  saveAlarm: (alarm) => request('POST', '/api/alarms', alarm),
  patchAlarm: (id, patch) => request('PATCH', `/api/alarms/${encodeURIComponent(id)}`, patch),
  deleteAlarm: (id) => request('DELETE', `/api/alarms/${encodeURIComponent(id)}`),
  toggleAlarm: (id, enabled) => request('POST', `/api/alarms/${encodeURIComponent(id)}/toggle`, { enabled: enabled !== false }),
  settings: (patch) => request('PATCH', '/api/settings', patch),
  setAutoLaunch: (enable) => request('POST', '/api/system/autolaunch', { enable }),
  // 桌面气泡层（只有 Windows 的 PC 版有）：网页里的那个入口调它开/关那一层。
  // ⚠️ iPad / 安卓上这个接口不存在（404）—— 调用方要能咽下这个错，
  //    表现是"那一整块设置根本不显示"，而不是弹一个红错误。
  desktopLayer: () => request('GET', '/api/desktop-layer'),
  desktopLayerAct: (action, on) => request('POST', '/api/desktop-layer', { action, on }),
  dueReminders: () => request('GET', '/api/reminders/due'),
  testNotification: () => request('POST', '/api/reminders/test', {}),
  importCourses: (payload) => request('POST', '/api/courses/import', payload),
  courses: () => request('GET', '/api/courses'),
  /**
   * 删除一门课（**连同它的课程事件**）。
   *
   * ⚠️ `encodeURIComponent` 不能省：课程 key 是 `标题|星期|节次|老师|周次`，
   *    含 `|`、中文、逗号、甚至空段。裸拼的话 `|` 在某些中间层会被当分隔符处理，
   *    中文也可能被按 latin-1 编坏 —— 症状是服务端回「课程不存在」，
   *    而库里明明有这门课（key 已经变成 %E5… 了）。服务端那边对应地 decode 一次，
   *    见 server/api.js 里这条路由的注释。
   */
  deleteCourse: (key) => request('DELETE', `/api/courses/${encodeURIComponent(key)}`),
  clearEvents: (keepCourses = false) => request('POST', '/api/events/clear', { keepCourses }),
  restore: (payload) => request('POST', '/api/restore', payload),

  // ---- 接入信息（设置页的"手机/平板接入"卡片用）----
  //
  // ⚠️ 这两个原来写在 `views/settings.js` 里**直接 fetch('/api/net')**，
  //    绕过了本适配器。为什么必须收进来：
  //    所有视图只该通过这里碰网络 —— 否则将来换一套传输（比如 iOS 原生壳把
  //    API 桥成 WKScriptMessageHandler、或换成自定义 scheme）就得满仓库找 fetch。
  net: () => request('GET', '/api/net'),
  /** 二维码返回的是 **SVG 文本**（不是 JSON），所以单独一个函数 */
  qr: async (url) => {
    const res = await fetch(`/api/qr?url=${encodeURIComponent(url)}`);
    return res.text();
  },



  // ---- 原生直链（浏览器自己发起，不经过 fetch）----
  /** 数据备份下载地址（给 <a download> 用）*/
  backupUrl: () => '/api/backup',
  /**
   * 把全部数据导出成 JSON **文本**（不依赖 `<a download>`）。
   *
   * ⚠️ 为什么光有 `backupUrl` 不够：
   *   它是给浏览器 `<a download>` 用的，而**原生壳（WKWebView）里那个点不动**
   *   —— 壳没实现下载代理，`download` 属性不生效；本地模式下它更是空串。
   *   于是 iPad 上"下载全部数据备份"是个**死按钮**，而 iPad 恰恰是数据主场。
   *   有了文本，界面就能让用户**复制/保存**，两条路都不依赖平台。
   *
   * 路径写在这里而不是调用方，是本文件的老规矩（见上面那段注释）。
   */
  exportText: async () => {
    const res = await fetch('/api/backup', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('导出失败 HTTP ' + res.status);
    return res.text();
  },
  /** 服务健康/日志页（给 window.open 用）*/
  healthUrl: () => '/api/health',
};

// ---------------------------------------------------------------------------
// 同步通道（4c）
//
// ⚠️ 这两个**故意不挂在**上面那个会随模式切换的 `api` 对象上：
//    同步是"本机 ↔ 电脑"，它**永远指向电脑**。
//    挂到 `api` 上的话，切到 local 之后 `api.sync` 就变成"本机和自己同步"了 ——
//    语义不通，而且很容易写出死循环。所以它们是**独立的命名导出**。
//
// 为什么放在这个文件：架构约束是"网络访问只出现在 api.js"
// （守门测试 tools/api-boundary.test.mjs）。同步也是网络访问，所以归这里，
// 而不是新建一个 peer.js 去开第二个口子。
// ---------------------------------------------------------------------------

/** 取电脑那边的同步载荷 */
export const syncPull = (filter) => request('GET',
  `/api/sync${filter ? `?filter=${encodeURIComponent(JSON.stringify(filter))}` : ''}`);

/** 把本机载荷送给电脑合并，拿回合并结果 */
export const syncPush = (payload, filter) => request('POST', '/api/sync', { payload, filter });

/** 电脑在不在 —— 离线时给界面一个准确的说法，而不是笼统的"同步失败" */
export async function peerReachable() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * （精简版去掉了本文件原有的 AI 出口：本机服务里已经没有那几条路由了。）
 */

// ---------------------------------------------------------------------------
// 模式切换：remote（连着电脑）↔ local（iPad 自己存数据）
//
// 为什么这样切（4b 的关键设计）：
//   `store.js` / 各个视图只认 `api` 对象上的方法名与签名，**不关心数据从哪来**。
//   所以只要 `api-local.js` 形状一致（已由 api-local 的对照检查保证），
//   切换模式对上层**完全透明** —— 一行都不用改。
//
// ⚠️ 默认必须是 remote（保持现状）。切到 local 是用户在有本地库之后主动做的动作；
//    默认翻成 local 会让所有既有用户"数据凭空变空"。
// ---------------------------------------------------------------------------

let impl = remoteApi;

export function setApiMode(mode) {
  const next = mode === 'local' ? localApi : remoteApi;
  if (next === impl) return getApiMode();
  impl = next;
  return getApiMode();
}
export function getApiMode() { return impl === remoteApi ? 'remote' : 'local'; }

/**
 * 对外的 `api`：每个方法**转调给当前实现**。
 *
 * 不用 Proxy 是为了让 `Object.keys(api)` 仍然列出方法名 ——
 * 守门测试（tools/api-boundary.test.mjs）和预缓存依赖图都依赖这一点。
 */
export const api = {};
for (const [k, v] of Object.entries(remoteApi)) {
  if (typeof v === 'function') {
    api[k] = (...a) => impl[k](...a);
  } else {
    api[k] = v;
  }
}
