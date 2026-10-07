// 「闹钟」板块的纯逻辑验收套件（core/alarms.js + core/state-ops.js 的增删改）。
//
// ⚠️ 为什么这些断言值得写死：
//   闹钟的失败方式**几乎全是"静默"的** —— 不响、响错日子、每天重复响、
//   或者"关了以后再也不响"。这些都不会报错，只会在某天早上发生，
//   而那时用户只会觉得"这 App 的闹钟不可靠"，不会去查代码。
//   所以每一个时间规则都用**固定时刻**钉住（不依赖真实时钟）。
//
// 跑法：node tools/alarms.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import {
  ALARM_LIMIT, ALARM_SOUNDS, DEFAULT_SOUND_ID, MAX_SCHEDULED, TIMER_PRESETS,
  ALARM_KINDS, ALARM_REPEATS, REPEAT_LABEL,
  alarmId, alarmTitle, describeAlarm, describeNextFire, describeSchedule,
  formatCountdown, formatDuration, markFired, newAlarm, nextFireAt, normalizeAlarm,
  planAlarmSchedule, soundById, soundFileOf, timerEndsAt, timerRemainingMs,
  validateAlarm, weekdaysOf,
  // 2026-10-02 多首自定义铃声（m01328）新加的这套：id 前缀/老 id/校验/取名/可用性
  CUSTOM_SOUND_PREFIX, LEGACY_CUSTOM_SOUND_ID, customSoundId, isCustomSoundId,
  customSoundKey, normalizeCustomSounds, soundAvailable, soundLabelOf,
  // 2026-10-02「全部闹钟」（m03912）：状态 / 排序 / 计数
  ALARM_PHASES, PHASE_LABEL, alarmPhase, staleTimers, sortAlarmsForDisplay,
  summarizeAlarms, describeAlarmCount,
} from '../core/alarms.js';
import { upsertAlarm, removeAlarm, toggleAlarm } from '../core/state-ops.js';
import { defaultDb } from '../core/defaults.js';

/** 固定的"现在"：2026-03-02 是**周一**（本套件全程用它，绝不用真实时钟） */
const NOW = new Date('2026-03-02T06:30:00');
const at = (s) => new Date(s);

/**
 * 造一个时钟闹钟。
 *
 * ⚠️ 这里为什么绕了一下（先展开 patch、再按需补缺省）：
 *    写成 `newAlarm({ kind:'clock', atHour:7, atMinute:0, ...patch })` 看起来对，
 *    但 patch 里**没写** atHour 时，展开出来的是 `atHour: undefined` ——
 *    而 undefined **会覆盖掉前面的 7**（对象展开的坑：键存在就覆盖，不看值）。
 *    第一版就是这样，于是 `clock({atHour:6})` 变成了 7:00，
 *    测试报的却是"已过去的那条被排了" —— 一个**假失败**，比真失败更浪费时间。
 */
const clock = (patch) => {
  const p = (patch && typeof patch === 'object') ? patch : {};
  const out = { atHour: 7, atMinute: 0, kind: 'clock', ...p };
  if (p.atHour === undefined) out.atHour = 7;
  if (p.atMinute === undefined) out.atMinute = 0;
  if (p.kind === undefined) out.kind = 'clock';
  return newAlarm(out, NOW);
};

// ---------------------------------------------------------------------------
// ① 归一化 / 校验
// ---------------------------------------------------------------------------

test('归一化：脏数据不许把列表带崩，也不许把排程带歪', () => {
  const a = normalizeAlarm({
    kind: '瞎写的', repeat: '瞎写的', atHour: 99, atMinute: -5,
    weekdays: [9, 'x', 3, 3, 1], sound: '不存在的铃声', label: 'x'.repeat(50),
    durationMs: -100,
  }, NOW);
  assert.equal(a.kind, 'clock', '认不出来的 kind 要退回 clock');
  assert.equal(a.repeat, 'once', '认不出来的 repeat 要退回 once');
  assert.equal(a.atHour, 23, '小时越界要夹回 23');
  assert.equal(a.atMinute, 0, '分钟越界要夹回 0');
  assert.deepEqual(a.weekdays, [1, 3], 'weekdays 要去重、排序、丢掉 0..6 之外的');
  assert.equal(a.sound, DEFAULT_SOUND_ID, '认不出来的铃声要退回默认（不能是空串）');
  assert.equal(a.label.length, 24, '标签按 24 字截断（锁屏会截得更狠）');
  assert.ok(a.durationMs >= 1000, '时长不能是负数/0');
  assert.ok(a.id && a.id.startsWith('alarm_'), '没有 id 时要补一个');
});

test('归一化：传了 now 就绝不许偷偷用真实时钟', () => {
  // ⚠️ 这条是**真抓过一次 bug 的**：原来写的是 `asDate(now || new Date())`，
  //    而 `asDate(undefined)` 会掉回真实时钟 —— 于是同一个 fixture 隔天就红。
  const a = normalizeAlarm({ kind: 'clock', atHour: 7 }, NOW);
  assert.ok(a.createdAt.startsWith('2026-03-01T22:30'),
    `createdAt 应当来自 NOW（UTC+8 的 2026-03-02T06:30），实际=${a.createdAt}`);
  // 幂等：再归一化一次不许改任何时间戳
  const b = normalizeAlarm(a, NOW);
  assert.equal(b.createdAt, a.createdAt);
  assert.equal(b.updatedAt, a.updatedAt);
});

test('校验：边界值该过就过、该拦就拦，而且都给错误码', () => {
  // ⚠️ 校验这一组**故意不走 clock()**（那个 helper 会经过 newAlarm 归一化）：
  //    生产路径是"**先校验用户填的原始对象**、通过了再归一化落库"
  //    （见 core/state-ops.js 的 upsertAlarm）。用 helper 造对象再校验，
  //    等于在测一个不存在的调用方式 —— 而且归一化会把 24 点夹成 23，
  //    于是"该拦的没拦"看起来像 bug，其实是测试写错了。
  const raw = (patch) => ({ kind: 'clock', atHour: 7, atMinute: 0, repeat: 'once', ...patch });

  const ok = validateAlarm(raw({ atHour: 0, atMinute: 0, repeat: 'daily' }));
  assert.equal(ok.ok, true, '00:00 每天是合法的' + JSON.stringify(ok.errors));
  assert.deepEqual(ok.errors, []);

  const hour = validateAlarm(raw({ atHour: 24 }));
  assert.equal(hour.ok, false, '24 点必须被拦住（不许静默夹成 23）');
  assert.equal(hour.errors[0].code, 'ALARM_HOUR', '错误要带**码**（界面按码取人话）');
  assert.match(hour.errors[0].message, /小时/, '也要带中文人话（用户看的是这个）');

  assert.equal(validateAlarm(raw({ atHour: 'abc' })).errors[0].code, 'ALARM_HOUR', '不是数字也要拦');
  assert.equal(validateAlarm(raw({ atHour: -1 })).errors[0].code, 'ALARM_HOUR');
  assert.equal(validateAlarm(raw({ atHour: 23, atMinute: 59 })).ok, true, '边界内要放行');
  assert.equal(validateAlarm(raw({ atMinute: 60 })).errors[0].code, 'ALARM_MINUTE');
  assert.equal(validateAlarm(raw({ repeat: '每天' })).errors[0].code, 'ALARM_REPEAT');
  assert.equal(validateAlarm(raw({ repeat: 'custom', weekdays: [] })).errors[0].code, 'ALARM_WEEKDAYS');
  assert.equal(validateAlarm({ kind: 'clock', atHour: 7, atMinute: 0, repeat: 'custom', weekdays: [1] }).ok, true);
  assert.equal(validateAlarm({ kind: 'timer', durationMs: 0 }).errors[0].code, 'ALARM_DURATION_MIN');
  assert.equal(validateAlarm({ kind: 'timer', durationMs: 1000 }).ok, true, '正好 1 秒要合法');
  assert.equal(validateAlarm({ kind: 'timer', durationMs: 25 * 3600 * 1000 }).errors[0].code, 'ALARM_DURATION_MAX');
  assert.equal(validateAlarm({ kind: 'timer', durationMs: 24 * 3600 * 1000 }).ok, true, '正好 24 小时要合法');
  assert.equal(validateAlarm({ kind: 'timer', durationMs: 'abc' }).errors[0].code, 'ALARM_DURATION');
  assert.equal(validateAlarm(raw({ sound: '没有这个铃声' })).errors[0].code, 'ALARM_SOUND');
  assert.equal(validateAlarm(raw({ label: 'x'.repeat(25) })).errors[0].code, 'ALARM_LABEL');
  // ⚠️ 多错一起报：只报第一个的话，用户会一轮一轮地改（"改完小时又说分钟"）
  const many = validateAlarm({ kind: 'clock', atHour: 99, atMinute: 99, repeat: 'x', sound: 'y', label: 'z'.repeat(30) });
  assert.ok(many.errors.length >= 4, `多条错要一起报，实际 ${many.errors.length} 条`);
});

test('铃声目录：每个音都有文件、id 不重复，且"认不出来"返回 null 而不是空串', () => {
  assert.ok(ALARM_SOUNDS.length >= 3, '至少要有三个铃声（用户要求 3–5 个）');
  const ids = new Set(ALARM_SOUNDS.map((s) => s.id));
  assert.equal(ids.size, ALARM_SOUNDS.length, '铃声 id 不许重复');
  for (const s of ALARM_SOUNDS) {
    // ⚠️ 2026-10-01：「自定义（我导入的）」那一档**故意没有包内文件** ——
    //    它的 `file` 是空串，真实文件名带时间戳、运行时才由壳报上来
    //    （存在 App 容器的 `Library/Sounds`，不进仓库也不进包）。
    //    所以它单独断言"file 必须是空串"，其余各档仍要求"不带扩展名的包内名字"。
    if (s.id === 'custom') {
      assert.equal(s.file, '',
        '「自定义」那一档的 file 必须是空串（真实文件名在 App 容器的 Library/Sounds，运行时才有）');
      assert.ok(s.label && s.desc, `铃声 ${s.id} 缺中文名/说明`);
      assert.equal(LEGACY_CUSTOM_SOUND_ID, s.id, '老 id 常量必须还是目录里那一条的 id');
      continue;
    }
    assert.ok(s.file && !s.file.includes('.'), `铃声文件应当**不带扩展名**（named() 的用法）：${s.file}`);
    assert.ok(s.label && s.desc, `铃声 ${s.id} 缺中文名/说明`);
  }
  // ⚠️ 断言里写的是**真实文件名**（不是 id）—— id 与文件名的映射是这一层唯一的职责，
  //    改了文件名而没改这里，就会在真机上变成"静默放系统默认音"。
  assert.equal(soundFileOf('morning'), 'alarm-morning-bell');
  assert.equal(soundFileOf('beep'), 'alarm-beep-pips-x');
  assert.equal(soundFileOf('没有这个'), null, '认不出来必须是 null（空串会变成"静默没声音"）');
  // ⚠️「自定义」那一档要**靠调用方把真实文件名传进来**（`opts.customFile`）：
  //    不传 = 返回 null（= 用系统默认音），**绝不返回空串**。
  assert.equal(soundFileOf('custom'), null, '自定义铃声没传文件名时必须返回 null（不能返回空串）');
  assert.equal(soundFileOf('custom', { customFile: 'timetable-custom-t0-1696.caf' }),
    'timetable-custom-t0-1696.caf',
    '自定义铃声要原样用调用方给的文件名（老名字也必须认 —— 那是老用户文件里的真名）');
  assert.equal(soundFileOf('custom', { customFile: '' }), null, '空文件名 = 没得用 → null');
  assert.equal(soundById(null), null);
  assert.ok(soundById(DEFAULT_SOUND_ID), '默认铃声必须在目录里');
});

test('⭐ 目录里的铃声文件真的在 App 包里（不在 = iOS 会静默放默认音）', () => {
  // ⚠️ 这条断言的价值全在"静默"两个字上：
  //    `AlertSound.named("alarm-morning")` 找不到文件时**不报错**，
  //    只是放系统默认闹钟音。所以"文件没生成 / 名字改了 / 被删了"
  //    在真机上的表现只是"铃声不对"，没有任何日志能提示你。
  //    这里用文件系统核对一遍，把那种静默失败挡在提交之前。
  const dir = path.join(ROOT, 'ios', 'Timetable');
  for (const s of ALARM_SOUNDS) {
    // ⚠️ 2026-10-01：跳过「自定义」那一档 —— 它的音频在 **App 容器的 Library/Sounds**，
    //    是**用户运行时导入**的，包内当然没有（这正是它与内置五档的本质区别）。
    if (s.id === 'custom') continue;
    const p = path.join(dir, `${s.file}.caf`);
    assert.ok(fs.existsSync(p),
      `缺文件 ios/Timetable/${s.file}.caf —— 跑 \`node tools/gen-alarm-sounds.mjs\` 生成它。`
      + '（缺了的话真机上会静默放系统默认音，用户只会觉得"铃声功能坏了"）');
    const size = fs.statSync(p).size;
    assert.ok(size > 5000, `${s.file}.caf 只有 ${size} 字节，不像是有效的音频`);
  }
  // 反向也看一眼：目录里不许有"没人用的" alarm-*.caf（那会白涨包体积）
  const onDisk = fs.readdirSync(dir).filter((f) => /^alarm-.*\.caf$/.test(f));
  const wanted = new Set(ALARM_SOUNDS.map((s) => `${s.file}.caf`));
  for (const f of onDisk) {
    assert.ok(wanted.has(f), `ios/Timetable/${f} 没有出现在铃声目录里（白占包体积，或者目录漏了一项）`);
  }
  // ⚠️ 2026-10-01 补一条**反向**检查（这条是防"版权音频又混进仓库"的）：
  //    用户导入的铃声文件**绝不该**出现在 `ios/Timetable/`（那里会被打进公开包）。
  //    曾经为了验证功能临时放过一个（`alarm-custom-railgun.caf`），验完必须撤掉 ——
  //    这条断言就是那次事故留下的护栏。
  const userImported = fs.readdirSync(dir).filter((f) => /^timetable-custom-/.test(f));
  assert.deepEqual(userImported, [],
    'ios/Timetable/ 里出现了**用户导入的铃声文件**（它们应当只存在于 App 容器的 Library/Sounds）：\n  '
    + userImported.join('\n  ')
    + '\n这类文件可能是有版权的音频，绝不能被打进包/提交进仓库。');
});

// ---------------------------------------------------------------------------
// ② nextFireAt：重复 / 跨天 / 已过点顺延
// ---------------------------------------------------------------------------

test('nextFireAt：今天还没到 → 今天；已经过了 → 顺延到明天', () => {
  const a = clock({ atHour: 7, atMinute: 0, repeat: 'daily' });
  assert.equal(nextFireAt(a, at('2026-03-02T06:30:00')).getTime(), at('2026-03-02T07:00:00').getTime());
  assert.equal(nextFireAt(a, at('2026-03-02T07:00:00')).getTime(), at('2026-03-03T07:00:00').getTime(),
    '**恰好等于**那一分钟时要顺延（不能返回一个已经过去的时刻）');
  assert.equal(nextFireAt(a, at('2026-03-02T07:00:01')).getTime(), at('2026-03-03T07:00:00').getTime());
  assert.equal(nextFireAt(a, at('2026-03-02T23:59:59')).getTime(), at('2026-03-03T07:00:00').getTime(),
    '跨天：晚上算出明天早上');
});

test('nextFireAt：秒与毫秒一律抹成 0', () => {
  const a = clock({ atHour: 7, atMinute: 0, repeat: 'daily' });
  const n = nextFireAt(a, at('2026-03-02T06:59:59.500'));
  assert.equal(n.getSeconds(), 0);
  assert.equal(n.getMilliseconds(), 0);
  assert.equal(n.getTime(), at('2026-03-02T07:00:00.000').getTime());
});

test('nextFireAt：工作日 = 周一至周五（跨周末）', () => {
  const a = clock({ atHour: 7, atMinute: 0, repeat: 'weekdays' });
  // 2026-03-06 是周五
  const fri = nextFireAt(a, at('2026-03-06T08:00:00'));   // 周五 08:00（今天的 7 点已过）
  assert.equal(fri.getDay(), 1, '周五已过点 → 下一个工作日是**周一**，不是周六');
  assert.equal(fri.getTime(), at('2026-03-09T07:00:00').getTime());
  // 周六 → 周一
  const sat = nextFireAt(a, at('2026-03-07T09:00:00'));
  assert.equal(sat.getTime(), at('2026-03-09T07:00:00').getTime());
  // 周日 → 周一
  const sun = nextFireAt(a, at('2026-03-08T09:00:00'));
  assert.equal(sun.getTime(), at('2026-03-09T07:00:00').getTime());
  // 周一早上 6:30 → 今天 7:00
  assert.equal(nextFireAt(a, NOW).getTime(), at('2026-03-02T07:00:00').getTime());
});

test('nextFireAt：自定义星期（含只选周日这种跨 6 天的情况）', () => {
  const sunday = clock({ atHour: 9, atMinute: 15, repeat: 'custom', weekdays: [0] });
  // 周一早上 → 下一个周日（+6 天）
  assert.equal(nextFireAt(sunday, NOW).getTime(), at('2026-03-08T09:15:00').getTime());
  const wed = clock({ atHour: 9, atMinute: 15, repeat: 'custom', weekdays: [3] });
  assert.equal(nextFireAt(wed, NOW).getTime(), at('2026-03-04T09:15:00').getTime());
  // 多天：取**最近**的那个（周一、周三；NOW 是周一 06:30 → 周一 09:15 还没到 → 就是今天）
  const both = clock({ atHour: 9, atMinute: 15, repeat: 'custom', weekdays: [1, 3] });
  assert.equal(nextFireAt(both, NOW).getTime(), at('2026-03-02T09:15:00').getTime());
  // 周一 09:15 过掉之后 → 轮到周三
  assert.equal(nextFireAt(both, at('2026-03-02T10:00:00')).getTime(), at('2026-03-04T09:15:00').getTime());
  // 今天就是周三但已过点 → 下周三（不是今天）
  assert.equal(
    nextFireAt(wed, at('2026-03-04T10:00:00')).getTime(),
    at('2026-03-11T09:15:00').getTime(),
  );
  // ⚠️ 一天都没选 → null（宁可这条不排，也不能在用户没选的日子把他吵醒）
  assert.equal(nextFireAt(clock({ repeat: 'custom', weekdays: [] }), NOW), null);
});

test('nextFireAt：once 与 daily 一样算"最近一次"，区别在响完怎么处理', () => {
  const once = clock({ atHour: 7, atMinute: 0, repeat: 'once' });
  assert.equal(nextFireAt(once, NOW).getTime(), at('2026-03-02T07:00:00').getTime());
  assert.equal(nextFireAt(once, at('2026-03-02T08:00:00')).getTime(), at('2026-03-03T07:00:00').getTime(),
    '已过点就顺延（用户按"只响一次"时的心里预期是"下一次那个点"）');
});

test('nextFireAt：跨月/跨年不许算错', () => {
  const a = clock({ atHour: 7, atMinute: 0, repeat: 'daily' });
  assert.equal(nextFireAt(a, at('2026-03-31T08:00:00')).getTime(), at('2026-04-01T07:00:00').getTime());
  assert.equal(nextFireAt(a, at('2026-12-31T08:00:00')).getTime(), at('2027-01-01T07:00:00').getTime());
  // 2028 是闰年，2/28 → 2/29
  assert.equal(nextFireAt(a, at('2028-02-28T08:00:00')).getTime(), at('2028-02-29T07:00:00').getTime());
});

test('nextFireAt：enabled=false 也要能算出"下次几点"（关掉 ≠ 删掉）', () => {
  const a = clock({ atHour: 7, atMinute: 0, repeat: 'daily', enabled: false });
  assert.ok(nextFireAt(a, NOW), '关掉的闹钟仍然要算出下次时刻（列表要显示"下次 7:00"）');
  assert.equal(nextFireAt(a, NOW).getTime(), at('2026-03-02T07:00:00').getTime());
  // 但**排程**要把它滤掉
  assert.deepEqual(planAlarmSchedule([a], { now: NOW }), [], '关掉的绝不能排给系统');
});

test('nextFireAt：计时器 = startedAt + duration；没开始过返回 null', () => {
  const t = newAlarm({ kind: 'timer', durationMs: 25 * 60_000, startedAt: '2026-03-02T06:00:00' }, NOW);
  assert.equal(nextFireAt(t, NOW).getTime(), at('2026-03-02T06:25:00').getTime());
  assert.equal(timerRemainingMs(t, NOW), 0, '已经过完了 → 剩 0（不是负数）');
  const t2 = newAlarm({ kind: 'timer', durationMs: 25 * 60_000, startedAt: '2026-03-02T06:20:00' }, NOW);
  assert.equal(timerRemainingMs(t2, NOW), 15 * 60_000);
  assert.equal(timerEndsAt(t2, NOW).getTime(), at('2026-03-02T06:45:00').getTime());
  const idle = newAlarm({ kind: 'timer', durationMs: 60_000, startedAt: null }, NOW);
  assert.equal(nextFireAt(idle, NOW), null, '没开始过 → 没有"下次"');
  assert.equal(timerRemainingMs(idle, NOW), null);
});

test('markFired：一次性响完关掉但保留记录；每天的照旧；计时器清 startedAt', () => {
  const once = clock({ repeat: 'once' });
  const f1 = markFired(once, at('2026-03-02T07:00:00'));
  assert.equal(f1.enabled, false, '只响一次 → 响完自动关掉');
  assert.equal(f1.id, once.id, '**不许删记录**（用户要能在列表里看到它并重新打开）');

  const daily = clock({ repeat: 'daily' });
  const f2 = markFired(daily, at('2026-03-02T07:00:00'));
  assert.equal(f2.enabled, true, '每天重复的响完当然还是开着的');

  const t = newAlarm({ kind: 'timer', durationMs: 1000, startedAt: '2026-03-02T06:00:00' }, NOW);
  const f3 = markFired(t, NOW);
  assert.equal(f3.enabled, false);
  assert.equal(f3.startedAt, null, '计时器响完要清掉 startedAt，否则它会被算成"已结束"一直挂着');
});

// ---------------------------------------------------------------------------
// ③ planAlarmSchedule：交给原生壳的契约
// ---------------------------------------------------------------------------

test('planAlarmSchedule：过滤 + 排序 + 上限，字段形状是壳那边的契约', () => {
  const list = [
    clock({ atHour: 9, atMinute: 0, repeat: 'daily', label: '晚的' }),
    clock({ atHour: 7, atMinute: 30, repeat: 'daily', label: '早的' }),
    // ⚠️ "已过去" 这条**必须是一次性的**（`once` 而且已经过了那一分钟的那种）。
    //    写成"每天 6:00 + NOW=6:30"是不对的：每天的 6:00 已经过了 → 顺延到**明天** 6:00，
    //    它其实**该被排**（比"早的"还早）—— 第一版测试就是把这个当成了"已过去"，
    //    报出来的是"它怎么被排了"，而真相是测试的预期错了。
    //    "真·已过去"只有一种：一次性闹钟的时刻已经过了（今天 6:00 且只响一次 → 顺延到明天，
    //    仍然在排程窗口里）。所以这里干脆用**计时器**（根本不走这条路）+
    //    下面那条 `fireAt <= now` 的断言来覆盖"过滤已过去"这条规则。
    clock({ atHour: 8, atMinute: 0, repeat: 'daily', label: '关掉的', enabled: false }),
    newAlarm({ kind: 'timer', durationMs: 60_000, startedAt: '2026-03-02T06:29:00' }, NOW),
    // 每天 6:00 也**应该**在计划里（顺延到明天），这里显式钉住这个容易误判的点
    clock({ atHour: 6, atMinute: 0, repeat: 'daily', label: '明天的六点' }),
  ];
  const plan = planAlarmSchedule(list, { now: NOW });
  assert.deepEqual(plan.map((p) => p.label), ['早的', '晚的', '明天的六点'],
    '要滤掉"关掉的"；计时器不走这条路；已过点的**顺延到明天**仍然要排');
  // ⚠️ "过滤已经过去的时刻"这条规则单独钉：喂一个 fireAt 就是过去的条目不行，
  //    所以直接断言"计划里每一条都在未来"
  for (const p of plan) {
    assert.ok(new Date(p.fireAt).getTime() > NOW.getTime(), `排出来的必须都是未来的：${p.fireAt}`);
  }
  assert.ok(plan[0].fireAt < plan[1].fireAt, '按 fireAt 升序');
  for (const p of plan) {
    // ⚠️ `soundId` 是 2026-10-02 多首自定义铃声时加的：`sound` 仍是**给壳的裸文件名**
    //    （系统按它找文件），而 `soundId` 是**给界面看的 id**（同一首歌在多台设备上
    //    文件名不同，只有 id 是稳定的）。两个都要有，缺了任一个都有静默失败：
    //    缺 sound → 壳不响那首歌；缺 soundId → 界面显示不出"用户选的是哪一首"。
    assert.deepEqual(Object.keys(p).sort(),
      ['fireAt', 'id', 'kind', 'label', 'repeat', 'sound', 'soundId', 'title', 'weekdays'].sort(),
      '契约字段不许悄悄多/少一个（壳按这些字段读）');
    assert.match(p.fireAt, /^\d{4}-\d{2}-\d{2}T.*Z$/, 'fireAt 必须是 UTC ISO 字符串');
    assert.equal(p.sound, 'alarm-triple-rise', 'sound 是**不带扩展名**的文件名');
    assert.equal(p.soundId, 'triple', 'soundId 是铃声目录里的 id（界面看这个）');
  }
  // custom 才带 weekdays；其它一律空数组（壳据此决定用不用重复规则）
  const withCustom = planAlarmSchedule([clock({ repeat: 'custom', weekdays: [1, 3], atHour: 9 })], { now: NOW });
  assert.deepEqual(withCustom[0].weekdays, [1, 3]);
  // ⚠️ 非 custom 模式**故意清空** weekdays：用户勾过的那几天仍然留在记录里
  //    （字段 `weekdays`），但**计划里不带**——否则壳侧会看到两套重复语义
  //    （`repeat:'daily'` 又给了一串星期），那可就成了"到底听谁的"。
  const dailyAlarm = clock({ repeat: 'daily', weekdays: [1] });
  assert.deepEqual(dailyAlarm.weekdays, [1], '记录里保留用户勾过的星期（改回自定义时还在）');
  assert.deepEqual(planAlarmSchedule([dailyAlarm], { now: NOW })[0].weekdays, [],
    'daily 的计划里不带 weekdays');
});

test('planAlarmSchedule：数量上限 = MAX_SCHEDULED（和壳侧 maxAlarms 同源）', () => {
  const many = Array.from({ length: MAX_SCHEDULED + 5 }, (_, i) =>
    clock({ atHour: 7, atMinute: i, repeat: 'daily', label: `第${i}条` }));
  const plan = planAlarmSchedule(many, { now: NOW });
  assert.equal(plan.length, MAX_SCHEDULED, '超出的等下次重排（系统有数量上限）');
  assert.equal(plan[0].label, '第0条', '留下的必须是**最早**的那几条');
});

test('planAlarmSchedule：乱七八糟的输入不许抛错（渲染路径上不能崩）', () => {
  assert.deepEqual(planAlarmSchedule(null, { now: NOW }), []);
  assert.deepEqual(planAlarmSchedule([null, 42, 'x', {}], { now: NOW }).length >= 1, true,
    '{} 会被归一化成"每天 07:00"，仍然是一条合法闹钟 —— 但不许抛错');
});

// ---------------------------------------------------------------------------
// ④ 文案
// ---------------------------------------------------------------------------

test('describeAlarm：定时器/计时器/关掉的三种说法都说得清', () => {
  assert.match(describeAlarm(clock({ repeat: 'daily', label: '起床' }), NOW), /「起床」每天 07:00 响/);
  assert.match(describeAlarm(clock({ repeat: 'weekdays' }), NOW), /工作日/);
  assert.match(describeAlarm(clock({ repeat: 'custom', weekdays: [0, 6] }), NOW), /周日、周六/);
  assert.match(describeAlarm(clock({ repeat: 'custom', weekdays: [] }), NOW), /还没选星期/);
  assert.match(describeAlarm(clock({ enabled: false }), NOW), /^（已关）/);
  assert.match(describeAlarm(clock({ sound: 'morning' }), NOW), /铃声：晨钟/);
  const t = newAlarm({ kind: 'timer', durationMs: 5 * 60_000, startedAt: '2026-03-02T06:28:00' }, NOW);
  assert.match(describeAlarm(t, NOW), /5 分钟倒计时/);
  assert.match(describeAlarm(t, NOW), /还剩 03:00/, '跑着的计时器要带上剩余时间');
});

test('describeNextFire：今天 / 明天 / 已结束', () => {
  assert.equal(describeNextFire(clock({ atHour: 7 }), NOW), '今天 07:00');
  assert.equal(describeNextFire(clock({ atHour: 6 }), NOW), '明天 06:00');
  const t = newAlarm({ kind: 'timer', durationMs: 1000, startedAt: null }, NOW);
  assert.equal(describeNextFire(t, NOW), '还没开始');
  const done = newAlarm({ kind: 'timer', durationMs: 1000, startedAt: '2026-03-02T06:00:00' }, NOW);
  assert.equal(describeNextFire(done, NOW), '已结束');
});

test('describeSchedule：空计划说人话；有条目时带 id 与铃声', () => {
  assert.match(describeSchedule([], NOW), /没有要排的闹钟/);
  const plan = planAlarmSchedule([clock({ atHour: 7, label: '起床' })], { now: NOW });
  const txt = describeSchedule(plan, NOW);
  assert.match(txt, /今天 07:00/);
  // ⚠️ 这里显示的是**用户选的那首的名字**（"轻快三连"），不是裸文件名
  //    （`alarm-triple-rise`）—— 诊断区是给用户看的，文件名只有开发者认得。
  assert.match(txt, /铃声=轻快三连/);
  assert.doesNotMatch(txt, /轻快三连（自定义）/,
    '内置铃声**不许**被标成"（自定义）"—— 那是自定义那一类的说法');
  assert.doesNotMatch(txt, /alarm-triple-rise/, '诊断区显示中文名，不显示裸文件名');
  assert.match(txt, new RegExp(plan[0].id), '诊断区必须能看到 id（出问题时唯一能对上的东西）');
});

test('describeSchedule：自定义铃声说清"是哪一首"；本机没有它时说清"会响默认音"', () => {
  // ⚠️ 这条是这次需求（多首共存）最要紧的一句文案：
  //    自定义音频**不跟着设置同步**（只存在导入它的那台设备上），
  //    所以"在另一台设备上看这条闹钟"必须能看出"那首歌不在这台设备上"。
  //    否则用户会以为闹钟坏了 —— 而 iOS 找不到文件时**不报错、只是没声音**。
  const now = NOW;
  const got = { id: 'custom:9f3a1c07', name: '竹取飛翔', file: 'timetable-custom-9f3a1c07.caf' };
  const a = clock({ atHour: 7, label: '起床', sound: got.id });
  const plan = planAlarmSchedule([a], { now, customFile: [got] });
  assert.equal(plan[0].sound, 'timetable-custom-9f3a1c07.caf', 'sound 是壳要的文件名');
  assert.equal(plan[0].soundId, got.id, 'soundId 是界面用的 id');
  const txt = describeSchedule(plan, now, { customFile: [got] });
  assert.match(txt, /铃声=自定义 · 竹取飛翔（自定义）/, `实际：${txt}`);

  // 同一份 settings、换一台设备（壳报的清单里没有它）→ 必须说"不在这台设备上"
  const missing = planAlarmSchedule([a], { now, customFile: [] });
  assert.equal(missing[0].sound, null, '本机没有这个文件 → sound 必须是 null（= 系统默认音）');
  const txt2 = describeSchedule(missing, now, { customFile: [] });
  assert.match(txt2, /不在这台设备上/, `实际：${txt2}`);
  // 内置铃声不许被说成"不在这台设备上"（它永远在包里）
  const builtin = planAlarmSchedule([clock({ atHour: 7, sound: 'morning' })], { now, customFile: [] });
  assert.match(describeSchedule(builtin, now, { customFile: [] }), /铃声=晨钟/);
});

// ---------------------------------------------------------------------------
// ④′ 自定义铃声：id 规则 / 清单归一化 / 取值 / 可用性 / 取名（2026-10-02 多首）
// ---------------------------------------------------------------------------

test('自定义铃声 id：前缀、key 校验、老 id 的含义', () => {
  assert.equal(CUSTOM_SOUND_PREFIX, 'custom:');
  assert.equal(LEGACY_CUSTOM_SOUND_ID, 'custom');
  assert.equal(customSoundId('9f3a1c07'), 'custom:9f3a1c07');
  assert.equal(customSoundId('t0-1696'), 'custom:t0-1696', '老文件名去掉前缀后的形状也是合法 key');
  // 脏输入给 null（**不许**拼出 `'custom:'` 这种半成品：那会让界面列出"一首没有文件的音"）
  assert.equal(customSoundId(''), null);
  assert.equal(customSoundId('   '), null);
  assert.equal(customSoundId(null), null);
  assert.equal(customSoundId('a:b'), null, '冒号不许出现在 key 里（它是 id 的分隔符）');
  assert.equal(customSoundId('a b'), null, '空格不行');
  assert.equal(customSoundId('x'.repeat(65)), null, '超长不行');

  assert.equal(isCustomSoundId('custom:9f3a1c07'), true);
  assert.equal(isCustomSoundId('custom:'), false, '光有前缀不算（那正是上面要挡的半成品）');
  assert.equal(isCustomSoundId('custom'), false, '老的裸 id **不算**"某一首"（它指"第一首"）');
  assert.equal(isCustomSoundId('triple'), false);
  assert.equal(isCustomSoundId(null), false);

  assert.equal(customSoundKey('custom:9f3a1c07'), '9f3a1c07');
  assert.equal(customSoundKey('custom'), '', '老的裸 id 没有 key');
  assert.equal(customSoundKey('morning'), '');
});

test('normalizeCustomSounds：两种形状都吃，坏条目丢掉不抛错，同 id 去重', () => {
  const arr = normalizeCustomSounds([
    { id: '9f3a1c07', name: '竹取飛翔', file: 'timetable-custom-9f3a1c07.caf' },
    { file: 'timetable-custom-aabbccdd.caf' }, // 老壳：只给文件名
    { id: 'x', file: '' }, // 认不出 → 丢
    null, 42, 'nonsense', // 脏 → 丢
    { id: '9f3a1c07', name: '重复的', file: 'timetable-custom-9f3a1c07.caf' }, // 同 id → 只留第一条
  ]);
  assert.deepEqual(arr.map((x) => x.id), ['custom:9f3a1c07', 'custom:aabbccdd']);
  assert.equal(arr[0].name, '竹取飛翔');
  assert.equal(arr[1].name, '', '壳没报名字时留空串（界面会退回文件名）');
  // 单个文件名字符串（老壳只报一个 alarmFile）
  assert.deepEqual(normalizeCustomSounds('timetable-custom-9f3a1c07.caf'),
    [{ id: 'custom:9f3a1c07', name: '', file: 'timetable-custom-9f3a1c07.caf' }]);
  // 老名字（多首之前，文件名里编了通知档位）必须认得 —— 认不出 = 用户那首"看不见了"
  assert.deepEqual(normalizeCustomSounds('timetable-custom-t0-16960852.caf').map((x) => x.id),
    ['custom:t0-16960852']);
  assert.deepEqual(normalizeCustomSounds(null), []);
  assert.deepEqual(normalizeCustomSounds(undefined), []);
  assert.deepEqual(normalizeCustomSounds('随便什么.mp3'), [], '不是我们的文件名 → 空数组，不许抛错');
  // 名字截到 40 字以内（壳报来的东西要进界面，长度得有个上限）
  const longName = normalizeCustomSounds([
    { id: '9f3a1c07', name: 'x'.repeat(200), file: 'timetable-custom-9f3a1c07.caf' },
  ]);
  assert.equal(longName.length, 1);
  assert.equal(longName[0].name.length, 40, '壳给的名字要截到 40 字以内');
  // id 不合法（文件名里的 key 65 位，超过 64 的上限）→ 整条丢掉，不许留下"半条"记录
  assert.deepEqual(normalizeCustomSounds([
    { file: `timetable-custom-${'a'.repeat(65)}.caf` },
  ]), [], '超长的 key 认不出来 → 丢掉（不抛错，也不留半条）');
  // ⚠️ 老名字里带 `-`（`t0-16960852`）必须放行，而**纯 `-` 开头**不行 ——
  //    前者是真实历史文件名，后者是伪造/畸形的。
  assert.deepEqual(normalizeCustomSounds([
    { file: 'timetable-custom--.caf' },
  ]), [], '以 - 开头的 key 认不出来（脏数据 → 丢掉，不抛错）');
});

test('自定义铃声的名字：用户自己起的名字能按 token 查回来，而且不许盖掉壳报的名字', () => {
  const raw = [
    { id: '9f3a1c07', file: 'timetable-custom-9f3a1c07.caf' },
    { id: 'aabbccdd', file: 'timetable-custom-aabbccdd.caf' },
  ];
  // ① 用户起的名字（键是**不带**前缀的 token —— 这正是 settings.customSoundNames 的形状）
  const named = normalizeCustomSounds(raw, { '9f3a1c07': '起床号' });
  assert.equal(named[0].name, '起床号');
  assert.equal(named[1].name, '', '没起过名的那首仍然是空串（界面退回显示编号）');
  // ② 键写成带前缀的也要认（手改过设置的人不该因此"改名没生效"）
  assert.equal(normalizeCustomSounds(raw, { 'custom:9f3a1c07': '起床号' })[0].name, '起床号');
  // ③ 壳报的名字**优先**（将来壳能从文件里读出标题时，那个比用户手打的可信）
  assert.equal(normalizeCustomSounds(
    [{ id: '9f3a1c07', name: '壳给的标题', file: 'timetable-custom-9f3a1c07.caf' }],
    { '9f3a1c07': '用户起的' },
  )[0].name, '壳给的标题');
  // ④ 单个文件名字符串那条路也要能带上名字（老壳形状）
  const viaString = normalizeCustomSounds('timetable-custom-9f3a1c07.caf', { '9f3a1c07': '起床号' });
  assert.equal(viaString[0].name, '起床号');
  // ⑤ 脏数据不许抛错：names 是数组/字符串/undefined、值是数字/对象/超长
  for (const bad of [[], 'x', 42, null, undefined, { '9f3a1c07': 42 }, { '9f3a1c07': {} }]) {
    assert.doesNotThrow(() => normalizeCustomSounds(raw, bad));
    assert.equal(normalizeCustomSounds(raw, bad)[0].name, '');
  }
  assert.equal(normalizeCustomSounds(raw, { '9f3a1c07': `  ${'名'.repeat(80)}  ` })[0].name.length, 40,
    '用户名字也钳到 40 字（它会进 DOM、也会进备份）');
  // ⑥ 名字会进界面看着的那一行
  assert.equal(soundLabelOf('custom:9f3a1c07', {
    customFile: raw, customNames: { '9f3a1c07': '起床号' },
  }), '自定义 · 起床号');
  // ⑦ **没起过名时不许把 label 变成空**（退回编号，界面才不会出现"自定义 · "这种断尾）
  assert.equal(soundLabelOf('custom:9f3a1c07', { customFile: raw, customNames: {} }),
    '自定义 · 9f3a1c07');
});

test('soundFileOf / soundAvailable / soundLabelOf：多首各自取值，认不出给 null 不是空串', () => {
  const custom = [
    { id: 'custom:9f3a1c07', name: '竹取飛翔', file: 'timetable-custom-9f3a1c07.caf' },
    { id: 'custom:aabbccdd', name: '', file: 'timetable-custom-aabbccdd.caf' },
  ];
  const opts = { customFile: custom };
  // 每一首取到**自己**那个文件（这里正是"一个格子"变成"一串"的核心）
  assert.equal(soundFileOf('custom:9f3a1c07', opts), 'timetable-custom-9f3a1c07.caf');
  assert.equal(soundFileOf('custom:aabbccdd', opts), 'timetable-custom-aabbccdd.caf');
  // 本机没有这一首 → null（= 用系统默认音），**不是空串**（空串在 iOS 上是"这条没声音"且不报错）
  assert.equal(soundFileOf('custom:deadbeef', opts), null);
  // 老 id = 第一首
  assert.equal(soundFileOf('custom', opts), 'timetable-custom-9f3a1c07.caf');
  assert.equal(soundFileOf('custom', {}), null, '一首都没有时老 id 也要给 null');
  // 映射形状也要吃（调用方可以按需拼，不必先归一化）
  assert.equal(soundFileOf('custom:aabbccdd', { customFile: { 'custom:aabbccdd': 'timetable-custom-aabbccdd.caf' } }),
    'timetable-custom-aabbccdd.caf');
  // ⚠️ 映射里是**别人**的文件名时不许张冠李戴（宁可给 null = 系统默认音，
  //    也不能让用户选了 A 首、响的却是 B 首 —— 那种错用户永远查不出来）
  assert.equal(soundFileOf('custom:9f3a1c07', { customFile: { 'custom:aabbccdd': 'timetable-custom-aabbccdd.caf' } }),
    null, '要的那一首不在清单里 → null，不许拿清单里别的文件顶上');
  // 单个文件名字符串也要吃（老壳）
  assert.equal(soundFileOf('custom', { customFile: 'timetable-custom-t0-16960852.caf' }),
    'timetable-custom-t0-16960852.caf');

  assert.equal(soundAvailable('morning'), true, '内置的永远可用');
  assert.equal(soundAvailable('custom:9f3a1c07', opts), true);
  assert.equal(soundAvailable('custom:deadbeef', opts), false);
  assert.equal(soundAvailable('custom', {}), false);

  assert.equal(soundLabelOf('morning'), '晨钟');
  assert.equal(soundLabelOf('custom:9f3a1c07', opts), '自定义 · 竹取飛翔');
  assert.equal(soundLabelOf('custom:aabbccdd', opts), '自定义 · aabbccdd',
    '壳没报名字就退回文件名（总比所有自定义都长一样强）');
  assert.equal(soundLabelOf('custom:deadbeef', opts), '自定义', '本机没有这一首时给个能看的名');
  assert.equal(soundLabelOf('没有这个'), '');
  // ⚠️ 老 id `'custom'` 这里**故意**只回"自定义"（不回第一首的名字）：
  //    调用方正是靠"有没有名字/有没有文件"来判断"那一首还在不在"。
  //    这里替它报出第一首的名字 = 替它假装文件还在 —— 界面就不敢说
  //    "会响默认音"了，用户到点听到系统默认音却毫无提示（本项目最忌讳的失败方式）。
  //    "老 id 显示成哪一首"由界面负责（`web/ui/views/alarms.js` 的 `soundTextOf`）。
  assert.equal(soundLabelOf('custom', opts), '自定义',
    '老 id 不许在这里"顺便"报第一首的名字（会毁掉"文件在不在"的判断）');
});

test('formatCountdown / formatDuration / alarmTitle：边界', () => {
  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(59_400), '00:59');
  assert.equal(formatCountdown(60_000), '01:00');
  assert.equal(formatCountdown(3600_000), '1:00:00');
  assert.equal(formatCountdown(-5000), '00:00', '负数要夹到 0（不许出现 -1:-1）');
  assert.equal(formatDuration(45_000), '45 秒');
  assert.equal(formatDuration(90 * 60_000), '1 小时 30 分钟');
  assert.equal(formatDuration(120 * 60_000), '2 小时');
  assert.equal(formatDuration(25 * 60_000), '25 分钟');
  assert.equal(alarmTitle({ label: '起床啦起床啦起床啦起床啦' }).length, 12, '锁屏标题要截短');
  assert.equal(alarmTitle({ kind: 'timer' }), '计时器');
  assert.equal(alarmTitle({}), '闹钟');
});

// ---------------------------------------------------------------------------
// ⑤ 常量一致性（这些数字是跨文件的约定，改一个地方必须两边都改）
// ---------------------------------------------------------------------------

test('常量：种类/重复/快选这些"约定"本身不许漂移', () => {
  assert.deepEqual(ALARM_KINDS, ['clock', 'timer']);
  assert.deepEqual(ALARM_REPEATS, ['once', 'daily', 'weekdays', 'custom']);
  for (const r of ALARM_REPEATS) assert.ok(REPEAT_LABEL[r], `重复方式 ${r} 缺中文名`);
  assert.deepEqual(TIMER_PRESETS, [1, 3, 5, 10, 30]);
  assert.equal(ALARM_LIMIT, 50);
  assert.equal(MAX_SCHEDULED, 8, '⚠️ 这个数字必须和 ios/Timetable/AlarmKitScheduler.swift 的 maxAlarms 一致');
});

// ---------------------------------------------------------------------------
// ⑥ 增删改：只动目标那一条（深度断言）
// ---------------------------------------------------------------------------

/** 造一个装着 3 条闹钟的库 */
function dbWithThree() {
  const db = defaultDb();
  const r1 = upsertAlarm(db, { kind: 'clock', atHour: 6, atMinute: 30, repeat: 'daily', label: 'A' }, NOW);
  db.alarms = r1.alarms;
  const r2 = upsertAlarm(db, { kind: 'clock', atHour: 7, atMinute: 0, repeat: 'weekdays', label: 'B' }, NOW);
  db.alarms = r2.alarms;
  const r3 = upsertAlarm(db, { kind: 'timer', durationMs: 5 * 60_000, label: 'C' }, NOW);
  db.alarms = r3.alarms;
  return { db, ids: db.alarms.map((a) => a.id) };
}

test('upsertAlarm：新建落在末尾、默认字段齐全、id 稳定', () => {
  const { db, ids } = dbWithThree();
  assert.equal(db.alarms.length, 3);
  assert.equal(new Set(ids).size, 3, 'id 不许重复');
  const a = db.alarms[0];
  assert.equal(a.kind, 'clock');
  assert.equal(a.enabled, true);
  assert.equal(a.sound, DEFAULT_SOUND_ID);
  assert.ok(a.createdAt && a.updatedAt);
});

test('upsertAlarm：改一条时**只有它**变，其余三条逐条引用不变', () => {
  const { db, ids } = dbWithThree();
  const [a0, a1, a2] = db.alarms;
  const before = db.alarms.slice();

  const r = upsertAlarm(db, { id: ids[1], kind: 'clock', atHour: 8, atMinute: 15, repeat: 'daily', label: 'B改' }, at('2026-03-02T09:00:00'));
  assert.equal(r.alarms.length, 3, '改不该增减条数');
  assert.equal(r.alarm.atHour, 8);
  assert.equal(r.alarm.atMinute, 15);
  assert.equal(r.alarm.label, 'B改');
  // ⚠️ 深度断言：另外两条必须是**同一个对象引用**（不许顺手重建一遍）
  assert.equal(r.alarms[0], before[0], 'A 那一条必须是同一个引用（没动它）');
  assert.equal(r.alarms[2], before[2], 'C 那一条必须是同一个引用（没动它）');
  assert.notEqual(r.alarms[1], before[1], '被改的那条要是新对象');
  assert.equal(r.alarms[1].createdAt, before[1].createdAt, '创建时间不许被改');
  assert.equal(r.alarms[1].id, ids[1]);
  // 原数组没被就地改（不可变：调用方手上的那份仍然完整）
  assert.equal(db.alarms.length, 3);
  assert.equal(db.alarms[1].atHour, 7, '传入的 db.alarms 不该被就地改');
  // 归一化过的字段也要保留
  assert.equal(a0.label, 'A');
  assert.equal(a2.kind, 'timer');
  assert.equal(a1.repeat, 'weekdays', '没动 repeat 时不许被冲掉');
});

test('upsertAlarm：传入未知 id 等同于新建（不抛"找不到"）', () => {
  const { db } = dbWithThree();
  const r = upsertAlarm(db, { id: 'alarm_不存在', kind: 'clock', atHour: 9, atMinute: 0 }, NOW);
  assert.equal(r.alarms.length, 4, '未知 id 当新建（客户端离线建的 id 也要能补上来）');
  assert.equal(r.alarm.id, 'alarm_不存在');
});

test('upsertAlarm：非法输入抛错，且带上 status + code（api.js 依赖这个约定）', () => {
  const db = defaultDb();
  let err = null;
  try { upsertAlarm(db, { kind: 'clock', atHour: 99 }, NOW); } catch (e) { err = e; }
  assert.ok(err, '必须在保存时就拒绝，而不是排到系统里才失败');
  assert.equal(err.status, 400);
  assert.equal(err.code, 'ALARM_HOUR');
  assert.deepEqual(db.alarms, [], '失败时库必须一个字节都没变');
});

test('upsertAlarm：上限用 ALARM_LIMIT，超了抛 ALARM_LIMIT', () => {
  const db = defaultDb();
  db.alarms = Array.from({ length: ALARM_LIMIT }, (_, i) => ({
    id: `alarm_${i}`, kind: 'clock', atHour: 7, atMinute: 0, repeat: 'daily',
  }));
  let err = null;
  try { upsertAlarm(db, { kind: 'clock', atHour: 8, atMinute: 0 }, NOW); } catch (e) { err = e; }
  assert.equal(err && err.code, 'ALARM_LIMIT');
  // 改已有的那条**不受上限影响**（否则用户满了以后连改都改不了）
  const r = upsertAlarm(db, { id: 'alarm_0', kind: 'clock', atHour: 9, atMinute: 30, repeat: 'daily' }, NOW);
  assert.equal(r.alarms.length, ALARM_LIMIT);
  assert.equal(r.alarm.atHour, 9);
});

test('removeAlarm：删一条时只有它消失，其余引用不变；删不存在的 id 不抛错', () => {
  const { db, ids } = dbWithThree();
  const [a0, , a2] = db.alarms;
  const left = removeAlarm(db, ids[1], NOW);
  assert.equal(left.length, 2);
  assert.deepEqual(left.map((a) => a.id), [ids[0], ids[2]]);
  assert.equal(left[0], a0, '剩下的必须是同一引用（没重建）');
  assert.equal(left[1], a2);
  // 删不存在的不抛错（"我这边删了、那边也删了"是正常情况）
  assert.doesNotThrow(() => removeAlarm(db, 'alarm_没有这个', NOW));
  assert.equal(removeAlarm(db, 'alarm_没有这个', NOW).length, 3);
  assert.equal(removeAlarm(db, '', NOW).length, 3);
  assert.equal(removeAlarm(db, null, NOW).length, 3);
});

test('toggleAlarm：只改开关；关掉跑着的计时器要顺手清 startedAt', () => {
  const { db, ids } = dbWithThree();
  const before = db.alarms.slice();
  const off = toggleAlarm(db, ids[0], false, at('2026-03-02T09:00:00'));
  assert.equal(off.alarm.enabled, false);
  assert.equal(off.alarms[1], before[1], '别的条不许动');
  assert.equal(off.alarms[2], before[2]);
  const on = toggleAlarm(db, ids[0], true, NOW);
  assert.equal(on.alarm.enabled, true);
  assert.equal(on.alarm.atHour, 6, '开关不许碰时刻');
  assert.equal(on.alarm.createdAt, before[0].createdAt);

  // 计时器：关掉 → startedAt 清空（留着会让"重新打开"立刻显示已结束）
  const running = { ...before[2], startedAt: '2026-03-02T06:00:00' };
  const db2 = { ...db, alarms: [running] };
  const t = toggleAlarm(db2, running.id, false, NOW);
  assert.equal(t.alarm.startedAt, null);
  const t2 = toggleAlarm(db2, running.id, true, NOW);
  assert.equal(t2.alarm.startedAt, null, '重新打开也不会凭空空出一个开始时刻（要用户按"开始"）');

  let err = null;
  try { toggleAlarm(db, 'alarm_没有', true, NOW); } catch (e) { err = e; }
  assert.equal(err && err.status, 404);
  assert.equal(err && err.code, 'ALARM_NOT_FOUND');
});

test('upsertAlarm 的返回值可以直接写回 db.alarms（服务端就是这么用的）', () => {
  const db = defaultDb();
  db.alarms = upsertAlarm(db, { kind: 'clock', atHour: 7, atMinute: 0, repeat: 'daily' }, NOW).alarms;
  db.alarms = upsertAlarm(db, { id: db.alarms[0].id, kind: 'clock', atHour: 7, atMinute: 30, repeat: 'daily' }, NOW).alarms;
  assert.equal(db.alarms.length, 1);
  assert.equal(db.alarms[0].atMinute, 30);
});

test('闹钟不进同步载荷（这是有意的决定，不是漏做）', async () => {
  const { syncPayloadOf } = await import('../core/sync.js');
  const db = defaultDb();
  db.alarms = upsertAlarm(db, { kind: 'clock', atHour: 7, atMinute: 0, repeat: 'daily' }, NOW).alarms;
  const payload = syncPayloadOf(db, null, NOW);
  assert.equal(payload.alarms, undefined,
    '闹钟不许出现在同步载荷里：它是"这台设备几点叫我"，跨设备同步是错的');
});

test('备份/恢复要带上闹钟（漏了就是"恢复完闹钟全没了"）', async () => {
  const { restoreBackup } = await import('../core/state-ops.js');
  const db = defaultDb();
  const backup = {
    events: [],
    courses: [],
    alarms: [{ id: 'alarm_x', kind: 'clock', atHour: 6, atMinute: 0, repeat: 'daily' }],
  };
  const out = restoreBackup(db, backup);
  assert.equal(out.alarms, 1);
  assert.equal(db.alarms.length, 1);
  assert.equal(db.alarms[0].id, 'alarm_x');
  // 备份里没有 alarms 时 → 清空（备份是权威快照）
  restoreBackup(db, { events: [], courses: [] });
  assert.deepEqual(db.alarms, [], '备份里没有的就是没有（快照语义）');
});

test('alarmId：稳定 + 只留安全字符', () => {
  assert.equal(alarmId('abc-123'), 'alarm_abc-123');
  assert.match(alarmId('a b/c'), /^alarm_abc$/);
  assert.ok(alarmId().length > 6);
  assert.notEqual(alarmId(), alarmId());
});

// ---------------------------------------------------------------------------
// ⑨ 「全部闹钟」：状态 / 排序 / 计数（2026-10-02 用户 m03912）
//    「我需要一个显示已创建闹钟的地方，同时我要可删改」
// ---------------------------------------------------------------------------
//
// ⚠️ 这一套守的是一个**已经发生过**的 bug：
//    页面标题写着"共 12 条，开着 12 条"，屏幕上只有 1 行 —— 因为"开着"是拿
//    `enabled` 数的，而跑完的计时器 `enabled` 仍然是 true、界面上**又根本不画**
//    （计时器那段只画"正在跑的那一条"）。于是那些记录既数得进去、又看不见 = 删不掉。
//    所以这里钉死两件事：**"会响的"必须按状态算**，**清理只许碰计时器**。
//    （"每一条都画得出来"那半句在 `tools/alarms-view.test.mjs` 里。）

/** 一个计时器：默认"10 分钟、从现在开始跑" */
const timer = (patch = {}) => {
  const p = (patch && typeof patch === 'object') ? patch : {};
  const out = { kind: 'timer', durationMs: 600_000, startedAt: NOW.toISOString(), ...p };
  if (p.kind === undefined) out.kind = 'timer';
  if (p.durationMs === undefined) out.durationMs = 600_000;
  if (p.startedAt === undefined) out.startedAt = NOW.toISOString();
  return newAlarm(out, NOW);
};

test('alarmPhase：五种状态各自认得出，**关掉的计时器 ≠ 跑完的计时器**', () => {
  const running = timer();
  const paused = { ...running, paused: true };
  // 1 小时前开始的一个 10 分钟倒计时 → 早跑完了（`timerRemainingMs` 给 0，不是负数）
  const ended = timer({ startedAt: at('2026-03-02T05:00:00').toISOString() });
  const offTimer = { ...running, enabled: false };
  const neverStarted = { ...running, startedAt: null };
  const waiting = clock({ atHour: 7, atMinute: 0, repeat: 'daily' });
  const offClock = clock({ atHour: 7, atMinute: 0, repeat: 'daily', enabled: false });

  assert.equal(alarmPhase(running, NOW), 'running');
  assert.equal(alarmPhase(paused, NOW), 'paused');
  assert.equal(alarmPhase(ended, NOW), 'ended');
  assert.equal(alarmPhase(offTimer, NOW), 'off');
  assert.equal(alarmPhase(neverStarted, NOW), 'off', '从没开始过的计时器 = 什么都不剩的死记录');
  assert.equal(alarmPhase(waiting, NOW), 'waiting');
  assert.equal(alarmPhase(offClock, NOW), 'off');

  // ⚠️ 这条是这一节的核心：混成一种的话，"清掉已结束的计时器"会把用户**主动关掉**的也扫走
  assert.notEqual(alarmPhase(offTimer, NOW), alarmPhase(ended, NOW));

  // 常量本身不许漂移：视图直接拿 `PHASE_LABEL[phase]` 当文案，缺一个就是空白徽标
  assert.deepEqual(ALARM_PHASES, ['running', 'paused', 'waiting', 'ended', 'off']);
  assert.deepEqual(Object.keys(PHASE_LABEL).sort(), [...ALARM_PHASES].sort());
  for (const p of ALARM_PHASES) assert.ok(PHASE_LABEL[p] && PHASE_LABEL[p].length >= 2, `PHASE_LABEL 缺 ${p}`);

  // 脏输入：这一路上（列表渲染）**不许抛**
  assert.doesNotThrow(() => alarmPhase(null, NOW));
  assert.doesNotThrow(() => alarmPhase({ kind: 'timer', durationMs: 'abc' }, NOW));
  assert.doesNotThrow(() => alarmPhase(undefined));
});

test('staleTimers：只碰"跑完/从没开始"的计时器，**定时器一条都不许进去**', () => {
  const ended = timer({ startedAt: at('2026-03-02T05:00:00').toISOString() });
  const neverStarted = { ...timer({ startedAt: null }) };
  const offTimer = { ...timer(), enabled: false };
  const running = timer();
  const paused = { ...timer(), paused: true };
  const waiting = clock({ atHour: 7, atMinute: 0, repeat: 'daily' });
  const offClock = clock({ atHour: 8, atMinute: 0, repeat: 'daily', enabled: false });
  const list = [ended, neverStarted, offTimer, running, paused, waiting, offClock];

  const stale = staleTimers(list, NOW);
  assert.deepEqual(stale.map((a) => a.id), [ended.id, neverStarted.id, offTimer.id],
    '名单 = 跑完的 + 从没开始的 + 关掉的计时器');

  // ⚠️⚠️ 边界：定时器是用户排的班（哪怕它被关着），替他删 = 删掉他的日程
  assert.ok(!stale.some((a) => a.kind === 'clock'),
    '定时器一条都不许进"清理"名单 —— 包括已经关掉的那些（那是用户的记忆，不是垃圾）');
  assert.ok(!stale.some((a) => a.id === running.id || a.id === paused.id),
    '正在跑/已暂停的计时器不许被清（暂停的那条还能"继续"）');

  // 传进来的数组不许被改（视图会把同一个数组同时喂给列表和计数）
  const copy = list.slice();
  staleTimers(list, NOW);
  assert.deepEqual(list, copy);

  assert.deepEqual(staleTimers([], NOW), []);
  assert.deepEqual(staleTimers(null, NOW), []);
  assert.doesNotThrow(() => staleTimers([{ kind: 'timer' }], NOW));
});

test('sortAlarmsForDisplay：跑的 → 暂停 → 会响的（近→远）→ 已结束 → 关掉的，而且**稳定**', () => {
  const running = timer();
  const paused = { ...timer(), paused: true };
  const soon = clock({ atHour: 7, atMinute: 0, repeat: 'daily' });     // 30 分钟后
  const later = clock({ atHour: 9, atMinute: 0, repeat: 'daily' });    // 2.5 小时后
  const ended = timer({ startedAt: at('2026-03-02T05:00:00').toISOString() });
  const offClock = clock({ atHour: 8, atMinute: 0, repeat: 'daily', enabled: false });

  const sorted = sortAlarmsForDisplay([offClock, ended, later, soon, paused, running], NOW);
  assert.deepEqual(sorted.map((a) => a.id), [running.id, paused.id, soon.id, later.id, ended.id, offClock.id],
    '「还有什么会响」要比「刚改过的那条死计时器」更靠上（按 updatedAt 倒序是最省事的错法）');

  // ⚠️ 稳定：三条一模一样的闹钟必须保持原顺序 —— 否则每次重画列表都在跳，
  //    用户点"删"会点到隔壁那条
  const a1 = clock({ atHour: 7, atMinute: 0, repeat: 'daily' });
  const a2 = clock({ atHour: 7, atMinute: 0, repeat: 'daily' });
  const a3 = clock({ atHour: 7, atMinute: 0, repeat: 'daily' });
  assert.deepEqual(sortAlarmsForDisplay([a1, a2, a3], NOW).map((a) => a.id), [a1.id, a2.id, a3.id]);

  // 不许原地改
  const input = [offClock, running];
  const before = input.slice();
  sortAlarmsForDisplay(input, NOW);
  assert.deepEqual(input, before, '排序不许原地改（视图会把同一个数组用在两处）');

  assert.deepEqual(sortAlarmsForDisplay(null, NOW), []);
  assert.doesNotThrow(() => sortAlarmsForDisplay([null, 42, 'x'], NOW));
});

test('summarizeAlarms / describeAlarmCount：**跑完的计时器不算"会响的"**（"共 12 条、开着 12 条"的正面修法）', () => {
  const running = timer();
  const ended1 = timer({ startedAt: at('2026-03-02T05:00:00').toISOString() });
  const ended2 = timer({ startedAt: at('2026-03-02T04:00:00').toISOString() });
  const waiting = clock({ atHour: 7, atMinute: 0, repeat: 'daily' });
  const offClock = clock({ atHour: 8, atMinute: 0, repeat: 'daily', enabled: false });
  const list = [running, ended1, ended2, waiting, offClock];

  const s = summarizeAlarms(list, NOW);
  assert.equal(s.total, 5);
  assert.equal(s.clocks, 2);
  assert.equal(s.clocksLive, 1);
  assert.equal(s.clocksOff, 1);
  assert.equal(s.timers, 3);
  assert.equal(s.timersRunning, 1);
  assert.equal(s.timersPaused, 0);
  assert.equal(s.timersEnded, 2);
  assert.equal(s.timersStale, 2);
  assert.equal(s.live, 2, '会响的 = 会响的定时器 + 正在跑的计时器；**跑完的计时器不算**');

  // ⚠️ 把旧写法的数字摆出来：按 `enabled` 数会报 4 条 —— 那就是用户截图里那个假数字
  assert.equal(list.filter((a) => a.enabled !== false).length, 4);
  assert.notEqual(s.live, 4, '这就是那个 bug：按 enabled 数 = 4 条"开着"，实际只有 2 条会响');

  const txt = describeAlarmCount(list, NOW);
  assert.match(txt, /共 5 条/);
  assert.match(txt, /会响的 2 条/);
  assert.match(txt, /计时器 3 条/);
  assert.match(txt, /跑着 1/);
  assert.match(txt, /已结束\/没用 2/);

  assert.equal(describeAlarmCount([], NOW), '还没有闹钟');
  assert.equal(describeAlarmCount(null, NOW), '还没有闹钟');
  // 只有定时器时不许拖出一条"（计时器 0 条…）"的废话
  assert.equal(describeAlarmCount([waiting], NOW), '共 1 条，会响的 1 条');
  assert.doesNotThrow(() => summarizeAlarms([{ kind: 'x' }], NOW));
});

