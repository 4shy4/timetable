// 课程表视图：按「节次 × 星期」网格，按周次切换。
import { el, mount } from '../dom.js';
import { expandRange } from '../../../core/recurrence.js';
// ⚠️ "这条事件属于这门课"的判定只认 core 那一份（课程 key 自己含 `|`）。
//    界面里只是为了**先把要删几条说清楚**，重写一个前缀匹配迟早和 core 分叉。
import { isCourseEventOf } from '../../../core/state-ops.js';
import {
  addDays, asDate, hhmm, mondayOf, startOfDay, termStartFromWeek, toDateKey, weekOfTerm, weekDates,
} from '../../../core/time.js';
import { emptyState } from '../viewkit.js';
import { openCustomCourse } from '../custom-course.js';
// 二次确认用项目既有的 confirmDialog（**不要**自己写一个弹窗）：
// 它已经处理了 Esc、焦点、栈式嵌套（见 web/ui/modal.js 文件头那段"关不掉的僵尸"）。
import { confirmDialog, openModal } from '../modal.js';
import { toast } from '../toast.js';
import * as store from '../../adapter/store.js';

const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 * 学期第一周的校准条 —— **必须突出，不能是一句灰字**。
 *
 * ⚠️ 为什么这个必须有（踩过）：
 *   `core/recurrence.js` 展开课表时要 `termStart`：
 *     `if (ev.type === 'course' && ev.weeks.length && termStart) { ... }`
 *   **没有 termStart 就整段不展开** —— 于是课表格子是**空的**。
 *   而原来的提示只是页面底部一句 `p.tiny`「去「设置」里填一下」，
 *   用户看到的是"我明明导入了课表，怎么什么都没有"，根本联想不到是这个原因。
 *
 * 两条路都提供，因为它们的**难度差很多**：
 *   ① 填「第一周的周一」—— 准确，但用户未必记得住那个日期
 *   ② 填「本周是第几周」—— 用户几乎一定知道（今天第几周了），
 *      由它反推 termStart = 本周一 − (N−1) 周。**这条才是大多数人会走的路。**
 */
function termCalibrateCard(state, ctx) {
  const total = state.settings.termWeeks || 20;
  const saved = state.settings.termStart || '';
  const nowWeek = saved ? weekOfTerm(new Date(), saved) : null;

  // 为什么还要在"已设置"时报错：设了但今天落在学期外，说明第一周填错了，
  // 这时默认周次（"当前周"）会算出一个荒唐值 —— 正是用户报的那个问题。
  const outOfRange = saved && nowWeek && (nowWeek < 1 || nowWeek > total);
  const missing = !saved;

  const dateInput = el('input', { type: 'date', value: saved, style: { width: '150px' } });
  const weekInput = el('input', {
    type: 'number', min: '1', max: String(total),
    value: String(nowWeek && nowWeek >= 1 && nowWeek <= total ? nowWeek : 1),
    style: { width: '76px' },
  });
  const preview = el('span.tiny', { style: { opacity: '.8' } });

  function refreshPreview() {
    const n = Number(weekInput.value);
    if (!Number.isFinite(n) || n < 1) { preview.textContent = ''; return; }
    const monday = termStartFromWeek(new Date(), n);
    preview.textContent = `→ 第一周周一 = ${toDateKey(monday)}（本周一往前 ${n - 1} 周）`;
  }
  weekInput.addEventListener('input', refreshPreview);
  refreshPreview();

  async function save(patch, okTitle) {
    try {
      await store.saveSettings(patch);
      toast({ title: okTitle, timeout: 2000 });
      ctx.refresh();
    } catch (err) {
      toast({ title: '保存失败', body: err.message, kind: 'err' });
    }
  }

  return el('div.card', {
    style: {
      borderColor: 'var(--warn, #f59e0b)',
      background: 'color-mix(in srgb, var(--warn, #f59e0b) 10%, transparent)',
    },
  }, [
    el('b', {
      text: missing ? '⚠️ 课表周次还没校准' : '⚠️ 学期第一周可能填错了',
    }),
    el('p.tiny', {
      style: { margin: '6px 0 10px' },
      text: missing
        ? '课表要靠「第一周是哪天」才能算出每周上什么课 —— 不填的话，下面这些格子会是空的。'
        : `按现在填的日期，今天算出来是第 ${nowWeek} 周（学期只有 ${total} 周），说明第一周填错了。`,
    }),

    // ① 知道确切日期的人
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
      el('span.tiny', { text: '① 我知道第一周的周一：' }),
      dateInput,
      el('button.btn.btn-sm', {
        text: '保存',
        onclick: () => {
          if (!dateInput.value) { toast({ title: '请先选一个日期', kind: 'err' }); return; }
          save({ termStart: dateInput.value }, `学期第一周已设为 ${dateInput.value}`);
        },
      }),
    ]),

    // ② 只知道"现在是第几周"的人（大多数人）
    el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' } }, [
      el('span.tiny', { text: '② 或者，我知道本周是第' }),
      weekInput,
      el('span.tiny', { text: '周' }),
      el('button.btn.btn-sm.btn-primary', {
        text: '按本周校准',
        onclick: () => {
          const n = Number(weekInput.value);
          if (!Number.isFinite(n) || n < 1 || n > total) {
            toast({ title: `周次要在 1 – ${total} 之间`, kind: 'err' });
            return;
          }
          // 反推：termStart = 本周一 − (n−1) 周
          const monday = termStartFromWeek(new Date(), n);
          save({ termStart: toDateKey(monday) }, `已按「本周是第 ${n} 周」推算出第一周`);
        },
      }),
      preview,
    ]),

    el('p.tiny', {
      style: { margin: '10px 0 0' },
      text: '提示：周次对不上时，随时回到这里重校。',
    }),
  ]);
}

/**
 * 一门课一个颜色（相邻课程不同色，一眼分得开）。
 *
 * 用课程名做哈希选色，所以**同一门课在所有格子/所有周都是同一个颜色** ——
 * 这对"扫一眼找某门课"很重要（随机上色会让同一门课周一周三看起来是两门课）。
 *
 * 颜色定义在 base.css 的 --cc-1..12（避开红/琥珀等语义色）。
 * 同名但不同老师的分班仍同色 —— 这是刻意的：颜色表达"哪门课"，不表达"哪个班"。
 */
function courseColorVar(title) {
  const s = String(title || '');
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return `var(--cc-${(h % 12) + 1})`;
}

/**
 * 「删除课程」对话框：一门课一行，各自一个删除按钮。
 *
 * ⚠️ 为什么是"列表 + 逐门删"，而不是在课表格子上挂个小 ✕：
 *   · 格子里那块（`.ct-block`）本来就窄，还写着时间/老师/地点/周次，
 *     再塞一个 ✕ 既挤又容易误触，而它是**删除**这种不可轻率的动作；
 *   · 一门课在格子里会出现**很多次**（每周一次、每次一格），
 *     而"删课"的对象是**这门课**（`courses` 里那一条 + 它的全部课程事件）——
 *     在格子上删会让人以为是"删这一节"。
 *   所以入口放在工具栏（和"导入课表 / 添加自定义课程"同一排），
 *   点开是这份清单 —— 一次只删一门、删之前还要过一遍 confirmDialog。
 *
 * ⚠️ 删的是 `course.key`，**不是**标题：这个库里同名不同班的课很常见
 *   （`大学物理B1(I)` 有 3 条，只是老师/节次/周次不同），按标题删会一锅端。
 */
function openCourseManager(ctx) {
  const listHost = el('div');

  const ctl = openModal({
    title: '删除课程',
    width: '560px',
    body: [
      el('p.tiny', {
        text: '这里删的是一门课：课程表里的记录和它的课程事件会一起删掉，气泡区和提醒也就不再出现它了。'
          + '删错了不要紧 —— 重新导入同一份课表就能把它加回来。',
      }),
      listHost,
    ],
    footer: [el('div.spacer'), el('button.btn', { text: '关闭', onclick: () => ctl.close() })],
  });

  /** 这门课现在有几条课程事件（删之前先把数字说给用户听） */
  function eventCountOf(key) {
    return (store.getState().events || []).filter((e) => isCourseEventOf(e, key)).length;
  }

  function lineOf(course) {
    const day = DAY_LABELS[Number(course.dayOfWeek) - 1] || '';
    const secs = (course.sections || []).join(',');
    const weeks = (course.weeks || []).length ? `${compactWeeks(course.weeks)}周` : '';
    return [day && `${day} 第${secs}节`, weeks, course.teacher, course.location]
      .filter(Boolean).join(' · ');
  }

  async function askDelete(course) {
    const title = course.title || '(无名称)';
    const n = eventCountOf(course.key);
    const ok = await confirmDialog({
      title: '删除课程',
      message: `确定删除「${title}」吗？课表里它的 ${n} 条课程事件会一起删掉。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await store.deleteCourse(course.key);
      // ⚠️ 文案如实说：这门课的删除**没有**回收站可还原（见 core/state-ops.js
      //    deleteCourse 的"回收语义"注释：既有范式是硬删 + 墓碑，墓碑是同步用的，
      //    不是给用户看的回收站）。所以这里说的是"可以重新导入加回来"这个真实退路，
      //    而不是含糊地说"已移入回收站"——那是句好听话，点了却找不到东西。
      const removed = (res && res.removedEvents && res.removedEvents.length) || n;
      toast({
        title: '已删除课程',
        body: `「${title}」和它 ${removed} 条课程事件一起删掉了`,
        timeout: 4000,
      });
      renderList();
      ctx.refresh();
    } catch (err) {
      toast({ title: '删除失败', body: err.message, kind: 'err', timeout: 5000 });
    }
  }

  function renderList() {
    const courses = store.getState().courses || [];
    if (!courses.length) {
      mount(listHost, el('p.tiny', {
        style: { marginTop: '10px' },
        text: '课表是空的，没有可以删除的课程。',
      }));
      return;
    }
    mount(listHost, el('div.course-del-list', {}, courses.map((c) => el('div.course-del-row', {}, [
      el('div.cdr-main', {}, [
        el('div.cdr-title', { text: c.title || '(无名称)' }),
        el('div.cdr-meta', { text: lineOf(c) || '（没有时间信息）' }),
      ]),
      el('button.btn.btn-sm.btn-danger', {
        text: '删除',
        'aria-label': `删除课程 ${c.title || ''}`,
        onclick: () => askDelete(c),
      }),
    ]))));
  }

  renderList();
  return ctl;
}

export const courseView = {
  id: 'course',
  label: '课程表',
  icon: '🎓',

  title(state) {
    const w = currentWeek(state);
    return w ? `课程表 · 第 ${w} 周` : '课程表';
  },

  subtitle(state) {
    const n = state.courses.length;
    if (!n) return '尚未导入课表';
    return `${n} 门课 · 学期共 ${state.settings.termWeeks || 20} 周`;
  },

  nav() {
    return [
      { label: '‹', action: 'prev', title: '上一周' },
      { label: '本周', action: 'thisweek', className: 'today-btn' },
      { label: '›', action: 'next', title: '下一周' },
    ];
  },

  onNav(action, ctx) {
    const total = ctx.state.settings.termWeeks || 20;
    const w = currentWeek(ctx.state) || 1;
    if (action === 'prev') ctx.setCourseWeek(Math.max(1, w - 1));
    if (action === 'next') ctx.setCourseWeek(Math.min(total, w + 1));
    if (action === 'thisweek') ctx.setCourseWeek(weekOfTerm(new Date(), ctx.state.settings.termStart) || 1);
  },

  render(state, ctx, host) {
    // 加自定义课程（校内课表里没有的课）—— 空课表时也能用
    const addCustom = (course = null) => openCustomCourse(course, {
      sectionTimes: state.settings.sectionTimes,
      termWeeks: state.settings.termWeeks,
      onDone: () => ctx.refresh(),
    });

    if (!state.courses.length) {
      return void mount(host, el('div.card', {}, [
        emptyState({
          title: '还没有课表',
          hint: '可以手工加课，也可以从「导入课表」用标准 JSON 批量导入。',
          actionLabel: '导入课表',
          onAction: () => ctx.setView('import'),
        }),
        el('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center', padding: '0 0 18px' } }, [
          el('button.btn.btn-sm', { text: '＋ 添加自定义课程', onclick: () => addCustom() }),
        ]),
      ]));
    }

    const total = state.settings.termWeeks || 20;
    const week = Math.min(Math.max(currentWeek(state) || 1, 1), total);
    const monday = state.settings.termStart
      ? addDays(mondayOf(asDate(state.settings.termStart)), (week - 1) * 7)
      : addDays(mondayOf(new Date()), (week - 1) * 7);
    const days = weekDates(monday);

    const rows = deriveRows(state);
    const items = expandRange(
      state.events.filter((e) => e.type === 'course'),
      startOfDay(monday),
      new Date(addDays(monday, 7).getTime() - 1),
      state.settings.termStart,
    );

    const cellMap = new Map();
    for (const it of items) {
      const dayIdx = days.findIndex((d) => toDateKey(d) === toDateKey(it.start));
      const rowKey = String(it.start.getHours()).padStart(2, '0') + ':' + String(it.start.getMinutes()).padStart(2, '0');
      const key = `${rowKey}|${dayIdx}`;
      if (!cellMap.has(key)) cellMap.set(key, []);
      cellMap.get(key).push(it);
    }

    // 周次选择条
    const strip = el('div.week-strip', {}, Array.from({ length: total }, (_, i) => i + 1).map((w) =>
      el('button.week-pill', {
        type: 'button',
        'aria-pressed': String(w === week),
        text: `第${w}周`,
        onclick: () => ctx.setCourseWeek(w),
      })));

    const toolbar = el('div.card.course-toolbar', {}, [
      el('div.seg', {}, [
        el('button', { 'aria-pressed': 'true', text: '按周次' }),
      ]),
      strip,
      el('div.spacer'),
      el('button.btn.btn-sm.btn-primary', { text: '＋ 自定义课程', onclick: () => addCustom() }),
      el('button.btn.btn-sm', { text: '导入课表', onclick: () => ctx.setView('import') }),
      el('button.btn.btn-sm', { text: '设置学期', onclick: () => ctx.setView('settings') }),
      // 删一门课（导入的反操作）——放在最后一格，和"加课/导入"这类正向动作分开
      el('button.btn.btn-sm', {
        text: '🗑 删除课程',
        title: '删除某一门课（连同它的课程事件）',
        onclick: () => openCourseManager(ctx),
      }),
    ]);

    // 所有行都在**同一个网格**里：表头第 1 行，之后每个节次占一行。
    const head = el('div.ct-row.ct-head', { style: { gridRow: '1' } }, [
      el('div', { style: { gridColumn: '1' }, text: '周次' }),
      el('div', { style: { gridColumn: '2' }, text: '节次' }),
      ...DAY_LABELS.map((d, i) => el('div', { style: { gridColumn: String(3 + i) } }, [
        d,
        el('div', { style: { fontSize: '10.5px', opacity: '.75' }, text: `${days[i].getMonth() + 1}/${days[i].getDate()}` }),
      ])),
    ]);

    const bodyRows = rows.map((row, rowIdx) => {
      // 表头占第 1 行，所以第 i 个节次在网格的第 i+2 行
      const gridRow = rowIdx + 2;
      // 这一行（这个时间段）在本周出现过的所有周次集合 —— 用来做左侧那列的摘要
      const weekSet = new Set();
      for (let dayIdx = 0; dayIdx < 7; dayIdx += 1) {
        for (const it of (cellMap.get(`${row.key}|${dayIdx}`) || [])) {
          for (const w of (it.event.weeks || [])) weekSet.add(Number(w));
        }
      }
      const weekList = [...weekSet].filter(Boolean).sort((a, b) => a - b);

      return el('div.ct-row', {}, [
        el('div.ct-weeks', {
          style: { gridRow: String(gridRow), gridColumn: '1' },
          title: weekList.length ? `这一时段上课的周次：${weekList.join(', ')}` : '这一时段本周没有课',
        }, [
          el('b', { text: weekList.length ? compactWeeks(weekList) : '—' }),
          el('span', { text: `${weekList.length} 周` }),
        ]),
        el('div.ct-slot', {
          style: { gridRow: String(gridRow), gridColumn: '2' },
        }, [
          el('b', { text: String(row.index) }),
          el('span', { text: row.label }),
        ]),
        ...DAY_LABELS.map((_, dayIdx) => {
          const key = `${row.key}|${dayIdx}`;
          return el('div.ct-cell', {
            style: { gridRow: String(gridRow), gridColumn: String(3 + dayIdx) },
            onclick: (e) => {
              if (e.target.closest('.ct-block')) return;
              const day = days[dayIdx];
              const d = new Date(day);
              const [h, m] = row.start.split(':').map(Number);
              d.setHours(h, m, 0, 0);
              ctx.newEventAt(d, { type: 'course' });
            },
          });
        }),
        // 课程块：直接放进**外层网格**，用 grid-row: span N 跨多行连起来。
        // 第 1-2 节就是一整块（8:00–9:35），不再被拆成两行只画上面那行。
        ...(() => {
          const out = [];
          const placed = new Set();
          for (let dayIdx = 0; dayIdx < 7; dayIdx += 1) {
            const cellItems = cellMap.get(`${row.key}|${dayIdx}`) || [];
            for (const it of cellItems) {
              // 同一门课只在它**起始节次**那一行画（其余行由 span 覆盖）
              if (it.event.sections && Number(it.event.sections[0]) !== Number(row.index)) continue;
              const dup = `${it.event.id}|${dayIdx}`;
              if (placed.has(dup)) continue;
              placed.add(dup);
              const span = Math.max(1, (it.event.sections || []).length);
              const s = asDate(it.event.start);
              const e2 = asDate(it.event.end);
              const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
              // 周次也标在块里—— 左列那个"周次"太远，看块时对不上
              const wk = (it.event.weeks || []).length;
              const wkText = wk ? `${compactWeeks(it.event.weeks)}周` : '';
              out.push(el('div.ct-block', {
                style: {
                  // 一门课一个颜色（哈希课程名），同一门课所有格子同色
                  '--c': courseColorVar(it.event.title),
                  gridRow: `${gridRow} / span ${span}`,
                  gridColumn: String(3 + dayIdx),
                },
                title: `${it.event.title}${it.event.location ? ' @ ' + it.event.location : ''}`
                  + `\n${hhmm(s)}–${hhmm(e2)}` + (wkText ? ` · ${wkText}` : ''),
                onclick: (ev) => { ev.stopPropagation(); ctx.editEvent(it.event, it.start); },
              }, [
                el('b', { text: it.event.title }),
                // 行序：课程名 → 时间 → 老师 → 地点 → 周次
                // 时间放第二行是刻意的：用户要"直观显示课程时间"，
                // 它是块里最该先看到的信息（原来在最后一行，跨行块中间还空一大截）。
                el('span.ct-time', { text: `${hhmm(s)}–${hhmm(e2)}` }),
                it.event.teacher ? el('span', { text: `👤 ${it.event.teacher}` }) : null,
                it.event.location ? el('span', { text: `📍 ${it.event.location}` }) : null,
                wkText ? el('span', { text: `📅 ${wkText}` }) : null,
              ]));
            }
          }
          return out;
        })(),
      ]);
    });

    // 什么时候把校准条顶到最上面：
    //   · 没填第一周  → 课表根本不会展开，格子是空的
    //   · 填了但"今天"落在学期之外 → 第一周填错了，默认周次会算出荒唐值
    const nowWeek = state.settings.termStart
      ? weekOfTerm(new Date(), state.settings.termStart)
      : null;
    const needsCalibration = !state.settings.termStart
      || nowWeek == null || nowWeek < 1 || nowWeek > total;
    const banner = needsCalibration ? termCalibrateCard(state, ctx) : null;

    mount(host, el('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } }, [
      // 没校准 / 校准错了就顶在最上面 —— 不能塞在底部当灰字（见 termCalibrateCard 的注释）
      banner,
      toolbar,
      // 窄屏横向滑动：外层容器负责 overflow-x，表格自己有 min-width。
      // 宽屏不会出现滚动条（表格撑满），窄屏手指左右滑。
      el('div.course-table-scroll', {}, [
        el('div.course-table', {}, [head, ...bodyRows]),
      ]),
      el('div', { style: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } }, [
        el('p.tiny', {
          text: state.settings.termStart
            ? `学期第一周周一：${state.settings.termStart} · 第 ${week} 周`
            : '未设置学期第一周 —— 课表格子会是空的，用上面的卡片校准。',
        }),
        el('p.tiny', { text: '点空白格子可补一节临时课' }),
      ]),
    ]));
  },
};

function currentWeek(state) {
  if (state.courseWeek) return state.courseWeek;
  return weekOfTerm(new Date(), state.settings.termStart) || 1;
}

/**
 * 把一串周次压缩成简短说法（左侧"周次"列空间很窄）。
 *
 * ⚠️ 先判"是否连续"，再判单双周。
 *    第一版顺序反了，结果 [1..16] 和 [1,3,5,…,15] 都显示成"单周" ——
 *    全周和单周长得一模一样，等于没说（截图里一眼就看出来的 bug）。
 *    规则：
 *      连续      → "1-16"（下面小字写周数）
 *      隔一个取  → "单周" / "双周"（首项是 1 就是单，是 2 就是双）
 *      其余      → "lo-hi"（零散周次用范围表示，比列一串数字短）
 */
export function compactWeeks(weeks) {
  const ws = [...new Set(weeks.map(Number).filter(Boolean))].sort((a, b) => a - b);
  if (!ws.length) return '—';

  const lo = ws[0];
  const hi = ws[ws.length - 1];
  const span = hi - lo + 1;

  // ① 连续：最常见的形态（"1-16 周"）
  if (ws.length === span) {
    return ws.length === 1 ? String(lo) : `${lo}-${hi}`;
  }
  // ② 隔一个取一个（单/双周）：必须是等差 2 且首项是 1 或 2
  if (ws.length === Math.ceil(span / 2) && ws.every((w, i) => i === 0 || w - ws[i - 1] === 2)) {
    if (lo === 1) return '单周';
    if (lo === 2) return '双周';
  }
  // ③ 零散：给个范围，配合下面"共 N 周"就够用了
  return lo === hi ? String(lo) : `${lo}-${hi}`;
}

/**
 * 从已导入的课程事件推导「节次行」：同一起始时间视为同一大节。
 * 若导入时提供了 sectionTimes 元数据，则用其中的节次编号与时间。
 */
function deriveRows(state) {
  const times = state.settings.sectionTimes;
  if (Array.isArray(times) && times.length) {
    return times.map((t) => ({ key: t.start, index: t.index, label: `${t.start}`, start: t.start }));
  }
  const seen = new Map();
  for (const ev of state.events) {
    if (ev.type !== 'course') continue;
    const d = asDate(ev.start);
    const key = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (!seen.has(key)) seen.set(key, { key, start: key, label: key });
  }
  return [...seen.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r, i) => ({ ...r, index: i + 1 }));
}
