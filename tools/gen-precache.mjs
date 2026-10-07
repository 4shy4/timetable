// 从入口文件走依赖图，生成 Service Worker 的**预缓存清单**。
//
// 为什么要有这个工具：
//   原来 `web/sw.js` 的预缓存清单是**手工维护**的，只列了 11 个资源，
//   而实际有 46 个模块 —— 漏了 35 个（含 `bubble.js`、`editor.js`、
//   所有 adapter 和 core）。后果：iOS 加到主屏幕后一旦断网就**白屏**
//   （外壳在缓存里，但模块加载失败）。
//   手工清单**必然漂移**：以后加一个新视图就漏一个。所以改成生成。
//
// 用法：
//   node tools/gen-precache.mjs           # 打印清单
//   node tools/gen-precache.mjs --write   # 写回 web/sw.js
//   node tools/gen-precache.mjs --check   # 只校验是否同步（给测试用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');

/**
 * 静态 import / export ... from / 动态 import() 的模块说明符。
 *
 * ⚠️ 中段必须用 `[^;]*?`（**允许换行**），不能用 `[^;\n]*?`。
 *    长 import 列表习惯写成多行：
 *      import {
 *        a, b, c,
 *      } from './x.js';
 *    用 `[^;\n]*?` 会因为撞到第一个换行就匹配失败，**静默漏掉整个模块**。
 *    这个 bug 让 `/core/recycle.js` 没进预缓存清单 —— 而它正是回收站依赖的模块。
 *    （`[^;]` 仍然排除分号，所以不会跨越两条语句。）
 */
const SPEC_RE = /(?:^|\n)\s*(?:import|export)[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 从一个 JS 文件里抽出所有模块说明符 */
function specifiers(code) {
  const out = new Set();
  for (const m of code.matchAll(SPEC_RE)) {
    const s = m[1] || m[2] || m[3];
    if (s && (s.startsWith('./') || s.startsWith('../') || s.startsWith('/'))) out.add(s);
  }
  return [...out];
}

/** 模块说明符 → 仓库里的绝对路径 */
function resolveSpec(fromFile, spec) {
  if (spec.startsWith('/')) {
    // 站内绝对路径：先按 web/ 下找，再按仓库根找（`/core/...` 指仓库根的 core）
    const a = path.join(WEB, spec);
    if (fs.existsSync(a)) return a;
    return path.join(ROOT, spec);
  }
  return path.resolve(path.dirname(fromFile), spec);
}

/** 仓库路径 → 站内 URL */
function toUrl(abs) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  if (rel.startsWith('web/')) return '/' + rel.slice('web/'.length);
  return '/' + rel;   // core/... 也挂在根上（服务器与 assets 都是这么放的）
}

/** 走完整个依赖图，返回 { urls:Set, missing:[] } */
export function collectShell(entry = path.join(WEB, 'ui', 'app.js')) {
  const urls = new Set();
  const missing = [];
  const seen = new Set();
  const queue = [entry];

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    let code;
    try {
      code = fs.readFileSync(file, 'utf8');
    } catch {
      missing.push(file);
      continue;
    }
    urls.add(toUrl(file));

    for (const spec of specifiers(code)) {
      const abs = resolveSpec(file, spec);
      if (!fs.existsSync(abs)) { missing.push(`${toUrl(file)} → ${spec}`); continue; }
      queue.push(abs);
    }
  }

  // 外壳本身：HTML、manifest、图标、样式
  for (const extra of [
    'index.html', 'join.html', 'manifest.webmanifest', 'sw.js',
    'assets/icon.svg', 'assets/icon-192.png', 'assets/icon-512.png',
  ]) {
    const p = path.join(WEB, extra);
    if (fs.existsSync(p)) urls.add('/' + extra);
  }
  // 样式：从 index.html 里抓 <link rel="stylesheet">
  try {
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    for (const m of html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)) urls.add(m[1]);
  } catch { /* ignore */ }

  return { urls: [...urls].sort(), missing };
}

/** 生成 sw.js 里那段的文本 */
export function renderShellArray(urls) {
  return `const SHELL = [\n${urls.map((u) => `  '${u}',`).join('\n')}\n];`;
}

// ---- CLI ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { urls, missing } = collectShell();
  const mode = process.argv.includes('--write') ? 'write'
    : process.argv.includes('--check') ? 'check' : 'print';

  if (missing.length) {
    console.error('⚠️ 有 import 指向不存在的文件：');
    missing.forEach((m) => console.error('   ' + m));
  }

  const swPath = path.join(WEB, 'sw.js');
  const sw = fs.readFileSync(swPath, 'utf8');
  const next = sw.replace(/const SHELL = \[[\s\S]*?\];/, renderShellArray(urls));
  const inSync = next === sw;

  if (mode === 'print') {
    console.log(`预缓存 ${urls.length} 个资源：`);
    urls.forEach((u) => console.log('  ' + u));
  } else if (mode === 'write') {
    fs.writeFileSync(swPath, next, 'utf8');
    console.log(`已写入 web/sw.js（${urls.length} 个资源）`);
  } else {
    console.log(inSync ? `✔ 预缓存清单已同步（${urls.length} 个资源）` : `✖ 预缓存清单**没同步**（应为 ${urls.length} 个）`);
  }
  process.exit(mode === 'check' && !inSync ? 1 : (missing.length ? 1 : 0));
}
