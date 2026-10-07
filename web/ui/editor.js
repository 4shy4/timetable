// 日程编辑器（新建 / 修改）。所有字段都落到服务端，本地只是镜像。
//
// v0.4 的重点：
//   · **截止时间**有两种填法（用户要求）：
//       ① 确切日期：年 / 月 / 日 / 时 / 分，**无需都填**，缺的按粒度取起点；
//       ② 距离期限：直接填"还剩 3 周"，可勾「模糊剩余时间」。
//   · **颜色 = 事情多大**（四档手选），大小与通知强度都由"还剩多久"自动决定。
import { el, mount } from './dom.js';
import { openModal, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import * as store from '../adapter/store.js';
import { hhmm, pad, toDateKey, asDate, toLocalStamp } from '../../core/time.js';
import { URGENCY_TIERS, tierFill } from '../../core/palette.js';
import {
  LEVELS, levelByKey, rankOf, allowedChildLevels, canNestInside, levelFromLegacyMagnitude,
} from '../../core/level.js';
// levelOf 在 urgency.js（它负责"解析等级"，含旧 magnitude 换算），不在 level.js
import { levelOf } from '../../core/urgency.js';
// 批量生成同质泡泡 / 套用母泡泡参数 —— **规则本体在 core**，这里只画界面
import {
  batchDrafts, applyParentTemplate, describeBatch, unitMinutes, GAP_UNITS,
  BATCH_MAX, PARENT_TEMPLATE_FIELDS, PARENT_TEMPLATE_DEFAULTS,
} from '../../core/event-template.js';
import {
  formatRemaining, formatRemainingInUnit, tickUnitForParts, partsToMs,
  deadlineFromParts as deadlineFromDistance, describeParts,
  DAY_MS, WEEK_MS, MONTH_MS, YEAR_MS,
} from '../../core/countdown.js';
import { notificationPlanForRemaining } from '../../core/level.js';
// 「每几周」的判定与 core/recurrence.js 共用同一个函数，界面和服务端不会分叉
import { recurLevelOf, RECUR_LEVELS } from '../../core/recurrence.js';

export const TYPE_LABEL = {
  course: '课程', task: '任务', exam: '考试',
  activity: '活动', personal: '个人', other: '其他',
};
export const TYPE_KEYS = Object.keys(TYPE_LABEL);

const REMINDER_PRESETS = [0, 5, 10, 15, 30, 60];

/** 距离期限可填的单位（最小填写项 = 时间流逝单位） */
const DISTANCE_UNITS = [
  { key: 'year', label: '年' },
  { key: 'month', label: '月' },
  { key: 'week', label: '周' },
  { key: 'day', label: '天' },
  { key: 'hour', label: '小时' },
  { key: 'minute', label: '分' },
];

/**
 * 「事情多大」= 四档颜色（决定气泡颜色，不决定大小）。
 * 同时受套娃约束：容器里只能选比它小的档。
 */
function levelPicker({ initial, parentLevel, hasChildren }) {
  const host = el('div.bubble-level-row');
  let current = initial || 'sky';
  const allowed = parentLevel
    ? new Set(allowedChildLevels(parentLevel).map((l) => l.key))
    : new Set(LEVELS.map((l) => l.key));

  const render = () => {
    mount(host, LEVELS.map((l) => {
      const disabled = !allowed.has(l.key);
      // 容器本身：不能改得比里面的子气泡还小
      const tooSmall = hasChildren && !canNestInside(l.key, hasChildren);
      const off = disabled || tooSmall;
      return el('button.chip.level-chip', {
        type: 'button',
        disabled: off,
        'aria-pressed': String(l.key === current),
        title: off
          ? (disabled ? `这个容器里放不下${l.colorName}` : `里面已经有比它大的气泡了`)
          : `${l.colorName} = ${l.label}`,
        onclick: () => { if (!off) { current = l.key; render(); } },
      }, [
        el('i', { style: { background: l.color } }),
        el('span', { text: l.label }),
      ]);
    }));
  };
  render();
  return { node: host, get: () => current, set: (v) => { current = v; render(); } };
}

/** 档位键 → 界面上那句档位文案 */
const AUTO_REMINDER_BAND_TEXT = {
  year: '一年以上', month: '一个月以上', week: '一周以上', day: '一天之内',
  hour: '几小时内', minute: '几分钟内', second: '马上到期',
  // ⚠️ 'unset' 必须在这里有一行：下面那句是 `BAND[info.band] || info.band`，
  //    少一行就会把英文键 'unset' 直接印到界面上（"查表落空"那一类 bug）。
  unset: '未设期限',
};

/**
 * 「自动提醒」那块预览要显示的东西（**纯函数**，导出给测试；界面和测试共用同一份实现）。
 *
 * @param {number|null} remainingMs 这条日程**自己**还剩多久（`deadline.remaining()`）
 * @returns {{info:object, text:string, planText:string, color:string}}
 *   `text` = 那个小标签（"未设期限 · 强度 1"）、`planText` = "准点 / 提前10分…"、`color` = 标签底色
 */
export function autoReminderPreview(remainingMs) {
  /**
   * ⚠️ 没有截止时间（null / 非有限数）→ **中性，不催**。别再把 null 换成 Infinity。
   *
   * 这里原来是把 null 换成 `Number.POSITIVE_INFINITY` 再交给 core 的，想的是
   * "∞ = 很远很远的将来 = 年档（还早，不用催）"。但 `bandForRemaining()` 对**非有限数**
   * 恰恰是**兜底到最紧迫的秒档** —— 于是没填期限的日程在这里显示成
   * 「**马上到期** · 强度 4」+ 秒档那串"提前10分 / 准点 / 截止后5分/15分/25分"，
   * 而紧挨着的截止时间预览上明明写着"没有截止时间" —— 同一屏自相矛盾（用户报的就是它）。
   *
   * 现在统一走 core 的中性口径：`notificationPlanForRemaining(null)` →
   * 档位 'unset' / "未设期限"、强度 1、只准点提醒一次。那句计划**才是真会响的**
   * （core/state-ops.js 的 effectiveReminders() 对没期限的事件返回 `[0]`），
   * 也就是说这次不只是"文案变好看"，是把"预览说的"和"实际会响的"对齐了。
   */
  const info = notificationPlanForRemaining(Number.isFinite(remainingMs) ? remainingMs : null);
  /**
   * ⚠️⚠️ 过期那句读的是 `info.overdue`，**不是** `info.ownOverdue` / `info.overdueInherited`。
   *
   * 那两个字段是 `core/urgency.js` 的 `bubbleStyle()` 才有的（它拿得到事件、父容器、allEvents），
   * `notificationPlanForRemaining()` 只收**一个数字**，从来就没返回过它们。
   * 原先这里写的是 `info.ownOverdue ? '已过期' : info.overdueInherited ? \`容器已过期 · …\` : …`，
   * 两个字段恒为 `undefined` → 两个分支永不生效 → **过期日程一直显示成「马上到期」**
   * （用户能看见的错：明明过期了，标签还说"马上到期"；强度刚好也是 4，所以更迷惑）。
   *
   * 为什么选**改读取**（读 `overdue`）而不是**给 core 加字段**：
   *   · 这个函数唯一的输入是"这条日程**自己**还剩多少毫秒"，它能确定的只有"自己到点了没有"。
   *     而 `notificationPlanForRemaining()` 的 `overdue = !(remainingMs > 0)` 与
   *     `bubbleStyle()` 的 `ownOverdue = remaining != null && remaining <= 0` **判据完全相同** ——
   *     在这里 `info.overdue` **恒等于** `ownOverdue`，读它不是将就，是语义等价。
   *   · 加字段也做不到：这里没有事件、没有祖先链，`overdueInherited` 只能硬写 `false`，
   *     那就是 `core/desktop-bubbles.js` 注释里点名要避免的"**永远读到 false 的死字段**"。
   *     真要算它得读 `state.events` 沿 `parentId` 往上走（`stateOps.inheritedOverdueOf`），
   *     那是**容器**的状态，不是"这条日程的自动提醒"这一块该回答的问题。
   *   · 而且"容器过期"在这个项目里**本来就不是用文字说的**：气泡区画一圈暗紫虚线环
   *     （`overdueInherited` → `.bubble-inside-overdue` / 桌面层契约里的 `ring`）。
   *   · 这也是 `bubbleStyle()` 早就定下的规矩（core/urgency.js 里 band/bandLabel 那段）：
   *     **档位与文字只陈述自己**，"容器过期了"交给 `overdueInherited` + 另一种视觉。
   *     所以这里显示"已过期" = 自己过期；自己没过期（哪怕母泡泡过期）→ 照常显示自己的档位文案。
   *     措辞用项目里已有的那个词：`core/urgency.js` 的 `bandLabel` 和 `web/ui/views/list.js`
   *     都用「已过期」（"容器已过期"这个词全仓库只在这里造过，而且从来没显示成功过，已删）。
   */
  const bandText = info.overdue ? '已过期' : (AUTO_REMINDER_BAND_TEXT[info.band] || info.band);
  const planText = info.plan.map((m) => (m === 0 ? '准点' : m > 0 ? `提前${m >= 1440 ? `${Math.round(m / 1440)}天` : m >= 60 ? `${Math.round(m / 60)}小时` : `${m}分`}` : `截止后${-m}分`)).join(' / ');
  const color = info.intensity >= 4 ? '#ef4444' : info.intensity === 3 ? '#f5b301' : info.intensity === 2 ? '#22c55e' : '#38bdf8';
  return { info, text: `${bandText} · 强度 ${info.intensity}`, planText, color };
}

/** 按剩余时间档位自动排出提醒并显示（只读展示） */
function renderAutoReminders(host, remainingMs) {
  const { text, planText, color } = autoReminderPreview(remainingMs);
  mount(host, [
    el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } }, [
      el('span.chip', {
        style: { background: `${color}22`, borderColor: color, color: 'var(--text)' },
        text,
      }),
      el('span.tiny', { text: '自动提醒：' + planText }),
    ]),
    el('p.tiny', { text: '说明：通知强度由「还剩多久」自动决定，越接近截止越强（和气泡变大同一个信号）。' }),
  ]);
}

function toInputValue(stamp) {
  const d = asDate(stamp);
  if (Number.isNaN(d.getTime())) return '';
  return `${toDateKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 截止时间输入：两种填法 + 模糊勾选 + 实时"还剩多久"预览。
 *
 * 关键点：距离填法要连**填写那一刻**一起记下来（countdownAt），
 * 因为"还剩 3 周"必须换算成绝对截止点，之后倒计时自己走。
 */
function deadlinePicker({ event }) {
  const host = el('div.deadline-field');
  const nowAnchored = Date.now();

  // 已有事件：从存储里还原两种填法
  const existingParts = event && event.countdownParts ? { ...event.countdownParts } : null;
  let mode = existingParts ? 'distance' : 'date';
  let parts = existingParts || { week: 1 };
  let fuzzy = !!(event && event.fuzzy);
  let exact = event && event.deadline
    ? toInputValue(event.deadline)
    : toInputValue(addMinutesLocal(new Date(), 24 * 60));

  const modeRow = el('div.seg');
  const dateBox = el('div.field-grid');
  const distBox = el('div');
  const preview = el('div.deadline-preview');
  const fuzzyRow = el('label.check-row', {
    style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', marginTop: '6px' },
  });

  const exactInput = el('input', { type: 'datetime-local', value: exact });
  exactInput.addEventListener('input', () => { exact = exactInput.value; renderPreview(); });
  mount(dateBox, [
    el('div', {}, [
      el('label', { text: '确切截止（可以只填到某天）' }),
      exactInput,
    ]),
  ]);

  // 距离输入：每个单位一个数字框，留空即"不填"
  const partInputs = {};
  const buildDist = () => {
    const rows = DISTANCE_UNITS.map((u) => {
      const input = el('input', {
        type: 'number', min: '0', max: '9999', placeholder: '—',
        value: parts[u.key] != null ? String(parts[u.key]) : '',
        style: { width: '84px', minHeight: '34px' },
        'aria-label': `还剩多少${u.label}`,
      });
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && v > 0) parts[u.key] = v; else delete parts[u.key];
        renderPreview();
      });
      partInputs[u.key] = input;
      return el('div.deadline-unit', {}, [input, el('span.tiny', { text: u.label })]);
    });
    mount(distBox, [
      el('label', { text: '距离期限（填哪几项都行，最小填写项就是倒计时单位）' }),
      el('div.deadline-units', {}, rows),
      el('p.tiny', { text: '例如只填"3 周"，以后就一直按周走：剩余 3 周 → 剩余 2 周 → 剩余 1 周 …（向下取整，不虚报）' }),
    ]);
  };
  buildDist();

  const fuzzyInput = el('input', { type: 'checkbox', checked: fuzzy });
  fuzzyInput.addEventListener('change', () => { fuzzy = fuzzyInput.checked; renderPreview(); });
  mount(fuzzyRow, [
    fuzzyInput,
    el('span', { text: '模糊剩余时间（只显示刻度的整数量，不显示更细的单位）' }),
  ]);

  function renderMode() {
    mount(modeRow, [
      el('button.chip', {
        type: 'button', text: '确切日期', 'aria-pressed': String(mode === 'date'),
        onclick: () => { mode = 'date'; renderMode(); renderPreview(); },
      }),
      el('button.chip', {
        type: 'button', text: '距离期限', 'aria-pressed': String(mode === 'distance'),
        onclick: () => { mode = 'distance'; renderMode(); renderPreview(); },
      }),
    ]);
    dateBox.style.display = mode === 'date' ? '' : 'none';
    distBox.style.display = mode === 'distance' ? '' : 'none';
    fuzzyRow.style.display = mode === 'distance' ? '' : 'none';
  }

  function renderPreview() {
    const remaining = computeRemaining();
    if (remaining == null) {
      mount(preview, [el('span.tiny', { text: '⚠️ 没有截止时间：气泡会用中性大小，并显示"未设期限"' })]);
      return;
    }
    const abs = Math.abs(remaining);
    const text = remaining >= 0
      ? formatRemaining(remaining)
      : `已过 ${formatRemaining(abs, { prefix: false })}`;
    const tick = mode === 'distance' ? tickUnitForParts(parts) : null;
    const tickText = tick
      ? formatRemainingInUnit(Math.max(0, remaining), tick, { now: Date.now() })
      : null;
    mount(preview, [
      el('span.chip', { text: `还剩：${text}` }),
      tickText && tickText !== text.replace(/^剩余 /, `剩余 `)
        ? el('span.tiny', { text: `按刻度读：${tickText}` })
        : null,
    ].filter(Boolean));
  }

  /** 当前填法 → 剩余毫秒；没填完整就返回 null */
  function computeRemaining() {
    if (mode === 'date') {
      if (!exact) return null;
      const t = asDate(normalizeStamp(exact)).getTime();
      return Number.isFinite(t) ? t - Date.now() : null;
    }
    const ms = partsToMs(parts);
    if (!(ms > 0)) return null;
    return ms - (Date.now() - nowAnchored);
  }

  /** 生成要提交的字段 */
  function toPayload() {
    if (mode === 'date') {
      return {
        deadline: exact ? normalizeStamp(exact) : '',
        countdownParts: null,
        countdownAt: null,
        fuzzy: false,
      };
    }
    const ms = partsToMs(parts);
    if (!(ms > 0)) {
      return { deadline: '', countdownParts: null, countdownAt: null, fuzzy: false };
    }
    const at = Date.now();
    const dl = deadlineFromDistance(parts, at);
    return {
      deadline: dl.toISOString(),
      countdownParts: { ...parts },
      countdownAt: at,
      fuzzy,
    };
  }

  renderMode();
  renderPreview();
  mount(host, [modeRow, dateBox, distBox, fuzzyRow, preview]);
  return { node: host, toPayload, remaining: computeRemaining, mode: () => mode };
}

/**
 * @param {object|null} event 传 null 表示新建
 * @param {object} defaults 新建时的预填（例如点月历某天的 08:00）
 */
export function openEditor(event = null, defaults = {}) {
  const isNew = !event;
  const state = store.getState();
  const base = event || {
    // ⚠️ 新建时也要**尊重 defaults 里的这几个字段**（原来写死成空串/默认值）。
    //    这是给"一句话加日程"用的：解析出来的标题/地点/提前提醒要能带进编辑框，
    //    否则用户口述完还得自己重填一遍，等于白解析。
    //    对老调用方（只传 start/type/parentId）完全无影响 —— 那些字段依然走默认。
    title: defaults.title || '',
    type: defaults.type || 'personal',
    location: defaults.location || '',
    teacher: defaults.teacher || '',
    notes: defaults.notes || '',
    // defaults.start 可能是 Date（在时间轴上点空白处）或本地时间字符串
    start: defaults.start instanceof Date ? toLocalStamp(defaults.start) : (defaults.start || `${toDateKey(new Date())}T09:00:00`),
    end: defaults.end || '',
    allDay: false,
    recurrence: { freq: 'none', byDay: [] },
    reminders: defaults.reminders || state.settings.defaultReminders || [10, 0],
    tags: [],
    done: false,
  };

  // ⚠️ parentId 必须**先确认容器真的存在**再用。
  //
  // 这里踩过一个"只要创建就失败"的坑：原来写的是
  //   const parentId = base.parentId || defaults.parentId || null;
  //   const parent = parentId ? state.events.find(...) : null;
  // 查出来的 parent 只拿去算颜色默认值，**没有用来兜住 parentId**。
  // 于是只要调用方带了一个已经不存在的容器 id（比如套娃路径里残留的幽灵 id），
  // 这个 id 就会被原样发到服务端 → 400「父气泡不存在」→ 用户"怎么创建都失败"。
  // 现在：容器不存在就直接当作最外层新建。
  const wantedParentId = base.parentId || defaults.parentId || null;
  const parent = wantedParentId ? state.events.find((e) => e.id === wantedParentId) : null;
  // 容器不存在 → 当作最外层新建（不要把这个 id 发出去）
  const parentId = parent ? wantedParentId : null;

  const draft = {
    ...base,
    recurrence: { freq: (base.recurrence || {}).freq || 'none', byDay: [...((base.recurrence || {}).byDay || [])], until: base.recurrence?.until || '' },
    reminders: [...(base.reminders || [])],
    // 颜色：显式 level > 旧 tier > 旧 magnitude/importance 换算
    level: base.level || base.tier || (base.magnitude != null ? levelFromLegacyMagnitude(base.magnitude) : (base.importance != null ? levelFromLegacyMagnitude(base.importance) : 'sky')),
    autoReminders: base.autoReminders !== false,
    // ⏰ 到点用真闹钟（见下面 alarmRow 的说明）：默认 false = 不会炸穿专注模式
    alarm: base.alarm === true,
    parentId,
    // 周期（天）：只显示"第一颗 + 周期"以内的重复实例。空/0 = 不筛。
    periodDays: base.periodDays != null && base.periodDays !== '' ? Number(base.periodDays) : '',
    // 未来泡泡：`start` 的含义变成**出现日期**（到那天之前气泡区不显示），`end` 就是到期。
    future: base.future === true,
  };

  // 新建子气泡时，颜色默认取"容器允许的最接近档"
  // 注意用 levelOf() 解析母气泡等级，**不能读 parent.level**：
  // 旧数据只有 magnitude，读原始字段会得到 undefined 再兜底成 'sky'，
  // 于是"红色容器的子气泡"会被错误地限制成只能选蓝色（踩过）。
  if (isNew && parent) {
    const allowed = allowedChildLevels(levelOf(parent)).map((l) => l.key);
    if (allowed.length && !allowed.includes(draft.level)) draft.level = allowed[allowed.length - 1];
  }

  // ---- 字段 ----
  const titleInput = el('input', {
    type: 'text', value: draft.title, placeholder: '例如：高等数学 / 交作业 / 社团例会', maxlength: '80',
  });

  const typeSelect = el('select', {},
    TYPE_KEYS.map((k) => el('option', { value: k, text: TYPE_LABEL[k], selected: draft.type === k })));

  const startInput = el('input', { type: 'datetime-local', value: toInputValue(draft.start) });
  const endInput = el('input', {
    type: 'datetime-local',
    value: draft.end ? toInputValue(draft.end) : toInputValue(addMinutesLocal(draft.start, 60)),
  });

  // ---- 未来泡泡（用户要求的新功能）----
  //
  // 用户原话拆开就是三条语义（都已确认）：
  //   ① 「开始」= **这颗泡泡出现的日子**（不是"开始做"的时刻）
  //   ③ 出现之后照常按剩余时间长大/变色，**到期 = 结束**
  //
  // 所以编辑框里这是一次**字段用途的切换**，不是多填一个字段：
  //   · 未来泡泡   → 写「开始（出现日）+ 结束」，不写截止时间那一段
  //   · 非未来泡泡 → 保持老路径：写「开始 + 结束」+「截止时间（确切日期 / 距离期限）」
  //
  // ⚠️ 提醒的锚点也跟着切：未来泡泡的提醒按 `end` 算（见 core/notify-plan.js）。
  //    否则"提前 10 分钟提醒"会变成"泡泡刚冒出来就提醒"，等于没提醒。
  const FUTURE_ON = { text: '未来泡泡', hint: '到「开始」那天才出现在气泡区' };
  const FUTURE_OFF = { text: '普通日程', hint: '现在就出现在气泡区' };
  let futureOn = draft.future === true;

  const startLabel = el('label', { text: '开始 *' });
  const endLabel = el('label', { text: '结束' });
  const futureRow = el('div.seg');
  // 未来泡泡专属说明：把"什么时候出现、什么时候到期"一句话讲清楚，
  // 免得用户以为"开始/结束"还是老意思。
  const futureNote = el('p.tiny', { text: '' });

  function renderFutureToggle() {
    mount(futureRow, [
      el('button.chip', {
        type: 'button', text: FUTURE_OFF.text,
        'aria-pressed': String(!futureOn),
        onclick: () => { futureOn = false; applyFutureMode(); },
      }),
      el('button.chip', {
        type: 'button', text: FUTURE_ON.text,
        'aria-pressed': String(futureOn),
        onclick: () => { futureOn = true; applyFutureMode(); },
      }),
    ]);
  }

  function applyFutureMode() {
    startLabel.textContent = futureOn ? '开始（泡泡出现的日子）*' : '开始 *';
    endLabel.textContent = futureOn ? '结束（到期）' : '结束';
    // 未来泡泡：截止时间 = 结束，所以那一段整个收起来（避免"两个地方都能设到期"）
    deadlineBlock.style.display = futureOn ? 'none' : '';
    futureNote.textContent = futureOn
      ? `到「开始」那天之前，这颗泡泡只在气泡区不显示（列表和月历里照样能查到）；到了就按剩余时间长大，到期 =「结束」。提醒也按「结束」算。`
      : '';
    futureNote.style.display = futureOn ? '' : 'none';
    renderFutureToggle();
    // 切模式后"按还剩多久自动安排"的预览要立刻跟着换锚点（截止时间 ↔ 结束）
    syncReminderMode();
  }

  const locationInput = el('input', { type: 'text', value: draft.location, placeholder: '教三 305 / 线上' });
  const teacherInput = el('input', { type: 'text', value: draft.teacher, placeholder: '选填' });

  // ---- 重复：级别（日/周/月/年）+ 间隔 + （周级的）周几勾选 ----
  //
  // 用户要求："重复参数可以为日级，周级，月级，年级（意思是每 N 日，每 N 周，
  //            每 N 月，每 N 年新生一次）…… 新生机制当然要严格遵循级别单位"
  const startLevel = recurLevelOf(draft.recurrence);   // null = 不重复
  const freqSelect = el('select', {},
    [['none', '不重复'], ...RECUR_LEVELS.map((l) => [l.key, l.label])]
      .map(([v, t]) => el('option', {
        value: v,
        text: t,
        // 旧数据 freq='biweekly' 会被 recurLevelOf 归一化成 weekly + interval 2
        selected: v === 'none' ? !startLevel : (startLevel && startLevel.freq === v),
      })));

  const intervalInput = el('input', {
    type: 'number', min: '1', max: '365', step: '1',
    value: String(startLevel ? startLevel.interval : 1),
    style: { width: '72px' },
  });
  // 「每 __ 天/周/月/年」的量词跟着级别走
  const intervalUnit = el('span.tiny', { text: '周' });

  const byDayHost = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
  const untilInput = el('input', { type: 'date', value: draft.recurrence.until || '' });

  const notesInput = el('textarea', { placeholder: '备注、作业要求、要带的东西…' });
  notesInput.value = draft.notes || '';

  const reminderHost = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } });

  // 「是否重复」勾选框（用户要求）。
  //
  // 语义要分清楚，两个方向不是对称的：
  //   · 原来是单次 → 勾上 = 打开重复（等于上面的「重复」下拉选了"每周"，可再调）
  //   · 原来是重复 → **取消勾选 = 这条重复彻底结束**：以后不再新生，
  //     只把最近一次留下来当单次日程。
  //     这是"除了等它到截止时间之外，另一个把重复结束掉的办法"（用户原话）。
  //
  // ⚠️ 声明必须放在 `recurrenceRow` **之前** —— 那个元素里要用到它。
  //    我第一版声明写在后面，`recurrenceRow` 构建时直接
  //    `ReferenceError: Cannot access 'repeatToggle' before initialization`（TDZ）。
  const repeatToggle = el('input', {
    type: 'checkbox',
    checked: !!startLevel,
  });
  /** 记住"取消重复"之前的级别，用户又勾回来时恢复它 */
  let lastLevel = startLevel ? startLevel.freq : 'weekly';
  /** 勾选框旁边那行文字（跟着状态变） */
  const repeatToggleText = el('span', { text: repeatToggle.checked ? '重复' : '不重复' });

  const recurrenceRow = el('div.field-grid', {}, [
    el('div', {}, [
      el('label', { text: '是否重复' }),
      // 勾选框：取消勾选 = 彻底结束这条重复
      el('label.switch-row', { style: { padding: '4px 0', borderBottom: '0' } }, [
        repeatToggleText,
        repeatToggle,
      ]),
    ]),
    el('div', {}, [el('label', { text: '重复' }), freqSelect]),
    // 间隔单独一列，只在"每周"时显示
    el('div', {}, [
      el('label', { text: '每隔几个' }),
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
        intervalInput,
        intervalUnit,
      ]),
    ]),
    el('div', {}, [el('label', { text: '重复到（可留空）' }), untilInput]),
  ]);

  const dayRow = el('div', {}, [el('label', { text: '重复的星期（可多选，只对每周有效）' }), byDayHost]);

  function renderDays() {
    const active = new Set(draft.recurrence.byDay);
    mount(byDayHost, ['日', '一', '二', '三', '四', '五', '六'].map((label, i) => el('button.chip', {
      type: 'button',
      style: active.has(i)
        ? { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' }
        : {},
      text: `周${label}`,
      onclick: () => {
        if (active.has(i)) active.delete(i); else active.add(i);
        draft.recurrence.byDay = [...active];
        renderDays();
      },
    })));
  }

  function renderReminders() {
    const active = new Set(draft.reminders);
    const presetNodes = REMINDER_PRESETS.map((m) => el('button.chip', {
      type: 'button',
      style: active.has(m) ? { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : {},
      text: m === 0 ? '准点' : `${m} 分钟前`,
      onclick: () => {
        if (active.has(m)) active.delete(m); else active.add(m);
        draft.reminders = [...active].sort((a, b) => a - b);
        renderReminders();
      },
    }));
    const custom = el('input', {
      type: 'number', min: '1', max: '1440', placeholder: '自定义',
      style: { width: '92px', minHeight: '32px' },
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const v = Number(custom.value);
          if (v > 0) { active.add(v); draft.reminders = [...active].sort((a, b) => a - b); custom.value = ''; renderReminders(); }
        }
      },
    });
    const customBtn = el('button.btn.btn-sm', {
      type: 'button', text: '添加',
      onclick: () => {
        const v = Number(custom.value);
        if (!v || v <= 0) return;
        active.add(v); draft.reminders = [...active].sort((a, b) => a - b);
        custom.value = ''; renderReminders();
      },
    });
    const current = [...active].filter((m) => !REMINDER_PRESETS.includes(m))
      .map((m) => el('button.chip', {
        type: 'button', text: `${m} 分钟前 ✕`,
        style: { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' },
        onclick: () => { active.delete(m); draft.reminders = [...active].sort((a, b) => a - b); renderReminders(); },
      }));
    mount(reminderHost, [...presetNodes, ...current, custom, customBtn]);
  }

  const syncRepeatVisibility = () => {
    const on = freqSelect.value !== 'none';
    const isWeekly = freqSelect.value === 'weekly';
    // 勾选框与下拉框双向同步：
    //   · 取消勾选 → 下拉变"不重复"（= 这条重复彻底结束）
    //   · 下拉选回某个级别 → 勾选框自动打上
    repeatToggle.checked = on;
    repeatToggleText.textContent = on ? '重复' : '不重复';
    // 「重复的星期」只有周级才有意义（日/月/年是按级别单位走的，没有"星期"可选）
    dayRow.style.display = on && isWeekly ? '' : 'none';
    untilInput.parentElement.style.display = on ? '' : 'none';
    intervalInput.parentElement.parentElement.style.display = on ? '' : 'none';
    // 「重复」和「每隔几个」在"不重复"时也没意义
    freqSelect.parentElement.style.display = on ? '' : 'none';
    // 量词跟着级别走：每 __ 天 / 周 / 月 / 年
    const unit = { daily: '天', weekly: '周', monthly: '月', yearly: '年' }[freqSelect.value] || '周';
    intervalUnit.textContent = unit;
    // 上限也跟着级别走（和 core 的 INTERVAL_CAP 一致，免得填了被悄悄截断）
    const cap = { daily: 365, weekly: 52, monthly: 60, yearly: 20 }[freqSelect.value] || 52;
    intervalInput.max = String(cap);
  };
  syncRepeatVisibility();

  // 勾选框变化 → 驱动下拉框
  repeatToggle.addEventListener('change', () => {
    if (repeatToggle.checked) {
      // 打开重复：默认每周（用户最常用的），如果之前有级别就恢复那个
      freqSelect.value = lastLevel || 'weekly';
    } else {
      // 取消 = **彻底结束这条重复**。先记住原来的级别，万一用户又勾回来。
      if (freqSelect.value !== 'none') lastLevel = freqSelect.value;
      freqSelect.value = 'none';
    }
    syncRepeatVisibility();
  });

  const isCourse = typeSelect.value === 'course';
  const courseHint = el('p.tiny', {
    text: '课程建议用「课程表 → 导入课表」批量添加，这里适合手动补一节。',
  });
  courseHint.style.display = isCourse ? '' : 'none';

  // 「自动提醒」：按剩余时间档位自动排（颜色不参与）
  const autoReminders = el('input', { type: 'checkbox', checked: draft.autoReminders !== false });
  const autoHost = el('div');
  const manualHost = el('div');

  // ⏰「到点用真闹钟」——**按日程**的开关（iOS 26+ 的 AlarmKit）。
  //
  // ⚠️ 为什么必须是每条日程一个开关，而不是设置里一个总开关：
  //   真闹钟**会穿过专注模式、无视静音** —— 那是它的定义，改不了。
  //   所以"要不要炸穿专注"只能**由这条日程自己**决定：
  //     不勾（默认）= 永远不会炸；
  //     勾了        = 我认了它会穿过专注模式。
  //   如果做成全局开关，用户就只剩"全都用"（专注模式废掉）或"全都不用"
  //   两个极端 —— 那正是他说的"专注模式时别响"所不能接受的。
  const alarmInput = el('input', { type: 'checkbox', checked: draft.alarm === true });
  const alarmRow = el('div', {
    style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px dashed var(--line)' },
  }, [
    el('label', {
      style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--text)' },
    }, [alarmInput, el('span', { text: '⏰ 到点用真闹钟（最后关头拉满音量）' })]),
    el('p.tiny', {
      style: { margin: '4px 0 0' },
      text: '只对「最后 1 小时内 / 已过期」的那几次提醒生效；更早的（提前一天、提前一小时）仍是普通通知。'
        + '注意：真闹钟会穿过专注模式、无视静音开关 —— 系统就是这么设计的。所以只勾「绝对不能错过」的事。',
    }),
  ]);

  // ---- 周期（重复事件才显示）----
  //
  // 用户要的自由度："若泡泡为周级、每周一，周期设 3 天，那么原本'剩四天'和'剩十一天'
  //   两颗泡泡，第二颗会被筛掉；周期改成 8 天又会出来。"
  // 规则：只显示「窗口内第一颗 + 周期」以内的实例（见 core/recurrence.js: applyPeriodLimit）。
  const periodInput = el('input', {
    type: 'number', min: '1', step: '1', style: { width: '88px' },
    value: draft.periodDays === '' || draft.periodDays == null ? '' : String(draft.periodDays),
  });
  const periodRow = el('div', {}, [
    el('label', { text: '周期（天）' }),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
      periodInput,
      el('span.tiny', {
        text: '留空 = 不限制。填了之后，重复日程只浮「第一颗 + 周期」以内的，更远的自动收起来',
      }),
    ]),
  ]);
  /** 只有重复事件才有周期可言；不重复时整行隐藏 */
  function syncPeriodRow() {
    periodRow.style.display = freqSelect.value === 'none' ? 'none' : '';
  }
  freqSelect.addEventListener('change', syncPeriodRow);
  syncPeriodRow();

  // ---- 截止时间 + 颜色 ----
  const deadline = deadlinePicker({ event: base });
  // 未来泡泡模式下这一整段会收起来（截止时间就是「结束」）。
  // ⚠️ 必须**在 deadline 建好之后**才拼这个块：`mount()` 会清空 host，
  //    先建块后 mount 的话里面那句 label 会被清掉（第一版就是这么写的）。
  const deadlineBlock = el('div', {}, [
    el('label', { text: '截止时间（决定气泡大小）' }),
    deadline.node,
  ]);
  // 这里两处也要走 levelOf()：旧数据没有 level 字段，
  // 读原始 `c.level` / `parent.level` 会把等级算错（红容器被当成蓝的）。
  const childrenLevels = (event ? store.childrenOf(event.id) : []).map((c) => levelOf(c));
  const strongestChild = childrenLevels.length
    ? childrenLevels.reduce((a, b) => (rankOf(a) >= rankOf(b) ? a : b))
    : null;
  const level = levelPicker({
    initial: draft.level,
    parentLevel: parent ? levelOf(parent) : null,
    hasChildren: strongestChild,
  });

  function syncReminderMode() {
    const auto = autoReminders.checked;
    autoHost.style.display = auto ? '' : 'none';
    manualHost.style.display = auto ? 'none' : '';
    if (auto) {
      // ⚠️ 未来泡泡模式下截止时间那一段是**收起来的**，`deadline.remaining()` 读到的是
      //    那块隐藏输入的默认值（+24 小时），跟真实的到期（= 结束）没关系 →
      //    预览会骗人。所以这一支要直接用「结束」算。
      let r;
      if (futureOn) {
        const t = endInput.value ? new Date(normalizeStamp(endInput.value)).getTime() : NaN;
        // 填不出结束时间 → 就是"没设期限"，交给下面那支中性处理。
        // ⚠️ 以前这里填的是 `Number.POSITIVE_INFINITY`（"∞ = 还早 = 年档"），
        //    但 core 对非有限数是兜底到**最紧迫的秒档**的 —— 于是"没结束时间"
        //    反而显示成"马上到期"。现在填 null，语义就是"没有期限"。
        r = Number.isFinite(t) ? t - Date.now() : null;
      } else {
        r = deadline.remaining();
      }
      // `renderAutoReminders` 自己会把 null / 非有限数当"没设期限"处理（见那里的说明）。
      renderAutoReminders(autoHost, r);
    }
  }
  autoReminders.addEventListener('change', syncReminderMode);
  // 截止时间变了要重算提醒预览
  deadline.node.addEventListener('input', () => { if (autoReminders.checked) syncReminderMode(); });
  deadline.node.addEventListener('click', () => { if (autoReminders.checked) syncReminderMode(); });
  // 未来泡泡模式下「结束」就是到期 → 改它也要重算预览
  endInput.addEventListener('input', () => { if (futureOn && autoReminders.checked) syncReminderMode(); });

  renderDays();
  renderReminders();
  syncRepeatVisibility();
  syncReminderMode();
  // 未来泡泡模式的显隐（含「开始/结束」的措辞和截止时间那一段的收起）
  applyFutureMode();
  freqSelect.addEventListener('change', syncRepeatVisibility);

  typeSelect.addEventListener('change', () => {
    courseHint.style.display = typeSelect.value === 'course' ? '' : 'none';
  });

  // ---- 批量生成同质泡泡（用户点名要的；只在**新建**时出现）----
  //
  // 用户原话："批量产生同质化泡泡，就是几个参数相同的泡泡（哪些参数可选），方便我批量设计任务"
  // 三个旋钮在 core/event-template.js 的 BATCH_KNOBS 里 —— 其余字段全都相同，
  // 那才是"同质化"。这里只画界面，生成规则一行都不在这里写。
  // ⚠️ `data-field` 是给测试用的抓手（端到端测试要能像用户那样改这两个输入框）。
  //    没有它就只能靠下标去找 input，改一次布局就断。
  const batchCount = el('input', { type: 'number', min: '1', max: String(BATCH_MAX), step: '1', value: '1', 'data-field': 'batch-count' });
  const batchGap = el('input', { type: 'number', min: '0', max: '365', step: '1', value: '1', 'data-field': 'batch-gap' });
  const batchUnit = el('select', { 'data-field': 'batch-unit' },
    GAP_UNITS.map((u) => el('option', { value: u.key, text: u.label, selected: u.key === 'day' })));
  const batchNumber = el('input', { type: 'checkbox', checked: true, 'data-field': 'batch-number' });
  const batchPreview = el('div.tiny', { style: { color: 'var(--muted)' } });

  /** 界面上那三个旋钮 → core 要的参数（**夹取规则只在 core 里**） */
  function batchOpts() {
    const count = Number(batchCount.value) || 1;
    const unit = batchUnit.value;
    const gap = (Number(batchGap.value) || 0) * unitMinutes(unit);
    return { count, gapMinutes: gap, numberTitles: batchNumber.checked, unit };
  }
  function renderBatchPreview() {
    const o = batchOpts();
    batchPreview.textContent = describeBatch(o);
  }
  for (const node of [batchCount, batchGap, batchUnit]) node.addEventListener('input', renderBatchPreview);
  batchUnit.addEventListener('change', renderBatchPreview);
  batchNumber.addEventListener('change', renderBatchPreview);

  const batchBlock = isNew ? el('div', {}, [
    el('label', { text: '批量生成同质泡泡' }),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } }, [
      el('span.tiny', { text: '一次生成' }),
      batchCount,
      el('span.tiny', { text: '个 · 每隔' }),
      batchGap,
      batchUnit,
      el('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' } },
        [batchNumber, el('span', { text: '标题加序号' })]),
    ]),
    batchPreview,
  ]) : null;

  // ---- 套用母泡泡的参数（用户点名要的；只在**新建子气泡**时出现）----
  //
  // 用户原话："在母泡泡内部添加的子泡泡可以选择套用母泡泡的参数生成（哪些参数可选）"
  // 勾选项就是 core 里那份 PARENT_TEMPLATE_FIELDS（**颜色不在里面**：
  // 套娃要求子级严于父容器，照抄颜色会被服务端拒掉）。
  const inheritChecks = new Map();
  const inheritBlock = (isNew && parent) ? el('div', {}, [
    el('label', { text: `套用「${parent.title}」的参数` }),
    el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px 16px' } },
      PARENT_TEMPLATE_FIELDS.map((f) => {
        const cb = el('input', {
          type: 'checkbox',
          checked: PARENT_TEMPLATE_DEFAULTS.includes(f.key),
          title: f.hint || '',
          // 端到端测试要能像用户那样勾/取消某一项
          'data-field': 'inherit-' + f.key,
        });
        inheritChecks.set(f.key, cb);
        return el('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' } },
          [cb, el('span', { text: f.label })]);
      })),
    el('div.tiny', {
      style: { color: 'var(--muted)' },
      text: '颜色不在这里：子气泡必须比母泡泡小（套娃规则），所以颜色只会在允许的那几档里。',
    }),
  ]) : null;

  const form = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, [
    el('div', {}, [el('label', { text: '标题 *' }), titleInput]),
    el('div.field-grid', {}, [
      el('div', {}, [el('label', { text: '类型' }), typeSelect]),
      el('div', {}, [el('label', { text: '地点' }), locationInput]),
    ]),
    // 「未来泡泡」开关放在时间字段**上面**：它改的是下面这几个字段的含义，
    // 先选类型再填时间，顺序才顺。
    el('div', {}, [
      el('label', { text: '这颗泡泡什么时候出现' }),
      futureRow,
      futureNote,
    ]),
    el('div.field-grid', {}, [
      el('div', {}, [startLabel, startInput]),
      el('div', {}, [endLabel, endInput]),
    ]),
    deadlineBlock,
    el('div', {}, [
      el('label', { text: `事情多大（决定气泡颜色）${parent ? ` · 放在「${parent.title}」里面` : ''}` }),
      level.node,
    ]),
    recurrenceRow,
    dayRow,
    // 「周期」：重复事件的一个自由度 —— 只显示"第一颗 + 周期"以内的实例。
    // 只对重复事件有意义，所以跟着 recurrenceRow 一起显隐（见下面的 syncPeriodRow）。
    periodRow,
    el('div', {}, [
      el('label', { text: '提醒' }),
      el('label', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', fontSize: '13px', color: 'var(--text)' },
      }, [autoReminders, el('span', { text: '按还剩多久自动安排（推荐）' })]),
      autoHost,
      manualHost,
      alarmRow,
    ]),
    el('div', {}, [el('label', { text: '任课 / 相关人员' }), teacherInput]),
    el('div', {}, [el('label', { text: '备注' }), notesInput]),
    inheritBlock,
    batchBlock,
    courseHint,
  ].filter(Boolean));

  const deleteBtn = el('button.btn.btn-danger', {
    text: '删除', style: isNew ? { display: 'none' } : {},
  });

  const saveBtn = el('button.btn.btn-primary', { text: isNew ? '创建日程' : '保存' });

  const ctl = openModal({
    title: isNew ? '新建日程' : '编辑日程',
    body: [form],
    footer: [deleteBtn, el('div.spacer'), el('button.btn', { text: '取消', onclick: () => ctl.close() }), saveBtn],
  });

  async function save() {
    const title = titleInput.value.trim();
    if (!title) { toast({ title: '请填写标题', kind: 'err' }); titleInput.focus(); return; }
    if (!startInput.value) { toast({ title: '请选择开始时间', kind: 'err' }); return; }

    const start = normalizeStamp(startInput.value);
    let end = endInput.value ? normalizeStamp(endInput.value) : addMinutesLocal(start, 60);
    if (new Date(end) < new Date(start)) end = addMinutesLocal(start, 60);

    // 未来泡泡：到期就是「结束」，所以这里必须**明确要求**结束晚于出现那天。
    //   ⚠️ 不能沿用上面那句静默修正 —— 那句会把"结束填在出现之前"悄悄改成"出现后 1 小时"，
    //      用户看到的是"我填的结束没生效"。宁可拦住让他自己填。
    if (futureOn && endInput.value && new Date(end) <= new Date(start)) {
      toast({
        title: '「结束」要晚于「开始」',
        body: '未来泡泡的「结束」就是到期时刻，不能早于它出现的那天',
        kind: 'err',
        timeout: 4200,
      });
      return;
    }

    // 未来泡泡不写截止时间那一段：截止时间 = 结束（由 deadlineMsOf 的 end 兜底）。
    const dl = futureOn
      ? { deadline: '', countdownParts: null, countdownAt: null, fuzzy: false }
      : deadline.toPayload();
    // 诊断探针（只读，不参与产品逻辑）：把"这次保存带的 parentId"打出来。
    // 真机上出现过"一添加就报父气泡不存在"，而这句能一眼分清
    // 是 id 传空了、还是传了个库里没有的 id。走 console → logcat。
    try {
      const ids = store.getState().events.map((e) => e.id);
      const pid = draft.parentId || null;
      console.log(`[editor] 保存 parentId=${pid} 库里${ids.length}个`
        + (pid ? (ids.includes(pid) ? ' 存在' : ' 不存在') : ''));
    } catch (e) { console.log('[editor] 探针出错: ' + e.message); }

    const payload = {
      id: draft.id,
      title,
      type: typeSelect.value,
      location: locationInput.value.trim(),
      teacher: teacherInput.value.trim(),
      notes: notesInput.value,
      start,
      end,
      allDay: false,
      recurrence: freqSelect.value === 'none'
        ? { freq: 'none' }
        : {
          // 级别：日 / 周 / 月 / 年（用户要求"严格遵循级别单位"）
          freq: freqSelect.value,
          // 间隔归一化：按各级别上限收好（和 core/recurrence.js 的 recurLevelOf 一致）
          interval: Math.min(
            { daily: 365, weekly: 52, monthly: 60, yearly: 20 }[freqSelect.value] || 52,
            Math.max(1, Math.floor(Number(intervalInput.value) || 1)),
          ),
          // 只有周级用 byDay；其他级别留着也无害（展开时不看它）
          byDay: freqSelect.value === 'weekly' ? draft.recurrence.byDay : [],
          until: untilInput.value || '',
        },
      // 自动模式下 reminders 交给服务端按剩余时间生成（传 [] 表示"自动"）
      reminders: autoReminders.checked ? [] : [...new Set(draft.reminders)].sort((a, b) => a - b),
      autoReminders: autoReminders.checked,
      // ⏰ 到点用真闹钟（iOS 26+）：**按日程**决定要不要炸穿专注模式
      alarm: alarmInput.checked,
      // 周期：空 → 不筛（存 null 而不是 0，免得后端把 0 当成"筛到只剩第一颗"）
      periodDays: periodInput.value === '' ? null : Math.max(1, Math.floor(Number(periodInput.value) || 1)),
      // 未来泡泡：`start` = 出现日期，`end` = 到期（提醒也按 end 算）
      future: futureOn,
      // 颜色 = 事情多大
      level: level.get(),
      // 套娃
      parentId: draft.parentId || null,
      // 截止时间（两种填法）
      deadline: dl.deadline,
      countdownParts: dl.countdownParts,
      countdownAt: dl.countdownAt,
      fuzzy: dl.fuzzy,
      tags: draft.tags || [],
      done: !!draft.done,
    };

    saveBtn.disabled = true;
    try {
      // ① 先按勾选把母泡泡的参数套上来（规则在 core；颜色只在允许档里收窄）
      let one = payload;
      if (isNew && parent && inheritChecks.size) {
        const picked = [...inheritChecks.entries()].filter(([, cb]) => cb.checked).map(([k]) => k);
        one = applyParentTemplate(payload, parent, { fields: picked });
      }
      // ② 再铺成 N 条（count=1 时就是原样一条，不加序号、时间也不动）
      const o = batchOpts();
      const list = batchDrafts(one, o);

      // ⚠️ 逐条存、并且**记下失败的那几条**：批量里第 3 条被服务端拒了（比如等级/期限），
      //    不能整批静默当作成功 —— 用户会以为都建好了。
      const failed = [];
      for (const item of list) {
        try { await store.saveEvent(item); } catch (err) { failed.push({ item, err }); }
      }
      if (failed.length) {
        toast({
          title: `有 ${failed.length} 条没建成`,
          body: `${failed[0].err.message}（例如「${failed[0].item.title}」）`,
          kind: 'err',
          timeout: 6000,
        });
        if (failed.length === list.length) { saveBtn.disabled = false; return; }
      }
      const made = list.length - failed.length;
      toast({
        title: made > 1 ? `已创建 ${made} 条` : (isNew ? '已创建日程' : '已保存'),
        body: made > 1
          ? `${one.title}${o.numberTitles && made > 1 ? ' 1…' + made : ''} · ${hhmm(new Date(list[0].start))} 起`
          : `${one.title} · 开始 ${hhmm(new Date(list[0].start))}`,
      });
      ctl.close();
    } catch (err) {
      toast({ title: '保存失败', body: err.message, kind: 'err', timeout: 5000 });
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener('click', save);
  deleteBtn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '删除日程',
      message: `确定删除「${draft.title}」吗？里面的气泡会被放出来，不会一起删掉。`,
      confirmText: '删除', danger: true,
    });
    if (!ok) return;
    try {
      await store.deleteEvent(draft.id);
      toast({ title: '已删除' });
      ctl.close();
    } catch (err) {
      toast({ title: '删除失败', body: err.message, kind: 'err' });
    }
  });

  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });

  return ctl;
}

function normalizeStamp(value) {
  // "2026-03-02T09:00" -> "2026-03-02T09:00:00"
  return value.length === 16 ? `${value}:00` : value;
}

function addMinutesLocal(stamp, minutes) {
  const d = stamp instanceof Date ? stamp : asDate(stamp);
  if (Number.isNaN(d.getTime())) return typeof stamp === 'string' ? stamp : '';
  const t = new Date(d.getTime() + minutes * 60_000);
  return `${toDateKey(t)}T${pad(t.getHours())}:${pad(t.getMinutes())}:00`;
}

// 让"未使用"的导出不触发 lint：这些常量是给外部/未来用的
void tierFill;
void levelByKey;
void describeParts;
void DAY_MS; void WEEK_MS; void MONTH_MS; void YEAR_MS;
void URGENCY_TIERS;
