// 断言层：把 Kotlin Store 的行为逐项钉住。
//
// 为什么需要它：run.ps1 只把 Kotlin 的结果**打印**成 JSON，人看一眼"好像都对"
// 就过去了 —— 这不是验证。这里把每一条期望写死，跑的时候逐项比对，
// 任何一条不符就非零退出。
//
// 用法：node tools/android-parity.test.mjs <harness 输出的 json 文件>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

// 先跑 harness 拿 JSON（它会自己打印到 stdout）。
//
// ⚠️ 本机沙箱**禁止 node 用管道 spawn 任何子进程**：`execFileSync(..., {encoding:'utf8'})`
//    直接 `Error: spawnSync powershell EPERM`（errno -4048，status=null，stdout/stderr 全空）。
//    这不是"检查通过"，也不是代码坏了 —— 同一个 run.ps1 从 shell 里直接跑完全正常。
//    所以留一个**不用管道**的后备通道：外部（shell）先把 harness 输出重定向到文件，
//    再用 TIMETABLE_PARITY_JSON=<那个文件> 调本脚本；两条路走的是同一份 JSON、同一套断言。
//    ⚠️ 别删掉后备通道（沙箱里会没法验证），也别把后备通道当默认（正常机器上必须自己跑 harness）。
const fromFile = process.env.TIMETABLE_PARITY_JSON;
let raw;
if (fromFile) {
  raw = fs.readFileSync(fromFile, 'utf8');
  console.log(`（沙箱后备通道：读 ${fromFile}）`);
} else {
  try {
    raw = execFileSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(here, 'android-parity', 'run.ps1'),
    ], { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    console.error('parity harness 跑失败了：');
    console.error(String(err.stdout || '').slice(-4000));
    console.error(String(err.stderr || '').slice(-2000));
    process.exit(1);
  }
}

// stdout 前面有编译日志，取第一个 { 到最后一个 }
const start = raw.indexOf('{');
const end = raw.lastIndexOf('}');
if (start < 0 || end < 0) {
  console.error('parity harness 没有输出 JSON：');
  console.error(raw.slice(-3000));
  process.exit(1);
}
let got;
try {
  got = JSON.parse(raw.slice(start, end + 1));
} catch (err) {
  console.error('parity JSON 解析失败：' + err.message);
  console.error(raw.slice(start, start + 2000));
  process.exit(1);
}

// 期望值。每一项都对应 server/store.js 里一条"踩过坑才对"的行为。
const EXPECT = {
  // 锚点本身也是断言：harness 必须报出"下周一"和"摘要那天"，
  // 否则下面两条日期敏感的期望值没有依据（宁可红，也不要静默跳过）
  anchorMonday: got.anchorMonday,
  digestDay: got.digestDay,
  baseNextMonday: got.baseNextMonday,
  // 套娃层级
  createdRedLevel: 'red',
  greenParentIsRed: true,
  redIntoRedRejected: true,        // 红不能放进红
  emeraldCannotHoldAmber: true,    // 绿(1) 不能装黄(2) —— 等级是"严于"关系
  missingParentDegrades: true,      // 父不存在 → 当最外层建（不再报错）
  // 旧数据迁移：与 core/level.js 的区间一致
  legacyLevels: ['red', 'red', 'amber', 'amber', 'emerald', 'sky'],
  // 只挪位置不该改归属
  renameKeptParentInRed: true,
  // 戳破：只释放直接子级，孙辈不动
  popReleasedCount: 1,
  popAmberDone: true,
  popReleasedGreen2ToRed: true,
  popBlueStaysInGreen2: true,
  green2IsRootAfterUnparent: true,
  // 删除父级：子级存活并被释放
  childReallyNestedBeforeDelete: 1,
  deletedParentGone: true,
  childSurvivedAndReleased: true,
  // 截止时间优先级
  explicitDeadlineWins: true,
  deadlineFallsBackToStart: true,
  // 课程导入
  importAdded: 1,
  courseEventCount: 2,             // 一门课两段上课 = 两条事件（曾经互相覆盖）
  courseStarts: ['08:00', '13:30'],// 按作息表换算，不是硬编码 08:00
  courseStartDiffersFromEnd: true, // 曾经 start == end
  courseMeetingCount: 2,
  courseEventCountAfterReimport: 2,// 幂等
  // 提醒：重复规则必须逐次展开（第一版只拿 deadline 当一个点，
  // 导致周重复和课表只有第一次会响）
  weeklyOccurrenceCount: 1,
  weeklyOccurrenceIsMonday9: true,
  biweeklyCountIn20Days: 2,        // 第 1 周 + 第 3 周
  courseOccurrenceCount: 4,        // weeks=[1,2,3,4] → 4 次
  courseOccurrencesAllWednesday: true,
  dueNoneFiredAt0849: true,        // 还没到 fireAt，不该弹
  dueFiredExactlyAtFireAt: true,   // 到 fireAt 那一刻要弹（提前 10 分钟）
  dueNotRepeatedSameKey: true,     // 记账后不该重复弹
  dueHasFiredAtTime: true,         // 到点了要弹
  // 排程（AlarmManager 那条路的核心计算）
  nextAlarmIsInFuture: true,       // 绝不能返回过去的时刻，否则系统立刻触发
  nextAlarmMatchesEarliestFuture: true, // 必须是"最早的**未来**提醒"，不早不晚
  nextAlarmSkipsPast: true,        // 过了的点要跳过，不能拿旧时刻去注册
  nextAlarmNullWhenNoEvents: true, // 没事件就别占着精确闹钟名额
  takeDueEmptyBefore: true,        // 还没到点，醒来也不该弹
  takeDueHasItemsAtTime: true,     // 到点了要弹
  takeDueAllFired: true,           // 只弹"到点且没弹过"的
  takeDueNotRepeated: true,        // 记账后重复唤醒不重复弹
  autoRemindersDefaultsOn: true,
  // 账本必须落盘并被多个 Store 实例共享 —— 否则同一条提醒会被
  // "网页轮询"和"系统闹钟"各弹一次（安卓端有多个 Store 实例）
  ledgerFirstFires: true,
  ledgerSharedAcrossInstances: true,   // 另一个实例不该再弹一次
  ledgerFileWritten: true,             // fired.json 真的写了
  ledgerSurvivesRestart: true,         // 重启后还记得
  ledgerNotEmpty: true,
  // 数据变更回调（AlarmManager 靠它重排；挂错地方就会"改了日程还按旧时间响"）
  onChangedFiredOnUpsert: true,
  onChangedFiredOnPatch: true,
  onChangedFiredOnDelete: true,
  // 过期容器只读：能进去看，但不能往里加子泡泡（用户要求）。
  // 客户端守一道、服务端再守一道 —— 否则绕过界面调 API 就能塞进去。
  overdueDetected: true,
  overdueRejectsChild: true,          // 往里加 → 拒
  freshAcceptsChild: true,            // 没过期的照常可以加
  overdueRejectsPatchReparent: true,  // 拖拽改归属也拒
  parentBecameOverdue: true,          // 把父的截止时间改到过去 → 父变紫
  canStillPullOutFromOverdue: true,   // 但**拉出来**必须仍然允许
  // ---- 「每 N 周」可自定义（用户要求：每周/每两周不够用）----
  // 两端（JS / Kotlin）必须展开出**同样的日期**，所以这些值都钉死。
  every3WeeksCount: 5,                       // 第 0/3/6/9/12 周 → 5 次
  every3WeeksSpacingDays: [21],              // 间隔正好 21 天
  // ⚠️ 锚点是 harness 里的 MONDAY_MS = **相对今天的"下周一"**，不是写死的日期。
  //    我第一次断言写成了 09-21 起（我自己手测时用了硬编码那天），
  //    于是和 Kotlin 差了一周、看起来像"两端不一致"——其实是测试脚手架写错。
  //    ⚠️ 第二次还是同一个坑：这里原本硬编码成 2026-09-28 那一串，
  //       日期一走到下一个周一就整条变红。所以改成**从 harness 报的 anchorMonday 现算**：
  //       anchorMonday 是 WEEK_MON_MS（下周一），序列从它起、每 21 天一个。
  every3WeeksStamps: (() => {
    const mon = got.baseNextMonday;   // ⚠️ 是"下周一"，不是"本周一"
    if (typeof mon !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(mon)) return '<无 baseNextMonday>';
    const out = [];
    for (let i = 0; i < 5; i += 1) {
      const d = new Date(`${mon}T00:00:00`);
      d.setDate(d.getDate() + i * 21);
      const p = (n) => String(n).padStart(2, '0');
      out.push(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
    }
    return out;
  })(),
  intervalWeeksLegacyBiweekly: 2,            // 旧写法 biweekly 仍等价于 2（老数据不用迁移）
  intervalWeeksWeeklyDefault: 1,
  intervalWeeksPlain3: 3,
  intervalWeeksZero: 1,                      // 0 → 归一化成 1
  intervalWeeksNegative: 1,                  // 负数 → 1
  intervalWeeksJunk: 1,                      // 非数字 → 1
  intervalWeeksHuge: 52,                     // 超上限 → 截到 52
  labelEvery1: '每周',
  labelEvery2: '每两周',
  labelEvery3: '每 3 周',
  // 一周勾满 7 天：每天一次，不能重复膨胀（曾经从 7 涨到 45）
  allSevenDaysPerWeek: 7,
  allSevenDaysUnique: 7,
  // ---- 日/月/年级（用户要求"严格遵循级别单位"）----
  // 两端必须展开出同样的日期；月/年"不存在的那天"要**跳过**而不是硬凑。
  dailyEvery3Stamps: ['2026-03-02', '2026-03-05', '2026-03-08', '2026-03-11', '2026-03-14'],
  dailyEvery3Count: 5,
  monthly31Stamps: ['2026-01-31', '2026-03-31', '2026-05-31'],   // 2 月、4 月跳过
  monthly30Stamps: ['2026-01-30', '2026-03-30', '2026-04-30'],   // 2 月跳过
  yearlyFeb29Stamps: ['2028-02-29', '2032-02-29'],               // 只闰年
  levelDailyEvery3: 3,
  levelMonthlyCap: 60,
  levelYearlyCap: 20,
  levelDailyJunk: 1,
  labelDaily: '每天',
  labelEvery3Days: '每 3 天',
  labelMonthly: '每月',
  labelYearly: '每年',
  // ---- 按实例记账（用户要求"戳破一颗不结束整条"）----
  // 与 server/store.js 的 popEvent 一致：重复事件只记这一颗，done 保持 false。
  instancePopKeepsSeries: true,
  instancePopRecorded: 1,
  recycleCount: 1,
  recycleRemainingMs: 2 * 86_400_000,   // 提前 2 天完成（前端会显示成 -2天）
  restoreClearsPopped: 0,
  // ---- 课程摘要（与 core/course-digest.js 的 dueDigests 逐字一致）----
  digestCount: 1,
  digestSlot: 'noon',
  digestTitle: '今天下午 1 门课',
  // ⚠️ 同理：key 里带"本周一"的日期，写死就会随日期腐化 → 取 harness 报的 digestDay
  get digestKey() { return `digest:noon:${got.digestDay}`; },
  digestBodyHasCourse: true,
  digestBodyHasLocation: true,
  digestNoEveningForNoonCourse: true,   // 傍晚不报中午的课
  digestTooLateSkipped: true,           // 超过新鲜期（90 分钟）不补发
  digestDisabledSilent: true,           // 总开关关掉就不响
  // ---- 闹钟：摘要要按时醒，而且不能死循环 ----
  nextAlarmHitsDigestSlot: true,        // 11:00 时正确排到 12:30
  takenDigestCount: 1,
  nextAlarmNotSameSlot: true,           // 发完之后不再排同一个槽位（防死循环）
  // ---- 缺省值补全要覆盖**两条路径** ----
  // ⚠️ `/api/state` 走 state()，**不经过 settings()**。真机上我只补了 settings()，
  //    于是设置页（读 /api/state）还是看不到 courseDigest。两条都要测。
  stateHasCourseDigest: 4,              // 4 个槽位都要在（空 slots:{} 也算不全）
  settingsHasCourseDigest: 4,
  stateHasSectionTimes: true,
  // ---- 闹钟（安卓"闹钟简版"）：CRUD + nextAlarmAt 必须把 alarms 算进去 ----
  // ⚠️ 这一大块以前一条断言都没有 —— 而"加了闹钟从来不响"正是漏测的典型症状：
  //    nextAlarmAt 原来只算 events/digest，闹钟根本没进排程。
  alarmsDefaultEmpty: true,
  nextAlarmNullWhenNoAlarms: true,       // 没闹钟没事件 → null，别白占精确闹钟名额
  alarmSaveReturnsSingle: true,          // 返回**那一条**，不是数组（网页按单条解包）
  alarmShapeAtHour: 9,
  alarmShapeAtMinute: 0,
  alarmShapeRepeat: 'once',
  alarmShapeSound: 'triple',             // 没给 sound → DEFAULT_SOUND_ID
  alarmShapeEnabled: true,
  alarmShapeLabel: '起床',
  alarmShapeHasCreatedAt: true,
  nextAlarmSeesClockAlarm: true,         // ← 核心：闹钟进了 nextAlarmAt
  nextAlarmSkipsDisabled: true,
  alarmToggleBackOn: true,
  nextAlarmAfterToggleOn: true,
  alarmToggleMissingThrows: true,        // 开关找不到 → 404（与删除的不对称是刻意的）
  alarmEditKeepsId: true,
  alarmEditKeepsCreatedAt: true,         // 编辑不许重置创建时间
  alarmEditMovesUpdatedAt: true,
  alarmEditChangesFire: true,
  alarmEditCountStillOne: true,          // 编辑不能把一条变成两条
  // ---- 下次触发时刻的算法（与 core/alarms.js 的 nextFireAt 同语义）----
  alarmDailyNextIsToday: true,
  alarmDailyRollsToTomorrow: true,       // 过了今天那个点 → 顺延到明天
  alarmWeeklyPicksWednesday: true,       // custom 重复按"勾的那几天"挑
  alarmWeeklyKeepsWeekdays: 3,
  alarmWeekdaysSortedDeduped: '[1,5]',   // 去重 + 排序，越界的 9 丢掉
  alarmCustomNoWeekdayRejected: true,    // 一天都没勾 → 400 ALARM_WEEKDAYS
  alarmTimerNextIsStartPlusDuration: true,
  alarmTimerFiredMarksOffAndClearsStarted: true,  // 不清 startedAt 会立刻再响
  alarmOnceFiredMarksOff: true,
  alarmRepeatFiredStaysOn: true,         // "每天"响完必须继续响
  // ---- 到点判定窗口 ----
  dueAlarmsInsideWindow: true,
  dueAlarmsWithTolerance: true,          // 系统推迟 30 秒叫醒也算到点
  dueAlarmsTooEarly: true,
  dueAlarmsTooLate: true,
  dueAlarmsSkipsDisabled: true,
  // ---- 校验：越界必须报错，不许悄悄夹回去 ----
  alarmHour25Rejected: true,
  alarmMinute60Rejected: true,
  alarmBadSoundRejected: true,           // 认不出的铃声 → 400 ALARM_SOUND（不静默换一个）
  alarmBadSoundFallsBack: true,          // 但归一化这层兜底成 triple（手改坏 db.json 也要能算）
  alarmCustomSoundIdAccepted: true,      // custom:xxx 是合法 id（安卓上只是个标签）
  alarmLongLabelRejected: true,          // 名字 >24 字 → 400 ALARM_LABEL
  // ---- 上限 / 删除 / 落盘 ----
  alarmLimitReached50: 50,
  alarmLimitRejects51st: true,
  alarmDeleteReturnsOne: 1,
  alarmDeleteIdempotent: 0,              // 连点两下删除不该报错
  alarmDeleteEmptiesNext: true,
  alarmSurvivesReload: true,             // 壳与网页是两个进程，靠 db.json 交接
  alarmsPersistedInState: true,          // /api/state 自动带 alarms
  nextAlarmAfterReload: true,
  // 落盘
  // persistedEventCount 只断言存在且为正，具体数字随用例增加而变
};

let pass = 0;
const failures = [];
for (const [key, want] of Object.entries(EXPECT)) {
  const have = got[key];
  const ok = JSON.stringify(have) === JSON.stringify(want);
  if (ok) { pass += 1; console.log(`  ✔ ${key} = ${JSON.stringify(have)}`); } else {
    failures.push(`${key}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(have)}`);
    console.log(`  ✖ ${key}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(have)}`);
  }
}
// 单独处理
if (typeof got.persistedEventCount === 'number' && got.persistedEventCount > 0) {
  pass += 1;
  console.log(`  ✔ persistedEventCount = ${got.persistedEventCount}（>0）`);
} else {
  failures.push(`persistedEventCount 应为正数，实际 ${JSON.stringify(got.persistedEventCount)}`);
  console.log(`  ✖ persistedEventCount 应为正数，实际 ${JSON.stringify(got.persistedEventCount)}`);
}

// 没被 EXPECT 覆盖的字段也报一下，避免"加了新检查但忘了写期望"
const extra = Object.keys(got).filter((k) => !(k in EXPECT) && k !== 'persistedEventCount');
if (extra.length) console.log(`\n（未断言的字段，仅展示：${extra.join(', ')}）`);

console.log(`\n结果：${pass} 通过，${failures.length} 失败`);
if (failures.length) {
  console.log('失败项：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
void fs;

