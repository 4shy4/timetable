// 开机自启：在 HKCU 的 Run 键写/删一项。不需要管理员权限。
//
// ⚠️ 这里有一个**曾经真实存在、而且很难发现**的 bug，务必保留背景：
//
//   自启命令原来是 `Timetable.exe --autostart` —— **没有 `--lan`**。
//   而 `server/paths.js` 里 `HOST = LAN ? '0.0.0.0' : '127.0.0.1'`。
//   于是开机自启拉起的是一个**只听回环**的服务：本机浏览器一切正常，
//   手机/平板却连不上（表现为 Safari「无法连接服务器」）。
//   用户每次手动 npm run start:lan 时都是好的，一重启就坏 ——
//   因为手动的那个 bat 带了 `--lan`，自启的那条没带。
//
//   修法：自启命令**跟随当前进程的运行模式**（本进程带了 --lan 就写 --lan）。
//   这样"我怎么在跑"和"开机后怎么起"永远一致，不会各说各话。
//
//   顺带：`getAutoLaunch()` 以前在 `spawnSync` 失败（沙箱/权限）时**静默返回 false**，
//   把"读不到"说成"没开" —— 这种"自信地给错答案"最难查。现在用
//   `readAutoLaunch()` 把三种状态分开：能读且开着 / 能读且没开 / 读不到。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, LAN } from './paths.js';

export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const VALUE_NAME = 'TimetableScheduler';

const LAUNCHER_EXE = path.join(ROOT, 'Timetable.exe');
const LAUNCHER_VBS = path.join(ROOT, '启动日程表.vbs');
const LAUNCHER_HIDDEN = path.join(ROOT, 'start-hidden.vbs');

/**
 * 选一个"登录后静默把服务拉起来"的命令。
 * 优先用便携包里的 Timetable.exe --autostart（客户机器上不需要装 Node.js），
 * 开发形态下退回 .vbs 启动器。
 *
 * @param {boolean} lan 是否让服务监听局域网（手机/平板要连就必须开）
 */
export function launcherCommand(lan = LAN) {
  // `--lan` 要放在两个启动器都认的位置：Launcher.cs 用 HasFlag 扫全部参数，
  // .vbs 也是按顺序扫，所以位置不敏感。
  const lanArg = lan ? ' --lan' : '';
  if (process.platform === 'win32' && fs.existsSync(LAUNCHER_EXE)) {
    // --autostart：只起后台服务，不弹应用窗口
    return { cmd: `"${LAUNCHER_EXE}" --autostart${lanArg}`, exists: true, kind: 'exe' };
  }
  const vbs = fs.existsSync(LAUNCHER_VBS) ? LAUNCHER_VBS : LAUNCHER_HIDDEN;
  if (!fs.existsSync(vbs)) return { cmd: '', exists: false, kind: 'none' };
  return { cmd: `wscript.exe "${vbs}" autostart${lanArg}`, exists: true, kind: 'vbs' };
}

function run(args) {
  // spawnSync 走的是**管道**；在被限制的环境里会直接 EPERM（不是命令失败）。
  // 必须把 r.error 和"命令返回非零"区分开，否则会把"读不到"当成"没设置"。
  const r = spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8' });
  return {
    code: r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
    error: r.error ? String(r.error.code || r.error.message) : null,
  };
}

/** 从 `reg query` 的输出里抠出 REG_SZ 的值（可能含空格和引号） */
function parseValue(out) {
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.match(/REG_SZ\s+(.*)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * 读自启状态。**三态**，不要退化成布尔：
 *   { ok:false, error }        —— 读不到（不是"没开"！）
 *   { ok:true, enabled:false } —— 确认没设置
 *   { ok:true, enabled:true, command } —— 已设置，附带注册表里的原命令
 */
export function readAutoLaunch() {
  if (process.platform !== 'win32') return { ok: true, enabled: false, command: null, error: null, supported: false };
  const r = run(['query', RUN_KEY, '/v', VALUE_NAME]);
  if (r.error) {
    return { ok: false, enabled: false, command: null, error: r.error, supported: true };
  }
  // 值不存在时 reg 返回 1 且 stderr 说"找不到指定的注册表项或值"
  if (r.code !== 0) return { ok: true, enabled: false, command: null, error: null, supported: true };
  const command = parseValue(r.out);
  return { ok: true, enabled: !!command, command, error: null, supported: true };
}

/**
 * 是否已设置开机自启。
 *
 * ⚠️ 读不到时返回 false（保持旧契约，`/api/settings` 依赖它）。
 *    需要区分"读不到"和"没开"的调用方请用 `readAutoLaunch()`。
 */
export function getAutoLaunch() {
  return readAutoLaunch().enabled;
}

/**
 * 写/删自启项。
 *
 * @param {boolean} enable
 * @param {{lan?: boolean}} [opts] lan 默认 **跟随当前进程模式**（见文件头注释）
 * @returns {boolean} 写完之后**重新读回来**的真实状态
 */
export function setAutoLaunch(enable, opts = {}) {
  if (process.platform !== 'win32') return false;
  const lan = opts.lan === undefined ? LAN : !!opts.lan;
  if (enable) {
    const l = launcherCommand(lan);
    if (!l.exists) {
      throw Object.assign(new Error('找不到启动器（Timetable.exe 或 .vbs 启动脚本），无法设置开机自启'), { status: 500 });
    }
    const r = run(['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', l.cmd, '/f']);
    if (r.code !== 0) throw Object.assign(new Error(`写入自启失败: ${r.err || r.out}`), { status: 500 });
    return getAutoLaunch();
  }
  run(['delete', RUN_KEY, '/v', VALUE_NAME, '/f']);
  return getAutoLaunch();
}

/**
 * 自启项缺 `--lan` 时补上它（**单向**：只加不减）。
 *
 * 为什么需要：老版本写进去的就是缺 `--lan` 的命令，而它只在用户手动拨动那个
 * 开关时才会被重写 —— 用户不动开关就永远带着这个 bug（本机就是这么中的招：
 * 桌面浏览器一切正常，平板连不上）。
 *
 * 为什么是单向的：反过来"当前进程没带 --lan 就把注册表里的 --lan 删掉"是**错的** ——
 * 用户可能只是这次临时以桌面模式跑一下，而自启项是给平板用的。
 * 降级会造成"平板莫名其妙连不上"，正是我们要消灭的那类故障。
 *
 * @returns {{changed:boolean, before:string|null, after:string|null, reason:string}}
 */
export function upgradeAutoLaunchLan() {
  const now = readAutoLaunch();
  if (!now.ok) return { changed: false, before: null, after: null, reason: `读不到自启项(${now.error})` };
  if (!now.enabled) return { changed: false, before: null, after: null, reason: '未开启自启，不用管' };
  if (/\s--lan\b/.test(now.command)) {
    return { changed: false, before: now.command, after: now.command, reason: '已经带 --lan' };
  }
  if (!LAN) {
    return { changed: false, before: now.command, after: now.command, reason: '本次没以 --lan 运行，不擅自改' };
  }
  // ⚠️ 这是**尽力而为**的修补，绝不能因为它失败就把服务带崩。
  //    写注册表可能因为权限/安全软件被拒（开发沙箱里就是 "Access is denied"），
  //    而这段代码跑在 server.listen 的回调里 —— 抛出去就是整个服务起不来，
  //    代价远大于"自启项没修好"。
  try {
    setAutoLaunch(true, { lan: true });
  } catch (err) {
    return { changed: false, before: now.command, after: now.command, reason: `修补失败(${err.message})` };
  }
  return { changed: true, before: now.command, after: readAutoLaunch().command, reason: '补上 --lan' };
}
