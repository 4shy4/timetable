// 三档预设（v0.11.0「简约版」）—— **唯一真源**。
//
// 用户原话："返璞归真增加简约版"。两条已经拍板的产品决定：
//   · **极简档必须保留节日**（节日图案与节日泡泡都留）
//   · **三档都只改开关、绝不动用户数据**（数据安全优先于省事）
//
// 为什么这一份必须住在 core/：
//   · 三端共用（网页 / 安卓 / iOS 壳）。iOS 那侧是 JavaScriptCore，**没有 window**，
//     所以这份逻辑不能放 web/；
//   · 它要被测试钉住（tools/presets.test.mjs 是这次交付的验收核心），
//     而"能测"的前提是纯函数 + 平台无关。
//   平台无关（不碰 node: / window / document / Buffer / fetch / localStorage），见 tools/core.test.mjs。
//
// ---------------------------------------------------------------------------
// 六条硬规矩（改动之前先读完；每一条都对应一个真会咬人的坑）
// ---------------------------------------------------------------------------
// ① **预设只改开关，绝不动数据。**
//    只写下面 PRESET_SWITCHES 里登记的那些路径。`events` / `courses` 根本不在 settings 里，
//    这些**装着用户东西**的字段一个字节都不碰（测试④按"逐叶子对账"钉死）。
//
// ② **绝不自动改隐私 / 花钱路径。**
//    `lan`（要重启服务）**都不在**预设能写的名单里。这是本项目既有的铁律：
//    不许静默改变隐私/计费路径。
//    预设因此永远不会静默改变隐私 / 计费路径。
//
// ③ **关掉的功能不许发任何请求。**
//    公开版里"要出网"的功能已经随模块删掉了（大模型聊天 / 节日群发 / 热点），
//    这一条仍然成立：剩下能出网的只有"连电脑同步"，而那是用户显式打开的。
//
// ④ **幂等 + 可逆。**
//    每一档都把**它管的所有开关**显式写一遍（而不是"只写这次要改的那几个"）。
//    这样"连按两次"结果相同（幂等），"极简→全功能→极简"回到**逐字节相同**的一份（可逆）。
//    只写差量的写法做不到可逆：切回去的时候没人知道该还原成什么值。
//
// ⑤ **不写"每台设备自己的显示偏好"。**
//    `bubbleView.horizonDays` / `bubbleView.showCourse` / `bubbleView.showDone` /
//    `bubbleView.festivalDays` 一律**不碰**。两层理由：
//      · "极简档必须保留节日"的最强保证，就是**预设根本没有把节日关掉的能力**；
//      · 网页那侧这些偏好的真值在 **localStorage**（见 web/ui/views/bubble.js 的
//        readConfig / syncBubbleView），而 syncBubbleView 是**单向** web→settings：
//        预设写进去的值会被气泡区下一次渲染用 localStorage 的值**覆盖回来** ——
//        那种"我改过，它自己又变回去了"正是本项目最恨的症状。
//    唯一允许改 `bubbleView.festivalDays` 的是**引导页里用户亲口回答的那一问**
//    （见 applyAnswers：他当场说"不要节日"才算数）。
//
// ⑥ **不许发明键名。**
//    PRESET_SWITCHES 里的每一条路径都必须在 `core/defaults.js` 的 `defaultDb().settings`
//    里**登记过**（否则 mergeDefaults 补不上、老库读出来是 undefined —— 这正是
//    `courseDigest` 在真机上炸过一次的那条坑）。测试③机械化对账：多一个就红。
//
// ⚠️ 另一条容易看漏的合并坑（测试⑦专门抓它）：
//    `core/state-ops.js` 的 `updateSettings` 是**浅合并**，其中
//    而 `courseDigest` **不在**那份名单里 —— 给它发 `{courseDigest:{enabled:true}}`
//    会把 `slots` / `perCourseReminders` **整个冲掉**。
//    所以 `settingsPatch()` 对"逐字段合并"的容器只给改动的字段，
//    对其余容器（当前就是 `courseDigest`）**整份带上**。

import { BUBBLE_VIEW_DEFAULTS } from './bubble-select.js';

// ---------------------------------------------------------------------------
// 开关登记表
// ---------------------------------------------------------------------------


/** 一条开关：三档各取什么值。`kind` 只影响界面上怎么说（开/关 vs 设成 N）。 */
function sw(path, label, simple, standard, full, kind = 'bool') {
  return Object.freeze({ path, label, kind, values: Object.freeze({ simple, standard, full }) });
}

/**
 * 预设**能写的全部开关**（顺序就是界面上列出差异的顺序）。
 *
 * ⚠️ 这里每一条都必须是 `core/defaults.js` 里登记过的真实键 —— 见文件头第 ⑥ 条。
 */
export const PRESET_SWITCHES = Object.freeze([
  // ---- 提醒。三档全开：极简档的定义就是"泡泡区 + 提醒 + 新建/编辑 + 课程" ----
  sw('notify.desktop', '系统通知（电脑）', true, true, true),
  sw('notify.browser', '浏览器通知（页面开着时）', true, true, true),
  sw('notify.sound', '提示音', true, true, true),
  // ---- 「周期」的生效范围：只有全功能档才连提醒/日历一起筛 ----
  sw('periodAffectsReminders', '周期也管提醒', false, false, true),
  sw('periodAffectsCalendar', '周期也管日历订阅', false, false, true),
  // ---- 课程摘要提醒（"什么时候提醒你上课"那一组的总开关）----
  sw('courseDigest.enabled', '课程摘要提醒', false, false, true),
  // ---- 本地活动日记：**记在本地**的总闸 ----
  sw('activitySettings.enabled', '本地活动日记（只记在本机）', false, false, true),
]);

/** 档位顺序（界面按这个顺序出三个按钮，报告里的矩阵也是这个顺序） */
export const PRESET_KEYS = Object.freeze(['simple', 'standard', 'full']);

/** 推荐的默认档。⚠️ 它**不是** `settings.preset` 的缺省值（那是空串，见 core/defaults.js）。 */
export const DEFAULT_PRESET = 'standard';

const TIER_META = Object.freeze({
  simple: Object.freeze({
    key: 'simple',
    label: '极简',
    desc: '只有泡泡区、提醒、新建/编辑和课表。节日照旧，其余全部关掉。',
  }),
  standard: Object.freeze({
    key: 'standard',
    label: '标准',
    desc: '在极简的基础上加「课程摘要提醒」和「让周期也管提醒 / 日历」。',
  }),
  full: Object.freeze({
    key: 'full',
    label: '全功能',
    desc: '所有开关全打开（活动日记、课程摘要、周期的生效范围）。',
  }),
});

/** 把一条开关在三档下的值摊成 `{simple:…, standard:…, full:…}` 的扁平路径表 */
function patchOf(key) {
  const out = {};
  for (const s of PRESET_SWITCHES) out[s.path] = s.values[key];
  // ⚠️ `preset` 本身也要写：设置页要显示"当前是哪一档"，而它必须是**存储键**
  //    （`core/defaults.js` 里登记过）。测试③会把它一起对账。
  out.preset = key;
  return out;
}

/**
 * 三档预设。每一项：`{key, label, desc, patch}`，`patch` 是**扁平路径 → 值**。
 *
 * ⚠️ `patch` 是**完整**的一份（不是差量）—— 见文件头第 ④ 条（幂等 + 可逆靠它）。
 */
export const PRESETS = Object.freeze(PRESET_KEYS.map((key) => Object.freeze({
  ...TIER_META[key],
  patch: Object.freeze(patchOf(key)),
})));

/**
 * 按 key 取一档；**未知 key（含空串）给 null**，绝不"顺手兜个默认档"。
 *
 * ⚠️ 为什么不兜默认档：设置页/引导页会把用户点的那一档原样传进来，
 *    真要兜底的话一个拼错的 key 会**静默应用另一档** —— 用户看到的是
 *    "我点极简，怎么变成标准了"。未知 = 什么都不做（见 applyPreset）。
 */
export function presetByKey(key) {
  const k = String(key == null ? '' : key);
  return PRESETS.find((p) => p.key === k) || null;
}

/** 一档会写的全部路径（排序后）。给测试③和界面用。 */
export function presetPaths(key) {
  const p = presetByKey(key);
  return p ? Object.keys(p.patch).sort() : [];
}

// ---------------------------------------------------------------------------
// 小工具（全部纯函数，不抛错）
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 选项/设置对象兜底：只认普通对象（null / 数组 / 字符串一律当空对象，别再崩一次） */
function objOf(v) {
  return isPlainObject(v) ? v : {};
}

/**
 * 深拷贝（只拷贝普通对象与数组，数组里逐项递归）。
 *
 * ⚠️ Date 单独拷（settings 里目前没有 Date，但 `updatedAt` 这类字段将来可能进来，
 *    用 `{...d}` 会把 Date 变成一个**普通对象**，那比不拷更糟）。
 *    其余非普通值（函数、类实例…）**按引用带过去** —— 它们是用户传进来的东西，
 *    预设不该假装能复制它们。
 */
export function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (v instanceof Date) return new Date(v.getTime());
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = deepClone(x);
    return out;
  }
  return v;
}

/** 读 `a.b.c`；中间缺任何一层就给 undefined（**不抛**） */
export function getPath(obj, path) {
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * 写 `a.b.c = value`（就地在 `obj` 上写；调用方保证 `obj` 已经是自己的一份拷贝）。
 *
 * ⚠️ **只创建缺的那几层**，已有的兄弟字段一个都不动 ——
 *    这就是"改 `courseDigest.enabled` 不会把 `slots` 冲掉"的落点。
 */
export function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/** 逐叶子路径（数组当叶子：整份替换，语义同 core/defaults.js 的 mergeDefaults） */
export function leafPaths(v, prefix = '') {
  if (Array.isArray(v) || !isPlainObject(v)) return prefix ? [prefix] : [];
  const out = [];
  for (const [k, x] of Object.entries(v)) {
    out.push(...leafPaths(x, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

/** 两个值"深度相等"吗（只认 JSON 那套 + Date；够 settings 用了） */
function sameValue(a, b) {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameValue(x, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const ka = Object.keys(a); const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
  }
  return false;
}

/** 两份 settings 之间**值变了的全部叶子路径**（`after` 里少了的不算删除，本模块不删东西） */
export function changedPaths(before, after, prefix = '') {
  const out = [];
  const a = objOf(before); const b = objOf(after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const av = a[k]; const bv = b[k];
    if (isPlainObject(av) && isPlainObject(bv)) {
      out.push(...changedPaths(av, bv, path));
      continue;
    }
    if (!sameValue(av, bv)) out.push(path);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// 应用
// ---------------------------------------------------------------------------

/**
 * 把某一档的开关应用到一份 settings 上，返回**新对象**。
 *
 * 契约（测试逐条钉住）：
 *   · **不改传进来的那个对象**（深拷贝一份再写）；
 *   · **幂等**：连应用两次，结果深度相等；
 *   · **可逆**：`simple → full → simple` 与直接 `simple` 深度相等；
 *   · **只写登记的开关**（第 ⑥ 条）+ 一个 `preset` 标记；别的字段一个字节都不动；
 *   · **未知档位 → 原样返回一份拷贝**（不抛错、不顺手兜默认档）。
 *
 * @param {object} settings 当前设置（脏值/null → 当空对象）
 * @param {string} key 'simple' | 'standard' | 'full'
 * @returns {object} 新的 settings
 */
export function applyPreset(settings, key) {
  const next = deepClone(objOf(settings));
  const preset = presetByKey(key);
  if (!preset) return next;                    // 未知档位：一个开关都不改（见 presetByKey 的说明）
  for (const [path, value] of Object.entries(preset.patch)) setPath(next, path, value);
  return next;
}

/**
 * 逐字段合并的嵌套容器（**必须与 `core/state-ops.js` 的 updateSettings 保持一致**）。
 *
 * 为什么要有这份名单：给"逐字段合并"的容器**只发改动的字段**是安全的（兄弟字段保住），
 * 而给其余容器（当前就是 `courseDigest`）必须**整份发**，否则 `slots` 会被冲掉
 * （见文件头最后那段）。测试⑦会用**真的 `updateSettings`** 走一遍，
 * 谁把名单写漂了，那条测试立刻红。
 */
const FIELD_MERGED = Object.freeze(new Set([
  'notify', 'bubbleView', 'activitySettings',
]));

/**
 * 由"两份 settings"算出一份**可以直接交给 `store.saveSettings()`** 的 patch。
 *
 * 为什么不直接整份 settings 发回去：整份发意味着把用户没改过的键也一起发回去 —— 说"整份都是干净的"没人能担保。
 * 只发改动的开关，这条风险根本不存在。。
 * 只发改动的开关，这条风险根本不存在。
 *
 * ⚠️ 本函数**只加不删**：`next` 里没有的键不会被"删除"（settings 的形状由
 *    `core/defaults.js` 的 mergeDefaults 管，不在这里删东西）。
 */
export function settingsPatch(prev, next) {
  const before = objOf(prev); const after = objOf(next);
  const out = {};
  for (const path of changedPaths(before, after)) {
    const [head, ...rest] = path.split('.');
    if (!rest.length) { out[head] = after[head]; continue; }
    if (!isPlainObject(out[head])) out[head] = {};
    setPath(out[head], rest.join('.'), getPath(after, path));
  }
  // 非"逐字段合并"的容器：整份带上（否则兄弟字段会被 updateSettings 冲掉）
  for (const head of Object.keys(out)) {
    if (!isPlainObject(out[head])) continue;
    if (FIELD_MERGED.has(head)) continue;
    out[head] = deepClone(after[head]);
  }
  return out;
}

/** 应用某一档时**真正要发给服务端的 patch**（未知档位 → 空 patch） */
export function presetPatch(settings, key) {
  const prev = objOf(settings);
  const preset = presetByKey(key);
  if (!preset) return {};
  return settingsPatch(prev, applyPreset(prev, key));
}

// ---------------------------------------------------------------------------
// 差异预览（设置页"应用之前先看清楚"用）
// ---------------------------------------------------------------------------

/**
 * 列出"换成某一档会打开 / 关掉什么"。**纯读**，不改任何东西。
 *
 * @returns {{key:string, known:boolean, label:string, desc:string,
 *   changes:Array<{path,label,kind,from,to,change:'on'|'off'|'set'}>,
 *   opens:Array, closes:Array, sets:Array}}
 *   未知档位 → `known:false`、`changes:[]`（界面据此显示"认不出这一档"，绝不崩）。
 */
export function describePresetDiff(settings, key) {
  const preset = presetByKey(key);
  const prev = objOf(settings);
  if (!preset) {
    return {
      key: String(key == null ? '' : key), known: false, label: '', desc: '',
      changes: [], opens: [], closes: [], sets: [],
    };
  }
  const changes = [];
  for (const s of PRESET_SWITCHES) {
    const from = getPath(prev, s.path);
    const to = preset.patch[s.path];
    if (sameValue(from, to)) continue;
    const change = s.kind === 'bool' ? (to === true ? 'on' : 'off') : 'set';
    changes.push({ path: s.path, label: s.label, kind: s.kind, from, to, change });
  }
  return {
    key: preset.key,
    known: true,
    label: preset.label,
    desc: preset.desc,
    changes,
    opens: changes.filter((c) => c.change === 'on'),
    closes: changes.filter((c) => c.change === 'off'),
    sets: changes.filter((c) => c.change === 'set'),
  };
}

/**
 * 现在这一份 settings 的开关组合**正好等于哪一档**（不看 `settings.preset` 标记）。
 *
 * 为什么要它：用户可以在选完档之后又手动掰几个开关。这时"当前：标准"就是**假的**。
 * 所以标记和实际组合要分别算：`presetStatusOf()` 负责把两者对起来说人话。
 */
export function currentPresetOf(settings) {
  const s = objOf(settings);
  for (const preset of PRESETS) {
    if (PRESET_SWITCHES.every((x) => sameValue(getPath(s, x.path), preset.patch[x.path]))) {
      return { key: preset.key, label: preset.label, exact: true };
    }
  }
  return { key: 'custom', label: '自定义', exact: false };
}

/**
 * 设置页/引导页顶部那行"当前档位"要说的话（**只有这一份实现**，免得两处文案漂移）。
 *
 * @returns {{chosen:string, chosenLabel:string, current:string, currentLabel:string,
 *   matches:boolean, drifted:number, text:string}}
 *   · `chosen` = `settings.preset`（可能是空串 = 从没选过）
 *   · `current` = 开关组合实际等于哪一档（`'custom'` = 跟哪一档都不完全一样）
 *   · `drifted` = 相对"它自己声称的那一档"有几个开关被手动改过
 */
export function presetStatusOf(settings) {
  const s = objOf(settings);
  const chosenPreset = presetByKey(s.preset);
  const cur = currentPresetOf(s);
  const raw = String(s.preset == null ? '' : s.preset);
  const chosen = chosenPreset ? chosenPreset.key : raw;
  const chosenLabel = chosenPreset ? chosenPreset.label : '';

  let drifted = 0;
  if (chosenPreset) {
    for (const x of PRESET_SWITCHES) {
      if (!sameValue(getPath(s, x.path), chosenPreset.patch[x.path])) drifted += 1;
    }
  }

  const matches = !!chosenPreset && drifted === 0;
  let text;
  if (!chosenPreset) {
    text = `还没选过档位（现在的开关组合 = ${cur.key === 'custom' ? '自定义' : cur.label}）`;
  } else if (matches) {
    text = `当前：${chosenPreset.label} ✓`;
  } else if (cur.exact) {
    text = `当前：${chosenPreset.label}（开关组合现在和「${cur.label}」一样）`;
  } else {
    text = `当前：${chosenPreset.label}（其中 ${drifted} 项你手动改过）`;
  }
  return {
    chosen,
    chosenLabel,
    current: cur.key,
    currentLabel: cur.label,
    matches,
    drifted,
    text,
  };
}

// ---------------------------------------------------------------------------
// 首次引导（两个问题 → 一档 + 那一档的开关）
// ---------------------------------------------------------------------------

/**
 * 首次引导的两个问题（**只有这一份定义**：界面照着它画，映射也在本文件里）。
 *
 * ⚠️ 两问都是"用户亲口说的"，所以它们可以改预设本身**没有能力**改的东西
 *    （第二问 → `bubbleView.festivalDays`）。见文件头第 ⑤ 条。
 */
export const WIZARD_QUESTIONS = Object.freeze([
  Object.freeze({
    key: 'festival',
    title: '要节日吗？',
    hint: '节日泡泡和节日图案。三档预设都不会把它关掉，这一问只是想确认你的意思。',
    options: Object.freeze([{ value: true, label: '要' }, { value: false, label: '不要' }]),
    fallback: true,
  }),
  Object.freeze({
    key: 'onlyImportant',
    title: '只提醒重要的事吗？',
    hint: '是 = 极简档（只有泡泡区 / 提醒 / 课表）；'
      + '否 = 标准档（再加课程摘要提醒，并让周期也管提醒 / 日历）。',
    options: Object.freeze([{ value: true, label: '是' }, { value: false, label: '否' }]),
    fallback: false,
  }),
]);

/** 引导页默认答案（最不打扰人的那一组 → 标准档） */
export const WIZARD_DEFAULT_ANSWERS = Object.freeze(
  Object.fromEntries(WIZARD_QUESTIONS.map((q) => [q.key, q.fallback])),
);

/**
 * 两个答案 → 哪一档 + 要不要关节日。**纯函数**，界面与测试共用。
 *
 * 映射（写死在这儿，不散在界面里）：
 *   ①只提醒重要的 → `simple`
 *   ①不只         → `standard`（= DEFAULT_PRESET）
 */
export function presetForAnswers(answers) {
  const a = objOf(answers);
  const onlyImportant = a.onlyImportant === true;
  const key = onlyImportant ? 'simple' : DEFAULT_PRESET;
  const preset = presetByKey(key);
  return {
    preset: key,
    label: preset ? preset.label : '',
    // 只有**明确说了不要**才算关（缺字段/脏值 → 不动，别替用户关掉节日）
    festivalOff: a.festival === false,
  };
}

/**
 * 把引导页的两个答案落到 settings 上（返回**新对象**）。
 *
 * ⚠️ 第二问"不要节日"是**用户当场亲口回答**的，所以才允许写
 *    `bubbleView.festivalDays = 0`（预设本身永远不碰它，见文件头第 ⑤ 条）。
 *    回答"要节日"时**不写**这个键 —— 那多半是台设备自己记着 4/7 天，
 *    没必要用 4 去覆盖用户手填的 7。
 * ⚠️ `setupDone` 不在这里写：它是"引导走完了没"的标记，由界面在保存成功时一起提交。
 */
export function applyAnswers(settings, answers) {
  const { preset, festivalOff } = presetForAnswers(answers);
  const next = applyPreset(settings, preset);
  if (festivalOff) setPath(next, 'bubbleView.festivalDays', 0);
  return next;
}

/** 引导页要发给服务端的 patch（`preset` + 那一档的开关 + 可选 `setupDone`） */
export function answersPatch(settings, answers, { setupDone = false } = {}) {
  const prev = objOf(settings);
  const patch = settingsPatch(prev, applyAnswers(prev, answers));
  if (setupDone) patch.setupDone = true;
  return patch;
}

/** 气泡区默认的"节日泡泡提前几天浮出来"（引导页第二问答"要"时用得到） */
export const FESTIVAL_DAYS_DEFAULT = BUBBLE_VIEW_DEFAULTS.festivalDays;

/**
 * （精简版去掉了 AI 那一组开关，所以这里不再有"开关表 ↔ 功能清单"的对账。）
 */
