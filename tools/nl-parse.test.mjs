import test from 'node:test';
import assert from 'node:assert/strict';

import { parseNatural, parseDeepLink, cnToNum, matchDuration } from '../core/nl-parse.js';

// ---------------------------------------------------------------------------
// 所有用例都钉在同一个"现在"上：**2026-09-24（周四）15:00**。
// ⚠️ 用固定时刻而不是 new Date()，否则周末/月末跑测试会忽红忽绿 ——
//    那种"看日子才过"的测试比没有测试更坏，因为它会训练人忽略红色。
//
// 参考日历（下面写断言时会反复用到）：
//   09-21 周一 · 09-22 周二 · 09-23 周三 · 09-24 周四(今天) · 09-25 周五
//   09-26 周六 · 09-27 周日 · 09-28 下周一 · 09-30 下周三
// ---------------------------------------------------------------------------
const NOW = new Date(2026, 8, 24, 15, 0, 0);
const P = (text, opts) => parseNatural(text, { now: NOW, ...opts });

// ===========================================================================
// 中文数字
// ===========================================================================
test('中文数字：十/十一/二十/二十三 都认得', () => {
  assert.equal(cnToNum('3'), 3);
  assert.equal(cnToNum('十'), 10);
  assert.equal(cnToNum('十一'), 11);
  assert.equal(cnToNum('十二'), 12);
  assert.equal(cnToNum('二十'), 20);
  assert.equal(cnToNum('二十三'), 23);
  assert.equal(cnToNum('两'), 2);
  assert.equal(cnToNum('九'), 9);
});

test('中文数字：认不出来返回 NaN 而不是抛异常', () => {
  // ⚠️ 这一条是设计约定：调用方靠 NaN 判断"这不是数字"，
  //    而不是用 try/catch 控流程。抛异常会让"解析失败"和"程序出错"混在一起。
  assert.ok(Number.isNaN(cnToNum('百')));
  assert.ok(Number.isNaN(cnToNum('')));
  assert.ok(Number.isNaN(cnToNum(null)));
  assert.ok(Number.isNaN(cnToNum('abc')));
});

// ===========================================================================
// 日期
// ===========================================================================
test('相对日：今天/明天/后天/大后天', () => {
  assert.equal(P('今天 10点 开会').draft.start, '2026-09-24T10:00:00');
  assert.equal(P('明天 10点 开会').draft.start, '2026-09-25T10:00:00');
  assert.equal(P('后天 10点 开会').draft.start, '2026-09-26T10:00:00');
  // ⚠️ "大后天"必须比"后天"先匹配，否则会算成 +2 天
  assert.equal(P('大后天 10点 开会').draft.start, '2026-09-27T10:00:00');
});

test('裸「周X」= 含今天在内的下一个该天', () => {
  // 今天周四 → 周五就是明天
  assert.equal(P('周五 10点 开会').draft.start, '2026-09-25T10:00:00');
  // 今天周四 → 本周三(09-23)已过 → 顺延到 09-30
  assert.equal(P('周三 10点 开会').draft.start, '2026-09-30T10:00:00');
  // 周日 = 本周日 09-27
  assert.equal(P('周日 10点 开会').draft.start, '2026-09-27T10:00:00');
  // "周天"这种写法也要认
  assert.equal(P('周天 10点 开会').draft.start, '2026-09-27T10:00:00');
});

test('「下周X」按日历周算（周一起）', () => {
  assert.equal(P('下周五 10点 开会').draft.start, '2026-10-02T10:00:00');
  assert.equal(P('下周一 10点 开会').draft.start, '2026-09-28T10:00:00');
  assert.equal(P('下下周一 10点 开会').draft.start, '2026-10-05T10:00:00');
});

test('「本周X」已过 → 挪到下一个并明确告知（不给一个一存进来就过期的日程）', () => {
  const r = P('本周三 10点 开会');
  assert.equal(r.draft.start, '2026-09-30T10:00:00');
  assert.ok(r.warnings.some((w) => w.includes('已经过了')), '应给出"已经过了"的提示：' + JSON.stringify(r.warnings));
});

test('绝对日期：X月X日 / X月X号', () => {
  assert.equal(P('10月1日 10点 开会').draft.start, '2026-10-01T10:00:00');
  assert.equal(P('11月15号 10点 开会').draft.start, '2026-11-15T10:00:00');
});

test('绝对日期：已经过去的按明年算（"1月5日"在九月说显然指明年）', () => {
  const r = P('3月5日 10点 开会');
  assert.equal(r.draft.start, '2027-03-05T10:00:00');
  assert.ok(r.warnings.some((w) => w.includes('明年')), JSON.stringify(r.warnings));
});

test('绝对日期：斜杠写法', () => {
  assert.equal(P('9/26 10点 开会').draft.start, '2026-09-26T10:00:00');
});

test('⚠️ 斜杠写法必须要求左侧边界，不能把 "买1/2斤" 当成 1月2日', () => {
  const r = P('买1/2斤 苹果');
  assert.equal(r.matched.date, undefined, '不该解析出日期，实际：' + JSON.stringify(r.matched.date));
  // 解析不出日期 → 走默认路径（默认 9:00；现在 15:00 已过 → 顺延明天）。
  // ⚠️ 这里要的不是某个具体日子，而是"**没有从文本里读到日期**"这件事 ——
  //    所以主要断言是上面那条 matched.date，下面这条只是把默认路径钉住。
  assert.equal(r.draft.start, '2026-09-25T09:00:00');
  assert.ok(r.missing.includes('date'), '应报缺少日期');
});

test('⚠️ 不存在的日期要抓出来，不能让它被 Date 悄悄滚到下个月', () => {
  // new Date(2026, 1, 30) 会变成 3月2日 —— 用户从没说过这个日期
  const r = P('2月30日 10点 开会');
  assert.ok(r.warnings.some((w) => w.includes('不存在')), JSON.stringify(r.warnings));
});

// ===========================================================================
// 时间
// ===========================================================================
test('上下午折算：下午3点 → 15:00', () => {
  assert.equal(P('明天下午3点 开会').draft.start, '2026-09-25T15:00:00');
  assert.equal(P('明天上午9点 开会').draft.start, '2026-09-25T09:00:00');
  assert.equal(P('明天下午两点 开会').draft.start, '2026-09-25T14:00:00');
});

test('⚠️ 12 点是最容易错的边界：晚上12点是次日零点，中午12点还是12点', () => {
  // 晚上12点 → 00:00（**不是** 24:00，也不是 12:00）
  assert.equal(P('明天晚上12点 睡觉').draft.start, '2026-09-25T00:00:00');
  assert.equal(P('明天中午12点 吃饭').draft.start, '2026-09-25T12:00:00');
  assert.equal(P('明天凌晨12点 出发').draft.start, '2026-09-25T00:00:00');
  assert.equal(P('明天上午12点 出发').draft.start, '2026-09-25T00:00:00');
});

test('半点/刻/分', () => {
  assert.equal(P('明天上午9点半 开会').draft.start, '2026-09-25T09:30:00');
  assert.equal(P('明天下午3点一刻 开会').draft.start, '2026-09-25T15:15:00');
  assert.equal(P('明天下午3点45分 开会').draft.start, '2026-09-25T15:45:00');
  assert.equal(P('明天15:30 开会').draft.start, '2026-09-25T15:30:00');
  assert.equal(P('明天下午3点30 开会').draft.start, '2026-09-25T15:30:00');
});

test('⚠️ 裸钟点 1~6 点按下午算，并且**必须告知这是猜的**', () => {
  const r = P('明天3点 看电影');
  assert.equal(r.draft.start, '2026-09-25T15:00:00');
  assert.ok(r.warnings.some((w) => w.includes('按下午算')), JSON.stringify(r.warnings));

  // ⚠️ 边界是 **1~6 点**，7 点及以上**不折**。
  //    为什么把线划在 6：1~6 点在学校/上班语境里几乎必然是下午
  //    （"5点下课""6点吃饭"），而 7 点两可（"7点起床"vs"7点看电影"）——
  //    两可的时候宁可给 07:00 也不偷偷改成晚上，反正预览里看得见。
  const r2 = P('明天7点 看电影');
  assert.equal(r2.draft.start, '2026-09-25T07:00:00');

  const r3 = P('明天9点 开会');
  assert.equal(r3.draft.start, '2026-09-25T09:00:00');
  assert.ok(!r3.warnings.some((w) => w.includes('按下午算')), JSON.stringify(r3.warnings));
});

test('只写时段没写钟点：用该时段的默认值，并告知', () => {
  assert.equal(P('明天中午 吃饭').draft.start, '2026-09-25T12:00:00');
  assert.equal(P('明天晚上 吃饭').draft.start, '2026-09-25T20:00:00');
  const r = P('明天中午 吃饭');
  assert.ok(r.warnings.some((w) => w.includes('只写了')), JSON.stringify(r.warnings));
});

test('⚠️ 没写日期时，今天已过去的钟点顺延到明天并告知', () => {
  // 现在 15:00，"8点"已过（且 8 点不折成下午）→ 明天 8:00
  const r = P('8点 开会');
  assert.equal(r.draft.start, '2026-09-25T08:00:00');
  assert.ok(r.warnings.some((w) => w.includes('明天')), JSON.stringify(r.warnings));
});

test('⚠️ 写了日期就不顺延：哪怕那个时刻已经过去', () => {
  // "今天10点"在 15:00 说 → 就是今天 10:00（已过期），不该偷偷变成明天
  const r = P('今天10点 开会');
  assert.equal(r.draft.start, '2026-09-24T10:00:00');
  assert.ok(!r.warnings.some((w) => w.includes('按明天算')), JSON.stringify(r.warnings));
});

// ===========================================================================
// 时长
// ===========================================================================
test('时长：小时/半小时/一个半小时/分钟/一刻钟', () => {
  assert.equal(P('明天下午3点 开会 1小时').draft.end, '2026-09-25T16:00:00');
  assert.equal(P('明天下午3点 开会 半小时').draft.end, '2026-09-25T15:30:00');
  // ⚠️ "一个半小时"必须比"半小时"先匹配，否则会得到 30 分钟 + 残留"一个"
  assert.equal(P('明天下午3点 开会 一个半小时').draft.end, '2026-09-25T16:30:00');
  assert.equal(P('明天下午3点 开会 20分钟').draft.end, '2026-09-25T15:20:00');
  assert.equal(P('明天下午3点 开会 一刻钟').draft.end, '2026-09-25T15:15:00');
  assert.equal(P('明天下午3点 开两小时会').draft.end, '2026-09-25T17:00:00');
});

test('没写时长：默认 60 分钟并告知', () => {
  const r = P('明天下午3点 开会');
  assert.equal(r.draft.end, '2026-09-25T16:00:00');
  assert.ok(r.warnings.some((w) => w.includes('没写时长')), JSON.stringify(r.warnings));
});

// ===========================================================================
// 提前提醒 —— 这是最容易出**隐蔽错误**的一类
// ===========================================================================
test('⚠️「提前20分钟」必须是提醒，不能被当成"事件时长 20 分钟"', () => {
  const r = P('明天下午3点 开会 提前20分钟');
  assert.deepEqual(r.draft.reminders, [20], '提醒应是 20 分钟前');
  // 关键：时长仍是默认 60 分钟，而不是被"20分钟"顶掉
  assert.equal(r.draft.end, '2026-09-25T16:00:00', '事情本身仍应是 1 小时');
  assert.equal(r.draft.title, '开会', '标题不该残留"提前20分钟"');
});

test('提前提醒：小时 / 天 / "提醒我…前" 三种说法', () => {
  assert.deepEqual(P('明天下午3点 开会 提前一小时').draft.reminders, [60]);
  assert.deepEqual(P('明天下午3点 开会 提前1天').draft.reminders, [1440]);
  assert.deepEqual(P('明天下午3点 开会 提醒我半小时前').draft.reminders, [30]);
});

test('提前量比事情本身还长 → 提醒一句（但不拒绝）', () => {
  const r = P('明天下午3点 开会 半小时 提前2小时');
  assert.deepEqual(r.draft.reminders, [120]);
  assert.ok(r.warnings.some((w) => w.includes('比事情本身还长')), JSON.stringify(r.warnings));
});

// ===========================================================================
// 地点
// ===========================================================================
test('地点：在X / @X', () => {
  const a = P('明天下午3点 在图书馆 开会');
  assert.equal(a.draft.location, '图书馆');
  assert.equal(a.draft.title, '开会');

  const b = P('明天下午3点 @图书馆 交作业');
  assert.equal(b.draft.location, '图书馆');
  assert.equal(b.draft.title, '交作业');
});

test('地点：「在家写作业」→ 家 / 写作业', () => {
  const r = P('明天下午3点 在家写作业');
  assert.equal(r.draft.location, '家');
  assert.equal(r.draft.title, '写作业');
});

test('⚠️「现在开会」里的"在"不是地点标记（否则标题会变成"现"）', () => {
  const r = P('现在开会');
  assert.equal(r.draft.location, '', '不该把"开会"当地点');
  assert.ok(r.draft.title.includes('开会'), '标题里要有"开会"，实际：' + r.draft.title);
});

test('地点词表让「作业在图书馆交」也取得对（第一版会取成"图书馆交"）', () => {
  // ⚠️ 这条曾经被我写成"已知不足、故意钉住错误行为"。
  //    后来加了**常见地点词表**，它就成了正确行为 —— 于是断言改成正确的那个。
  const r = P('明天下午3点 作业在图书馆交');
  assert.equal(r.draft.location, '图书馆');
  // 中间被挖掉的字**直接丢掉**（不补空格），否则标题会变成"作业 交"
  assert.equal(r.draft.title, '作业交');
});

test('⚠️ 未知地点 + 没有分隔符 → 什么都不提取（宁可留在标题里，也不吞掉标题）', () => {
  // 这一条是"保守优先"的守门测试：没有分隔符时任何"贪一点"的规则都会吞标题。
  const r = P('明天下午3点 在小张那儿聊聊');
  assert.equal(r.draft.location, '', '不该硬猜地点');
  assert.ok(r.draft.title.includes('聊聊'), '标题应保留原话，实际：' + r.draft.title);
});

// ===========================================================================
// 语序 —— 回归测试：解析规则必须在**任意位置**生效，不只在开头
// ===========================================================================
test('⚠️ 时间和提醒放在句子中间/末尾也要解析出来（只在位置 0 匹配是个真 bug）', () => {
  const r = P('开会 明天下午3点 提前20分钟');
  assert.equal(r.draft.title, '开会');
  assert.equal(r.draft.start, '2026-09-25T15:00:00');
  assert.deepEqual(r.draft.reminders, [20]);
});

// ===========================================================================
// 缺字段与标题
// ===========================================================================
test('没有标题 → ok:false 并报 missing（唯一会被拒绝的情况）', () => {
  const r = P('明天下午3点');
  assert.equal(r.ok, false);
  assert.ok(r.missing.includes('title'));
});

test('没写日期时间 → 仍然 ok，只是给出默认值与 missing', () => {
  const r = P('开会');
  assert.equal(r.ok, true);
  assert.equal(r.draft.title, '开会');
  assert.ok(r.missing.includes('date'));
  assert.ok(r.missing.includes('time'));
  // 默认 9 点；今天 9 点已过 → 顺延明天
  assert.equal(r.draft.start, '2026-09-25T09:00:00');
});

test('完整例句端到端', () => {
  const r = P('下周三下午两点 在图书馆 交作业 提前20分钟 1小时');
  assert.equal(r.ok, true);
  assert.equal(r.draft.title, '交作业');
  assert.equal(r.draft.location, '图书馆');
  assert.equal(r.draft.start, '2026-09-30T14:00:00');
  assert.equal(r.draft.end, '2026-09-30T15:00:00');
  assert.deepEqual(r.draft.reminders, [20]);
  assert.deepEqual(r.warnings, [], '这个句子不该有任何猜测提示，实际：' + JSON.stringify(r.warnings));
});

test('时间戳格式必须和项目其他地方一致（YYYY-MM-DDTHH:MM:00）', () => {
  const r = P('明天下午3点 开会');
  assert.match(r.draft.start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
  assert.match(r.draft.end, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
});

// ===========================================================================
// 深链（timetable://add?text=…）—— 原生壳与网页层之间的契约，必须钉住
//
// ⚠️ 这条协议是给**快捷指令 / Siri** 用的：用户口述 → 快捷指令拼出这个 URL →
//    打开 App → 原生转交给网页层 → 解析。任何一环变了都会"点了没反应"，
//    所以格式必须有测试守着。
// ===========================================================================
test('深链：timetable://add?text=… 能取出那句话（含中文编码）', () => {
  const t = '明天下午3点 在图书馆 交作业';
  const r = parseDeepLink('timetable://add?text=' + encodeURIComponent(t));
  assert.ok(r, '应能解析');
  assert.equal(r.action, 'add');
  assert.equal(r.text, t);
  assert.equal(r.quick, false);
});

test('深链：路径写法与短参数 t= 都认', () => {
  const t = '下周三9点开会';
  assert.equal(parseDeepLink('timetable://add/' + encodeURIComponent(t)).text, t);
  assert.equal(parseDeepLink('timetable://add?t=' + encodeURIComponent(t)).text, t);
});

test('深链：quick=1 能被认出来（给纯语音用；默认必须是 false）', () => {
  assert.equal(parseDeepLink('timetable://add?text=abc&quick=1').quick, true);
  assert.equal(parseDeepLink('timetable://add?text=abc&quick=true').quick, true);
  assert.equal(parseDeepLink('timetable://add?text=abc&quick=0').quick, false);
  assert.equal(parseDeepLink('timetable://add?text=abc').quick, false);
});

test('深链：空/坏输入返回 null，不抛异常', () => {
  // ⚠️ 这个函数是**原生壳调进来的入口**，任何输入都不该让整个 App 崩掉
  assert.equal(parseDeepLink(''), null);
  assert.equal(parseDeepLink(null), null);
  assert.equal(parseDeepLink('https://example.com/add?text=x'), null);
  assert.equal(parseDeepLink('timetable://add'), null, '只给动作不给话 → 认不出来');
  assert.equal(parseDeepLink('timetable://add?text='), null);
});

test('深链：编码坏掉时用原样，而不是整个失败', () => {
  // 用户手打 URL 很容易打出半个百分号（%E6%8）。宁可加一句乱码让用户改，
  // 也好过"点了完全没反应" —— 后者根本不知道哪里错了。
  const r = parseDeepLink('timetable://add?text=%E6%8');
  assert.ok(r, '不应因为编码坏了就整条丢弃');
  assert.ok(r.text.length > 0);
});

// ===========================================================================
// matchDuration 单独测（它是被复用的零件，值得单独钉住）
// ===========================================================================
test('matchDuration 单独可用，且"先长后短"的顺序正确', () => {
  assert.equal(matchDuration('一个半小时', 0).minutes, 90);
  assert.equal(matchDuration('半小时', 0).minutes, 30);
  assert.equal(matchDuration('3小时', 0).minutes, 180);
  assert.equal(matchDuration('45分钟', 0).minutes, 45);
  assert.equal(matchDuration('一刻钟', 0).minutes, 15);
  // "3点30分" 里的 "30分" **不该**被当成时长（需要"分钟"才算）
  assert.equal(matchDuration('3点30分 开会', 0), null);
});
