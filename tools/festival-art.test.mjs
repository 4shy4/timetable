// 节日背景图案（方案 A 矢量 / 方案 C 用户自己的图）的验证。
//
// ⚠️ 这里最该盯住的是**覆盖率**：30 个节日里漏掉一个，症状是"某个节日浮出来是光秃秃的"，
//    而光秃秃的泡泡看起来跟图案没做完一模一样 —— 所以"每个节日都必须有图案"要断言，
//    不能靠人眼在月历上一个个翻。
//
// 跑法：node tools/festival-art.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { festivalArt, motifFor, allMotifs, customArtSize, CUSTOM_ART_MAX } from '../core/festival-art.js';
import { FESTIVALS, FESTIVAL_COLORS } from '../core/holidays.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// ① 覆盖：每个节日都得有一张图案
// ---------------------------------------------------------------------------
test('图案：30 个节日全都分到了图案（一个都不许漏）', () => {
  const missing = [];
  for (const f of FESTIVALS) {
    const art = festivalArt(f.key);
    if (art.id === 'fallback') missing.push(`${f.key}(${f.name})`);
  }
  assert.deepEqual(missing, [], `这些节日还没分配图案：${missing.join('、')}`);
});

test('图案：同一个节日两次调用结果一致（纯函数，没有随机）', () => {
  for (const f of FESTIVALS) {
    assert.equal(JSON.stringify(festivalArt(f.key)), JSON.stringify(festivalArt(f.key)), f.key);
  }
});

test('图案：节日 key 大小写/未知 key 都不许抛异常（兜底图案）', () => {
  const art = festivalArt('buzhidaodeshenmejie');
  assert.equal(art.id, 'fallback');
  assert.ok(art.shapes.length > 0, '兜底也得有东西可画');
});

// ---------------------------------------------------------------------------
// ② 形状合法：越界/坏颜色会让 native 那侧画出鬼东西（WPF 拿到 NaN 直接异常）
// ---------------------------------------------------------------------------
test('形状：坐标都在 100×100 的框里（±2 容差）', () => {
  for (const m of allMotifs()) {
    assert.ok(m.shapes.length > 0, `${m.id} 一个形状都没有`);
    for (const s of m.shapes) {
      const pts = (s.t === 'p' || s.t === 'l') ? s.pts : [[s.x, s.y]];
      for (const [x, y] of pts) {
        assert.ok(Number.isFinite(x) && Number.isFinite(y), `${m.id} 有非数字坐标`);
        assert.ok(x >= -2 && x <= 102, `${m.id} 的 x=${x} 出框了`);
        assert.ok(y >= -2 && y <= 102, `${m.id} 的 y=${y} 出框了`);
      }
      if (s.t === 'c') assert.ok(s.r > 0, `${m.id} 有半径 <= 0 的圆`);
      if (s.t === 'e') assert.ok(s.rx > 0 && s.ry > 0, `${m.id} 有半轴 <= 0 的椭圆`);
      if (s.t === 'p') assert.ok(s.pts.length >= 3, `${m.id} 的多边形少于 3 个点`);
      if (s.t === 'l') assert.ok(s.pts.length >= 2 && s.w > 0, `${m.id} 的折线点数/线宽不对`);
    }
  }
});

test('形状：2 个点的形状必须是**折线**而不是多边形（填出来是一条看不见的缝）', () => {
  for (const m of allMotifs()) {
    for (const s of m.shapes) {
      if (s.t === 'p') assert.ok(s.pts.length >= 3, `${m.id} 拿 ${s.pts.length} 个点当多边形用了`);
      // ⚠️ 消息模板是**先求值**再传给 assert 的，条件为真也会执行 ——
      //    所以这里不能直接写 `${s.pts.length}`（圆和椭圆没有 pts，会抛 TypeError 把测试搞红）。
      assert.ok(!(s.t === 'l' && s.pts.length < 2), `${m.id} 的折线点数不对：${s.pts ? s.pts.length : 0}`);
    }
  }
});

test('形状：只有四种图元，颜色都是 #rrggbb，透明度在 0–1', () => {
  for (const m of allMotifs()) {
    for (const s of m.shapes) {
      assert.ok(['c', 'e', 'p', 'l'].includes(s.t), `${m.id} 出现了未知图元 ${s.t}`);
      assert.match(s.color, /^#[0-9a-fA-F]{6}$/, `${m.id} 的颜色 ${s.color} 不是 #rrggbb`);
      if (s.a !== undefined) assert.ok(s.a > 0 && s.a <= 1, `${m.id} 的 a=${s.a} 不在 0–1`);
    }
  }
});

test('形状：图案总数够用但没失控（8–40 个）', () => {
  const n = allMotifs().length;
  assert.ok(n >= 8 && n <= 40, `图案数量 ${n} 不合理`);
});

test('形状：节日用的图案**不跟自己的底色同色**（同色就看不见了）', () => {
  // 节日泡泡的底色是红色，图案主色要是也红，整块糊成一片
  const reds = new Set([FESTIVAL_COLORS.fill.toLowerCase(), FESTIVAL_COLORS.fillDark.toLowerCase()]);
  for (const f of FESTIVALS) {
    const shapes = motifFor(f.key).shapes;
    const visible = shapes.filter((s) => !reds.has(String(s.color).toLowerCase()) && (s.a === undefined || s.a >= 0.5));
    assert.ok(visible.length >= 1, `${f.key} 的图案全是节日红底同色，等于没画`);
  }
});

// ---------------------------------------------------------------------------
// ③ 方案 C：用户自己的图
// ---------------------------------------------------------------------------
const DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test('自定义图：给了就用它，并且不再返回形状（免得两套叠着画）', () => {
  const art = festivalArt('zhongqiu', { customArt: { zhongqiu: DATA_URL } });
  assert.equal(art.custom, true);
  assert.equal(art.image, DATA_URL);
  assert.deepEqual(art.shapes, []);
});

test('自定义图：只影响**那一个**节日，别的节日还是矢量', () => {
  const art = festivalArt('duanwu', { customArt: { zhongqiu: DATA_URL } });
  assert.equal(art.custom, false);
  assert.ok(art.shapes.length > 0);
  assert.equal(art.id, 'zongzi');
});

test('自定义图：空值/坏值（不是 data:image）一律回退到矢量，不许画出白框', () => {
  for (const bad of [{ zhongqiu: '' }, { zhongqiu: 'https://example.com/a.jpg' }, { zhongqiu: 123 }, { zhongqiu: null }]) {
    const art = festivalArt('zhongqiu', { customArt: bad });
    assert.equal(art.custom, false, JSON.stringify(bad));
    assert.ok(art.shapes.length > 0);
  }
  // customArt 整个是 null / undefined 也要能跑
  assert.equal(festivalArt('zhongqiu', { customArt: null }).custom, false);
  assert.equal(festivalArt('zhongqiu').custom, false);
});

test('自定义图：压缩尺寸是 256（两张图存进去也就 ~40KB，不会撑爆 db.json）', () => {
  assert.equal(CUSTOM_ART_MAX, 256);
  assert.equal(customArtSize(), 256);
});

// ---------------------------------------------------------------------------
// ④ 接线：图案真的被画上去了吗（只做 core 的话，界面上什么都不会变）
// ---------------------------------------------------------------------------
test('接线：web/ui/views/bubble.js 里确实引了图案并画在泡体之后', () => {
  const src = readFileSync(join(ROOT, 'web/ui/views/bubble.js'), 'utf8');
  assert.match(src, /import \{ festivalArt \} from '\.\.\/\.\.\/\.\.\/core\/festival-art\.js'/, '没有引入图案模块');
  // ⚠️ 这里以前钉的是**逐字的调用串** `drawFestivalArt(ctx2d, b, r, festKey, customArt, alpha)`，
  //    于是 2026-09-27 那次重构（把每颗泡泡的绘制搬进 paintBubble、半径从 `r` 换成
  //    已经兜过底的 `v.r`）会让这条**接线测试**误报"没有把图案画到泡泡上"。
  //    它想守的其实是"**图案被画上去了、而且画在文字下面**"，不是某个变量叫什么名字。
  //    所以改成钉"调用形状 + 有没有传 festivalKey/customArt"，重构不会再误伤。
  const call = /drawFestivalArt\(ctx2d, b, v?\.?r, festKey, customArt, alpha\)/.exec(src);
  assert.ok(call, '没有把图案画到泡泡上');
  // 必须画在文字下面：图案要在"开始画文字"（`if (r >= 18)`）那一段之前
  const textStart = src.indexOf('if (r >= 18) {');
  assert.ok(textStart > 0, '没找到文字绘制那一段');
  assert.ok(call.index < textStart, '图案画到文字上面去了，会把"还剩几天"盖住');
  assert.match(src, /b\.item\.event\.festivalKey/, '没判断是不是节日泡泡');
});

test('接线：设置的入口在（下拉选节日 + 选图 + 恢复矢量）', () => {
  const src = readFileSync(join(ROOT, 'web/ui/views/bubble.js'), 'utf8');
  assert.match(src, /function festivalArtBlock/, '没有设置块');
  assert.match(src, /festivalArtBlock\(state, rerender\)/, '设置块没被挂到面板里');
  assert.match(src, /store\.saveSettings\(\{ festivalArt: \{ \.\.\.saved, \[artPicked\]: dataUrl \} \}\)/, '没把图存进设置');
  assert.match(src, /type: 'file'/, '没有选文件的入口');
  assert.match(src, /toDataURL\('image\/jpeg'/, '存之前没压缩');
});

test('接线：设置是逐字段合并的，换 B 节日的图不能把 A 节日的图冲掉', () => {
  const src = readFileSync(join(ROOT, 'web/ui/views/bubble.js'), 'utf8');
  // 存的必须是"老图 + 新图"的合体，不能只发一个新 key
  assert.match(src, /festivalArt: \{ \.\.\.saved, \[artPicked\]: dataUrl \}/);
  assert.match(src, /const next = \{ \.\.\.saved \};/, '恢复矢量时没复制老图，会把别人的图一起清掉');
});

// ---------------------------------------------------------------------------
// ⑤ 辨认度：这些是**实拍图上真出过的问题**（用户一眼分不出来 / 根本看不见）。
//    ⚠️ 这几条只加不减：原来的断言全部保留，这里补的是"改完不许退回去"。
// ---------------------------------------------------------------------------
test('辨认：五个"黄星"节日（劳动/青年/建党/建军/国庆）现在各用各的图案', () => {
  const keys = ['laodong', 'qingnian', 'dang', 'jianjun', 'guoqing'];
  const ids = keys.map((k) => festivalArt(k).id);
  assert.equal(new Set(ids).size, ids.length,
    `这五个节日还共用图案：${keys.map((k, i) => `${k}=${ids[i]}`).join('、')}`);
  const labels = keys.map((k) => festivalArt(k).label);
  assert.equal(new Set(labels).size, labels.length, `图案名还重复：${labels.join('、')}`);
});

test('辨认：元旦和冬至不再共用一张（原来两个都是 snowflake）', () => {
  assert.notEqual(festivalArt('yuandan').id, festivalArt('dongzhi').id,
    '元旦/冬至又变回同一张图了');
});

test('辨认：龙抬头 / 中元节 / 植树节 三张"绿色植物"里只剩植树节是树苗', () => {
  const ids = ['longtaitou', 'zhongyuan', 'zhishu'].map((k) => festivalArt(k).id);
  assert.equal(new Set(ids).size, 3, `这三个节日又共用图案了：${ids.join('、')}`);
  assert.equal(festivalArt('zhishu').id, 'sprout', '植树节应该留着树苗');
});

test('辨认：春节的鞭炮在节日红底上看得见（主图案不许是红本身）', () => {
  // 第 46 轮那版鞭炮整根是 `RED`，画在红泡泡上等于没画 —— 这里要求**过半图元**都不是节日红
  const reds = new Set([FESTIVAL_COLORS.fill.toLowerCase(), FESTIVAL_COLORS.fillDark.toLowerCase()]);
  const shapes = motifFor('chunjie').shapes;
  const notRed = shapes.filter((s) => !reds.has(String(s.color).toLowerCase()));
  assert.ok(notRed.length * 2 >= shapes.length,
    `春节的图案 ${shapes.length} 个图元里只有 ${notRed.length} 个不是节日红`);
});

test('辨认：共用图案的只剩"有意为之"的两组（除夕+元宵的灯笼、妇女节+母亲节的花）', () => {
  const byId = new Map();
  for (const f of FESTIVALS) {
    const id = festivalArt(f.key).id;
    byId.set(id, (byId.get(id) || []).concat(f.key));
  }
  const shared = [...byId.entries()]
    .filter(([, ks]) => ks.length > 1)
    .map(([id, ks]) => `${id}:${ks.join('+')}`)
    .sort();
  assert.deepEqual(shared, ['flower:funv+muqin', 'lantern:chuxi+yuanxiao'],
    `共用关系变了（要么是漏改了，要么是新的重复图案）：${shared.join('、')}`);
});
