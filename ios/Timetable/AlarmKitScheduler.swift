// 用 **AlarmKit** 把"最高档"的提醒做成**系统级真闹钟**。
//
// ⚠️ 为什么值得接（这是实测出来的，不是猜的）：
//   iOS 26 的 AlarmKit 让第三方 App 能创建**真闹钟** ——
//   满音量、**无视静音开关**、**穿过专注模式**、锁屏全屏响到你按掉。
//   而普通通知（哪怕带自定义提示音 + 时效性）做不到这些：
//     · 音量归系统管，App 改不了
//     · 静音开关一拨就没了
//     · 专注模式能压住（除非用户允许时效性通知）
//   探针 App 实测结论（iOS 26.6 / iPad / 免费 Apple ID 侧载）：
//     · 启动不崩   · requestAuthorization → authorized（**不需要任何 entitlement**）
//     · schedule 成功   · **到点真的响** ✓
//
// ⚠️⚠️ 但它有一个**无法绕开**的代价，用户必须知道：
//   **真闹钟在设计上就无法被专注模式压住** —— 那正是它"强"的来源。
//   所以这个文件只服务**最高档（intensity 4）**，而且：
//     · 用户不把某条日程设成最高档 → 它永远不会炸到人
//     · 没授权 / 系统低于 26 → 自动退回普通通知（见 ShellBridge 的分流）
//   绝不要"因为真闹钟更强就全都用它" —— 那等于把专注模式废掉。
//
// ⚠️ 这一层**只做翻译**：哪些提醒、什么时候响、文案是什么，全部由网页侧算好
//   （core/notify-plan.js）。这里不判断业务，只判断"系统能不能做"。

import Foundation
import SwiftUI
import AlarmKit

/// AlarmKit 要求元数据类型是**具体类型**且 **nonisolated**
/// （Xcode 26 的工程默认把类型标成 MainActor 隔离，不加会编译不过）
nonisolated struct TimetableAlarmMetadata: AlarmMetadata {}

/// 哪一档该做成真闹钟。
///
/// ⚠️ 两个条件**都要**满足，缺一不可：
///   ① `useAlarm`：用户在编辑器里给**这条日程**勾了"用真闹钟"
///      —— 默认不勾，所以不勾的日程**永远不会**炸穿专注模式；
///   ② `intensity >= 4`：按剩余时间算出来已经是最高档（最后一小时 / 已过期）。
///
///   为什么②也要：勾了它意味着"这件事绝对不能错过"，但**不代表**
///   要提前一天就拉响闹钟。所以勾了之后是"**到最后一小时才炸**"，
///   前面那些（提前一天、提前一小时）仍然只是普通通知。
///   两个条件合成一句话就是：**勾了它，最后关头的提醒会变成真闹钟。**
///
/// ⚠️ 这个函数**故意放在 `@available` 外面**：它是纯判断，不该要求调用方
///   先做一次 availability 检查 —— 否则 ShellBridge 里到处都要包 `if #available`。
func isAlarmIntensity(_ item: PlannedNotification) -> Bool {
    item.useAlarm && item.intensity >= 4
}

/// 真闹钟的调度器。**只在 iOS 26+ 存在**。
///
/// ⚠️⚠️ 所有对 `AlarmManager` 的访问都写在 `Task { @MainActor in … }` 里，原因：
///   `AlarmManager` 的状态访问受 **actor 隔离**约束，从非 MainActor 的上下文
///   **同步**读会直接编译失败（"main actor-isolated property can not be
///   referenced from a non-isolated context"）。
///   而我从 SDK 导出的符号图里**看不出**哪些成员带隔离 —— 所以统一用
///   `Task { @MainActor in }` 把访问包起来：这样无论隔离与否都能过，
///   代价只是要读状态的地方改读缓存（见下面两个 cached 字段）。
@available(iOS 26.0, *)
final class AlarmKitScheduler {
    static let shared = AlarmKitScheduler()

    private let manager = AlarmManager.shared

    /// 最多排几个真闹钟。
    ///
    /// ⚠️ AlarmKit 有数量上限（`AlarmError.maximumLimitReached`），而且每个闹钟
    ///    都会占一个 Live Activity —— 排太多既会撞上限，也可能被系统丢掉。
    ///    所以只排**最近的 N 个**：更远的等 App 下次打开重排时再进来
    ///    （和通知那条路"64 条上限、每次重排把时间窗往前推"是同一个思路）。
    static let maxAlarms = 8

    /// 缓存的可用性（框架真的加载到了 = 我们跑到了这里）
    private(set) var available = false
    /// 缓存的授权状态 —— 供非 MainActor 的调用方**同步**读
    private(set) var authorized = false

    /// 刷新缓存状态。App 启动时调一次、申请授权之后再调一次。
    func refresh() {
        Task { @MainActor in
            available = true
            authorized = (manager.authorizationState == .authorized)
            NSLog("[AlarmKit] 状态：available=true authorized=\(authorized)")
        }
    }

    /// 申请闹钟权限。
    /// ⚠️ 与通知权限一样是**系统弹窗**；在 App 启动时调用即可（实测可行）。
    ///    拿不到就安静退回普通通知，不要反复骚扰用户。
    func requestAuthorization(completion: @escaping (Bool) -> Void) {
        Task { @MainActor in
            do {
                let s = try await manager.requestAuthorization()
                authorized = (s == .authorized)
                NSLog("[AlarmKit] 申请授权 → \(String(describing: s))")
                completion(authorized)
            } catch {
                NSLog("[AlarmKit] 申请授权抛错：\(error)")
                completion(false)
            }
        }
    }

    /// 重新排全部真闹钟。
    ///
    /// ⚠️ 和通知那条路一样：**先清空再排**。"删了还响"比"漏一次"更糟。
    func replaceAll(with items: [PlannedNotification], completion: (() -> Void)? = nil) {
        let future = items.filter { $0.fireAt > Date() }
        Task { @MainActor in
            // 清掉上一批（只清我们自己排过的 id，不动系统里别的闹钟）
            for id in scheduledIDs { try? manager.cancel(id: id) }
            scheduledIDs.removeAll()

            guard authorized else {
                NSLog("[AlarmKit] 没授权，这 \(future.count) 条不做成真闹钟（会退回普通通知）")
                completion?()
                return
            }
            let picked = Array(future.prefix(Self.maxAlarms))
            if future.count > picked.count {
                NSLog("[AlarmKit] 只排最近的 \(picked.count) 个真闹钟（共 \(future.count) 个）")
            }
            for item in picked {
                do {
                    let id = UUID()
                    let cfg = AlarmManager.AlarmConfiguration<TimetableAlarmMetadata>.alarm(
                        schedule: Alarm.Schedule.fixed(item.fireAt),
                        attributes: Self.attributes(for: item)
                    )
                    _ = try await manager.schedule(id: id, configuration: cfg)
                    scheduledIDs.append(id)
                    NSLog("[AlarmKit] 排真闹钟 \(item.id) @ \(item.fireAt)")
                } catch {
                    NSLog("[AlarmKit] 排 \(item.id) 失败：\(error)")
                }
            }
            completion?()
        }
    }

    /// 自己排出去的那些 id —— `AlarmManager` 没有"取消全部"的接口，
    /// 所以要自己记账，取消时逐个来。
    private var scheduledIDs: [UUID] = []

    /// 闹钟长什么样。
    ///
    /// ⚠️ 标题要**短**：锁屏横幅会截断得很厉害（官方建议 4–5 个词），
    ///    所以这里硬截断，而不是把整句塞进去。
    private static func attributes(for item: PlannedNotification) -> AlarmAttributes<TimetableAlarmMetadata> {
        // ⚠️⚠️ `title` 的类型是 **`LocalizedStringResource`，不是 `String`**
        //    （`AlarmButton.text` 也一样）。探针里能过是因为那边写的是**字面量**，
        //    编译器会自动转；而这里是运行时字符串，必须显式构造。
        //    第一版直接传 String，编译报：
        //      error: cannot convert value of type 'String' to expected argument type 'LocalizedStringResource'
        let alert = AlarmPresentation.Alert(
            title: LocalizedStringResource(stringLiteral: String(item.title.prefix(20))),
            stopButton: AlarmButton(
                text: "知道了",
                textColor: .white,
                systemImageName: "checkmark"
            ),
            // 第二个按钮：真闹钟上多一个「稍后 5 分钟」。
            // ⚠️ `.countdown` 是系统内置的"稍后再响"语义（`.custom` 那个要配 intent）。
            //    这两个 case 是从 SDK 导出的接口里**确认存在**的，不是猜的：
            //      enum AlarmPresentation.Alert.SecondaryButtonBehavior { countdown, custom }
            //    ⚠️ 但**具体行为只能真机上试** —— 我这边只能证明它编译得过。
            secondaryButton: AlarmButton(
                text: "稍后 5 分钟",
                textColor: .white,
                systemImageName: "clock.arrow.circlepath"
            ),
            secondaryButtonBehavior: .countdown
        )
        // ⚠️⚠️ `sound` 这里**故意不传**（保持默认的 `.default`）—— 这是一个**有证据的决定**，
        //    不是"懒得做"。结论：**AlarmKit 的自定义提示音在 iOS 26 上是坏的，别用。**
        //
        //    ① 接口是存在的（这点我先确认过，免得把"没有 API"当成理由）：
        //       `AlarmManager.AlarmConfiguration.alarm(schedule:attributes:stopIntent:secondaryIntent:sound:)`
        //       —— 最后一个参数就是 `sound: AlertConfiguration.AlertSound = .default`；
        //       而 `AlertConfiguration.AlertSound.named(String)` 是 ActivityKit 的公开 API
        //       （s:11ActivityKit18AlertConfigurationV0C5SoundV）。
        //       我是从 `build/alarmkit-api/AlarmKit.symbols.json`（SDK 符号导出）里读出来的。
        //
        //    ② 但开发者论坛上**多份独立报告**说：真机上它**不放你给的音，改放系统错误音**
        //       （"AlarmKit custom sounds are universally broken in iOS 26.0 stable —
        //         instead of playing your custom sound, it plays a system error" /
        //         "AlarmKit plays system error tone instead of custom sound files (iOS 26.0)"）。
        //       链接见 docs/IOS-NATIVE.md 的"真闹钟的声音"一节。
        //
        //    ③ 为什么宁可用默认音也不用它：真闹钟服务的是"**绝对不能错过**"的那些日程。
        //       万一真的踩到那个 bug，用户在**最关键的那一刻**听到的是一声系统错误音 ——
        //       比"普通的闹钟音"糟得多。**拿不准的东西不能放在最要命的那条路上。**
        //
        //    → 自定义提示音只作用在**普通通知**上（那条路是 `UNNotificationSound(named:)`，
        //      本地通知用它十几年了，可靠）。等苹果修了，这里加一个参数就能开。
        return AlarmAttributes(
            presentation: AlarmPresentation(alert: alert),
            // 和主界面的"最高档"用同一个橙色系，让用户一眼看出这是哪一档
            tintColor: .orange
        )
    }

    /// 系统里现在有几个真闹钟（调试用）。
    /// ⚠️ `AlarmManager.alarms` 是**会抛错的属性** —— 必须 `try`，而且要先赋给
    ///    局部变量再取 `.count`（写成 `try manager.alarms.count` 编译器会挑刺）。
    ///    这是探针第一次编译失败的地方，原话：
    ///      error: property access can throw, but it is not marked with 'try'
    func refreshSystemCount() {
        Task { @MainActor in
            do {
                let list = try manager.alarms
                NSLog("[AlarmKit] 系统里现在有 \(list.count) 个闹钟")
            } catch {
                NSLog("[AlarmKit] 读系统闹钟失败：\(error)")
            }
        }
    }
}
