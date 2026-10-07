// 把网页给的提醒计划注册成系统通知。
//
// ⚠️ 为什么提醒必须走这里（而不是网页自己定时弹）：
//   iOS 上 App 切到后台后**不能指望它按时醒来** —— BGAppRefreshTask 的时机由系统决定。
//   所以提醒必须**提前**注册成系统的定时通知，到点由系统投递。
//   网页侧算出"未来哪些时刻该响"（core/notify-plan.js），这里把它变成
//   UNCalendarNotificationTrigger 交给 UNUserNotificationCenter。
//
// ⚠️ **不要**在这里复刻任何业务逻辑。哪些提醒、什么时候响、文案是什么，
//    全部由网页侧（core/ 的同一份代码）算好；这里只做"翻译成系统 API"。
//    一旦这里也判断一次，就会和网页端分叉 —— 那是这个项目一直在避免的事。

import Foundation
import UserNotifications

struct PlannedNotification {
    let id: String
    let eventId: String
    let title: String
    let body: String
    let fireAt: Date
    let intensity: Int
    /// 用户给这条日程勾了"用真闹钟"（会穿过专注模式）。见 core/notify-plan.js 的说明。
    let useAlarm: Bool
    /// **这一条该用哪个声音文件**，由网页侧决定（core/notify-plan.js 的 `soundForIntensity`）：
    ///   · 有名字 → 就用它（既可能是打进包的默认三档，也可能是用户自己导入的 .caf）
    ///   · nil / 空 → 退回下面 `add()` 里那份**按档位的内置映射**（老计划/字段缺失时的兜底）
    ///
    /// ⚠️ 为什么由网页侧决定而不是这里判断：**"哪一档配哪个声音"是业务**，
    ///    而且用户换过自定义音之后，那个名字只有网页层知道（存在 settings.notify.customSounds）。
    ///    壳只做"用哪个文件"这一个翻译动作 —— 和这个文件开头那条原则一致。
    let sound: String?
}

final class NotificationScheduler {
    static let shared = NotificationScheduler()

    /// 通知分类 —— 挂上它，通知才会多出两个按钮。
    ///
    /// ⚠️ 这是 App **唯一能改的通知界面**：横幅长什么样、停留多久、声音多响
    ///    全归系统；但"通知上能点哪几个按钮"是我们可以决定的。
    ///    所以用户在锁屏/横幅上可以直接「完成」或「10 分钟后再提醒」，
    ///    不必先打开 App —— 这才是"提示方式"里能真正改进的那部分。
    ///
    /// ⚠️⚠️ 这三个 id **故意都超过 15 个字节**，别改短：
    ///    Swift 把 ≤15 字节的字符串字面量按**内联小字符串**编码 ——
    ///    编译产物里 `strings` **一个字节都搜不到**，于是"这两个按钮到底注册没注册"
    ///    就无法从产物上验证。第一版 `TIMETABLE_DONE` 只有 14 字节，
    ///    `tools/ios-verify-ipa.mjs` 当场就查不出来（那不是它错，是名字太短）。
    ///    这些 id 不落盘、不跨版本，改长没有任何兼容性代价。
    static let categoryId = "TIMETABLE_REMINDER"
    static let actionDone = "TIMETABLE_ACTION_DONE"
    static let actionSnooze = "TIMETABLE_ACTION_SNOOZE_10"

    private let center = UNUserNotificationCenter.current()

    /// 注册通知分类（App 启动时调一次）。
    ///
    /// ⚠️ 必须**先注册、后投递**：投递时只带 categoryIdentifier，系统按注册表去找
    ///    那几个按钮；没注册就是一条普通通知（而且**不报错**，很难查）。
    func registerCategories() {
        let done = UNNotificationAction(
            identifier: Self.actionDone,
            title: "完成",
            options: []                       // 不设 .foreground：留在锁屏上处理，不拉起 App
        )
        let snooze = UNNotificationAction(
            identifier: Self.actionSnooze,
            title: "10 分钟后",
            options: []
        )
        let cat = UNNotificationCategory(
            identifier: Self.categoryId,
            actions: [done, snooze],
            intentIdentifiers: [],
            options: []
        )
        center.setNotificationCategories([cat])
        NSLog("[Notifications] 已注册通知分类 \(Self.categoryId)")
    }

    /// 「10 分钟后」：把**同一条内容**再排一次。
    ///
    /// ⚠️ 这里**故意不碰业务**：不重新计算提醒时间、不去改日程 ——
    ///    只是"把刚响的这条，原样晚 10 分钟再响一次"。
    ///    真正改数据（比如「完成」）必须回到网页层，见 ShellBridge。
    func snooze(_ content: UNNotificationContent, minutes: Int = 10, completion: (() -> Void)? = nil) {
        let copy = UNMutableNotificationContent()
        copy.title = content.title
        copy.body = content.body
        copy.userInfo = content.userInfo
        copy.sound = content.sound
        copy.interruptionLevel = content.interruptionLevel
        copy.categoryIdentifier = content.categoryIdentifier
        let trigger = UNTimeIntervalNotificationTrigger(
            timeInterval: TimeInterval(minutes * 60), repeats: false)
        let req = UNNotificationRequest(
            identifier: "snooze-\(UUID().uuidString)", content: copy, trigger: trigger)
        center.add(req) { err in
            if let err { NSLog("[Notifications] 延后提醒排失败：\(err)") }
            completion?()
        }
    }

    /// 请求通知权限。**必须由用户手势触发**（iOS 不允许冷启动自动弹）。
    func requestAuthorization(completion: @escaping (Bool) -> Void) {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, err in
            if let err { NSLog("[Notifications] 授权失败: \(err)") }
            completion(granted)
        }
    }

    /// 重新排全部提醒。
    ///
    /// ⚠️ 每次都**先清空再排**：网页侧给的 id 是稳定的，理论上有它就够；
    ///    但用户在别处删掉日程、或改了提醒时间时，残留的旧通知会照样响 ——
    ///    而"删了还响"比"漏一次"更让人困惑。所以整批替换。
    func replaceAll(with items: [PlannedNotification], completion: (() -> Void)? = nil) {
        center.removeAllPendingNotificationRequests()
        let group = DispatchGroup()
        for item in items where item.fireAt > Date() {
            group.enter()
            add(item) { group.leave() }
        }
        group.notify(queue: .main) { completion?() }
    }

    private func add(_ item: PlannedNotification, completion: @escaping () -> Void) {
        let content = UNMutableNotificationContent()
        content.title = item.title
        content.body = item.body
        content.userInfo = ["eventId": item.eventId, "planId": item.id]
        // 强度档位映射到系统的提示音 / 中断级别。
        //
        // ⚠️⚠️ 两条决定了"最响也就这样"的硬事实（别在这里自作聪明）：
        //
        //   1. **iOS 不开放"通知音量"**。App 唯一能选的是**用哪个声音文件**，
        //      实际多响由用户在「设置 → 声音与触感 → 铃声与提醒」里决定，
        //      App 既读不到也改不了。（iOS 27 才允许单独调"提醒"音量，这台设备没有。）
        //
        //   2. **关键警报（critical alert）需要苹果特批的 entitlement**，免费账号拿不到。
        //      这里原来第 4 档用的是 `.defaultCritical` —— 在没有 entitlement 的情况下
        //      它**可能让通知变成"没声音"**，比第 3 档还弱，
        //      这正是用户报"锁屏提醒没啥声音"的最可疑原因。
        //      所以第 4 档**不再去够这个够不着的能力**。
        //
        // 改成：按档位用**打进包里的三档自定义提示音**（换声音文件不需要任何权限），
        // 让"提示音"本身也成为强度的表达 —— 和气泡大小/颜色、提醒提前量是同一个信号。
        // 1 档保持系统默认音（最短的一声"叮"）。
        //
        // ⚠️ 文件名**都故意超过 15 字节**，别改短：Swift 会把 ≤15 字节的字符串字面量
        //    按内联小字符串编码，编译产物里根本 `strings` 不到（连倒序都搜不到），
        //    于是"改动有没有真的编进去"就无法从产物上验证。详见 tools/gen-alert-sound.mjs。
        //
        // ⚠️ 网页侧给了 `sound` 就用它的（那可能是**用户自己导入的 .caf**）——
        //    这几行 switch 是**兜底**：老计划、或字段缺失时按档位给内置三档。
        if let custom = item.sound, !custom.isEmpty {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(custom))
            content.interruptionLevel = item.intensity >= 3 ? .timeSensitive : .active
        } else {
            switch item.intensity {
            case 4:
                content.sound = UNNotificationSound(named: UNNotificationSoundName("timetable-alert-strong.wav"))
                content.interruptionLevel = .timeSensitive
            case 3:
                content.sound = UNNotificationSound(named: UNNotificationSoundName("timetable-alert.wav"))
                content.interruptionLevel = .timeSensitive
            case 2:
                content.sound = UNNotificationSound(named: UNNotificationSoundName("timetable-alert-soft.wav"))
                content.interruptionLevel = .active
            default:
                content.sound = .default
                content.interruptionLevel = .active
            }
        }
        // 挂上分类，通知上才会出现「完成 / 稍后 10 分钟」两个按钮（见 registerCategories）
        content.categoryIdentifier = Self.categoryId

        // 用**绝对时间**排（不传 repeats）—— 网页侧已经把每个发生点都算成具体时刻了，
        // 这里再做重复规则只会两边不一致。
        let comps = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute, .second], from: item.fireAt)
        let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
        let req = UNNotificationRequest(identifier: item.id, content: content, trigger: trigger)
        center.add(req) { err in
            if let err { NSLog("[Notifications] 排 \(item.id) 失败: \(err)") }
            completion()
        }
    }

    /// 当前还有几条待处理 —— 调试用（iOS 上限 64，超过的部分系统不会保留）
    func pendingCount(completion: @escaping (Int) -> Void) {
        center.getPendingNotificationRequests { completion($0.count) }
    }
}
