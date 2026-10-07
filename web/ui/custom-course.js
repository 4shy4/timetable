// 自定义课程：把"不是校内课表里的课"（网课、培训班、旁听、跨校课…）手工录进来。
//
// 为什么单独一个对话框、而不是复用日程编辑器：
//   课程表要的是**周期性**的一门课（周几 + 第几节 + 哪几周），
//   而日程编辑器面向的是"某个时间点的一件事"。两者的心智模型不一样，
//   用同一个表单会让两边都别扭。
//
// 参数与校内课程**完全一致**（store.importCourses 的字段）：
//   title / dayOfWeek / sections / weeks / location / teacher (+ 可选的课程代码)
// 所以自定义课会出现在同一张课程表里、同样展开成事件、同样能设提醒。
import { el } from './dom.js';
import { openModal } from './modal.js';
import { toast } from './toast.js';
import * as store from '../adapter/store.js';
import { DEFAULT_SECTION_TIMES } from '../../core/import-adapter.js';

const DAY_LABEL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/**
 *
 * ⚠️ 为什么要内置这份兜底：`settings.sectionTimes` **只有在导入过课表之后才有值**。
 *    没导入时它是空数组，于是"第几节"的下拉只剩一个选项，"从/到"都变成同一节，
 *    用户根本没法选两节课（实测踩到）。用学校真实作息兜底，手工加课立刻可用。
 */
const DEFAULT_SECTIONS = DEFAULT_SECTION_TIMES.map((s) => ({
  index: s.index, start: s.start, end: s.end,
}));

const DEFAULT_TERM_WEEKS = 20;

/**
 * 打开"添加/编辑自定义课程"对话框。
 * @param {object|null} course 传已有课程则是编辑
 * @param {object} opts `{ sectionTimes, termWeeks, onDone }`
 */
export function openCustomCourse(course = null, opts = {}) {
  const isEdit = Boolean(course);
  const sectionTimes = opts.sectionTimes && opts.sectionTimes.length
    ? opts.sectionTimes
    : DEFAULT_SECTIONS;
  const termWeeks = Number(opts.termWeeks) || DEFAULT_TERM_WEEKS;

  // ---- 字段 ----
  const nameInput = el('input', { type: 'text', value: course?.title || '', placeholder: '例如：雅思口语 / 校外编程培训 / 旁听课' });
  const codeInput = el('input', { type: 'text', value: course?.code || '', placeholder: '可以留空（比如 WANGKE-01）' });
  const placeInput = el('input', { type: 'text', value: course?.location || '', placeholder: '例如：线上 / 赤峰路 120 号 3 楼' });
  const teacherInput = el('input', { type: 'text', value: course?.teacher || '', placeholder: '可以留空' });
  const noteInput = el('input', { type: 'text', value: course?.note || '', placeholder: '备注（选填）' });

  // ---- 星期 ----
  const dayBtns = DAY_LABEL.map((label, i) => {
    const day = i + 1;
    const b = el('button.chip', { type: 'button', text: label });
    b.dataset.day = String(day);
    b.addEventListener('click', () => {
      // 单选：一门课的一次上课只在一个星期几（多次上课就加多条课程）
      for (const x of dayBtns) x.setAttribute('aria-pressed', String(x === b));
    });
    b.setAttribute('aria-pressed', String(Number(course?.dayOfWeek) === day));
    return b;
  });

  // ---- 节次：起止 ----
  // 新建时"到"默认比"从"晚一节（一门课通常连上两节）；
  // 之前默认和"从"相同，等于默认一门课只上一节，很容易漏改。
  const secOptions = sectionTimes.map((s) => ({ index: Number(s.index), label: `${s.index} 节 ${s.start}-${s.end}` }));
  const startDefault = course?.sections?.[0] || 1;
  const endDefault = course?.sections?.length
    ? course.sections[course.sections.length - 1]
    : (secOptions.find((o) => o.index === startDefault + 1)?.index ?? startDefault);
  const fromSel = el('select', {}, secOptions.map((o) => el('option', { value: String(o.index), text: o.label, selected: o.index === startDefault })));
  const toSel = el('select', {}, secOptions.map((o) => el('option', { value: String(o.index), text: o.label, selected: o.index === endDefault })));

  // ---- 周次 ----
  const weekMode = el('select', {}, [
    el('option', { value: 'all', text: `全学期（1-${termWeeks} 周）` }),
    el('option', { value: 'odd', text: '单周' }),
    el('option', { value: 'even', text: '双周' }),
    el('option', { value: 'range', text: '指定范围' }),
  ]);
  const rangeFrom = el('input', { type: 'number', min: '1', max: String(termWeeks), value: '1', style: { width: '70px' } });
  const rangeTo = el('input', { type: 'number', min: '1', max: String(termWeeks), value: String(termWeeks), style: { width: '70px' } });
  const rangeRow = el('div.deadline-units', { hidden: true }, [
    el('span.tiny', { text: '第' }), rangeFrom, el('span.tiny', { text: '到第' }), rangeTo, el('span.tiny', { text: '周' }),
  ]);
  weekMode.addEventListener('change', () => { rangeRow.hidden = weekMode.value !== 'range'; });

  // 编辑已有课程时，尽量还原它的周次形态
  if (course?.weeks?.length) {
    const ws = [...course.weeks].sort((a, b) => a - b);
    const allOf = (n) => Array.from({ length: n }, (_, i) => i + 1);
    const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    if (eq(ws, allOf(termWeeks))) weekMode.value = 'all';
    else if (eq(ws, allOf(termWeeks).filter((w) => w % 2 === 1))) weekMode.value = 'odd';
    else if (eq(ws, allOf(termWeeks).filter((w) => w % 2 === 0))) weekMode.value = 'even';
    else {
      weekMode.value = 'range';
      rangeRow.hidden = false;
      rangeFrom.value = String(ws[0]);
      rangeTo.value = String(ws[ws.length - 1]);
    }
  }

  function resolveWeeks() {
    const all = Array.from({ length: termWeeks }, (_, i) => i + 1);
    if (weekMode.value === 'all') return all;
    if (weekMode.value === 'odd') return all.filter((w) => w % 2 === 1);
    if (weekMode.value === 'even') return all.filter((w) => w % 2 === 0);
    const a = Math.max(1, Number(rangeFrom.value) || 1);
    const b = Math.min(termWeeks, Number(rangeTo.value) || termWeeks);
    return all.filter((w) => w >= Math.min(a, b) && w <= Math.max(a, b));
  }

  function resolveSections() {
    const a = Number(fromSel.value);
    const b = Number(toSel.value);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const out = [];
    for (let i = lo; i <= hi; i += 1) out.push(i);
    return out;
  }

  const field = (label, node, hint) => el('label.custom-field', {}, [
    el('span', { text: label }),
    node,
    hint ? el('span.tiny', { text: hint }) : null,
  ]);

  // 保存按钮要放在 footer 里，但 footer 是在 openModal 返回之前构造的，
  // 所以先建节点、等 ctl 有了再绑 close（与 editor.js 同一个写法）。
  const saveBtn = el('button.btn.btn-primary', { text: isEdit ? '保存' : '添加' });
  const cancelBtn = el('button.btn', { text: '取消' });

  const ctl = openModal({
    title: isEdit ? '编辑自定义课程' : '添加自定义课程',
    width: '520px',
    body: [
      el('p.tiny', {
        text: isEdit
          ? '改完保存即可。它会和校内课程一起出现在课程表里。'
          : '校内课表里没有的课（网课、培训、旁听、跨校课）在这里手工加。参数和校内课程一样，所以会出现在同一张课程表里，也能设提醒。',
      }),
      field('课程名称 *', nameInput),
      el('div.field-grid', {}, [
        field('课程代码', codeInput, '可留空'),
        field('任课 / 老师', teacherInput, '可留空'),
      ]),
      field('上课地点', placeInput, '线上线下都行，随便写'),
      el('div.field-grid', {}, [
        field('星期几 *', el('div.chip-row', {}, dayBtns)),
      ]),
      el('div.field-grid', {}, [
        field('第几节 *', el('div.deadline-units', {}, [
          el('span.tiny', { text: '从' }), fromSel, el('span.tiny', { text: '到' }), toSel,
        ])),
      ]),
      field('上到哪几周 *', el('div.deadline-units', {}, [weekMode]), null),
      rangeRow,
      field('备注', noteInput),
      el('p.tiny', {
        text: '如果这门课一周上两次（比如周一和周三），保存后再点一次「添加自定义课程」加第二条即可 —— 同名的会算作同一门课。',
      }),
    ],
    footer: [el('div.spacer'), cancelBtn, saveBtn],
  });

  cancelBtn.addEventListener('click', () => ctl.close());
  saveBtn.addEventListener('click', async () => {
    const title = nameInput.value.trim();
    if (!title) { toast({ title: '课程名称不能为空', kind: 'err' }); return; }
    const day = Number(dayBtns.find((b) => b.getAttribute('aria-pressed') === 'true')?.dataset.day || 0);
    if (!day) { toast({ title: '请选一个星期几', kind: 'err' }); return; }
    const sections = resolveSections();
    const weeks = resolveWeeks();
    if (!weeks.length) { toast({ title: '周次范围不对', kind: 'err' }); return; }

    // 同一门课（同名或同代码）的多次上课共用 key，这样 courses 表里是一门课、
    // meetings 里列出所有时段；事件 id 再带上星期与节次，避免互相覆盖。
    const base = course?.key || `custom:${codeInput.value.trim() || title}`;
    saveBtn.disabled = true;
    try {
      await store.importCourses({
        courses: [{
          key: base,
          eventKey: `course:${base}|${day}|${sections.join(',')}`,
          title,
          code: codeInput.value.trim(),
          teacher: teacherInput.value.trim(),
          location: placeInput.value.trim(),
          dayOfWeek: day,
          sections,
          weeks,
          note: noteInput.value.trim(),
        }],
        meta: {
          source: 'custom',
          // ⚠️ 必须把作息表一起提交：store 用它把"第几节"换算成具体时刻。
          //    不传的话服务端退回硬编码的 08:00，下午的课会被排到早上（踩过）。
          sectionTimes,
          termWeeks,
        },
        mode: 'merge',
      });
      toast({ title: isEdit ? '已保存' : '已添加', body: `${title} · 周${'日一二三四五六'[day]} 第${sections.join(',')}节` });
      ctl.close();
      opts.onDone?.();
    } catch (err) {
      toast({ title: '保存失败', body: err.message, kind: 'err', timeout: 5000 });
      saveBtn.disabled = false;
    }
  });
}
