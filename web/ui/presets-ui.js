// 「简约版」（0.11.0）三档预设的**界面**：设置页顶部那一块 + 首次引导那张卡。
//
// ⚠️ 这一层**不许自己算语义**。档位有哪三档、每档把哪些真实开关设成什么、
//    "换成这一档会打开/关掉什么"、引导那两个答案落到哪一档 —— 全在
//    `core/presets.js` 里（那边是唯一真源，也是三端共用的那一份）。
//    这里只做三件事：把 core 的话画出来、把用户点的东西交回 core、保存之后说人话。
//    自己在这里抄一份映射的后果是"界面说的"和"实际改的"慢慢分叉，
//    而用户看到的是"它说只关节日，怎么把课程也关了"。
//
// ⚠️ 保存**只发 patch**（core 的 `presetPatch` / `answersPatch`），不整份回传 settings：
//    整份回传意味着"连没改过的字段也要替它负责干净"。
//    只发改动的开关，这个风险根本不存在。
import { el, mount } from './dom.js';
import * as store from '../adapter/store.js';
import { toast } from './toast.js';
import {
  PRESETS, presetByKey, presetPatch, describePresetDiff, presetStatusOf,
  answersPatch, presetForAnswers,
  WIZARD_QUESTIONS, WIZARD_DEFAULT_ANSWERS,
} from '../../core/presets.js';
// 气泡区那台设备自己记的显示偏好键（**只有一处定义**，在气泡区视图里）
import { FESTIVAL_DAYS_KEY } from './views/bubble.js';

/** 应用成功之后那句必须说的话 —— 用户真正担心的是"换个档我数据还在不在" */
const SAFE_NOTE = '只改了开关，没有删除任何数据。';

/** 把"会打开/关掉什么"压成一行（列表太长时截断，界面不滚雪球） */
function joinLabels(list, max = 6) {
  const names = list.map((c) => c.label);
  if (names.length <= max) return names.join('、');
  return `${names.slice(0, max).join('、')}…等 ${names.length} 项`;
}

/**
 * 写"这台设备的节日泡泡提前几天浮出来"。
 *
 * ⚠️ 网页气泡区读的是 **localStorage**（见 web/ui/views/bubble.js 的 readConfig），
 *    而 `core/` 不许碰 localStorage（硬约束，见 tools/core.test.mjs）——
 *    所以只有引导页这一层能做这件事。
 * ⚠️ 读/写都可能抛（无痕模式、被策略禁掉的 WebView）→ 一律咽掉：
 *    "一个显示偏好没存上"绝不该让整次引导失败。
 */
function setDeviceFestivalDays(days) {
  try { localStorage.setItem(FESTIVAL_DAYS_KEY, String(days)); } catch { /* 存不上就算了 */ }
}

// ---------------------------------------------------------------------------
// 设置页顶部：三个按钮 + 应用前的差异预览
// ---------------------------------------------------------------------------

/**
 * 设置页最上面那一块。
 *
 * 交互是**两步**的（先点档位看差异 → 再确认），这不是啰嗦：
 * 一步到位的话用户点下去的那一刻就已经改了开关，而"预览"永远来不及看 ——
 * 那这个功能就只剩一个装饰作用了。
 *
 * @param {{settings?:object, onDone?:Function}} opts `onDone` = "状态变了，重画一下"
 * @returns {HTMLElement} 直接塞进卡片里的节点
 */
export function presetBlock({ settings = {}, onDone } = {}) {
  const host = el('div');
  let armed = null;   // 正在预览（还没确认）的那一档

  const redraw = () => { mount(host, body()); };

  async function applyTier(key) {
    const preset = presetByKey(key);
    if (!preset) { toast({ title: '这一档认不出来', kind: 'err', timeout: 4000 }); return; }
    const patch = presetPatch(settings, key);
    try {
      // ⚠️ 顺手把 `setupDone` 记上：用户已经**亲手**选过档位了，
      //    首次引导那张卡片不该再来问一遍。
      await store.saveSettings({ ...patch, setupDone: true });
      toast({
        title: `已切换到「${preset.label}」档`,
        body: SAFE_NOTE,
        timeout: 4500,
      });
      armed = null;
      if (onDone) onDone();
    } catch (err) {
      toast({
        title: '切换失败',
        body: String((err && err.message) || err),
        kind: 'err',
        timeout: 8000,
      });
    }
  }

  /** 应用前的差异预览（数据全部来自 core 的 describePresetDiff） */
  function preview(key) {
    const preset = presetByKey(key);
    const d = describePresetDiff(settings, key);
    const empty = !d.opens.length && !d.closes.length;
    return el('div', {
      style: {
        marginTop: '8px', padding: '10px', border: '1px solid var(--line)',
        borderRadius: '10px', display: 'flex', flexDirection: 'column', gap: '4px',
      },
    }, [
      el('b', { text: `切到「${preset.label}」，会发生这些：` }),
      empty
        ? el('p.tiny', { style: { margin: '2px 0' }, text: '开关本来就和这一档一样，什么都不会变。' })
        : null,
      d.opens.length
        ? el('p.tiny', { style: { margin: '2px 0' }, text: `✅ 打开：${joinLabels(d.opens)}` })
        : null,
      d.closes.length
        ? el('p.tiny', { style: { margin: '2px 0' }, text: `⛔ 关掉：${joinLabels(d.closes)}` })
        : null,
      d.sets.length
        ? el('p.tiny', { style: { margin: '2px 0' }, text: `⚙ 改动：${joinLabels(d.sets)}` })
        : null,
      el('p.tiny', {
        style: { margin: '2px 0' },
        // ⚠️ 界面是**纯文本渲染**的，这里绝不能写 Markdown 的星号 ——
        //    用户看到的就是两个 `*`（这个坑本项目在自定义铃声那段专门记过一笔）。
        text: '⚠️ 只动这些开关：日程、课程、活动记录 —— 别的（课程名、地点、备注…）一个字都不动'
          + '（其它设置一个字都不动）。',
      }),
      el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' } }, [
        el('button.btn.btn-sm.btn-primary', {
          text: empty ? '确认（其实就是没变）' : `确认切到「${preset.label}」`,
          onclick: () => applyTier(key),
        }),
        el('button.btn.btn-sm', {
          text: '算了',
          onclick: () => { armed = null; redraw(); },
        }),
      ]),
    ]);
  }

  function body() {
    const st = presetStatusOf(settings);
    const buttons = PRESETS.map((p) => {
      const cur = st.chosen === p.key;
      return el(`button.btn.btn-sm${cur ? '.btn-primary' : ''}`, {
        text: cur ? `${p.label} ✓` : p.label,
        title: p.desc,
        'aria-pressed': String(cur),
        onclick: () => { armed = armed === p.key ? null : p.key; redraw(); },
      });
    });
    return el('div', {}, [
      el('p.tiny', {
        style: { margin: '0 0 8px' },
        // ⚠️ 这行文案由 core 的 presetStatusOf 给（**只有一份实现**，免得和别处漂移）。
        //    它同时说清"你选过哪一档"和"实际开关现在是不是还等于那一档"。
        text: `${st.text}。选一档就把开关按那一档调好；这三档都不会碰你的日程和课程。`,
      }),
      el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, buttons),
      el('p.tiny', {
        style: { margin: '6px 0 0' },
        text: PRESETS.map((p) => `${p.label}：${p.desc}`).join('　'),
      }),
      armed ? preview(armed) : null,
      el('p.tiny', {
        style: { margin: '6px 0 0' },
        text: '⚠️ 三档都保留节日（节日泡泡和节日图案）。',
      }),
    ].filter(Boolean));
  }

  redraw();
  return host;
}

// ---------------------------------------------------------------------------
// 首次引导（两个问题）—— 放在 app.js 的 #banner-host 里，**不挡路**
// ---------------------------------------------------------------------------

/**
 * 首次进入时那张卡：两个问题，可以整张跳过。
 *
 * ⚠️ 为什么用"横条（banner）"而不是弹窗：
 *    弹窗会挡住气泡区，而气泡区是主界面（还要接拖拽/长按手势）——
 *    一个"引导"把主界面按住，是最容易被用户骂的设计。
 *    `#banner-host` 本来就有这套机制（离线提示、"第一次使用？"都在那儿）。
 *
 * @param {{settings?:object, onDone?:Function}} opts `onDone` = "状态变了，重画一下"
 * @returns {HTMLElement} 交给 app.js 追加进 #banner-host
 */
export function wizardBanner({ settings = {}, onDone } = {}) {
  const host = el('div.banner.info', {
    // 覆盖 banner 的横向排布：这张卡里是"几行问答"，竖着放才读得下去
    style: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '6px' },
  });
  // 草稿答案就放在这个闭包里：只有真实的状态变化才会重画整张卡（那时草稿重置是可接受的）
  const draft = { ...WIZARD_DEFAULT_ANSWERS };
  const redraw = () => { mount(host, body()); };

  async function applyAnswers() {
    const chosen = presetForAnswers(draft);
    // ⚠️ 只有"当场说了不要节日"才去动显示偏好；回答"要"时一个字都不写
    //    （设备上可能记着用户手填的 7 天，拿 4 去覆盖是自作聪明）。
    if (chosen.festivalOff) setDeviceFestivalDays(0);
    try {
      await store.saveSettings(answersPatch(settings, draft, { setupDone: true }));
      toast({
        title: `好，按「${chosen.label}」档调好了`,
        body: `${SAFE_NOTE}随时可以在设置页里换。`,
        timeout: 6000,
      });
      if (onDone) onDone();
    } catch (err) {
      toast({ title: '保存失败', body: String((err && err.message) || err), kind: 'err', timeout: 8000 });
    }
  }

  async function skip() {
    try {
      // 跳过 = 只记"问过了"，**一个开关都不改**（用户没表态的事，我们不替他定）
      await store.saveSettings({ setupDone: true });
      toast({ title: '好，那就都不动', body: '什么时候想选，设置页最上面就有这三档。', timeout: 4500 });
      if (onDone) onDone();
    } catch (err) {
      toast({ title: '保存失败', body: String((err && err.message) || err), kind: 'err', timeout: 8000 });
    }
  }

  function body() {
    const chosen = presetForAnswers(draft);
    const d = describePresetDiff(settings, chosen.preset);
    const bits = [];
    if (d.opens.length) bits.push(`打开 ${joinLabels(d.opens, 4)}`);
    if (d.closes.length) bits.push(`关掉 ${joinLabels(d.closes, 4)}`);
    return [
      el('div', {}, [
        el('b', { text: '先花十秒选个档位？' }),
        el('span', {
          text: ' 两个问题，答完就按你说的把开关调好。不想答就直接跳过 —— 什么都不动。',
        }),
      ]),
      el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        WIZARD_QUESTIONS.map((q) => el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } }, [
          el('span.tiny', { text: q.title, title: q.hint, style: { minWidth: '132px' } }),
          ...q.options.map((o) => el(`button.btn.btn-sm${draft[q.key] === o.value ? '.btn-primary' : ''}`, {
            text: o.label,
            'aria-pressed': String(draft[q.key] === o.value),
            onclick: () => { draft[q.key] = o.value; redraw(); },
          })),
          el('span.tiny', { text: q.hint, style: { color: 'var(--muted)', fontSize: '12px' } }),
        ]))),
      el('p.tiny', {
        style: { margin: '2px 0 0' },
        text: `将应用：「${chosen.label}」档`
          + (chosen.festivalOff ? '（节日泡泡收起，随时能在气泡区显示设置里改回来）' : '')
          + (bits.length ? `　${bits.join('；')}` : '　（开关已经和这一档一样了）'),
      }),
      el('p.tiny', {
        style: { margin: '0' },
        text: '⚠️ 只改开关：不删任何数据，也不会动你自己填过的内容。',
      }),
      el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '2px' } }, [
        el('button.btn.btn-sm.btn-primary', { text: '就这样', onclick: () => applyAnswers() }),
        el('button.btn.btn-sm', { text: '先跳过', onclick: () => skip() }),
      ]),
    ];
  }

  redraw();
  return host;
}
