// Service Worker 预缓存清单必须和实际依赖图一致。
//
// 为什么值得测：这份清单原来**手工维护**，只列了 11 个、漏了 35 个模块。
// 后果不是报错，而是**断网后白屏** —— 外壳在缓存里、模块加载失败。
// 这种"静默失效"最容易漏，所以用测试钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { collectShell, renderShellArray } = await import('./gen-precache.mjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW = path.join(ROOT, 'web', 'sw.js');

test('依赖图里所有模块都能被解析（没有断掉的 import）', () => {
  const { missing } = collectShell();
  assert.deepEqual(missing, [], `有 import 指向不存在的文件：\n${missing.join('\n')}`);
});

test('sw.js 的 SHELL 清单与依赖图同步', () => {
  const { urls } = collectShell();
  // ⚠️ 读进来先把行尾归一成 LF 再比。
  //    为什么：GitHub 的 windows runner 用 core.autocrlf=true 检出，`web/sw.js`
  //    在那边是 CRLF，而 `renderShellArray()` 生成的是 LF ⇒ `includes()` 恒 false，
  //    报出来却是「漏了 0 个 / 多了 0 个」这种**看不出原因**的假红
  //    （2026-10-07 公开仓库第一次 CI 就撞上这条，本机永远复现不了）。
  //    行尾不是这份清单要保证的东西，别让它决定测试的红绿。
  const sw = fs.readFileSync(SW, 'utf8').replace(/\r\n/g, '\n');
  const want = renderShellArray(urls);
  if (!sw.includes(want)) {
    // 给出可操作的差异，而不是只说"不一样"
    const cur = /const SHELL = \[([\s\S]*?)\];/.exec(sw);
    const curList = cur ? [...cur[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
    const missing = urls.filter((u) => !curList.includes(u));
    const extra = curList.filter((u) => !urls.includes(u));
    assert.fail(
      'SHELL 清单漂移了，跑 `node tools/gen-precache.mjs --write` 同步。\n'
      + `  漏了 ${missing.length} 个：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}\n`
      + `  多了 ${extra.length} 个：${extra.slice(0, 8).join(', ')}`,
    );
  }
});

test('关键模块确实在清单里（防止"生成了但漏了入口"）', () => {
  const { urls } = collectShell();
  for (const must of [
    '/ui/app.js',
    '/ui/views/bubble.js',
    '/ui/views/recycle.js',
    '/ui/editor.js',
    '/adapter/store.js',
    '/adapter/reminder.js',
    '/core/recurrence.js',
    '/core/course-digest.js',
    '/core/recycle.js',
    '/core/time.js',
  ]) {
    assert.ok(urls.includes(must), `${must} 不在预缓存清单里 —— 断网会白屏`);
  }
});

test('缓存版本号存在且是 vN 形式', () => {
  const sw = fs.readFileSync(SW, 'utf8');
  const m = /const CACHE = '([^']+)'/.exec(sw);
  assert.ok(m, 'sw.js 里找不到 CACHE 常量');
  assert.match(m[1], /^timetable-shell-v\d+$/,
    `CACHE 版本号形式不对：${m[1]}（改 SHELL 后必须同时涨版本，否则旧缓存不失效）`);
});

test('外壳资源（HTML/manifest/图标）也在清单里', () => {
  const { urls } = collectShell();
  for (const must of ['/index.html', '/manifest.webmanifest']) {
    assert.ok(urls.includes(must), `${must} 不在预缓存清单里`);
  }
});
