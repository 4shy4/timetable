// 统一的路径与运行常量。所有文件读写只在这里定义，避免散落。
import { fileURLToPath } from 'node:url';
import os from 'node:os';
// 读注册表拿网卡的真实描述 —— Windows 的别名（「以太网 2」）看不出是不是虚拟网卡，
// 而描述只存在注册表里。见 lanUrls 的注释。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const WEB_DIR = path.join(ROOT, 'web');
/** 共用核心层：平台无关的纯逻辑，网页 / 安卓 / iOS 三端共用同一份源码 */
export const CORE_DIR = path.join(ROOT, 'core');
/**
 * 数据目录。优先级：`--data-dir=` 参数 **>** `TIMETABLE_DATA_DIR` 环境变量 **>** 默认 `<repo>/data`。
 *
 * ⚠️ 为什么要**两条**路（不是重复造轮子，各有各的用处，都不能删）：
 *   · `--data-dir=` 给**运维/用户**：`node server/main.js --data-dir=D:\我的日程` 是最直观的
 *     说法，能直接写进快捷方式 / 启动器，而且已经在用。
 *   · `TIMETABLE_DATA_DIR` 给**测试/CI**：这是唯一能在 `import` 之前生效的口子。
 *     原因很硬：`DATA_DIR` 是**模块加载那一刻**就算出来的常量，而 `process.argv` 是
 *     进程启动时定型的。测试套件想换目录，只能在 import server/ 之前动 `process.env`
 *     —— 晚一步（哪怕 import 之后再 `argv.push('--data-dir=…')`）就已经晚了：
 *     常量早算完了，后面 import 的 store.js 接着用那个**已经算好的真目录**。
 *     这个坑真发生过：一个套件先 import 了 ai-share.js（它 import 本文件），
 *     再 push `--data-dir=`，于是夹具的假 Key / 假端口覆盖了用户真实的 AI 配置。
 *
 * ⚠️ 顺序即优先级：**参数优先于环境变量**。命令行是这一次运行的显式意图；环境变量可能是
 *    从父进程继承来的（IDE、CI、shell 里全局设了一个），显式参数必须能压过它。
 *    两者都按 cwd 解析（与环境变量在 shell 里的直觉一致）。
 */
const dataDirArg = (process.argv.find((a) => a.startsWith('--data-dir=')) || '').split('=')[1];
const dataDirEnv = process.env.TIMETABLE_DATA_DIR;
export const DATA_DIR = dataDirArg
  ? path.resolve(dataDirArg)
  : (dataDirEnv ? path.resolve(dataDirEnv) : path.join(ROOT, 'data'));
export const DB_FILE = path.join(DATA_DIR, 'db.json');
export const FIRED_FILE = path.join(DATA_DIR, 'fired.json');
export const LOG_FILE = path.join(DATA_DIR, 'server.log');
export const PID_FILE = path.join(DATA_DIR, 'server.pid');

// HTTPS 证书（手机通过局域网访问时需要安全上下文：安卓才允许"添加到主屏幕"和通知）
export const CERT_DIR = path.join(DATA_DIR, 'cert');
export const PFX_FILE = path.join(CERT_DIR, 'server.pfx');
export const CERT_INFO_FILE = path.join(CERT_DIR, 'cert-info.json');
/** 给 iOS / 安卓安装用的公开证书（DER 编码 .crt）；由 tools/make-cert.ps1 之后再导出 */
export const CRT_FILE = path.join(CERT_DIR, 'timetable-ca.crt');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

/** --lan：监听 0.0.0.0，让同一局域网的手机/平板能访问 */
export const LAN = has('--lan');
/** --https：额外起一个 HTTPS 端口（有证书时才真正生效） */
export const WANT_HTTPS = has('--https') || has('--lan');
/** --no-https：即使有证书也不起 HTTPS */
export const NO_HTTPS = has('--no-https');

export const PORT = Number(
  (argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] || 7080,
);
export const HTTPS_PORT = Number(
  (argv.find((a) => a.startsWith('--https-port=')) || '').split('=')[1] || 7443,
);

/**
 * 「把电脑当平板的 AI 服务器」里平板上要填的端口。
 *
 * ⚠️ 它**就是**本机服务的端口（`PORT`），不是另一个监听端口 —— 共享没有开
 *    （见 server/ai-share.js）。单独给一个常量是为了让界面/测试有个名字可用，
 *    免得在别处写死 7080（改了 `--port=` 就跟不上）。
 */
export const SHARE_DEFAULT_PORT = PORT;

export const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const BASE_HTTPS_URL = `https://127.0.0.1:${HTTPS_PORT}`;

export const TICK_MS = 20_000; // 提醒引擎轮询间隔
export const HORIZON_HOURS = 25; // 每次只计算未来这么久内的提醒

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 证书是否就绪（PFX + 元信息） */
export function httpsCertAvailable() {
  return fs.existsSync(PFX_FILE);
}

export function certInfo() {
  try {
    return JSON.parse(fs.readFileSync(CERT_INFO_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** 本机所有非回环 IPv4 地址（保留网卡名，用来识别虚拟网卡）*/
export function localIPv4Detailed() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if ((ni.family === 'IPv4' || ni.family === 4) && !ni.internal) out.push({ name, ip: ni.address });
    }
  }
  // 同一地址出现在多张网卡上时只留一条
  const seen = new Set();
  return out.filter((x) => (seen.has(x.ip) ? false : (seen.add(x.ip), true)));
}

/** 本机所有非回环 IPv4 地址 */
export function localIPv4() {
  return localIPv4Detailed().map((x) => x.ip);
}

/**
 * 哪些 IP 属于"手机可能连得上"的网卡。
 *
 * ⚠️ 为什么需要（实测踩过）：装了 VirtualBox 的机器上，它的 Host-Only 网卡地址是一个 `192.168.x.x` —— 而原来的排序规则认为"192.168.* 最像家用局域网"，
 *    于是把这个**手机根本连不上**的地址排到第一位，还当成"推荐地址"推给用户
 *    （扫码进去必然失败）。
 *
 * 判据：**有没有默认网关**。
 *   · WLAN（校园网 / 手机热点） 网关 → 能出去，手机连得上
 *   · VirtualBox（Host-Only 网卡） 网关（空） → 出不去，手机连不上
 *   这比"网段像不像 192.168"可靠得多，也比读注册表简单。
 *
 * ⚠️ 试过但**放弃**的方案：按网卡名匹配 `virtualbox` ——
 *    Windows 上 `os.networkInterfaces()` 给的是**别名**（中文系统叫「以太网 2」），
 *    真实描述只在注册表里，按名字匹配**完全失效**。
 *    读注册表的 `reg query` 又因为转义/权限太脆，不值得。
 *
 * 拿不到网关信息时（非 Windows / 命令失败）返回 null，调用方回退到名字关键词。
 */
/**
 * `ConvertTo-Json` 在**只有一个结果**时返回**标量**（`"9"`）而不是数组（`"[9]"`）——
 * 这是一个经典陷阱。不处理的话 `for...of` 会抛 `TypeError: 9 is not iterable`，
 * 而那个异常会被 catch 吞掉，表现为"这个功能完全没生效"（我就是这么被坑的：
 * 命令输出明明是对的、排序却一直不变）。
 */
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

let gatewayIps = null;
function ipsWithGateway() {
  if (gatewayIps !== null) return gatewayIps;
  gatewayIps = new Set();
  if (process.platform !== 'win32') return gatewayIps;
  try {
    // ⚠️ 这块试了四种写法才定下来，把经验记下（省得下次又踩）：
    //
    //   ✖ 在 `-Command` 里拼 `\"0.0.0.0\"` —— PowerShell 把 `\"` 当字面量，
    //      报「找不到接受实际参数"0.0.0.0\""的位置形式参数」。
    //   ✖ 分两步查（先 InterfaceIndex、再 Get-NetIPAddress 映射）——
    //      单看每条都能跑，但在同一个 Node 进程里连着跑就**静默失败**，
    //      而异常被 catch 吞掉，表现为"排序怎么改都不变"（我被这个坑了很久）。
    //   ✔ **一步到位**：直接让 PowerShell 返回"有默认网关的网卡 IP"。
    //      不碰 CIM、不做第二次调用、不需要索引映射 —— 中间环节越少越不容易坏。
    //
    // 输出是 JSON（单个结果时是标量字符串，用 asArray 归一化）。
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      'Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } '
      + '| ForEach-Object { $_.IPv4Address.IPAddress } | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    for (const ip of asArray(JSON.parse(String(out).trim() || 'null'))) {
      if (ip) gatewayIps.add(String(ip));
    }
  } catch (err) {
    // ⚠️ 不要静默吞掉 —— 这个 catch 曾经把"命令失败"藏起来，
    //    表现为"排序怎么改都不变"，查了很久。
    if (process.env.TIMETABLE_DEBUG) {
      console.error('[paths] 探测默认网关失败，将回退到网卡名判断：', err.message);
    }
  }
  return gatewayIps;
}

/** 名字里能看出是虚拟网卡的关键词（拿不到网关信息时的回退）*/
const VIRTUAL_HINTS = [
  'virtualbox', 'vmware', 'hyper-v', 'vethernet', 'docker', 'wsl',
  'tailscale', 'zerotier', 'tap-', 'tun', 'npcap', 'bluetooth', 'vpn',
  'radmin', 'hamachi',
];

function looksVirtual(ifName, ip, ctx) {
  // ① 最可靠：有没有默认网关（虚拟的 Host-Only 网卡没有网关）
  const withGw = ipsWithGateway();
  if (withGw.size) return !withGw.has(ip);

  // ② 名字关键词
  const n = String(ifName || '').toLowerCase();
  if (VIRTUAL_HINTS.some((h) => n.includes(h))) return true;

  // ③ 兜底启发式（拿不到网关信息时用，比如非 Windows、或子进程被限制的场景）
  //
  // 背景：VirtualBox / VMware 的 Host-Only 网卡**几乎总是** 192.168.x.1 这种
  // 「网段里的 .1」。而真实 WiFi 在校园网/热点里常是 100.64/10（CGNAT）。
  // 所以：**当同时存在 CGNAT 地址时，把 192.168.x.1 视为可疑的虚拟网卡**。
  // 反过来（只有家用 192.168 网卡）不动 —— 那才是最常见的正常情况。
  if (ctx && ctx.hasCgnat && /^192\.168\.\d+\.1$/.test(ip)) return true;

  return false;
}

/** 诊断用：把"判定依据"摊开（排查"排序怎么没变"这类问题时必需）*/
export function lanDiagnostics() {
  const gw = ipsWithGateway();
  const detail = localIPv4Detailed();
  const ctx = { hasCgnat: detail.some((x) => isCgnat(x.ip)) };
  return {
    gatewayIps: [...gw],
    hasCgnat: ctx.hasCgnat,
    adapters: detail.map((x) => ({
      name: x.name, ip: x.ip, virtual: looksVirtual(x.name, x.ip, ctx),
    })),
  };
}

/** 100.64.0.0/10 = 运营商级 NAT（校园网、手机热点常见）*/
function isCgnat(ip) {
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
}

/**
 * 手机能用来访问本机的地址列表。
 *
 * 排序（越靠前越可能是"手机真能连上"的）：
 *   ① **有默认网关的网卡优先，其余垫底** —— 这条比网段判断重要得多
 *   ② 同组里再按"像不像家用局域网"排：192.168 / 10. / 172.16-31
 *   ③ `100.64/10`（运营商级 NAT，校园网/热点常见）排在真实网段之后
 */
export function lanUrls(port = PORT, scheme = 'http') {
  const netScore = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    // 100.64.0.0/10 = CGNAT（校园网 / 手机热点常见）。
    // 它**可以是真网卡**（不像 Tailscale 那样一定是虚拟的），所以只降一档。
    if (isCgnat(ip)) return 3;
    return 4;
  };
  const detail = localIPv4Detailed();
  const ctx = { hasCgnat: detail.some((x) => isCgnat(x.ip)) };
  return detail
    .map((x) => ({ ...x, virtual: looksVirtual(x.name, x.ip, ctx), net: netScore(x.ip) }))
    .sort((a, b) => (a.virtual - b.virtual) || (a.net - b.net) || a.ip.localeCompare(b.ip))
    .map((x) => `${scheme}://${x.ip}:${port}`);
}

