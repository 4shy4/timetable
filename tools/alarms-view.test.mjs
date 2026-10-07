// 「闹钟」板块（web/ui/views/alarms.js + web/adapter/alarms.js）的验证 —— **node 层，不依赖浏览器**。
//
// ⚠️ 为什么只做"读源码 + 桩 DOM 渲染 + import core"这三类断言，而不开无头浏览器：
//    这个沙箱拦 Edge/Chrome，没有可用的无头浏览器（和 contacts-view / festival-art
//    遇到的是同一个限制）。所以这一层守住的是**接线**，而"点下去到底响不响"
//    只能由真机回答（见汇报里"没做到/不确定"那一节）。
//
// 这个板块**最贵的三种故障**，正好各有一条断言钉着：
//   ① 门控放错了 → 安卓/电脑上出现一个"设了不会响"的闹钟入口（用户明确不要这个）
//   ② 接线漏了 → 存了没交给壳 → 到点不响，而界面看起来一切正常（静默失败）
//   ③ 铃声静默降级 → 设了自定义音却放系统音，用户以为功能坏了
//
// 跑法：node tools/alarms-view.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_REL = 'web/ui/app.js';
const VIEW_REL = 'web/ui/views/alarms.js';
const ADAPTER_REL = 'web/adapter/alarms.js';
const VIEW = path.join(ROOT, VIEW_REL);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 去掉注释再断言：注释里提到别的写法是允许的（那是说明，不是代码） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ---------------------------------------------------------------------------
// ① 视图模块本身 + app.js 的注册与门控
// ---------------------------------------------------------------------------

test('视图模块存在，且导出了约定形状的视图对象', () => {
  assert.ok(fs.existsSync(VIEW), `${VIEW_REL} 不存在`);
  const src = read(VIEW_REL);
  assert.match(src, /export const alarmsView = \{/, '没有导出 alarmsView');
  assert.match(src, /id: 'alarms'/, "alarmsView.id 应为 'alarms'（要和路由/侧栏一致）");
  assert.match(src, /label: '[^']+'/, 'alarmsView 缺 label');
  assert.match(src, /title\(\)\s*\{/, 'alarmsView 缺 title()');
  assert.match(src, /subtitle\(state\)\s*\{/, 'alarmsView 缺 subtitle(state)');
  assert.match(src, /render\(state, ctx, host\)\s*\{/, 'alarmsView 缺 render(state, ctx, host)');
  assert.match(src, /nav\(\)\s*\{ return \[\]; \}/, 'nav() 要返回数组（没有周期导航就返回空数组）');
  assert.match(src, /import \{ el, mount \} from '\.\.\/dom\.js'/, '要从 ../dom.js 取 el/mount');
});

test('⭐ 门控：认原生壳（iOS 桥 / 安卓注入标记），而且"不确定就当不允许"', () => {
  const src = read(VIEW_REL);
  // 门控函数必须存在并导出（app.js 要靠它决定侧栏项）
  assert.match(src, /export function alarmsViewAllowed\(\)\s*\{/, '没有导出 alarmsViewAllowed()');
  // ⚠️ 2026-10-xx 起放宽：iOS 认 **shellKind()**（原生桥），安卓认 **platformKind()**
  //    （壳往 HTML 里注入的 window.__timetablePlatform —— 安卓没有 JS 桥，只有 HTTP）。
  //    仍然**不能**认 deviceKindOf()（那个把"iPad 上的浏览器"也算设备）。
  assert.match(src, /kind === 'ios' \|\| kind === 'android'/, "门控要同时认 'ios' 与 'android'");
  assert.ok(!/deviceKindOf/.test(stripComments(src)),
    '⚠️ 门控里不许用 deviceKindOf()：它会把"iPad 用浏览器打开"也当成设备，'
    + '于是浏览器里也会出现这个入口 —— 而那里根本没有真闹钟');
  // 认不出来（抛错/返回空）→ 必须 false
  assert.match(src, /catch \{[\s\S]{0,80}return false;/, 'platformKind() 抛错时要返回 false（偏向不显示）');
  // render 里也要再判一次（快捷键/深链能绕过侧栏）
  assert.match(src, /if \(!alarmsViewAllowed\(\)\) \{/, 'render 里也要再判一次门控');
});

test('app.js 注册了这一页：import + 视图池 + 图标 + **侧栏门控**', () => {
  const src = read('web/ui/app.js');
  assert.match(src, /import \{ alarmsView, alarmsTick, alarmsViewAllowed \} from '\.\/views\/alarms\.js'/,
    'app.js 没有 import alarmsView / alarmsTick / alarmsViewAllowed');
  // allViews：路由/快捷键能找到它（不放进来，state.view='alarms' 会被兜底成气泡区）
  assert.match(src, /const allViews = \[\.\.\.views, alarmsView,/, 'alarmsView 不在 allViews 里（点了会没反应）');
  // 侧栏：**必须走门控**，不许直接写进 views
  assert.match(src, /const views = \[[^\]]*\];\s*\n/, 'views 常量不见了');
  assert.ok(!/const views = \[[^\]]*alarmsView/.test(src),
    '⚠️ alarmsView 不许直接写进 views —— 那样安卓/电脑上也会出现入口（用户明确不要）');
  assert.match(src, /function shellViews\(\)[\s\S]{0,200}alarmsViewAllowed\(\)/,
    '侧栏必须由 shellViews() 按门控拼出来');
  assert.match(src, /mount\(\$\('#nav-desk'\), shellViews\(\)\.map\(makeItem\)\)/, '桌面侧栏没用 shellViews()');
  assert.match(src, /mount\(\$\('#nav-mobile'\), shellViews\(\)\.map\(makeItem\)\)/, '手机侧栏没用 shellViews()');
  // 图标：没有它，侧栏那一项会渲染成 '•'
  assert.match(src, /navIcons = \{[\s\S]*?alarms: '⏰'/, 'navIcons 里缺 alarms 的图标');
});

// ---------------------------------------------------------------------------
// ② 三块 UI + 诊断 + 失败文案，都在源码里接上了
// ---------------------------------------------------------------------------

test('三块 UI 的接线都在（计时器 / 定时器 / 铃声）', () => {
  const src = read(VIEW_REL);
  // 计时器：快选 + 自定义 + 开始/暂停/继续/取消 + 实时剩余
  assert.match(src, /TIMER_PRESETS/, '计时器要用 core 的 TIMER_PRESETS（别在视图里再抄一份分钟数）');
  assert.match(src, /bridge\.startTimer\(/, '计时器没接到 bridge.startTimer');
  assert.match(src, /bridge\.pauseTimer\(/, '缺暂停');
  assert.match(src, /bridge\.resumeTimer\(/, '缺继续');
  assert.match(src, /bridge\.cancelTimer\(/, '缺取消');
  assert.match(src, /timerRemainingMs\(/, '剩余时间必须由 core 现算（不许自己记秒表）');
  assert.match(src, /formatCountdown\(/, '剩余时间要格式化显示');
  assert.match(src, /dataset: \{ role: 'al-timer-display' \}/, '缺倒计时大字（实时显示要用它定位）');
  // 定时器：时刻 + 重复 + 标签 + 铃声 + 开关 + 删
  assert.match(src, /dataset: \{ role: 'al-hour' \}/, '缺小时输入');
  assert.match(src, /dataset: \{ role: 'al-minute' \}/, '缺分钟输入');
  assert.match(src, /dataset: \{ role: 'al-repeat' \}/, '缺重复选择');
  assert.match(src, /value: r, text: REPEAT_LABEL\[r\]/, '重复选项要用 core 的 REPEAT_LABEL（唯一一份中文名）');
  assert.match(src, /dataset: \{ role: 'al-weekdays' \}/, '缺自定义星期的勾选');
  assert.match(src, /dataset: \{ role: 'al-label' \}/, '缺标签输入');
  assert.match(src, /dataset: \{ role: 'al-sound' \}/, '缺铃声选择');
  assert.match(src, /dataset: \{ role: 'al-toggle'/, '缺开关');
  assert.match(src, /dataset: \{ role: 'al-delete'/, '缺删除');
  assert.match(src, /validateAlarm\(draft\)/, '保存前必须用 core 的 validateAlarm 在本地先拦一道');
  // 铃声：内置目录 + 试听 + 每条可选
  assert.match(src, /ALARM_SOUNDS/, '铃声列表要来自 core 的目录（唯一一份文件名单）');
  assert.match(src, /dataset: \{ role: 'al-preview', soundId: s\.id \}/, '缺试听按钮');
  assert.match(src, /dataset: \{ role: 'al-test-sound', soundId: s\.id \}/, '缺「10 秒后试响」');
});

test('⭐ 每个铃声的 `preview` 都必须有对应的试听音型（2026-09-30 那个"晨钟响成轻快三连"的 bug）', async () => {
  // 事故形状：`core/alarms.js` 给"晨钟"写的是 `preview: 'chime'`，
  // 而视图里那张合成音型表**没有 `chime` 这个键** → 运行时静默落到兜底 `triple`
  // → 用户选「晨钟」点试听、听到的是「轻快三连」。**两侧都各自"看起来没问题"**，
  // 所以只有"把两张表对着核一遍"才能发现 —— 这就是这条断言存在的唯一理由。
  const core = await import(pathToFileURL(path.join(ROOT, 'core/alarms.js')).href);
  const view = await import(`${pathToFileURL(VIEW).href}?preview=1`);

  assert.ok(Array.isArray(core.ALARM_SOUNDS) && core.ALARM_SOUNDS.length > 0,
    'core/alarms.js 没导出 ALARM_SOUNDS');
  assert.equal(typeof view.SOUND_PATTERNS, 'object',
    '视图必须导出 SOUND_PATTERNS（否则测试看不见那张表，"静默响错音"就没人能发现）');

  const missing = [];
  for (const s of core.ALARM_SOUNDS) {
    const key = s.preview;
    if (!Object.prototype.hasOwnProperty.call(view.SOUND_PATTERNS, key)) {
      missing.push(`${s.id}(${s.label}) → preview='${key}' 在 SOUND_PATTERNS 里没有`);
    }
  }
  assert.deepEqual(missing, [],
    '这些铃声的试听会静默响成别的音（左为 core，右为视图）：\n  ' + missing.join('\n  '));

  // 音型表里不许有"没人用"的键：那通常意味着某处改了值、另一处没跟上
  const used = new Set(core.ALARM_SOUNDS.map((s) => s.preview));
  const unused = Object.keys(view.SOUND_PATTERNS).filter((k) => !used.has(k));
  assert.deepEqual(unused, [], `SOUND_PATTERNS 里有没人用的音型：${unused.join(', ')}`);

  // 视图里不许再出现"局部 patterns 表 + 静默兜底"的老写法
  const src = read(VIEW_REL);
  assert.ok(!/const patterns = \{/.test(src),
    '试听音型表必须留在模块级并导出（`const patterns = {` 是旧写法，测试看不见它）');
  assert.ok(!/patterns\[s\.preview\] \|\|/.test(src),
    '不许再用 `|| 兜底` 静默放别的音型 —— 认不出来必须说出来（见 previewSound 里那段 toast）');
});

test('⭐ 试听必须"先播真文件、播不了才回落合成音"，壳的 MIME 表要认音频，且每个铃声都有对应 .caf（2026-10-01）', async () => {
  // 事故形状：用户真机上第一次听到真铃声，立刻发现"和下面的试听完全不一样"。
  //   根因两层：① 试听是**网页自己合成的近似音**（与真文件两套参数）；
  //            ② 当初不走真文件，是因为**壳的 MIME 表没有音频类型** ——
  //               静态文件一律回落 `application/octet-stream`，浏览器不肯当音频播。
  // 下面钉住修法，防止有人"顺手"改回纯合成。
  const src = read(VIEW_REL);
  assert.match(src, /function playRealSoundFile\(/, '必须有"播真文件"这条路径');
  assert.match(src, /new Audio_?\(/, '要用 `new Audio(...)` 播真音频');
  // ⚠️ 2026-10-02 改写：原来这里断言的是 `'/' + file + '.caf'` —— 那个写法对**内置**
  //    铃声是对的（`ALARM_SOUNDS[].file` = `'alarm-morning'`，**不带后缀**），
  //    但对**用户导入**的铃声是必然 404：壳报回来的名字**已经带 `.caf`**，
  //    而且文件在 App 容器的 `Library/Sounds`（由壳的 `/__sounds/` 路由提供），
  //    不在包根。拼出来是 `/timetable-custom-….caf.caf` → 取不到 →
  //    静默回落到合成音型 —— 于是用户听到的"自己那首歌"其实是假的。
  //    现在两种文件走两条路，所以断言也钉成两条。
  assert.match(src, /function soundUrlOf\(/, '真文件 URL 必须由 `soundUrlOf()` 统一算（不许各处手拼）');
  assert.match(src, /startsWith\(CUSTOM_SOUND_PREFIX\)/,
    '用户导入的铃声要按前缀走 `/__sounds/` 那条路（容器里的文件，包根没有）');
  assert.match(src, /'\/__sounds\/'/,
    '容器里的文件必须走 `/__sounds/` 那条路由（壳就是在那里把 `Library/Sounds` 里的文件吐出来的）');
  assert.ok(!/String\(s\.file\)\s*\+\s*'\.caf'/.test(stripComments(src)),
    "不许再有 `'/' + file + '.caf'` 这种拼法 —— 自定义文件自带 `.caf`，拼出来会变成 `.caf.caf`（必然 404，且静默回落）");
  assert.match(src, /function playSynthPreview\(/, '必须保留"回落合成音型"这条路径');
  assert.match(src, /playSynthPreview\(s, why\)/, '回落时要把"为什么没播真文件"传下去（要如实告知用户）');
  assert.ok(!/真文件在 App 里，网页取不到/.test(stripComments(src)),
    '那句"网页取不到真文件"**是错的**（MIME 补上就能取），不许再出现在**给用户看的文案**里'
    + '（注释里可以引用它来说明为什么错，所以这里要先 stripComments）');

  // ② 壳的 MIME 表：caf / wav / m4a 必须有音频类型。
  //    ⚠️ 为什么单独断言：`tools/ios-bundle.test.mjs` 的 MIME 检查只覆盖
  //    **网页实际请求过的扩展名**，而那条 E2E 需要浏览器（本机跑不了）
  //    → `.caf` 永远不会被请求到，也就永远不会被发现缺 MIME。
  const swift = read('ios/Timetable/LocalServer.swift');
  const mimeBlock = swift.slice(swift.indexOf('static func mimeType'), swift.indexOf('default: return'));
  //    ⚠️ 这里**不要**去精确匹配 `case "x": return "y"` 的形状 —— 表里有
  //    `case "m4a", "aac":`（一行两个名字、两个独立引号对）和 `case "html", "htm":` 这种写法，
  //    任何"只允许一对引号"的正则都会漏掉它（我连写错两版）。改成：
  //    抓出所有 case 分支 → 看每个扩展名是否**出现在某条分支的名字列表里**。
  const branches = [...mimeBlock.matchAll(/case\s+([^:]+):\s*return\s+"([^"]+)"/g)]
    .map((m) => ({ names: [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]), type: m[2] }));
  assert.ok(branches.length >= 8, `MIME 表解析失败（只解析出 ${branches.length} 条分支）`);
  for (const ext of ['caf', 'wav', 'm4a']) {
    const hit = branches.find((b) => b.names.includes(ext));
    assert.ok(hit, `LocalServer.swift 的 MIME 表里缺 \`${ext}\` —— 浏览器会以 octet-stream 拒绝播放`);
    assert.ok(hit.type.startsWith('audio/'), `\`${ext}\` 的 MIME 必须是 audio/*，实际是 ${hit.type}`);
  }

  // ③ 目录里每个 file 都必须真的有同名 .caf，否则真机必然静默回落默认音
  const { ALARM_SOUNDS } = await import(pathToFileURL(path.join(ROOT, 'core/alarms.js')).href);
  const missing = [];
  for (const s of ALARM_SOUNDS) {
    // ⚠️ `id: 'custom'`（用户自己导入的那一档）**故意没有包内文件** ——
    //    它的 `file` 是空串，真实文件在 App 容器的 `Library/Sounds`（运行时才有）。
    //    所以这一档要跳过这条检查，并反过来钉住"它的 file 必须是空串"
    //    （如果哪天有人给它填了个包内文件名，那就说明这两条路被弄混了）。
    if (s.id === 'custom') {
      assert.equal(s.file, '', '「自定义」那一档的 file 必须留空（真实文件名运行时才由壳报上来）');
      continue;
    }
    if (!fs.existsSync(path.join(ROOT, 'ios', 'Timetable', `${s.file}.caf`))) {
      missing.push(`${s.id}(${s.label}) → ios/Timetable/${s.file}.caf`);
    }
  }
  assert.deepEqual(missing, [],
    '这些铃声在目录里但没有对应的 .caf（真机会静默放默认音）：\n  ' + missing.join('\n  '));
});

test('诊断小节在（状态 + 试响 + 网页/壳两边排程对照）', () => {
  const src = read(VIEW_REL);
  assert.match(src, /function blockDiag\(/, '缺诊断小节');
  assert.match(src, /alarmKitStatus\(\)/, '诊断要显示 AlarmKit 可用/授权状态');
  assert.match(src, /bridge\.scheduleStatus\(\)/, '诊断要显示壳回报的"排了几条"');
  assert.match(src, /dataset: \{ role: 'al-status' \}/, '缺状态区');
  assert.match(src, /dataset: \{ role: 'al-plan' \}/, '缺"网页算出来的排程"区');
  assert.match(src, /dataset: \{ role: 'al-shell-plan' \}/, '缺"壳回报的实际排程"区');
  assert.match(src, /bridge\.planAlarms\(alarms\)/, '网页侧的排程必须转调同一份 core 函数（不许在视图里另算）');
  // 试响：必须真的走壳（这是唯一能验证铃声的操作）
  assert.match(src, /bridge\.testAlarmSound\(/, '缺「试响」——它是唯一能验证自定义铃声的操作');
  assert.match(src, /10 秒后试响/, '试响按钮文案要说清"10 秒后"');
});

test('三块都必须有**如实**的失败/边界文案（不许静默失败）', () => {
  const src = read(VIEW_REL);
  // ⚠️ 2026-10-01 改写：原来这里断言的是"必须如实写明**暂不支持**自选文件"。
  //    那句依据（"AlertSound.named() 只能读打进包的音频"）**是错的** ——
  //    真机实测：用户导入到 App 容器 `Library/Sounds` 的音频，AlarmKit 真的能响。
  //    自选文件做成了正门功能，所以这条断言**反过来**：要写明**支持**，并且
  //    仍要如实说明"没导入时不会显示自定义那一档"（避免用户选了却静默放默认音）。
  assert.match(src, /导入音频…/, '要做（并写出来）"导入音频"这个入口，而不是把它藏起来');
  assert.match(src, /30 秒以内/, '要写明"只取 30 秒以内"（系统硬上限，不说用户会以为被截坏了）');
  assert.match(src, /试听.*真铃声那个音频文件|真铃声那个音频文件/, '要写明"试听放的是真文件"（改掉旧的"音型示意"说法）');
  assert.match(src, /静默放默认音/, '要写明"iOS 找不到声音文件时是静默放默认音"（这是最误导人的一种）');
  // 没授权 / 低于 26 / 没排上，三种要说得出区别
  assert.match(src, /系统低于 iOS 26/, '要说清"系统低于 26"这一种');
  assert.match(src, /没授权/, '要说清"没授权"这一种');
  assert.match(src, /没能交给系统/, '要说清"落库了但没交给壳"这一种（最危险：看起来成功）');
  // 失败码 → 人话
  assert.match(src, /function showAlarmError\(/, '缺失败翻译函数');
  for (const code of ['ALARM_HOUR', 'ALARM_WEEKDAYS', 'ALARM_LIMIT', 'ALARM_SOUND']) {
    assert.match(src, new RegExp(code), `失败文案表里缺 ${code}（按码翻译，不许匹配中文）`);
  }
  assert.match(src, /👉/, '失败文案要带"👉 下一步"（本项目的既有范式）');
});

test('门控文案：不在原生壳里时说清"为什么这里没有闹钟"', () => {
  const src = read(VIEW_REL);
  assert.match(src, /闹钟只在 iPhone \/ iPad \/ 安卓 App 里能用/, '缺"非原生壳"时的说明文案');
  assert.match(src, /免得你设了一个不会响的闹钟/, '要说明"为什么这里不显示入口"（否则用户以为功能没做）');
});

test('⭐ app.js 调用的每个**本地函数**也必须真的存在（2026-10-01 我又栽了同一个坑）', () => {
  // 事故形状：做「自定义闹钟铃声」时，我在 `applySoundEvent` 里写了一句
  //   `scheduleAlarmsSoon();` —— **那个函数根本不存在**（正确的是 `refreshAlarmSchedule`）。
  //   这和 2026-09-30 那个 `refreshAlarmStatus` 漏导入**是同一种 bug**：
  //   静态读代码看不出来，**只有运行时走到那一行才炸**（真机上弹「App 出了个错」）。
  //
  // 为什么已有那条"桥函数必须导入"的断言拦不住它：那条只查**从 native.js 导入的名字**，
  // 而 `scheduleAlarmsSoon` 不是导入的 —— 它是"以为页面上有个本地函数"。
  //
  // 做法：把 app.js 里所有 `name(` 形式的调用抠出来，逐个到
  //   app.js + 它 import 的那些模块里找定义；找不到的**必须**出现在一份显式白名单里
  //   （浏览器全局、语言内置、或确实由别处提供的东西）。白名单是**故意显式**的：
  //   加进去要动代码，就不可能"顺手放过"。
  const src = read(APP_REL);
  const code = stripComments(src);
  // 全局/语言内置/浏览器 API：这些不是"本地函数"，列全了才不会天天假红
  const GLOBALS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new',
    'Number', 'String', 'Boolean', 'Array', 'Object', 'Math', 'JSON', 'Date', 'Error',
    'Set', 'Map', 'Promise', 'RegExp', 'Symbol', 'BigInt', 'isNaN', 'isFinite',
    'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'alert', 'confirm',
    'structuredClone', 'queueMicrotask', 'Intl', 'URL', 'URLSearchParams', 'TextEncoder',
    'Audio', 'Image', 'Blob', 'File', 'FileReader', 'CustomEvent', 'Event', 'AbortController',
    'AudioContext', 'webkitAudioContext', 'localStorage', 'indexedDB', 'crypto', 'performance',
    'import', 'super', 'await', 'yield', 'delete', 'void', 'in', 'of', 'do', 'else', 'try',
    'finally', 'throw', 'case', 'default', 'break', 'continue', 'class', 'extends', 'this',
    // ⚠️ 这几个是"被正则误当函数名的关键字"：`var x = (…)` / `const f = async (…)` 之类
    //    会让 `var` / `async` 后面紧跟一个 `(`。它们不该进 unknown 名单。
    'var', 'let', 'const', 'async', 'function', 'typeof', 'new', 'return', 'get', 'set',
  ]);
  // 这份白名单 = "确实不在 app.js 里定义、但调用是合法的"（每条都要能说出为什么）
  const ALLOW = new Set([
    // 由 import 进来的名字（下面会真的去那些模块里找，找不到就报）
    ...['inShell', 'announceReady', 'installShellReceiver', 'pushNotifications',
      'pushShareData', 'pushVoiceMirror', 'refreshCustomSounds', 'refreshAlarmStatus',
      'applyShellAlarms', 'pushAlarmSchedule', 'refreshAlarmSchedule', 'applySavedMode',
      'el', 'mount', 'toast', 'store', 'bridge', 'reminder', 'api',
      'renderAll', 'startReminder', 'applySoundEvent', 'pushShellNotifications',
      'buildBubbleDemo', 'setupKeyboard', 'setupSwipe'],
  ]);
  const called = new Set();
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (!GLOBALS.has(name)) called.add(name);
  }
  const defined = new Set();
  // ① app.js 里的各种定义形式
  for (const m of code.matchAll(/(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function|\()/g)) defined.add(m[1]);
  // ② import 进来的名字（默认导入 / 命名导入 / 命名空间导入）
  for (const m of code.matchAll(/import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g)) {
    for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) {
      if (n[1] !== 'as' && n[1] !== 'from') defined.add(n[1]);
    }
  }
  const unknown = [...called].filter((n) => !defined.has(n) && !ALLOW.has(n));
  assert.deepEqual(unknown, [],
    'app.js 里调用了这些**找不到定义**的名字（真机上就是弹「App 出了个错」）：\n  '
    + unknown.join('\n  ')
    + '\n如果它们确实是别处提供的，请加进本断言的 ALLOW 白名单并写清理由。');
});

// ---------------------------------------------------------------------------
// ③ 适配器：契约字段与状态回灌
//
// ⚠️ 契约（网页 ↔ 壳）的一个字都不许漂：壳按这些字段读。
// ---------------------------------------------------------------------------

test('适配器只用 core 算排程，且契约字段与 core 一致', () => {
  const src = read(ADAPTER_REL);
  assert.match(src, /planAlarmSchedule\(/, '适配器必须转调 core 的 planAlarmSchedule');
  assert.match(src, /type: 'alarms'/, "缺 'alarms' 消息（整批重排）");
  assert.match(src, /type: 'alarmTimer'/, "缺 'alarmTimer' 消息（倒计时开始/取消）");
  assert.match(src, /type: 'alarmScheduleStatus'/, "缺 'alarmScheduleStatus' 消息（问状态）");
  // ⚠️ 「计时器不走整批重排」这条规则的**实现**在 core 的 planAlarmSchedule
  //    （它 `if (a.kind !== 'clock') continue;`），已经由 tools/alarms.test.mjs
  //    钉住了（"计时器也不走这条路"那条断言）。这里只确认适配器确实转调了
  //    那个函数 —— 在源码字符串里再断言一遍 core 的实现只会造成**假失败**
  //    （注释里出现这几个字、或者 core 改了写法，都会让它红）。
  // 暂停/继续的算法要写对：startedAt = now - (duration - left)
  assert.match(src, /a\.durationMs - left/, '暂停/继续的时间换算不见了（startedAt = now −(duration − left)）');
  assert.match(src, /paused: true/, '暂停要显式记 paused（否则"暂停"和"在跑"分不出来）');
});

test('状态回灌：shell 报什么就显示什么，并且能认出"铃声没生效"', () => {
  const src = read(ADAPTER_REL);
  assert.match(src, /export function applyShellAlarms\(/, '缺 applyShellAlarms');
  assert.match(src, /soundOk/, '要读壳回报的 soundOk（铃声文件找没找到）');
  assert.match(src, /soundUnsupported/, '要能汇总出"自定义铃声没生效"');
  assert.match(src, /export function scheduleStatus\(/, '缺 scheduleStatus');
  // 排程上限必须和 core 同源
  assert.match(src, /MAX_SCHEDULED/, '上限要用 core 的 MAX_SCHEDULED（和壳的 maxAlarms 同源）');
  // 不在壳里要**如实**返回 false，不许假装排好
  assert.match(src, /return \{ sent: false|sent: ok/, '发不出去时要如实回 sent:false');
});

// ---------------------------------------------------------------------------
// ④ 桩 DOM：真把这一页画一遍（渲染时抛 = 用户看到白页）
// ---------------------------------------------------------------------------

const listeners = [];
class StubNode {}
globalThis.Node = StubNode;

function makeElement(tag = 'div') {
  return Object.assign(new StubNode(), {
    tagName: String(tag).toUpperCase(),
    children: [], childNodes: [],
    style: {
      _custom: {},
      setProperty(k, v) { this._custom[k] = String(v); this[k] = String(v); },
      getPropertyValue(k) { return Object.prototype.hasOwnProperty.call(this._custom, k) ? this._custom[k] : ''; },
      removeProperty(k) { delete this._custom[k]; delete this[k]; },
    },
    dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    attributes: {}, value: '', textContent: '', innerHTML: '', hidden: false,
    firstChild: null, parentElement: null, isContentEditable: false,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { this.children.push(c); this.childNodes.push(c); if (c) c.parentElement = this; this.firstChild = this.childNodes[0] || null; return c; },
    append(...c) { c.forEach((x) => this.appendChild(x)); },
    removeChild(c) {
      this.children = this.children.filter((x) => x !== c);
      this.childNodes = this.childNodes.filter((x) => x !== c);
      this.firstChild = this.childNodes[0] || null;
      return c;
    },
    remove() {}, insertBefore(n) { return this.appendChild(n); },
    addEventListener(type, fn) { listeners.push([this, type, fn]); },
    removeEventListener() {}, dispatchEvent() { return true; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; }, contains() { return true; },
    focus() {}, click() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 800, height: 600, right: 800, bottom: 600 }; },
    setPointerCapture() {}, releasePointerCapture() {},
    insertAdjacentHTML() {}, scrollIntoView() {},
    getContext() { return null; }, toDataURL() { return 'data:,'; },
  });
}

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
}

const knownNodes = new Map();
function stubQuery(sel) {
  const key = String(sel || '').trim();
  if (!key) return null;
  if (!knownNodes.has(key)) knownNodes.set(key, makeElement('div'));
  return knownNodes.get(key);
}

const stubBody = makeElement('body');
defineGlobal('document', {
  documentElement: makeElement('html'), head: makeElement('head'), body: stubBody,
  createElement: (tag) => makeElement(tag),
  createTextNode: (t) => Object.assign(new StubNode(), { nodeType: 3, textContent: String(t), children: [] }),
  createDocumentFragment: () => makeElement('fragment'),
  getElementById: (id) => stubQuery(`#${id}`),
  querySelector: (sel) => stubQuery(sel),
  querySelectorAll: () => [],
  addEventListener: (type, fn) => listeners.push([null, type, fn]),
  removeEventListener: () => {},
  visibilityState: 'visible', hidden: false, title: '', cookie: '', readyState: 'complete',
});
const stubNavigator = { userAgent: 'node', language: 'zh-CN' };
defineGlobal('window', {
  document: globalThis.document,
  location: { protocol: 'http:', href: 'http://127.0.0.1:17801/' },
  navigator: stubNavigator,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  addEventListener: (type, fn) => listeners.push([null, type, fn]),
  removeEventListener: () => {},
  setTimeout: (...a) => setTimeout(...a), clearTimeout: (...a) => clearTimeout(...a),
  // ⚠️ `setInterval` 要返回**真句柄**（不能返回 0）：视图里的 alarmsTick 靠
  //    "句柄是不是空的"判断"已经在跑了、别重复起一个"。桩返回 0 的话
  //    那句判断永远为假 → 每次调用都再起一个"定时器"，测出来的行为与真机不符。
  setInterval: (...a) => setInterval(...a), clearInterval: (...a) => clearInterval(...a),
  requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  devicePixelRatio: 1, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  Notification: undefined, AudioContext: undefined,
  CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
});
defineGlobal('navigator', stubNavigator);
defineGlobal('location', globalThis.window.location);
defineGlobal('CustomEvent', globalThis.window.CustomEvent);
defineGlobal('localStorage', {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
  clear() { this._m.clear(); },
});
defineGlobal('sessionStorage', globalThis.localStorage);
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };

/** 把桩 DOM 里的文字全抓出来（断言"界面上到底显示了什么"） */
function collectText(node) {
  if (!node || typeof node !== 'object') return '';
  let out = typeof node.textContent === 'string' ? `${node.textContent}\n` : '';
  for (const child of (node.children || node.childNodes || [])) out += collectText(child);
  return out;
}

const makeCtx = (state) => ({
  state, setView() {}, setCursor() {}, setCourseWeek() {}, setLocal() {}, refresh() {},
  newEventAt() {}, editEvent() {},
});

const NOW = new Date('2026-03-02T06:30:00');
/**
 * 造两条样例闹钟（**每次调用都按"真实现在"算 startedAt**）。
 *
 * ⚠️ 为什么不写成固定常量（第一版就是常量，害我查了一轮假失败）：
 *    视图渲染时用的是**真实时钟**（`timerRemainingMs(a)` 不传 now），
 *    而固定常量里的 startedAt 是 2026-03-02 —— 于是"25 分钟倒计时"在
 *    真实时间里**早就结束了**，界面上根本不显示剩余时间，
 *    断言却写着"应当有 mm:ss"。那是**测试的错**，不是代码的错。
 *    （倒计时这类"跟着现在走"的东西，fixture 必须跟着现在走。）
 */
function sampleAlarms(now = new Date()) {
  return [
    {
      id: 'alarm_wake', kind: 'clock', atHour: 7, atMinute: 0, repeat: 'weekdays',
      weekdays: [1, 2, 3, 4, 5], label: '起床', sound: 'morning', enabled: true,
      durationMs: 1_500_000, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    },
    {
      id: 'alarm_run', kind: 'timer', durationMs: 25 * 60_000, label: '番茄钟',
      sound: 'beep', enabled: true,
      startedAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
      paused: false, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    },
  ];
}
const SAMPLE_ALARMS = sampleAlarms();

test('浏览器里（没有 iOS 桥）：门控关闭，侧栏没有它，直接进来也看得懂', async () => {
  const { alarmsView, alarmsViewAllowed } = await import(pathToFileURL(VIEW).href);
  assert.equal(alarmsViewAllowed(), false, '没有 window.webkit 时必须判定为"不允许"');
  const state = { ready: true, alarms: sampleAlarms(), settings: {} };
  const host = makeElement('main');
  assert.doesNotThrow(() => alarmsView.render(state, makeCtx(state), host));
  const text = collectText(host);
  // ⚠️ 标题在 2026-10-xx 从「只在 iPhone / iPad 的 App 里能用」改成带上了安卓
  //    （安卓加了闹钟简版：网页负责落库，壳用 AlarmManager 到点响）。
  assert.ok(text.includes('闹钟只在 iPhone / iPad / 安卓 App 里能用'),
    '直接进到这一页时要给出解释（而不是空白或报错）：\n' + text);
  assert.ok(!text.includes('试响'), '门控关闭时不该渲染出可用的闹钟 UI');
});

test('安卓壳（壳注入 __timetablePlatform）：门控打开，且不照抄 iOS 的话术', async () => {
  // ⚠️ 安卓**没有 JS 桥**（MainActivity 里没有 addJavascriptInterface），网页认自己
  //    只能靠壳往 HTML 里注入的那行 `window.__timetablePlatform='android'`
  //    （LocalServer.withPlatformMarker）。这条测试守三件事：
  //      ① 门控必须打开 —— 否则用户根本看不到闹钟板块（安卓白白有了排程也不可见）；
  //      ② 不能把 iOS 的 AlarmKit 诊断搬过来（"iOS 26 起才有"在安卓上是假话，
  //         会让用户以为这台设备没有闹钟）；
  //      ③ "试响/申请权限"这些 iOS 独有的入口不许出现（点了不会有反应）。
  globalThis.window.__timetablePlatform = 'android';
  try {
    const { alarmsView, alarmsViewAllowed } = await import(
      `${pathToFileURL(VIEW).href}?android=1`);
    assert.equal(alarmsViewAllowed(), true, '安卓壳上门控要打开（闹钟简版就是为它做的）');
    const state = { ready: true, alarms: sampleAlarms(), settings: {} };
    const host = makeElement('main');
    assert.doesNotThrow(() => alarmsView.render(state, makeCtx(state), host),
      '渲染抛了 = 安卓用户看到白页');
    const text = collectText(host);
    assert.ok(text.includes('AlarmManager'), '安卓侧要说清是系统闹钟排程：\n' + text);
    assert.ok(!text.includes('AlarmKit 可用'), '安卓上不该出现 iOS 的 AlarmKit 诊断行：\n' + text);
    assert.ok(!/iOS 26 起才开放/.test(text), '安卓上不该照抄"iOS 26 起才有"的说法：\n' + text);
    assert.ok(!text.includes('申请闹钟权限'), '安卓没有"申请闹钟权限"这个入口（那是 iOS 的）：\n' + text);
    assert.ok(text.includes('准点程度'),
      '关掉精确闹钟授权时安卓会把唤醒推后 —— 诊断里必须有一句人话：\n' + text);
  } finally {
    delete globalThis.window.__timetablePlatform;
  }
});

test('渲染冒烟（iOS 壳）：三块 + 诊断都在，内容都对得上', async () => {
  // 模拟 iOS 壳：WKWebView 注入的那个 messageHandlers
  const posted = [];
  globalThis.window.webkit = {
    messageHandlers: { timetable: { postMessage: (m) => posted.push(m) } },
  };
  try {
    const { alarmsView, alarmsViewAllowed } = await import(
      `${pathToFileURL(VIEW).href}?ios=1`);
    assert.equal(alarmsViewAllowed(), true, '有 iOS 桥时门控要打开');

    const state = { ready: true, alarms: sampleAlarms(), settings: {} };
    const host = makeElement('main');
    assert.doesNotThrow(() => alarmsView.render(state, makeCtx(state), host), '渲染抛了 = 用户看到白页');
    const text = collectText(host);

    for (const must of ['计时器', '定时器（闹钟）', '铃声', '诊断']) {
      assert.ok(text.includes(must), `界面上没有「${must}」：\n${text}`);
    }
    // 计时器：剩余时间必须由 core 现算（不要断言具体数字 —— fixture 用的是
    // 真实时钟算出来的 startedAt，写死 "20:00" 会在某天变成假失败）
    assert.match(text, /还剩 \d{2}:\d{2}/,
      '计时器的剩余时间没显示出来（应当是 mm:ss）：\n' + text);
    // 定时器：那条工作日 07:00 的要在列表里
    assert.ok(text.includes('07:00'), '定时器列表没显示 07:00：\n' + text);
    assert.ok(text.includes('起床'), '标签没显示');
    // 铃声目录：五个音都要能选/能试听
    for (const label of ['晨钟', '轻快三连', '低沉两下', '水滴', '连续滴']) {
      assert.ok(text.includes(label), `铃声目录里没有「${label}」：\n${text}`);
    }
    // 诊断：状态区必须有 AlarmKit/权限/条数
    assert.ok(text.includes('AlarmKit 可用'), '诊断区没有 AlarmKit 状态');
    assert.ok(text.includes('闹钟权限'), '诊断区没有权限状态');
    assert.ok(text.includes('库里的闹钟：2 条'), '诊断区没说清库里几条：\n' + text);
    // ⚠️ 这次的场景是"**壳还没回报**"（没灌过任何 alarms 消息，scheduleState.known 为假）。
    //    这时光显示"还没收到壳的回报"是**不够**的 —— 用户不知道下一步该干什么。
    //    2026-09-30 真机上就是这个症状，所以钉住"必须给出可执行的下一步"。
    assert.ok(text.includes('还没收到壳的回报'), '壳没回报时要说清"还没收到壳的回报"：\n' + text);
    assert.ok(text.includes('重排全部闹钟'),
      '壳没回报时，必须给出一个不依赖回报的自证办法（按「重排全部闹钟」看提示语）：\n' + text);
    assert.ok(/先确认装的是最新那个包/.test(text),
      '壳没回报时，要提醒"先确认装的是最新包"（实测最可能的原因就是包比源码旧）：\n' + text);
    // 如实边界（2026-10-01 改：自选文件**已经支持**，所以断言反过来 —— 要写明"可以导入"）
    assert.ok(text.includes('导入音频'), '界面没写清"可以导入自己的音频"');
  } finally {
    delete globalThis.window.webkit;
  }
});

test('⭐⭐ 「全部闹钟」：每一条都画出来（跑完的计时器也在）、能改、清理只碰计时器（2026-10-02 用户 m03912）', async () => {
  // 用户原话（m03912）：「我需要一个显示已创建闹钟的地方，同时我要可删改」
  //
  // 改之前的样子（这正是用户点出这条需求的原因）：
  //   这一页的标题写着"共 12 条，开着 12 条"，屏幕上却只有 1 行 —— 因为跑完的计时器
  //   `enabled` 仍然是 true（所以**数得进去**），而计时器那段只画"正在跑的那一条"
  //   （所以**画不出来**）。看不见 = 删不掉，于是它们只增不减。
  //
  // 这条测试守三件事（每一件都对应一种静默失败）：
  //   ① 行数必须**等于**闹钟条数（含跑完的计时器）—— "显示得出来"是"能删"的前提；
  //   ② 计数按**状态**算，不按 `enabled`（旧写法在这份数据上会报 3 条"开着"，实际只 2 条会响）；
  //   ③ 「清掉已结束的计时器」只许删**计时器** —— 定时器是用户排的班，一条都不能动。
  const deletes = [];
  globalThis.window.webkit = {
    messageHandlers: { timetable: { postMessage: () => true } },
  };
  const realFetch = globalThis.fetch;
  // 用**真的 fetch 桩**去打完整的删除链路（store.deleteAlarm → api DELETE /api/alarms/:id）：
  // 直接替换 store 的函数是做不到的（视图用 `import * as store` 拿的是**冻结的命名空间对象**），
  // 而且从 fetch 这一层看，断言的正是"到底往服务端发了哪条删除"。
  globalThis.fetch = async (url, opts) => {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    if (method === 'DELETE') deletes.push(String(url));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const walkAll = (n) => {
    const out = [];
    const go = (x) => { if (!x || typeof x !== 'object') return; out.push(x); for (const c of (x.children || [])) go(c); };
    go(n);
    return out;
  };
  try {
    // ⚠️ startedAt 用**真实时钟**倒推（和 `sampleAlarms` 同一个理由：视图渲染时不传 now，
    //    写死 2026-03-02 的话"25 分钟倒计时"在真实时间里早就跑完了 —— 那是测试的错）
    const nowMs = Date.now();
    const ended = {
      id: 'alarm_stale', kind: 'timer', durationMs: 10 * 60_000, label: '泡面', sound: 'beep',
      enabled: true, paused: false, startedAt: new Date(nowMs - 3 * 3600_000).toISOString(),
    };
    const running = {
      id: 'alarm_run', kind: 'timer', durationMs: 25 * 60_000, label: '番茄钟', sound: 'beep',
      enabled: true, paused: false, startedAt: new Date(nowMs - 5 * 60_000).toISOString(),
    };
    const waiting = {
      id: 'alarm_sleep', kind: 'clock', atHour: 21, atMinute: 35, repeat: 'daily',
      label: '睡前', sound: 'morning', enabled: true,
    };
    // 跑完的那条**故意放在第一个**：它必须出现在列表里（改之前它连画都画不出来）
    const alarms = [ended, running, waiting];
    const state = { ready: true, alarms, settings: {} };
    const { alarmsView } = await import(`${pathToFileURL(VIEW).href}?all=1`);
    const host = makeElement('main');
    assert.doesNotThrow(() => alarmsView.render(state, makeCtx(state), host));

    const nodes = walkAll(host);
    const rows = nodes.filter((n) => n.dataset && n.dataset.role === 'al-row');
    assert.deepEqual(rows.map((n) => n.dataset.alarmId).sort(), ['alarm_run', 'alarm_sleep', 'alarm_stale'],
      '**每一条**闹钟都要画出来（含跑完的计时器）—— 少一条，那条就永远删不掉（m03912 的起因）');
    const rowOf = (id) => rows.find((n) => n.dataset.alarmId === id);
    assert.match(collectText(rowOf('alarm_stale')), /已结束/,
      '跑完的计时器要标出"已结束"（不能画成一条还在跑的）');
    assert.match(collectText(rowOf('alarm_run')), /正在倒计时/);
    assert.match(collectText(rowOf('alarm_sleep')), /会响/);
    // 每条都要有能改、能删的把手
    for (const id of ['alarm_run', 'alarm_sleep', 'alarm_stale']) {
      assert.ok(nodes.some((n) => n.dataset && n.dataset.role === 'al-edit' && n.dataset.alarmId === id),
        `${id} 那一行没有「改」按钮（用户要的"可改"就落在这上面）`);
      assert.ok(nodes.some((n) => n.dataset && n.dataset.role === 'al-delete' && n.dataset.alarmId === id),
        `${id} 那一行没有「删」按钮（用户要的"可删"就落在这上面）`);
    }

    // ② 计数按状态算（这份数据里 2 条会响：跑着的计时器 + 会响的定时器）
    const sum = nodes.find((n) => n.dataset && n.dataset.role === 'al-all-summary');
    assert.ok(sum, '「全部闹钟」那块没有计数');
    assert.match(String(sum.textContent), /共 3 条/);
    assert.match(String(sum.textContent), /会响的 2 条/);
    assert.ok(!/开着/.test(String(sum.textContent)),
      '不许再用"开着 N 条"：`enabled` 不等于会响（跑完的计时器 enabled 还是 true，那正是假数字的来源）');

    // ③ 「改」：点定时器那一行的「✏️ 改」→ 表单载入**它**（不是默认的 7:00）
    const editSleep = nodes.find((n) => n.dataset && n.dataset.role === 'al-edit' && n.dataset.alarmId === 'alarm_sleep');
    assert.ok(editSleep, '定时器那一行没有「改」按钮');
    const editClick = listeners.filter(([node, type]) => node === editSleep && type === 'click').pop();
    assert.ok(editClick, '「改」按钮没挂 click 监听');
    assert.doesNotThrow(() => editClick[2]({ stopPropagation() {} }), '点「改」不许抛');
    const host2 = makeElement('main');
    alarmsView.render(state, makeCtx(state), host2);
    const nodes2 = walkAll(host2);
    const val = (role) => {
      const n = nodes2.find((x) => x.dataset && x.dataset.role === role);
      return n ? String(n.value) : null;
    };
    assert.equal(val('al-hour'), '21', '点了「改」之后表单要载入那一条的时刻（21:35），不是默认的 7:00');
    assert.equal(val('al-minute'), '35');

    // ④ 「清掉已结束的计时器」：只碰计时器，而且按钮上写清会删几条
    const clean = nodes2.find((n) => n.dataset && n.dataset.role === 'al-clean-timers');
    assert.ok(clean, '没有「清掉已结束的计时器」按钮');
    assert.match(String(clean.textContent), /清掉已结束的计时器（1）/,
      '按钮上要写清**会删几条**（这条数据里只有 1 条跑完的计时器）');
    assert.notEqual(clean.disabled, true, '有得清的时候不许禁用');
    const cleanClick = listeners.filter(([node, type]) => node === clean && type === 'click').pop();
    assert.ok(cleanClick, '清理按钮没挂 click 监听');
    assert.doesNotThrow(() => cleanClick[2]({ stopPropagation() {} }));
    await new Promise((r) => setTimeout(r, 80));   // deleteAlarm 是异步的（逐条 await）
    assert.deepEqual(deletes, ['/api/alarms/alarm_stale'],
      '清理只许删"跑完的计时器"：定时器（用户排的班）与正在跑的计时器一条都不能动');

    // ⑤ 没有可清理的时候：按钮**禁用**（但仍在，位置不跳）
    const cleanState = { ready: true, alarms: [running, waiting], settings: {} };
    const host3 = makeElement('main');
    alarmsView.render(cleanState, makeCtx(cleanState), host3);
    const clean3 = walkAll(host3).find((n) => n.dataset && n.dataset.role === 'al-clean-timers');
    assert.equal(clean3.disabled, true, '没有要清的时候必须禁用（而不是能按但没反应）');
    assert.match(String(clean3.textContent), /没有要清的计时器/);
    // 列表里没有跑完的计时器时也不许冒出"清理"以外的东西动静
    assert.equal(deletes.length, 1, '只是重画一次，不许再发删除请求');
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.window.webkit;
  }
});

test('⭐ 多首自定义铃声：每一首各占一条、本机没有的那一首要报警并不许保存（2026-10-02 用户 m01328）', async () => {
  // 需求原话（用户 m01328 选的是"最小可用版"）：
  //   "用户应该拥有一个自定义列表，一个自定义有时候可能不够用"
  //   → 多首共存 + **每条闹钟各自挑哪一首**；不做改名、不做批量导入。
  //
  // 这条测试守的是这个需求里**最贵**的三种失败（都静默）：
  //   ① 列表里只出现一首 / 每首显示同一个名字 → 用户分不清，等于没做成；
  //   ② 某条闹钟用的那一首**本机没有**（换设备/删过）→ 界面上没有任何提示，
  //      到点响系统默认音，用户只能觉得"闹钟坏了"；
  //   ③ 把 id 当文件名交给壳 → 壳找不到文件 → **静默**响默认音（不报错）。
  //      所以既要断言界面上的字，也要断言**真的交给壳的那个文件名**。
  const posted = [];
  globalThis.window.webkit = {
    messageHandlers: { timetable: { postMessage: (m) => { posted.push(m); return true; } } },
  };
  try {
    // 先按壳的身份灌一次"容器里有哪些音频"，再渲染
    const nat = await import(`${pathToFileURL(path.join(ROOT, 'web/adapter/native.js')).href}`);
    const S1 = 'timetable-custom-9f3a1c07.caf';
    const S2 = 'timetable-custom-aabbccdd.caf';
    const GONE = 'timetable-custom-01234567.caf';
    nat.installShellReceiver(() => {}, () => {}, () => {});
    globalThis.window.__timetableNative.onMessage({
      type: 'soundStatus', files: [S1, S2], alarmFile: S1,
      sounds: [
        { id: '9f3a1c07', name: '竹取飛翔', file: S1 },
        { id: 'aabbccdd', name: '超电磁炮', file: S2 },
      ],
    });

    const { alarmsView } = await import(`${pathToFileURL(VIEW).href}?multi=1`);
    const state = {
      ready: true,
      // 一条用着**某一首具体自定义铃声**、而那一首文件本机已经没有了（用户换过手机 /
      // 在另一台设备上导入的）—— 这正是用户截图里橙色那一行：
      // "自定义（我导入的）⚠️ 那个自定义音频不在了，会响默认音"。
      // ⚠️ 这里故意**不**用老 id `'custom'`：老 id 的语义是"第一首"（见 core 的
      //    `soundFileOf`），本机有文件时它会解析成第一首 —— 那是**正常的**，
      //    不该报警。要测"某一首没了"就必须点名到那一首（`custom:01234567`）。
      alarms: [
        { ...sampleAlarms()[0], sound: GONE.replace(/^timetable-custom-/, 'custom:').replace(/\.caf$/, '') },
        { ...sampleAlarms()[1], sound: 'custom:aabbccdd' },
      ],
      settings: {},
    };
    const host = makeElement('main');
    assert.doesNotThrow(() => alarmsView.render(state, makeCtx(state), host));

    // 行内的副标题必须**按这一条各自那一首**算
    const subs = collectText(host);
    assert.match(subs, /音频不在这台设备上，会响默认音/,
      '那条用着"已经不在了"的自定义铃声的闹钟，行里必须说清会响默认音：\n' + subs);
    assert.match(subs, /自定义 · 超电磁炮/,
      '用着另一首（文件在）的闹钟要显示**那一首**的名字：\n' + subs);

    // 铃声小节：两首各占一张卡（不是"一个格子"）
    const all = (function walk(n, out = []) { out.push(n); for (const c of (n.children || [])) walk(c, out); return out; })(host);
    const drops = all.filter((n) => n && n.dataset && n.dataset.role === 'al-drop-sound');
    assert.equal(drops.length, 2, '两首自定义音频必须各自有一个「删掉」按钮（有一首没卡片 = 用户看不见它）');
    // ⚠️ `soundId` 是**完整 id**（`custom:…`），不是文件名里的 token
    assert.deepEqual(drops.map((n) => n.dataset.soundId).sort(), ['custom:9f3a1c07', 'custom:aabbccdd'],
      '「删掉」按钮要带 soundId（认得出删的是哪一首）');

    // 下拉：两首各占一条 option（用**完整 id** 当 value —— 内核就是按 id 认铃声的）
    const sel = all.find((n) => n && n.dataset && n.dataset.role === 'al-sound');
    assert.ok(sel, '没找到铃声下拉');
    const vals = sel.children.map((o) => o.value);
    assert.ok(vals.includes('custom:9f3a1c07') && vals.includes('custom:aabbccdd'),
      `两首自定义都要在下拉的选项里，实际：${vals.join(', ')}`);
    assert.ok(!vals.includes('custom'),
      '老 id `custom` 不该出现在下拉里（它是"第一首"的意思，会出现两条一模一样的"自定义"，用户不知道该选哪条）');
    assert.equal(sel.children.find((o) => o.value === 'custom:aabbccdd').disabled, undefined,
      '文件还在的那一首不该被禁用');

    // ⚠️⚠️ 关键：**载入一条"铃声已经不在了"的闹钟**（点那一行 = 载入表单编辑）。
    //    这时下拉里必须**留着那一首**（否则浏览器显示成第一项 → 用户改个标签再保存
    //    就把铃声悄悄换了，静默改数据），并且**保存按钮必须禁用**：
    //    存下来只会到点静默响系统默认音（iOS 找不到文件不报错），
    //    用户下次打开还以为"我设的那个铃声好好的"。
    // ⚠️ 2026-10-02（m03912 新增「全部闹钟」之后）：这一页现在**每条闹钟都画出来**
    //    并且按「最该关心的排最上面」排序（见 core 的 `sortAlarmsForDisplay`），
    //    所以"DOM 里第一个 .al-item-main"**不再等于** `state.alarms[0]`（迟早不等于）。
    //    要点的那一行必须**按 alarmId 找**，否则这条测试会在某次排序调整后
    //    悄悄去点另一条闹钟、然后报一个看起来毫不相干的错。
    const rowOf = (nodes, id) => nodes.find((n) => n && n.dataset && n.dataset.role === 'al-row' && n.dataset.alarmId === id);
    const firstRow = rowOf(all, state.alarms[0].id);
    assert.ok(firstRow, '没找到"铃声已经不在了"那条闹钟的画出来的行（m03912 之后每条都必须在列表里）');
    const rowMain = (function walk(n, out = []) { out.push(n); for (const c of (n.children || [])) walk(c, out); return out; })(firstRow)
      .find((n) => n && n.className === 'al-item-main');
    assert.ok(rowMain, '没找到闹钟那一行（点它 = 载入表单）');
    const rowClick = listeners.filter(([node, type]) => node === rowMain && type === 'click').pop();
    assert.ok(rowClick, '闹钟行没挂 click 监听');
    rowClick[2]();
    alarmsView.render(state, makeCtx(state), host);
    const all2 = (function walk(n, out = []) { out.push(n); for (const c of (n.children || [])) walk(c, out); return out; })(host);
    const sel2 = all2.find((n) => n && n.dataset && n.dataset.role === 'al-sound');
    const cur = sel2.children.find((o) => o.value === 'custom:01234567');
    assert.ok(cur, `正在用的那一首必须留在选项里（否则会被静默换掉），实际：${sel2.children.map((o) => o.value).join(', ')}`);
    assert.equal(cur.disabled, true, '本机没有的那一首必须是禁用项');
    assert.match(String(cur.textContent), /不在这台设备上/, '禁用项要说清原因');
    assert.match(collectText(host), /不在这台设备上/, 'form 里必须报警');
    const saveBtn = all2.find((n) => n && n.tagName === 'BUTTON'
      && typeof n.textContent === 'string' && n.textContent.includes('保存修改'));
    assert.ok(saveBtn, '没找到「保存修改」按钮');
    assert.equal(saveBtn.disabled, true, '选中的自定义音频本机没有时**不许保存**（否则到点静默响默认音）');

    // 关键：交给壳的必须是**文件名**，不是 id（id 给壳 = 找不到文件 = 静默响默认音）
    const bridge = await import(`${pathToFileURL(path.join(ROOT, ADAPTER_REL)).href}?multi=1`);
    assert.equal(bridge.alarmSoundFile('custom:aabbccdd'), S2, '自定义 id 必须翻译成**文件名**再交给壳');
    assert.equal(bridge.alarmSoundFile('custom:9f3a1c07'), S1);
    assert.equal(bridge.alarmSoundFile('custom'), S1,
      '老 id `custom` = 第一首（多首之前只能有一首，这是唯一合理的解释）');
    assert.equal(bridge.alarmSoundFile(GONE.replace('.caf', '')), null,
      '不是清单里的名字给 null（= 系统默认音），不许给空串');
    assert.equal(bridge.alarmSoundFile('morning'), 'alarm-morning-bell', '内置的还是不带扩展名的包内名字');
  } finally {
    delete globalThis.window.webkit;
  }
});

test('⭐ 改名：用户起的名字要显示在铃声卡片和下拉里，并且真的存进设置（2026-10-02 用户 m02630）', async () => {
  // 用户原话（m02630）：「列表名我需要可以自己改」。
  // 以前列表上写的是壳生成的编号（`自定义 · 9f3a1c07`）—— 用户根本认不出哪个是自己的哪首歌。
  //
  // 这条测试守三件事（都有静默失败的可能）：
  //   ① 名字存进**设置**（`settings.customSoundNames`，跟着数据同步），而不是壳报的清单里
  //      —— 壳那份清单是"这台设备上有哪些文件"，换个设备就没了；
  //   ② 名字要同时出现在**卡片**和**下拉**里（只在别处改、下拉还是编号 = 用户选的时候照样认不出）；
  //   ③ 弹窗必须走项目自己的 `openModal`：`window.prompt()` 在 WKWebView 里
  //      **静默返回 null**（电脑上正常、iPad 上"点了没反应"），所以这条也顺便钉住。
  globalThis.window.webkit = {
    messageHandlers: { timetable: { postMessage: () => true } },
  };
  try {
    const nat = await import(`${pathToFileURL(path.join(ROOT, 'web/adapter/native.js')).href}`);
    const store = await import(`${pathToFileURL(path.join(ROOT, 'web/adapter/store.js')).href}`);
    const S1 = 'timetable-custom-9f3a1c07.caf';
    nat.installShellReceiver(() => {}, () => {}, () => {});
    // ⚠️ 壳报的名字是**空串**：这一条测的就是"壳没有名字时，用户自己起一个"
    globalThis.window.__timetableNative.onMessage({
      type: 'soundStatus', files: [S1], alarmFile: S1,
      sounds: [{ id: '9f3a1c07', name: '', file: S1 }],
    });
    store.setState({
      settings: { ...(store.getState().settings || {}), customSoundNames: { '9f3a1c07': '起床号' } },
    });

    const { alarmsView } = await import(`${pathToFileURL(VIEW).href}?rename=1`);
    const state = store.getState();
    const host = makeElement('main');
    assert.doesNotThrow(() => alarmsView.render(state, makeCtx(state), host));

    // ① 卡片上显示用户起的名字，**不再**显示编号
    const text = collectText(host);
    assert.match(text, /自定义 · 起床号/, `卡片要用用户起的名字：\n${text}`);
    assert.ok(!/自定义 · 9f3a1c07/.test(text),
      '起了名就不该再显示那串编号（否则用户以为改名没生效）');

    const all = (function walk(n, out = []) { out.push(n); for (const c of (n.children || [])) out.push(...walk(c)); return out; })(host);
    // ② 下拉里那一条也要是同一个名字（选的时候认得出）
    const sel = all.find((n) => n && n.dataset && n.dataset.role === 'al-sound');
    assert.ok(sel, '没找到铃声下拉');
    const opt = sel.children.find((o) => o.value === 'custom:9f3a1c07');
    assert.ok(opt, '下拉里没有这一首');
    assert.match(String(opt.textContent), /起床号/, '下拉选项也要用用户起的名字');
    // ③ 每首一个「改名」按钮，而且带 soundId（两首以上时用文字分不出点的是哪个）
    const renames = all.filter((n) => n && n.dataset && n.dataset.role === 'al-rename-sound');
    assert.equal(renames.length, 1, '一首自定义铃声配一个改名按钮');
    assert.equal(renames[0].dataset.soundId, 'custom:9f3a1c07', '改名按钮要带**完整 id**');

    // 点它 → 必须是项目自己的弹窗（`openModal`），不许是 `window.prompt`
    const click = listeners.filter(([node, type]) => node === renames[0] && type === 'click').pop();
    assert.ok(click, '「改名」按钮没挂 click 监听');
    assert.doesNotThrow(() => click[2](), '点「改名」不许抛（抛了用户看到的是"点了没反应"）');
    // ⚠️ 只看**代码**，不看注释：这条守卫的说明本身就会提到 `window.prompt()`
    //    （第一版就是这么假红的），所以先 stripComments 再匹配。
    assert.ok(!/\bprompt\s*\(/.test(stripComments(read(VIEW_REL))),
      '视图里**不许**用 window.prompt —— 原生壳里它静默返回 null（这个坑 app.js 里写着）');

    // ④ **真的改一次名**：输入框里打字、点保存 → 值必须落进**设置**（不是壳报的清单）
    //    —— 名字要跟着数据同步，所以只能存在 settings 里。
    //    这里刻意不只看"弹窗出现"，因为"弹出来了但保存没写进去"是同一个坑的另一半。
    const modalHost = stubQuery('#modal-host');
    const modalNodes = (function walk(n, out = []) { out.push(n); for (const c of (n.children || [])) out.push(...walk(c)); return out; })(modalHost);
    const input = modalNodes.find((n) => n && n.dataset && n.dataset.role === 'sound-name');
    assert.ok(input, '弹窗里没找到名字输入框');
    const saveBtn = modalNodes.find((n) => n && n.tagName === 'BUTTON' && n.textContent === '保存');
    assert.ok(saveBtn, '弹窗里没有「保存」按钮');
    input.value = '起床号';
    const saveClick = listeners.filter(([node, type]) => node === saveBtn && type === 'click').pop();
    assert.ok(saveClick, '「保存」按钮没挂 click 监听');
    saveClick[2]();
    await new Promise((r) => setTimeout(r, 30));   // saveSettings 是异步的（先试服务端、失败入队）
    assert.equal(store.getState().settings.customSoundNames['9f3a1c07'], '起床号',
      '改的名字必须写进 settings.customSoundNames（否则刷新一下就没了）');
  } finally {
    delete globalThis.window.webkit;
  }
});

test('⭐ 删掉某一首：发给壳的必须是**文件名**，不是 id（2026-10-02）', async () => {
  // 壳只认文件名（它管的是"容器里那个文件"）。如果这里把 `custom:aabbccdd` 发过去，
  // 壳按名字找不到 → 什么都不删 → 而界面已经把它从列表里摘掉了：
  // 用户以为删了，其实文件还在；反过来如果按"第一个文件"删，就**删错了歌**。
  const posted = [];
  globalThis.window.webkit = {
    messageHandlers: { timetable: { postMessage: (m) => { posted.push(m); return true; } } },
  };
  try {
    const nat = await import(`${pathToFileURL(path.join(ROOT, 'web/adapter/native.js')).href}`);
    const S1 = 'timetable-custom-9f3a1c07.caf';
    const S2 = 'timetable-custom-aabbccdd.caf';
    nat.installShellReceiver(() => {}, () => {}, () => {});
    globalThis.window.__timetableNative.onMessage({
      type: 'soundStatus', files: [S1, S2], alarmFile: S1,
      sounds: [{ id: '9f3a1c07', name: '竹取飛翔', file: S1 }, { id: 'aabbccdd', name: '超电磁炮', file: S2 }],
    });

    const { alarmsView } = await import(`${pathToFileURL(VIEW).href}?drop=1`);
    // ⚠️ 这一条**必须有闹钟数据**：`blockSounds`（铃声卡片）只有渲染出页面才有，
    //    而 `render` 头一件事就是门控 + 三块骨架 —— `alarms: []` 时
    //    "定时器（闹钟）"那块会短路（没有 clock 可画），铃声卡片根本不会生成，
    //    于是"没找到删掉按钮"会被误判成产品 bug。这是测试自己的错。
    const state = { ready: true, alarms: sampleAlarms(), settings: {} };
    const host = makeElement('main');
    alarmsView.render(state, makeCtx(state), host);

    const all = (function walk(n, out = []) { out.push(n); for (const c of (n.children || [])) walk(c, out); return out; })(host);
    // ⚠️ `soundId` 是**完整 id**（`custom:aabbccdd`），不是文件名里的 token ——
    //    第一版这里写成 `'aabbccdd'` 才找不到按钮（测试自己的错，不是产品的错）。
    const dropBtns = all.filter((n) => n && n.dataset && n.dataset.role === 'al-drop-sound');
    assert.equal(dropBtns.length, 2, `两首各要一个「删掉」，实际 ${dropBtns.length} 个`);
    const btn = dropBtns.find((n) => n.dataset.soundId === 'custom:aabbccdd');
    assert.ok(btn, '没找到第二首的「删掉」按钮');
    const h = listeners.filter(([node, type]) => node === btn && type === 'click').pop();
    assert.ok(h, '「删掉」按钮没挂 click 监听');
    const before = posted.length;
    h[2]();
    await new Promise((r) => setTimeout(r, 10));
    const sent = posted.slice(before).filter((m) => m && m.type === 'dropSound');
    assert.equal(sent.length, 1, `点「删掉」应当往壳发一条 dropSound，实际发了 ${sent.length} 条：${JSON.stringify(posted.slice(before))}`);
    assert.equal(sent[0].name, S2, '交给壳的必须是**文件名**（壳按文件名删容器里的文件）');
    assert.ok(!/\bcustom:/.test(JSON.stringify(sent[0])), '不许把 id 发给壳');
  } finally {
    delete globalThis.window.webkit;
  }
});

test('⭐ 导入成功后立刻能在"建闹钟"时选到那一首（不必等壳下一次回报；2026-10-02）', async () => {
  // 用户的实际动作顺序是"导完马上建闹钟选它"。如果这里只等壳下一次 `soundStatus`
  // （一次异步往返），那个窗口里列表会少一首 —— 用户会以为"没导进去"，再导一遍。
  globalThis.window.webkit = {
    messageHandlers: { timetable: { postMessage: () => true } },
  };
  try {
    const nat = await import(`${pathToFileURL(path.join(ROOT, 'web/adapter/native.js')).href}`);
    nat.installShellReceiver(() => {}, () => {}, () => {});
    globalThis.window.__timetableNative.onMessage({
      type: 'soundImported', ok: true,
      name: 'timetable-custom-fedcba98.caf', id: 'fedcba98', alarmFile: 'timetable-custom-fedcba98.caf',
      sounds: [{ id: 'fedcba98', name: '', file: 'timetable-custom-fedcba98.caf' }],
    });
    const bridge = await import(`${pathToFileURL(path.join(ROOT, ADAPTER_REL)).href}?imp=1`);
    assert.equal(bridge.alarmSoundFile('custom:fedcba98'), 'timetable-custom-fedcba98.caf',
      '刚导入的那一首必须立刻能用（否则用户以为没导进去，会再导一遍）');
  } finally {
    delete globalThis.window.webkit;
  }
});

test('⭐ app.js 调用的每个壳桥函数都必须真的从 native.js 导入（2026-09-30「启动失败」那个 bug）', async () => {
  // 事故形状：`app.js:851` 调用 `refreshAlarmStatus()`，但它的 import 清单里**没有这个名字**
  //   → 启动时 `ReferenceError: Can't find variable: refreshAlarmStatus`
  //   → 被启动流程的 try/catch 抓住 → 顶部弹"启动失败"横幅，**后面的初始化全没跑完**。
  //   真机上（iPad）才暴露；当时的静态断言只查了 `applyShellAlarms` 有没有 import，
  //   **没有任何一条断言检查"调用的每个桥函数都导入了"** → 就成了漏网之鱼。
  // 这条断言就是补这个洞：把"调用"与"导入"两张名单机械地对一遍。
  const appSrc = read('web/ui/app.js');
  const natSrc = read('web/adapter/native.js');

  // ① native.js 导出的名字
  const exported = [...natSrc.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
  assert.ok(exported.includes('refreshAlarmStatus'), 'native.js 应当导出 refreshAlarmStatus');

  // ② app.js 从 native.js 导入了哪些名字（含 `x as y` 别名，忽略注释）
  //    ⚠️ 这里第一版写错过：用 `/import\s*\{([\s\S]*?)\}\s*from '…native.js'/` 会从**文件里第一个**
  //    `import {`（`dom.js` 那个）一路吃到 native.js 那句，于是名单里混进 `$` / `clear` 之类，
  //    结果把本来导入好的 `shellKind` / `inShell` 判成"没导入"（**假阳性**）。
  //    所以：只吃 **紧邻** native.js 的那一段 —— `[^}]*` 不允许跨过任何 `}`。
  const imp = appSrc.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/adapter\/native\.js'/);
  assert.ok(imp, "app.js 应当有一条 `import { … } from '../adapter/native.js'`");
  const imported = new Set(
    imp[1].split(',')
      .map((s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim())
      .filter(Boolean)
      .map((s) => {
        const m = s.match(/^(\w+)(?:\s+as\s+(\w+))?$/);
        if (!m) return null;
        return m[2] || m[1];   // 用别名（本地名），因为调用点用的是本地名
      })
      .filter(Boolean)
  );
  assert.ok(imported.has('inShell'), '这条断言自身要能解析出 inShell（否则解析器坏了，见上面注释）');

  // ③ app.js 里**出现了调用**的导出名，必须在导入名单里
  //    ⚠️ 必须先去掉注释再判"有没有调用" —— 第一版没去，于是把注释里提到的
  //    `shellKind()`（L210 那是**文档**，不是调用）判成"调用了却没导入"，又一次假阳性。
  //    （"只搜字符串会被注释骗"这条教训，corpus 里记过，我在这里又踩了一次。）
  const appCode = stripComments(appSrc);
  const missing = [];
  for (const name of exported) {
    const called = new RegExp(`(?<![\\w.])${name}\\s*\\(`).test(appCode);
    if (called && !imported.has(name)) missing.push(name);
  }
  assert.deepEqual(missing, [],
    'app.js 调用了这些壳桥函数但没导入（真机上会 ReferenceError → 顶部"启动失败"）：\n  '
    + missing.join('\n  '));

  // ④ 反向：导入了却没用的（只提示，不断言）
  const unused = [...imported].filter((n) => !new RegExp(`(?<![\\w.])${n}\\s*[({]`).test(appCode));
  if (unused.length) console.log('  （提示）app.js 导入了但似乎没用到：' + unused.join(', '));
});

test('⭐ 真的点一次「⏱ 10 秒后试响」：不许抛错，且必须真的往壳发一条（2026-09-30 `Ctx` 那个 bug）', async () => {
  // 事故形状：我把 `testSound(s)` 改成 `testSound(s, Ctx)`，而**那个作用域里没有 `Ctx` 这个变量**
  //   （按钮在 `blockSounds()` 里，`Ctx` 只存在于别的函数）→ 用户点一下，
  //   真机上弹「App 出了个错 — Can't find variable: Ctx」。
  //   **为什么之前没抓到**：既有的断言全是"读源码 + 查字符串"，
  //   **从来没有真的触发过那个 onclick** —— 字符串里写着 `testSound(s, ctx)` 也照样过。
  //   （后来我又把 `Ctx` 改成了 `ctx`，但**测试仍然不会发现**——所以这条断言必须"真的按一下"。）
  const posted = [];
  globalThis.window.webkit = {
    messageHandlers: { timetable: { postMessage: (m) => { posted.push(m); return true; } } },
  };
  try {
    const view = await import(`${pathToFileURL(VIEW).href}?click=1`);
    const state = { ready: true, alarms: [], settings: {} };
    const host = makeElement('main');
    view.alarmsView.render(state, makeCtx(state), host);

    // 找"试响"那颗按钮（认 dataset.role，和它在哪个小节无关）
    const btn = (function walk(node) {
      for (const c of (node.children || [])) {
        if (c && c.dataset && c.dataset.role === 'al-test-sound') return c;
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    })(host);
    assert.ok(btn, '没找到「试响」按钮（dataset.role="al-test-sound"）—— 铃声小节结构变了');
    assert.ok(btn.dataset.soundId, '试响按钮必须带 soundId（否则不知道要试哪个音）');

    // 触发它的 click 回调（桩 DOM 把 addEventListener 记在 listeners 里）
    const h = listeners.filter(([el2, type]) => el2 === btn && type === 'click').pop();
    assert.ok(h, '试响按钮没挂 click 监听');

    // ⚠️ 关键：**同步阶段不许抛**。`ReferenceError: Ctx is not defined` 就是在这里炸的。
    let threw = null;
    try { h[2](); } catch (e) { threw = e; }
    assert.equal(threw, null,
      '点「试响」时同步抛错了（真机上会弹「App 出了个错」）：' + (threw && threw.message));

    // 等异步流程（postToShell 是同步的，但 runTimerFlow 是 async）
    await new Promise((r) => setTimeout(r, 40));
    const alarmPosts = posted.filter((m) => m && m.type === 'alarmTimer');
    assert.ok(alarmPosts.length >= 1,
      '点「试响」后必须真的往壳发一条 alarmTimer；实际发出去的：' + JSON.stringify(posted));
    assert.ok(alarmPosts[0].action === 'start' && alarmPosts[0].durationSec >= 3,
      '试响那条要是 start 且时长合理：' + JSON.stringify(alarmPosts[0]));

    // ⚠️ 2026-10-02 新增两件事（用户报「试响过了一阵，闹钟自己冒出来」）：
    //   ① 试响这条消息必须带 `test: true` —— 壳靠它决定"响过之后自动撤掉"，
    //      而**不靠 id 前缀猜**：试响与真正的倒计时走的是**同一条** `alarmTimer` 消息。
    assert.equal(alarmPosts[0].test, true,
      '试响必须带 test: true（否则壳不会自动收尾，会留下幽灵闹钟）：'
      + JSON.stringify(alarmPosts[0]));

    //   ② 每次「开始倒计时 / 试响」都要**落盘**留一份（最近 8 条）。
    //      这一条回答的正是本次事件里唯一说不清的问题 ——「改名之后到底有没有
    //      再点过一次试响」。内存里那份（lastAttempt）页面一刷新就没了，指望不上。
    globalThis.localStorage.removeItem('timetable.alarms.attempts');
    h[2]();
    await new Promise((r) => setTimeout(r, 20));
    h[2]();
    await new Promise((r) => setTimeout(r, 40));
    const histRaw = globalThis.localStorage.getItem('timetable.alarms.attempts');
    assert.ok(histRaw, '试响之后必须在 localStorage 里留下记录（诊断区要显示它）');
    const hist = JSON.parse(histRaw);
    assert.equal(hist.length, 2, '两次操作要留两条记录：' + histRaw);
    assert.ok(hist[0].at >= hist[1].at, '记录要新的在前：' + histRaw);
    // 重画一次 → 诊断区应当把这段历史显示出来
    view.alarmsView.render(state, makeCtx(state), host);
    const text2 = collectText(host);
    assert.ok(text2.includes('这台设备上最近 2 次'),
      '诊断区要显示"最近几次「开始倒计时 / 试响」"（这就是下次排查的证据）：\n' + text2);
  } finally {
    delete globalThis.window.webkit;
  }
});

test('⭐⭐ 闹钟板块**每个按钮**都真按一遍：同步不抛错、异步不许有未处理拒绝、托底不许报错（2026-09-30 三个 bug 的系统性堵口）', async () => {
  // 为什么要有这条（血的教训）：
  //   同一天里我在这个板块连出三个 bug，全是"静态断言看不见、只有真按下去才炸"：
  //     ① `AlarmClockScheduler.authorized` 缓存从没刷新 → 闹钟从没交给系统（Swift 侧）
  //     ② `app.js` 调用 `refreshAlarmStatus()` 却没导入 → 启动就 ReferenceError（另见下一条断言）
  //     ③ `testSound(s, Ctx)` —— 作用域里**没有 `Ctx`** → 一点试响就弹「App 出了个错」
  //   而既有的断言全是"读源码 + 查字符串"：字符串写着 `testSound(s, ctx)` 照样过。
  //   所以这条断言的哲学是：**别猜，真的按**。
  //
  // 它检查三件事：
  //   (a) **每个**挂了 click 的元素，触发后同步阶段不许抛；
  //   (b) 异步流程不许产生未处理拒绝（`testSound` 这类是 async 的，同步不抛也可能在 await 后炸）；
  //   (c) `window.dispatchEvent`（`ctx.refresh()` 的入口）不许抛 —— 视图重画最容易撞 undefined 变量。
  const posted = [];
  globalThis.window.webkit = {
    messageHandlers: { timetable: { postMessage: (m) => { posted.push(m); return true; } } },
  };
  const rejections = [];
  const onRej = (r) => { rejections.push(r); };
  process.on('unhandledRejection', onRej);
  // ⚠️ 桩 window 的 dispatchEvent 是空实现（`() => true`），所以 refresh 里的异常会被吞掉。
  //    这里补一个**真的派发器**，好让 `window.addEventListener('timetable:alarms')` 的回调真的跑，
  //    它的异常也就能被抓到。同时**把桩的监听表清空**，避免前面套件留下的回调串味。
  listeners.length = 0;
  const realDispatch = globalThis.window.dispatchEvent;
  const refreshErrors = [];
  globalThis.window.dispatchEvent = (ev) => {
    try {
      let out = true;
      for (const [node, type, fn] of listeners.slice()) {
        if (type === String(ev && ev.type)) out = (fn.call(globalThis.window, ev) !== false) && out;
      }
      return out;
    } catch (e) { refreshErrors.push(e); return true; }
  };

  try {
    const view = await import(`${pathToFileURL(VIEW).href}?allbuttons=1`);
    // ⚠️ 用**带内容**的状态：有计时器（才有暂停/继续/取消）也有定时器（才有开关/删除）
    const state = { ready: true, alarms: sampleAlarms(), settings: {} };
    const ctx = makeCtx(state);
    const host = makeElement('main');
    view.alarmsView.render(state, ctx, host);

    const clickables = [];
    const seen = new Set();
    for (const [node, type] of listeners) {
      if (type !== 'click' || !node || seen.has(node)) continue;
      seen.add(node);
      clickables.push(node);
    }
    assert.ok(clickables.length >= 10,
      `应当能收到至少 10 个可点元素，实际 ${clickables.length} 个 —— 视图结构或桩 DOM 变了`);

    // ⚠️ 跳过"删除"：它会真的改桩 store 的状态、影响后面按钮的渲染。
    //    （它仍然要在下一条"每个 role 都在"的静态断言里出现。）
    // ⚠️ 有些 handler 签名是 `(e) => { e.stopPropagation(); … }`（开关/删除那两个），
    //    所以**不能无参调用** —— 得给一个最小的合成事件，否则测出来的是"我调用方式不对"
    //    而不是"代码有问题"（第一版就是这么误报的）。
    const fakeEvent = {
      stopPropagation() {}, preventDefault() {}, stopImmediatePropagation() {},
      target: null, currentTarget: null, type: 'click',
    };
    const triggered = [];
    const failed = [];
    for (const node of clickables) {
      const role = (node.dataset && node.dataset.role) || '';
      const text = String(node.textContent || '').slice(0, 24);
      const isDelete = role === 'al-delete' || text.includes('删');
      if (isDelete) { triggered.push('跳过(删除)'); continue; }
      const h = listeners.filter(([n, t]) => n === node && t === 'click').pop();
      if (!h) continue;
      try {
        h[2](fakeEvent);                           // (a) 同步阶段
        triggered.push(role || text || '(无 role)');
      } catch (e) {
        failed.push(`${role || text} → ${e && e.name}: ${e && e.message}`);
      }
    }
    await new Promise((r) => setTimeout(r, 150));   // 让 async handler 跑完

    assert.deepEqual(failed, [],
      '这些按钮一按就抛（真机上就是弹「App 出了个错」）：\n  ' + failed.join('\n  '));
    assert.deepEqual(refreshErrors.map((e) => String(e && e.message)), [],
      'refresh 入口抛错：\n  ' + refreshErrors.map((e) => e && e.message).join('\n  '));
    assert.deepEqual(rejections.map((r) => String((r && r.message) || r)), [],
      '有异步未处理拒绝（`Ctx` 那类就是这种：同步不抛、await 之后才炸）：\n  '
      + rejections.map((r) => (r && r.message) || r).join('\n  '));
    assert.ok(triggered.length >= 9, '实际触发到的按钮太少：' + triggered.join(', '));

    // 正向：必须真的把消息发给壳（不能只是"不报错"）
    const types = posted.map((m) => m && m.type).filter(Boolean);
    assert.ok(types.includes('alarmTimer'),
      '按了「试响」/「开始倒计时」之后必须真的有 alarmTimer 发给壳；实际：' + JSON.stringify(types));
    if (process.env.ALARMS_TEST_VERBOSE) console.log('  触发到的：' + triggered.join(' | '));
  } finally {
    process.removeListener('unhandledRejection', onRej);
    globalThis.window.dispatchEvent = realDispatch;
    delete globalThis.window.webkit;
  }
});

test('⭐ 诊断区会报出「上一次操作走到哪一步」（2026-09-30 真机"按了没反应"的排查口子）', async () => {
  // 事故形状：真机上按「开始倒计时」/「10 秒后试响」都没反应、库也不进一条，
  // 而诊断区那六行**分不出**是①没落库 ②没通知壳 ③壳没排上 —— 三段都可能静默失败。
  // 所以视图必须把这三步的结果记下来并显示出来。这条断言钉的就是"这个口子存在"。
  // ⚠️ 必须先把"我在 iOS 壳里"这个标记立起来 —— `alarmsViewAllowed()` 认的是
  //    `window.webkit.messageHandlers.timetable`，没有它 render() 会在门控那一行
  //    直接画"闹钟只在 App 里能用"就 return（第一版就是这么报"找不到按钮"的）。
  globalThis.window.webkit = {
    messageHandlers: { timetable: { postMessage: () => true } },
  };
  try {
    const view = await import(`${pathToFileURL(VIEW).href}?attempt=1`);
    assert.equal(typeof view.lastTimerAttempt, 'function',
      '视图必须导出 lastTimerAttempt()（诊断区靠它说出断点）');

  const state = { ready: true, alarms: [], settings: {} };
  const host = makeElement('main');
  view.alarmsView.render(state, makeCtx(state), host);

  // 找到"开始倒计时"那颗按钮并记下它的点击处理。
  // ⚠️ 认 `dataset.preset`（视图里明确写的），**不要**认 `onclick` 属性 ——
  //    `el()` 是用 `addEventListener('click', …)` 挂的，桩 DOM 只把它记进 listeners
  //    数组、不暴露成 `node.onclick`（第一版就是这么写错的，报"找不到按钮"）。
  const btn = (function walk(node) {
    for (const c of (node.children || [])) {
      if (c && c.dataset && c.dataset.preset) return c;
      const hit = walk(c);
      if (hit) return hit;
    }
    return null;
  })(host);
  assert.ok(btn, '没找到带 dataset.preset 的「N 分钟」开始按钮 —— 视图结构变了');
  assert.ok(String(btn.textContent).includes('分钟'),
    `那颗按钮的文字应形如"N 分钟"，实际是"${btn.textContent}"`);

  // 真的触发它：桩 DOM 记录了 addEventListener 的回调，从 listeners 里取出来调
  const marks = btn.dataset.preset;
  const handler = listeners.filter(([el2, type]) => el2 === btn && type === 'click').pop();
  assert.ok(handler, `按钮 ${marks} 分钟没挂 click 监听`);
  handler[2]();

  // 等异步流程跑完（startTimer 内部是 await 的）
  await new Promise((r) => setTimeout(r, 60));

  const att = view.lastTimerAttempt();
  assert.ok(att && typeof att === 'object', '点完之后 lastTimerAttempt() 必须有内容');
  for (const key of ['at', 'label', 'step', 'detail', 'sent']) {
    assert.ok(key in att, `记录里缺字段 ${key}：${JSON.stringify(att)}`);
  }
  // ⚠️ 这里**不断言 sent 的真假**：桩环境里没有真壳、也没有 IndexedDB，
  //    两种走向都是合法的。断言的是"它把结果说出来了、且说得出是哪一类"。
  assert.ok(typeof att.step === 'string' && att.step.length > 0, 'step 要说清走到哪一步');
  assert.ok(att.step.includes('落库') || att.step.includes('通知壳'),
    `step 必须落在"落库"或"通知壳"这两类上，实际是：${att.step}`);
  assert.ok(['string', 'number'].includes(typeof att.detail) || att.detail === null,
    'detail 要能直接显示给用户');

    // 界面也要把它画出来（不能只存在内存里）
    const host2 = makeElement('main');
    view.alarmsView.render(state, makeCtx(state), host2);
    const text2 = collectText(host2);
    assert.ok(text2.includes('上一次操作'), '诊断区必须渲染出「上一次操作」那一行：\n' + text2);
  } finally {
    delete globalThis.window.webkit;
  }
});

test('适配器：壳回报的状态能被如实接住（包括"铃声文件没找到"）', async () => {
  const bridge = await import(`${pathToFileURL(path.join(ROOT, ADAPTER_REL)).href}?t=2`);
  const before = bridge.scheduleStatus();
  assert.equal(before.known, false, '还没收到回报时必须是 known:false（不许默认成"排好了"）');

  bridge.applyShellAlarms({
    count: 2,
    scheduled: [
      { id: 'alarm_wake', fireAt: '2026-03-02T23:00:00.000Z', sound: 'alarm-morning', soundOk: true },
      { id: 'alarm_wake2', fireAt: '2026-03-02T23:10:00.000Z', sound: 'alarm-beep', soundOk: false },
    ],
  });
  const after = bridge.scheduleStatus();
  assert.equal(after.known, true);
  assert.equal(after.count, 2);
  assert.equal(after.scheduled.length, 2);
  assert.equal(after.scheduled[0].soundOk, true);
  assert.equal(after.scheduled[1].soundOk, false, '壳说文件没找到就要如实记下来');
  assert.equal(after.soundUnsupported, true,
    '只要有一条 soundOk:false，就必须汇总出"自定义铃声没生效"（否则用户以为设好了）');
});

test('⭐ 适配器接得住「上次排程结果」，且**不许把"不知道"默认成成功**（2026-09-30 关键分界）', async () => {
  const bridge = await import(`${pathToFileURL(path.join(ROOT, ADAPTER_REL)).href}?t=lastsched`);

  // ① 壳报"没排上" + 原因 → 必须原样接住
  bridge.applyShellAlarms({
    count: 0, scheduled: [], lastSchedule: 'failed', lastScheduleError: 'Error Domain=AlarmKit Code=1',
  });
  let s = bridge.scheduleStatus();
  assert.equal(s.lastSchedule, 'failed', '壳说失败就必须记成失败');
  assert.ok(String(s.lastScheduleError).includes('AlarmKit'), '失败原因要原样留住（那是给用户看的线索）');

  // ② 壳报"系统收下了" → 记成 ok（**但界面文案必须提醒"收下 ≠ 会响"**）
  bridge.applyShellAlarms({ count: 1, scheduled: [], lastSchedule: 'ok' });
  s = bridge.scheduleStatus();
  assert.equal(s.lastSchedule, 'ok');

  // ③ 旧壳/电脑**根本不带这两个字段** → 一律当"不知道"，**绝不许默认成 ok**
  bridge.applyShellAlarms({ count: 1, scheduled: [] });
  s = bridge.scheduleStatus();
  assert.equal(s.lastSchedule, null,
    '壳没报这一项时必须为 null（"不知道"）—— 默认成 ok 就是本项目最忌讳的那种假绿');
  assert.equal(s.lastScheduleError, null);

  // ④ 脏值（乱写的字符串）也不许被当成 ok
  bridge.applyShellAlarms({ count: 0, scheduled: [], lastSchedule: 'YES!!' });
  assert.equal(bridge.scheduleStatus().lastSchedule, null, '只认精确的 ok / failed，别的都是"不知道"');
});

test('适配器：不在 iOS 壳里时，排程/试响都如实返回没发出去', async () => {
  delete globalThis.window.webkit;
  const bridge = await import(`${pathToFileURL(path.join(ROOT, ADAPTER_REL)).href}?t=3`);
  const r = bridge.pushAlarmSchedule();
  assert.equal(r.sent, false, '不在壳里不许假装排好了');
  assert.equal(r.count, 0);
  const t = bridge.testAlarmSound({ soundId: 'morning', seconds: 10 });
  assert.equal(t.sent, false, '不在壳里不许假装试响发出去了');
  assert.equal(t.file, 'alarm-morning-bell', '但要把"会用哪个文件"如实报出来（诊断要用）');
});

test('倒计时刷新：不在闹钟板块 / 没有在跑的计时器时必须停掉', async (t) => {
  const { alarmsTick } = await import(`${pathToFileURL(VIEW).href}?t=tick`);
  // ⚠️ 一定要收尾：第 ④ 条会真的起一个 250ms 的 interval（桩 setInterval 用的
  //    是真实现）—— 不清掉，测试进程不会退出（表现为"跑完了但不返回"）。
  t.after(() => { alarmsTick('bubble', { alarms: [] }); });
  // ① 不在这个板块 → 不许跑
  assert.equal(alarmsTick('bubble', { alarms: SAMPLE_ALARMS }), false);
  // ② 在这个板块但没有在跑的计时器 → 不许跑
  const idle = { alarms: [{ ...SAMPLE_ALARMS[1], startedAt: null, enabled: true }] };
  assert.equal(alarmsTick('alarms', idle), false);
  // ③ 已暂停 → 也不许跑（暂停了还自己倒数就是一眼假）
  const paused = { alarms: [{ ...SAMPLE_ALARMS[1], paused: true }] };
  assert.equal(alarmsTick('alarms', paused), false);
  // ④ 真在跑 → 要跑
  assert.equal(alarmsTick('alarms', { alarms: SAMPLE_ALARMS }), true);
  // 收尾：别把 interval 留在测试进程里
  alarmsTick('bubble', { alarms: [] });
});
