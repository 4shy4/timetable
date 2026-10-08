// Service Worker：为 PWA（iOS 加到主屏幕 / 安卓装成应用）打地基。
//
// ⚠️ SHELL 清单是 **`tools/gen-precache.mjs` 生成的**，不要手工改。
//    它从 `ui/app.js` 走依赖图，把整个模块图都收进来。
//    原来这份清单是手工维护的，只列了 11 个、漏了 35 个模块 ——
//    后果是断网后**白屏**（外壳在缓存里，模块加载失败）。
//    改完代码跑 `node tools/gen-precache.mjs --write` 同步；
//    测试 `tools/precache.test.mjs` 会在漂移时报错。
//
// ⚠️ 改 SHELL 之后**必须同时改 CACHE 版本号**，否则旧缓存不会失效。
//    v5：SHELL 多了 core/state-ops.js（4a 把状态操作层搬到了 core）
//    v6：SHELL 多了 adapter/api-local.js 与 adapter/idb.js（4b 的本地模式）
//    v7：又多了 adapter/local-mode.js（4b 的模式切换与播种）
//    v8→v9：多了 adapter/sync.js（4c 的同步；同步通道并进了 api.js，没有 peer.js）
//    v10：多了 adapter/native.js 与 core/notify-plan.js（原生壳的提醒注册）
//    v11：补上 core/holidays.js、lunar.js、lunar-terms.js（节日/农历）、
//         event-template.js（批量+母泡泡模板）、festival-art.js（节日背景图案）——
//         这些是**后来才进依赖图的**，而清单一直是旧生成物，谁都没重跑生成器。
//         症状极阴险：**联网时一切正常，只有断网才白屏**（外壳在缓存里、模块加载失败），
//         而"本地优先"承诺的恰恰是断网可用。
//         三个 core 模块是**第一次**进依赖图（以前只在测试里被 import）。
//         不升这个号的话，断网时那一页会加载失败（外壳在缓存里、模块不在）。
// ⚠️ 教训：新增/改名任何被 `ui/app.js` 依赖到的模块后，**必须重跑** `tools/gen-precache.mjs --write`
//    并同时升这里的版本号。只靠漂移测试不够 —— 它只在"清单里有、磁盘上没了"时报错，
//    "磁盘上有、清单里漏了"它看不见。
//         **联网时正常、断网才白屏**。
//         都 import 它 —— 不升号的话，断网点开设置页就是**整页白屏**。
//    v15：多了 core/activity-log.js（本地活动日记：记了什么、只喂摘要）与
//    v17：多了 core/bubble-draw-numbers.js（一颗泡泡"喂给 canvas 的全部数字"，
//         见 tools/bubble-finite.test.mjs）。它被 **ui/views/bubble.js** import ——
//         而气泡区就是**主界面**：不升号的话，断网启动时外壳在缓存里、这个模块不在，
//         表现是"一打开就是空白"（比"少一颗泡泡"严重得多），而本地优先承诺的正是断网可用。
//    v18：**清单没有变**，改的是内容 —— web/ui/editor.js 里"没设期限"的提醒预览
//         （不再把 null 换成 Infinity，见 tools/bubble-band-unset.test.mjs 文件头），
//         以及 core/countdown.js、core/level.js、core/urgency.js 里的中性档 'unset'。
//         ⚠️ 这三样**全都在预缓存清单里**：不升号的话，已经装过 App 的设备会继续用
//         缓存里的旧 editor.js / 旧 core —— 表现是"改了但没生效，而且清缓存才好"，
//         正是这个版本号存在的意义（改内容也要升，不只加文件才升）。
//    v19：**清单仍然没变**，改的还是内容 —— 这次是 web/ui/editor.js 那个"自动提醒"小标签：
//         过期日程原来一直显示「马上到期」（那一行读的是 `notificationPlanForRemaining()` 根本不返回的
//         `info.ownOverdue` / `info.overdueInherited`，两个分支恒不生效），现在改读 `info.overdue`
//         → 自己过期显示「已过期」（见 tools/bubble-band-unset.test.mjs 第⑥组）。
//         editor.js 在预缓存清单里，不升号的话旧设备会继续显示错的文案。
//    v20：**清单变了（+2 个新模块）**，改的内容也很多 —— iOS 上"长按 2.5 秒无响应"那一轮：
//         · 新增 `web/ui/bubble-gesture.js`（手势状态机：长按计时从 rAF 搬到 setTimeout）
//           和 `web/ui/frame-guard.js`（帧回调护栏：异常不许掐断 rAF 续排）；
//         · `web/ui/views/bubble.js` 改成用它们（长按与渲染循环解耦 + 整帧兜底）；
//         · `web/css/views.css` 补 `touch-action: none` 的整条祖先链、
//           `-webkit-touch-callout`、以及长按提示条样式。
//         ⚠️ 这三样**全都在预缓存清单里**（bubble.js / views.css 本来就在，新模块是这次加的）：
//         不升号的话，已经装过 App 的 iPad 会继续用**旧 bubble.js** ——
//         也就是"改了但长按还是不灵，清缓存才好"，正是这个版本号存在的意义。
//    v21：**清单变了（+1 个新模块）**，而且改的是一处**从 v17 起就坏掉**的东西：
//         · 【真凶】`core/bubble-draw-numbers.js` 给那份"喂给 canvas 的数字"起的名字是
//           `holdProgress`，而 `web/ui/views/bubble.js` 里画进度环时读的是 `v.hold` ——
//           `undefined > 0.001` 恒为 false，于是**长按那圈红环从 v17 起一次都没画出来过**。
//           这是"长按 2.5 秒没有任何反馈"的真正原因（跨设备、跨平台都一样）。
//           修的是消费方那一行（`v.holdProgress`），并加了"字段名对账"的机械化断言
//           （tools/bubble-longpress-hooks.test.mjs）：以后谁再改名/写错名字，套件立刻红。
//         · 新增 `web/ui/bubble-diag.js`（手势诊断角标：把 pointer/touch 的原始事件计数、
//           最后一次取消的**原因**、以及版本标记写进屏幕 —— 平板上没有控制台，
//           这是"哪一环断了"唯一能让用户念出来的东西）。默认关闭，`?diag=1` 或 ? 面板里开。
//         · `web/ui/bubble-gesture.js` 加了 **touch 兜底通道**（pointer 一条都不来时顶上），
//           两条通道用"通道锁"去重（同一次触摸不会被处理两遍 → 不会被误判成多指而自杀）。
//         · `web/ui/views/bubble.js` 把 touch 四条监听接上、角标接上、「?」面板加"版本"一行。
//         · `web/css/views.css` 加 `.bubble-diag`（`pointer-events: none`：诊断器绝不抢手势）。
//         ⚠️ 上面这些**全都在预缓存清单里**（bubble-gesture.js / bubble.js / views.css 本来就在）：
//         不升号的话，已经装过 PWA 的设备会继续用**旧 bubble.js** —— 症状还是"没有环"。
//    v22：**清单变了（+2 个新模块）**，改的是"简约版"（0.11.0）这一整块：
//         · 新增 `core/presets.js`（三档预设的**唯一真源**：每档把哪些真实开关设成什么、
//           `applyPreset` / `describePresetDiff` / 首次引导两个答案的映射）与
//           `web/ui/presets-ui.js`（设置页最上面那三个按钮 + 应用前的差异预览 +
//           首次引导那张**不挡路**的横条）。
//         · `core/defaults.js` 新登记了 `preset` / `setupDone` / `bubbleView`
//           （⚠️ 不登记的话 mergeDefaults 补不上，正是 courseDigest 炸过的那条坑）。
//         · `web/ui/views/settings.js` 顶部插入预设块；
//           `web/ui/app.js` 的 `renderBanners()` 里接上首次引导卡片；
//           `web/ui/views/bubble.js` 把 `FESTIVAL_DAYS_KEY` 导出（引导页第二问要用它）。
//         ⚠️ 这几样**全都在预缓存清单里**：不升号的话，已经装过 PWA 的设备会继续用
//         **旧 app.js / 旧 settings.js** —— 表现是"设置页最上面根本没有那三个按钮"，
//         而且**引导卡片永远不出现**（用户会以为这个功能没做）。
//
//        校园网/手机热点（100.64.0.0/10）默认**不认**，被拦时共享块里会直接说明
//        原因与下一步；同时修掉了"共享地址端口拼两次"（`http://…:7091:7091`）
//        和电脑端自检一点就报 `stepNode is not defined` 的崩溃。
//        不升号的话装过 PWA 的设备会继续用旧的那两块界面 ——
//        表现是"设置页里根本没有那个开关"，刷新多少次都不出现。
//
// v25 → v26：新增「闹钟」板块（web/ui/views/alarms.js、web/adapter/alarms.js、
//        core/alarms.js），并且**改了 web/ui/app.js 与 adapter/store.js**。
//        ⚠️ 必须升号的理由同上：装过 PWA 的设备会继续用**旧的 app.js** ——
//        而旧 app.js 里根本没有闹钟这个视图，表现就是"侧栏里没有闹钟"
//        （在 iOS 壳里也一样：壳加载的是同一份 web/ 资源）。
// v26 → v27（2026-09-30）：修「晨钟」试听响错音 —— `core/alarms.js` 里"晨钟"的
//        `preview` 写的是 `chime`，而 `web/ui/views/alarms.js` 的合成音型表**没有这个键**
//        → 运行时静默落到兜底 `triple` → 用户选「晨钟」点试听、听到的是「轻快三连」。
//        本次把值改成 `morning`、把音型表提成模块级导出的 `SOUND_PATTERNS`、
//        并让"认不出来"时**弹提示而不是静默放别的音**；另加了一条断言
//        （docs/IOS-NATIVE.md §八·五 的两个体检脚本也是这一轮收编的）。
//        ⚠️ 必须升号的理由同 v25/v26：`core/alarms.js` 与 `web/ui/views/alarms.js`
//        **都在 SHELL 里** —— 不升号，装过旧包/旧 PWA 的设备会继续用**旧的 alarms.js**，
//        表现就是"试听还是响错音"，而重新打包也救不了（壳加载的是缓存里那份）。
// v27 → v28（2026-09-30 晚）：闹钟板块加「上一次操作走到哪一步」的诊断行 ——
//        真机上按「开始倒计时」/「10 秒后试响」**没反应、库也不进一条**时，
//        原来那六行诊断**分不出**是①没落库 ②没通知壳 ③壳没排上（三段都可能静默失败）。
//        现在每次操作都把这三步的结果记进内存并画在诊断区（`lastTimerAttempt()`）。
//        顺带把「试响」也改走同一条流程（原来它只弹个 toast，什么都没记）。
//        ⚠️ 升号理由同前：`web/ui/views/alarms.js` 在 SHELL 里。
// v28 → v29（2026-09-30 晚，随 0.12.0 出）：再加**一条真机排查的关键读数** ——
//        诊断区「上次排程」：读壳回报的 `lastSchedule` / `lastScheduleError`
//        （壳侧 `AlarmClockScheduler.noteSchedule()` 记下每次 `schedule()` 的结果，
//        由 `App.swift` 的 `reportAlarmClock` 带回来）。
//        **这是"压根没排上"与"排上了但不响"的唯一分界**，而两者修法相反 ——
//        没有它，用户只能说"不响"，我们只能猜。
//        ⚠️ 同批还改了 `web/adapter/alarms.js`（接住并校验这两个字段，
//        缺字段/脏值一律当"不知道"，**绝不默认成成功**）。
// v29 → v30（2026-10-01 凌晨）：闹钟授权的**失败文案**改了 ——
//        壳侧发现 `AlarmClockScheduler` 的 `authorized` 缓存**从来没被刷新过**
//        （`App.swift` 只调了 `AlarmKitScheduler.shared.refresh()`，没调它），
//        于是 `startTimer` / `replaceAll` 的 `guard authorized` **每次都挡掉**，
//        闹钟从来没被交给系统；而同一屏的「闹钟权限：已授权」读的是另一个实例的真实状态
//        → 用户看到的是一对**自相矛盾的读数**。
//        修法是"排程前现读系统状态 + 需要时现场申请"，并把原因写清
//        （"系统没给闹钟权限（弹窗里没允许，或被家长控制/描述文件挡住）"）。
//        ⚠️ 升号理由：诊断区的文案在 `web/ui/views/alarms.js` 里，它在 SHELL 里。
// v30 → v31（2026-10-01 凌晨）：修**启动时必现**的 `ReferenceError` ——
//        `web/ui/app.js` 在启动流程里调用 `refreshAlarmStatus()`（L851/L852），
//        但它的 import 清单里**没有这个名字** → 真机上顶部弹"启动失败：
//        Can't find variable: refreshAlarmStatus"，**后面的初始化全没跑完**。
//        （2026-09-30 用户在 iPad 上装 0.12.0 后报的。）
//        修法：补上导入；并新增一条**机械化断言** ——
//        "app.js 调用的每个壳桥函数都必须真的从 native.js 导入"
//        （`tools/alarms-view.test.mjs`，做过两次变异验证：去掉任一导入都会报红）。
//        ⚠️ 升号理由：`web/ui/app.js` **在 SHELL 里** —— 不升号，装过旧包的设备会继续用
//        **旧的 app.js**，表现就是"启动还是失败"，重新打包也救不了。
// v31 → v32（2026-10-01 凌晨）：修**点「⏱ 10 秒后试响」必报错**的 bug ——
//        我做"上一次操作"那次重构时，把 `testSound(s)` 写成了 `testSound(s, Ctx)`，
//        而 `blockSounds()` 那个作用域里**没有 `Ctx` 这个变量** →
//        用户一点就弹「App 出了个错 — Can't find variable: Ctx」。
//        修法：`blockSounds(ctx)` 显式接收并转交 `ctx`。
//        ⚠️ 为什么之前的测试没抓到：所有既有断言都是"读源码 + 查字符串"，
//        **从来没有真的触发过那个 onclick**（字符串里写着 `testSound(s, ctx)` 也能过）。
//        本次新增一条"**真的按一次试响按钮**"的断言 —— 触发 click 回调、
//        断言同步阶段不抛错、且真的往壳发了 `alarmTimer`；
//        并做过变异验证（把 ctx 改回 Ctx → 断言报红，报的正是 `Ctx is not defined`）。
//        ⚠️ 升号理由：`web/ui/views/alarms.js` 在 SHELL 里。
// v32 → v33（2026-10-01 凌晨）：**没有改产品代码**，只是把"闹钟板块每个按钮都真按一遍"
//        做成了系统性断言（`tools/alarms-view.test.mjs`）。
//        为什么要为一条测试升缓存版本号：这条断言改变了"通过"的含义 ——
//        它要求**每个可点元素真的被触发过**、同步不抛、异步无未处理拒绝、refresh 入口不抛。
//        有了它之后，`v30/v31/v32` 那种"点一下就弹 App 出了个错"的 bug 不可能再溜过去
//        （已做变异验证：给预设按钮注入未定义变量 → 断言报红并点名 1/3/5/10/30 分钟五个按钮）。
//        ⚠️ 同批也顺手把 v32 的 `Ctx` 修复**确认在包内**（`testSound(s, ctx)` 命中、`Ctx` 0 命中）。
// v33 → v34（2026-10-01 上午）：**试听改成直接播 App 包里那个真文件**（方案 A 的正解）。
//        过去"试听"是网页合成的**近似音**，和真铃声是**两套各自写死的参数** ——
//        用户装上真铃声后**第一耳朵就发现**"和下面的试听完全不一样"。
//        根因之一：**壳的 MIME 表没有音频类型**，静态文件回落 `application/octet-stream`，
//        而浏览器不肯把 octet-stream 当音频播 → 当年因此误判成"网页取不到 App 里的文件"。
//        现在：`LocalServer.mimeType` 补上 caf/wav/m4a/mp3/aiff；
//        `playRealSoundFile()` 用 `new Audio('/<file>.caf')` 播真文件
//        （那些文件就在 **bundle 根**、和 `index.html` 同级），播不了才回落
//        `playSynthPreview()` 并**如实弹提示**说明"这是示意"。
//        ⚠️ 升号理由：`core/alarms.js` 与 `web/ui/views/alarms.js` 都在 SHELL 里。
//        ⚠️ 本版还带一个**临时条目**（用户自己的音频，仅本地测试包）——
//        出包后必须撤掉，见 `core/alarms.js` 里 `id: 'custom'` 那段注释。
// v35 → v36（2026-10-01 下午）：同一功能的**收尾清理**（复查时发现并删掉了"死数据"）。
//        · **删掉 `settings.alarms.customSound`** —— 它被写入却**从没被读取**过。
//          铃声的"有没有"以**容器里那个文件**为唯一判据（壳每次 `soundStatus` 报上来），
//          "谁在用它"记在**每条闹钟自己的 `sound` 字段**里。再存一份只会多一个
//          "和实际不一致"的机会 —— 这个项目已经栽过好几次同类。
//        · 新增**用户看得懂的警示**：某条闹钟选了「自定义」但文件已经不在了时，
//          列表那行会显示「⚠️ 那个自定义音频不在了，会响默认音」。
//          不说的话 iOS 找不到文件**不报错**、只是响默认音，用户无从察觉。
//        · `soundStatus` 名单**真的变了**才重排闹钟（以前每次 status 都重排，白折腾）。
//        原来第一屏是「AI 功能开关 + 本地活动日记 + 隐私说明」—— 而功能**默认全关**，
//        所以新用户看到的是一屏设置、**看不到这一页能给他什么**（会以为功能还没做）。
//        现在开头先放一块**引导区**：
//          · 一句话说清"能给你什么"（今日简报 / 周复盘 / 问助手）；
//          · 明说 **不配 AI 也能用**（走离线模板）—— 不然用户会以为必须先搞一个 Key；
//          · 给一个**当场能按的按钮**（生成今日简报 / 周复盘）；两个都没开时给"先打开一个 ↓"，
//            点了会滚到开关区并提示（而不是让用户自己去找）。
//        区块顺序也从「开关 → 日记 → 卡片 → 问 → 说明」改成
//        「引导 → 卡片 → 问助手 → 开关 → 日记 → 到点行 → 说明」：**内容在前，设置在后**。
//        顺手：删掉 5 个真死导入，并新增 JS 侧机械预检 `tools/js-preflight.mjs`
//        —— 它当天就抓出一个真 bug：`settings.js` 调了一个不存在的
//        `pushShellNotifications()`，导致「用回默认」按钮后面两行根本不执行。
//        用户明确放弃了"自动发送"（微信没有可靠通道），改成"到点提醒你、并把文案给你"。
//          `{festival, contacts:[…]}`（一个节日一条）**拆成每人一条**，
//          因为原形状做通知就是用户最讨厌的"一次提醒一大串人"。
//        · core：它复用 `taskKey()` 生成 key —— **必须和通讯录页那张草稿卡片同源**，
//          否则点通知会"跳过去但定位不到人"（静默失败）。
//          （`(year-4)%12`，用户要的"结合生肖"）；热点**故意不做**（那要联网抓取，
//          不能让模型自己想象今年有什么热点 —— 会编假事件）。
//        · core：`createReminderEngine` 新增 `markFired()` —— 外部投递的 key 必须走它记账，
//          自己写 localStorage 会被引擎的内存快照盖掉（祝福会重复弹）。
//          （所以网页/iOS 壳/安卓三端自动都有系统通知）；通知正文**直接带文案**（离线档，
//          不配 AI 也能用）；同一节日的多条**按 2 分钟错开**，不连弹。
//        · web：点通知 → 切到通讯录页、滚到那张草稿卡并**短暂高亮**（`.draft-flash`）。
//
// v38 → v39（2026-10-01 夜）：**祝福提醒合并成一条** + **B 站热点**。
//        ⚠️ 用户当场纠正了 v38 的做法：原话"**这个祝福提醒还是一次就够了吧，弹多了烦**"。
//        v38 是"每人一条"（8 个好友 = 8 条通知），现在改成**一个节日一条**：
//        正文点名列出发给谁，点进去到通讯录页逐条处理。
//        （竞品 Birday 就是这个做法；我上一版还在文档里写了"故意反着做"，那是我想错了。）
//        同步删除 `staggerMinutes`（合并之后不需要错开）。
//          解析/拼装/缓存在 core（纯逻辑、可单测）；新增 AI 功能开关 `hotTopics`（默认关）。
//          ⚠️ 关着/抓不到时 prompt **与接入前逐字节相同**（有条断言钉着）。
//          ⚠️ 热点是"大家最近在看什么"，**不是新闻** —— prompt 里明确写了这一点，
//          并要求"不相关就完全不提、不许照抄"，免得模型把视频标题当事实陈述。
//
// v39 → v40（2026-10-01 深夜）：用户点头的两件 + 一个测试缺陷。
//        · **`.aac` 能导入了**（用户上次报的那个）：新增 `importAudioWithFallback()` ——
//          先走同步的 `AVAudioFile`（常见格式几十毫秒），**失败才用 `AVAssetExportSession`
//          转成 m4a 再读**。中间那段曲折值得记：先猜 `CMTimeMinimum`、又猜别的，两次
//          CI 都在 `AVAssetTrack has no member 'naturalTimeRange'` 失败
//          （那是 `AVAsset` 的成员）—— 而当时我以为"失败拿不到日志"，于是盲改。
//          ⚠️ 真相：失败构建也上传 artifacts（见 `tools/build-log.mjs`）。
//          ⚠️ 另修一处**只有真编译器能抓**的错：`documentPicker` 是同步回调，
//          里面直接写 `await` 会编译不过 → 包进 `Task {}`，并加了预检断言。
//        · 修了一个**测试自身的缺陷**：`contacts-view` 有三条用例用
//          `up[0].daysLeft` 当 `leadDays`，而 `leadDays` 的**上限被钳到 7 天** ——
//          于是"最近节日还有 8 天以上"时它们必然红（实测 2026-10-02 红、
//          把时钟拨到 2026-10-12 就 23/23 全绿）。**与产品代码无关**，
//          已给那三条装假时钟（`freezeClock`）。
//
// v40 → v41（2026-10-02 凌晨）：**第二批五个内置闹钟铃声**。
//        用户要求"同时加的几个必须各有特色，不能没有专攻" —— 所以每个占一个空位：
//          心跳（低频脉冲，能持续 11 秒）· 欧式警笛（两音硬交替）· 风铃（五声上行+泛音）
//          渐急滴（唯一节奏会变的：越敲越急）· 晨曦（低音床+高音缓升）
//        ⚠️ **全部由 `tools/gen-alarm-sounds.mjs` 代码合成**（零依赖、零版权），
//        包体 1.42 MB → 4.01 MB。
//        ⚠️ 新增两条护栏（`tools/alarm-sounds.test.mjs`），因为"听起来有没有专攻"
//        靠人眼守不住：① **从音频算四条声学特征**（时长/亮度/节奏密度/能量重心），
//        两两不许全接近；② 每个 `desc` 必须 ≥16 字说清"谁该选它"
//        （旧的四条描述也补长了 —— 护栏不该为旧数据让路）。
//        ⚠️ 加新铃声时**必须同步改** `codemagic.yaml` 与 `.github/workflows/ios.yml`
//        的 `for w in ...` 断言清单，漏一个 `tools/ios-bundle-check.mjs` 就让构建失败。
// v41 → v42（2026-10-02 凌晨）：**自定义铃声从"一个格子"变成"一串列表"**。
//        用户原话 (m01310)："用户应该拥有一个自定义列表，一个自定义有时候可能不够用"，
//        三个选项里选了最小的那个 (m01328)："**选2吧**"（多首共存 + 每个闹钟能挑哪一首）。
//        旧设计是"一个档位一个槽"：文件名带 `-t<tier>-`，导入时把同档上一次那个删掉 ——
//        用户导入第二首，第一首就没了（他看到的那条橙色警告"那个自定义音频不在了"就是这么来的）。
//        现在：每首各自一个文件、各自一个 id（`timetable-custom-<8位十六进制>.caf`，
//        `newToken()` 会先查一遍撞名），导入**不再删任何东西**；
//        闹钟的 `sound` 存 `custom:<token>`，壳回报**全量清单** `sounds: [{id,name,file}]`。
//        ⚠️ 界面上"这条闹钟用的那首不在这台设备上"是个**正常状态**（音频文件不跟着设置同步）：
//        必须明说"会响默认音"并**禁用保存**，绝不许静默换一首 —— 那才是"设了铃声却听到系统音"。
//        ⚠️ 同时修掉一个真 bug：试听拼 URL 时给**已经带 `.caf`** 的容器文件名又加了 `.caf`，
//        拼成 `/timetable-custom-….caf.caf` → 必然 404 → 静默回落合成音
//        （用户"试听自己那首歌"听到的其实是假的）。现在走 `/__sounds/<名字>`。
// v42 → v43（2026-10-02 中午）：**用户装了 v42 之后报的三件事**（原话 m02630）：
//        「导入了三个音频但是为啥有好几个列表，同时列表名我需要可以自己改，同时这是什么错误」。
//        ① 「导入 3 首怎么有 5 条」= **失败的导入留下了 0 帧的残骸文件**：旧代码
//           `token`/最终文件名在任何读取之前就定下、直接往 `Library/Sounds` 里写，
//           于是"格式转换不支持"这类失败也留下一个**名字完全合法、打开却没声音**的 caf，
//           而"本机有哪几首"是按名字形状过滤的 → 每条残骸都冒充一首真铃声。
//           修法两头堵：导入改**原子**写（先写 `.incoming-<uuid>.caf`，成功才 `moveItem`
//           成最终名，失败 `defer` 删掉）+ `sounds()` 前先 `isPlayable()` 自愈，
//           把已经躺着的空文件认出来删掉。
//        ② **自定义铃声可以改名了**：名字存在 `settings.customSoundNames`
//           （键是壳给的 8 位十六进制 token）——**是用户数据，跟着数据同步**，
//           不像音频文件那样只留在导入它的那台设备上。改名必须用项目自己的 `openModal`：
//           `window.prompt()` 在 WKWebView 里**静默返回 null**（电脑上正常、iPad 上"点了没反应"）。
//        ③ 「-50」是什么错：`AVAudioFile.read(into:)` **只转格式、不转采样率/声道数** ——
//           把 48kHz 立体声读进 44.1kHz 单声道 buffer 就抛 `paramErr -50`（用户那两个
//           飞鼠转的 MP3 正好都是 48kHz 立体声）。现在目标格式**先试 44.1kHz 单声道、
//           失败再照源文件的采样率/声道数重来一次**（`targets` / `native`），
//           并且诊断里带**采样率/声道数与文件后缀体积**，失败时明说
//           "这是我们 App 的问题，不是你的文件"（以前一律说成"你的文件解不出来"）。
//        ⚠️ 同一个 -50 还有第二个来源：兜底解码 `decodeWithAssetReader` 写出的 buffer 是
//           `interleaved: true`，而 `writePCMToCaf` 建临时文件时写死 `interleaved: false`
//           → 整条兜底路**永远** -50。现在两处都照抄 buffer 自己的交错位。
// v43 → v44（2026-10-02 傍晚）：**清单没有变，改的是内容**。
//           那份"程序自述 + 版本史"是从 `docs/CHANGELOG.md` 与 `docs/WHY.md` **生成**的常量，
//           而它在预缓存清单里 → **不升号的话，装过 App 的设备会一直拿着旧的那份自述**。
//        ② ⚠️ **把上面 v43 第 ③ 条作废（`-50` 的归因是错的）**：真根因不是采样率/声道数
//           —— 用户真机上「源 44100Hz/2声道 → 目标 44100Hz/2声道」**照样** -50。
//           真根因是 `AVAudioFile.read(into:frameCount:)` 要求 buffer 的格式**逐项等于**
//           `processingFormat`（Apple 原文与推导见 `docs/IOS-NATIVE.md` 的"铃声"节）：
//           修法是**打开时就声明格式**（`init(forReading:commonFormat:interleaved:)`）、
//           buffer 用 `AVAudioPCMBuffer(pcmFormat: fmt, …)` 照抄它，采样率/声道数**保持源自己的、不重采样**。
//           留着那段错解释只为记账，**别再照着它理解代码**（它害我在错误方向上改了两轮）。
//        ③ ⚠️ 同样作废的还有 v43 第 ① 条里"认出来删掉"四个字：现在 `isPlayable` 只做
//           **改名隔离**（`.unplayable-<原名>`，不匹配 `namePrefix` 形状所以不会再进列表，但**字节还在**）。
//           理由是底线：**护栏可以少做事，不可以毁数据** —— 上一版导进过的 3 首在装新包后不见了，
//           是"重装换了容器"还是"自愈误删"当时分不清，那就宁可不动它。
// v44 → v45（2026-10-02 夜）：**闹钟页多了一块「全部闹钟」**（用户 m03912
//         「我需要一个显示已创建闹钟的地方，同时我要可删改」）。
//         ① `web/ui/views/alarms.js` 变了：每一条闹钟（**含已经跑完的计时器**）都画出来，
//            每条自带「✏️ 改 / 开·关 / 删」；计时器那段不再单独画一份列表
//            （以前两处各切一份，"跑完的"那份没人画 → 数得进去、看不见、删不掉）。
//         ② ⚠️ **同一份改动也作废了旧标题那句话**："共 N 条，开着 M 条"里的"开着"是拿
//            `enabled` 数的，而跑完的计时器 `enabled` 仍然是 true —— 那个数字**永远是假的**。
//            现在计数走 `core/alarms.js` 的 `describeAlarmCount()`（按**状态**数：
//            会响的 / 跑着的 / 暂停的 / 已结束或被关掉的），和列表用的是**同一份算法**。
//         ③ 清理按钮只碰**计时器**（`staleTimers()` 里 `kind === 'timer'` 那道判断）：
//            定时器是用户排的班，一条都不许替他删 —— 这条边界由 `tools/alarms.test.mjs` 钉着。
// v45 → v46（2026-10-02 夜）：**拆掉闹钟上那个「稍后 5 分钟」按钮 + 学会"对账"**
//        （用户 m04519：「有时会莫名其妙地冒出闹钟」，他自己观察到的规律是"跟点过
//         「10 秒后试响」有关"；还给了一条反例线索：试听点过的都没事）。
//        ① ⚠️ **根因之一**：AlarmKit 的 `secondaryButtonBehavior: .countdown` 按 Apple
//           官方样例原文**就是系统的 Repeat 动作**（"re-triggers the alarm after a
//           certain TimeInterval, as specified in `Alarm.CountdownDuration.postAlert`"），
//           而我们**从来没传过 `countdownDuration`** ⇒ 一个"间隔由系统默认决定、我们从没
//           定义过"的"再响一次"挂在**每一条**闹钟上（包括 10 秒试响）。按钮上那句
//           「稍后 5 分钟」也是我们自己编的（样例用的是系统给的 `.repeatButton`）。
//           现在**只留「知道了」**（两个字段都传 nil = 官方样例里 `.none` 那条路）。
//        ② ⚠️ **根因之二（"撤不掉"）**：`scheduledIDs` / `idMap` 只在内存里，App 一重启
//           （重装、升级、被系统回收）就空了 ⇒ 上一次进程排给系统守护进程的闹钟
//           **谁都撤不掉**：在界面上删它、关它、重排一次，全都不动它，它到点自己冒出来。
//           现在每次整批重排之后都拿 `manager.alarms`（官方文档：守护进程里属于本 App 的
//           **全部**闹钟）对账，清掉"不属于这一轮计划、且**没在响**"的遗留闹钟 ——
//           正在响的一律不碰（不能把正在叫醒用户的闹钟按掉）。
//        ③ 试响**自己收尾**：网页在 `alarmTimer` 上明说 `test: true`，壳在"该响的时刻
//           +45 秒"后把那条从系统里撤掉。真正的倒计时不带这个字段，**绝不受影响**。
//        ④ `web/ui/views/alarms.js` 多了一块**落盘的**「最近几次开始倒计时 / 试响」
//           （localStorage 键 `timetable.alarms.attempts`，最近 8 条，显示在诊断区）。
//           起因是这次唯一说不清的问题 ——「改名之后到底有没有再点过一次试响」——
//           而内存里那份（`lastAttempt`）页面一刷新就没了，指望不上。
//        ⑤ ⚠️ **本版仍未证实**的那一点：用户说第二次冒出来的提醒标题是**改名后**的名字。
//           可能是"改名后又点过一次试响"，也可能他说的是 App 里那一行（那一行的铃声名
//           是渲染时现算的，改名立刻生效）。诊断区那块落盘记录就是为了下次一次问清。
// v46 → v47（2026-10-03 上午）：**把仓库自带的本地 3B 接成"一键可用"**（`待办.md` 第 4 条）
//        ① 起因：`build/local-ai/` 里那套 llama.cpp + Qwen2.5-3B 本来就跑得动（显卡上
//           91–94 t/s），但启动命令**没传 `--alias`** ⇒ `/v1/models` 把**模型文件的完整
//           Windows 路径**当模型名报回来（`…\qwen2.5-3b-instruct-q4_k_m.gguf`）：
//           用户得把一整条本机路径填进设置，而且它会随请求发出去。现在 `serve.ps1` 与两个
//           `START-LLAMA-*.cmd` 都带 `--alias qwen2.5-3b`，报回来就是干净名字。
//           8087** 再落回本机那条 Ollama 兜底；另加 `isLocalUrl()` —— 判"是不是本机"必须看
//           **地址形状**。旧代码保存时拿 `baseUrl === LOCAL_MODEL_URL`（只认 Ollama 那个
//           常量）判，于是"地址填对 8087、模型名填对、Key 也留空"还是被判成云端接口，
//           最后甩给用户一句"还没配置 AI"。
//        ③ 「💻 用电脑上的本地模型」现在**两个端口都问一遍**（8087 先、11434 后），谁应答
//           就用谁；两个都没应答时明说"两个端口都没有应答"并告诉他双击哪个启动器
//           （地址仍填 8087 —— 他下一步就是去起它）。
//        ④ ⚠️ 真跑抓出来一个真 bug：`server/ai.js` 的连接阶段上限是 3 秒，而本地模型
//           **非流式**必须算完整个回答才回响应头，第一次问要现算图 —— 本机实测
//           **5394ms**（第二次 135ms）。于是"第一问必死"，报错还是
//           「AI 接口 20 秒没回应」（拿总时长那个数字报连接超时）。现在本机配置用
//           `LOCAL_CONNECT_TIMEOUT_MS = 15000`、云端仍是 3s，报错**说清是哪一段**。
//        ⑤ 本版**不重新出包**（web 改动先跟在壳里，等用户报幽灵闹钟的结果时一起打包）。
// v47 → v48（2026-10-07 夜）：**安卓端也能用闹钟了**（用户原话「闹钟的话随便整整就行，
//        能自定义能删除增加能响就行·-·」；同轮还有一件不碰 web 的事：导出"大众精简版"）。
//        ① 以前闹钟板块**只在 iOS 壳里出现**（`alarmsViewAllowed()` 只认 `shellKind() === 'ios'`，
//           理由写的是"用户明确要求：安卓与电脑先不动"）。这次只放宽这一处。
//        ② ⚠️ **没有**去改 `shellKind()` / `inShell()` 的语义，这是本版最容易踩的坑：
//           安卓壳**没有 JS 桥**（只有 `LocalServer.kt` 的 HTTP 路由），`inShell()` 一旦在
//           安卓上变成 true，`web/adapter/local-mode.js` 就会把模式切成 local —— 数据写进
//           WebView 的 IndexedDB，壳自己的 Store 收不到，"改了日程但壳不知道"。
//        ③ 判"这是安卓"用**新加的** `platformKind()`（`web/adapter/native.js`）：壳在静态资源
//           里注入 `<script>window.__timetablePlatform='android';</script>`，认这个标记。
//        ④ 安卓这条路的形状和 iOS **完全不同**：网页只负责 `POST /api/alarms` 落进壳的
//           Store（`Store.kt` 顶层新增 `alarms` + 增删改，并把它纳入 `nextAlarmAt()`），
//           **由壳自己**用 `AlarmManager` 排下一次唤醒（`ReminderAlarms.kt` 本来就有
//           `setExactAndAllowWhileIdle` + 唤醒锁 + 开机重建）；到点响的是按 sound uri
//           建出来的通知渠道（`AndroidNotifier.kt`）。所以安卓上 `postToShell` 与
//           `sent` 恒为 false 是**预期**，不是失败。
//        ⑤ 「试响 / 倒计时」在安卓上仍然用不了（那两条是发给 iOS 壳的消息）—— 页面按平台
//           分档说明，**不再照抄**"真闹钟是 iOS 26 才开放的能力"那几句（在安卓上那是错的），
//           也不会把它标成错误。
// v48 → v49（2026-10-07 深夜）：**修掉设置页「关于」里写死的版本号**。
//        ① 那一栏一直写着 `'v0.3.0（手机可用版）'`（一路错到 0.12.0；安卓包里也是这一份）。
//           改成：有服务端就用 `/api/health` 的 `version`（`server/api.js` 从 package.json 读，
//           安卓壳的 `LocalServer.kt` 也回 `version`），本机独立模式才用新加的
//           `core/defaults.js` 的 `APP_VERSION`。
//        ② `tools/defaults.test.mjs` 加了一条**防漂移**断言：`APP_VERSION` 必须等于
//           package.json 的 `version` —— 以后发版忘了改这里就会红。
//        ③ 只有 `core/defaults.js` / `web/ui/views/settings.js` 两个文件变了，逻辑一处没动。
//        起因：v49 那轮往 `docs/CHANGELOG.md` 追加了一节，忘了跑
//        （摘要就是从那两份文档生成的常量）。重新生成后本文件在预缓存清单里，所以升版本号。
//        ⚠️ 摘要现在 **2494/2500 字**，已经贴着上限 —— 下次再改 `docs/CHANGELOG.md`
//        大概率会把老条目挤掉（截断），要么提高 `AI_DIGEST_LIMIT`，要么先精简 `docs/WHY.md`。
// v50 → v51（2026-10-08）：**修掉二维码「格式信息」行列写反**（`core/qrcode.js`）。
//        ① 症状：应用里「手机扫码打开电脑这一份」生成的二维码，真手机与 OpenCV **一个都扫不出来**；
//           根因是 `placeFormat()` / `readFormat()` 把 nayuki 参考实现的 `setFunctionModule(x, y)`
//           （x 是**列**）当成了 `m[row][col]` ⇒ 行列对调（两份副本都写反）。
//        ② 为什么四周测试全绿：自检解码器 `decodeQrMatrix()` 与编码器**共享同一处假设** ⇒
//           "编码→解码"往返自检必然成立。现在把**外部参照**（Python `qrcode` 库生成的矩阵，
//           `tools/fixtures/qr-reference.json`）钉进 `tools/qrcode.test.mjs`，并给 `makeQrMatrix`
//           加了 `mask` 逃生口（要跟别的实现逐格对表就得先钉死掩码）。
//        ③ 同时 `core/defaults.js` 的 `APP_VERSION` 升到 0.12.1（发版一起改，见那里的注释）。
const CACHE = 'timetable-shell-v51';
const SHELL = [
  '/adapter/alarms.js',
  '/adapter/api-local.js',
  '/adapter/api.js',
  '/adapter/idb.js',
  '/adapter/local-mode.js',
  '/adapter/native.js',
  '/adapter/outbox.js',
  '/adapter/reminder.js',
  '/adapter/store.js',
  '/adapter/sync.js',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/icon.svg',
  '/core/activity-log.js',
  '/core/alarms.js',
  '/core/bubble-draw-numbers.js',
  '/core/bubble-select.js',
  '/core/countdown.js',
  '/core/course-digest.js',
  '/core/defaults.js',
  '/core/event-template.js',
  '/core/festival-art.js',
  '/core/holidays.js',
  '/core/import-adapter.js',
  '/core/level.js',
  '/core/lunar-terms.js',
  '/core/lunar.js',
  '/core/nl-parse.js',
  '/core/notify-plan.js',
  '/core/palette.js',
  '/core/presets.js',
  '/core/recurrence.js',
  '/core/recycle.js',
  '/core/reminder-plan.js',
  '/core/share-plan.js',
  '/core/state-ops.js',
  '/core/sync.js',
  '/core/time.js',
  '/core/urgency.js',
  '/core/voice-bridge.js',
  '/css/base.css',
  '/css/components.css',
  '/css/layout.css',
  '/css/views.css',
  '/index.html',
  '/join.html',
  '/manifest.webmanifest',
  '/sw.js',
  '/ui/app.js',
  '/ui/bubble-diag.js',
  '/ui/bubble-gesture.js',
  '/ui/custom-course.js',
  '/ui/dom.js',
  '/ui/editor.js',
  '/ui/frame-guard.js',
  '/ui/modal.js',
  '/ui/presets-ui.js',
  '/ui/textfit.js',
  '/ui/toast.js',
  '/ui/viewkit.js',
  '/ui/views/alarms.js',
  '/ui/views/bubble.js',
  '/ui/views/course.js',
  '/ui/views/help.js',
  '/ui/views/import.js',
  '/ui/views/list.js',
  '/ui/views/month.js',
  '/ui/views/recycle.js',
  '/ui/views/settings.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {}),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API 永不缓存：数据必须实时
  if (url.pathname.startsWith('/api/')) return;

  if (event.request.method !== 'GET') return;

  // 网络优先，失败回落缓存（离线也能打开界面）
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res && res.status === 200 && url.origin === location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match('/index.html'))),
  );
});

// ---- 预留：Web Push（需要服务器 + VAPID 密钥，联网后再启用）----
self.addEventListener('push', (event) => {
  let data = { title: '日程提醒', body: '你有一个日程即将开始' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch { /* ignore */ }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/assets/icon.svg',
    badge: '/assets/icon.svg',
    tag: data.tag,
    data: { eventId: data.eventId },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((list) => {
      const client = list[0];
      if (client) return client.focus();
      return self.clients.openWindow('/');
    }),
  );
});
