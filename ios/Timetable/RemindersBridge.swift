// 语音桥：把日程写进系统「提醒事项」，好让 **Siri 原生**读得到、也加得进来。
//
// ⚠️⚠️ 为什么是「提醒事项」而不是别的：
//   前面试过"写文件 + 快捷指令"，技术上通了，但**用户侧摩擦太大** ——
//   要建快捷指令、选对动作、按类型过滤、关掉"运行时显示"；
//   而且实测踩到 `public.plain-text` **同时匹配 .txt 和 .json**，
//   Siri 把两份文件连起来念（文本后面跟一坨 JSON）。
//   「提醒事项」是**苹果原生支持 Siri 的**：
//     · 念：「嘿 Siri，日程表里有什么」
//     · 加：「嘿 Siri，在日程表里加：明天下午3点开会」
//   **一个快捷指令都不用建**，上面的坑全都不存在。
//
// ⚠️ **这一层只做翻译，不做判断**：
//   哪些日程要写出去、用户加的那条怎么变成事件、要不要设闹铃 ——
//   全部由 core/voice-bridge.js 算好。这里只负责调 EventKit。
//   一旦这里也判断一次，就会和网页端分叉（本项目一直在避免的事）。
//
// ⚠️ 会写进用户的**真实数据**（他自己的提醒事项），所以必须克制：
//   · 只动我们**专用清单**里的东西（名字由 core 给，用户会用嘴说它）
//   · 只删**带我们标记**的条目 —— 用户自己加的、或者别的 App 加的一律不碰
//
// ⚠️ 权限：`NSRemindersFullAccessUsageDescription`（iOS 17+）/
//   `NSRemindersUsageDescription`（更早）。这是**隐私权限**，不是 entitlement，
//   免费账号没问题。

import Foundation
import EventKit

final class RemindersBridge {
    static let shared = RemindersBridge()

    private let store = EKEventStore()
    // ⚠️ EventKit 的 EKEventStore **不是线程安全**的，所有调用串行化到一条队列上。
    private let queue = DispatchQueue(label: "timetable.reminders")

    /// 最近一次同步的结果，给网页层显示用（用户在设备上看不到日志）
    private(set) var lastStatus: [String: Any] = [:]

    /// 申请「提醒事项」权限。和通知权限一样是系统弹窗，可以程序化调用。
    func requestAccess(completion: @escaping (Bool) -> Void) {
        let finish: (Bool, Error?) -> Void = { ok, err in
            if let err { NSLog("[Reminders] 申请权限失败：\(err)") }
            NSLog("[Reminders] 权限结果：\(ok)")
            DispatchQueue.main.async { completion(ok) }
        }
        if #available(iOS 17.0, *) {
            store.requestFullAccessToReminders(completion: finish)
        } else {
            store.requestAccess(to: .reminder, completion: finish)
        }
    }

    /// 当前有没有权限（不弹窗，只读状态）
    var authorized: Bool {
        let s = EKEventStore.authorizationStatus(for: .reminder)
        if #available(iOS 17.0, *) {
            return s == .fullAccess
        }
        return s == .authorized
    }

    /// 同步一次：把镜像写进去，并把用户自己加的读回来。
    ///
    /// - Parameters:
    ///   - listName: 专用清单名（由 core 给，用户会用嘴说它）
    ///   - mirrorMark: 我们写进去的标记（用来区分"我们写的"和"用户加的"）
    ///   - mirror: 要写进去的条目 `{key,title,due,notes}`
    ///   - completion: 主线程回调 —— `{ok, status, added, removed, inbound:[{title,notes,due,key}]}`
    func sync(listName: String, mirrorMark: String,
              mirror: [[String: Any]],
              completion: @escaping ([String: Any]) -> Void) {
        guard authorized else {
            let out: [String: Any] = ["ok": false, "status": "unauthorized"]
            lastStatus = out
            DispatchQueue.main.async { completion(out) }
            return
        }
        queue.async { [weak self] in
            guard let self else { return }
            guard let cal = self.ensureList(named: listName) else {
                let out: [String: Any] = ["ok": false, "status": "no-list"]
                self.lastStatus = out
                DispatchQueue.main.async { completion(out) }
                return
            }
            // 取这个清单里的全部提醒
            let predicate = self.store.predicateForReminders(in: [cal])
            self.store.fetchReminders(matching: predicate) { reminders in
                let all = reminders ?? []
                // ---- ① 读回来：用户自己加的（没有我们的标记、且没完成）----
                var inbound: [[String: Any]] = []
                for r in all {
                    let notes = r.notes ?? ""
                    if notes.contains(mirrorMark) { continue }      // 我们写的镜像
                    if r.isCompleted { continue }                    // 已经做掉的
                    inbound.append([
                        "title": r.title ?? "",
                        "notes": notes,
                        "due": Self.localStamp(r.dueDateComponents),
                        "key": r.calendarItemIdentifier,
                    ])
                }
                // ---- ② 清掉我们上一次写的镜像（只清带标记的）----
                var removed = 0
                for r in all where (r.notes ?? "").contains(mirrorMark) {
                    do { try self.store.remove(r, commit: false); removed += 1 }
                    catch { NSLog("[Reminders] 删除镜像条目失败：\(error)") }
                }
                // ---- ③ 写这一批新的 ----
                var added = 0
                for item in mirror {
                    guard let title = item["title"] as? String, !title.isEmpty else { continue }
                    let r = EKReminder(eventStore: self.store)
                    r.title = title
                    r.notes = item["notes"] as? String ?? ""
                    r.calendar = cal
                    // ⚠️ **只给到期时间，不设闹铃** —— 否则用户会同时收到
                    //    "我们 App 的提醒"和"提醒事项的提醒"两条，会让人直接关掉这功能。
                    //    （要闹铃的话，那是另一个开关，见 core/voice-bridge.js 的说明。）
                    if let due = item["due"] as? String { r.dueDateComponents = Self.components(due) }
                    do { try self.store.save(r, commit: false); added += 1 }
                    catch { NSLog("[Reminders] 写镜像条目失败：\(error)") }
                }
                do { try self.store.commit() }
                catch { NSLog("[Reminders] commit 失败：\(error)") }

                let out: [String: Any] = [
                    "ok": true, "status": "ok",
                    "added": added, "removed": removed,
                    "inbound": inbound,
                ]
                self.lastStatus = out
                NSLog("[Reminders] 同步完成：写入 \(added)、清理 \(removed)、读回 \(inbound.count)")
                DispatchQueue.main.async { completion(out) }
            }
        }
    }

    // ------------------------------------------------------------------
    // 下面全是 EventKit 的机械翻译，没有业务判断
    // ------------------------------------------------------------------

    /// 找到（或创建）专用清单
    private func ensureList(named name: String) -> EKCalendar? {
        let existing = store.calendars(for: .reminder).first { $0.title == name }
        if let existing { return existing }
        guard let source = store.defaultCalendarForNewReminders()?.source else {
            NSLog("[Reminders] 找不到可用的 source，建不了清单")
            return nil
        }
        let cal = EKCalendar(for: .reminder, eventStore: store)
        cal.title = name
        cal.source = source
        do {
            try store.saveCalendar(cal, commit: true)
            NSLog("[Reminders] 已创建清单「\(name)」")
            return cal
        } catch {
            NSLog("[Reminders] 创建清单失败：\(error)")
            return nil
        }
    }

    /// `YYYY-MM-DDTHH:MM:SS` → DateComponents（⚠️ 只给年月日时分，**不给 alarm**）
    private static func components(_ stamp: String) -> DateComponents? {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = stamp.count == 10 ? "yyyy-MM-dd" : "yyyy-MM-dd'T'HH:mm:ss"
        guard let d = f.date(from: stamp) else { return nil }
        return Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: d)
    }

    /// DateComponents → `YYYY-MM-DDTHH:MM:SS`（读回来给网页层，格式和别处一致）
    private static func localStamp(_ c: DateComponents?) -> String {
        guard let c, let y = c.year, let m = c.month, let d = c.day else { return "" }
        let hh = c.hour ?? 0
        let mm = c.minute ?? 0
        return String(format: "%04d-%02d-%02dT%02d:%02d:00", y, m, d, hh, mm)
    }
}
