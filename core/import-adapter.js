// 通用课表导入适配器：把一份课表 JSON 归一成 store.importCourses 能吃的形态。
//
// 为什么要有这一层：
//   课表来源是会变的 —— 别人的 json、手抄的表、自己写的脚本导出。
//   与其每来一个来源就改一遍 UI 和服务端，不如**统一到一个入口**：
//   传原始数据 + 一个 profile 名，适配器负责挑课、挑字段、收尾。
//
// 平台无关（core/）：不碰网络、不碰 DOM —— 安卓壳子复用同一份。
//
// 目前实现：`generic` —— `{courses:[{title,dayOfWeek,sections,weeks,...}]}`

/** 默认作息：11 节，每节 45 分钟。调用方可以用 opts.sectionTimes 覆盖。 */
export const DEFAULT_SECTION_TIMES = [
  { index: 1, start: '08:00', end: '08:45' },
  { index: 2, start: '08:50', end: '09:35' },
  { index: 3, start: '10:00', end: '10:45' },
  { index: 4, start: '10:50', end: '11:35' },
  { index: 5, start: '13:30', end: '14:15' },
  { index: 6, start: '14:20', end: '15:05' },
  { index: 7, start: '15:30', end: '16:15' },
  { index: 8, start: '16:20', end: '17:05' },
  { index: 9, start: '18:30', end: '19:15' },
  { index: 10, start: '19:20', end: '20:05' },
  { index: 11, start: '20:10', end: '20:55' },
];

/** 默认学期周数（16 周）。调用方可以用 opts.termWeeks 覆盖。 */
export const DEFAULT_TERM_WEEKS = 16;

/** 支持的来源档案。新增来源只需要在这里加一条 + 一个适配函数。 */
export const PROFILES = {
  generic: {
    label: '通用格式',
    hint: '{ courses: [{ title, dayOfWeek, sections, weeks, location, teacher }] }',
  },
};

/** 猜一下这份数据像哪个档案（字段名很特征，猜错也能手动指定） */
export function detectProfile(input) {
  // 只认通用格式：JSON（或对象）里带 courses[]，每项有 dayOfWeek。
  const data = typeof input === 'string' ? tryJson(input) : input;
  if (!data) return 'generic';
  // 通用：courses[] 且每项已有 dayOfWeek
  if (Array.isArray(data.courses) && data.courses.some((c) => c && c.dayOfWeek)) return 'generic';
  // 数组本身
  if (Array.isArray(data) && data.some((c) => c && c.dayOfWeek)) return 'generic';
  // 猜不出来也按通用走 —— adaptGeneric 会给出一条能看懂的问题
  return 'generic';
}

function tryJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 统一入口：把任意来源的数据转成可导入的形态。
 *
 * @param {string|object} input 原始数据（JSON 字符串或对象）
 * @param {{profile?:string, termStart?:string, termWeeks?:number, sectionTimes?:Array, planId?:string}} opts
 * @returns {{courses:Array, meta:object, stats:object, problems:string[], profile:string}}
 */
export function adaptTimetable(input, opts = {}) {
  const profile = opts.profile && PROFILES[opts.profile] ? opts.profile : detectProfile(input);

  return adaptGeneric(input, opts);
}

// ---------------------------------------------------------------------------
// 通用格式：{ courses: [{ title, dayOfWeek, sections, weeks, location, teacher }] }
// ---------------------------------------------------------------------------

function adaptGeneric(input, opts) {
  const data = typeof input === 'string' ? tryJson(input) : input;
  if (!data) {
    return fail('generic', '不是合法 JSON');
  }
  const list = Array.isArray(data) ? data : (data.courses || []);
  if (!Array.isArray(list) || !list.length) {
    return fail('generic', '没有 courses 数组，或数组为空');
  }

  const courses = [];
  const problems = [];
  for (const c of list) {
    const title = String(c?.title || c?.name || '').trim();
    const day = Number(c?.dayOfWeek ?? c?.day);
    const sections = (c?.sections || []).map(Number).filter(Boolean);
    const weeks = (c?.weeks || []).map(Number).filter(Boolean);
    if (!title || !day || !sections.length) {
      problems.push(`跳过无效课程：${title || '(无名称)'}（缺 title / dayOfWeek / sections）`);
      continue;
    }
    courses.push({
      key: c.key || `generic:${title}`,
      eventKey: c.eventKey || `course:generic:${title}|${day}|${sections.join(',')}`,
      title,
      teacher: c.teacher || '',
      location: c.location || '',
      dayOfWeek: day,
      sections,
      weeks: weeks.length ? weeks : Array.from({ length: opts.termWeeks || DEFAULT_TERM_WEEKS }, (_, i) => i + 1),
      level: c.level || 'emerald',
    });
  }

  return {
    profile: 'generic',
    courses,
    meta: {
      source: 'generic',
      termStart: opts.termStart || '',
      termWeeks: Number(opts.termWeeks) || DEFAULT_TERM_WEEKS,
      sectionTimes: opts.sectionTimes || DEFAULT_SECTION_TIMES,
    },
    stats: { courses: courses.length, meetings: courses.length },
    problems,
  };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
function fail(profile, message) {
  return {
    profile,
    courses: [],
    meta: { source: profile, termStart: '', termWeeks: DEFAULT_TERM_WEEKS, sectionTimes: DEFAULT_SECTION_TIMES },
    stats: { courses: 0, meetings: 0 },
    problems: [message],
    fatal: message,
  };
}

