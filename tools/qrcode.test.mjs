// 二维码生成器的单元测试。
//
// 重点不是"看起来像二维码"，而是**能不能被读回来**：
// 测试里带一个独立实现的反向解码器（去掩码 → 反交错 → 还原字节），
// 用它把内容读出来比对，等价于"手机扫得出来"。
//
// ⚠️ 但"自己验自己"曾经漏掉过一个致命 bug（2026-10-08）：
//    格式信息的位置行/列写反，编码器与自检解码器共享同一个错误假设，
//    于是本文件、net.test.mjs、selfcheck.mjs 全绿，真手机/OpenCV 却一个都扫不出来。
//    所以下面还有一组**外部参照**断言：矩阵必须与 Python `qrcode` 库逐格一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeQrMatrix, decodeQrMatrix, qrToSvg } from '../core/qrcode.js';

const SAMPLES = [
  'http://127.0.0.1:7080/',
  'https://192.0.2.1:7443/',
  'https://192.0.2.1:7443/',
  'https://198.51.100.2:7443/join',
  'https://timetable.local:7443/',
  'a',
  'https://192.0.2.1:7443/?src=qr&v=2',
];

test('往返解码：生成的内容都能被读回来（等价于手机扫得出来）', () => {
  for (const text of SAMPLES) {
    const { modules } = makeQrMatrix(text);
    const back = decodeQrMatrix(modules);
    assert.equal(back, text, `内容不一致：${text}`);
  }
});

test('中文内容也能往返（UTF-8 字节模式）', () => {
  const text = 'https://192.0.2.1:7443/?name=日程表';
  const { modules } = makeQrMatrix(text);
  assert.equal(decodeQrMatrix(modules), text);
});

test('四种纠错等级都能往返', () => {
  const text = 'https://192.0.2.1:7443/';
  for (const ecl of ['L', 'M', 'Q', 'H']) {
    const { modules, ecl: got } = makeQrMatrix(text, { ecl });
    assert.equal(got, ecl);
    assert.equal(decodeQrMatrix(modules), text);
  }
});

test('矩阵尺寸符合标准：17 + 4×版本', () => {
  for (const text of SAMPLES) {
    const { size, version, modules } = makeQrMatrix(text);
    assert.equal(size, version * 4 + 17);
    assert.equal(modules.length, size);
    for (const row of modules) assert.equal(row.length, size);
  }
});

test('三个定位图形位置正确（黑框白底黑心）', () => {
  const { size, modules } = makeQrMatrix('https://192.0.2.1:7443/');
  const corners = [[0, 0], [0, size - 7], [size - 7, 0]];
  for (const [r0, c0] of corners) {
    for (let i = 0; i < 7; i += 1) {
      assert.equal(modules[r0][c0 + i], 1, `定位图形上边 (${r0},${c0})`);
      assert.equal(modules[r0 + 6][c0 + i], 1, `定位图形下边 (${r0},${c0})`);
      assert.equal(modules[r0 + i][c0], 1, `定位图形左边 (${r0},${c0})`);
      assert.equal(modules[r0 + i][c0 + 6], 1, `定位图形右边 (${r0},${c0})`);
    }
    assert.equal(modules[r0 + 1][c0 + 1], 0, '定位图形内部应为白');
    assert.equal(modules[r0 + 3][c0 + 3], 1, '定位图形中心应为黑');
  }
});

test('定时图案黑白交替', () => {
  const { size, modules } = makeQrMatrix('https://192.0.2.1:7443/');
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `水平定时图案第 ${i} 列`);
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, `竖直定时图案第 ${i} 行`);
  }
});

test('固定黑点存在，且格式信息区域被占用', () => {
  const { size, modules } = makeQrMatrix('https://192.0.2.1:7443/');
  assert.equal(modules[size - 8][8], 1, '固定黑点');
  // 左上角格式信息两侧的一排必须有值（0 或 1，不能是 null）
  for (let i = 0; i < 9; i += 1) {
    if (i === 6) continue;
    assert.ok(modules[8][i] === 0 || modules[8][i] === 1);
    assert.ok(modules[i][8] === 0 || modules[i][8] === 1);
  }
});

test('内容太长会给出清晰报错，而不是生成坏码', () => {
  const huge = 'x'.repeat(400);
  assert.throws(() => makeQrMatrix(huge), /内容太长/);
});

test('相同的输入产生完全相同的结果（可复现）', () => {
  const a = makeQrMatrix(SAMPLES[0]).modules.flat().join('');
  const b = makeQrMatrix(SAMPLES[0]).modules.flat().join('');
  assert.equal(a, b);
});

test('SVG 输出包含黑白两种颜色与正确的 viewBox', () => {
  const svg = qrToSvg('https://192.0.2.1:7443/');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /fill="#000000"/);
  assert.match(svg, /fill="#ffffff"/);
  assert.match(svg, /<\/svg>$/);
});

// ---------------- 外部参照（防"自己验自己"） ----------------
// tools/fixtures/qr-reference.json 由 build/make-qr-fixture.py 用 Python `qrcode` 库生成
// （与本仓库毫无关系的外部实现），里面是 5 组用例的完整矩阵。
//
// 比对时要把掩码钉成参照那一颗：**掩码选择只是"哪个更耐脏"的启发式**，8 颗都是合法码，
// 我们的打分与 Python 的打分在小尺寸上会挑出不同的掩码（实测 5 组里 2 组不同）。
// 真正必须一致的是"同一颗掩码下，每一格都对得上" —— 格式信息的位置错了就会在这里现形。
const REFERENCE = JSON.parse(readFileSync(new URL('./fixtures/qr-reference.json', import.meta.url), 'utf8'));

test('与外部实现（Python qrcode 库）逐格一致', () => {
  assert.ok(REFERENCE.cases.length >= 4, '外部参照不能是空的');
  for (const c of REFERENCE.cases) {
    const { modules, size, mask } = makeQrMatrix(c.text, { ecl: c.ecl, mask: c.mask });
    const label = `${c.text} [${c.ecl}]`;
    assert.equal(size, c.size, `${label} 版本/尺寸对不上`);
    assert.equal(mask, c.mask, `${label} 掩码没有按参数钉住`);
    const spots = [];
    for (let r = 0; r < size; r += 1) {
      for (let col = 0; col < size; col += 1) {
        const want = c.rows[r][col] === '1' ? 1 : 0;
        if (modules[r][col] !== want) {
          spots.push(`(${r},${col})`);
          if (spots.length >= 8) break;
        }
      }
      if (spots.length >= 8) break;
    }
    assert.equal(spots.length, 0, `${label} 与外部实现对不上，例如这些格子：${spots.join(' ')}`);
  }
});

test('外部实现生成的矩阵，我们的解码器也能读回来（反方向同样可信）', () => {
  for (const c of REFERENCE.cases) {
    const ref = c.rows.map((row) => [...row].map(Number));
    assert.equal(decodeQrMatrix(ref), c.text, `${c.text} 读不回`);
  }
});

test('钉住掩码只影响掩码本身，不影响内容（掩码是自由选择项）', () => {
  const text = 'https://192.0.2.1:7443';
  for (let mask = 0; mask < 8; mask += 1) {
    const { modules, mask: got } = makeQrMatrix(text, { mask });
    assert.equal(got, mask);
    assert.equal(decodeQrMatrix(modules), text, `掩码 ${mask} 读不回`);
  }
});
