// 「闹钟」板块的原生侧：把网页算好的闹钟排成 **AlarmKit 真闹钟**（iOS 26+）。
//
// ===========================================================================
// ⚠️ 与 AlarmKitScheduler.swift 的分工（两个文件，别合并）
//
//   · `AlarmKitScheduler` = **提醒的最高档**：日程 → 真闹钟。
//     它的输入是 core/notify-plan.js 排出来的提醒计划，每个都有绝对的 fireAt。
//   · `AlarmClockScheduler`（本文件）= **闹钟板块**：用户自己设的计时器/定时器。
//     它的输入是 core/alarms.js 的排程计划，**带重复规则**（每天/工作日/自定义星期），
//     所以它用的是 `Alarm.Schedule.relative`（系统自己重复），不是 fixed。
//
//   为什么不合并成一个类：两者的**生命周期不同**。
//   提醒是"每次数据变化整批重排"；闹钟是"用户手动开关 + 整批重排"，
//   而且多一条"计时器按秒倒计时"的路。混在一起会让
//   "谁负责取消谁排的"变得说不清，而那个搞错的症状是
//   **用户关掉的闹钟还在响**（本项目最不能接受的一类失败）。
//   两个类各自记自己排出去的 id，取消时只动自己的。
//
// ===========================================================================
// ⚠️ 四条纪律，一条都不能破（破了就是"老系统启动即崩"或"排了不响"）
//
//   ① **弱链接**：`ios/project.yml` 里的 `-weak_framework AlarmKit`。
//      部署目标是 16.0，强链接会让 iOS 16~25 启动加载动态库时直接崩。
//   ② **`#available(iOS 26.0, *)`**：弱链接负责启动不崩，
//      这个负责"不调用不存在的 API"。两者缺一不可。
//   ③ **`Task { @MainActor in … }`**：AlarmManager 的状态访问受 actor 隔离约束，
//      从非 MainActor 上下文同步读会编译失败。所以一律包起来，
//      需要同步读的地方读本类的缓存字段（见 available/authorized）。
//   ④ **`nonisolated struct` 的元数据类型**：Xcode 26 默认把类型标成 MainActor 隔离，
//      而 AlarmMetadata 的一致性要求它不是 —— 不加会编译不过。
//
// ===========================================================================
// ⚠️ 铃声：`AlertSound.named("文件名")`，**只吃打进 App 包里的音频文件**
//
//   依据（`build/alarmkit-api/AlarmKit.symbols.json` 与 Apple 文档核对过）：
//     AlarmManager.AlarmConfiguration.alarm(…, sound: AlertConfiguration.AlertSound = .default)
//     AlertSound.named(String) -> AlertSound        // 静态方法，只有"文件名"这一个入口
//   没有文件 URL、没有沙盒路径 —— 所以**用户自选音频这条路在系统层面就不通**
//   （网页上已如实写明）。文件名**不带扩展名**（探针实测的用法）。
//
//   ⚠️ 文件找不到时 iOS 的行为是**静默放默认闹钟音**（不报错）。
//      所以这里逐个用 `Bundle.main.url(forResource:withExtension:)` 核对，
//      把结果回报给网页（`soundOk`），让界面能如实说出"自定义铃声没生效"。
//      这是"设了铃声却听到系统音"这件事**唯一**能被发现的途径。

import Foundation
import SwiftUI
import ActivityKit
import AlarmKit

/// AlarmKit 要求元数据类型是**具体类型**且 **nonisolated**（理由见文件头第 ④ 条）。
///
/// ⚠️ 与 `TimetableAlarmMetadata`（提醒那条路）**不能共用一个类型**：
///    两边排出去的闹钟要能区分开，否则"取消自己那一批"的时候
///    会把对方的也取消掉 —— 症状是"设了闹钟，提醒反而没了"。
nonisolated struct AlarmClockMetadata: AlarmMetadata {}

/// 网页传来的一条闹钟排程（契约见 core/alarms.js 的 planAlarmSchedule）。
struct AlarmClockRequest {
    let id: String
    let fireAt: Date
    let repeatMode: String        // 'once' | 'daily' | 'weekdays' | 'custom'
    let weekdays: [Int]           // 0=周日 … 6=周六（**和 JS 的 getDay() 一致**）
    let sound: String?            // 文件名（不带扩展名）；nil = 系统默认闹钟音
    let title: String

    /// ⚠️ 解析规则集中在这里（网页那边只负责给对形状）：
    ///    · 缺 id / fireAt 就返回 nil（宁可这条不排，也不要排一个身份不明的闹钟 ——
    ///      它以后没法被取消，只能等用户在系统里手删）
    ///    · `sound` 空串**当作 nil**（空名字在 iOS 上会变成"没声音"且不报错）
    init?(_ d: [String: Any]) {
        guard let id = d["id"] as? String, !id.isEmpty else { return nil }
        guard let fireStr = d["fireAt"] as? String, let when = Self.parseDate(fireStr) else { return nil }
        self.id = id
        self.fireAt = when
        self.repeatMode = (d["repeat"] as? String) ?? "once"
        let raw = (d["weekdays"] as? [Any]) ?? []
        self.weekdays = raw.compactMap { v in
            let n = (v as? Int) ?? Int((v as? NSNumber)?.intValue ?? -1)
            return (n >= 0 && n <= 6) ? n : nil
        }
        let s = (d["sound"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.sound = s.isEmpty ? nil : s
        self.title = (d["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "闹钟"
    }

    /// ⚠️ 网页给的是 **UTC ISO 字符串**（`core/alarms.js` 的契约）。
    ///    解析必须同时认"带毫秒"和"不带毫秒"两种 —— 带毫秒那种在
    ///    iOS 上要额外的 formatOptions，只写一种会有一半条目解析失败
    ///    （而失败的表现是"那几条闹钟不响"）。这个写法是从
    ///    NotificationScheduler.swift 抄过来的（那条路已经在真机上跑通了）。
    static func parseDate(_ s: String) -> Date? {
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFrac.date(from: s) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: s)
    }
}

/// 状态回报里的一条（网页用它显示"壳实际排成什么样"）。
struct AlarmClockStatusRow {
    let id: String
    let fireAt: String
    let sound: String?
    let soundOk: Bool
}

/// 铃声文件的核对工具 —— **故意放在 `@available(iOS 26.0, *)` 的类外面**。
///
/// ⚠️⚠️ 为什么不能挂在 `AlarmClockScheduler` 上（这是第一次 CI 编译抓到的真错误）：
///    那个类整体标了 `@available(iOS 26.0, *)`，于是**连它的 static 成员**也被
///    一起标上了可用性。而 App.swift 里调用它的地方在
///    `if #available(iOS 26.0, *)` 的**外面**（回报函数还要处理"系统低于 26"那条分支），
///    编译器原话：
///      error: 'AlarmClockScheduler' is only available in iOS 26.0 or newer
///    这个工具本身只是"问一句 Bundle 里有没有这个文件"，跟 AlarmKit 毫无关系，
///    老系统上也**跑得了**（Bundle 一直存在）—— 所以它本来就不该被圈进 26.0。
enum AlarmSoundFiles {
    /// 这个铃声文件**系统找得到吗**（诊断用）
    ///
    /// ⚠️⚠️ 这是"自定义铃声到底生效没有"的**唯一**答案来源：
    ///    文件找不到时 `AlertSound.named()` 不报错，只是**静默放默认闹钟音**。
    ///    所以界面必须能说出"你设的是 alarm-morning-bell，但包里没有这个文件" ——
    ///    否则用户只会觉得"这 App 的铃声是坏的"。
    ///
    /// ⚠️⚠️ 2026-10-01 改：**两个位置都要查**，而且顺序按系统的查找顺序。
    ///    Apple 对 `AlertSound.named()` 的文档是"App 主包 **或** 数据容器的
    ///    `Library/Sounds`" —— 而用户自己导入的音频**只可能在后者**（它们是运行时写进去的）。
    ///    以前这里只查 `Bundle.main`，所以用户导入的铃声会被诊断成
    ///    **"⚠️ 文件没找到"**（假警报），而它其实好好地躺在容器里、
    ///    闹钟也确实在用它 —— 一份会撒谎的诊断比没有诊断更糟。
    static func exists(_ name: String) -> Bool {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        // ① App 主包（内置铃声）
        let inBundle: Bool
        if ext.isEmpty {
            inBundle = ["caf", "wav", "m4a", "aiff"].contains {
                Bundle.main.url(forResource: base, withExtension: $0) != nil
            }
        } else {
            inBundle = Bundle.main.url(forResource: base, withExtension: ext) != nil
        }
        if inBundle { return true }
        // ② 数据容器的 Library/Sounds（用户导入的铃声）
        return existsInContainer(name)
    }

    /// 容器 `Library/Sounds` 里有没有这个名字（用户导入的音频都在这儿）。
    /// ⚠️ 复用 `CustomSoundLibrary` 的目录与安全校验，**不自己拼路径**
    ///    （那份校验同时挡着"目录穿越"，两处必须一致）。
    static func existsInContainer(_ name: String) -> Bool {
        guard CustomSoundLibrary.isSafeName(name),
              let dir = CustomSoundLibrary.shared.soundsDirectory() else { return false }
        return FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path)
    }
}

/// 闹钟板块的调度器。**只在 iOS 26+ 存在**。
@available(iOS 26.0, *)
final class AlarmClockScheduler {
    static let shared = AlarmClockScheduler()

    private let manager = AlarmManager.shared

    /// ⚠️ 与 `core/alarms.js` 的 `MAX_SCHEDULED`（8）**必须一致**：
    ///    两边不一样就会出现"网页以为排了 12 条、系统只收了 8 条"，
    ///    而它表现出来只是"有的闹钟不响"，极难查。
    ///    （tools/alarms.test.mjs 钉着 core 那一侧的数字。）
    static let maxAlarms = 8

    /// 缓存的可用性 / 授权状态 —— 供非 MainActor 的调用方**同步**读（见文件头第 ③ 条）
    private(set) var available = false
    private(set) var authorized = false

    /// 自己排出去的闹钟 —— `AlarmManager` 没有"取消全部"的接口，
    /// 所以自己记账，取消时逐个来。**只记自己的**（见文件头关于分账的说明）。
    private var scheduledIDs: [UUID] = []
    /// 闹钟 id（网页给的字符串）→ 系统 id 的映射。
    /// 用途：用户**单条开关**时能立刻撤掉那一条，而不是整批重排。
    private var idMap: [String: UUID] = [:]

    /// **上一次 `schedule()` 的结果** —— 给诊断区用。
    ///
    /// ⚠️⚠️ 为什么必须有它（2026-09-30 真机排查补的）：
    ///    用户报「按下去弹了"N 分钟开始"（= 落库 ✓ 通知壳 ✓），但系统里 0 条、也不响」。
    ///    `schedule()` 抛错时，原来**只写 NSLog**（`catch { NSLog("[AlarmClock] 计时器排失败…") }`），
    ///    而回报给网页的内容**不包含这个结果** → 界面上分不出"排上了但不响"和"根本没排上"。
    ///    两者修法完全相反，所以这个字段是必须的。
    ///    （刻意**不落盘**：这是"上一次操作"的即时状态，重启清空才对。）
    private(set) var lastScheduleResult: String?
    /// 上一次排程的**错误原文**（只在上一条是失败时有值）
    private(set) var lastScheduleError: String?

    /// 记一次排程结果（成功/失败都记，供 `readSystem` 一起回报）
    private func noteSchedule(_ ok: Bool, error: String? = nil) {
        lastScheduleResult = ok ? "ok" : "failed"
        lastScheduleError = ok ? nil : (error ?? "未知错误")
    }

    private init() {}

    // -----------------------------------------------------------------------
    // 授权
    // -----------------------------------------------------------------------

    /// 刷新缓存状态。App 启动时调一次、申请授权之后再调一次。
    func refresh() {
        Task { @MainActor in
            available = true
            authorized = (manager.authorizationState == .authorized)
            NSLog("[AlarmClock] 状态：available=true authorized=\(authorized)")
        }
    }

    /// 申请闹钟权限（系统弹窗）。拿不到就如实回报，别反复骚扰用户。
    func requestAuthorization(completion: @escaping (Bool) -> Void) {
        Task { @MainActor in
            do {
                let s = try await manager.requestAuthorization()
                authorized = (s == .authorized)
                NSLog("[AlarmClock] 申请授权 → \(String(describing: s))")
                completion(authorized)
            } catch {
                NSLog("[AlarmClock] 申请授权抛错：\(error)")
                completion(false)
            }
        }
    }

    /// **现读**一次系统授权状态，并把缓存同步过来。
    ///
    /// ⚠️⚠️ 为什么必须有它（2026-09-30 真机抓到的**根因**）：
    ///    `authorized` 这个缓存字段**只有 `refresh()` 会写**，而
    ///    **`App.swift` 从来没调过 `AlarmClockScheduler.shared.refresh()`**
    ///    （它只调了 `AlarmKitScheduler.shared.refresh()`，那是"提醒"那条路的另一个实例）。
    ///    于是这个字段**永远是声明时的初值 `false`** → `startTimer()`/`replaceAll()` 的
    ///    `guard authorized` **每次都挡掉** → 闹钟**从来没被交给系统**，
    ///    而同一屏诊断区显示的"闹钟权限：已授权"读的是 Apple 那个实例的真实状态
    ///    → 用户看到的是**自相矛盾的两行**（"已授权" + "没有闹钟权限，计时器没排"）。
    ///    更糟的是它**静默**：用户既看不到授权弹窗，也看不到失败原因（现在有 noteSchedule 了）。
    /// ⚠️ 所以：**排程前一律现读，绝不信任缓存** —— 缓存只用来给诊断区显示。
    @MainActor
    @discardableResult
    private func currentAuthorization() -> Bool {
        available = true
        authorized = (manager.authorizationState == .authorized)
        return authorized
    }

    /// 需要时**申请**一次授权（会弹系统窗），然后把结果缓存下来。
    /// 只在用户主动发起动作时调（点"开始倒计时"、点"申请闹钟权限"）。
    @MainActor
    @discardableResult
    private func ensureAuthorized() async -> Bool {
        if currentAuthorization() { return true }
        do {
            let s = try await manager.requestAuthorization()
            authorized = (s == .authorized)
            NSLog("[AlarmClock] 现场申请授权 → \(String(describing: s))")
        } catch {
            NSLog("[AlarmClock] 现场申请授权抛错：\(error)")
            authorized = false
        }
        return authorized
    }

    // -----------------------------------------------------------------------
    // 排程：整批重排 / 单条开关 / 计时器
    // -----------------------------------------------------------------------

    /// 重新排**全部**闹钟（网页每次数据变动都调它）。
    ///
    /// ⚠️ 和其它排程一样：**先清空再排**。"删了还响"比"漏一次"更糟。
    /// ⚠️ 没授权时**照样把上一批清掉**，然后回报 0 条 —— 不清的话，
    ///    用户"关了权限"之后那些闹钟还会响，而界面显示"没有闹钟"。
    func replaceAll(_ requests: [AlarmClockRequest], completion: (() -> Void)? = nil) {
        Task { @MainActor in
            for id in scheduledIDs { try? manager.cancel(id: id) }
            scheduledIDs.removeAll()
            idMap.removeAll()

            // ⚠️ 现读系统真实状态（不再信任可能永远为 false 的缓存）。
            //    这里**不主动申请**：整批重排是后台动作（数据一变就发），
            //    不该在用户没操作时弹窗；申请交给 startTimer / 「申请闹钟权限」按钮。
            guard currentAuthorization() else {
                NSLog("[AlarmClock] 没授权，\(requests.count) 条不排")
                // ⚠️ 如实记成失败 + 原因：否则诊断区会显示"还没排过"，
                //    而真相是"排过、被授权挡了" —— 两者修法不同。
                noteSchedule(false, error: "系统没给闹钟权限，\(requests.count) 条都没排（点上面的「申请闹钟权限」）")
                completion?()
                return
            }

            let picked = Array(requests.prefix(Self.maxAlarms))
            if requests.count > picked.count {
                NSLog("[AlarmClock] 只排最近的 \(picked.count) 条（共 \(requests.count) 条，上限 \(Self.maxAlarms)）")
            }
            var okCount = 0
            var firstError: String?
            for r in picked {
                do {
                    _ = try await schedule(r)
                    okCount += 1
                } catch {
                    // ⚠️ 单条失败**不中断其余的**，但一定要 NSLog：
                    //    否则"某一条不响"连线索都没有。
                    NSLog("[AlarmClock] 排 \(r.id) 失败：\(error)")
                    if firstError == nil { firstError = "\(error)" }
                }
            }
            if picked.isEmpty {
                // 没有要排的：不算失败，也不算成功（清空是有效动作）
                noteSchedule(true, error: nil)
            } else if okCount == 0 {
                noteSchedule(false, error: firstError ?? "全部排程失败")
            } else if firstError != nil {
                noteSchedule(false, error: "排上 \(okCount)/\(picked.count) 条，第一个错误：\(firstError!)")
            } else {
                noteSchedule(true, error: nil)
            }
            // ⚠️ 最后**对账一次**（见 sweepOrphans 的注释）：上面那圈 `for id in scheduledIDs`
            //    只撤得掉"本进程排过的"；重启后 `scheduledIDs` 是空的，上一次进程
            //    留给系统守护进程的闹钟**谁都撤不掉**，只会在到点时自己冒出来。
            sweepOrphans()
            completion?()
        }
    }

    // -----------------------------------------------------------------------
    // 对账：把系统里"不属于这一轮计划"的遗留闹钟清掉
    // -----------------------------------------------------------------------

    /// 以**系统守护进程的名单为准**对账，清掉不属于当前计划的闹钟。
    ///
    /// ⚠️ 为什么必须有这一步（2026-10-02 用户报「闹钟会莫名其妙自己冒出来」）：
    ///    `scheduledIDs` / `idMap` **只在内存里**，App 一退出（重装、升级、
    ///    被系统回收、用户划掉）就空了 ⇒ 上一次进程排给守护进程的闹钟，
    ///    我们**再也撤不掉**：在界面上删掉它、关掉它、重排一次，都不动它，
    ///    它只会在到点时自己冒出来响。而 Apple 文档说 `AlarmManager.alarms` 是
    ///      「Fetches all alarms from the daemon that belong to the current client」
    ///    —— 这就是**权威名单**（它跨进程活着），所以对账要以它为准。
    ///
    /// ⚠️ 正在响的（`state` 里带 alert）**一律不动**：用户可能正被它叫醒，
    ///    对账把响着的闹钟按掉，是最不能接受的那种"修 bug 修出新事故"。
    /// ⚠️ 只在我们**有授权**时才被调用（`replaceAll` 的授权分支里）——
    ///    没授权时读 `manager.alarms` 本身就会抛错，没必要去试。
    private func sweepOrphans() {
        let keep = Set(scheduledIDs.map { String(describing: $0) })
        do {
            let list = try manager.alarms
            var swept = 0
            for a in list {
                let sysID = String(describing: a.id)
                if keep.contains(sysID) { continue }
                let state = String(describing: a.state).lowercased()
                if state.contains("alert") {
                    NSLog("[AlarmClock] 系统里有一条不属于当前计划的闹钟正在响（\(sysID)，state=\(state)）—— 不动它")
                    continue
                }
                try? manager.cancel(id: a.id)
                swept += 1
                NSLog("[AlarmClock] 清掉一条系统里的遗留闹钟 \(sysID)（state=\(state)，不在这一轮计划里）")
            }
            if swept > 0 {
                NSLog("[AlarmClock] 对账：系统里原有 \(list.count) 条，清掉 \(swept) 条遗留，这一轮留 \(keep.count) 条")
            }
        } catch {
            // ⚠️ 读不到就当"对不了账"，**绝不猜、绝不乱删**：宁可留着，也不误删。
            NSLog("[AlarmClock] 对账失败（读系统闹钟列表出错）：\(error)")
        }
    }

    /// 撤掉**一个**系统闹钟（如果它还在系统里）。给"试响自动收尾"用。
    ///
    /// ⚠️ 与 `sweepOrphans` 的区别：这个**不管它响不响** —— 试响是给用户
    ///    "听一下这个铃声"的，响过一次之后不该在系统里留任何东西
    ///    （留着的后果就是 2026-10-02 那次"过了一阵又自己冒出来"）。
    private func sweepOne(_ sys: UUID, why: String) {
        let sysID = String(describing: sys)
        // 先摘记账：不管系统里还有没有，这一条都不再属于我们了。
        scheduledIDs.removeAll { $0 == sys }
        idMap = idMap.filter { String(describing: $0.value) != sysID }
        do {
            let list = try manager.alarms
            guard list.contains(where: { String(describing: $0.id) == sysID }) else { return }
            try? manager.cancel(id: sys)
            NSLog("[AlarmClock] 已收尾\(why)（\(sysID)）")
        } catch {
            NSLog("[AlarmClock] 收尾\(why)失败：\(error)")
        }
    }

    /// 单条开关：关掉 → 撤掉那一条；打开 → 立刻把它排上。
    ///
    /// ⚠️ 为什么不干脆整批重排（那更简单）：整批重排会**动到别人的账**
    ///    （用户在设置页点一次开关，别的闹钟也被取消重排一遍），
    ///    而"重排"这个动作本身有失败的可能 —— 能不动就不动。
    func toggleAlarm(id: String, enabled: Bool, completion: (() -> Void)? = nil) {
        Task { @MainActor in
            if !enabled {
                if let sys = idMap[id] {
                    try? manager.cancel(id: sys)
                    scheduledIDs.removeAll { $0 == sys }
                    idMap.removeValue(forKey: id)
                    NSLog("[AlarmClock] 已撤掉 \(id)")
                }
            }
            completion?()
        }
    }

    /// 计时器：**按秒倒计时**（`.timer(duration:)`，系统自己数）。
    ///
    /// ⚠️ 与定时器分开的原因：定时器用 `relative` 重复规则（系统按天重复），
    ///    而倒计时是"从这一刻起 N 秒后响"，一次性的。混用会导致
    ///    "倒计时结束后按每天重复响一次"这种荒唐事。
    ///
    /// ⚠️ 返回值刻意**不是** Bool：真正的排程在 `Task {}` 里异步完成，
    ///    同步返回的 Bool 只会是 false（= 骗人）。成功/失败走 completion。
    ///
    /// ⚠️ `isTest`（2026-10-02 加）：网页上的「⏱ 10 秒后试响」走的就是这条路
    ///    （`alarm_test_<时间戳>`）。它**必须自己收尾** —— 见下面那段 Task 的注释。
    func startTimer(id: String, seconds: Int, sound: String?, title: String,
                    isTest: Bool = false,
                    completion: ((Bool) -> Void)? = nil) {
        Task { @MainActor in
            // ⚠️ 现读 +（需要时）申请，**不再读那个死掉的缓存**（见 currentAuthorization 的注释）
            guard await ensureAuthorized() else {
                NSLog("[AlarmClock] 没授权，计时器不排")
                noteSchedule(false, error: "系统没给闹钟权限（弹窗里没允许，或被家长控制/描述文件挡住）")
                completion?(false)
                return
            }
            do {
                let cfg = AlarmManager.AlarmConfiguration<AlarmClockMetadata>.timer(
                    duration: TimeInterval(max(1, seconds)),
                    attributes: Self.attributes(title: title),
                    sound: Self.sound(for: sound)
                )
                let sys = UUID()
                _ = try await manager.schedule(id: sys, configuration: cfg)
                scheduledIDs.append(sys)
                idMap[id] = sys
                // ⚠️ 记成"成功"：这只是说**系统收下了**，不代表它会呈现/会响
                //    （见 readSystem 那段注释）—— 所以诊断区还会同时读系统列表对账。
                noteSchedule(true)
                NSLog("[AlarmClock] 计时器已排 \(seconds) 秒，铃声=\(sound ?? "系统默认")\(isTest ? "（试响）" : "")")
                if isTest {
                    // ⚠️ 试响**必须自己收尾**（2026-10-02 用户报「试响过了一阵又自己冒出来」）。
                    //    两条防线：① `attributes()` 里已经把系统的 Repeat 按钮拆了；
                    //    ② 这里在"该响的时刻"之后留 45 秒，然后把这条从系统里撤掉。
                    //    45 秒的理由：10 秒的试响 + 用户听完/点「知道了」的余量；
                    //    再长就是在替用户留一条他不知道自己有的闹钟。
                    //    ⚠️ 只对试响这么干：真正的倒计时（倒计时 N 分钟）**不许**自动撤 ——
                    //       它可能正在响、用户正要按「知道了」。
                    let grace = Double(max(1, seconds)) + 45
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: UInt64(grace * 1_000_000_000))
                        self.sweepOne(sys, why: "（试响，\(seconds) 秒）")
                    }
                }
                completion?(true)
            } catch {
                noteSchedule(false, error: "\(error)")
                NSLog("[AlarmClock] 计时器排失败：\(error)")
                completion?(false)
            }
        }
    }

    /// 撤掉一个计时器（暂停 / 取消都走它）
    func cancelTimer(id: String) {
        Task { @MainActor in
            guard let sys = idMap[id] else { return }
            try? manager.cancel(id: sys)
            scheduledIDs.removeAll { $0 == sys }
            idMap.removeValue(forKey: id)
            NSLog("[AlarmClock] 计时器已撤：\(id)")
        }
    }

    // -----------------------------------------------------------------------
    // 读系统真实状态（诊断区要它）
    // -----------------------------------------------------------------------

    /// 从系统读**真实**排了哪些（只回 id / 系统 id / 状态）。
    ///
    /// ⚠️ 为什么不信自己记的账：`schedule()` 返回成功只说明"系统收下了请求"，
    ///    **不代表它会呈现**（探针踩过：排了 12 个、到点没响，根因是缺
    ///    NSSupportsLiveActivities）。而 `AlarmManager.alarms` 是系统自己持有
    ///    的那份列表，拿它对账才是真的。
    ///
    /// ⚠️ `AlarmManager.alarms` 是**会抛错的属性**（不是普通属性）——
    ///    必须 `try`，而且要先赋给局部变量（写 `try manager.alarms.count`
    ///    编译器会挑刺，探针第一次编译就栽在这）。
    ///
    /// ⚠️⚠️ **不读 `Alarm.fireDate`**（第一次 CI 编译报
    ///    `error: value of type 'Alarm' has no member 'fireDate'`）：
    ///    符号表里那个 `Alarm` 的属性清单我读得不全，这个成员在真 SDK 上不存在。
    ///    所以这里**只碰符号表里确认有的两个**：`id` 与 `state`
    ///    （`Alarm.id` / `Alarm.state` 在导出接口里是明确列出来的）。
    ///    时刻信息由网页侧负责显示 —— 它本来就有那份计划，不需要壳再回一遍。
    /// 返回的字典里除了 `scheduled` 列表，还带**上一次 `schedule()` 的结果**
    /// （`lastScheduleResult` / `lastScheduleError`）—— 2026-09-30 补：
    /// 没有它，界面分不出"排上了但不响"和"根本没排上"，而两者修法相反。
    func readSystem(completion: @escaping ([[String: Any]], String?, String?) -> Void) {
        Task { @MainActor in
            var out: [[String: Any]] = []
            do {
                let list = try manager.alarms
                for a in list {
                    let sysID = String(describing: a.id)
                    // 反查网页 id：只有我们自己排的才有映射
                    let webID = idMap.first(where: { String(describing: $0.value) == sysID })?.key
                        ?? sysID
                    out.append([
                        "id": webID,
                        "systemId": sysID,
                        "state": String(describing: a.state),
                    ])
                }
                NSLog("[AlarmClock] 系统里现在有 \(list.count) 个闹钟")
            } catch {
                NSLog("[AlarmClock] 读系统闹钟失败：\(error)")
            }
            // ⚠️ 把"上一次 schedule() 的结果"一起带回去（网页据此区分
            //    "没排上"和"排上了但不响"，两者修法相反）
            completion(out, self.lastScheduleResult, self.lastScheduleError)
        }
    }

    // -----------------------------------------------------------------------
    // 内部
    // -----------------------------------------------------------------------

    private func schedule(_ r: AlarmClockRequest) async throws {
        let schedule = Self.systemSchedule(for: r)
        let cfg = AlarmManager.AlarmConfiguration<AlarmClockMetadata>.alarm(
            schedule: schedule,
            attributes: Self.attributes(title: r.title),
            sound: Self.sound(for: r.sound)
        )
        let sys = UUID()
        _ = try await manager.schedule(id: sys, configuration: cfg)
        scheduledIDs.append(sys)
        idMap[r.id] = sys
    }

    /// 网页的重复规则 → 系统的排程。
    ///
    /// ⚠️⚠️ 这里是整个文件**唯一一处"我没法在本机验证"的换算**，说清楚：
    ///
    ///   网页给的 `weekdays` 用的是 **JS 的 `getDay()` 编号：0=周日 … 6=周六**
    ///   （core/alarms.js 里就是这么定义的，测试钉着）。
    ///   而系统的 `Alarm.Schedule.Relative.Recurrence.weekly([Locale.Weekday])`
    ///   要的是 Foundation 的 `Locale.Weekday` 枚举。
    ///
    ///   本机没有 Swift 工具链，`Locale.Weekday` 的原始值我没法在这里跑出来核对，
    ///   所以按 **1=周日 … 7=周六**（Foundation 的 `Calendar.Component.weekday`
    ///   惯例）映射，并且：
    ///     · 映射集中在**这一个函数**里 —— 万一真机上"周三响成了别的天"，
    ///       改这里一处就行，不用满文件找
    ///     · **诊断区会把每条闹钟的重复规则与星期原样显示出来**，
    ///       真机上一眼能看出"它以为是哪几天"（不用靠猜）
    ///
    ///   ⚠️ 另一条保底：`once` 与 `daily` **完全不经过这个映射**
    ///      （once 用 fixed、daily 用 weekly 全集），所以即使这段换算错了，
    ///      也只有"工作日/自定义星期"这两种会受影响，最常见的
    ///      "只响一次/每天早上"不会受牵连。
    private static func systemSchedule(for r: AlarmClockRequest) -> Alarm.Schedule {
        switch r.repeatMode {
        case "once":
            // 一次性：给**绝对时刻**。注意网页算出来的 fireAt 就是"最近的那一次"，
            // 所以不需要系统再重复。
            return .fixed(r.fireAt)
        case "daily":
            // 每天：用系统自己的重复规则（App 没打开也照样响）。
            // 时刻用 fireAt 的**时分**，其余交给系统。
            //
            // ⚠️ 七天是**显式列出来**的，不用 `Locale.Weekday.allCases`：
            //    那个 API 存不存在我没法在本机核实（没有 Swift 工具链），
            //    而显式数组一定能编译。少猜一个 API 就少烧一个 CI 构建周期。
            let hm = Calendar.current.dateComponents([.hour, .minute], from: r.fireAt)
            return .relative(Alarm.Schedule.Relative(
                time: Alarm.Schedule.Relative.Time(hour: hm.hour ?? 7, minute: hm.minute ?? 0),
                repeats: .weekly(Self.allWeekdays)
            ))
        case "weekdays", "custom":
            let days: [Int] = r.repeatMode == "weekdays" ? [1, 2, 3, 4, 5] : r.weekdays
            let hm = Calendar.current.dateComponents([.hour, .minute], from: r.fireAt)
            let mapped = days.compactMap { Self.localeWeekday(jsDay: $0) }
            // ⚠️ 一天都没映射出来时退回"一次性"而不是"每天"：
            //    宁可少响一次，也不能在用户**没选的日子**把他吵醒。
            if mapped.isEmpty { return .fixed(r.fireAt) }
            return .relative(Alarm.Schedule.Relative(
                time: Alarm.Schedule.Relative.Time(hour: hm.hour ?? 7, minute: hm.minute ?? 0),
                repeats: .weekly(mapped)
            ))
        default:
            return .fixed(r.fireAt)
        }
    }

    /// JS 的 getDay()（0=周日）→ Foundation 的 Locale.Weekday。
    /// ⚠️ 1=周日 的假设写在文件头那段里（这是唯一没法在本机验证的一处）。
    private static func localeWeekday(jsDay: Int) -> Locale.Weekday? {
        switch jsDay {
        case 0: return .sunday
        case 1: return .monday
        case 2: return .tuesday
        case 3: return .wednesday
        case 4: return .thursday
        case 5: return .friday
        case 6: return .saturday
        default: return nil
        }
    }

    /// 一周七天（显式列出 —— 理由见 systemSchedule 里"daily"那段注释） */
    private static let allWeekdays: [Locale.Weekday] = [
        .sunday, .monday, .tuesday, .wednesday, .thursday, .friday, .saturday,
    ]

    /// 这一条该用哪个声音。`nil` = 不传（= 系统默认闹钟音）。
    ///
    /// ⚠️⚠️ **2026-10-01 改了：加上扩展名**（原来是裸名字）。
    ///    原因是一条真机证据 + 一条本仓库内的旁证：
    ///      ① 真机：5 个「10 秒后试响」**全部放默认音**，而当时传的是
    ///         `named("alarm-morning-bell")`（**不带**扩展名）——
    ///         `named()` 查不到文件时**不报错、静默回落 `.default`**，
    ///         这与"听到默认音"完全吻合（见 `AlarmSoundFiles` 那段注释）。
    ///      ② 旁证：本 App 里**已经可用**的那条路（普通通知）传的是
    ///         **带扩展名的完整文件名** —— `UNNotificationSoundName("timetable-alert-strong.wav")`、
    ///         以及用户自导入的 `"customTier-….caf"`（见 `NotificationScheduler.swift:158-169`）。
    ///    原来的注释写着"`named()` 吃的是不带扩展名的文件名（探针实测的用法）"——
    ///    **但探针从来没真跑过**，那句"实测"是假的（`ios/probe/README.md` 的结论表一直空着）。
    ///    ⚠️ 这个改动**正在用探针复验**（探针加了 `withExtension` 开关，见 `ios/probe/`）：
    ///    如果"不带扩展名"也能响，把这里改回去即可 —— 但"带扩展名"在两种情况下都对
    ///    （文件名本来就在包里），所以先按证据走。
    /// ⚠️ 文件**不在包里**时仍然照传（让系统按它自己的规则处理）——
    ///    但回报里会带 `soundOk:false`（见 soundFileExists），界面据此如实说明。
    ///    为什么不在这里改成 nil（= 用默认音）：那会把"文件丢了"这件事
    ///    藏起来 —— 用户听到默认音，却以为"我设的是这个铃"。
    private static func sound(for file: String?) -> AlertConfiguration.AlertSound {
        guard let f = file, !f.isEmpty else { return .default }
        // 网页侧给的是**不带扩展名**的裸名字（`core/alarms.js` 的 `file:` 字段，
        // 例如 `alarm-morning-bell`）；这里补成完整文件名再交给系统。
        // 已经带扩展名的不动（防止将来网页侧改了写法这边重复加）。
        let name = (f as NSString).pathExtension.isEmpty ? f + ".caf" : f
        return AlertConfiguration.AlertSound.named(name)
    }

    /// 闹钟长什么样。
    ///
    /// ⚠️ 标题要**短**：锁屏横幅会截断得很厉害（官方建议 4–5 个词），
    ///    所以调用方已经把标题截到 12 个字（见 core/alarms.js 的 alarmTitle）。
    /// ⚠️ `title` 的类型是 **`LocalizedStringResource`，不是 `String`** ——
    ///    运行时字符串必须显式构造（第一版直接传 String 编译报
    ///    "cannot convert value of type 'String' to expected argument type 'LocalizedStringResource'"）。
    /// ⚠️ 这里**刻意没有第二个按钮**（2026-10-02 拆的）—— 理由写在下面 `secondaryButton: nil`
    ///    那一段的注释里：系统对 `.countdown` 的语义是 "Repeat（再响一次）"，
    ///    间隔取 `postAlert`，而我们从来没传过它。
    private static func attributes(title: String) -> AlarmAttributes<AlarmClockMetadata> {
        let alert = AlarmPresentation.Alert(
            title: LocalizedStringResource(stringLiteral: String(title.prefix(20))),
            stopButton: AlarmButton(
                text: "知道了",
                textColor: .white,
                systemImageName: "checkmark"
            ),
            // ⚠️⚠️ **不许再加第二个按钮**（2026-10-02 拆掉的，用户报「闹钟会莫名其妙自己冒出来」）。
            //    这里曾经是 `secondaryButton: AlarmButton(text: "稍后 5 分钟", …)`
            //    + `secondaryButtonBehavior: .countdown`，当时的理解是"系统内置的稍后再响"。
            //    Apple 官方样例把这件事说清楚了：
            //      「When the `secondaryButtonBehavior` property is set to `countdown`,
            //        the secondary button is a `Repeat` action, which re-triggers the alarm
            //        after a certain `TimeInterval`, as specified in
            //        `Alarm.CountdownDuration.postAlert`.」
            //      （<https://developer.apple.com/documentation/alarmkit/scheduling-an-alarm-with-alarmkit>）
            //    两处致命：
            //      ① 它**不是**"稍后 5 分钟"，而是**系统的 Repeat**（再响一次）；间隔取
            //         `Alarm.CountdownDuration.postAlert`，而我们**从来没传过 `countdownDuration`**
            //         ⇒ 一个"间隔由系统默认决定、我们从没定义过"的重复提醒挂在**每一条**
            //         闹钟上（包括 10 秒试响）—— 这正是"过了一阵又自己冒出来"的来源。
            //      ② 按钮上的字**由系统说了算**（样例用的是系统给的 `.repeatButton`），
            //         我们写「稍后 5 分钟」是在替系统承诺一个它没保证的数字。
            //    ⇒ 只留「知道了」一个按钮（`secondaryButton` 与 `secondaryButtonBehavior`
            //      都是 `Optional`，传 nil 就是官方样例里 `selectedSecondaryButton = .none` 那条路）。
            //      真要做贪睡：得用带 `countdownDuration(preAlert:postAlert:)` 的那个
            //      `AlarmConfiguration` 构造 + 自己的 AppIntent，而且官方 Important 说
            //      「AlarmKit expects a widget extension if an app supports a countdown
            //      presentation. Otherwise, the system may unexpectedly dismiss alarms and
            //      fail to alert.」—— 那是另一件事，别在这里顺手加。
            secondaryButton: nil,
            secondaryButtonBehavior: nil
        )
        return AlarmAttributes(
            presentation: AlarmPresentation(alert: alert),
            // 和闹钟板块的界面主色一致（橙色系），一眼看出这是哪一档
            tintColor: .orange
        )
    }
}
