// 清单视图：按「今天 / 明天 / 本周 / 下周 / 更远」分组，勾选即完成。
import { el, mount } from '../dom.js';
import { expandRange } from '../../../core/recurrence.js';
import {
  addDays, asDate, dayDiff, friendlyDay, hhmm, isSameDay, mondayOf, startOfDay, toDateKey,
} from '../../../core/time.js';
import { emptyState, tierVarForItem } from '../viewkit.js';
import * as store from '../../adapter/store.js';
import { toast } from '../toast.js';
import { TYPE_LABEL } from '../editor.js';

const SHOW_DONE_KEY = 'timetable.list.showDone';

export const listView = {
  id: 'list',
  label: '清单',
  icon: '☰',

  title() { return '清单'; },
  subtitle(state) {
    const items = upcoming(state);
    return `未来 60 天 ${items.length} 条`;
  },

  nav(state) {
    const showDone = state.eventShowDone || localStorage.getItem(SHOW_DONE_KEY) === '1';
    return [
      { label: showDone ? '隐藏已完成' : '显示已完成', action: 'toggle-done', className: 'today-btn' },
    ];
  },

  onNav(action, ctx) {
    if (action !== 'toggle-done') return;
    const next = !(ctx.state.eventShowDone || localStorage.getItem(SHOW_DONE_KEY) === '1');
    localStorage.setItem(SHOW_DONE_KEY, next ? '1' : '0');
    ctx.setLocal({ eventShowDone: next });
  },

  render(state, ctx, host) {
    const showDone = state.eventShowDone ?? (localStorage.getItem(SHOW_DONE_KEY) === '1');
    const items = upcoming(state).filter((it) => showDone || !it.event.done);

    if (!items.length) {
      return void mount(host, emptyState({
        title: state.events.length ? '未来 60 天没有待办' : '还没有日程',
        hint: state.events.length ? '换个视图看看，或新建一条。' : '从新建一条日程开始吧。',
        actionLabel: '新建日程',
        onAction: () => ctx.newEventAt(new Date()),
      }));
    }

    const groups = new Map();
    const today = startOfDay(new Date());
    for (const it of items) {
      const label = groupLabel(asDate(it.start), today);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(it);
    }

    const list = el('div.list', {}, [...groups.entries()].map(([label, groupItems]) =>
      el('div.list-group', {}, [
        el('div.list-group-head', {}, [
          el('h3', { text: label }),
          el('span.count', { text: `${groupItems.length} 条` }),
        ]),
        ...groupItems.map((it) => row(it, ctx)),
      ])));

    mount(host, list);
  },
};

function groupLabel(day, today) {
  const diff = dayDiff(today, day);
  if (diff < 0) return '已过期';
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  const thisMonday = mondayOf(today);
  const nextMonday = addDays(thisMonday, 7);
  if (day < nextMonday) return '本周';
  if (day < addDays(nextMonday, 7)) return '下周';
  return '更远';
}

function row(item, ctx) {
  const ev = item.event;
  const check = el(`button.check${ev.done ? '.on' : ''}`, {
    'aria-label': ev.done ? '标记为未完成' : '标记为已完成',
    text: '✓',
    onclick: async (e) => {
      e.stopPropagation();
      try {
        await store.toggleDone(ev.id);
        if (!ev.done) toast({ title: '已完成', body: ev.title, timeout: 1800 });
      } catch (err) {
        toast({ title: '操作失败', body: err.message, kind: 'err' });
      }
    },
  });

  const sameDay = isSameDay(asDate(ev.start), item.start) && asDate(ev.end).getTime() > asDate(ev.start).getTime();
  const timeText = sameDay
    ? `${hhmm(item.start)}–${hhmm(item.end)}`
    : hhmm(item.start);

  return el(`div.row${ev.done ? '.done' : ''}`, {
    style: { '--c': tierVarForItem(item) },
    onclick: () => ctx.editEvent(ev, item.start),
  }, [
    el('div.bar'),
    check,
    el('div.row-main', {}, [
      el('div.row-title', {}, [
        ev.title,
        el('span.chip', { text: TYPE_LABEL[ev.type] || '其他', style: { fontSize: '11px' } }),
      ]),
      el('div.row-meta', {}, [
        el('span', { text: friendlyDay(item.start) }),
        ev.location ? el('span', { text: '📍 ' + ev.location }) : null,
        ev.teacher ? el('span', { text: '👤 ' + ev.teacher }) : null,
        (ev.reminders || []).length ? el('span', { text: '🔔 ' + ev.reminders.map((m) => (m === 0 ? '准点' : `${m}分`)).join('/') }) : null,
      ]),
    ]),
    el('div.row-time', { text: timeText }),
  ]);
}

function upcoming(state) {
  const from = startOfDay(new Date());
  const to = addDays(from, 60);
  return expandRange(state.events, from, new Date(to.getTime() - 1), state.settings.termStart);
}
