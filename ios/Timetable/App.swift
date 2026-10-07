// App 骨架：起本机服务 → 加载网页 → 接住网页发来的提醒计划。
//
// 整个壳子只有三件事，没有别的：
//   ① LocalServer：把打包进来的 web/ + core/ 通过固定的 http://127.0.0.1:17801 发出去
//      （为什么必须这样：见 LocalServer.swift 文件头 —— 一句话是"origin 决定存储"）
//   ② WKWebView：加载它，并注入一个 message handler 接网页的消息
//   ③ NotificationScheduler：把网页算好的提醒翻译成系统通知
//
// ⚠️ **这里不做任何业务逻辑**。气泡、编辑器、课表、提醒的判定，
//    全都是同一份 web/ + core/ 在 WebView 里跑 —— 和电脑端、PWA 端一模一样的代码。
//    这个壳子薄到"删掉它，网页在浏览器里照样能用"，这是故意的。

import SwiftUI
import WebKit
import UserNotifications

@main
struct TimetableApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        WindowGroup {
            ShellView()
                .ignoresSafeArea(.container, edges: .bottom)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// App 在前台时也让通知显示出来 —— 用户可能正开着日程表，
    /// 到点了却什么都不弹会显得"提醒坏了"。
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                               willPresent notification: UNNotification,
                               withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .list])
    }

    /// 用户在通知上做了动作（点通知本体，或点「完成 / 10 分钟后」）
    ///
    /// ⚠️ 分工要说清楚：
    ///   · 「10 分钟后」= **呈现层**的事（把刚响的这条原样再排一次）→ 壳自己做完
    ///   · 「完成」    = **业务**（要把这条日程标成做完）→ **回网页层**，壳不改数据
    ///     壳一旦自己改数据，就和网页端分叉了 —— 那是本项目一直在避免的。
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                               didReceive response: UNNotificationResponse,
                               withCompletionHandler completionHandler: @escaping () -> Void) {
        let content = response.notification.request.content
        let eventId = content.userInfo["eventId"] as? String

        switch response.actionIdentifier {
        case NotificationScheduler.actionDone:
            if let eventId { ShellBridge.shared.tellWeb(action: "done", eventId: eventId) }
        case NotificationScheduler.actionSnooze:
            NotificationScheduler.shared.snooze(content)
        default:
            // 点通知本体 / 「打开」→ 跳到那条日程
            if let eventId { ShellBridge.shared.openEvent(eventId) }
        }
        completionHandler()
    }
}

struct ShellView: View {
    var body: some View {
        WebShellView()
            .background(Color(.systemBackground))
            // 深链入口：快捷指令 / Siri 打开 timetable://add?text=…
            // ⚠️ 用 SwiftUI 的 onOpenURL 而不是 AppDelegate 的 application(_:open:options:)：
            //    scene 化的 App 里前者才是确定会被调到的那个。
            .onOpenURL { url in
                ShellBridge.shared.handleIncoming(url.absoluteString)
            }
    }
}

/// WKWebView 的 SwiftUI 包装 + 本机服务的生命周期
struct WebShellView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> ShellViewController { ShellViewController() }
    func updateUIViewController(_ uiViewController: ShellViewController, context: Context) {}
}

final class ShellViewController: UIViewController, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var server: LocalServer!

    override func viewDidLoad() {
        super.viewDidLoad()

        // ⚠️ 必须在**投递任何通知之前**注册分类，通知上才会出现那两个按钮。
        //    顺序反了不会报错，只是按钮不出现 —— 很难查。
        NotificationScheduler.shared.registerCategories()
        NotificationScheduler.shared.requestAuthorization { _ in }
        // 闹钟权限（AlarmKit，iOS 26+ 才有）：和通知权限一样在启动时申请一次。
        // 拿不到不报错 —— 最高档会自动退回普通通知（见 ShellBridge.scheduleAll）。
        if #available(iOS 26.0, *) {
            AlarmKitScheduler.shared.requestAuthorization { ok in
                NSLog("[ShellBridge] 启动时申请闹钟权限 → \(ok)")
            }
        }

        // ① 起本机服务。**固定端口**，起不来就说清楚，别白屏。
        let root = Bundle.main.bundleURL
        server = LocalServer(bundleRoot: root)
        do {
            try server.start()
        } catch {
            showFatal("本机服务起不来：\(error.localizedDescription)")
            return
        }

        // ② WebView + 消息通道
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        // ⚠️ 用 default() 而不是 nonPersistent()：
        //    非持久化的数据仓库会让 IndexedDB 在每次启动时**清空** ——
        //    而本应用的数据就存在那里（4b 的本地模式）。这一行是"数据在不在"的关键。
        config.websiteDataStore = .default()
        let controller = config.userContentController
        controller.add(self, name: "timetable")

        // 原生壳标记：网页据此知道"我在 App 里"，从而默认走本机独立模式
        // （见 web/adapter/native.js 的 shellKind / local-mode.js 的 savedMode）
        let boot = WKUserScript(source: "window.__timetableInShell = 'ios';",
                                injectionTime: .atDocumentStart, forMainFrameOnly: true)
        controller.addUserScript(boot)

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        // ⚠️⚠️ 下面两行是**给"按住气泡 2.5 秒戳破"这个手势让路**的，别删。
        //
        // 为什么必须有：WKWebView 内部那个 `scrollView`（WKScrollView）默认是
        //   · `delaysContentTouches = true` —— 按下之后先把这次触摸**扣住约 150ms**，
        //     等它判定"这是不是想滚动"；判定期间网页收到的 pointerdown / touchstart 被推迟；
        //   · `canCancelContentTouches = true` —— 一旦判定成滚动，就把这次触摸**取消**，
        //     网页侧表现为 `pointercancel` / `touchcancel`，**之后再也不会来 pointerup**。
        // 长按要按住 2.5 秒，整段都落在"被扣住 + 可能被取消"的窗口里：
        // 计时器要么根本没开始、要么中途被掐断 —— 用户看到的就是"长按完全没反应"。
        // 关掉这两条之后，触摸**立刻**原样交给网页；"要不要当成滚动"由网页自己用 CSS 的
        // `touch-action: none` 说了算（那条祖先链已经逐层写死在 web/css/views.css 里）。
        //
        // ⚠️ 为什么**不**顺手写 `isScrollEnabled = false`（虽然它看起来"更彻底"）：
        //    同一个 WKWebView 里还装着月历 / 列表 / 设置面板，那些页面**全靠滚动**才能用
        //    （见 web/css/layout.css 与 index.html 的同一份外壳）。一刀禁掉滚动 =
        //    为了修气泡区把别的页面弄坏，代价远大于收益。气泡区自己不需要滚动 ——
        //    它靠 CSS 的 `touch-action: none` 就已经不滚了。
        webView.scrollView.delaysContentTouches = false
        webView.scrollView.canCancelContentTouches = false
        // 给网页一个像样的外观（不要白边闪烁）
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        view.addSubview(webView)

        ShellBridge.shared.attach(webView: webView)

        // ③ 加载。必须在服务起来之后。
        webView.load(URLRequest(url: server.baseURL))
    }

    // 网页发来的消息
    func userContentController(_ userContentController: WKUserContentController,
                              didReceive message: WKScriptMessage) {
        ShellBridge.shared.handle(message.body)
    }

    private func showFatal(_ text: String) {
        let label = UILabel()
        label.numberOfLines = 0
        label.textAlignment = .center
        label.textColor = .secondaryLabel
        label.font = .preferredFont(forTextStyle: .body)
        label.text = text + "\n\n把 App 完全关掉再打开一次。若一直这样，说明这个包不完整。"
        label.frame = view.bounds
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(label)
    }

    deinit {
        server?.stop()
    }
}
/// 网页 ↔ 原生 的翻译层。协议见 docs/IOS-NATIVE.md。
final class ShellBridge {
    static let shared = ShellBridge()
    private weak var webView: WKWebView?

    /// 网页有没有发过 ready —— 决定深链是"立刻送"还是"先排队"。
    private var pageReady = false
    /// 排队的深链。
    ///
    /// ⚠️⚠️ 为什么要排队（这是冷启动必踩的坑）：
    ///   快捷指令打开 App 时，App 是**冷启动**的 —— onOpenURL 在 WebView 还没加载完
    ///   就触发了。这时 evaluateJavaScript 送过去，网页侧的
    ///   `window.__timetableNative` **还没定义**，那条 JS 会被静默丢掉，
    ///   用户看到的现象是"点了快捷指令，App 开了，但什么都没加"。
    ///   所以：没 ready 就先存着，等网页报 ready 再补送。
    private var pendingLinks: [String] = []

    func attach(webView: WKWebView) { self.webView = webView }

    /// 收到网页的消息
    func handle(_ body: Any) {
        guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return }
        switch type {
        case "notifications":
            let raw = dict["items"] as? [[String: Any]] ?? []
            let parsed = raw.compactMap(Self.parse)
            Self.scheduleAll(parsed)
            NSLog("[ShellBridge] 收到 \(raw.count) 条提醒计划")

        case "alarmAuth":
            // 网页侧点了"申请闹钟权限"（最高档要用真闹钟）
            // ⚠️ 必须由用户手势触发时才最可靠 —— 所以不写在启动流程里当唯一路径，
            //    启动时也会试着申请一次（实测可行），这里是补一次显式入口。
            if #available(iOS 26.0, *) {
                AlarmKitScheduler.shared.requestAuthorization { ok in
                    NSLog("[ShellBridge] 闹钟授权结果：\(ok)")
                    Self.reportAlarmKit()
                }
            } else {
                NSLog("[ShellBridge] 系统低于 26，没有 AlarmKit")
                Self.reportAlarmKit()
            }

        case "alarmStatus":
            Self.reportAlarmKit()
            // ⚠️ 不要在调用点写 `if #available`：可用性检查只在 reportAlarmClock 里做一次
            //    （散落多处迟早漏一个，而漏了的那处会直接编译失败）。
            Self.reportAlarmClock()

        // ------------------------------------------------------------------
        // 「闹钟」板块（计时器 / 定时器）—— 与上面那条"提醒的最高档"是两条路，
        // 各有各的排程器与元数据类型（见 AlarmClockScheduler.swift 文件头）。
        // ------------------------------------------------------------------
        case "alarms":
            // 整批重排：网页每次数据变动都会发一份**完整**的该排清单。
            // ⚠️ 空数组也是有效输入（用户把闹钟全删了/全关了）—— 那正需要"清空"。
            let rows = (dict["items"] as? [[String: Any]]) ?? []
            let requests = rows.compactMap { AlarmClockRequest($0) }
            let snd = Self.soundMap(requests)
            NSLog("[ShellBridge] 收到 \(rows.count) 条闹钟计划（解析出 \(requests.count) 条）")
            if #available(iOS 26.0, *) {
                AlarmClockScheduler.shared.replaceAll(requests) {
                    Self.reportAlarmClock(soundMap: snd)
                }
            } else {
                // ⚠️ 低于 iOS 26 也要**如实回报**（0 条 + 原因），
                //    否则网页那边显示"交给系统 0 条"却不知道为什么。
                NSLog("[ShellBridge] 系统低于 26，闹钟排不了")
                Self.send(["type": "alarms", "count": 0, "scheduled": [],
                           "reason": "系统低于 iOS 26，没有 AlarmKit"])
            }

        case "alarmScheduleStatus":
            // 只读：问一次"系统里实际排成什么样"（诊断区要用）
            Self.reportAlarmClock()

        case "alarmTimer":
            // 计时器（倒计时）：start / cancel
            let action = dict["action"] as? String ?? "start"
            let alarmId = dict["id"] as? String ?? ""
            // ⚠️ 先落成一个**不可变**的 map，再进闭包 ——
            //    在 @escaping 闭包里引用可变局部变量在 Swift 6 并发检查下会报错，
            //    而且那也不是这里想要的语义（"排这条时用的铃声"是那一刻的事实）。
            let one: [String: String] = {
                let s = (dict["sound"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return s.isEmpty ? [:] : [alarmId: s]
            }()
            let soundFile = one[alarmId]
            if #available(iOS 26.0, *) {
                if action == "cancel" {
                    AlarmClockScheduler.shared.cancelTimer(id: alarmId)
                    Self.reportAlarmClock(soundMap: one)
                } else {
                    let secs = dict["seconds"] as? Int ?? dict["durationSec"] as? Int ?? 600
                    let title = dict["title"] as? String ?? "计时器"
                    // ⚠️ `test: true` = 网页上的「⏱ 10 秒后试响」（见 adapter/alarms.js 的
                    //    testAlarmSound）。壳侧据此在响过之后**自动把这条从系统里撤掉**
                    //    —— 2026-10-02 用户报「试响过了一阵又自己冒出来」，试响绝不许
                    //    在系统里留成幽灵（真正的倒计时不会带这个字段，也就不受这条影响）。
                    let isTest = dict["test"] as? Bool ?? false
                    AlarmClockScheduler.shared.startTimer(id: alarmId, seconds: secs,
                                                          sound: soundFile, title: title,
                                                          isTest: isTest) { ok in
                        NSLog("[ShellBridge] 计时器 \(ok ? "排上了" : "没排上")（\(secs) 秒）")
                        Self.reportAlarmClock(soundMap: one)
                    }
                }
            } else {
                Self.send(["type": "alarms", "count": 0, "scheduled": [],
                           "reason": "系统低于 iOS 26，倒计时做不成真闹钟"])
            }

        case "pickSound":
            // 网页侧点了「导入音频…」/「＋ 再加一首…」
            // ⚠️ 2026-10-02：**不再读 `tier`**。以前网页说"替换第几档"，
            //    壳就把同档上一次那个文件删掉 —— 用户看到的正是"导了第二首第一首没了"。
            //    现在选中的音频一律**作为新的一首加进列表**。
            //    （老网页仍会带 tier 过来，**忽略它**即可，不会出错。）
            // ⚠️ `presentPicker` 标了 @MainActor（UIKit），必须这样跳一次 ——
            //    和 AlarmKit 那边同一个写法。
            Task { @MainActor in
                CustomSoundLibrary.shared.presentPicker { result in
                    var payload: [String: Any] = ["type": "soundImported"]
                    switch result {
                    case .success(let name):
                        payload["ok"] = true
                        payload["name"] = name
                        // 新格式的文件名里就是 id；老格式（理论上不会新产生）留空。
                        if let id = CustomSoundLibrary.soundId(ofFile: name) { payload["id"] = id }
                    case .failure(let e):
                        payload["ok"] = false
                        payload["reason"] = e.localizedDescription
                    }
                    // ⚠️ 2026-10-01：顺手带上"现在的完整名单"。
                    //    网页侧不用再追问一次 —— 导入之后它要立刻能用上新那一首排闹钟，
                    //    少一次往返就少一个"名单还没到、闹钟先排了"的竞态。
                    //
                    // ⚠️ 2026-10-02：从"只带一个 alarmFile"改成**带整个 `sounds` 数组** ——
                    //    多首之后"一个文件名"根本表达不了状态（那是这个需求的老病根）。
                    //    `alarmFile` 继续带着，只是为了不让还没更新的网页侧接口断掉。
                    payload["sounds"] = CustomSoundLibrary.shared.sounds()
                    payload["alarmFile"] = CustomSoundLibrary.shared.alarmSlotFile()
                    Self.send(payload)
                }
            }

        case "dropSound":
            // 网页侧点了那一首卡片上的「删掉」→ 把容器里那个文件也删掉（不然会一直堆着）
            // ⚠️ `name` 是**文件名**（不是 id）—— 壳只认文件名，别在这里做 id→文件名 的翻译，
            //    翻译属于网页侧（它才知道这一首的 id 对应哪个文件）。
            let name = dict["name"] as? String ?? ""
            let ok = CustomSoundLibrary.shared.delete(name)
            // 顺手把删完之后的名单带回去（网页侧据此立刻重画，不用等下一次轮询）
            Self.send(["type": "soundDropped", "name": name, "ok": ok,
                       "sounds": CustomSoundLibrary.shared.sounds(),
                       "alarmFile": CustomSoundLibrary.shared.alarmSlotFile()])

        case "soundStatus":
            // 网页侧问"容器里现在有哪些自定义音"——用来清掉设置里那些已经不存在的名字
            // （典型场景：设置在电脑上，音在电脑那个容器里；iPad 上同步到设置却没有文件）
            //
            // ⚠️ 2026-10-01：多带一个 `alarmFile`（当时是闹钟唯一那个文件名）。
            // ⚠️ 2026-10-02：**多带一个 `sounds`（数组）**，这才是列表功能真正要的东西：
            //    `[{id, name, file}]`。`alarmFile` 保留只为兼容还没更新的网页侧。
            Self.send(["type": "soundStatus",
                       "files": CustomSoundLibrary.shared.list(),
                       "sounds": CustomSoundLibrary.shared.sounds(),
                       "alarmFile": CustomSoundLibrary.shared.alarmSlotFile()])

        case "ready":
            let local = dict["localMode"] as? Bool ?? false
            NSLog("[ShellBridge] 网页就绪，localMode=\(local)")
            // 刷新闹钟状态并把结果告诉网页侧（设置页要显示"最高档到底会不会真响"）
            if #available(iOS 26.0, *) { AlarmKitScheduler.shared.refresh() }
            Self.reportAlarmKit()
            // 顺带报一次「提醒事项」桥的状态（设置页要显示）
            ShellBridge.shared.reportVoice(status: nil)
            // 以及"容器里现在有哪些自定义提示音"——网页侧拿它核对设置里记的名字还在不在
            // （`sounds` = 完整名单 / `alarmFile` 只为兼容旧网页，理由见上面 case "soundStatus"）
            ShellBridge.send(["type": "soundStatus",
                              "files": CustomSoundLibrary.shared.list(),
                              "sounds": CustomSoundLibrary.shared.sounds(),
                              "alarmFile": CustomSoundLibrary.shared.alarmSlotFile()])
            // 网页能收消息了 —— 把冷启动期间排队的深链补送出去
            pageReady = true
            let queued = pendingLinks
            pendingLinks.removeAll()
            for link in queued { deliver(link) }

        case "writeShare":
            // 「未来 7 天」写成文件，让快捷指令 / Siri 读到（内容由 core/share-plan.js 生成）
            Self.writeShare(json: dict["json"], text: dict["text"] as? String ?? "")

        case "voiceAuth":
            // 网页侧点了「申请提醒事项权限」
            RemindersBridge.shared.requestAccess { ok in
                NSLog("[ShellBridge] 提醒事项权限：\(ok)")
                ShellBridge.shared.reportVoice(status: ["ok": ok, "status": ok ? "ok" : "denied"])
            }

        case "voiceMirror":
            // 网页侧算好了"要写进提醒事项的那份镜像"（见 core/voice-bridge.js）。
            // ⚠️ 壳**不做任何判断**：清单名、标记、写什么、读回来什么，全部是网页侧给的。
            let listName = dict["listName"] as? String ?? "日程表"
            let mark = dict["mirrorMark"] as? String ?? "[tt:mirror]"
            let items = dict["items"] as? [[String: Any]] ?? []
            RemindersBridge.shared.sync(listName: listName, mirrorMark: mark, mirror: items) { result in
                // 把"用户自己加的那些"回灌给网页层 —— 变成真日程是**业务**，
                // 必须由网页层（同一份 core 代码）做，壳不改数据。
                var payload = result
                payload["type"] = "voiceImported"
                Self.send(payload)
            }

        case "voiceStatus":
            // 只读状态（不弹窗）—— 设置页显示用
            // ⚠️ `reportVoice` 是**实例**方法，所以要走 shared；
            //    写 `Self.reportVoice` 会编译不过（"instance member cannot be used on type 'Self'"）。
            ShellBridge.shared.reportVoice(status: nil)

        case "log":
            NSLog("[网页] \(dict["message"] as? String ?? "")")

        default:
            NSLog("[ShellBridge] 未知消息: \(type)")
        }
    }

    /// 深链进来了（快捷指令 / Siri）
    func handleIncoming(_ urlString: String) {
        NSLog("[ShellBridge] 深链: \(urlString)")
        guard pageReady else {
            pendingLinks.append(urlString)
            return
        }
        deliver(urlString)
    }

    private func deliver(_ urlString: String) {
        guard let webView else { return }
        // ⚠️ 用 JSONSerialization 生成 JS 字面量，而不是手拼字符串再转义。
        //    URL 里会带**中文**（用户口述的话），手写转义很容易漏掉
        //    引号/反斜杠/换行，那会因为一个字符就整条消息失效 —— 而且是静默失效。
        //    JSON 本身就是合法的 JS 对象字面量，交给系统去转义最稳。
        let payload: [String: Any] = ["type": "openUrl", "url": urlString]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        let js = "window.__timetableNative && window.__timetableNative.onMessage(\(json));"
        DispatchQueue.main.async {
            webView.evaluateJavaScript(js) { _, err in
                if let err { NSLog("[ShellBridge] 送深链失败: \(err)") }
            }
        }
    }

    /// 把一批提醒分派到两条通道。
    ///
    /// ⚠️⚠️ 这里的**分流规则是这一版最关键的一处设计**，别随手改：
    ///   · **最高档（intensity ≥ 4）** → AlarmKit 真闹钟（满音量、无视静音、穿专注）
    ///   · **其余档位** → 普通本地通知（尊重专注模式、尊重静音）
    ///   · **系统 < 26，或用户没授权闹钟** → **整批退回普通通知**
    ///
    ///   为什么必须按档位分，而不是"真闹钟更强就全用它"：
    ///   **真闹钟在设计上无法被专注模式压住** —— 全用它等于把专注模式废掉。
    ///   用户明确说了"专注模式时别响"，所以只让**他自己设成最高档**的那些日程
    ///   拥有穿专注的能力，其余一律走会尊重专注的普通通知。
    ///
    ///   ⚠️ 退回时是**整批**退回，不是只漏掉最高档：如果只把最高档丢掉，
    ///      用户会看到"排了但到点什么都没有"，比降级成普通通知更糟。
    private static func scheduleAll(_ items: [PlannedNotification]) {
        let wantsAlarm = items.filter(isAlarmIntensity)
        let normal = items.filter { !isAlarmIntensity($0) }

        // ⚠️ 所有对 AlarmKitScheduler 的引用都必须在**同一个** `#available` 保护里。
        //    第一版我在 `if #available` 块里读了 authorized，却把 `replaceAll`
        //    写在了块**外面** —— 编译直接报：
        //      error: 'AlarmKitScheduler' is only available in iOS 26.0 or newer
        //    `if #available(...), 条件` 这种写法能把整段都罩住，不用嵌套。
        if #available(iOS 26.0, *), AlarmKitScheduler.shared.authorized, !wantsAlarm.isEmpty {
            NSLog("[ShellBridge] 分流：\(wantsAlarm.count) 条做真闹钟，\(normal.count) 条走普通通知")
            AlarmKitScheduler.shared.replaceAll(with: wantsAlarm)
            NotificationScheduler.shared.replaceAll(with: normal)
        } else {
            if !wantsAlarm.isEmpty {
                NSLog("[ShellBridge] 有 \(wantsAlarm.count) 条最高档，但闹钟不可用 → 全部退回普通通知")
            }
            NotificationScheduler.shared.replaceAll(with: items)
        }
    }

    /// 把「未来 7 天」写进 App 自己的 Documents 目录。
    ///
    /// ⚠️⚠️ 这是**整个"语音助手"里最关键的一步**：没有它，Siri 读不到我们的数据。
    ///   原因见 core/share-plan.js 顶部：原生 Siri 集成要 `com.apple.developer.siri`，
    ///   免费账号拿不到、侧载还会崩；所以**文件是唯一通道**。
    ///
    /// ⚠️⚠️ **两份文件必须分开放**（这是用户实测踩出来的）：
    ///    第一版把 `timetable-plan.txt`（给人念的）和 `timetable-plan.json`
    ///    （给机器读的）**写在同一个目录** —— 结果用户用快捷指令取文件时
    ///    按字母序拿到了 `json`，Siri 念出来是一堆"乱码（代码）"，
    ///    而他**没有任何办法知道该拿哪个**。这是设计错误，不是他的操作问题。
    ///    现在：给人念的那份放在**根目录且是那里唯一的文件**；
    ///    机器读的那份藏进 `raw/` 子目录，永远不会被"取第一个文件"误抓到。
    ///
    /// ⚠️ 目录选 Documents 而不是 tmp：配合 Info.plist 的 `UIFileSharingEnabled`，
    ///   这个目录会出现在「文件 → 我的 iPad → 日程表」里，快捷指令的「获取文件」
    ///   和用户自己都能看到。
    ///
    /// ⚠️ 失败**必须记 NSLog**：这条通道坏了的表现是"Siri 念的是旧的 / 念不出来"，
    ///   用户在设备上看不到任何提示 —— 只有日志能告诉我们。
    private static func writeShare(json: Any?, text: String) {
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            NSLog("[ShellBridge] 找不到 Documents 目录，分享文件没写成")
            return
        }
        // ① 给人念的：放在**根目录**，而且是根目录里唯一的（快捷指令取"第一个文件"也只会拿到它）
        do {
            try text.write(to: dir.appendingPathComponent("timetable-plan.txt"),
                           atomically: true, encoding: .utf8)
        } catch {
            NSLog("[ShellBridge] 写 timetable-plan.txt 失败：\(error)")
        }
        // ② 给机器读的：藏进 raw/，不跟①混在一起
        if let json {
            let rawDir = dir.appendingPathComponent("raw", isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: rawDir, withIntermediateDirectories: true)
                let data = try JSONSerialization.data(
                    withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: rawDir.appendingPathComponent("timetable-plan.json"), options: .atomic)
            } catch {
                NSLog("[ShellBridge] 写 raw/timetable-plan.json 失败：\(error)")
            }
        }
        NSLog("[ShellBridge] 分享文件已更新（\(text.count) 字）")
    }

    /// 把 AlarmKit 的可用/授权状态告诉网页侧（设置页要显示它，
    /// 还要据此告诉用户"最高档现在到底会不会响"）。
    private static func reportAlarmKit() {
        var available = false
        var authorized = false
        if #available(iOS 26.0, *) {
            available = AlarmKitScheduler.shared.available
            authorized = AlarmKitScheduler.shared.authorized
        }
        let payload: [String: Any] = ["type": "alarmkit", "available": available, "authorized": authorized]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        ShellBridge.shared.evalJS("window.__timetableNative && window.__timetableNative.onMessage(\(json));")
    }

    /// 给网页侧发一条 JSON 消息（**统一入口**，别在别处手拼字符串）
    static func send(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        ShellBridge.shared.evalJS("window.__timetableNative && window.__timetableNative.onMessage(\(json));")
    }

    /// 从一批闹钟请求里抽出 "网页 id → 铃声文件名"（诊断要核对"文件在不在包里"）。
    private static func soundMap(_ requests: [AlarmClockRequest]) -> [String: String] {
        var m: [String: String] = [:]
        for r in requests { if let s = r.sound { m[r.id] = s } }
        return m
    }

    /// 把「闹钟」板块的**实际排程**回报给网页侧（诊断区要用）。
    ///
    /// ⚠️⚠️ 这个方法**刻意整个放在 `if #available` 之外**，理由有两个：
    ///    ① 别处调用它时都在 `#available` 里，但**下面还要处理"系统低于 26"**
    ///       那条分支 —— 那时 `AlarmClockScheduler` 整个类型都不可用，
    ///       引用它直接编译失败。第一次 CI 编译就是这么挂的：
    ///         error: 'AlarmClockScheduler' is only available in iOS 26.0 or newer
    ///    ② 铃声文件的核对住在 `AlarmSoundFiles`（**没有**可用性标注的 enum）里，
    ///       老系统上调用它完全没问题 —— 它只问一句 Bundle 里有没有这个文件。
    private static func reportAlarmClock(soundMap: [String: String] = [:]) {
        // 先算好在不在包里，再进闭包：`AlarmSoundFiles.exists` 与 iOS 版本无关。
        var soundOk: [String: Bool] = [:]
        for (id, file) in soundMap { soundOk[id] = AlarmSoundFiles.exists(file) }

        // ⚠️ 可用性检查**只在这一处**（`#available(...), 条件` 这种写法能把整段罩住，
        //    不用嵌套）—— 别在调用点再各写一次，那种散落的判断迟早漏一个。
        if #available(iOS 26.0, *) {
            AlarmClockScheduler.shared.readSystem { rows, scheduleResult, scheduleError in
                let enriched: [[String: Any]] = rows.map { row in
                    var r = row
                    if let webID = row["id"] as? String, let file = soundMap[webID] {
                        r["sound"] = file
                        r["soundOk"] = soundOk[webID] ?? false
                    } else {
                        // 没找到对应关系（比如系统里有一条不是这一次排的）：
                        // ⚠️ 如实标成"不知道"（NSNull），**不要默认成 true** ——
                        //    说"铃声没问题"而其实没核对过，是最误导人的那种绿。
                        r["sound"] = NSNull()
                        r["soundOk"] = NSNull()
                    }
                    return r
                }
                // ⚠️ `scheduleResult` / `scheduleError` = **上一次 `schedule()` 的结果**
                //    （2026-09-30 补）。没有它，界面上分不出这两种完全相反的情况：
                //      · "排上了、系统收下了，但就是不响" → 找呈现/系统那一侧
                //      · "压根没排上（schedule 抛错）"     → 找 AlarmKit 调用那一侧
                var payload: [String: Any] = [
                    "type": "alarms", "count": enriched.count, "scheduled": enriched,
                ]
                payload["lastSchedule"] = scheduleResult ?? NSNull()
                payload["lastScheduleError"] = scheduleError ?? NSNull()
                Self.send(payload)
            }
        } else {
            // 低于 26：没有可读的系统闹钟列表，也要如实回一份空 + 原因
            Self.send(["type": "alarms", "count": 0, "scheduled": [],
                       "reason": "系统低于 iOS 26，没有 AlarmKit"])
        }
    }

    /// 把「提醒事项」这条桥的状态告诉网页侧。
    /// ⚠️ 用户在设备上看不到任何日志 —— 设置页得有地方显示"权限给没给、上次同步成没成"。
    func reportVoice(status: [String: Any]?) {
        var payload: [String: Any] = [
            "type": "voiceStatus",
            "authorized": RemindersBridge.shared.authorized,
        ]
        if let status { payload["last"] = status }
        Self.send(payload)
    }

    /// 给网页侧执行一段 JS（失败只记日志，不抛）
    func evalJS(_ js: String) {
        guard let webView else { return }
        DispatchQueue.main.async {
            webView.evaluateJavaScript(js) { _, err in
                if let err { NSLog("[ShellBridge] evalJS 失败: \(err)") }
            }
        }
    }

    /// 把"用户在通知上点了某个动作"告诉网页层。
    ///
    /// ⚠️ 为什么要有这个：通知上的「完成」是**业务**（要改数据），
    ///    而数据归网页层管（本地模式存在 IndexedDB 里）。壳只负责把这个意图
    ///    **转达**过去，绝不自己动手改 —— 否则两端就分叉了。
    func tellWeb(action: String, eventId: String) {
        let payload: [String: Any] = ["type": "action", "action": action, "eventId": eventId]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        evalJS("window.__timetableNative && window.__timetableNative.onMessage(\(json));")
    }

    /// 通知被点击 → 让网页跳到对应日程
    func openEvent(_ eventId: String) {
        guard let webView else { return }
        let safe = eventId.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        let js = "window.__timetableNative && window.__timetableNative.onMessage({type:'openEvent',eventId:'\(safe)'});"
        DispatchQueue.main.async {
            webView.evaluateJavaScript(js) { _, err in
                if let err { NSLog("[ShellBridge] 回灌 openEvent 失败: \(err)") }
            }
        }
    }

    private static func parse(_ d: [String: Any]) -> PlannedNotification? {
        guard let id = d["id"] as? String,
              let eventId = d["eventId"] as? String,
              let title = d["title"] as? String,
              let body = d["body"] as? String,
              let fireAtStr = d["fireAt"] as? String else { return nil }
        // 网页侧给的是 UTC ISO（见 core/notify-plan.js 的契约）
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let fireAt = fmt.date(from: fireAtStr) ?? ISO8601DateFormatter().date(from: fireAtStr) else {
            NSLog("[ShellBridge] 时间解析失败: \(fireAtStr)")
            return nil
        }
        return PlannedNotification(id: id, eventId: eventId, title: title, body: body,
                                   fireAt: fireAt, intensity: d["intensity"] as? Int ?? 1,
                                   useAlarm: d["useAlarm"] as? Bool ?? false,
                                   sound: d["sound"] as? String)
    }
}
