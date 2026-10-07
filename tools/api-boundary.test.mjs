// 架构约束：**所有网络访问必须走 `web/adapter/api.js`**。
//
// 为什么值得测（这不是洁癖，是为了让换传输方式只改一个文件）：
//   · 设置页原来有 2 处直接 `fetch('/api/net')` / `fetch('/api/qr')`，绕过了适配器
//   · 而 iOS 原生壳要把静态资源和 API 分开处理（自定义 scheme vs 本机 HTTP），
//     视图里散落的绝对路径 `/api/...` 会让那件事变成"满仓库找 fetch"
// 所以把这条约束用测试钉住：视图层与其它适配器里不该出现裸 fetch。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');

/** 允许出现 fetch 的文件（各有正当理由）*/
const ALLOW = new Set([
  'adapter/api.js',   // 唯一的网络出入口
  'sw.js',            // Service Worker 自己就是网络层
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('视图层与其它适配器里没有裸 fetch（网络访问收口在 api.js）', () => {
  const offenders = [];
  for (const file of walk(WEB)) {
    const rel = path.relative(WEB, file).replace(/\\/g, '/');
    if (ALLOW.has(rel)) continue;
    const code = fs.readFileSync(file, 'utf8');
    // 去掉注释再找，避免把注释里的示例当成违规
    const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/\bfetch\s*\(/.test(noComments)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    `这些文件直接用了 fetch，请改走 adapter/api.js：\n  ${offenders.join('\n  ')}`);
});

test('`/api/` 路径只出现在 api.js 里（视图里不要写死接口路径）', () => {
  const offenders = [];
  for (const file of walk(WEB)) {
    const rel = path.relative(WEB, file).replace(/\\/g, '/');
    if (ALLOW.has(rel)) continue;
    const code = fs.readFileSync(file, 'utf8');
    const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // 只看字符串字面量里的 /api/（注释里提到接口名是允许的）
    if (/['"`]\/api\//.test(noComments)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    `这些文件写死了 /api/ 路径，请改走 adapter/api.js：\n  ${offenders.join('\n  ')}`);
});

test('api.js 暴露了设置页需要的接入信息接口', async () => {
  // 用正则查（不在 Node 里真加载 api.js —— 它依赖 fetch/DOM 环境）
  const code = fs.readFileSync(path.join(WEB, 'adapter', 'api.js'), 'utf8');
  assert.match(code, /\bnet:\s*\(\)/, 'api.net() 不存在（设置页的"接入"卡片要用）');
  assert.match(code, /\bqr:\s*async/, 'api.qr() 不存在（二维码是 SVG 文本，需要单独函数）');
  assert.match(code, /\brecycle:\s*\(\)/, 'api.recycle() 不存在（回收气泡站要用）');
  assert.match(code, /\brestorePopped:\s*\(/, 'api.restorePopped() 不存在（还原要用）');
  // 课程表那边只有"导入"没有"删除"很久了；删课的路由/适配器方法就是这次补的，
  // 少一个都会让课表页那个按钮变成"点了没反应"。
  assert.match(code, /\bdeleteCourse:\s*\(/, 'api.deleteCourse() 不存在（删除课程要用）');
});
