// 中文自由文本 → 日程草稿（**完全离线**，零依赖，属于 core/ 所以三端共用）。
//
// 为什么要有它（而不是直接上大模型）：
//   用户想要"用嘴加日程"。上云调大模型是可行的，但那是**另一条路**（要网络、
//   要把日程发给第三方）。而日程这件事的说法其实很集中：
//       "明天下午3点 图书馆 交作业 提前20分钟"
//       "下周三 9:00 组会"
//       "3月5号 晚上7点半 看电影"
//   这些**用规则就能稳定解析**，而且离线、确定性、可测试、可调试 ——
//   符合本项目"本地优先 + 零依赖"的一贯取向。规则覆盖不到的怪句子，
//   再考虑可选地交给云端 AI 兜底（那是另一个模块，不在本文件里）。
//
// ⚠️⚠️ 本模块的定位是"**帮用户少打字**"，不是"替用户做决定"：
//   所以它必须**把解析结果和判断依据一起交出去**（draft + matched + warnings），
//   由界面显示成**可编辑的预览**，用户确认后才落库。
//   不要设计成"解析完直接存" —— 规则解析一定会有猜错的时候（比如
//   "在家写作业"里的"家"到底是地点还是标题的一部分），
//   让用户一眼看到并改掉，比追求 100% 准确率现实得多。
//
// ⚠️ 时间一律按**设备本地时区**解释，输出用 core/time.js 的 toLocalStamp
//   那种格式（`YYYY-MM-DDTHH:MM:00`），和项目里其他地方保持一致。

import { addDays, mondayOf, pad, startOfDay, toDateKey } from './time.js';

// ---------------------------------------------------------------------------
// 中文数字（时间/时长里都会出现，单独抽出来）
// ---------------------------------------------------------------------------

const CN_DIGIT = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 数字片段正则：阿拉伯数字 **或** 中文数字 */
const NUM = '(?:\\d+|[零〇一二两三四五六七八九十]+)';

/**
 * 把数字片段转成整数。认不出来返回 NaN（**不抛异常** ——
 * 调用方靠 NaN 判断"这个片段不是数字"，而不是用 try/catch 控流程）。
 */
export function cnToNum(s) {
  if (s === undefined || s === null) return NaN;
  const t = String(s).trim();
  if (!t) return NaN;
  if (/^\d+$/.test(t)) return Number(t);
  // ⚠️ 顺序有讲究：先处理"十"开头的（十一、十二），再处理"X十Y"（二十三）。
  //    反过来的话"十一"会被"X十Y"的分支误判成 1*10+1=11 —— 恰好也对，
  //    但"十二"会被误判成 1*10+2=12……同样对。真正会错的是"十"单独出现
  //    和"二十"，所以按长度和形状分开处理更不容易出错。
  if (t === '十') return 10;
  let m = t.match(/^十([零〇一二两三四五六七八九])$/);
  if (m) return 10 + CN_DIGIT[m[1]];
  m = t.match(/^([一二两三四五六七八九])十([零〇一二两三四五六七八九])?$/);
  if (m) return CN_DIGIT[m[1]] * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
  if (t.length === 1 && t in CN_DIGIT) return CN_DIGIT[t];
  return NaN;
}

// ---------------------------------------------------------------------------
// 片段收集器
//
// 设计要点：**用"标记已消耗的区间"来算标题**，而不是靠正则替换。
//   因为好几条规则会互相抢字符（"3点30分"里的"30"既像分钟又像时长；
//   "提前20分钟"里的"20分钟"绝不能被当成时长）。用区间记账，
//   谁先匹配谁先占，占过的区间后面的规则看不见 —— **顺序即优先级**，
//   而且"标题 = 没被占的部分"这个定义不会因为规则增减而失效。
// ---------------------------------------------------------------------------

function makeSpans(len) {
  const used = new Array(len).fill(false);
  return {
    has(a, b) {
      for (let i = Math.max(0, a); i < Math.min(len, b); i += 1) if (used[i]) return true;
      return false;
    },
    take(a, b) { for (let i = Math.max(0, a); i < Math.min(len, b); i += 1) used[i] = true; },
    /** 没被占过的字符拼起来（标题就是从这儿来的） */
    rest(text) {
      let out = '';
      for (let i = 0; i < text.length; i += 1) out += used[i] ? '\u0000' : text[i];
      return out;
    },
  };
}

/**
 * 在**每一个未被占用的位置**上试匹配，返回第一个命中。
 *
 * ⚠️ 为什么不是"只在开头匹配"（这是我第一版写错的地方）：
 *   中文语序很自由 —— "开会 明天下午3点 提前20分钟" 把时间放在中间是常态。
 *   只在位置 0 匹配的话，这类句子会**一个字段都解析不出来**，
 *   而用户看到的却是"解析失败"，根本想不到是位置问题。
 */
function findFirst(raw, spans, fn) {
  for (let i = 0; i < raw.length; i += 1) {
    if (spans.has(i, i + 1)) continue;
    const m = fn(raw, i);
    if (m && m.from !== undefined && !spans.has(m.from, m.to)) return m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 时长（"1小时" / "半小时" / "一个半小时" / "20分钟"）
// ---------------------------------------------------------------------------

/**
 * 从 `from` 位置开始找时长片段。
 * @returns {{minutes:number, from:number, to:number, text:string}|null}
 */
export function matchDuration(text, from = 0) {
  const tail = text.slice(from);
  // ⚠️ 顺序：**先长后短**。"一个半小时"必须比"半小时"先匹配，
  //    否则会先吃掉"半小时"、剩下"一个"变成噪声。
  const rules = [
    { re: /^(?:一|1)?个半小时/, min: 90 },
    { re: /^半个小时/, min: 30 },
    { re: /^半小时/, min: 30 },
    { re: /^一刻钟/, min: 15 },
    { re: new RegExp('^(' + NUM + ')\\s*个?\\s*小时'), mul: 60 },
    { re: new RegExp('^(' + NUM + ')\\s*个?\\s*钟头'), mul: 60 },
    { re: new RegExp('^(' + NUM + ')\\s*分钟'), mul: 1 },
  ];
  for (const r of rules) {
    const m = tail.match(r.re);
    if (!m) continue;
    const minutes = r.min !== undefined ? r.min : cnToNum(m[1]) * r.mul;
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    return { minutes, from, to: from + m[0].length, text: m[0] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 日期
// ---------------------------------------------------------------------------

/** 周几的中文 → getDay() 的取值（周日 = 0） */
const DOW = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 末: 6 };

/**
 * 某周内某个周几的日期。
 * ⚠️ 用"周一起算"而不是"今天起算"：因为「本周三」的中文语义是
 *   **日历上的这一周**，不是"从今天往后数"。
 */
function weekdayInWeek(targetDow, weekOffset, now) {
  const monday = mondayOf(now);
  const idx = (targetDow + 6) % 7;          // 周一 = 0 … 周日 = 6
  return addDays(monday, weekOffset * 7 + idx);
}

function matchDate(text, from, now) {
  const tail = text.slice(from);
  const today = startOfDay(now);

  // ① 相对日
  //    ⚠️ 长的写在前面："大后天"要在"后天"之前，"今晚"要在"今天"之前
  //       （否则"大后天"会先被"后天"吃成 +2 天）。
  const rel = [
    [/^大后天/, 3], [/^大前天/, -3], [/^后天/, 2],
    [/^明天|^明日/, 1], [/^今天|^今日|^今晚|^今早/, 0], [/^昨天|^昨日/, -1],
  ];
  for (const [re, days] of rel) {
    const m = tail.match(re);
    if (!m) continue;
    return { date: addDays(today, days), from, to: from + m[0].length, text: m[0], note: '' };
  }

  // ② 周几（可带 这/本/下/下下 修饰）
  const w = tail.match(/^(这|本|下下|下)?(?:周|星期|礼拜)([一二三四五六日天末])/);
  if (w) {
    const target = DOW[w[2]];
    const mod = w[1] || '';
    let date;
    let note = '';
    if (mod === '下') date = weekdayInWeek(target, 1, now);
    else if (mod === '下下') date = weekdayInWeek(target, 2, now);
    else if (mod === '这' || mod === '本') {
      date = weekdayInWeek(target, 0, now);
      if (date < today) {
        // ⚠️ 「本周三」而今天已经周四了 —— 用户多半是想说下一个周三。
        //    这里**顺手往后挪一周并明确告知**，而不是给一个已经过期的日期
        //    （那会让日程一存进来就是"已过期"，看起来像 bug）。
        date = weekdayInWeek(target, 1, now);
        note = '「' + w[0] + '」已经过了，按下一个算';
      }
    } else {
      // 裸「周三」= **含今天在内**的下一个周三。
      // 今天就是周三时说"周三" → 今天（符合直觉）。
      date = weekdayInWeek(target, 0, now);
      if (date < today) date = weekdayInWeek(target, 1, now);
    }
    return { date, from, to: from + w[0].length, text: w[0], note, dow: target };
  }

  // ③ 绝对日期：3月5日 / 3月5号
  const cn = tail.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  // ④ 斜杠/短横/点：3/5、3-5、3.5
  //    ⚠️ 这一种**必须**加"左侧边界"判断，否则会把 "买1/2斤" 里的 "1/2"
  //       当成 1 月 2 日。要求它出现在开头或空白/标点之后。
  const prev = from > 0 ? text[from - 1] : '';
  const atBoundary = from === 0 || /[\s,，。、;；:：()（）]/.test(prev);
  const sep = atBoundary ? tail.match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?!\d)/) : null;
  const abs = cn || sep;
  if (abs) {
    const mo = Number(abs[1]);
    const day = Number(abs[2]);
    if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      let year = now.getFullYear();
      let note = '';
      let d = new Date(year, mo - 1, day, 0, 0, 0, 0);
      // ⚠️ 校验真实性：2月30日这种会被 Date **悄悄滚到 3 月**，
      //    不查的话会生成一个用户从没说过的日期。这是最容易漏的一类 bug。
      if (d.getMonth() !== mo - 1 || d.getDate() !== day) {
        return { date: null, from, to: from + abs[0].length, text: abs[0], note: '「' + abs[0] + '」这个日期不存在' };
      }
      // 已经过去的日期 → 按**明年**算（"1月5日"在九月说，显然指明年）
      if (d < today) { year += 1; d = new Date(year, mo - 1, day, 0, 0, 0, 0); note = '已过，按明年算'; }
      return { date: d, from, to: from + abs[0].length, text: abs[0], note };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

/** 时段前缀：决定 12 小时制怎么折算，以及"只写时段没写钟点"时的默认值 */
const PERIOD = [
  { re: /^(凌晨)/, kind: 'am', defHour: 5 },
  { re: /^(早上|早晨|清晨|上午|早)/, kind: 'am', defHour: 8 },
  { re: /^(中午|正午)/, kind: 'noon', defHour: 12 },
  { re: /^(下午|晌午)/, kind: 'pm', defHour: 14 },
  { re: /^(傍晚|晚上|夜里|晚)/, kind: 'pm', defHour: 20 },
];

// 钟点：`3点` / `3点半` / `3点30` / `3点30分` / `15:30` / `3时`
const HOUR_RE = new RegExp(
  '^\\s*(' + NUM + ')\\s*(?:点|时|:)\\s*'
  + '(?:(\\d{1,2})\\s*分?|(' + NUM + ')\\s*分|半|一刻|三刻)?'
);

function matchTime(text, from) {
  const tail = text.slice(from);
  let period = null;
  let cursor = 0;
  for (const p of PERIOD) {
    const m = tail.match(p.re);
    if (m) { period = { ...p, text: m[0] }; cursor = m[0].length; break; }
  }

  const hm = tail.slice(cursor).match(HOUR_RE);
  if (hm) {
    let h = cnToNum(hm[1]);
    let mi = 0;
    const mm = hm[2] !== undefined ? hm[2] : hm[3];
    if (hm[0].includes('半')) mi = 30;
    else if (hm[0].includes('一刻')) mi = 15;
    else if (hm[0].includes('三刻')) mi = 45;
    else if (mm !== undefined && mm !== null && mm !== '') {
      mi = cnToNum(mm);
      if (!Number.isFinite(mi)) mi = 0;
    }
    if (!Number.isFinite(h)) return null;

    // ⚠️ 12 小时制 → 24 小时制。边界情况是经典的坑：
    //   · 下午 3 点   → 15:00（+12）
    //   · 晚上 12 点  → 00:00（**不是** 24:00）—— 所以要归零而不是 +12
    //   · 中午 12 点  → 12:00（不动）
    //   · 凌晨 12 点  → 00:00
    let note = '';
    if (period) {
      if (period.kind === 'pm') {
        if (h === 12) h = 0;
        else if (h < 12) h += 12;
      } else if (period.kind === 'am') {
        if (h === 12) h = 0;
      } else if (period.kind === 'noon') {
        if (h !== 12) note = '「中午' + h + '点」按 12 点算';
        h = 12;
      }
    } else if (h >= 1 && h <= 6) {
      // 裸钟点且落在 1~6 点：中文习惯里"7点看电影"多半是晚上，
      // 但"9点开会"多半是上午 —— **这个猜不准**，所以只对 1~6 点折成下午，
      // 并且**明确告知这是猜的**，让用户在预览里改。
      h += 12;
      note = '没写上/下午，按下午算';
    }
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;

    const to = cursor + hm[0].length;
    return {
      hour: h, minute: mi,
      from, to: from + to,
      text: tail.slice(0, to),
      note,
      periodText: period ? period.text : '',
    };
  }

  // 只写了时段、没写钟点
  if (period) {
    return {
      hour: period.defHour, minute: 0,
      from, to: from + cursor,
      text: tail.slice(0, cursor),
      note: '只写了「' + period.text + '」，按 ' + pad(period.defHour) + ':00 算',
      periodText: period.text,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 提前提醒
// ---------------------------------------------------------------------------

/**
 * "提前20分钟" / "提前一小时" / "提醒我半小时前" / "提前1天"
 *
 * ⚠️ 必须**最先**解析（在时长之前）：否则"提前20分钟"里的"20分钟"会被
 *   当成事件时长，结果是"事件 20 分钟长"而提醒没了 —— 语义完全错，
 *   而且这种错很隐蔽（字段都"有值"，只是值不对）。
 */
function matchLead(text, from) {
  const tail = text.slice(from);

  // "提醒我…前"
  const rm = tail.match(/^提醒我\s*/);
  if (rm) {
    const d = matchDuration(tail, rm[0].length);
    if (d) {
      const after = tail.slice(d.to).match(/^前/);
      const to = d.to + (after ? 1 : 0);
      return { minutes: d.minutes, from, to: from + to, text: tail.slice(0, to) };
    }
    return null;
  }

  const head = tail.match(/^(?:提前|事先|早点)\s*/);
  if (!head) return null;
  const afterHead = head[0].length;

  // "提前1天" —— 天单独认（matchDuration 不管天，因为"时长1天"是另一回事）
  const dayM = tail.slice(afterHead).match(new RegExp('^(' + NUM + ')\\s*(?:天|日)'));
  if (dayM) {
    const n = cnToNum(dayM[1]);
    if (Number.isFinite(n) && n > 0) {
      const to = afterHead + dayM[0].length;
      return { minutes: n * 1440, from, to: from + to, text: tail.slice(0, to) };
    }
  }

  const d = matchDuration(tail, afterHead);
  if (!d) return null;
  return { minutes: d.minutes, from, to: from + d.to, text: tail.slice(0, d.to) };
}

// ---------------------------------------------------------------------------
// 地点
// ---------------------------------------------------------------------------

/**
 * 地点：`@图书馆` 或 `在图书馆`。
 *
 * ⚠️ 这是整个解析器里**最会猜错**的一条，所以规则要写清楚、并且**保守优先**：
 *
 *   ① 先认**常见地点词**（长词优先）：家 / 图书馆 / 教室 / 食堂 / 会议室 …
 *   ② 再认**通用后缀**：…楼 / 馆 / 室 / 厅 / 场 / 园 / 站 / 院 / 中心 / 食堂 …
 *   ③ 最后才是"取到下一个分隔符为止"，而且**必须真有分隔符**才敢取。
 *
 *   为什么第 ③ 步要这么严（这是踩出来的）：
 *     第一版只写了 ③ 那种"惰性匹配到分隔符或串尾"。结果 `在家写作业` 里
 *     没有分隔符，惰性匹配只能一路吃到串尾 → 地点变成"家写作业"、标题只剩"写"。
 *     `作业在图书馆交` 同理变成"图书馆交"。
 *     **没有分隔符时，任何"贪一点"的规则都会吞掉标题** —— 所以那种情况下
 *     宁可**什么都不提取**（整串留在标题里，用户自己看着改），也不要猜。
 *
 *   ⚠️ 还必须排除"现在/正在/所在/存在/实在/不在/还在"这类词里的"在"，
 *     否则「现在开会」会被解析成 地点"开会"、标题"现"，非常离谱。
 */
const NOT_A_MARKER_BEFORE = '现正所存实不还也都在';

/** 常见地点词。⚠️ 顺序无所谓（用之前会按长度降序排），但**必须都是完整词**。 */
const PLACES = [
  '图书馆', '教学楼', '自习室', '会议室', '办公室', '实验室', '体育馆', '游泳馆',
  '健身房', '报告厅', '快递站', '咖啡厅', '电影院', '操场', '食堂', '宿舍', '教室',
  '机房', '礼堂', '医院', '银行', '超市', '公园', '机场', '车站', '餐厅', '药店',
  '澡堂', '广场', '大厦', '公司', '学校', '家里', '家', '门口',
];
// ⚠️ 最长的先试 —— 否则「家里」会被「家」先吃掉，剩下"里"变成标题。
const PLACES_BY_LEN = [...PLACES].sort((a, b) => b.length - a.length);

// 通用后缀：…楼 / …馆 / …室 / …厅 / …场 / …中心 …（前缀 1~8 字，惰性）
const PLACE_SUFFIX = /^([\u4e00-\u9fa5A-Za-z0-9]{1,8}?(?:楼|馆|室|厅|场|园|站|院|中心|食堂|宿舍|餐厅|超市|银行|医院|公园|机场|大厦|广场|大楼|门口))/;

function matchLocation(text, from) {
  const prev = from > 0 ? text[from - 1] : '';
  const tail = text.slice(from);
  const isAt = tail[0] === '@';
  if (!isAt) {
    if (tail[0] !== '在') return null;
    if (prev && NOT_A_MARKER_BEFORE.includes(prev)) return null;
  }

  // "在"/"@" 之后跳过空格；bodyStart = 标记 + 空格 的总长度
  const afterMark = tail.slice(1);
  const spaces = afterMark.match(/^\s*/)[0].length;
  const body = afterMark.slice(spaces);
  const bodyStart = 1 + spaces;

  const hit = (loc) => ({
    location: loc, from, to: from + bodyStart + loc.length,
    text: tail.slice(0, bodyStart + loc.length),
  });

  // ① 常见地点词
  for (const p of PLACES_BY_LEN) {
    if (body.startsWith(p)) return hit(p);
  }
  // ② 通用后缀
  const suf = body.match(PLACE_SUFFIX);
  if (suf && suf[1].length >= 2) return hit(suf[1]);

  // ③ 兜底：**必须真有分隔符**才敢取。
  //    `@` 是用户显式标的，可以取到空白/标点为止；`在` 则必须有分隔符终止
  //    （没有分隔符就整串留在标题里，什么都不猜）。
  const rest = tail.slice(1);
  const m = isAt
    ? rest.match(/^\s*([^\s,，。;；]{1,12})/)
    : rest.match(/^\s*([^\s,，。;；]{1,12}?)(?=[\s,，。;；]|提前|提醒)/);
  if (!m || !m[1].trim()) return null;
  const to = 1 + m[0].length;
  return { location: m[1].trim(), from, to: from + to, text: tail.slice(0, to) };
}

// ---------------------------------------------------------------------------
// 深链协议：timetable://add?text=明天下午3点开会
//
// 为什么这个放在 core/（而不是 iOS 壳里）：
//   它是**各端共用的一种输入方式**，不是 iOS 专属 —— 安卓的桌面快捷方式、
//   电脑端的浏览器书签，都可以用同一个 URL 把一句话丢进来。
//   而"解析 URL"是纯字符串处理，放在 core 里就能被 Node 直接测（三端同一套）。
//
// ⚠️ 不用 `new URL()`：那会引入"协议/主机"的语义（`timetable://add` 里
//   `add` 会被当成**主机名**），而这里要的只是"路径 + 查询串"，
//   手写几行反而更直白、也更少意外。
// ---------------------------------------------------------------------------

/**
 * 从深链里取出要加的那句话。
 * 支持两种形状：
 *   timetable://add?text=<经过百分号编码的话>
 *   timetable://add/<经过百分号编码的话>
 * @returns {{action:string, text:string, quick:boolean}|null} 认不出来返回 null
 */
export function parseDeepLink(rawUrl) {
  const s = String(rawUrl || '').trim();
  const m = s.match(/^timetable:\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?/i);
  if (!m) return null;
  const action = decodeURIComponent(m[1] || '').toLowerCase() || 'add';
  const pathPart = m[2] || '';
  const query = m[3] || '';

  let text = '';
  let quick = false;
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = (eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    let dv = v;
    try { dv = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { /* 编码坏了就用原样 */ }
    // ⚠️ 名字同时认 text 和 t：快捷指令里手打 URL 时，短的少打几个字。
    if (k === 'text' || k === 't') text = dv;
    if (k === 'quick' || k === 'now') quick = dv === '1' || dv === 'true';
  }
  if (!text && pathPart) {
    try { text = decodeURIComponent(pathPart.replace(/\+/g, ' ')); } catch { text = pathPart; }
  }
  if (!text) return null;
  return { action, text: text.trim(), quick };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 解析一句中文，产出**日程草稿**（不落库、不碰状态容器）。
 *
 * @param {string} text 用户输入，例如 "明天下午3点 图书馆 交作业 提前20分钟"
 * @param {object} [opts]
 * @param {Date}   [opts.now]                     以"现在"为基准算相对日期
 * @param {number} [opts.defaultDurationMinutes]  没写时长时用多久（默认 60 分钟）
 * @param {number} [opts.defaultHour]             没写钟点时按几点算（默认 9 点）
 * @returns {{
 *   ok: boolean,
 *   draft: {title:string, start:string, end:string, location:string, reminders:number[]},
 *   matched: object, missing: string[], warnings: string[], text: string
 * }}
 *
 * ⚠️ `ok:false` 只在**没有标题**时出现。日期时间没写/猜错都只给 warning
 *   而不拒绝 —— 因为这是"帮用户少打字"：猜错了让用户在预览里改，
 *   比什么都不给要好。
 */
export function parseNatural(text, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const defaultDuration = Number(opts.defaultDurationMinutes) || 60;
  const defaultHour = Number.isFinite(opts.defaultHour) ? opts.defaultHour : 9;

  const raw = String(text || '');
  const spans = makeSpans(raw.length);
  const warnings = [];
  const missing = [];
  const matched = {};

  // ⚠️ 解析顺序 = 优先级，别随意调换：
  //   ① 提前提醒 —— 含"20分钟"，必须先占掉，否则会被"时长"抢走
  //   ② 时长     —— 含"半小时"，必须在时间之前占掉
  //   ③ 日期 ④ 时间 ⑤ 地点 ⑥ 剩下的就是标题
  const lead = findFirst(raw, spans, (t, i) => matchLead(t, i));
  if (lead) { spans.take(lead.from, lead.to); matched.lead = lead; }

  const duration = findFirst(raw, spans, (t, i) => {
    const d = matchDuration(t, i);
    return d && !spans.has(d.from, d.to) ? d : null;
  });
  if (duration) { spans.take(duration.from, duration.to); matched.duration = duration; }

  const date = findFirst(raw, spans, (t, i) => matchDate(t, i, now));
  if (date) { spans.take(date.from, date.to); matched.date = date; }

  const time = findFirst(raw, spans, (t, i) => matchTime(t, i));
  if (time) { spans.take(time.from, time.to); matched.time = time; }

  const loc = findFirst(raw, spans, (t, i) => matchLocation(t, i));
  if (loc) { spans.take(loc.from, loc.to); matched.location = loc; }

  // ---- 标题 = 没被任何规则占用的部分 ----
  // ⚠️ 被挖掉的位置**直接丢掉**，不补空格。
  //   补空格会在"句子中间被挖掉一块"时留下难看的缝：
  //   「作业在图书馆交」→「作业 交」；直接丢掉才是「作业交」。
  const title = spans.rest(raw)
    .split('\u0000').join('')
    .replace(/[，,、;；:：]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title) missing.push('title');

  // ---- 拼日期 + 时间 ----
  let day = date && date.date ? startOfDay(date.date) : startOfDay(now);
  if (date && date.note) warnings.push(date.note);
  if (!date) missing.push('date');
  if (!time) missing.push('time');

  const hour = time ? time.hour : defaultHour;
  const minute = time ? time.minute : 0;
  if (time && time.note) warnings.push(time.note);
  if (!time) warnings.push('没写时间，按 ' + pad(defaultHour) + ':00 算');

  // ⚠️ 只有**没写日期**时才允许顺延到明天：
  //   写了日期就严格按那天算，哪怕那个时刻已经过去 ——
  //   "今天8点"在十点说，就是过期了，不该偷偷变成明天。
  //
  // ⚠️ 注意这里**不要求写了钟点**（第一版写了 `&& time`，那是个不对称的疏漏）：
  //   「开会」这种连钟点都没写的句子会用默认 9 点，而现在已经是下午 ——
  //   照样落在一个"一存进来就过期"的时刻上。既然要顺延，就该对两种情况一致。
  let rolled = false;
  if (!date) {
    const cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
    if (cand.getTime() < now.getTime()) {
      day = addDays(day, 1);
      warnings.push('这个点今天已经过了，按明天算');
      rolled = true;
    }
  }

  const startDate = new Date(
    day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0,
  );
  const len = duration ? duration.minutes : defaultDuration;
  if (!duration) warnings.push('没写时长，按 ' + len + ' 分钟算');
  const endDate = new Date(startDate.getTime() + len * 60_000);

  const stamp = (d) => toDateKey(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00';

  const reminders = [];
  if (lead) {
    reminders.push(lead.minutes);
    if (lead.minutes > len) {
      // "提前2小时提醒一个1小时的会" —— 提醒会落在**开始前很远**，未必是想要的。
      // 不拒绝，但要说一句（提醒计划那边也真的会排得很早）。
      warnings.push('提前量比事情本身还长，会提前 ' + (lead.minutes / 60).toFixed(1) + ' 小时响');
    }
  }

  return {
    ok: !!title,
    draft: {
      title,
      start: stamp(startDate),
      end: stamp(endDate),
      location: loc ? loc.location : '',
      reminders,
    },
    matched: rolled ? { ...matched, rolledToTomorrow: true } : matched,
    missing,
    warnings,
    text: raw,
  };
}
