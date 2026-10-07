// 共用核心层的"平台无关性"守门测试。
//
// 为什么需要它：core/ 里的代码要被三端共用 —— 网页、安卓（WebView 或原生壳内嵌 JS）、
// iOS（JavaScriptCore）。只要有人在里面写了 window / document / localStorage / Buffer /
// node:fs，那另外两端就会在运行时炸，而且**只有跑到那一步才会发现**。
// 这个测试在 CI/本地就能立刻拦住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'core');

/** core/ 里必须存在的模块 */
const EXPECTED = ['time.js', 'recurrence.js', 'palette.js', 'urgency.js', 'reminder-plan.js', 'qrcode.js'];

/** 禁止出现在 core/ 里的东西：[正则, 说明] */
const FORBIDDEN = [
  [/\bfrom\s+['"]node:/, 'Node 内置模块（from "node:..."）'],
  [/\brequire\s*\(\s*['"]node:/, 'Node 内置模块（require("node:...")）'],
  [/\bfrom\s+['"][^'"]*\.\.\/server\//, '反向依赖服务端代码'],
  [/\bfrom\s+['"][^'"]*\.\.\/web\//, '反向依赖网页层代码'],
  [/\bprocess\s*\.\s*(env|argv|exit|platform|cwd)/, 'process 平台对象'],
  [/\bBuffer\s*\.\s*(from|alloc|concat)/, 'Node Buffer'],
  [/\bnew\s+TextEncoder\b/, null, false], // 占位，TextEncoder 是允许的（Web 标准）
  [/\bdocument\s*\./, 'document（DOM）'],
  [/\bwindow\s*\./, 'window'],
  [/\blocalStorage\b/, 'localStorage'],
  [/\bsessionStorage\b/, 'sessionStorage'],
  [/\bNotification\b\s*\./, 'Notification API'],
  [/\bfetch\s*\(/, 'fetch（应通过注入的适配器）'],
  [/\bAudioContext\b/, 'AudioContext'],
  [/\bnavigator\s*\./, 'navigator'],
  [/\brequestAnimationFrame\b/, 'requestAnimationFrame（渲染相关）'],
  [/\bResizeObserver\b/, 'ResizeObserver'],
  [/\bfs\s*\.\s*(readFileSync|writeFileSync|existsSync)/, 'node:fs 用法'],
].filter(([, desc]) => desc);

function coreFiles() {
  return fs.readdirSync(CORE).filter((f) => f.endsWith('.js')).sort();
}

test('core/ 里有预期的模块', () => {
  const files = coreFiles();
  for (const name of EXPECTED) {
    assert.ok(files.includes(name), `缺少 core/${name}`);
  }
});

test('core/ 里没有平台依赖（三端共用的前提）', () => {
  const violations = [];
  for (const file of coreFiles()) {
    const text = fs.readFileSync(path.join(CORE, file), 'utf8');
    const lines = text.split('\n');
    for (const [pattern, desc] of FORBIDDEN) {
      lines.forEach((line, i) => {
        // 跳过注释行：注释里提到某个 API 名字是允许的
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        if (pattern.test(line)) {
          violations.push(`core/${file}:${i + 1} 用了 ${desc}  ->  ${trimmed.slice(0, 70)}`);
        }
      });
    }
  }
  assert.equal(violations.length, 0, `core/ 必须是平台无关的，发现 ${violations.length} 处：\n  ` + violations.join('\n  '));
});

test('core/ 只依赖 core/ 内部的模块（不向上下层反向引用）', () => {
  const problems = [];
  for (const file of coreFiles()) {
    const text = fs.readFileSync(path.join(CORE, file), 'utf8');
    const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of imports) {
      if (spec.startsWith('.')) {
        const resolved = path.resolve(CORE, spec);
        if (!resolved.startsWith(CORE)) problems.push(`core/${file} 引用了 core/ 之外的 ${spec}`);
        else if (!fs.existsSync(resolved)) problems.push(`core/${file} 引用了不存在的 ${spec}`);
      } else {
        problems.push(`core/${file} 引用了外部包 ${spec}`);
      }
    }
  }
  assert.equal(problems.length, 0, problems.join('\n  '));
});

test('core/ 的每个模块都能在"没有浏览器也没有 Node"的环境下加载', async () => {
  // 关键：在 Node 里把平台全局变量先删掉，再 import。
  // 如果模块顶层用到它们，加载就会失败 —— 这正是 iOS JavaScriptCore 的情形。
  const saved = {};
  const platforms = ['document', 'window', 'localStorage', 'sessionStorage', 'Notification', 'AudioContext', 'navigator'];
  for (const key of platforms) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    try { delete globalThis[key]; } catch { /* 只读属性，忽略 */ }
  }
  const savedBuffer = globalThis.Buffer;
  try {
    // Node 的 Buffer 在 JavaScriptCore 里不存在，所以也临时藏起来
    // eslint-disable-next-line no-global-assign
    globalThis.Buffer = undefined;
    for (const file of coreFiles()) {
      const mod = await import(`../core/${file}?bare=${Date.now()}-${Math.random()}`);
      assert.ok(mod, `core/${file} 加载失败`);
    }
  } finally {
    globalThis.Buffer = savedBuffer;
    for (const [key, desc] of Object.entries(saved)) {
      if (desc) Object.defineProperty(globalThis, key, desc);
    }
  }
});

test('二维码在无 Buffer 环境下仍能生成并解回（回归）', async () => {
  const savedBuffer = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    const qr = await import(`../core/qrcode.js?bare=${Date.now()}`);
    const url = 'https://192.0.2.100:7443/?name=日程表';
    const matrix = qr.makeQrMatrix(url, { ecl: 'M' });
    assert.equal(qr.decodeQrMatrix(matrix.modules), url, '二维码内容对不上');
    const svg = qr.toSvg ? qr.toSvg(url) : qr.qrToSvg(url);
    assert.ok(svg.includes('<svg'), 'SVG 输出异常');
  } finally {
    globalThis.Buffer = savedBuffer;
  }
});
