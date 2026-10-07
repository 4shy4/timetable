// 设置页：习惯设置 + 通知与自启 + 数据管理 + 关于。
import { el, mount } from '../dom.js';
import * as store from '../../adapter/store.js';
import { api, getApiMode } from '../../adapter/api.js';
// 本机独立模式（4b）：切换 + 播种 + 查看本机库
import { switchToLocal, switchToRemote, localSummary, wipeLocal } from '../../adapter/local-mode.js';
// 同步（4c）：本机 ↔ 电脑
import { runSync } from '../../adapter/sync.js';
import { toast } from '../toast.js';
import { confirmDialog, openModal } from '../modal.js';
import * as reminder from '../../adapter/reminder.js';
// 原生壳：显示"系统提醒排了几条"、并发一条测试通知（浏览器里都是空操作）
import {
  inShell, lastPushStatus, sendTestNotification,
  // ⚠️ 2026-10-01 加：把"当前该排的提醒"重排给系统（换/清自定义提示音之后必须重排）。
  //    以前这里写的是 `pushShellNotifications()` —— 那是 **app.js 自己的包装函数**，
  //    在设置页里根本不存在，既没导入也没定义 → 点「用回默认」会抛 ReferenceError。
  //    **这是同一种 bug 的第三次**（前两次：`refreshAlarmStatus` 漏导入、
  //    `scheduleAlarmsSoon` 根本不存在）→ 已做机械预检 `node tools/js-preflight.mjs`。
  pushNotifications,
  // 真闹钟（AlarmKit / iOS 26+）：状态显示与申请入口
  alarmKitStatus, requestAlarmAuthorization, refreshAlarmStatus,
  // 语音桥（写进系统「提醒事项」，让 Siri 原生读写）
  voiceBridgeStatus, requestVoiceAccess, pushVoiceMirror,
  // 自定义提示音：导入 / 删除 / 查询容器里现有的文件
  pickCustomSound, dropCustomSound, refreshCustomSounds, customSoundStatus,
} from '../../adapter/native.js';
// 三档提示音的名字表（"哪一档配哪个音"是业务，和推送计划共用同一份）
import { BUILTIN_SOUNDS } from '../../../core/notify-plan.js';
// 专用清单名 —— 用户会**用嘴说**它，所以只有一处定义（core/voice-bridge.js）
import { VOICE_LIST_NAME } from '../../../core/voice-bridge.js';
import { asDate } from '../../../core/time.js';
// 版本号：优先用服务端报的（权威），本机独立模式下用它（core/defaults.js 里那一份）
import { APP_VERSION } from '../../../core/defaults.js';
// 课程摘要的槽位定义与判定，和 core 共用同一份（界面不自造一套）
import { DIGEST_SLOTS, normalizeDigest, parseHHMM } from '../../../core/course-digest.js';
// 「简约版」三档预设（0.11.0）：设置页**最上面**那一块（三个按钮 + 应用前的差异预览）。
// ⚠️ 档位语义一个字都不在这里 —— 全在 core/presets.js，这里只负责画和保存。
import { presetBlock } from '../presets-ui.js';

export const settingsView = {
  id: 'settings',
  label: '设置',
  icon: '⚙',

  title() { return '设置'; },
  subtitle() { return '通知 · 开机自启 · 数据'; },
  nav() { return []; },
  onNav() {},

  render(state, ctx, host) {
    const s = state.settings;

    // ---- 基本 ----
    const ownerInput = el('input', { type: 'text', value: s.owner || '', placeholder: '怎么称呼你' });
    const termStartInput = el('input', { type: 'date', value: s.termStart || '' });
    const termWeeksInput = el('input', { type: 'number', min: '1', max: '30', value: String(s.termWeeks || 20) });
    const todoInput = el('input', { type: 'text', value: s.todayTodo || '', placeholder: '例如：今天要把数据结构作业写完' });

    const defaultReminderHost = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });
    const presetReminders = [0, 5, 10, 15, 30, 60];
    let chosenReminders = [...(s.defaultReminders || [10, 0])];
    const renderDefaultReminders = () => {
      mount(defaultReminderHost, presetReminders.map((m) => el('button.chip', {
        type: 'button',
        style: chosenReminders.includes(m)
          ? { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : {},
        text: m === 0 ? '准点' : `${m} 分钟前`,
        onclick: () => {
          chosenReminders = chosenReminders.includes(m)
            ? chosenReminders.filter((x) => x !== m)
            : [...chosenReminders, m].sort((a, b) => a - b);
          renderDefaultReminders();
        },
      })));
    };
    renderDefaultReminders();

    // ---- 课程摘要提醒的控件 ----
    const digestStart = normalizeDigest(s.courseDigest);
    // 本地草稿：改完点"保存"才写回服务端（和"基本"那栏一致的交互）
    const digestDraft = {
      enabled: digestStart.enabled,
      perCourseReminders: digestStart.perCourseReminders,
      slots: Object.fromEntries(DIGEST_SLOTS.map((sl) => [sl.key, { ...digestStart.slots[sl.key] }])),
    };

    const digestEnabled = el('input', {
      type: 'checkbox', checked: digestDraft.enabled,
      onchange: (e) => { digestDraft.enabled = e.target.checked; renderDigestSlots(); },
    });
    const digestPerCourse = el('input', {
      type: 'checkbox', checked: digestDraft.perCourseReminders,
      onchange: (e) => { digestDraft.perCourseReminders = e.target.checked; },
    });
    const digestSlotHost = el('div');

    function renderDigestSlots() {
      // 总开关关掉时槽位整块变灰（不隐藏 —— 隐藏会让人以为功能没了）
      digestSlotHost.style.opacity = digestDraft.enabled ? '1' : '.5';
      mount(digestSlotHost, DIGEST_SLOTS.map((sl) => {
        const cur = digestDraft.slots[sl.key];
        const on = el('input', {
          type: 'checkbox', checked: cur.on,
          disabled: !digestDraft.enabled,
          onchange: (e) => { cur.on = e.target.checked; },
        });
        const at = el('input', {
          type: 'time', value: cur.at,
          disabled: !digestDraft.enabled,
          style: { width: '116px' },
          onchange: (e) => {
            // 非法值（比如清空）回落到默认，别让它变成空字符串后在计算里出怪事
            cur.at = parseHHMM(e.target.value) !== null ? e.target.value : sl.defaultAt;
            e.target.value = cur.at;
          },
        });
        return el('label.switch-row', {}, [
          el('span', {}, [
            el('b', { text: sl.label }),
            el('small', {
              text: sl.hint,
              style: { display: 'block', color: 'var(--muted)', fontSize: '12px' },
            }),
          ]),
          el('span', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [at, on]),
        ]);
      }));
    }
    renderDigestSlots();

    const saveDigest = async () => {
      try {
        await store.saveSettings({ courseDigest: digestDraft });
        toast({ title: '摘要设置已保存', kind: 'ok' });
        ctx.refresh();
      } catch (err) {
        toast({ title: '保存失败', body: String((err && err.message) || err), kind: 'err' });
      }
    };

    const saveBasic = async () => {
      try {
        await store.saveSettings({
          owner: ownerInput.value.trim(),
          termStart: termStartInput.value || '',
          termWeeks: Number(termWeeksInput.value) || 20,
          todayTodo: todoInput.value.trim(),
          defaultReminders: chosenReminders,
        });
        toast({ title: '设置已保存' });
        ctx.refresh();
      } catch (err) {
        toast({ title: '保存失败', body: err.message, kind: 'err' });
      }
    };

    // ---- 通知 ----
    const notify = s.notify || {};
    const permState = reminder.permission();
    const permText = {
      granted: '已授权 ✓', denied: '已被拒绝（需在浏览器地址栏左侧重新允许）',
      default: '未授权，点右侧按钮开启', unsupported: '当前浏览器不支持',
    }[permState] || '未知';

    // ---- 提醒强度 ----
    //
    // 为什么必须有这个控件：强度原本是**按剩余时间自动算**的（越临近截止越强）。
    // 规则合理，但它意味着"下周的课"永远只有最弱那一档 —— 用户觉得不够响，
    // 却没有任何旋钮可调（用户原话："我要平板端提醒强度"）。
    // ⚠️ 这些 hint 说的是**网页里的弹窗**（NOTIFY_INTENSITY：停留多久、响几遍）。
    //    在 iPad 上你真正会看到的是**系统通知**，那边受系统限制：
    //    1/2 档在系统上**没有区别**（都是普通通知），3/4 档是时效性通知。
    //    而"真闹钟"还要**那条日程自己勾上**「到点用真闹钟」才会做（见下）。
    const INTENSITY_CHOICES = [
      { value: 'auto', label: '自动', hint: '按还剩多久自动升级（周/月=1，日=2，小时=3，最后1小时/过期=4）—— 推荐' },
      { value: '1', label: '1 轻', hint: '一声轻响，通知自动消失' },
      { value: '2', label: '2 中', hint: '两声，通知自动消失（在 iPad 的系统通知上和 1 档没区别）' },
      { value: '3', label: '3 强', hint: '响两遍，通知停留更久；iPad 上是时效性通知，能穿专注模式' },
      { value: '4', label: '4 最强', hint: '响四遍、不自动消失；勾了「到点用真闹钟」的日程会响成系统级真闹钟' },
    ];
    const curIntensity = String(notify.intensity == null ? 'auto' : notify.intensity);
    const intensityHost = el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, []);
    INTENSITY_CHOICES.forEach((c) => {
      const b = el('button.btn.btn-sm', {
        text: c.label,
        'aria-pressed': String(c.value === curIntensity),
        onclick: async () => {
          await store.saveSettings({
            notify: { intensity: c.value === 'auto' ? 'auto' : Number(c.value) },
          });
          toast({ title: `提醒强度：${c.label}`, body: c.hint, timeout: 2500 });
          ctx.refresh();
        },
      });
      if (c.value === curIntensity) b.classList.add('btn-primary');
      intensityHost.appendChild(b);
    });
    const intensityHint = el('p.tiny', {
      style: { margin: '6px 0 0' },
      text: (INTENSITY_CHOICES.find((c) => c.value === curIntensity) || {}).hint || '',
    });

    // ---- 原生壳里的「系统提醒」状态（+ 测试通知）----
    //
    // 为什么要有这一块：在 iOS 里"到点没响"有好几种完全不同的原因，
    // 而用户在设备上**看不到任何日志**，只能靠猜。把状态摆出来 + 给一个走
    // 同一条通道的测试按钮，一次点击就能把范围劈成两半。
    const shellStatusBlock = el('div', {
      style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--line)' },
    });
    if (inShell()) {
      const st = lastPushStatus();
      let line;
      if (!st) line = '还没有把提醒交给系统（下次改动日程或重开 App 时会）';
      else if (!st.sent) line = '❌ 交给系统失败：' + (st.reason || '未知');
      else if (!st.count) line = '⚠️ 交过去了，但**计划是空的**（没有可排的提醒 —— 检查日程有没有提醒提前量）';
      else {
        const mins = Math.max(0, Math.round((asDate(st.nextAt).getTime() - Date.now()) / 60000));
        line = `✅ 已交给系统 ${st.count} 条，最近一条 ${mins} 分钟后（${asDate(st.nextAt).toLocaleString('zh-CN', { hour12: false })}）`;
      }
      shellStatusBlock.appendChild(el('b', { text: '系统提醒（原生 App）' }));
      shellStatusBlock.appendChild(el('p.tiny', { style: { margin: '4px 0 8px' }, text: line }));
      shellStatusBlock.appendChild(el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
        el('button.btn.btn-sm', {
          text: '🔔 立刻发一条测试通知（5 秒后响）',
          onclick: () => {
            const s = store.getState();
            const r = sendTestNotification({ events: s.events, settings: s.settings, delayMs: 5000 });
            if (!r.sent) {
              toast({ title: '发不出去', body: r.reason || '不在原生壳内', kind: 'err', timeout: 5000 });
              return;
            }
            toast({
              title: '已交给系统',
              body: '5 秒内应该会弹一条「测试通知」。没弹就在系统「设置 → 通知 → 日程表」里把通知权限打开。',
              timeout: 8000,
            });
          },
        }),
      ]));
      shellStatusBlock.appendChild(el('p.tiny', {
        style: { margin: '6px 0 0' },
        text: '这一条走的是和真实提醒**完全相同的通道**。它响了 → 权限和通道没问题；不响 → 先去系统设置里检查通知权限。',
      }));

      // ---- 真闹钟（AlarmKit，iOS 26+）----
      //
      // ⚠️ 为什么必须把这一节摆出来（这一版最关键的一处诚实）：
      //   "最高档 = 真闹钟" 是现在最强的能力，但它**会穿过专注模式** ——
      //   而用户明确说了"专注模式时别响"。用户**看不到任何日志**，
      //   如果不把状态摆出来，他会以为"我设成最高档了但它没响"或者
      //   "它凭什么在专注时炸我"。所以这里要同时说清**能不能用**和**代价是什么**。
      const ak = alarmKitStatus();
      shellStatusBlock.appendChild(el('b', { text: '最高档：真闹钟（AlarmKit）' }));
      let akLine;
      if (!ak.known) akLine = '还没从系统读到状态（重开一次 App，或点下面的按钮再读一次）';
      else if (!ak.available) akLine = '这台设备的系统低于 iOS 26 → 没有真闹钟，最高档会自动退回普通提醒';
      else if (!ak.authorized) akLine = '⚠️ 还没拿到闹钟权限 → 最高档现在**不会响成真闹钟**，只会按普通提醒响';
      else akLine = '✅ 已授权。设成**最高档**的日程会响成真闹钟：满音量、无视静音、**且会穿过专注模式**';
      shellStatusBlock.appendChild(el('p.tiny', { style: { margin: '4px 0 8px' }, text: akLine }));
      shellStatusBlock.appendChild(el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
        el('button.btn.btn-sm', {
          text: ak.authorized ? '🔄 重新读一次闹钟状态' : '⏰ 申请闹钟权限',
          onclick: () => {
            if (ak.known && ak.available && ak.authorized) refreshAlarmStatus();
            else requestAlarmAuthorization();
            toast({
              title: '已请求',
              body: '系统弹窗里点「允许」之后，回到设置页（或重开 App）就能看到状态。',
              timeout: 6000,
            });
          },
        }),
      ]));
      shellStatusBlock.appendChild(el('p.tiny', {
        style: { margin: '6px 0 0' },
        text: '⚠️ 真闹钟**无法**被专注模式或静音开关压住 —— 那正是它强的来源。所以「专注时别响」的正确做法是：那条日程别设成最高档，其余档位一律尊重专注。',
      }));

      // ---- 语音桥：写进系统「提醒事项」，让 Siri 原生读写 ----
      //
      // ⚠️ 为什么必须把状态摆出来：权限没给、或同步没成时，
      //    表现都只是"**Siri 念不出来**" —— 用户在设备上看不到任何提示，只能猜。
      //    这里给状态 + 申请入口，一次点击就能把范围劈成两半。
      const vb = voiceBridgeStatus();
      shellStatusBlock.appendChild(el('b', { text: '语音助手（Siri 读「提醒事项」）' }));
      let vbLine;
      if (!vb.known) {
        vbLine = '还没从系统读到状态（重开一次 App，或点下面的按钮再读一次）';
      } else if (!vb.authorized) {
        vbLine = '⚠️ 还没拿到「提醒事项」权限 → Siri 现在读不到你的日程';
      } else {
        const added = vb.last && typeof vb.last.added === 'number' ? vb.last.added : null;
        vbLine = '✅ 已授权。日程会写进「提醒事项」里一个叫「' + VOICE_LIST_NAME + '」的清单'
          + (added === null ? '' : '（上次同步写入 ' + added + ' 条）');
      }
      shellStatusBlock.appendChild(el('p.tiny', { style: { margin: '4px 0 8px' }, text: vbLine }));
      shellStatusBlock.appendChild(el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
        el('button.btn.btn-sm', {
          text: (vb.known && vb.authorized) ? '🔄 立刻同步一次' : '🎙 申请「提醒事项」权限',
          onclick: () => {
            const s = store.getState();
            if (vb.known && vb.authorized) {
              const r = pushVoiceMirror({ events: s.events, settings: s.settings });
              toast({
                title: r.sent ? '已同步' : '同步失败',
                body: r.sent ? ('写进去 ' + r.count + ' 条') : (r.reason || ''),
                kind: r.sent ? 'ok' : 'err',
                timeout: 5000,
              });
            } else {
              requestVoiceAccess();
            }
          },
        }),
      ]));
      shellStatusBlock.appendChild(el('p.tiny', {
        style: { margin: '6px 0 0' },
        text: '给它权限之后，直接对 Siri 说：「' + VOICE_LIST_NAME + '里有什么」（念日程）'
          + '或「在' + VOICE_LIST_NAME + '里加：明天下午3点开会」（语音加日程）。'
          + '语音加的那些会**自动变成气泡**（App 下次打开时读回来）。'
          + '⚠️ 写进去的条目**不带闹铃** —— 免得同一件事你和 App 各响一次。',
      }));
    } else {
      shellStatusBlock.appendChild(el('b', { text: '系统提醒（原生 App）' }));
      shellStatusBlock.appendChild(el('p.tiny', {
        style: { margin: '4px 0 0' },
        text: '当前不在原生 App 里（浏览器/PWA）。原生 App 才会把提醒提前注册给系统。',
      }));
    }

    // ---- 「周期」的生效范围（用户说的那个开关）----
    //
    // 周期是每个重复日程上的字段（编辑器里的「周期（天）」）：
    // 只浮「最近那颗 + 周期」以内的实例。
    //
    // ⚠️ 这个开关**只给日历订阅**，不碰提醒 —— 这不是偷懒，是提醒那边数学上做不到：
    //    提醒只扫未来 26 小时，而本应用的重复粒度最小是"每天"（间隔 ≥ 24h），
    //    周期最小又是 1 天 ⇒ 26 小时窗口里的两颗间隔恰好 24h，永远 ≤ 周期 ⇒ 筛不动。
    //    （见 tools/reminder-plan.test.mjs 里那条结论性测试。）
    //    日历一次展开 400 天，所以那边筛一下是看得见的。
    const periodScopeRow = switchRow({
      title: '周期也管日历订阅',
      desc: '关（默认）：周期只收起气泡区的显示。'
        + '开：订阅到 iPad 的日历里，也只出现「最近那颗 + 周期」以内的实例。',
      checked: s.periodAffectsCalendar === true,
      onChange: async (v) => {
        await store.saveSettings({ periodAffectsCalendar: v });
        toast({
          title: v ? '日历也跟着周期收拢了' : '周期只管气泡显示',
          body: v ? 'iPad 的日历里远期的重复实例会消失' : '日历保持完整',
          timeout: 3000,
        });
        ctx.refresh();
      },
    });

    // ---- 本机独立模式（4b）----
    //
    // 让平板**不再需要电脑**：数据整份存到这台设备上（IndexedDB），
    // 气泡区/编辑器/课表全部就地可用。
    //
    // ⚠️ 界面必须说清两件事，否则用户会被吓到或误解：
    //   ① 切过去时会**把那台电脑上的数据整份拷过来**（不然会看到"0 条日程"）
    //   ② 切回电脑**不会**把本机的改动推回去（那是 4c 增量同步的事）
    const localHost = el('div');
    (async () => {
      const cur = getApiMode();
      const isLocal = cur === 'local';
      let summary = null;
      if (isLocal) {
        try { summary = await localSummary(); } catch { summary = null; }
      }
      mount(localHost, [
        el('p.tiny', {
          style: { margin: '0 0 8px' },
          text: isLocal
            ? `✅ 现在跑在**本机独立模式**：数据存在这台设备上，电脑可以关着。`
            : '现在跑在「连着电脑」模式：数据在那台电脑上，电脑关着就用不了新数据。'
              + '打开本机独立模式后，日程会整份复制到这台设备上，之后不依赖电脑。',
        }),
        isLocal && summary
          ? el('p.tiny', { text: `本机库：${summary.events} 条日程 / ${summary.courses} 门课程` })
          : null,
        el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } }, [
          isLocal
            ? el('button.btn.btn-sm', {
              text: '切回「连着电脑」',
              onclick: () => {
                switchToRemote();
                toast({
                  title: '已切回连着电脑',
                  body: '本机的数据保留着，不会丢；但本机的改动不会自动同步回电脑',
                  timeout: 6000,
                });
                ctx.refresh();
              },
            })
            : el('button.btn.btn-sm.btn-primary', {
              text: '开启本机独立模式',
              onclick: async () => {
                const ok = await confirmDialog({
                  title: '开启本机独立模式？',
                  message: '会把那台电脑上的日程**整份复制**到这台设备上，之后这台设备自己读写。'
                    + '电脑上的数据不会被改动。之后电脑关着也能看和改。'
                    + '\n\n注意：在这台设备上做的改动，暂时**不会**自动同步回电脑。',
                  confirmText: '复制并开启',
                });
                if (!ok) return;
                try {
                  const r = await switchToLocal({ seed: true });
                  toast({
                    title: '已开启本机独立模式',
                    body: `复制了 ${r.events} 条日程 / ${r.courses} 门课程，正在重新加载…`,
                    timeout: 4000,
                  });
                  // 整份数据换了来源，最稳的是重新加载一次，避免残留状态错乱
                  setTimeout(() => location.reload(), 900);
                } catch (err) {
                  toast({ title: '开启失败', body: err.message, kind: 'err', timeout: 8000 });
                }
              },
            }),
          isLocal
            ? el('button.btn.btn-sm', {
              text: '清空本机数据',
              onclick: async () => {
                const ok = await confirmDialog({
                  title: '清空本机数据？',
                  message: '只清这台设备上的那份，电脑上的不受影响。清完会切回「连着电脑」。',
                  confirmText: '清空', danger: true,
                });
                if (!ok) return;
                await wipeLocal();
                switchToRemote();
                toast({ title: '本机数据已清空', timeout: 2500 });
                setTimeout(() => location.reload(), 700);
              },
            })
            : null,
        ]),
      ]);
    })();

    // ---- 同步范围（4c 的 item 2）----
    //
    // 用户的要求："自选同步：比如只同步课表（白名单），或者只不同步气泡区（黑名单）"
    // 归纳成一个模式 + 类别勾选，两种说法都能表达：
    //   白名单 + 只勾"课表"     = 只同步课表
    //   黑名单 + 勾"气泡区"     = 只不同步气泡区
    const syncHost = el('div');
    {
      const raw = s.syncFilter && typeof s.syncFilter === 'object' ? s.syncFilter : {};
      const cur = { mode: ['all', 'whitelist', 'blacklist'].includes(raw.mode) ? raw.mode : 'all',
        categories: Array.isArray(raw.categories) ? raw.categories.slice() : [] };
      const MODES = [
        { v: 'all', label: '全都同步' },
        { v: 'whitelist', label: '只同步勾选的（白名单）' },
        { v: 'blacklist', label: '勾选的都不同步（黑名单）' },
      ];
      const CATS = [
        { v: 'courses', label: '课表', hint: '导入的课程 + 课程事件' },
        { v: 'bubbles', label: '气泡区', hint: '自己建的日程 / 任务 / 作业' },
      ];
      const modeSel = el('select', {}, MODES.map((m) =>
        el('option', { value: m.v, text: m.label, selected: m.v === cur.mode })));
      const catBoxes = CATS.map((c) => {
        const input = el('input', { type: 'checkbox', checked: cur.categories.includes(c.v) });
        return { c, input };
      });
      const catRow = el('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '6px' } },
        catBoxes.map(({ c, input }) => el('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, [
          input, el('span', { text: c.label }), el('span.tiny', { text: `（${c.hint}）` }),
        ])));
      /** 「全都同步」时勾选框没有意义，灰掉（但仍显示，免得用户以为丢了） */
      const syncCatEnabled = () => { catRow.style.opacity = modeSel.value === 'all' ? '.45' : '1'; };
      modeSel.addEventListener('change', syncCatEnabled);
      syncCatEnabled();

      mount(syncHost, [
        el('p.tiny', {
          style: { margin: '0 0 6px' },
          text: '决定"和电脑同步时带上哪些东西"。**没有勾到的类别，两边各管各的，互不覆盖**'
            + '（不是"删掉"，是"这次同步不碰它"）。',
        }),
        el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
          el('span.tiny', { text: '范围：' }), modeSel,
        ]),
        catRow,
        el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' } }, [
          el('button.btn.btn-sm', {
            text: '保存同步范围',
            onclick: async () => {
              const next = {
                mode: modeSel.value,
                categories: catBoxes.filter(({ input }) => input.checked).map(({ c }) => c.v),
              };
              await store.saveSettings({ syncFilter: next });
              toast({ title: '同步范围已保存', timeout: 2000 });
              ctx.refresh();
            },
          }),
          el('button.btn.btn-sm.btn-primary', {
            text: '立即同步',
            onclick: async (e) => {
              e.target.disabled = true;
              e.target.textContent = '同步中…';
              try {
                const st = store.getState().settings;
                const r = await runSync({ filter: st.syncFilter });
                const ts = r.tombstones || { total: 0, approxBytes: 0 };
                toast({
                  title: '同步完成',
                  body: `本机现在 ${r.local.events} 条日程 / ${r.local.courses} 门课程`
                    // 把"删除记录"的规模露出来 —— 这数一直很小就不用管它，
                    // 万一哪天变大了（比如上万条）才有必要考虑清理（见 LOCAL-FIRST.md）
                    + (ts.total ? `　（删除记录 ${ts.total} 条，约 ${Math.round(ts.approxBytes / 1024)} KB）` : ''),
                  timeout: 5000,
                });
                await store.refresh();
                ctx.refresh();
              } catch (err) {
                toast({
                  title: '同步失败',
                  body: err && err.message ? err.message : String(err),
                  kind: 'err', timeout: 8000,
                });
              } finally {
                e.target.disabled = false;
                e.target.textContent = '立即同步';
              }
            },
          }),
        ]),
      ]);
    }

    const notifyDesktop = switchRow({
      title: '系统通知（电脑）',
      desc: '由后台服务发送 Windows 通知中心消息，浏览器关掉也能提醒',
      checked: notify.desktop !== false,
      onChange: async (v) => {
        await store.saveSettings({ notify: { desktop: v } });
        toast({ title: v ? '已开启系统通知' : '已关闭系统通知', timeout: 1800 });
      },
    });

    const notifyBrowser = switchRow({
      title: '浏览器通知（页面开着时）',
      desc: '秒级提醒，可点击跳转到对应日程',
      checked: notify.browser !== false,
      onChange: async (v) => {
        if (v && permState !== 'granted') {
          const p = await reminder.requestPermission();
          if (p !== 'granted') {
            toast({ title: '浏览器未授权通知', body: '可在地址栏左侧的图标里手动允许', kind: 'err', timeout: 6000 });
            ctx.refresh();
            return;
          }
        }
        await store.saveSettings({ notify: { browser: v } });
        ctx.refresh();
      },
    });

    const notifySound = switchRow({
      title: '提示音',
      desc: '提醒时播放一声轻提示音',
      checked: notify.sound !== false,
      onChange: async (v) => {
        await store.saveSettings({ notify: { sound: v } });
        window.__timetableSettings = { ...(window.__timetableSettings || {}), sound: v };
      },
    });

    // ---------------------------------------------------------------------
    // 自定义提示音（三档各自可换）—— 只在原生壳里有意义
    // ---------------------------------------------------------------------
    //
    // 用户要的是"提醒的声音换成我自己的那段"。这里只做三件事：
    //   · 显示每一档现在用的是哪个音（内置 / 你自己导入的）
    //   · 「导入音频…」→ 让**壳**弹系统文件选择器（网页拿不到文件系统）
    //   · 「用回默认」→ 清掉设置里那条 + 让壳把容器里那个文件删掉
    //
    // ⚠️ 声音文件**只存在导入它的那台设备上**（App 容器的 Library/Sounds）。
    //    所以壳每次启动会报一份"容器里现在有哪些 .caf"，网页侧据此清掉
    //    设置里已经不存在的名字（见 app.js 的 applySoundEvent）。
    const soundHost = el('div');

    /** 四档的名字与用途（档位定义见 core/level.js 的 BAND_INTENSITY） */
    const SOUND_TIERS = [
      { tier: 4, label: '强烈', when: '临近到点的提醒（提前量以分钟计）' },
      { tier: 3, label: '中等', when: '提前量以小时计' },
      { tier: 2, label: '柔和', when: '提前量以天计' },
      { tier: 1, label: '最弱', when: '提前量以周 / 月计（默认就是系统那声"叮"）' },
    ];

    function renderSoundBlock() {
      if (!inShell()) { mount(soundHost); return; }
      const st = store.getState().settings || {};
      const custom = (st.notify || {}).customSounds || {};
      const files = customSoundStatus();
      const rows = SOUND_TIERS.map(({ tier, label, when }) => {
        const mine = custom[tier] || '';
        const builtin = BUILTIN_SOUNDS[tier];
        const desc = mine
          ? `你自己的音频（${mine}）`
          : (builtin ? `内置三档里那个（${builtin}）` : '系统默认提示音');
        const btns = [
          el('button.btn.btn-sm', {
            text: '导入音频…',
            title: '从「文件」里选一段音频（30 秒以内，会自动截取开头）',
            onclick: () => {
              // ⚠️ 2026-10-02：这里**只负责把请求发出去**。
              //    以前的写法是"发出去就以为换好了"（立刻弹"已换成你选的那段"）——
              //    那是**假的**：用户还没选文件呢。现在分两步：
              //      · 这条 toast 只说"去选文件"；
              //      · 选完之后由壳回报 `soundImported` → `app.js` 的 `applySoundEvent`
              //        把这一档写进 `settings.notify.customSounds` 并弹"已换好"。
              //    （`pickCustomSound(tier)` 里的 `tier` 也**不再发给壳**：壳把所有导入的
              //      音频都放进同一个「我的铃声」列表，分档只是网页自己要记的事。）
              const ok = pickCustomSound(tier);
              toast({
                title: ok ? '去「文件」里选一段音频' : '这个壳不支持换提示音',
                body: ok ? '选好之后自动转成 App 要的格式（只取前 30 秒），并让这一档用上它' : '',
                kind: ok ? 'ok' : 'err',
                timeout: ok ? 4200 : 4000,
              });
            },
          }),
        ];
        if (mine) {
          btns.push(el('button.btn.btn-sm', {
            text: '用回默认',
            onclick: async () => {
              const next = { ...custom };
              delete next[tier];
              // 先改设置（立刻生效），再让壳把文件删掉（删不掉也不影响用）
              await store.saveSettings({ notify: { customSounds: next } });
              dropCustomSound(mine);
              // ⚠️⚠️ 2026-10-01 修：这里原来写的是 `pushShellNotifications()` ——
              //    **那个名字既没导入、也没定义** → 真机上点「用回默认」会抛
              //    `ReferenceError: Can't find variable: pushShellNotifications`，
              //    于是它**后面两行（toast + 重画）根本不执行** ——
              //    用户看到的是"按钮点了没反应"。
              //    这是**同一种 bug 的第三次**（前两次：`refreshAlarmStatus` 漏导入、
              //    `scheduleAlarmsSoon` 根本不存在），所以这次顺手做了个机械预检：
              //    `node tools/js-preflight.mjs`（它正是靠它抓出来的）。
              //    ⚠️ 注意 `pushNotifications` 要**自己把数据传进去** ——
              //    app.js 那个 `pushShellNotifications()` 是它自己的包装函数（会读 store），
              //    这里没有那个包装，所以显式传当前状态。
              const st = store.getState();
              pushNotifications({ events: st.events, settings: st.settings });
              toast({ title: `第 ${tier} 档已用回默认`, timeout: 2200 });
              renderSoundBlock();
            },
          }));
        }
        return el('div', {
          style: {
            display: 'flex', gap: '10px', alignItems: 'center',
            flexWrap: 'wrap', padding: '7px 0', borderTop: '1px solid var(--line)',
          },
        }, [
          el('div', { style: { flex: '1', minWidth: '190px' } }, [
            el('b', { text: `第 ${tier} 档 · ${label}` }),
            el('small', {
              text: `　${when}`,
              style: { display: 'block', color: 'var(--muted)', fontSize: '12px' },
            }),
            el('small', {
              text: mine ? '✅ ' + desc : '· ' + desc,
              style: { display: 'block', color: mine ? 'var(--ok, #16a34a)' : 'var(--muted)', fontSize: '12px' },
            }),
          ]),
          el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, btns),
        ]);
      });
      mount(soundHost, el('div', { style: { marginTop: '10px' } }, [
        el('b', { text: '提示音（四档，可以换成你自己的音频）' }),
        el('p.tiny', {
          style: { margin: '4px 0 2px' },
          // ⚠️ 这里**不要写 Markdown 的 `**`**：界面是纯文本渲染的，
          //    用户看到的就是两个星号（这个坑不用别人提醒，渲染出来一眼就知道）
          text: '选一段音频（wav / m4a / mp3 都行），会自动转成 App 用的格式存进 App 里'
            + '（只取前 30 秒 —— 通知声音的系统上限就是 30 秒，超了会变成没声音）。'
            + '换完点下面的「🔔 试听当前档」听一下。',
        }),
        ...rows,
        !files.known
          ? el('p.tiny', { text: '（还没从系统读到已导入的文件列表 —— 点一下上面的按钮或重开一次 App）' })
          : null,
        el('p.tiny', {
          text: '⚠️ 最高档如果被做成「真闹钟」（AlarmKit），那一档用的是系统闹钟音 —— '
            + '真闹钟的自定义音在 iOS 26 上会放成系统错误音，所以这里不用它。',
        }),
      ].filter(Boolean)));
    }
    renderSoundBlock();

    const notifyActions = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
      el('button.btn.btn-sm', {
        text: permState === 'granted' ? '重新检查通知权限' : '开启浏览器通知权限',
        onclick: async () => {
          const p = await reminder.requestPermission();
          toast({
            title: p === 'granted' ? '浏览器通知已授权' : `权限状态：${p}`,
            kind: p === 'granted' ? 'ok' : 'err',
          });
          ctx.refresh();
        },
      }),
      el('button.btn.btn-sm', {
        text: '发送一条测试通知',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const res = await api.testNotification();
            toast({
              title: res.ok ? '已发送测试通知' : '系统通知发送失败',
              body: res.ok ? '看看屏幕右下角（或通知中心）' : '可查看 data/server.log 了解原因',
              kind: res.ok ? 'ok' : 'err',
              timeout: 5000,
            });
          } catch (err) {
            toast({ title: '测试失败', body: err.message, kind: 'err' });
          } finally { e.target.disabled = false; }
        },
      }),
      el('button.btn.btn-sm', {
        text: '页内弹一条测试提醒',
        onclick: () => window.dispatchEvent(new CustomEvent('timetable:test-toast')),
      }),
    ]);

    // ---- 自启 ----
    const autoLaunchRow = switchRow({
      title: '开机自动启动',
      desc: '登录 Windows 后静默在后台运行（写入注册表 HKCU\\...\\Run，无需管理员权限）',
      checked: !!s.autoLaunch,
      onChange: async (v) => {
        try {
          const res = await api.setAutoLaunch(v);
          await store.refresh({ silent: true });
          toast({
            title: res.autoLaunch ? '已设置开机自启' : '已取消开机自启',
            body: res.autoLaunch ? '下次登录会自动在后台启动服务' : '',
          });
          ctx.refresh();
        } catch (err) {
          toast({ title: '设置失败', body: err.message, kind: 'err', timeout: 6000 });
          ctx.refresh();
        }
      },
    });

    // ---- 数据 ----
    const restoreInput = el('input', {
      type: 'file', accept: '.json,application/json', style: { display: 'none' },
      onchange: async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const ok = await confirmDialog({
          title: '从备份恢复',
          message: `将用「${file.name}」覆盖当前全部数据，确定继续吗？`,
          confirmText: '覆盖恢复', danger: true,
        });
        if (!ok) return;
        try {
          const text = await file.text();
          const res = await api.restore(JSON.parse(text));
          await store.refresh();
          toast({ title: '恢复完成', body: `${res.events} 条日程 · ${res.courses} 门课程` });
          ctx.refresh();
        } catch (err) {
          toast({ title: '恢复失败', body: err.message, kind: 'err', timeout: 6000 });
        }
      },
    });

    /**
     * 把备份文本拿出来交给用户（复制走）。
     *
     * ⚠️⚠️ 为什么要有这条路（而不是只有"下载备份"那个链接）：
     *   那个链接用的是 `<a href="/api/backup" download>`：
     *     · **本地模式**（iPad 的主场）下 `backupUrl()` 是**空串** → 死按钮
     *     · **原生壳**里 WKWebView 没实现下载代理 → `download` 属性也不生效
     *   两头都不通，也就是说 **iPad 上根本拿不到备份** —— 而"重装 App 前先备份"
     *   恰恰是最需要它的时候。
     *
     *   所以这里改成：取文本 → 放进一个可选中的框 → 给一个复制按钮。
     *   并且**不让"复制"这一个环节决定成败**：复制失败时框里已经全选，
     *   用户长按拷贝也能拿到。
     */
    async function exportBackup() {
      // ⚠️⚠️ **先把窗口打开，再去取数据** —— 保证"点了必有反应"。
      //
      //   这里踩过一次真实的坑，值得写下来：
      //     我调了 `openModal` 却**忘了 import 它**（本文件原本只 import 了 confirmDialog）。
      //     于是点击后：取数据成功 → 走到 `openModal(...)` → **ReferenceError**。
      //     而 `exportBackup` 是 **async** 函数，这个错就变成**未处理的 Promise 拒绝** ——
      //     界面上**一点动静都没有**，用户只会说"点了没反应"，根本无从查起。
      //   教训：**点击类异步函数绝不能把异常留成未处理拒绝**。
      //   现在的写法是所有失败都在界面上说出来，而且窗口先开、内容后填。
      let dlg = null;
      const ta = el('textarea', {
        style: { width: '100%', height: '220px', fontFamily: 'ui-monospace, monospace', fontSize: '12px' },
      });
      const hint = el('p.tiny', { text: '正在读取本机数据…' });
      const copyBtn = el('button.btn.btn-primary', { text: '复制全部' });
      const fail = (err) => {
        const msg = String((err && err.message) || err);
        hint.textContent = '导出失败：' + msg + '（把这一行截图给我）';
        toast({ title: '导出失败', body: msg, kind: 'err', timeout: 8000 });
      };
      try {
        dlg = openModal({
          title: '数据备份',
          width: 680,
          body: el('div', {}, [hint, ta]),
          footer: [copyBtn],
        });
      } catch (err) {
        // 连窗口都开不出来（比如又忘了 import）—— 至少要说出来，不能静默
        fail(err);
        return;
      }

      let text = '';
      try {
        text = await api.exportText();
      } catch (err) {
        fail(err);
        return;
      }
      ta.value = text;
      ta.readOnly = true;
      hint.textContent = `共 ${text.length} 个字符。点「复制全部」→ 粘到「备忘录」或「文件」里存着。`
        + '重装 App、换设备、以后想恢复都用得上。复制不成功也没关系：框里已经全选，长按拷贝即可。';

      copyBtn.addEventListener('click', async () => {
        try {
          ta.focus(); ta.select();
          await navigator.clipboard.writeText(text);
          toast({ title: '已复制', body: '找地方粘上（备忘录 / 文件）就是备份了', timeout: 5000 });
        } catch {
          // 退路：execCommand；再不行就明确告诉用户手动复制（别假装成功）
          ta.focus(); ta.select();
          let ok = false;
          try { ok = !!(document.execCommand && document.execCommand('copy')); } catch { ok = false; }
          toast(ok
            ? { title: '已复制', timeout: 4000 }
            : { title: '复制不了', body: '框里已全选，长按 → 拷贝', kind: 'err', timeout: 7000 });
        }
      });
      setTimeout(() => { try { ta.focus(); ta.select(); } catch { /* ignore */ } }, 60);
    }

    const dataActions = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
      // ⚠️ 只在**真的能下载**时才显示这个链接。本地模式下 `backupUrl()` 是空串，
      //    `href=""` 的按钮点下去什么都不发生 —— 用户会以为"备份好了"，
      //    其实一份都没存下来。**死按钮比没有按钮更坏。**
      ...(api.backupUrl() ? [el('a.btn.btn-sm', { href: api.backupUrl(), download: '' }, ['下载全部数据备份'])] : []),
      el('button.btn.btn-sm', { text: '📋 导出备份（可复制）', onclick: () => exportBackup() }),
      el('button.btn.btn-sm', { text: '从备份恢复', onclick: () => restoreInput.click() }),
      el('button.btn.btn-sm.btn-danger', {
        text: '清空所有日程',
        onclick: async () => {
          const ok = await confirmDialog({
            title: '清空所有日程',
            message: '日程和课程都会被删除，且无法撤销。建议先下载备份。',
            confirmText: '清空', danger: true,
          });
          if (!ok) return;
          try {
            const res = await api.clearEvents(false);
            await store.refresh();
            toast({ title: '已清空', body: `删除 ${res.removed} 条` });
            ctx.refresh();
          } catch (err) {
            toast({ title: '清空失败', body: err.message, kind: 'err' });
          }
        },
      }),
      restoreInput,
    ]);

    // ---- 手机 / 其他设备接入 ----
    const netHost = el('div');
    const joinHost = el('div');
    // ---- 系统日历订阅（iPad 关掉 App 也能响提醒的唯一可靠办法）----
    const calendarHost = el('div');
    (async () => {
      // ⚠️ `net` 必须声明在 try 外面：日历那段要用它拼订阅地址，
      //    而 `const net = await api.net()` 写在 try 里的话，出了 try 就不在作用域内
      //    —— 那会抛 ReferenceError，且因为这里是 async，错误只以
      //    unhandledRejection 的形式出现（"设置页渲染没崩但订阅卡片永远不出现"）。
      let net = null;
      try {
        // 走适配器，不直接 fetch —— 视图层不该自己碰网络（见 adapter/api.js 的注释）
        const netData = await api.net();
        net = netData;
        const qr = el('div.settings-qr');
        if (net.primary) {
          qr.innerHTML = await api.qr(net.primary);
        }
        const links = (net.urls || []).map((u) => el('a.btn.btn-sm', { href: u, target: '_blank', rel: 'noreferrer' }, [u]));
        const joinUrl = `${location.origin}/join`;
        mount(netHost, [
          net.primary ? qr : el('p.tiny', { text: '未检测到局域网地址：请确认电脑已连上 WiFi 或网线。' }),
          el('p', { style: { marginTop: '8px', fontSize: '13px' } }, [
            el('b', { text: '手机扫码即达：' }),
            net.hasCert
              ? '用手机相机/微信扫上面的码，或在浏览器输入下面的地址（首次会提示"证书不安全"，点继续即可）。'
              : '用手机浏览器输入下面的地址。注意：电脑端还没生成证书，安卓此时无法"添加到主屏幕"。',
          ]),
          el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } }, links),
          el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } }, [
            el('a.btn.btn-sm', { href: joinUrl, target: '_blank', rel: 'noreferrer' }, ['打开手机接入引导页 /join']),
            el('button.btn.btn-sm', {
              text: '复制接入地址',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(net.primary || joinUrl);
                  toast({ title: '已复制', body: net.primary || joinUrl, timeout: 2000 });
                } catch {
                  toast({ title: '复制失败', body: net.primary || joinUrl, kind: 'err', timeout: 5000 });
                }
              },
            }),
          ]),
        ]);
        mount(joinHost, [
          el('ol', { style: { paddingLeft: '20px', fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '4px' } }, [
            el('li', { text: '手机连上和电脑同一个 WiFi' }),
            el('li', { text: '用相机/微信扫上面的二维码，打开那个 https 地址' }),
            el('li', { text: '首次提示"证书不安全" → 高级 → 继续前往（这是自签名证书的正常现象）' }),
            el('li', { text: '浏览器菜单 → 添加到主屏幕 / 安装应用' }),
            el('li', { text: '回到手机桌面，点「日程表」图标即可全屏使用，和 App 一样' }),
          ]),
          el('p.tiny', { text: '数据存在这台电脑上，手机只是前端；电脑上的服务要一直开着（关掉就打不开）。' }),
        ]);
      } catch (err) {
        mount(netHost, [el('p.tiny', { text: `读取接入信息失败：${err.message}` })]);
      }

      // ---- 拼出订阅地址并渲染 ----
      //
      // ⚠️⚠️ 这里优先给 **http（7080）**，不给 https（7443）—— 踩过，别改回去。
      //
      //   实测现象（用户报的）：「一点查找就说"不安全连接"，点继续之后
      //   **https 被偷偷改成了 http**」，然后报「验证失败，请编辑URL，然后重试」。
      //
      //   原因：`webcal://` 这个 scheme 按惯例会被客户端解析成 **http**（它比 https 老）。
      //   iOS 把 `webcal://host:7443/...` 改写成 `http://host:7443/...` ——
      //   **端口还是 7443，可 7443 只讲 TLS**。明文请求打到 TLS 监听上会被直接掐断
      //   （curl 的表现是 exit 52「Empty reply from server」）。
      //   于是"证书明明没问题"却永远验证失败。
      //
      //   所以：
      //     · 给用户抄的地址、以及 webcal 链接，都指向 **http 的 7080** —— 它明文就能取到日历。
      //     · https 仍然给（证书信任好之后更稳），但作为**备选**，不当默认。
      const httpsBase = (net && net.httpsUrls && net.httpsUrls[0]) || '';
      const httpBase = (net && net.httpUrls && net.httpUrls[0]) || '';
      const httpFeed = httpBase ? `${httpBase}/calendar.ics` : '';
      const httpsFeed = httpsBase ? `${httpsBase}/calendar.ics` : '';
      const feedUrl = httpFeed || httpsFeed;
      // webcal 会被改写成 http，所以必须配 http 那个端口
      const webcal = feedUrl.replace(/^https?:\/\//, 'webcal://');

      mount(calendarHost, feedUrl ? [
        el('p', { style: { fontSize: '13px' } }, [
          el('b', { text: '为什么需要：' }),
          '网页版提醒是页面里定时自查的，App 不开就不检查；安卓能用系统闹钟，iOS 装不了 APK。'
            + '让 iOS 的「日历」订阅这份源，提醒就由系统发出 —— 电脑关着也照响。',
        ]),
        el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } }, [
          el('a.btn.btn-sm.btn-primary', { href: webcal }, ['在 iPad 上点此订阅（webcal）']),
          el('a.btn.btn-sm', { href: feedUrl, target: '_blank', rel: 'noreferrer' }, ['预览 .ics']),
          // 兜底路径：下载成文件，隔空投送/邮件送到 iPad 后点开一次性导入。
          // 它不经过 URL 校验、不碰证书 —— 订阅报「验证失败，请编辑URL」时走这条。
          el('a.btn.btn-sm', { href: `${feedUrl}?download=1` }, ['下载 .ics 文件（一次性导入）']),
          el('button.btn.btn-sm', {
            text: '复制订阅地址',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(feedUrl);
                toast({ title: '已复制', body: feedUrl, timeout: 2500 });
              } catch {
                toast({ title: '复制失败，请手动抄写', body: feedUrl, kind: 'err', timeout: 8000 });
              }
            },
          }),
        ]),
        el('p.tiny', { style: { marginTop: '8px', wordBreak: 'break-all' }, text: feedUrl }),
        httpsFeed
          ? el('p.tiny', {
            style: { wordBreak: 'break-all' },
            text: `备选（证书信任后可改用 https）：${httpsFeed}`,
          })
          : null,
        el('p.tiny', { text: 'iPad 上手动添加：设置 → 日历 → 账户 → 添加账户 → 其他 → 添加已订阅的日历 → 粘贴上面的地址。' }),
        el('p.tiny', {
          style: { color: 'var(--warn, #b45309)' },
          text: '⚠️ 订阅后进「设置 → 日历 → 账户 → 已订阅的日历 → 点这条」，确认「移除提醒」是**关闭**的（默认关闭）。开着就不会响提醒。',
        }),
        el('p.tiny', {
          text: '⚠️ 如果报「验证失败，请编辑URL，然后重试」：多半是地址被改写成了 http 却仍指向 https 的 7443 端口。'
            + '用上面这个 **http（7080）** 地址，它明文就能取到日历。',
        }),
      ] : [
        el('p.tiny', { text: '要先开启「手机可访问」（用 npm run start:lan 启动，或加 --lan），才知道该用哪个局域网地址。' }),
      ]);
    })();

    // ---- 关于 ----
    const h = state.health || {};
    const info = el('dl.kv', { style: { flexDirection: 'column', gap: '6px' } }, [
      // ⚠️ 原来这里写死 `'v0.3.0（手机可用版）'`（一路错到 0.12.0）。现在：
      //    有服务端就用它报的版本，本机独立模式才用 core/defaults.js 的常量。
      kv('版本', h.version ? `v${h.version}` : `v${APP_VERSION}`),
      kv('服务地址', h.baseUrl || '—'),
      kv('手机访问', h.lan ? (h.lanUrls || []).join('  ') || '已开启，未检测到局域网地址' : '未开启（用 npm run start:lan 启动，或加 --lan）'),
      kv('HTTPS', h.hasCert ? `已启用 :${h.httpsPort}` : '未启用（手机无法"添加到主屏幕"）'),
      kv('运行环境', `${h.platform || '—'} · Node ${h.node || '—'}`),
      kv('数据文件', h.dbFile || '—'),
      kv('服务启动于', h.startedAt ? asDate(h.startedAt).toLocaleString('zh-CN', { hour12: false }) : '—'),
      kv('日程 / 课程', `${state.events.length} 条 / ${state.courses.length} 门`),
      kv('同步版本号', `rev ${state.rev}`),
    ]);


    mount(host, el('div', { style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '900px' } }, [
      // ---- 「简约版」三档预设（0.11.0）：**放在最上面** ----
      //
      // 为什么必须在第一位：用户说"返璞归真"，那他要找的就是这个开关；
      // 埋在"数据"或"通知"下面等于没有。它也是首次引导那张卡片的"常驻版"——
      // 引导可以跳过，但这里随时能回来选。
      // ⚠️ `onDone` 走的是 `ctx.refresh()`（重新拉状态再整页重画）：
      //    应用之后"当前档位"那行字必须立刻跟着变，否则用户会以为没生效。
      el('div.card.panel', {}, [
        el('h2', { text: '使用程度（极简 / 标准 / 全功能）' }),
        el('p.tiny', {
          style: { margin: '0 0 8px' },
          text: '只调开关，不动数据：日程、课程、活动记录一个字节都不会变。',
        }),
        presetBlock({ settings: s, onDone: () => ctx.refresh() }),
      ]),

      el('div.card.panel', {}, [
        el('h2', { text: '基本' }),
        el('div.field-grid', {}, [
          el('div', {}, [el('label', { text: '称呼' }), ownerInput]),
          el('div', {}, [el('label', { text: '今天最重要的一件事' }), todoInput]),
          el('div', {}, [el('label', { text: '学期第一周周一' }), termStartInput]),
          el('div', {}, [el('label', { text: '学期总周数' }), termWeeksInput]),
        ]),
        el('div', {}, [el('label', { text: '新日程默认提醒' }), defaultReminderHost]),
        el('div', { style: { display: 'flex', gap: '8px' } }, [
          el('button.btn.btn-primary', { text: '保存设置', onclick: saveBasic }),
        ]),
      ]),

      // 本机独立模式：平板脱离电脑的开关（4b）
      el('div.card.panel', {}, [
        el('h2', { text: '本机独立模式（不依赖电脑）' }),
        localHost,
      ]),

      // 同步范围：和电脑同步时带上哪些东西（4c / item 2）
      el('div.card.panel', {}, [
        el('h2', { text: '同步范围（和电脑同步哪些东西）' }),
        syncHost,
      ]),

      el('div.card.panel', {}, [
        el('h2', { text: '手机 / 平板接入' }),
        netHost,
        joinHost,
      ]),



      // 提醒的"最后一道保险"：iOS 关掉 App 也要能响，只能靠系统日历
      el('div.card.panel', {}, [
        el('h2', { text: 'iPad / iPhone：订阅到系统日历' }),
        calendarHost,
      ]),

      el('div.card.panel', {}, [
        el('h2', { text: '提醒' }),
        el('p.tiny', { text: `浏览器通知权限：${permText}` }),
        notifyDesktop, notifyBrowser, notifySound,
        // 三档提示音各自可以换成用户自己的音频（只在原生壳里出现）
        soundHost,

        // ---- 强度（这一块是"力度够不够大"的旋钮）----
        el('div', { style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--line)' } }, [
          el('b', { text: '提醒强度' }),
          el('p.tiny', { style: { margin: '4px 0 8px' }, text: '控制通知会不会自动消失、响几遍、音量多大。听不出差别就点「试听当前档」。' }),
          intensityHost,
          intensityHint,
          // 周期只管显示还是也管提醒 —— 放在强度下面，因为两者都是"提醒够不够"的旋钮
          el('div', { style: { marginTop: '10px' } }, [periodScopeRow]),
          // ---- 原生壳里的"系统提醒"状态 + 测试 ----
          //
          // 为什么要露出来（用户实测："到时间也没看到它提醒"）：
          //   在 iOS 壳里，"没响"有好几种完全不同的原因 —— 不在壳内 / 计划是空的 /
          //   系统权限没给。前两种 JS 知道，第三种只有真发一条才知道。
          //   把这行字和一个测试按钮放在一起，一眼就能劈开。
          shellStatusBlock,
          el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' } }, [
            el('button.btn.btn-sm', {
              text: '🔔 试听当前档',
              onclick: async () => {
                // 力度是听觉属性，光看"强度 3"没人知道多响 —— 直接放一遍最快
                const st = store.getState().settings;
                const cur = (st.notify || {}).intensity;
                let lv = cur;
                if (cur === 'auto' || cur == null) {
                  // 自动档没有一个固定值，用"最紧急"那档来试听最直观
                  lv = 4;
                  toast({ title: '当前是「自动」档', body: '自动档按剩余时间变化，下面放的是最紧急时的效果', timeout: 4000 });
                }
                const r = reminder.previewIntensity(lv);
                if (reminder.permission() !== 'granted') {
                  toast({ title: `强度 ${r.level}：已播提示音`, body: '还没授权浏览器通知，所以看不到通知长什么样', kind: 'err', timeout: 6000 });
                }
              },
            }),
          ]),
        ]),

        notifyActions,
        el('p.tiny', { text: '两套提醒同时生效：页面开着走浏览器通知，页面关掉由后台服务发系统通知。' }),
      ]),

      // ---- 课程摘要提醒 ----
      // 用户需求："前一天晚上提醒明天课程，早上提醒上午课程，中午提醒下午课程，
      //           傍晚提醒晚上课程……何时提醒、要不要提醒都能调"
      el('div.card.panel', {}, [
        el('h2', { text: '课程摘要提醒' }),
        el('p.tiny', {
          text: '按"一段时间"汇总课程，一天最多发几条 —— 比"每门课各提醒好几次"温和得多。'
            + '只汇总课表导入的课程，日程/作业不受影响。',
        }),
        el('label.switch-row', {}, [
          el('span', {}, [
            el('b', { text: '开启课程摘要' }),
            el('small', { text: '总开关；关掉后下面全部不生效', style: { display: 'block', color: 'var(--muted)', fontSize: '12px' } }),
          ]),
          digestEnabled,
        ]),
        digestSlotHost,
        el('label.switch-row', {}, [
          el('span', {}, [
            el('b', { text: '另外保留"逐条提醒课程"' }),
            el('small', {
              text: '每门课各按剩余时间提醒（1 小时前 / 30 分 / 10 分 / 准点）。'
                + '开了会跟摘要重复，默认关。',
              style: { display: 'block', color: 'var(--muted)', fontSize: '12px' },
            }),
          ]),
          digestPerCourse,
        ]),
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
          el('button.btn.btn-primary', { text: '保存摘要设置', onclick: saveDigest }),
          el('button.btn.btn-sm', {
            text: '现在试一条',
            onclick: async () => {
              // 不改设置、不动账本，只看"此刻会发出什么"——方便调时间
              try {
                const st = store.getState();
                const now = new Date();
                const mod = await import('../../../core/course-digest.js');
                const cfg = mod.normalizeDigest({ ...digestDraft, enabled: true });
                // 把"现在"当成每个槽位的时间来试算
                const probes = [];
                for (const slot of mod.DIGEST_SLOTS) {
                  const t = new Date(now);
                  const [hh, mm] = (digestDraft.slots[slot.key]?.at || slot.defaultAt).split(':').map(Number);
                  t.setHours(hh, mm, 0, 0);
                  const r = mod.dueDigests({
                    events: st.events,
                    settings: { ...st.settings, courseDigest: cfg },
                    now: t,
                  });
                  if (r.length) probes.push(r[0]);
                }
                if (!probes.length) {
                  toast({ title: '此刻没有该发的摘要', body: '可能是：还没到时间、那段时间没课、或今天已经发过了', timeout: 6000 });
                  return;
                }
                const p = probes[0];
                toast({
                  title: `📚 ${p.title}`,
                  body: p.body,
                  timeout: 12000,
                });
              } catch (err) {
                toast({ title: '试算失败', body: String(err && err.message || err), kind: 'err' });
              }
            },
          }),
        ]),
      ]),

      el('div.card.panel', {}, [
        el('h2', { text: '启动方式' }),
        autoLaunchRow,
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
          el('button.btn.btn-sm', {
            text: '打开数据文件夹',
            onclick: () => toast({ title: '路径', body: h.dataDir || '', timeout: 6000 }),
          }),
          el('button.btn.btn-sm', {
            text: '查看服务日志',
            onclick: () => window.open(api.healthUrl(), '_blank'),
          }),
        ]),
      ]),

      el('div.card.panel', {}, [
        el('h2', { text: '数据' }),
        // ⚠️ 这句话**必须随模式变**。原来写死成"保存在本机 data/db.json" ——
        //    那是**连电脑**时的位置；而 iPad 上跑的是本机独立模式，数据在
        //    这台设备的 IndexedDB 里，跟电脑上的 db.json 毫无关系。
        //    用户正看着这句想"我的备份在哪"，说错位置会直接把人带偏。
        el('p.tiny', {
          text: getApiMode() === 'local'
            ? '数据只存在**这台设备**上（浏览器的 IndexedDB），不上传任何服务器。'
              + '卸载 App 会连数据一起删掉 —— 所以想留底就点下面的「导出备份」。'
            : '数据保存在电脑的 data/db.json，不上传任何服务器。换电脑时下载备份再恢复即可。',
        }),
        dataActions,
      ]),

      el('div.card.panel', {}, [
        el('h2', { text: '关于' }),
        info,
      ]),
    ]));
  },
};

function kv(k, v) {
  return el('div', { style: { display: 'flex', gap: '10px' } }, [
    el('dt', { text: k }),
    el('dd', { text: String(v), style: { wordBreak: 'break-all' } }),
  ]);
}

function switchRow({ title, desc, checked, onChange }) {
  const input = el('input', { type: 'checkbox', checked });
  input.addEventListener('change', () => onChange(input.checked));
  return el('div.switch-row', {}, [
    el('div.sr-text', {}, [el('b', { text: title }), desc ? el('small', { text: desc }) : null]),
    el('label.switch', {}, [input, el('span.track')]),
  ]);
}
