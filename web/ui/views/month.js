// 月历视图
import { el, mount } from '../dom.js';
import { festivalsInYear, lunarLabelOf } from '../../../core/holidays.js';
import { expandRange } from '../../../core/recurrence.js';
import {
  addDays, addMonths, asDate, hhmm, isToday, mondayOf, monthTitle,
  startOfDay, toDateKey, weekOfTerm, DAY_MS,
} from '../../../core/time.js';
import { emptyState, tierVarForItem } from '../viewkit.js';
import { TYPE_LABEL } from '../editor.js';

export const monthView = {
  id: 'month',
  label: '月历',
  icon: '▦',

  title(state) { return monthTitle(asDate(state.cursor)); },
  subtitle(state) {
    const n = countInMonth(state);
    const w = weekOfTerm(asDate(state.cursor), state.settings.termStart);
    return [`本月 ${n} 条日程`, w ? `第 ${w} 学期周` : null].filter(Boolean).join(' · ');
  },

  nav(state) {
    return [
      { label: '‹', title: '上一月', action: 'prev' },
      { label: '今天', action: 'today', className: 'today-btn' },
      { label: '›', title: '下一月', action: 'next' },
    ];
  },

  onNav(action, ctx) {
    const cur = asDate(ctx.state.cursor);
    if (action === 'prev') ctx.setCursor(toDateKey(addMonths(cur, -1)));
    if (action === 'next') ctx.setCursor(toDateKey(addMonths(cur, 1)));
    if (action === 'today') ctx.setCursor(toDateKey(new Date()));
  },

  render(state, ctx, host) {
    const cursor = asDate(state.cursor);
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const gridStart = mondayOf(first);
    const gridEnd = addDays(gridStart, 41);
    const items = expandRange(state.events, gridStart, new Date(gridEnd.getTime() + DAY_MS - 1), state.settings.termStart);

    const byDay = new Map();
    for (const it of items) {
      const key = toDateKey(it.start);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(it);
    }

    // 节日：**不进库、算出来的**（公历节日每年都有、农历节日按农历表换算）。
    // 用网格覆盖到的那几个月去查，顺带把跨年的（腊月/除夕）也算进来。
    const festivalByDay = new Map();
    for (let y = gridStart.getFullYear(); y <= gridEnd.getFullYear(); y += 1) {
      for (const f of festivalsInYear(y)) {
        if (!festivalByDay.has(f.date)) festivalByDay.set(f.date, []);
        festivalByDay.get(f.date).push(f);
      }
    }

    const head = el('div.month-head', {}, ['一', '二', '三', '四', '五', '六', '日'].map((d, i) =>
      el('span', { class: i >= 5 ? 'weekend' : '', text: `周${d}` })));

    // 右侧"某一天的详细列表"里当前选中的那天。
    // 默认选中今天（如果今天在本月视图里），否则本月 1 号 —— 面板一进来就有内容。
    let selectedKey = (() => {
      const today = new Date();
      if (today.getMonth() === cursor.getMonth() && today.getFullYear() === cursor.getFullYear()) {
        return toDateKey(today);
      }
      return toDateKey(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
    })();

    const detailHost = el('div.month-detail');

    const renderDetail = () => {
      const day = asDate(selectedKey);
      const dayItems = (byDay.get(selectedKey) || [])
        .slice()
        .sort((a, b) => a.start - b.start);
      const w = weekOfTerm(day, state.settings.termStart);

      mount(detailHost, [
        el('div.month-detail-head', {}, [
          el('div', {}, [
            el('b', { text: `${day.getMonth() + 1} 月 ${day.getDate()} 日` }),
            el('span.tiny', {
              text: `周${'日一二三四五六'[day.getDay()]}`
                + (w ? ` · 第 ${w} 周` : '')
                + ` · ${dayItems.length} 项`,
            }),
          ]),
          el('button.btn.btn-sm', {
            text: '＋ 新建',
            onclick: () => ctx.newEventAt(day),
          }),
        ]),
        dayItems.length
          ? el('div.month-detail-list', {}, dayItems.map((it) => {
            const ev = it.event;
            // 比日历格子里的色块详细得多：时间、标题、地点、老师、类型、剩余
            const end = ev.end ? hhmm(asDate(ev.end)) : '';
            const meta = [
              ev.location,
              ev.teacher,
              TYPE_LABEL[ev.type] || ev.type,
            ].filter(Boolean).join(' · ');
            return el('div.month-detail-item', {
              style: { '--c': tierVarForItem(it) },
              title: '点击编辑',
              onclick: () => ctx.editEvent(ev, it.start),
            }, [
              el('div.mdi-time', {}, [
                el('b', { text: hhmm(it.start) }),
                end ? el('span', { text: end }) : null,
              ]),
              el('div.mdi-body', {}, [
                el('div.mdi-title', { text: ev.title }),
                meta ? el('div.tiny', { text: meta }) : null,
                ev.notes ? el('div.tiny.mdi-notes', { text: ev.notes }) : null,
              ]),
              ev.done ? el('span.mdi-done', { text: '已完成' }) : null,
            ]);
          }))
          : el('p.tiny.month-detail-empty', {
            text: '这天没有安排。点「＋ 新建」加一条，或点日历里的日子切换查看。',
          }),
      ]);
    };

    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      const day = addDays(gridStart, i);
      const key = toDateKey(day);
      const dayItems = (byDay.get(key) || []).filter((x) => !x.event.done || true);
      const out = day.getMonth() !== cursor.getMonth();
      const w = weekOfTerm(day, state.settings.termStart);
      // 这一天是什么节日（用户要求"月历里载入节日"）—— 名字从 core 的节日表来
      const fests = festivalByDay.get(key) || [];
      const lunar = lunarLabelOf(day.getFullYear(), day.getMonth() + 1, day.getDate());

      const cell = el(`div.month-cell${out ? '.out' : ''}${isToday(day) ? '.today' : ''}${fests.length ? '.has-festival' : ''}`, {
        dataset: { date: key },
        // 新建改成"双击格子"或右侧面板的「＋ 新建」，避免想看一天却误建日程。
        onclick: (e) => {
          if (e.target.closest('.pill')) return;
          selectedKey = key;
          for (const c of cells) c.classList.toggle('selected', c.dataset.date === key);
          renderDetail();
        },
        ondblclick: (e) => {
          if (e.target.closest('.pill')) return;
          ctx.newEventAt(day);
        },
      }, [
        el('div.cell-head', {}, [
          el('span.daynum', { text: String(day.getDate()) }),
          w ? el('span.cell-week', { text: `W${w}` }) : null,
          // 农历日子（很小的字）：没有节日时它也能让月历"像个日历"
          lunar && !fests.length ? el('span.cell-lunar', { text: lunar }) : null,
        ]),
        ...fests.slice(0, 2).map((f) => el('div.cell-festival', {
          text: f.name,
          title: `${f.name}（${lunar || ''}）\n${f.blessing}`,
        })),
        ...dayItems.slice(0, 3).map((it) => pill(it, ctx)),
        dayItems.length > 3 ? el('div.more', { text: `+${dayItems.length - 3} 更多` }) : null,
      ]);
      cells.push(cell);
    }

    const grid = el('div.month-grid', {}, cells);
    const calCol = el('div.card.month-cal', { style: { overflow: 'hidden' } }, [head, grid]);
    const sideCol = el('div.card.month-side', {}, [detailHost]);
    const wrap = el('div.month-layout', {}, [calCol, sideCol]);

    renderDetail();
    cells.find((c) => c.dataset.date === selectedKey)?.classList.add('selected');

    const content = state.events.length === 0
      ? el('div', {}, [
          emptyState({
            title: '还没有任何日程',
            hint: '点任意日期格子即可新建；也可以先去「课程表」导入课表。',
            actionLabel: '新建第一条日程',
            onAction: () => ctx.newEventAt(new Date()),
          }),
          wrap,
        ])
      : wrap;

    mount(host, el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
      content,
      el('div', { style: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } }, [
        el('p.tiny', { text: '提示：点格子新建 · 点色块编辑 · 手机可长按拖动（后续版本）' }),
        el('p.tiny', { text: `数据保存在本机 data/db.json · 共 ${state.events.length} 条` }),
      ]),
    ]));
  },
};

function pill(item, ctx) {
  const ev = item.event;
  return el(`div.pill${ev.done ? '.done' : ''}`, {
    style: { '--c': tierVarForItem(item) },
    title: `${hhmm(item.start)} ${ev.title}${ev.location ? ' @ ' + ev.location : ''}`,
    onclick: (e) => { e.stopPropagation(); ctx.editEvent(ev, item.start); },
  }, [
    el('span.pill-time', { text: hhmm(item.start) }),
    el('span.pill-title', { text: ev.title }),
  ]);
}

function countInMonth(state) {
  const cursor = asDate(state.cursor);
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59);
  return expandRange(state.events, startOfDay(first), last, state.settings.termStart).length;
}
