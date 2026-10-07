// 课表导入：标准中间格式 → 校验 → 预览 → 落库。
import { el, mount } from '../dom.js';
import * as store from '../../adapter/store.js';
import { toast } from '../toast.js';
import { openModal } from '../modal.js';
import { adaptTimetable, detectProfile, PROFILES } from '../../../core/import-adapter.js';

const DEMO = {
  meta: {
    source: '演示数据',
    termStart: nextMonday(),
    termWeeks: 18,
    sectionTimes: [
      { index: 1, start: '08:00', end: '08:45' },
      { index: 2, start: '08:55', end: '09:40' },
      { index: 3, start: '10:00', end: '10:45' },
      { index: 4, start: '10:55', end: '11:40' },
      { index: 5, start: '14:00', end: '14:45' },
      { index: 6, start: '14:55', end: '15:40' },
      { index: 7, start: '16:00', end: '16:45' },
      { index: 8, start: '16:55', end: '17:40' },
      { index: 9, start: '19:00', end: '19:45' },
      { index: 10, start: '19:55', end: '20:40' },
    ],
  },
  courses: [
    { title: '高等数学', teacher: '李老师', location: '教三 305', dayOfWeek: 1, sections: [1, 2], weeks: range(1, 16) },
    { title: '大学英语', teacher: 'Amy', location: '外语楼 204', dayOfWeek: 2, sections: [3, 4], weeks: range(1, 16) },
    { title: '数据结构', teacher: '王老师', location: '计算机楼 401', dayOfWeek: 3, sections: [1, 2], weeks: range(1, 18) },
    { title: '数据结构实验', teacher: '王老师', location: '机房 A', dayOfWeek: 5, sections: [5, 6], weeks: range(3, 18, 2), tags: ['实验'] },
    { title: '大学物理', teacher: '张老师', location: '理科楼 108', dayOfWeek: 3, sections: [5, 6], weeks: range(1, 18) },
    { title: '体育（篮球）', teacher: '刘老师', location: '东体育馆', dayOfWeek: 4, sections: [7, 8], weeks: range(1, 16) },
    { title: '中国近现代史纲要', teacher: '陈老师', location: '文科楼 302', dayOfWeek: 5, sections: [1, 2], weeks: range(1, 16) },
  ],
};

function range(from, to, step = 1) {
  const out = [];
  for (let i = from; i <= to; i += step) out.push(i);
  return out;
}

function nextMonday() {
  const d = new Date();
  const dow = d.getDay();
  const delta = dow === 0 ? 1 : 8 - dow;
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 这段文本是不是"二进制被当文本读了"。
 *
 * 用途：用户选了个老式 .xls（二进制）时，`readAsText` 会产出一堆替换字符
 * （U+FFFD）和控制字符。直接塞进文本框，用户看到的是乱码，完全不知道
 * 该怎么办。这里先判出来，给一句"请改导 CSV"的明确提示。
 */
function looksBinary(text) {
  if (typeof text !== 'string' || !text.length) return false;
  const sample = text.slice(0, 2000);
  let bad = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0);
    if (c === 0xfffd) bad += 2;                       // 解码失败的替换字符，权重高
    else if (c === 0 || (c < 0x09) || (c > 0x0d && c < 0x20)) bad += 1;
  }
  return bad / sample.length > 0.02;                  // 2% 以上就判定为二进制
}

/**
 * 从异常里取一句人话。
 *
 * ⚠️ 不能直接插值 `err.message` —— 如果抛出来的不是 Error（比如字符串、
 *    或者 undefined），`err.message` 就是 undefined，界面会显示字面的
 *    "undefined"（用户报过"操作时显示 undefined"）。这里保证永远返回字符串。
 */
function errText(err) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  if (err === undefined || err === null) return '未知错误（没有错误信息）';
  try {
    const s = JSON.stringify(err);
    return s && s !== '{}' ? s : String(err);
  } catch {
    return String(err);
  }
}

export const importView = {
  id: 'import',
  label: '导入课表',
  icon: '⇪',

  title() { return '导入课表'; },
  subtitle() { return '粘贴或导入课表数据（通用 JSON）'; },
  nav() { return []; },
  onNav() {},

  render(state, ctx, host) {
    // ===== 粘贴课表数据（本机适配器 core/import-adapter.js，纯函数）=====
    // 适配器是纯函数（core/import-adapter.js）：把这份数据转成可导入的课程。
    const profileSel = el('select', {}, [
      el('option', { value: 'auto', text: '自动识别' }),
      ...Object.entries(PROFILES).map(([key, p]) => el('option', { value: key, text: p.label })),
    ]);
    const profileHint = el('p.tiny');
    profileSel.addEventListener('change', () => {
      const k = profileSel.value;
      profileHint.textContent = k === 'auto'
        ? '自动识别：按字段特征猜测来源'
        : (PROFILES[k]?.hint || '');
    });

    const dataArea = el('textarea.code', {
      spellcheck: 'false',
      placeholder: '把课表 JSON 粘贴到这里（最小字段：title / dayOfWeek / sections / weeks），也可以点下面的「选择文件」',
    });
    const reportBox = el('div');
    const termStartInput = el('input', {
      type: 'date',
      value: state.settings?.termStart || nextMonday(),
      style: { width: '160px' },
    });

    const runImport = async () => {
      const raw = dataArea.value.trim();
      mount(reportBox);
      if (!raw) { toast({ title: '先把课表数据粘进来', kind: 'err' }); return; }

      // 先在本地把这份数据适配成可导入的课程（纯函数、平台无关），
      let adapted;
      try {
        adapted = adaptTimetable(raw, {
          profile: profileSel.value === 'auto' ? undefined : profileSel.value,
          termStart: termStartInput.value || '',
          termWeeks: state.settings?.termWeeks,
          sectionTimes: state.settings?.sectionTimes,
        });
      } catch (err) {
        mount(reportBox, el('div.import-report', {}, [
          el('b', { text: '❌ 解析失败' }),
          el('p.tiny', { text: errText(err) }),
        ]));
        return;
      }

      if (adapted.fatal) {
        mount(reportBox, el('div.import-report', {}, [
          el('b', { text: '❌ 认不出这份数据' }),
          el('p.tiny', { text: adapted.fatal }),
          el('p.tiny', { text: `识别为：${PROFILES[adapted.profile]?.label || adapted.profile}` }),
        ]));
        return;
      }

      if (!termStartInput.value) {
        toast({ title: '请填学期第一周的周一', body: '课表数据里没有开学日期，这个必须你来定', kind: 'err' });
        return;
      }

      // 合并/替换一律由用户选：导错了能重来，不会让旧课赖着。
      const mode = await askMode({
        stats: { count: adapted.stats?.courses ?? adapted.stats?.importedCourses ?? adapted.courses?.length ?? 0 },
      });
      if (!mode) return;   // 用户取消
      try {
        const res = await store.importCourses({
          courses: adapted.courses,
          meta: { ...adapted.meta, termStart: termStartInput.value },
          mode,
        });
        if (res.ok === false) throw new Error(res.error || '导入失败');
        // ⚠️ 统计字段在各条路径上并不统一，必须**逐个兜底**，否则界面会显示字面的
        //    "undefined"（用户报过"操作时显示 undefined"）。
        //    实际存在过的几种形状：
        //      · core/import-adapter.js 的 stats: {courses, meetings}
        //      · /api/courses/import 返回 {added, skipped, total, problems}
        //    所以统一用 pick() 按优先级取第一个"像数字的"值。
        const pick = (...vals) => {
          for (const v of vals) {
            if (typeof v === 'number' && Number.isFinite(v)) return v;
          }
          return '?';
        };
        const courses = pick(adapted.stats?.courses, adapted.stats?.importedCourses, res.added);
        const meetings = pick(adapted.stats?.meetings, res.added);
        const totalCourses = res.total;
        mount(reportBox, el('div.import-report', {}, [
          el('b.report-ok', { text: '✅ 导入完成' }),
          el('p', {
            style: { marginTop: '6px' },
            text: `来源「${PROFILES[adapted.profile]?.label || adapted.profile}」：`
              + `${courses} 门课 / ${meetings} 节课`
              + (typeof totalCourses === 'number' ? ` · 课程表共 ${totalCourses} 门` : ''),
          }),
          adapted.problems?.length
            ? el('ul', {}, adapted.problems.map((p) => el('li', { text: `提示：${p}` })))
            : null,
        ]));
        toast({ title: '导入完成', body: `${courses} 门课已排进课表` });
        ctx.refresh();
      } catch (err) {
        mount(reportBox, el('div.import-report', {}, [
          el('b', { text: '❌ 导入失败' }),
          el('p.tiny', { text: errText(err) }),
        ]));
      }
    };

    const filePicker = el('input', {
      // 也可以选文件：把课表 JSON 存成文件再选进来，比复制粘贴省事。
      type: 'file', accept: '.json,.txt,application/json', style: { display: 'none' },
      onchange: (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        // 老式 .xls 是二进制，readAsText 读出来是乱码。先看一眼文件头，
        // 直接告诉用户"请导 CSV"，而不是把乱码丢进文本框让他自己猜。
        const reader = new FileReader();
        reader.onload = () => {
          const text = String(reader.result ?? '');
          const bin = looksBinary(text);
          if (bin) {
            mount(reportBox, el('div.import-report', {}, [
              el('b', { text: '❌ 这个文件是二进制格式，读不了' }),
              el('p.tiny', {
                text: `「${file.name}」看起来是二进制文件（老式 Excel 或压缩包），读不出文本。`
                  + '请把它另存为 JSON / 纯文本再试一次。',
              }),
            ]));
            return;
          }
          dataArea.value = text;
        };
        reader.readAsText(file, 'utf-8');
      },
    });

    // ===== 路径二：标准 JSON（原有能力，保留）=====
    const textarea = el('textarea.code', {
      spellcheck: 'false',
      placeholder: '把课表 JSON 粘贴到这里，或点「载入示例」看看格式',
    });
    const reportHost = el('div');
    let lastParsed = null;

    function validate() {
      const raw = textarea.value.trim();
      mount(reportHost);
      lastParsed = null;
      if (!raw) return;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        mount(reportHost, el('div.import-report', {}, [
          el('b', { text: '❌ JSON 格式错误' }),
          el('p.tiny', { text: errText(err) }),
        ]));
        return;
      }
      const result = validatePayload(parsed);
      lastParsed = result.ok ? result : null;
      mount(reportHost, renderReport(result, doImport));
      return result;
    }

    textarea.addEventListener('input', debounce(validate, 350));

    const loadDemo = () => {
      textarea.value = JSON.stringify(DEMO, null, 2);
      validate();
    };

    const fileInput = el('input', {
      type: 'file', accept: '.json,application/json', style: { display: 'none' },
      onchange: (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => { textarea.value = String(reader.result); validate(); };
        reader.readAsText(file, 'utf-8');
      },
    });

    const doImport = async () => {
      const result = validate();
      if (!result || !result.ok) {
        toast({ title: '先修正数据再导入', kind: 'err' });
        return;
      }
      const mode = await askMode(result);
      if (!mode) return;
      try {
        const res = await store.importCourses({
          meta: result.meta, courses: result.courses, mode,
        });
        toast({
          title: '导入完成',
          body: `新增 ${res.added} 门 · 覆盖后共 ${res.total} 门` + (res.skipped ? ` · 跳过 ${res.skipped}` : ''),
        });
        ctx.setView('course');
        ctx.refresh();
      } catch (err) {
        toast({ title: '导入失败', body: errText(err), kind: 'err', timeout: 6000 });
      }
    };

    mount(host, el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px' } }, [
      el('div.card.panel', {}, [
        el('h2', { text: '① 粘贴数据 / 选文件（通用 JSON）' }),
        el('p.tiny', {
          text: '把课表 JSON 粘贴到下面的框里，或者点「选择文件」把 .json 选进来。'
            + '适配器先在本机把它转成可导入的课程，再让你确认合并还是替换。',
        }),
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
          el('span.bubble-tool-label', { text: '数据来源' }),
          profileSel,
        ]),
        el('p.tiny', { id: 'profile-hint', text: PROFILES[detectProfile('')]?.hint || '' }),
        dataArea,
        el('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } }, [
          el('span.bubble-tool-label', { text: '学期第一周周一' }),
          termStartInput,
          el('button.btn.btn-primary', { text: '导入', onclick: runImport }),
          el('button.btn.btn-sm', { text: '选择文件', onclick: () => filePicker.click() }),
          el('button.btn.btn-sm', { text: '清空', onclick: () => { dataArea.value = ''; mount(reportBox); } }),
          filePicker,
        ]),
        el('p.tiny', {
          text: '为什么要填开学日期：课表数据只记录"第几周星期几"，不给学期起点，所以第一周周一只能从你这里拿。',
        }),
        reportBox,
      ]),

      el('div.card.panel', {}, [
        el('h2', { text: '② 标准 JSON（校验与预览）' }),
        el('p.tiny', { text: '最小可用字段：title / dayOfWeek / sections / weeks。格式见 README.md。' }),
        textarea,
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
          el('button.btn.btn-sm', { text: '载入示例', onclick: loadDemo }),
          el('button.btn.btn-sm', { text: '选择 JSON 文件', onclick: () => fileInput.click() }),
          el('button.btn.btn-sm', {
            text: '下载格式模板',
            onclick: () => downloadJson('timetable-import-template.json', DEMO),
          }),
          el('button.btn.btn-sm', {
            text: '导出当前课程',
            onclick: () => downloadJson('timetable-courses.json', {
              meta: { source: 'export', termStart: store.getState().settings.termStart, termWeeks: store.getState().settings.termWeeks, sectionTimes: store.getState().settings.sectionTimes || [] },
              courses: store.getState().courses.map((c) => ({
                title: c.title, teacher: c.teacher, location: c.location,
                dayOfWeek: c.dayOfWeek, sections: c.sections, weeks: c.weeks,
              })),
            }),
          }),
          fileInput,
        ]),
        reportHost,
        el('p.tiny', { text: '校验通过后下方会出现「导入」按钮。' }),
      ]),
    ]));

    if (state.courses.length) {
      const report = el('div.import-report', {}, [
        el('b', { text: `当前已有 ${state.courses.length} 门课` }),
        el('ul', {}, state.courses.slice(0, 12).map((c) => {
          // 一门课可能有多段（如周一 1-3 节 + 周三 5-6 节），全部列出来
          const ms = Array.isArray(c.meetings) && c.meetings.length
            ? c.meetings
            : [{ dayOfWeek: c.dayOfWeek, sections: c.sections, weeks: c.weeks }];
          const desc = ms.map((m) => `周${'日一二三四五六'[m.dayOfWeek]} 第${(m.sections || []).join(',')}节`).join(' + ');
          const weeks = Math.max(...ms.map((m) => (m.weeks || []).length));
          return el('li', {
            text: `${c.title} · ${desc} · ${weeks} 周`,
            style: { color: 'var(--muted)' },
          });
        })),
        state.courses.length > 12 ? el('p.tiny', { text: `…等共 ${state.courses.length} 门` }) : null,
      ]);
      host.querySelector('.card.panel:last-child')?.appendChild(report);
    }

  },
};

function validatePayload(parsed) {
  const problems = [];
  const courses = Array.isArray(parsed) ? parsed : (parsed.courses || []);
  const meta = Array.isArray(parsed) ? {} : (parsed.meta || {});

  if (!Array.isArray(courses) || !courses.length) {
    return { ok: false, problems: ['没有 courses 数组，或数组为空'] };
  }
  if (meta.termStart && !/^\d{4}-\d{2}-\d{2}$/.test(meta.termStart)) {
    problems.push(`meta.termStart 应为 YYYY-MM-DD，当前是「${meta.termStart}」`);
  }
  const sectionIndexes = new Set((meta.sectionTimes || []).map((s) => Number(s.index)));

  const clean = [];
  courses.forEach((c, i) => {
    const label = c && c.title ? c.title : `第 ${i + 1} 条`;
    if (!c || typeof c !== 'object') { problems.push(`${label}：不是对象`); return; }
    if (!c.title) problems.push(`${label}：缺少 title`);
    const day = Number(c.dayOfWeek);
    if (!(day >= 1 && day <= 7)) problems.push(`${label}：dayOfWeek 应为 1–7（1=周一）`);
    const sections = (c.sections || []).map(Number).filter((n) => n > 0);
    if (!sections.length) problems.push(`${label}：缺少 sections（节次）`);
    if (sectionIndexes.size) {
      sections.forEach((s) => {
        if (!sectionIndexes.has(s)) problems.push(`${label}：节次 ${s} 不在 meta.sectionTimes 中`);
      });
    }
    const weeks = (c.weeks || []).map(Number).filter((n) => n > 0);
    if (!weeks.length) problems.push(`${label}：缺少 weeks（上课周次），将默认全学期`);

    clean.push({
      title: String(c.title || '').trim(),
      teacher: c.teacher || '',
      location: c.location || '',
      dayOfWeek: day,
      sections,
      weeks,
      tags: c.tags || [],
    });
  });

  const errors = problems.filter((p) => /缺少|不是对象|应为/.test(p));
  const warnings = problems.filter((p) => !errors.includes(p));
  const weekMax = Math.max(0, ...clean.flatMap((c) => c.weeks));

  return {
    ok: errors.length === 0,
    problems,
    errors,
    warnings,
    meta: {
      source: meta.source || 'manual',
      termStart: meta.termStart || '',
      termWeeks: Number(meta.termWeeks) || Math.max(weekMax, 20),
      sectionTimes: meta.sectionTimes || [],
    },
    courses: clean,
    stats: { count: clean.length, weekMax, hasSectionTimes: !!sectionIndexes.size },
  };
}

function renderReport(result, onImport) {
  if (!result.stats) {
    return el('div.import-report', {}, [
      el('b', { text: '❌ 校验未通过' }),
      el('ul', {}, result.problems.map((p) => el('li', { text: p }))),
    ]);
  }
  const { stats, errors, warnings } = result;
  return el('div.import-report', {}, [
    el('b', {
      class: result.ok ? 'report-ok' : '',
      text: result.ok ? '✅ 校验通过' : '❌ 校验未通过',
    }),
    el('p', {
      style: { marginTop: '6px' },
      text: `共 ${stats.count} 门课 · 最长 ${stats.weekMax} 周 · ` +
        (stats.hasSectionTimes ? '含节次时间表（课表网格更准确）' : '未提供节次时间表（按节次推导）'),
    }),
    errors.length ? el('ul', {}, errors.map((p) => el('li', { text: `错误：${p}` }))) : null,
    warnings.length ? el('ul', {}, warnings.map((p) => el('li', { text: `提示：${p}` }))) : null,
    result.ok ? el('div', { style: { marginTop: '10px' } }, [
      el('button.btn.btn-primary', { text: '导入这些课程', onclick: () => onImport && onImport() }),
    ]) : null,
  ]);
}

function askMode(result) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const ctl = openModal({
      title: '导入方式',
      width: '440px',
      body: [
        el('p', { text: `即将导入 ${result.stats.count} 门课程。请选择处理方式：`, style: { fontSize: '13.5px' } }),
        el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
          el('button.btn.btn-primary', {
            text: '合并（推荐）· 相同课程覆盖，其它保留',
            onclick: () => { done('merge'); ctl.close(); },
          }),
          el('button.btn.btn-danger', {
            text: '替换 · 清空已有课程后重新导入',
            onclick: () => { done('replace'); ctl.close(); },
          }),
          el('button.btn', { text: '取消', onclick: () => ctl.close() }),
        ]),
      ],
      onClose: () => done(null),
    });
    void ctl;
  });
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
