// 把"未来几天有什么"做成**机器可读 + 人能念**的两份东西，交给原生壳写成文件。
//
// ⚠️⚠️ 为什么要有这个文件（这是"语音助手"这条路的关键一步）：
//   用户想要的是"一个懂这款软件、能语音互动的助手"。
//   而**原生 Siri 集成（App Intents）走不通** —— 它需要
//   `com.apple.developer.siri` 这个 entitlement，免费 Apple ID 拿不到，
//   而且侧载缺它会让 App **一启动就崩**（见 transcripts/0015 的那次调研）。
//
//   能走通的是**快捷指令 + 一个文件**：
//     · 说进去：快捷指令「听写文本」→ 打开 `timetable://add?text=…`（已实现）
//     · **念出来：App 把计划写成一个文件 → 快捷指令「获取文件」读到 → Siri 念**
//   第二条就是本模块存在的理由。**文件是 Siri 唯一能读到我们数据的通道**，
//   因为没有任何 entitlement 能让 Siri 直接问我们的 App。
//
// ⚠️ 为什么放在 core/（而不是壳里）：
//   1. "未来几天有什么"是**业务**（要展开重复课程、要排序、要排版），
//      按本项目的分工必须由网页层算好，壳只翻译（见 NotificationScheduler.swift 顶部）。
//   2. 放 core 就能在 Node 里直接测（三端同一套），不需要真机。
//
// ⚠️ 为什么同时产出 JSON 和纯文本：
//   · JSON 给快捷指令做分支/判断用（「获取文件」+「从输入获取词典」）
//   · **纯文本给 Siri 直接念** —— 念的时候不需要它理解结构，只要顺口
//   两者都由这里生成，避免"能念的和能判断的两份内容对不上"。

import { expandRange } from './recurrence.js';
import { addDays, friendlyDay, hhmm, startOfDay, toDateKey } from './time.js';

/** 一周七天的中文（只用来做表头，不用来算日期） */
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 生成"未来 N 天"的两份表示。
 *
 * @param {Array} events 全部事件（含重复课程）
 * @param {object} [opts]
 * @param {Date}   [opts.now]
 * @param {number} [opts.days]      往后看几天（默认 7）
 * @param {string} [opts.termStart] 学期开始日（展开"第几周"的课要用）
 * @returns {{json: object, text: string, count: number}}
 */
export function buildSharePlan(events, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const days = Number(opts.days) > 0 ? Number(opts.days) : 7;
  const termStart = opts.termStart || '';

  const from = startOfDay(now);
  const to = addDays(from, days);

  // ⚠️ 用 expandRange 而不是遍历 events：**重复课程必须展开成一个个具体实例**，
  //    否则"明天有什么"会把整门课当成一条，念出来毫无意义。
  //    和提醒计划（core/notify-plan.js）用的是同一个展开函数 —— 三端同一个真相。
  const items = expandRange(
    (events || []).filter((e) => e && !e.done),
    from, to, termStart,
  ).sort((a, b) => a.start - b.start);

  const flat = items.map((it) => ({
    title: it.event.title || '(无标题)',
    day: toDateKey(it.start),
    start: hhmm(it.start),
    end: it.event.end ? hhmm(new Date(it.event.end)) : '',
    location: it.event.location || '',
    level: it.event.level || '',
  }));

  // ---- 人念的文本 ----
  const lines = [];
  lines.push('日程表 · 未来 ' + days + ' 天');
  lines.push('');
  let cursor = null;
  let n = 0;
  for (const it of items) {
    const key = toDateKey(it.start);
    if (key !== cursor) {
      cursor = key;
      // 空行分隔每天，Siri 念起来有停顿
      if (n) lines.push('');
      // ⚠️⚠️ 这里有个**只有看真实输出才会发现**的坑：
      //    `friendlyDay` 对前三天返回"今天/明天/后天"，而**更远的直接返回"周一"这种**。
      //    第一版无脑再拼一个"周X"，于是从第 4 天开始变成「**周一 周一**」——
      //    用户拿自己的 62 条真实数据导出时一眼就看见了。
      //    所以按它返回的是不是相对说法来决定补什么：
      //      相对说法（今天/明天/后天）→ 补"周X"（"今天 周四"）
      //      已经是"周X"            → 换成日期（"09-28 周一"），比重复一遍有用
      const fd = friendlyDay(it.start, now);
      const week = WEEKDAY_CN[it.start.getDay()];
      const head = /^[今明后]天$/.test(fd)
        ? fd + ' ' + week
        : toDateKey(it.start).slice(5) + ' ' + week;
      lines.push('【' + head + '】');
    }
    const time = it.event.end
      ? hhmm(it.start) + '-' + hhmm(new Date(it.event.end))
      : hhmm(it.start);
    lines.push('  ' + time + '  ' + (it.event.title || '(无标题)')
      + (it.event.location ? '（' + it.event.location + '）' : ''));
    n += 1;
  }
  if (!n) lines.push('（这几天没有安排）');

  return {
    // ⚠️ generatedAt 用 UTC ISO —— 和提醒计划里 fireAt 的约定一致，
    //    免得将来两边对时间格式的假设分叉。
    json: {
      generatedAt: now.toISOString(),
      days,
      from: toDateKey(from),
      to: toDateKey(to),
      count: flat.length,
      events: flat,
    },
    text: lines.join('\n') + '\n',
    count: flat.length,
  };
}
