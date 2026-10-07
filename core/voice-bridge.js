// 语音桥：让 **Siri 原生**就能读/写我们的日程 —— 走系统「提醒事项」（EventKit）。
//
// ⚠️⚠️ 为什么换到这条路（前面那条"写文件 + 快捷指令"被放弃了）：
//   文件桥技术上通了，但**用户侧的摩擦太大**：
//     要建快捷指令、要选对动作、要按类型过滤、要关掉"运行时显示"……
//     实测踩到：`public.plain-text` **同时匹配 .txt 和 .json**，
//     于是 Siri 把两份文件的内容**连起来念**（文本后面跟一坨 JSON）。
//   而「提醒事项」是**苹果原生支持 Siri 的**：
//     · 念：「嘿 Siri，日程表里有什么」
//     · 加：「嘿 Siri，在日程表里加：明天下午3点开会」
//   **一个快捷指令都不用建**，也就没有动作名/显示设置/类型过滤这一堆坑。
//
// ⚠️ 为什么这个模块在 core/（而不是壳里）：
//   "哪些日程要写出去""用户加的那条该怎么变成事件"都是**业务**，
//   按项目分工必须由网页层算好，壳只翻译成 EventKit 调用（见 Swift 侧注释）。
//   而且放 core 就能在 Node 里直接测 —— 不需要真机、不需要权限。
//
// ⚠️⚠️ 一个清单同时服务两个方向，靠**标记**区分（这是本模块的核心设计）：
//   · 我们写进去的镜像  → notes 里带 `MIRROR_MARK`，每次同步时**整批替换**
//   · 用户语音加的      → notes 里没有标记，我们**读回来变成真日程**，然后打上 `IMPORTED_MARK`
//   为什么不用两个清单：用户得记住"加日程要说到哪个清单"，
//   而他想说的就一个词——"日程表"。一个清单、内部靠标记分，用户侧最省事。

import { expandRange } from './recurrence.js';
import { addDays, startOfDay, toLocalStamp, toDateKey, pad } from './time.js';
import { parseNatural } from './nl-parse.js';

/** 专用清单的名字。⚠️ 用户会**用嘴说**这个名字，别改成不好念的。 */
export const VOICE_LIST_NAME = '日程表';

/** 我们写进去的镜像条目的标记（放在 notes 里） */
export const MIRROR_MARK = '[tt:mirror]';
/** 已经从语音条目变成真日程的标记 —— 防止同一条被反复导入 */
export const IMPORTED_MARK = '[tt:imported]';

/** 默认往后看几天 */
export const DEFAULT_VOICE_DAYS = 7;
/** 语音条目只给了开始时间时，默认持续多久 */
const DEFAULT_MINUTES = 60;

/**
 * 组装要写进「提醒事项」的镜像。
 *
 * ⚠️ **故意不给提醒设闹铃**（只给"到期时间"）。原因：
 *   这条路的目的是"让 Siri 能念"，不是"多一条提醒通道"。
 *   如果给每条都设闹铃，用户会在同一时刻收到**两条**提醒
 *   （我们 App 一条、提醒事项一条）—— 那会让人直接把整个功能关掉。
 *   （"想多一条不依赖 App 存活的提醒"是另一件事，以后做成单独的开关。）
 *
 * @returns {Array<{key:string,title:string,due:string,notes:string}>} due 是本地时间戳
 */
export function buildVoiceMirror(events, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const days = Number(opts.days) > 0 ? Number(opts.days) : DEFAULT_VOICE_DAYS;
  const from = startOfDay(now);
  const to = addDays(from, days);
  // ⚠️ 必须展开重复日程（课表里的课就是重复的）—— 只列 events 的话
  //    "明天有什么"会把整门课当成一条，念出来毫无意义。
  const items = expandRange(
    (events || []).filter((e) => e && !e.done),
    from, to, opts.termStart || '',
  ).sort((a, b) => a.start - b.start);

  return items.map((it) => ({
    // key 用"事件 id + 这一次的开始时刻"，稳定且能区分同一门课的多次
    key: it.event.id + '@' + toLocalStamp(it.start),
    title: it.event.title || '(无标题)',
    due: toLocalStamp(it.start),
    notes: MIRROR_MARK + (it.event.location ? ' ' + it.event.location : ''),
  }));
}

/** 本地时间戳（`YYYY-MM-DDTHH:MM:SS`）→ 「今天 09:00」这种好念的说法 */
function humanDue(dueStr) {
  if (!dueStr) return '';
  const d = new Date(dueStr.length === 10 ? dueStr + 'T00:00:00' : dueStr);
  if (Number.isNaN(d.getTime())) return '';
  return toDateKey(d).slice(5) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/**
 * 把「提醒事项」里**用户自己加的**条目变成日程草稿。
 *
 * ⚠️ 两级解析，别只做一级：
 *   ① 系统通常已经把"明天下午3点"解析成**到期时间**了（Siri 和提醒事项 App 都会）
 *      → 那就直接用标题 + 到期时间，**不要**再去解析标题（会画蛇添足）
 *   ② 没有到期时间时，才用**我们自己的离线解析器**（core/nl-parse.js）兜底 ——
 *      这样"开会 提前20分钟"这种说法也能被拆出标题/提前量
 *
 * @returns {Array<{key,title,start,end,location,reminders,source}>}
 */
export function voiceItemsToEvents(reminders, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const out = [];
  for (const r of reminders || []) {
    if (!r) continue;
    const notes = String(r.notes || '');
    // 我们自己写的镜像、以及已经导入过的，都不再处理
    if (notes.includes(MIRROR_MARK) || notes.includes(IMPORTED_MARK)) continue;
    const title = String(r.title || '').trim();
    if (!title) continue;

    if (r.due) {
      const start = new Date(r.due.length === 10 ? r.due + 'T09:00:00' : r.due);
      if (Number.isNaN(start.getTime())) continue;
      const end = new Date(start.getTime() + DEFAULT_MINUTES * 60_000);
      out.push({
        key: r.key || title,
        title,
        start: toLocalStamp(start),
        end: toLocalStamp(end),
        // 地点：用户写在标题里的话我们**不动**（有到期时间就说明系统已解析过，别乱猜）
        location: '',
        reminders: [],
        source: 'due',
        human: humanDue(r.due),
      });
      continue;
    }

    const parsed = parseNatural(title, { now });
    if (!parsed.ok) continue;      // 连标题都拆不出来 → 不是日程，别硬塞
    out.push({
      key: r.key || title,
      title: parsed.draft.title,
      start: parsed.draft.start,
      end: parsed.draft.end,
      location: parsed.draft.location,
      reminders: parsed.draft.reminders,
      source: 'text',
      human: humanDue(parsed.draft.start),
    });
  }
  return out;
}
