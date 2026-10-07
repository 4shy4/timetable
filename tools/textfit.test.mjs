// 文本折行的单测。
//
// 为什么值得单测：这段逻辑出错很隐蔽。逐字断行会把拉丁词从中间劈开 ——
// 真机上 "CHILD-AMBER" 被折成 "CHILD-AM" / "BER"，像乱码但不报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, wrapTextToFit, hasWordSplit, ellipsize, setFitFont } from '../web/ui/textfit.js';

/**
 * `wrapText` 会在返回的数组上挂一个 `truncated` 元信息（给 wrapTextToFit 用），
 * 这让 deepEqual 比较时多出一个属性。测试里统一剥成纯数组再比。
 */
const plain = (arr) => Array.from(arr);

/**
 * 假的 canvas 上下文：**宽度随字号缩放**（真实字体就是这样，不缩的话
 * "缩小字号"这个策略在测试里永远无效）。
 * 基准：字号 14 时，ASCII 字符宽 10px，CJK 每字 20px。
 */
function fakeCtx(charWidthAt14 = 10) {
  let font = '';
  let size = 14;
  const widthOf = (c) => (c.charCodeAt(0) > 0x2e80 ? charWidthAt14 * 2 : charWidthAt14);
  return {
    get font() { return font; },
    set font(v) {
      font = v;
      const m = /(\d+(?:\.\d+)?)px/.exec(v);
      if (m) size = Number(m[1]);
    },
    measureText(s) {
      const chars = [...String(s)];
      const base = chars.reduce((sum, c) => sum + widthOf(c), 0);
      return { width: base * (size / 14) };
    },
  };
}

test('setFitFont 设了带字号的字体', () => {
  const ctx = fakeCtx();
  setFitFont(ctx, 14);
  assert.match(ctx.font, /14px/);
});

test('拉丁词不从中间劈开（回归：CHILD-AMBER 曾被折成 CHILD-AM / BER）', () => {
  const ctx = fakeCtx(10);
  // 宽度只够放 6 个字符 → "CHILD-" 是 6 个，"AMBER" 放不下
  const lines = wrapText(ctx, 'CHILD-AMBER', 60, 14, 3);
  assert.deepEqual(plain(lines), ['CHILD-', 'AMBER'], `实际折成 ${JSON.stringify(lines)}`);
  // 任何一行都不该以"半个词"结尾再接下一行的另一半
  for (const l of lines) {
    assert.doesNotMatch(l, /AM$/, '不该在词中间断开');
  }
});

test('中文逐字断行（中文没有词边界，这样才对）', () => {
  const ctx = fakeCtx(10);
  // 中文每字 20px，宽度 60 → 每行 3 个字
  const lines = wrapText(ctx, '交实验报告', 60, 14, 3);
  assert.deepEqual(plain(lines), ['交实验', '报告']);
});

test('中英混排：中文照断，英文整体挪', () => {
  const ctx = fakeCtx(10);
  const lines = wrapText(ctx, '写 Linux 驱动', 60, 14, 4);
  // "写 " 是 2 字符 20px，"Linux" 50px → 20+50=70 > 60，所以 Linux 整块挪到第二行
  assert.equal(lines[0], '写 ');
  assert.ok(lines[1].startsWith('Linux'), `第二行应当以 Linux 开头，实际 ${JSON.stringify(lines)}`);
});

test('超过行数上限时末行加省略号', () => {
  const ctx = fakeCtx(10);
  const lines = wrapText(ctx, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 50, 14, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('…'), `末行应当有省略号：${JSON.stringify(lines)}`);
});

test('刚好放得下时不加省略号', () => {
  const ctx = fakeCtx(10);
  const lines = wrapText(ctx, 'abc', 100, 14, 3);
  assert.deepEqual(plain(lines), ['abc']);
});

test('不能因为"整行是一个超长词"就死循环', () => {
  const ctx = fakeCtx(10);
  const long = 'supercalifragilisticexpialidocious';
  const lines = wrapText(ctx, long, 30, 14, 3);   // 宽度只够 3 个字符
  assert.ok(lines.length <= 3, '行数不能超过上限');
  assert.ok(lines.length >= 1);
  assert.ok(lines.every((l) => typeof l === 'string' && l.length > 0), '不能出现空行');
});

test('空标题返回空数组（调用方会跳过绘制）', () => {
  const ctx = fakeCtx(10);
  assert.deepEqual(plain(wrapText(ctx, '', 50, 14, 2)), []);
  assert.deepEqual(plain(wrapText(ctx, null, 50, 14, 2)), []);
});

test('ellipsize 截到放得下为止', () => {
  const ctx = fakeCtx(10);
  assert.equal(ellipsize(ctx, 'abcdefgh', 100), 'abcdefgh', '放得下就原样');
  const cut = ellipsize(ctx, 'abcdefgh', 50);
  assert.ok(cut.endsWith('…'));
  assert.ok(ctx.measureText(cut).width <= 50, `截完还得放得下：${cut}`);
});

test('hasWordSplit 能看出"词被劈开"', () => {
  assert.equal(hasWordSplit(['CHILD-AM', 'BER']), true, 'AM|BER 是劈开的');
  assert.equal(hasWordSplit(['CHILD-', 'AMBER']), false, '在连字符后断开是可以的');
  assert.equal(hasWordSplit(['写 ', 'Linux']), false, '空格后断开正常');
  assert.equal(hasWordSplit(['交实验', '报告']), false, '中文逐字断行不算劈词');
  assert.equal(hasWordSplit(['abc']), false);
});

test('wrapTextToFit：连字符处正常断开，不需要缩字号（回归：CHILD-AM / BER）', () => {
  const ctx = fakeCtx(10);
  // 宽度 84 放不下整个 "CHILD-AMBER"（110px），但 "CHILD-" 正好能独占一行。
  // 正确结果是在连字符后断开，而不是硬断成 CHILD-AM / BER。
  const lines = wrapText(ctx, 'CHILD-AMBER', 84, 14, 2);
  assert.deepEqual(plain(lines), ['CHILD-', 'AMBER'], `实际 ${JSON.stringify(lines)}`);
  assert.equal(hasWordSplit(lines), false, '这不是"劈词"：连字符后断行是合法的');

  // 因为本来就不劈词，所以不该触发缩字号
  const fitted = wrapTextToFit(ctx, 'CHILD-AMBER', 84, 14, 2);
  assert.equal(fitted.fontSize, 14, '连字符可断 → 不用缩字号');
  assert.deepEqual(plain(fitted.lines), ['CHILD-', 'AMBER']);
});

test('wrapTextToFit：没有断点的词靠缩字号塞进一行', () => {
  const ctx = fakeCtx(10);
  // "Refactoris"（10 字符）没有可断字符：
  //   字号 14 → 100px（超 84）；12.32 → 88px（还超）；10.84 → 77px ✓
  // 所以应当缩到 ~10.8 就成功，而不是一路缩到下限。
  const word = 'Refactoris';
  const fitted = wrapTextToFit(ctx, word, 84, 14, 2);
  assert.equal(hasWordSplit(fitted.lines), false, `缩完不该劈词：${JSON.stringify(fitted)}`);
  assert.ok(fitted.fontSize < 14, `应当缩了字号（实际 ${fitted.fontSize}）`);
  assert.ok(fitted.fontSize > 8, `不该白缩到下限（实际 ${fitted.fontSize}）`);
  assert.equal(fitted.lines.length, 1, '应当整体放进一行');
  assert.ok(ctx.measureText(fitted.lines[0]).width <= 84, '放得下');
});

test('wrapTextToFit：缩到下限也放不下时接受硬断（不缩到看不见、不死循环）', () => {
  const ctx = fakeCtx(10);
  // "Refactorisation"（15 字符）在 8px 下限时仍要 85.7px > 84px —— 怎么都塞不进一行
  const fitted = wrapTextToFit(ctx, 'Refactorisation', 84, 14, 2, 8);
  assert.equal(fitted.fontSize, 8, '一直缩到下限');
  assert.ok(fitted.lines.length >= 1 && fitted.lines.length <= 2);
  assert.ok(fitted.lines.join('').length > 0, '不能返回空');
});

test('wrapTextToFit：词长到缩到最小也放不下时，接受硬断而不是死循环', () => {
  const ctx = fakeCtx(10);
  const fitted = wrapTextToFit(ctx, 'supercalifragilisticexpialidocious', 30, 14, 2, 9);
  assert.ok(fitted.lines.length >= 1 && fitted.lines.length <= 2);
  assert.equal(fitted.fontSize, 9, '一直缩到下限');
  assert.ok(fitted.lines.join('').length > 0);
});

test('wrapTextToFit：中文不会被缩字号（本来就不劈词）', () => {
  const ctx = fakeCtx(10);
  const fitted = wrapTextToFit(ctx, '交实验报告', 60, 14, 3);
  assert.equal(fitted.fontSize, 14, '中文逐字断行，不该缩字号');
  assert.deepEqual(plain(fitted.lines), ['交实验', '报告']);
});

test('日期里的连字符也是断点，碎片不会超出宽度', () => {
  const ctx = fakeCtx(10);
  // 连字符现在是断点，所以 "2026-09-19" 允许切成 ["2026-","09-","19"]。
  // 这不是"劈词"——日期本来就习惯在连字符处折行。
  const lines = wrapText(ctx, '2026-09-19 ABC', 130, 14, 3);
  assert.equal(lines.join(''), '2026-09-19 ABC', '不能丢字符');
  for (const l of lines) {
    assert.ok(ctx.measureText(l).width <= 130, `"${l}" 超宽了`);
  }
  assert.equal(hasWordSplit(lines), false, `不该硬劈：${JSON.stringify(lines)}`);
});

test('连字符是断点，所以日期会按 "-" 分段折行', () => {
  const ctx = fakeCtx(10);
  // 宽度 60 只够 6 字符；"2026-09-19" 能切成 ["2026-","09-","19"]
  const lines = wrapText(ctx, '2026-09-19 ABC', 60, 14, 3);
  assert.equal(lines.join(''), '2026-09-19 ABC', '不能丢字符');
  // 每行都不超宽
  for (const l of lines) {
    assert.ok(ctx.measureText(l).width <= 60, `"${l}" 超宽了`);
  }
  // 断点都在连字符/空格之后，不存在"半个词"被硬劈
  assert.equal(hasWordSplit(lines), false, `不该硬劈：${JSON.stringify(lines)}`);
});
