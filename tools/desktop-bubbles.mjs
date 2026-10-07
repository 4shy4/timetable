// Windows 桌面泡泡：编译 + 启动（+ 开机自启开关）。
//
// ⚠️ 为什么用系统自带的 csc 而不是"装个 .NET SDK / 用 Electron"：
//   这个项目的原则是**零依赖**（package.json 里 dependencies 是空的），
//   而这台机器上已经有 .NET Framework 4.8 + csc.exe，足够编一个透明置顶的 WPF 窗口。
//   装 Electron 要多 150 MB，只为画十个圆 —— 不值。
//
// ⚠️ 编译时踩到并记下来的两个坑（都在这台机器上实测过）：
//   1. `PresentationCore` 只在 **GAC_32**（也有 `…\Framework64\v4.0.30319\WPF\` 一份）。
//      按裸名字 `-r:PresentationCore.dll` 会 `error CS0006: 未找到元数据文件`。
//   2. **`System.Xaml` 必须显式引用**，否则
//      `error CS0012: 类型 System.Windows.Markup.IQueryAmbient 在未被引用的程序集中定义`。
//   3. `JavaScriptSerializer` 在 `System.Web.Extensions.dll` 里（.NET Framework 自带）。
//
// 用法：
//   node tools/desktop-bubbles.mjs --build      # 只编译
//   node tools/desktop-bubbles.mjs --selftest   # 编译 + 渲染一张图（不开窗口，不抓屏）
//   node tools/desktop-bubbles.mjs              # 编译 + 启动（**默认：铺满全屏的透明气泡层，置顶**）
//   node tools/desktop-bubbles.mjs --interval=30  # 拉数据的间隔秒数（默认 60）
//   node tools/desktop-bubbles.mjs --desktop-only # 不置顶：只在"看桌面"时看得见
//   node tools/desktop-bubbles.mjs --capture-background  # 空白处也吃点击（默认点透给桌面）
//   node tools/desktop-bubbles.mjs --autostart  # 开机自启（放进启动文件夹）/ --no-autostart
//   node tools/desktop-bubbles.mjs --probe      # 打印桌面的窗口结构（排查用，保留）
//
// ⚠️⚠️ 形态是用户第 41 轮亲口定的，别自己"改良"：
//   原话："我就是要铺满全屏的透明层，只不过我要气泡区的模式，有双击，有长按，有单击，
//          有母泡泡背景（这次就得像你之前那样搞一个圈圈，拿出去就拿到平级了），
//          只不过背景我要虚化而不挡住壁纸。桌面气泡的显示与软件气泡区设置保持一致"
//   · 全屏 + 透明 + **空白处点透**（桌面照常能用）
//   · 单击泡泡 = 编辑 / 双击 = 进去 / 长按 2.5 秒 = 戳破 / 拖到别人身上 = 放进去
//   · 进了容器就画**母泡泡那个圈**，圈里是**模糊过的壁纸**（壁纸还在、只是虚的）
//   · 拖到圈外松手 = 拉出来、和母泡泡平级
//   · 显示设置和软件气泡区**同一份**（settings.bubbleView，网页改这边跟着变）
//
// ⚠️ 我上一版做成了"一块 520×760 的磨砂面板"，被用户否掉了（那也不是他要的"面板"，是"整层"）。
//
// ⚠️ 为什么**不**做"贴桌面（图标之下）"那一层 —— 这台机器上实测过两次，结论是做不了：
//   1. 经典手法（给 Progman 发 0x052C 逼出 WorkerW，再 SetParent 上去）在 Win11 build 26200 上
//      失效：所有 WorkerW 的子窗口都是 0 个，图标是画在 Progman 里的。
//   2. 改用 SetParent(Progman) + SetWindowPos 插到 SHELLDLL_DefView 之后：API 全部返回成功，
//      但**还是看不见** —— 桌面图标列表本身是个铺满全屏的窗口，等于一幅画盖在你上面。
//   3. 就算看得见，那一层也**点不动**（图标层吃掉所有点击），"能用的气泡"这个前提就没了。
//   结论：Windows 桌面没有"壁纸之上、图标之下、还能点"的第三层。
//   → 现在这一层在**图标之上、应用窗口之下（关掉置顶时）或之上（默认置顶）**，
//     空白处点透，所以桌面照样能用。
//
// 托盘图标是兜底入口（右键 = 同一个菜单）：这一层是"点透"的，只有泡泡和母泡泡圈吃点击，
// 万一没找到泡泡在哪儿，托盘永远点得到。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(HERE, 'desktop-bubbles', 'DesktopBubbles.cs');
const OUT_DIR = path.join(ROOT, 'build', 'desktop-bubbles');
const EXE = path.join(OUT_DIR, 'DesktopBubbles.exe');
const PORT = 7080;
const BASE = `http://127.0.0.1:${PORT}`;
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

if (process.platform !== 'win32') {
  console.error('⛔ 桌面泡泡只有 Windows 有（iOS/安卓不允许第三方在别的 App 之上画东西）');
  process.exit(1);
}

const WIN = process.env.WINDIR || 'C:\\Windows';
const CANDIDATES = [
  path.join(WIN, 'Microsoft.NET', 'Framework64', 'v4.0.30319'),
  path.join(WIN, 'Microsoft.NET', 'Framework', 'v4.0.30319'),
];
const FX = CANDIDATES.find((d) => fs.existsSync(path.join(d, 'csc.exe')));
if (!FX) {
  console.error('⛔ 找不到系统自带的 csc.exe（.NET Framework 4.x）。正常 Windows 都有。');
  process.exit(1);
}
const CSC = path.join(FX, 'csc.exe');
const WPF = path.join(FX, 'WPF');
const GAC = path.join(WIN, 'Microsoft.NET', 'assembly', 'GAC_MSIL');
function gacPath(name, token) {
  const dir = path.join(GAC, name);
  if (!fs.existsSync(dir)) return null;
  const ver = fs.readdirSync(dir)[0];
  return ver ? path.join(dir, ver, `${name}.dll`) : null;
}

// ⚠️ **收子进程输出不能用管道**：这台机器上开了文件沙箱，
//    `spawnSync(x, args, { encoding: 'utf8' })`（也就是 stdio:'pipe'）会直接 EPERM ——
//    返回的 status 是 null、stdout 是 undefined，看起来像"编译器崩了"。
//    这里改成把 stdout/stderr 重定向到**普通文件**（不是命名管道），沙箱放行。
//    （踩过：`node tools/desktop-bubbles.test.mjs` 报 "编译失败（退出码 null）"。）
let captureSeq = 0;
function runCapture(cmd, args, opts) {
  const log = path.join(os.tmpdir(), `desktop-bubbles-capture-${process.pid}-${captureSeq++}.log`);
  const fd = fs.openSync(log, 'w');
  let r;
  try {
    r = spawnSync(cmd, args, Object.assign({}, opts, { stdio: ['ignore', fd, fd] }));
  } finally {
    fs.closeSync(fd);
  }
  let text = '';
  try { text = fs.readFileSync(log, 'utf8'); } catch { /* ignore */ }
  try { fs.rmSync(log, { force: true }); } catch { /* ignore */ }
  if (r.error) text += `\n（子进程起不来：${r.error.message}）`;
  return { status: r.status, text };
}

function build() {
  // ⚠️ 先把正在跑的旧实例关掉：Windows 会锁住正在执行的 exe，
  //    不然编译会报 `CS0016: 未能写入输出文件…另一个程序正在使用此文件`。
  //    （这个坑我自己踩了两次 —— 改了代码却编译不过，看起来像代码错了。）
  killRunning();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const refs = [
    path.join(WPF, 'PresentationFramework.dll'),
    path.join(WPF, 'PresentationCore.dll'),
    gacPath('WindowsBase', '31bf3856ad364e35'),
    gacPath('System.Xaml', 'b77a5c561934e089'),
    // 「只有桌面空白处可点」要读**桌面图标**的位置 —— 走 UI Automation（官方接口，
    // 不是往 explorer.exe 里写内存那种野路子）。这两个也在 GAC 里，系统自带。
    gacPath('UIAutomationClient', '31bf3856ad364e35'),
    gacPath('UIAutomationTypes', '31bf3856ad364e35'),
    // ⚠️ **不要**显式引用 System.Web.Extensions：csc 的默认响应文件（csc.rsp）里
    //    已经有一份了，再写一次会 `error CS1703: 已经导入了具有相同标识的程序集`
    //    （实测踩到）。JavaScriptSerializer 靠那一份就够。
  ].filter(Boolean);
  const missing = refs.filter((r) => !fs.existsSync(r));
  if (missing.length) {
    console.error('⛔ 缺这些程序集（这台机器上的 .NET Framework 不完整）：\n  ' + missing.join('\n  '));
    process.exit(1);
  }
  const cmd = [
    '/nologo', '/target:winexe', '/platform:anycpu', '/codepage:65001',
    `/out:${EXE}`, ...refs.map((r) => `/r:${r}`), SRC,
  ];
  const r = runCapture(CSC, cmd);
  const out = r.text.trim();
  if (out) console.log(out);
  if (r.status !== 0 || !fs.existsSync(EXE)) {
    console.error('⛔ 编译失败（退出码 ' + r.status + '）');
    process.exit(1);
  }
  const kb = (fs.statSync(EXE).size / 1024).toFixed(0);
  console.log(`✅ 编译好了：${path.relative(ROOT, EXE)}（${kb} KB，引用的是系统自带的 WPF）`);
  return EXE;
}

/** 同步睡一会儿（`Atomics.wait` 是标准库里唯一的同步 sleep） */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 关掉正在跑的旧实例（Windows 会锁住正在执行的 exe，不关就编译不过 → CS0016）。
 *
 * ⚠️ 这里的兜底是**实测逼出来的**：面板是从 `cmd /c start` 脱离出去的进程，
 *    这种进程 `taskkill /F` 会回一句 `ERROR: Access denied`（用户态看着莫名其妙），
 *    而 PowerShell 的 `Stop-Process -Force` 能杀掉。所以两条路都走一遍。
 */
function killRunning() {
  const r = runCapture('taskkill', ['/IM', 'DesktopBubbles.exe', '/F']);
  let killed = /成功|SUCCESS/i.test(r.text);
  if (!killed && /Access is denied|拒绝访问|Access denied/i.test(r.text)) {
    runCapture('powershell.exe', ['-NoProfile', '-Command',
      'Get-Process DesktopBubbles -ErrorAction SilentlyContinue | Stop-Process -Force']);
    killed = true;
  }
  if (killed) {
    console.log('（先关掉了正在跑的旧实例）');
    // ⚠️ 文件句柄不是瞬间松开的：不停一下还是会 CS0016（踩过一次）
    sleepSync(500);
  }
  return killed;
}

async function reachable() {
  try {
    const r = await fetch(`${BASE}/api/health`);
    return r.ok;
  } catch { return false; }
}

async function selftest() {
  const png = path.join(ROOT, 'build', 'shots', 'desktop-bubbles-selftest.png');
  const r = runCapture(EXE, [`--selftest=${png}`]);
  const out = r.text.trim();
  if (out) console.log(out);
  if (!fs.existsSync(png)) {
    console.error('⛔ selftest 没产出图片（退出码 ' + r.status + '）');
    process.exit(1);
  }
  console.log(`✅ 渲染自检：${path.relative(ROOT, png)}（${(fs.statSync(png).size / 1024).toFixed(0)} KB）`);
  console.log('   这是程序自己画出来的（**没有抓你的屏幕**），可以直接打开看泡泡长什么样。');
}

function shortcutPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '日程表桌面泡泡.lnk');
}

function autostart(on) {
  const lnk = shortcutPath();
  if (on) {
    // 用 WScript.Shell 建快捷方式（PowerShell 里 COM 是现成的，不用装东西）
    const ps = [
      '$w = New-Object -ComObject WScript.Shell;',
      `$s = $w.CreateShortcut('${lnk.replace(/'/g, "''")}');`,
      `$s.TargetPath = '${EXE.replace(/'/g, "''")}';`,
      `$s.Arguments = '--url=${BASE}';`,
      `$s.WorkingDirectory = '${OUT_DIR.replace(/'/g, "''")}';`,
      "$s.Description = '日程表桌面泡泡';",
      '$s.Save();',
    ].join(' ');
    const r = runCapture('powershell.exe', ['-NoProfile', '-Command', ps]);
    if (r.status !== 0) { console.error('⛔ 建快捷方式失败：' + r.text); process.exit(1); }
    console.log(`✅ 已设为开机自启：${lnk}`);
    console.log('   （取消：node tools/desktop-bubbles.mjs --no-autostart）');
  } else {
    if (fs.existsSync(lnk)) fs.rmSync(lnk);
    console.log(`✅ 已取消开机自启（${lnk}）`);
  }
}

// ---------------- 主流程 ----------------
build();
// ⚠️ `--build` 只编译就该退出：第一版漏了这一行，于是"只编译"顺手把泡泡也启动了
if (has('--build')) process.exit(0);
if (has('--selftest')) { await selftest(); process.exit(0); }
if (has('--autostart')) { autostart(true); process.exit(0); }
if (has('--no-autostart')) { autostart(false); process.exit(0); }
if (has('--no-start')) process.exit(0);
if (has('--probe')) {
  spawnSync(EXE, ['--probe-desktop'], { stdio: 'inherit' });
  process.exit(0);
}

if (!(await reachable())) {
  console.error(`⛔ 本地服务没在 ${BASE} 上跑 —— 桌面泡泡要问它"画什么"。`);
  console.error('   先启动服务（npm start 或双击 Timetable 的启动脚本），再跑这个。');
  process.exit(1);
}

const extra = [];
// ⚠️ 形态是**铺满全屏的透明层**（用户第 41 轮纠正的）：不是散落的圆，也不是一块面板，
//    而是"把整个气泡区搬到桌面上"，空白处点透、母泡泡画成一个虚化的圈。
//    默认置顶；`--desktop-only` 可以让它只出现在桌面上（被应用窗口盖住）。
if (has('--desktop-only')) extra.push('--desktop-only');
if (has('--capture-background')) extra.push('--capture-background');
if (has('--interval')) extra.push(`--interval=${args[args.indexOf('--interval') + 1] || 60}`);
// 用 start 让它脱离这个终端活着（关掉命令行窗口时气泡层不会跟着死）
const child = spawn('cmd.exe', ['/c', 'start', '', EXE, `--url=${BASE}`, ...extra], {
  detached: true, stdio: 'ignore', cwd: OUT_DIR,
});
child.unref();
console.log('✅ 桌面「气泡区」已启动（铺满全屏的透明层）。');
console.log('');
console.log('  · 空白处是**点透**的：桌面照常能用、别的软件照常能点，只有泡泡吃鼠标');
console.log('  · 泡泡：单击 = 编辑 · 双击 = 进去（套娃）· 长按 2.5 秒 = 戳破');
console.log('  · 拖动泡泡压到别的泡泡上 = 放进去（能不能进由 core 判断，进不去会抖一下并说明原因）');
console.log('  · 进了容器：画一个**母泡泡的圈**，圈里是**模糊的壁纸**（壁纸还在、只是虚的）；');
console.log('    单击背景 = 加子气泡 · 双击背景 = 出去一层 · **把泡泡拖到圈外松手 = 拉出来（和母泡泡平级）**');
console.log('  · 显示设置和软件气泡区**同一份**（时间范围 / 显示课程 / 显示已完成）');
console.log('  · 系统托盘图标（右键 = 菜单）：置顶开关 / 空白处是否吃点击 / 回到最外层 / 重排 / 退出');
console.log('  · 日志：build/desktop-bubbles.log');
