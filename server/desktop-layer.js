// 桌面气泡层（Windows）的**进程开关**：让网页界面里也能打开/关闭它。
//
// ⚠️ 为什么这段在 server/ 而不在 core/：
//   `core/` 必须保持平台无关（不碰 node: / 进程 / 文件系统，tools/core.test.mjs 守着）。
//   而"启动一个 exe、看看它有没有在跑"是**这台电脑**的事，天生属于服务端。
//
// ⚠️ 为什么不让浏览器自己去开：
//   浏览器不能启动本机程序（除非注册协议处理器）。所以是**服务端**去 spawn 它 ——
//   而服务端本来就跑在这台电脑上（PC 版就是本机服务），这件事只有它能做。
//
// 这一层的状态分两半：
//   · **进程**开没开 → 用进程名问（`tasklist`）
//   · **两个开关**（置顶 / 空白处也吃点击）→ 记在 `build/desktop-bubbles.json`
//     （那个 exe 自己也读写同一个文件，所以这里改了它下次启动就照新的来；
//       运行中改的话我们会**重启它**，免得出现"界面说勾上了、实际没生效"）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const EXE = path.join(ROOT, 'build', 'desktop-bubbles', 'DesktopBubbles.exe');
const CFG = path.join(ROOT, 'build', 'desktop-bubbles.json');
export const PROCESS_NAME = 'DesktopBubbles.exe';

/** 这一台机器上到底支不支持（只有 Windows 有） */
export function supported() {
  return process.platform === 'win32';
}

/**
 * ⚠️ 测试里**不许真的开窗口**：跑测试的机器就是用户那台，
 *    一 spawn 就会在他屏幕上冒出一个全屏层（而且很可能是"吃点击"的那种）。
 *    所以测试用 `TIMETABLE_NO_SPAWN=1` 起服务，这里只做校验、不真启。
 */
function spawnDisabled() {
  return process.env.TIMETABLE_NO_SPAWN === '1';
}

function readCfg() {
  try {
    const raw = fs.readFileSync(CFG, 'utf8');
    const j = JSON.parse(raw);
    return {
      topmost: j.topmost === true,
      captureBackground: j.captureBackground === true,
    };
  } catch {
    // 没有配置文件 = 还没启动过，用 exe 的默认值
    return { topmost: true, captureBackground: false };
  }
}

function writeCfg(patch) {
  const next = { ...readCfg(), ...patch };
  try {
    fs.mkdirSync(path.dirname(CFG), { recursive: true });
    fs.writeFileSync(CFG, JSON.stringify(next), 'utf8');
  } catch { /* 写不了不影响"开/关"本身 */ }
  return next;
}

/** 那个 exe 在不在（不在就说明还没编译过） */
export function built() {
  return fs.existsSync(EXE);
}

/** 现在有没有在跑。用 tasklist 问一下，别自己记状态（用户可能在托盘里退过） */
export function running() {
  if (!supported()) return false;
  const r = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${PROCESS_NAME}`, '/NH'], {
    encoding: 'utf8', windowsHide: true,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // 没有匹配时 tasklist 会说"没有运行的任务…"（中文/英文都要认）
  if (/没有运行|No tasks are running/i.test(out)) return false;
  return out.toLowerCase().includes(PROCESS_NAME.toLowerCase());
}

/** 开机自启的那个快捷方式在不在 */
function startupLink() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '日程表桌面泡泡.lnk');
}

export function autostartOn() {
  try { return fs.existsSync(startupLink()); } catch { return false; }
}

function setAutostart(on) {
  if (!supported()) return false;
  try {
    if (on) {
      const ps = [
        '$w = New-Object -ComObject WScript.Shell;',
        `$s = $w.CreateShortcut('${startupLink().replace(/'/g, "''")}');`,
        `$s.TargetPath = '${EXE.replace(/'/g, "''")}';`,
        '$s.Arguments = \'\';',
        `$s.WorkingDirectory = '${path.dirname(EXE).replace(/'/g, "''")}';`,
        "$s.Description = '日程表桌面气泡区';",
        '$s.Save();',
      ].join(' ');
      spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
    } else {
      fs.rmSync(startupLink(), { force: true });
    }
    return autostartOn();
  } catch {
    return autostartOn();
  }
}

/** 一次把状态说全（界面照这个画） */
export function status() {
  const cfg = readCfg();
  return {
    supported: supported(),
    built: built(),
    running: running(),
    topmost: cfg.topmost,
    captureBackground: cfg.captureBackground,
    autostart: autostartOn(),
    processName: PROCESS_NAME,
  };
}

/**
 * 编译一次（第一次用的时候还没有 exe）。
 * ⚠️ 同步跑、给 90 秒：csc 编这个大概 2 秒，但机器忙的时候会慢。
 */
function buildOnce() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'desktop-bubbles.mjs'), '--build'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 90_000,
  });
  return built() && r.status === 0;
}

function kill() {
  // ⚠️ taskkill 对"被 shell 脱离出去的"进程可能报 Access denied（我在沙箱里踩过），
  //    所以失败就换 PowerShell 的 Stop-Process 再来一次。
  const r = spawnSync('taskkill', ['/IM', PROCESS_NAME, '/F'], { encoding: 'utf8', windowsHide: true });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (/成功|SUCCESS/i.test(out)) return true;
  spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-Process ${PROCESS_NAME.replace('.exe', '')} -ErrorAction SilentlyContinue | Stop-Process -Force`],
  { windowsHide: true });
  return true;
}

function start() {
  if (!built() && !buildOnce()) {
    return { ok: false, error: '还没编译过，而且这次自动编译也没成功（先跑一次 npm run desktop 看看报什么错）' };
  }
  spawn(EXE, [], { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), windowsHide: true }).unref();
  return { ok: true };
}

/**
 * 界面上的动作。
 * @param {string} action start / stop / topmost / capture / autostart
 * @param {boolean} [on] 开关类动作的目标状态
 */
export function act(action, on) {
  if (!supported()) return { ok: false, error: '桌面气泡层只有 Windows 版有' };
  const a = String(action || '');

  if (a === 'start') {
    if (spawnDisabled()) return { ok: true, skipped: '测试模式：不真的启动' };
    if (running()) return { ok: true, already: true };
    return start();
  }

  if (a === 'stop') {
    if (spawnDisabled()) return { ok: true, skipped: '测试模式：不真的结束' };
    kill();
    return { ok: true };
  }

  if (a === 'topmost' || a === 'capture') {
    const patch = a === 'topmost' ? { topmost: !!on } : { captureBackground: !!on };
    const next = writeCfg(patch);
    // ⚠️ 跑着的时候改了开关要**重启**才生效：那层只在启动时读一次配置。
    //    不重启的话界面会显示"已经改了"而实际没变 —— 那种"设了没反应"最难查。
    if (running() && !spawnDisabled()) {
      kill();
      start();
    }
    return { ok: true, cfg: next, restarted: running() || !spawnDisabled() };
  }

  if (a === 'autostart') {
    if (spawnDisabled()) return { ok: true, skipped: '测试模式：不真的改开机自启' };
    return { ok: true, autostart: setAutostart(!!on) };
  }

  return { ok: false, error: '不知道这个动作：' + a };
}
