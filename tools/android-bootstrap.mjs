// 安卓工具链引导：把编译安卓壳子需要的东西**下载进工作区**，之后可离线使用。
//
// 为什么要有这个脚本：
//   本机没有 JDK / Gradle / Android SDK，而这类东西的下载地址经常变。
//   与其手敲一堆命令，不如把"确切文件名 + 校验值"钉在代码里，一条命令重建。
//
// 用法：
//   node tools/android-bootstrap.mjs            # 下载并安装全部
//   node tools/android-bootstrap.mjs --list     # 只列清单，不下载
//   node tools/android-bootstrap.mjs --only=jdk # 只装某一项
//   node tools/android-bootstrap.mjs --verify   # 只校验已安装的东西
//
// 装到哪里：android/toolchain/
//   jdk/            自解压的 Temurin JDK（不走系统安装，纯绿色）
//   sdk/cmdline-tools/latest/   Android 命令行工具（sdkmanager / avdmanager）
//   sdk/platform-tools/         adb 等
//   sdk/platforms/、sdk/build-tools/  由 sdkmanager 装
//   gradle/         Gradle 发行包
//   cache/          下载的 zip 留在这里，重装不用重新下（可手动删）
//
// 两个环境事实（写在 docs/ANDROID-TOOLCHAIN.md 里）：
//   · 这台机器的 curl / Invoke-WebRequest 走 Windows schannel，读不到系统证书 → HTTPS 全失败；
//     Node 自带 OpenSSL 与信任库，所以下载必须用 Node。
//   · developer.android.com 在本机**连不上**（超时），但 dl.google.com 通。
//     所以本文档里的链接一律指向 dl.google.com，文档页不要作为依赖。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import dns from 'node:dns';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipTo } from './zip.mjs';

dns.setDefaultResultOrder('ipv4first');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLCHAIN = path.join(ROOT, 'android', 'toolchain');
const CACHE = path.join(TOOLCHAIN, 'cache');

const isWin = process.platform === 'win32';
const EXE = isWin ? '.exe' : '';
const BAT = isWin ? '.bat' : '';

/**
 * 要装的东西。
 *
 * ⚠️ 版本号是**为了可重建**而钉住的，不是"必须用这个版本"：
 *    · JDK 21：Gradle 8.x 与 AGP 8.x 都要求 JDK 17+，21 是当前 LTS。
 *    · 命令行工具：版本号来自 dl.google.com 的 repository2-3.xml（`*_latest.zip` 随时会更）。
 *    · Gradle 8.14.3：与本项目将来用的 AGP 8.x 匹配。
 * 换版本时**只改这张表**，并在换完后核对校验值。
 *
 * `mirrors` 是**这台机器的网络现实**逼出来的：
 *   官方 JDK（GitHub releases）与官方 Gradle（services.gradle.org → 307 到 GitHub）
 *   在本机 **ETIMEDOUT**（GitHub 的 20.205.243.166 连不上），
 *   所以每个组件都配了国内镜像；官方源仍排第一，能通则优先用它。
 *   镜像指向的是**同一个官方文件**（文件名与大小一致），所以哈希校验照样有效。
 *   实测：清华 Adoptium 镜像 189ms、腾讯云 Gradle 直接给 131 MB、dl.google.com 537ms。
 */
const COMPONENTS = {
  jdk: {
    title: 'Temurin JDK 21（自解压，绿色）',
    url: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',
    mirrors: [
      'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',
    ],
    file: 'OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip',
    sha256: 'f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e',
    size: 205105307,
    installTo: 'jdk',
  },
  cmdlineTools: {
    title: 'Android 命令行工具（sdkmanager / avdmanager）',
    url: 'https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip',
    mirrors: [],
    file: 'commandlinetools-win-16111833_latest.zip',
    sha1: '57d04f2d75eb8e8fffc5000a987e5de4b5a63e9d',
    size: 154957218,
    installPrefix: 'sdk/cmdline-tools/latest',
    stripFirstDir: 'cmdline-tools',
  },
  gradle: {
    title: 'Gradle 8.14.3（发行包）',
    url: 'https://services.gradle.org/distributions/gradle-8.14.3-bin.zip',
    mirrors: [
      'https://mirrors.cloud.tencent.com/gradle/gradle-8.14.3-bin.zip',
      'https://repo.huaweicloud.com/gradle/gradle-8.14.3-bin.zip',
    ],
    file: 'gradle-8.14.3-bin.zip',
    // 校验值取自 repo.huaweicloud.com 的官方 .sha256（services.gradle.org 会 301 到 GitHub，
    // 那里本机连不上）。它核对的就是官方发布的那份 zip。
    sha256: 'bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531',
    size: 137393837,
    installPrefix: 'gradle',
    stripFirstDir: 'gradle-8.14.3',
  },
};

const SDK_PACKAGES = [
  'platform-tools',
  'platforms;android-35',
  'build-tools;35.0.0',
];
// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function log(msg) { console.log(msg); }
function step(msg) { console.log(`\n▶ ${msg}`); }

/**
 * 下载（跟随重定向，支持 Range 断点续传）。
 * `noRedirect` 时不跟重定向 —— 用来判断"官方源是不是把我们甩到 GitHub 去了"。
 */
function download(url, dest, { redirects = 6, noRedirect = false } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    let start = 0;
    if (fs.existsSync(dest)) start = fs.statSync(dest).size;
    const headers = { 'User-Agent': 'timetable-bootstrap/1.0' };
    if (start > 0) headers.Range = `bytes=${start}-`;

    const req = mod.get(url, { timeout: 60000, headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (noRedirect) {
          const e = new Error(`重定向到 ${res.headers.location.slice(0, 60)}`);
          e.redirectTo = res.headers.location;
          reject(e);
          return;
        }
        if (redirects <= 0) { reject(new Error('重定向太多')); return; }
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        resolve(download(next, dest, { redirects: redirects - 1 }));
        return;
      }
      if (res.statusCode === 206 || res.statusCode === 200) {
        // 200 表示服务端忽略了 Range（或本来就没下过），从头写
        const appending = res.statusCode === 206 && start > 0;
        const total = Number(res.headers['content-length'] || 0) + (appending ? start : 0);
        const out = fs.createWriteStream(dest, { flags: appending ? 'a' : 'w' });
        let got = appending ? start : 0;
        let lastPrint = 0;
        res.on('data', (chunk) => {
          got += chunk.length;
          if (total && Date.now() - lastPrint > 1500) {
            lastPrint = Date.now();
            process.stdout.write(`\r    ${human(got)} / ${human(total)}  ${((got / total) * 100).toFixed(1)}%   `);
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          if (total) process.stdout.write('\r' + ' '.repeat(60) + '\r');
          resolve({ bytes: got, total, host: safeHost(url) });
        });
        out.on('error', reject);
        return;
      }
      if (res.statusCode === 416) { res.resume(); resolve({ bytes: start, resumed: true, host: safeHost(url) }); return; }
      res.resume();
      reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', reject);
  });
}

function safeHost(url) {
  try { return new URL(url).host; } catch { return url; }
}

/**
 * 按"官方源 → 镜像"依次尝试下载。
 *
 * 为什么要这一步：官方 JDK 在 GitHub releases、官方 Gradle 会 307 到 GitHub，
 * 而本机连不上 GitHub（ETIMEDOUT）。先用 `noRedirect` 探一下，被重定向就换镜像，
 * 免得白等 60 秒超时。
 */
async function downloadWithFallback(spec, dest) {
  const tried = [];
  const primary = spec.url;
  try {
    const r = await download(primary, dest, { noRedirect: true });
    log(`  来源：官方 ${r.host}`);
    return r;
  } catch (err) {
    if (err.redirectTo) log(`  官方源重定向到 GitHub（本机连不上），改用镜像`);
    else log(`  官方源不可用（${err.message}），改用镜像`);
    tried.push(primary);
  }
  for (const m of spec.mirrors || []) {
    try {
      const r = await download(m, dest, { redirects: 4 });
      log(`  来源：镜像 ${r.host}`);
      return r;
    } catch (err) {
      log(`  镜像 ${safeHost(m)} 失败：${err.message}`);
      tried.push(m);
    }
  }
  throw new Error(`所有来源都失败：\n    ${tried.join('\n    ')}`);
}

function shaOf(file, algo) {
  const h = crypto.createHash(algo);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      h.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/**
 * 解压 zip —— 实现在 tools/zip.mjs（零依赖、走中央目录，有单测）。
 * 那里面记了为什么不能顺着"本地头"扫（踩过）。
 */


/** 递归找某个文件名（用于 JDK 解压后定位真实目录） */
function findFile(dir, name, depth = 3) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    if (e.isDirectory()) {
      const hit = findFile(p, name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 跑一个命令并把输出抓回来。
 *
 * 必须给 timeout：sdkmanager 首次运行会自己检查更新，能慢到一两分钟。
 */
function run(cmd, args, opts = {}) {
  const { timeout = 120000, ...rest } = opts;
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    ...rest,
  });
  return {
    code: r.status == null ? -1 : r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
    timedOut: Boolean(r.error && r.error.code === 'ETIMEDOUT'),
  };
}

/**
 * 跑一个 `.bat` / `.cmd`。
 *
 * `.bat` 在 Windows 上**不能**直接 spawn（EINVAL），必须经 cmd.exe；
 * 而经 cmd 时"路径里的空格/引号"极容易打架 —— 本项目路径还带中文括号，
 * 加一层引号也会被解析坏（实测：`'\"C:\...\sdkmanager.bat\"' 不是内部或外部命令`）。
 *
 * 所以这里**把 cwd 切到 bat 所在目录、只用文件名调用**：
 * 这样命令行里根本没有带路径的引号，绕开了整类问题。
 * 参数单独加引号（只对含空格/分号的加）。
 */
function runBat(batPath, args, opts = {}) {
  const dir = path.dirname(batPath);
  const file = path.basename(batPath);
  const inner = [file, ...args.map((a) => (/[\s;]/.test(a) ? `"${a}"` : a))].join(' ');
  return run('cmd', ['/c', inner], { cwd: dir, ...opts });
}

/** 工具链用的环境变量（不污染系统，只传给子进程） */
function toolEnv(extra = {}) {
  const jdk = path.join(TOOLCHAIN, 'jdk');
  const sdk = path.join(TOOLCHAIN, 'sdk');
  return {
    ...process.env,
    JAVA_HOME: jdk,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// 安装流程
// ---------------------------------------------------------------------------

function ensureDirs() {
  fs.mkdirSync(TOOLCHAIN, { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });
}

async function fetchComponent(key, spec) {
  step(`${spec.title}`);
  const cached = path.join(CACHE, spec.file);

  if (fs.existsSync(cached) && spec.size && fs.statSync(cached).size === spec.size) {
    log(`  缓存命中：${spec.file}`);
  } else {
    log(`  下载：${spec.file}`);
    const r = await downloadWithFallback(spec, cached);
    log(`  完成：${human(r.bytes)}${r.resumed ? '（续传）' : ''}`);
  }

  const got = fs.statSync(cached).size;
  // 大小只当**提示**，不当判据：HTTP 的 Content-Length 可能反映传输字节
  // （中间有 gzip 时与实际文件不同）。实测清华镜像下的 JDK 就差了 31 KB，
  // 但 SHA256 是对的 —— 所以哈希才是权威，这里只在明显不对时提醒。
  if (spec.size && Math.abs(got - spec.size) > 1024 * 1024) {
    log(`  ⚠️ 大小与预期差 ${human(Math.abs(got - spec.size))}：期望 ${spec.size}，实际 ${got}`);
    log(`     （若下面哈希不对，删掉 cache 里的这个文件重跑）`);
  }

  if (spec.sha256) {
    const h = shaOf(cached, 'sha256');
    if (h !== spec.sha256) throw new Error(`${spec.file} SHA256 不符\n  期望 ${spec.sha256}\n  实际 ${h}`);
    log(`  ✓ SHA256 校验通过`);
  } else if (spec.sha1) {
    const h = shaOf(cached, 'sha1');
    if (h !== spec.sha1) throw new Error(`${spec.file} SHA1 不符\n  期望 ${spec.sha1}\n  实际 ${h}`);
    log(`  ✓ SHA1 校验通过`);
  } else {
    log(`  实测 SHA256：${shaOf(cached, 'sha256')}`);
  }

  const dest = path.join(TOOLCHAIN, spec.installTo || spec.installPrefix || '');
  if (spec.installTo) {
    // 整包解到一个目录，再按需改名
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    const n = unzipTo(cached, dest);
    log(`  解压 ${n} 个文件 → ${path.relative(ROOT, dest)}`);
    // JDK 的顶层目录名带版本号，统一改名为 jdk/ 下的直接内容
    const inner = fs.readdirSync(dest, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (inner.length === 1 && !fs.existsSync(path.join(dest, 'bin'))) {
      const only = path.join(dest, inner[0].name);
      for (const e of fs.readdirSync(only)) {
        fs.renameSync(path.join(only, e), path.join(dest, e));
      }
      fs.rmdirSync(only);
      log(`  归一化目录名：${inner[0].name}/ → ${spec.installTo}/`);
    }
  } else {
    const n = unzipTo(cached, dest, { stripFirstDir: spec.stripFirstDir });
    log(`  解压 ${n} 个文件 → ${path.relative(ROOT, dest)}`);
  }
}

function sdkmanagerPath() {
  const p = path.join(TOOLCHAIN, 'sdk', 'cmdline-tools', 'latest', 'bin', `sdkmanager${BAT}`);
  return fs.existsSync(p) ? p : null;
}

/** 新的原生 CLI（`android.exe`）—— 官方推荐，且**没有 .bat 的引号/分号坑** */
function androidCliPath() {
  const p = path.join(TOOLCHAIN, 'sdk', 'cmdline-tools', 'latest', 'bin', `android${EXE}`);
  return fs.existsSync(p) ? p : null;
}

/**
 * 装 SDK 组件。
 *
 * ⚠️ 这里踩了一串坑，最后用**原生 `android.exe`**才走通：
 *
 *  1. `.bat` 不能被 spawn（Windows 上 EINVAL），必须经 cmd.exe；
 *  2. 经 cmd.exe 后，**项目路径里的中文括号 + 空格**会把引号解析坏：
 *     `'\"C:\...\sdkmanager.bat\"' 不是内部或外部命令`；
 *  3. 于是改成"cwd 切到 bin、只用文件名" —— 路径问题绕开了，
 *     但 `platforms;android-35` 里的**分号被 cmd 当成命令分隔符**：
 *     `android-35\""=="" was unexpected at this time`；
 *     `^;` 转义、单引号、`--package=` 全部不行（分号被吃掉 / 参数不认）。
 *  4. 换用原生 `android.exe sdk install <包>` —— 它把参数当真的 argv 收，
 *     中文路径与分号都不再有问题。
 *
 * 另外 sdkmanager 被官方标为 deprecated（会打印警告），`--licenses` 也已不再需要。
 *
 * 成功判据看**目录**而不是退出码：sdkmanager 常在收尾时崩（退出码 0xC0000409），
 * 但包其实已经装好了（实测 platform-tools 就是这样）。
 */
function installSdkPackages() {
  step('安装 SDK 组件');

  const cli = androidCliPath();
  const sdkRoot = path.join(TOOLCHAIN, 'sdk');

  if (cli) {
    for (const pkg of SDK_PACKAGES) {
      const dir = path.join(sdkRoot, ...pkg.split(';'));
      if (fs.existsSync(dir)) { log(`  ✓ ${pkg}（已存在）`); continue; }
      log(`  安装 ${pkg} …`);
      const r = run(cli, [`--sdk=${sdkRoot}`, 'sdk', 'install', pkg], {
        env: toolEnv(), timeout: 900000,
      });
      const ok = fs.existsSync(dir);
      log(`    ${ok ? '✓' : '✗'} ${pkg}${ok ? '' : `（退出码 ${r.code}）`}`);
      if (!ok) {
        const tail = `${r.out}\n${r.err}`.split('\n').filter((l) => l.trim()).slice(-3);
        tail.forEach((l) => log('      ' + l.slice(0, 110)));
      }
    }
    return listInstalledSdk().length >= SDK_PACKAGES.length;
  }

  // 退路：老的 sdkmanager.bat（只对不含分号的包安全，比如 platform-tools）
  const sm = sdkmanagerPath();
  if (!sm) { log('  ✗ 找不到 android.exe 与 sdkmanager，跳过'); return false; }
  log('  （没找到 android.exe，退回 sdkmanager.bat）');
  for (const pkg of SDK_PACKAGES) {
    let cmd;
    if (pkg.includes(';')) {
      log(`  ✗ ${pkg}：含分号，cmd 会解析坏，这条退路装不了它`);
      continue;
    }
    cmd = `echo y| ${path.basename(sm)} ${pkg}`;
    const r = run('cmd', ['/c', cmd], { cwd: path.dirname(sm), env: toolEnv(), timeout: 600000 });
    const ok = fs.existsSync(path.join(sdkRoot, ...pkg.split(';')));
    log(`    ${ok ? '✓' : '✗'} ${pkg}${ok ? '' : `（退出码 ${r.code}）`}`);
  }
  return listInstalledSdk().length > 0;
}

function verify() {
  step('环境自检');
  const results = [];
  const jdk = path.join(TOOLCHAIN, 'jdk');

  const javaExe = path.join(jdk, 'bin', `java${EXE}`);
  if (fs.existsSync(javaExe)) {
    const r = run(javaExe, ['-version']);
    results.push(['java', true, (r.err || r.out).split('\n')[0]]);
  } else results.push(['java', false, '未安装']);

  const javacExe = path.join(jdk, 'bin', `javac${EXE}`);
  if (fs.existsSync(javacExe)) {
    const r = run(javacExe, ['-version'], { timeout: 60000 });
    results.push(['javac', true, (r.out || r.err).split('\n')[0]]);
  } else results.push(['javac', false, '未安装']);

  const sm = sdkmanagerPath();
  if (sm) {
    // sdkmanager 会打印 deprecation 警告（"被 android CLI 取代"），但仍可用。
    // 只看它有没有正常输出版本号，不看警告。
    const r = runBat(sm, ['--version'], { env: toolEnv(), timeout: 180000 });
    const all = `${r.out}\n${r.err}`;
    const ver = (all.match(/^\d+\.\d+(\.\d+)?/m) || [])[0] || (r.code === 0 ? '可用' : '');
    results.push(['sdkmanager', Boolean(ver), ver || `退出码 ${r.code}`]);
  } else results.push(['sdkmanager', false, '未安装']);

  const adb = path.join(TOOLCHAIN, 'sdk', 'platform-tools', `adb${EXE}`);
  if (fs.existsSync(adb)) {
    const r = run(adb, ['version'], { timeout: 60000 });
    results.push(['adb', r.code === 0, (r.out || r.err).split('\n')[0]]);
  } else results.push(['adb', false, '未装（见上面 sdkmanager 的结果）']);

  const gradle = path.join(TOOLCHAIN, 'gradle', 'bin', `gradle${BAT}`);
  if (fs.existsSync(gradle)) {
    const r = runBat(gradle, ['--version'], { env: toolEnv(), timeout: 300000 });
    const line = `${r.out}\n${r.err}`.split('\n').find((l) => /Gradle \d/.test(l)) || '';
    results.push(['gradle', Boolean(line), line.trim() || `退出码 ${r.code}`]);
  } else results.push(['gradle', false, '未安装']);

  const installed = listInstalledSdk();
  log('');
  for (const [name, ok, detail] of results) {
    log(`  ${ok ? '✓' : '✗'} ${name.padEnd(11)} ${detail || ''}`);
  }
  if (installed.length) log(`  · SDK 组件     ${installed.join(', ')}`);
  const failed = results.filter((r) => !r[1]).length;
  log(`\n  自检：${results.length - failed}/${results.length} 通过`);
  return failed === 0;
}

/** 看 sdk 目录里到底装成了什么（不依赖 sdkmanager 输出） */
function listInstalledSdk() {
  const sdk = path.join(TOOLCHAIN, 'sdk');
  const out = [];
  const has = (p) => fs.existsSync(path.join(sdk, p));
  if (has('platform-tools')) out.push('platform-tools');
  for (const dir of ['platforms', 'build-tools']) {
    const d = path.join(sdk, dir);
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(`${dir};${e.name}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const only = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
  const listOnly = argv.includes('--list');
  const verifyOnly = argv.includes('--verify');

  log('安卓工具链引导');
  log(`  安装位置：${TOOLCHAIN}`);
  log(`  平台    ：${process.platform} ${os.arch()}  Node ${process.version}`);
  log(`  磁盘可用：${(os.freemem() / 1024 / 1024 / 1024).toFixed(1)} GB 内存`);

  if (listOnly) {
    step('清单（不下载）');
    let total = 0;
    for (const [key, spec] of Object.entries(COMPONENTS)) {
      log(`  ${key.padEnd(14)} ${human(spec.size).padStart(9)}  ${spec.file}`);
      total += spec.size;
    }
    log(`  ${'SDK 组件'.padEnd(14)} ${'~200 MB'.padStart(9)}  ${SDK_PACKAGES.join(', ')}`);
    log(`  ${'合计'.padEnd(14)} ${human(total).padStart(9)}（不含 SDK 组件）`);
    return;
  }

  if (verifyOnly) { verify(); return; }

  ensureDirs();
  for (const [key, spec] of Object.entries(COMPONENTS)) {
    if (only && only !== key) continue;
    await fetchComponent(key, spec);
  }

  if (!only || only === 'cmdlineTools') {
    const ok = installSdkPackages();
    if (!ok) log('  （SDK 组件没装成功也没关系：装好命令行工具后重跑本脚本即可）');
  }

  const allOk = verify();
  step(allOk ? '完成：工具链可用' : '部分组件缺失，见上面的自检结果');
  log(`\n  下一步：读 docs/ANDROID-TOOLCHAIN.md（里面有环境变量怎么设、怎么离线构建）`);
  if (!allOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n✗ 引导失败：', err.message);
  console.error('  重跑本脚本会从断点继续（zip 缓存在 android/toolchain/cache/）');
  process.exit(1);
});
