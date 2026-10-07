// 自定义提示音：让用户把自己的一段音频换成提醒的声音。
//
// ⚠️⚠️ 三条硬约束（都是系统定的，不是我挑的）：
//
//   1. **文件必须放在 `<App 容器>/Library/Sounds`**。
//      通知的 `UNNotificationSound(named:)` 按这个顺序找：App 容器的 Library/Sounds →
//      App 群组容器 → 主 bundle。所以**运行时写进去的声音能被找到** ——
//      不用重新打包、不用任何权限。（Apple 文档 "Preparing custom alert sounds"）
//
//   2. **只支持 aiff / wav / caf，而且必须短于 30 秒**。超了或格式不对，
//      系统的行为是"**直接放默认音，且不报错**" —— 属于最难查的一类问题。
//      所以这里主动把音频**转成 Linear PCM 16-bit / 44.1kHz / 单声道 / .caf**，
//      并且**只取前 30 秒**（用户可以直接选一段短的，或让整首歌只取开头）。
//
//   3. **文件名不要复用**。系统会缓存提示音，覆盖同名文件有时还是放旧的那段。
//      所以每次导入都生成一个新名字（随机 8 位十六进制），**而且不删旧的** ——
//      用户导入的每一首都是独立的铃声，谁也不会顶掉谁（2026-10-02 改，见下面 L40）。
//      ⚠️ 名字前缀 **故意超过 15 字节**（`timetable-custom-` = 17 字节）：
//         Swift 把 ≤15 字节的字符串字面量按内联小字符串编码，编译产物里
//         `strings` **一个字节都搜不到**，于是"这段代码到底有没有编进去"就无法
//         从产物上验证（这个项目已经栽过一次）。名字长一点没有任何代价。
//         ⚠️ 前缀从 `timetable-custom-t` 改成 `timetable-custom-` 之后仍是 17 字节，
//            这条约束还在（别顺手缩短它）。
//
// ⚠️ 另外：**真闹钟（AlarmKit）那一档不用这个音** —— 见 AlarmKitScheduler 里的说明
//    （iOS 26 上 AlarmKit 的自定义音是坏的，会放系统错误音）。
//
// ⚠️ UIKit 相关的两处（弹窗、找 presenter）标了 `@MainActor`，调用方要像
//    AlarmKit 那边一样用 `Task { @MainActor in … }` 包起来 —— 这是这个工程里
//    已经验证过能过编译的写法（Xcode 26 的 SDK 对 MainActor 隔离挑得很严）。

import Foundation
import AVFoundation
// ⚠️ 2026-10-02 新增：裸 AAC（ADTS）那条最后的路要用 Core Audio 的
//    `AudioFileOpenURL` / `ExtAudioFile*` —— 那几个都在 AudioToolbox 里。
//    （AVFoundation 会把 AudioToolbox 带进来，但**不保证**它的符号在 Swift 里可见；
//      显式 import 一行、编译期就稳，成本是一个 import。）
import AudioToolbox
import UniformTypeIdentifiers
import UIKit

final class CustomSoundLibrary: NSObject {
    static let shared = CustomSoundLibrary()

    /// 文件名前缀（>15 字节，见文件头第 3 条）
    static let namePrefix = "timetable-custom-"

    /// ⚠️⚠️ 2026-10-02 **把"档位"整个删掉**（用户要求"一个自定义有时候可能不够用"）。
    ///
    /// 旧设计是"一个 tier 一个槽"：文件名里带 `-t<tier>-`，导入时
    /// `removePrevious(tier:)` 把**同档上一次那个删掉** —— 于是每档**只能留一首**。
    /// 用户看到的就是"导了第二首，第一首没了"，界面上还会拿橙色警告烦他。
    ///
    /// 新设计：**每一首都是自己一个文件、自己一个 id**，谁也不顶掉谁。
    ///   · 文件名 = `timetable-custom-<token>.caf`，`token` 是 8 位十六进制的随机串；
    ///   · 这个 token 就是 core 那边的**自定义 id**（`custom:<token>`）；
    ///   · 闹钟的 `sound` 字段存 `custom:<token>`，取文件名时现查（见 `web/adapter`）。
    ///
    /// ⚠️ 老的 `timetable-custom-t0-1696….caf` 文件**不再被这个名字规则承认** ——
    ///    但**不删**它（用户可能还在别处用着）。`isSafeName` 也**必须继续放行**它，
    ///    否则 `/__sounds/` 那条路由会拒掉老文件，用户"以前导的那首"就试听不了。
    ///    （`legacyTierPattern` 就是为这件事留的。）

    /// ⚠️ 老文件名（带档位的那些）的前缀 —— **留着是为了认出用户以前导的文件**：
    ///    那些文件还在容器里，老闹钟的 `sound` 存的是老 id `'custom'`，
    ///    认不出这个名字 = 他"以前导的那首"在铃声列表里消失了 = 到点静默响默认音。
    ///    ⚠️ 这个常量本身也是**留给产物验证的锚点**（>15 字节才搜得到，
    ///    见 `tools/ios-verify-ipa.mjs`）—— 别把它内联回 `isLegacyName` 里。
    static let legacyNamePrefix = "timetable-custom-t0-"

    /// 老文件名（带档位的那些）的识别用：`timetable-custom-t0-1696000000.caf`
    private static func isLegacyName(_ name: String) -> Bool {
        name.hasPrefix(Self.legacyNamePrefix) && name.hasSuffix(".caf")
    }

    /// 新文件名 → id（不是新格式就返回 nil）
    static func soundId(ofFile name: String) -> String? {
        guard name.hasPrefix(namePrefix), name.hasSuffix(".caf") else { return nil }
        let token = String(name.dropFirst(namePrefix.count).dropLast(4))
        // 8 位十六进制（小写）—— 和生成处一一对应，别放宽（放宽等于允许拼路径）
        guard token.count == 8, token.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else {
            return nil
        }
        return token
    }

    /// 这个文件名是不是"我们自己导入的、能当铃声用的"（新格式或老格式都算）
    static func isAlarmSlot(_ name: String) -> Bool {
        soundId(ofFile: name) != nil || isLegacyName(name)
    }

    /// 名字是否**可以安全使用**（本地 HTTP 服务要拿它拼路径，所以必须严格）。
    ///
    /// ⚠️ 这不是"防呆"，是**防目录穿越**：`/__sounds/` 那条路由拿网页传来的名字拼路径，
    ///    如果放行 `../../Documents/db.json` 就成了任意文件读取。
    ///    规则：必须是我们自己的前缀、不能含路径分隔符、不能含 `..`。
    ///    ⚠️ 2026-10-02 补：**老格式（带 tier 的）也必须继续放行** ——
    ///    用户以前导的音频还在容器里，收紧校验会把它们变成"读不了的文件"。
    static func isSafeName(_ name: String) -> Bool {
        guard name.hasPrefix(namePrefix) else { return false }
        if name.contains("/") || name.contains("\\") || name.contains("..") { return false }
        if name.contains("\0") { return false }
        guard name.hasSuffix(".caf") else { return false }
        // 前缀之后就只剩"安全字符"（字母数字连字符）—— 挡掉 `timetable-custom-../x.caf`
        let stem = String(name.dropFirst(namePrefix.count).dropLast(4))
        return !stem.isEmpty && stem.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" }
    }

    /// ⚠️ 这个常量**不是给人看的，是给验证用的**（故意写长）：
    ///    真正要用的目录名是 `Sounds` —— 它只有 6 字节，Swift 会按内联小字符串编码，
    ///    编译产物里 `strings` 一个字节都搜不到，于是"这段代码到底有没有编进去"就
    ///    无法从产物上验证。所以另外留一个长句子，`tools/ios-verify-ipa.mjs` 搜它。
    static let dirLogTag = "[Sound] 自定义提示音目录 Library/Sounds（通知声音的规定位置）"

    /// 系统对通知声音的硬上限：**30 秒**（含）以内
    static let maxSeconds: Double = 30

    private var pendingCompletion: ((Result<String, Error>) -> Void)?

    private static func err(_ msg: String) -> NSError {
        NSError(domain: "TimetableSound", code: 1, userInfo: [NSLocalizedDescriptionKey: msg])
    }

    /// 生成一个新的铃声 id（8 位小写十六进制）。
    ///
    /// ⚠️ 会**主动检查撞名**：容器里已经有同名文件就重摇一次（最多 20 次）。
    ///    理论上撞不上，但"理论上不会"正是 bug 最喜欢的藏身处 —— 而这里的后果是
    ///    **用户新导入的那首把旧的一首覆盖掉**（旧闹钟还会指着同一个文件名响，
    ///    响的却是新歌），所以宁可多写 6 行。
    private static func newToken() -> String {
        let dir = CustomSoundLibrary.shared.soundsDirectory()
        let existing = Set(
            ((try? FileManager.default.contentsOfDirectory(atPath: dir?.path ?? "")) ?? [])
                .compactMap { soundId(ofFile: $0) }
        )
        for _ in 0..<20 {
            let token = String(format: "%08x", UInt32.random(in: 0...UInt32.max))
            if !existing.contains(token) { return token }
        }
        // 20 次全撞（不可能，除非随机源坏了）：用时间戳兜底，**绝不能返回空串**
        return String(format: "%08x", UInt32(truncatingIfNeeded: Int(Date().timeIntervalSince1970)))
    }

    /// `<App 容器>/Library/Sounds`（不存在就建）
    func soundsDirectory() -> URL? {
        let fm = FileManager.default
        guard let lib = fm.urls(for: .libraryDirectory, in: .userDomainMask).first else { return nil }
        let dir = lib.appendingPathComponent("Sounds", isDirectory: true)
        if !fm.fileExists(atPath: dir.path) {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            NSLog(Self.dirLogTag)
        }
        return dir
    }

    /// 现在容器里有哪些自定义提示音（网页侧拿它核对设置里记的名字还在不在）
    ///
    /// ⚠️⚠️ 2026-10-02 补（用户报「我导入了三个音频，为啥列表里有好几个」）：
    ///    **必须再问一句"这个文件里真的有声音吗"** —— 见 `isPlayable`。
    ///    以前只按文件名形状过滤，于是**每次失败的导入都在列表里留下一条假的**
    ///    （0 帧的 .caf 残骸长得和真的一模一样），用户点了它还没有声音。
    func list() -> [String] {
        guard let dir = soundsDirectory() else { return [] }
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return files
            .filter { $0.hasSuffix(".caf") }
            .filter { Self.isPlayable(dir.appendingPathComponent($0)) }
            .sorted()
    }

    /// 这个 caf **真的有声音**吗（能打开、而且长度 > 0）。
    ///
    /// ⚠️ 为什么值得单独一个函数（这不是洁癖，是一次真机投诉）：
    ///    以前的导入**直接往 `Library/Sounds` 里写最终文件名**，于是任何一步失败
    ///    （格式转换不支持、写完之前抛错）都会留下一个残骸文件。而"本机有哪几首"
    ///    是按**文件名的形状**过滤的（前缀 + 8 位十六进制）—— 残骸完全符合，
    ///    于是每次失败的导入都在铃声列表里多出一首**点了没声音的假铃声**。
    ///    现在两件事一起做：导入改成**原子**的（`writeAlarmSound` 只写临时文件，
    ///    成功才搬成最终名字），并且这里把**已经躺着的残骸认出来挪走**（自愈）。
    ///
    /// ⚠️ 判据只认"**能打开、而且长度恰好是 0**"：
    ///    · 打不开的文件**保守地留下** —— 那可能是我们以后才支持的格式，
    ///      当成垃圾删掉就是在删用户的音频；
    ///    · 长度 > 0 一律留下 —— 只有"失败的导入"会产生 0 帧的文件。
    ///
    /// ⚠️⚠️ 2026-10-02 改：从"**删掉**"改成"**改名隔离**"（`.unplayable-<原名>`）。
    ///    理由是用户那次投诉里有个我解释不了的现象：他上一版明明导进过 3 首，
    ///    装新包之后连那 3 首也不见了（界面上写「还没有导入过」）。两种可能
    ///    —— 重装换了容器、或者就是这段自愈**误删了它们**（`length` 读成 0 不代表没声音：
    ///    头没落盘、文件正在被写，都会读成 0）。我分不清是哪种，那就**别删**：
    ///    改名之后它不会再被列出来（`soundId(ofFile:)` 不认带 `.` 的名字），
    ///    但字节还在，随时能捞回来。护栏可以少做事，不可以毁数据。
    static func isPlayable(_ url: URL) -> Bool {
        guard let f = try? AVAudioFile(forReading: url) else { return true }
        if f.length > 0 { return true }
        let dest = url.deletingLastPathComponent()
            .appendingPathComponent(".unplayable-\(url.lastPathComponent)")
        NSLog("[Sound] 隔离一个 0 帧的自定义铃声（失败的导入留下的）：\(url.lastPathComponent)")
        do {
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.moveItem(at: url, to: dest)
        } catch {
            // ⚠️ 挪不动就**什么都不做**：让它继续出现在列表里，也比"没声音又占着名字"好
            //    —— 至少用户看得见它，我们能从日志里知道发生了什么。
            NSLog("[Sound] 隔离失败（改名没成）：\(url.lastPathComponent) — \(error)")
        }
        return false
    }

    /// 网页侧要的**结构化名单**：每首一条 `{id, name, file}`。
    ///
    /// ⚠️ 这才是 2026-10-02 之后界面上的"自定义铃声列表" —— `list()`（裸文件名）
    ///    保留是因为它还被别处用来做存在性检查，但**别拿它当列表用**：
    ///    那边只有文件名，界面要显示"自定义 · 3f9a"就得自己去前缀去后缀，
    ///    三处各写一遍必然有一天不一致。
    ///
    /// `name` 故意留空（用户没给它起名字，改名是下一步的事）——
    /// core 那边的 `soundLabelOf` 会在没有 name 时退回显示 id。
    func sounds() -> [[String: String]] {
        list().compactMap { file in
            guard let id = Self.soundId(ofFile: file) else { return nil }
            return ["id": id, "name": "", "file": file]
        }
    }

    /// **闹钟槽**当前那个文件名；没有就返回空串。
    ///
    /// ⚠️ 2026-10-01 加、**2026-10-02 变了含义**：以前它是"闹钟唯一那一首"，
    ///    现在多首共存，它只是"名字最大的那一首" —— **只有老客户端/日志还能看它**。
    ///    网页侧请一律用 `sounds()`（数组），不要再用这个单数接口去猜"用户选的是哪首"。
    ///
    /// 这条注释以前写着"将来支持多个要改成返回数组"—— 那个"将来"就是今天，
    /// 数组版叫 `sounds()`。**留着这个单数版是为了不让老版本网页接口消失**。
    func alarmSlotFile() -> String {
        guard let dir = soundsDirectory() else { return "" }
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        // 时间戳/随机串在名字里，降序 = 最新的那个优先
        return files.filter { Self.isAlarmSlot($0) }.sorted(by: >).first ?? ""
    }

    func delete(_ name: String) -> Bool {
        // ⚠️ 只允许删我们自己的文件：名字必须带前缀，且不能含路径分隔符
        guard name.hasPrefix(Self.namePrefix), !name.contains("/") else {
            NSLog("[Sound] 拒绝删除不属于我们的文件：\(name)")
            return false
        }
        guard let dir = soundsDirectory() else { return false }
        do {
            try FileManager.default.removeItem(at: dir.appendingPathComponent(name))
            NSLog("[Sound] 已删除 \(name)")
            return true
        } catch {
            NSLog("[Sound] 删除失败 \(name)：\(error)")
            return false
        }
    }

    // MARK: - 选文件

    /// 弹系统文件选择器让用户挑一段音频。
    ///
    /// ⚠️ 2026-10-02：**没有 tier 参数了**（以前是"替换第几档"）。
    ///    现在选中的音频总是**作为新的一首加进列表**（老的 `tier` 语义会让
    ///    "用户以为在加一首、其实顶掉了另一首"这种静默覆盖重新长出来）。
    ///
    /// ⚠️ `asCopy: true` 很关键：它会**把用户选的文件拷进我们自己的临时目录**，
    ///    于是不用处理"安全作用域书签"（文件 App / iCloud 里的文件默认在沙箱外）——
    ///    少了这一步，读文件会静默失败或抛权限错。
    @MainActor
    func presentPicker(completion: @escaping (Result<String, Error>) -> Void) {
        guard let presenter = Self.topViewController() else {
            completion(.failure(Self.err("找不到可以弹窗的界面")))
            return
        }
        pendingCompletion = completion
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.audio], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        presenter.present(picker, animated: true)
        NSLog("[Sound] 已弹出选文件")
    }

    /// 顶上那个可见的 view controller（从它弹 picker 才不会被吞掉）
    @MainActor
    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let windows = scenes.flatMap { $0.windows }
        let window = windows.first { $0.isKeyWindow } ?? windows.first
        var vc = window?.rootViewController
        while let presented = vc?.presentedViewController { vc = presented }
        return vc
    }

    // MARK: - 转换

    /// 把任意音频转成"通知**和闹钟**都能用的那一份"并写进 `Library/Sounds`。
    /// 返回最终的文件名（**不带路径**，可以直接喂给 `UNNotificationSoundName`
    /// 或 AlarmKit 的 `AlertConfiguration.AlertSound.named(...)`）。
    ///
    /// ⚠️ **两条解码路径，先快后慢**（2026-10-01 定稿）：
    ///
    ///   ① `AVAudioFile`（本函数）—— 对 wav / m4a / mp3 / caf 都够用，**同步、几十毫秒**。
    ///   ② `transcodeToM4A(src:)`（下面那个方法）—— 用 **`AVAssetExportSession`**
    ///      把源文件转成 m4a，然后再走 ①。**这条路是为 `.aac` 那种容器准备的。**
    ///
    ///   **真机事故（必须记住）**：用户从「文件」里选了一个 `.aac`（其实是 **MP4 容器**：
    ///   `codec_tag=mp4a / major_brand=iso5`），路径 ① 抛
    ///   `com.apple.coreaudio.avfaudio 错误 1937337955`。
    ///
    ///   ⚠️⚠️ **那个数字我一开始读错了**：`1937337955` = `0x73796E63` = **`'sync'`**，
    ///   **不是** `'!dat'`（`!dat` = `0x21646174` = 560297332）。
    ///   教训：**别拿一个没核实的数当依据** —— 我据此写的注释在仓库里躺了半天。
    ///
    ///   ⚠️ 中间还**撤回过一版**：我曾直接手写 `AVAssetReader` 读 PCM，两次 CI 都在
    ///   `AVAssetTrack has no member 'naturalTimeRange'` 编译失败
    ///   （那是 `AVAsset` 的成员，不是 `AVAssetTrack` 的）——
    ///   而当时我以为"失败时拿不到日志"，于是在没有编译器反馈的情况下盲改，两次都没到真原因。
    ///   **真相是失败构建也上传 artifacts**（见 `tools/build-log.mjs`）。
    ///   **现在用文档化程度最高的那条路（`AVAssetExportSession`）。**
    func importAudio(from src: URL) throws -> String {
        // ⚠️ 2026-10-02 用户报「我平板上能正常听、电脑上能正常开，App 却说读不出来」，
        //    界面这次把系统原话带出来了：`com.apple.coreaudio.avfaudio 错误 -50`（`paramErr`）。
        //    错的**不是解码**：`decodeToPCM` 用 `try?` 吞掉内部错误 —— 界面上能出现原始 `-50`
        //    当"直接读"的失败原因，就说明**它其实解码成功了**，`-50` 发生在它**之后**
        //    （建输出文件 / 重读 / 读一块 / 写一块）。
        //    ⚠️ 我一度以为"能成功的共同点是源采样率 44.1kHz"—— **被用户截图直接推翻**：
        //       "源 44100Hz/2声道 → 目标 44100Hz/2声道"**也** -50。别再往采样率上想。
        //
        //    ⚠️⚠️ **2026-10-02 第三次重写，这次拿到了 Apple 的原文** —— 前两版都是我猜的，
        //    而且猜反了：我以为"`read(into:)` 会帮我们转格式"，**真相是它一点都不转**。
        //
        //      · `AVAudioFile.read(into:frameCount:)` 的 `buffer` 参数，文档原文：
        //          "The buffer from which to read the file.
        //           **Its format must match the file's processing format.**"
        //      · `init(forReading:)` 的说明：用的是 "the standard,
        //        **deinterleaved floating point** format"。
        //
        //    ⇒ 手工造一个 `Int16 / 交错` 的 buffer 塞给 `read(into:)`，它的 commonFormat 与
        //      交错位就跟 processingFormat（float32 **非**交错）对不上 → **每次都 `-50`**
        //      （`paramErr`）。**与采样率、声道数、文件类型都无关** —— 这正好解释了用户截图上
        //      那条"源 44100Hz/2声道 → 目标 44100Hz/2声道 **也** -50"（我上一版的解释站不住）。
        //
        //    **修法**：用 `init(forReading:commonFormat:interleaved:)` 把 processingFormat
        //    **亲自定成 Int16 交错**（"文件格式 → 处理格式"的转换是系统文档里承诺会做的），
        //    然后所有 buffer **照抄 `processingFormat`** —— 逐项相同，`read(into:)` 挑不出毛病。
        //    ⚠️ 代价（文档明说）：processingFormat "must be **at the same sample rate** as the
        //       actual file contents" —— **采样率/声道数没得挑**，输出就保持源自己的。
        //       一次重采样都不做 = 少掉一整类失败；而 CAF/LinearPCM 是什么采样率 iOS 都放得出。
        //
        // ⚠️ 体检只做"能不能打开"（真正的取数在 `writeAlarmSound` 里重读一遍）。
        let probe: AVAudioFile
        do {
            probe = try AVAudioFile(forReading: src)
        } catch {
            // ⚠️ 这里**必须**把系统原话带上：不然用户看到的就是一句"读不出来"，
            //    而我们要的是"打不开"和"打得开但转不动"能分开。
            throw Self.err("这个音频打不开（\(Self.describeFile(src))）：\(error.localizedDescription)")
        }
        let srcFormat = probe.processingFormat
        guard srcFormat.sampleRate > 0, probe.length > 0 else {
            throw Self.err("这个文件里没有声音（能打开，但里面一帧都没有）")
        }

        guard let dir = soundsDirectory() else { throw Self.err("找不到 App 的目录") }
        // ⚠️ 2026-10-02：这里以前是 `removePrevious(tier:)` + 时间戳文件名。
        //    现在**什么都不删**（每首都是新的一首），名字用**随机 token**：
        //      · 不用时间戳：同一秒里连导两首会撞名（会覆盖掉前一首，正是要避免的）；
        //      · 8 位十六进制 = 32 bit：用户最多导几十首，撞名概率可以忽略，
        //        而且**拼不出路径**（只有 [0-9a-f]），`isSafeName` 那条防线也认它。
        let token = Self.newToken()
        let name = "\(Self.namePrefix)\(token).caf"
        let dest = dir.appendingPathComponent(name)

        // ⚠️ 只走一条路：**不重采样、不混声道**，按源格式直接写出去。
        //    以前这里是"先试 44.1k 单声道，再退回源格式"的双目标循环 —— 那个设计建立在
        //    "目标格式不匹配才会 -50"的错误判断上（见上面的 Apple 原文），整段删掉：
        //    失败与目标格式无关，多试几次只是多绕一圈。
        let written = try writeAlarmSound(from: src, to: dest)
        NSLog("[Sound] 导入完成 \(name)：约 \(String(format: "%.1f", written.seconds)) 秒，"
            + "\(written.bytes) 字节（\(written.format)）")
        return name
    }

    /// `writeAlarmSound` 的结果（日志/诊断用）
    private struct WrittenSound {
        let bytes: Int
        let seconds: Double
        let format: String
    }

    /// 把源音频写成 `Library/Sounds` 里的一个 caf。成功返回写了多少。
    ///
    /// ⚠️⚠️ **这里就是 `-50` 的修复**：不再手工造 buffer 格式，而是**在打开时声明**要什么格式，
    ///    然后 buffer / 输出文件全用 `processingFormat`（Apple 对 `read(into:)` 的硬要求，
    ///    见 `importAudio` 的注释）。
    ///
    /// ⚠️ 两条**内部自洽**的搭配（都用"格式逐项相同"的写法，所以**都不该再有 `-50`**）：
    ///      ① 打开时声明 `Int16 / 交错` —— 体积只有 float32 的一半，最像"正常铃声"；
    ///      ② 完全照抄系统给的 `processingFormat`（float32 非交错）—— 连声明都不声明，
    ///         buffer 就是那个对象本身，理论上不可能失败。
    ///      留第二条不是为了"多试一次碰运气"，而是防"某个系统版本不吃 Int16"。
    ///
    /// ⚠️⚠️ **原子**：先写同目录下的隐藏临时文件，**全部成功之后才搬**成最终名字。
    ///    这是用户那句「我导入了三个音频，为啥列表里有好几个」的直接修复：
    ///    以前是直接往最终文件名里写，于是**任何一步失败都留下一个残骸**，
    ///    而残骸的名字长得和真的一模一样（`timetable-custom-<8位十六进制>.caf`），
    ///    会被当成一首铃声列出来。现在 `dest` 只可能"完整存在"或"根本不存在"。
    ///    （临时名字以 `.` 开头，`soundId(ofFile:)` 不认它，所以不会漏出去。）
    ///
    /// ⚠️ 目标格式 = **源自己的采样率/声道数**，一次重采样都不做（文档限制，见 `importAudio`）。
    private func writeAlarmSound(from src: URL, to dest: URL) throws -> WrittenSound {
        var failures: [String] = []
        do {
            return try writeAlarmSoundOnce(from: src, to: dest, declareInt16: true)
        } catch {
            failures.append("按 Int16 交错 ×『\(error.localizedDescription)』")
            NSLog("[Sound] Int16 交错那条路不行，改按源格式原样读：\(error)")
        }
        do {
            return try writeAlarmSoundOnce(from: src, to: dest, declareInt16: false)
        } catch {
            failures.append("按源格式 ×『\(error.localizedDescription)』")
        }
        // ⚠️⚠️ 这两句**绝不能说成"你的音频解不出来"** —— 用户明确说过那文件在电脑和平板上
        //    都正常播。如实承认是我们 App 的毛病，同时把"哪一步、什么格式"摆出来
        //    （他不装 Xcode，看不到 NSLog）。
        NSLog("[Sound] 两种格式搭配都失败：\(failures.joined(separator: " ｜ "))")
        throw Self.err("这个音频读进来了、但转换没出结果 —— 这是我们 App 的问题，不是你的文件。"
            + "（诊断：文件 \(Self.describeFile(src))；" + failures.joined(separator: "；") + "）")
    }

    /// `writeAlarmSound` 的单次尝试。`declareInt16` = 是否在**打开时**把处理格式声明成 Int16 交错。
    ///
    /// ⚠️⚠️ 关键：无论哪条路，**读的 buffer 就是 `inFile.processingFormat`**，输出文件也用
    ///    `fmt.commonFormat` / `fmt.isInterleaved` —— 读、写、缓冲区三处永远是同一个格式，
    ///    这就是 Apple 文档要的"逐项相同"。**绝不要**手工 `AVAudioFormat(commonFormat:…)` 造一个。
    private func writeAlarmSoundOnce(from src: URL, to dest: URL,
                                     declareInt16: Bool) throws -> WrittenSound {
        let inFile: AVAudioFile
        do {
            // ⚠️ 解药在这一行：**要用哪个格式读，就在打开时声明**。
            //    声明成 Int16 交错之后，`processingFormat` 就是 Int16 交错（采样率/声道数仍是
            //    文件自己的），下面所有 buffer 都照抄它 —— 逐项相同，`read(into:)` 不可能再 -50。
            //    反面教材（连栽两版）：直接 `AVAudioFile(forReading:)` 拿 float32 **非**交错的
            //    processingFormat，却喂一个**手工造**的 Int16 交错 buffer 进去 → `paramErr -50`。
            inFile = declareInt16
                ? try AVAudioFile(forReading: src, commonFormat: .pcmFormatInt16, interleaved: true)
                : try AVAudioFile(forReading: src)
        } catch {
            throw Self.err("重开源文件失败（\(Self.describeFile(src))）：\(error.localizedDescription)")
        }
        let fmt = inFile.processingFormat
        guard fmt.sampleRate > 0, fmt.channelCount > 0 else {
            throw Self.err("源文件的格式读不出来（\(Self.describeFile(src))）")
        }
        let tmp = dest.deletingLastPathComponent()
            .appendingPathComponent(".incoming-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: tmp) }

        var written: AVAudioFramePosition = 0
        // ⚠️⚠️ `outFile` **故意关在这个内层作用域里**：它在这里析构（= 关闭文件、
        //    把 CAF 的头写完），然后才轮到下面的 `moveItem` ——
        //    顺序反了就会搬走一个"头还没写完"的文件（而且不报错）。
        do {
            let outFile: AVAudioFile
            do {
                // ⚠️ `settings`（盘上长什么样）与 `commonFormat/interleaved`（我喂进去的 buffer
                //    长什么样）**必须描述同一个格式**：三处都从 `fmt` 来，天然一致。
                outFile = try AVAudioFile(
                    forWriting: tmp, settings: fmt.settings,
                    commonFormat: fmt.commonFormat, interleaved: fmt.isInterleaved
                )
            } catch {
                throw Self.err("建输出文件失败（\(Self.describe(fmt))）：\(error.localizedDescription)")
            }

            let chunk: AVAudioFrameCount = 16_384
            // ⚠️⚠️ **必须自己卡 30 秒上限**：Apple 规定通知/闹钟声音**不得超过 30 秒**，
            //    超了系统会**拒绝播放**（静默降级成默认音 —— 用户只觉得"我选了铃声但响的是别的"，
            //    没有任何报错）。所以循环不能"读到文件尾"，那个上限就写在这里。
            let maxFrames = AVAudioFramePosition(Self.maxSeconds * fmt.sampleRate)
            while written < maxFrames {
                // ⚠️ buffer 的格式**照抄 processingFormat**（这是文档对 read(into:) 的硬要求）。
                //    **绝对不要**再手工 `AVAudioFormat(commonFormat:…)` 造一个 —— 那正是
                //    两版 `-50` 的根源。
                guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: chunk) else { break }
                do {
                    try inFile.read(into: buf, frameCount: chunk)
                } catch {
                    throw Self.err("读源文件失败（目标 \(Self.describe(fmt))，"
                        + "源 \(Self.describe(inFile.processingFormat))）：\(error.localizedDescription)")
                }
                if buf.frameLength == 0 { break }            // 读完了
                do {
                    try outFile.write(from: buf)
                } catch {
                    throw Self.err("写出失败（\(Self.describe(fmt))）：\(error.localizedDescription)")
                }
                written += AVAudioFramePosition(buf.frameLength)
            }
        }

        let attrs = try? FileManager.default.attributesOfItem(atPath: tmp.path)
        let bytes = (attrs?[.size] as? Int) ?? 0
        guard written > 0, bytes > 4096 else {
            // ⚠️ 诊断写进日志（用户看不到），消息里也带上数字
            NSLog("[Sound] 转换零输出：\(written) 帧 / \(bytes) 字节（\(Self.describe(fmt))）")
            // ⚠️ 这里只说事实（"读进来了但没写出东西"）—— 把它说成"你的文件解不出来"是误导，
            //    汇总成人话的那句在 `writeAlarmSound` 里。
            throw Self.err("转换零输出（源 \(Self.describe(fmt))，文件 \(Self.describeFile(src))）")
        }

        // ⚠️ 到这里才让最终文件名出现（原子收尾）
        do {
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.moveItem(at: tmp, to: dest)
        } catch {
            throw Self.err("保存铃声文件失败：\(error.localizedDescription)")
        }
        return WrittenSound(bytes: bytes,
                            seconds: Double(written) / fmt.sampleRate,
                            format: Self.describe(fmt))
    }

    /// 给人看的一行格式描述（诊断用：`48000Hz/2声道`）
    static func describe(_ f: AVAudioFormat) -> String {
        "\(Int(f.sampleRate))Hz/\(f.channelCount)声道"
    }

    /// 给人看的一行文件描述（诊断用：`.mp3 4.6MB`）
    ///
    /// ⚠️ 为什么连**后缀和体积**都要报上来：用户没法把文件给我们，而"哪个文件不行"
    ///    全靠这三个字（`mp3` / `m4a` / `aac`）+ 体积才能对上号。
    static func describeFile(_ url: URL) -> String {
        let ext = url.pathExtension.isEmpty ? "（没有后缀）" : ".\(url.pathExtension)"
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int
        guard let size, size > 0 else { return ext }
        return "\(ext) \(String(format: "%.1f", Double(size) / 1_048_576))MB"
    }

    /// 把 Core Audio 的 `OSStatus` 说成人话（数字 + 四字符码）。
    ///
    /// ⚠️ 只用在**诊断括号**和日志里，**不当主消息** —— 用户看不懂
    ///    `1937337955`（它是四字符码 `'sync'`：系统在说"这个文件里没有我认得的头"）。
    ///    带上四字符码是因为**下一次真机失败时，这一串能让我直接定位**：
    ///    `'sync'` = 认不出容器、`-50`(`paramErr`) = 参数/格式不匹配，两者病因完全不同。
    static func osStatusText(_ status: OSStatus) -> String {
        guard status != noErr else { return "noErr" }
        let n = UInt32(bitPattern: status)
        let bytes: [UInt8] = [
            UInt8((n >> 24) & 0xFF), UInt8((n >> 16) & 0xFF),
            UInt8((n >> 8) & 0xFF), UInt8(n & 0xFF),
        ]
        var code = ""
        if bytes.allSatisfy({ $0 >= 32 && $0 < 127 }), let s = String(bytes: bytes, encoding: .ascii) {
            code = "（'\(s)'）"
        }
        return "\(status)\(code)"
    }

    /// 把**已经解好的 PCM** 按目标格式写成 caf 并返回文件名。
    ///
    /// ⚠️ 为什么单独抽出来：兜底那条路（`importFromAssetReader`）拿到的是
    ///    **已经解好的 PCM**（float32），不需要再"重读源文件"，
    ///    但**写文件那一半完全一样** —— 包括那条 30 秒硬上限和"零输出"判据。
    ///    复制一份的话，将来改了一处忘另一处就会出一个很隐蔽的 bug。
    ///
    /// ⚠️ `decoded.format` 是**源格式**（可能是 float32 44.1k 单声道），
    ///    写出去时要转成目标格式（int16 44.1k 单声道交错）——
    ///    这一步还是交给 `AVAudioFile.read(into:)` 那套：**先把解码结果写成
    ///    一个临时 caf**，再让调用方走正常路径读它。
    ///    （听起来绕，但这样**只有一条写文件的实现**，比维护两套格式转换安全。）
    /// ⚠️ 是**实例方法**（不是 `static`）：它要调 `importAudio` 和 `soundsDirectory()`，
    ///    那两个都是实例成员 —— 写成 `static` 会编译不过：
    ///    `error: instance member 'soundsDirectory' cannot be used on type 'CustomSoundLibrary'`。
    ///    ⚠️ **这类错只有真编译器能抓**（本机 `swift-check` 只看括号配对），
    ///    2026-10-02 就是这么让一轮 CI 失败的 —— 拿到日志后一行就定位了。
    private func writePCMToCaf(_ decoded: Decoded) throws -> String {
        // ⚠️ 先确认目录可用（`importAudio` 里还会再确认一次）——
        //    这样"目录都不存在"这类问题会在**离用户操作最近的地方**就报错。
        //    ⚠️ 用 `guard ... else` 但**不绑定变量**：绑定了不用会被编译器警告。
        guard soundsDirectory() != nil else { throw Self.err("找不到 App 的目录") }
        // ⚠️⚠️ 2026-10-02 修：交错位**必须照抄 `decoded.format`**。
        //    这里原先写死 `interleaved: false`，而 `decodeWithAssetReader` 交给我们的
        //    buffer 是 `interleaved: true` —— `write(from:)` 一看到 buffer 的格式和文件的
        //    processingFormat 不一致就抛 `-50`（`paramErr`），**整整一条兜底解码路全废**。
        //    （这属于"同一个东西在两处各写一遍、其中一处写错"的经典情况：
        //      能少写一遍就少写一遍 —— 所以下面直接用 `decoded.format` 的两个属性。）
        guard let pcmFormat = AVAudioFormat(
            commonFormat: decoded.format.commonFormat, sampleRate: decoded.format.sampleRate,
            channels: decoded.format.channelCount, interleaved: decoded.format.isInterleaved
        ) else {
            throw Self.err("没法创建输出格式")
        }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("timetable-decoded-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: tmp) }
        let tmpFile = try AVAudioFile(
            forWriting: tmp, settings: pcmFormat.settings,
            commonFormat: decoded.format.commonFormat, interleaved: decoded.format.isInterleaved
        )
        try tmpFile.write(from: decoded.buffer)
        // ⚠️ 再走一遍标准路径（它会做目标格式转换 + 30 秒上限 + 零输出检查）
        return try importAudio(from: tmp)
    }

    // MARK: - 带回退的入口（先快后慢）

    /// 「导入」的真正入口：**先试快的（`AVAudioFile`），不行再转码重试**。
    ///
    /// ⚠️ 为什么分成两步、而不是让 `importAudio` 自己 async：
    ///    · 绝大多数文件（wav/m4a/mp3/caf）**第一步就成了**，那次不该有任何异步等待；
    ///    · 只有 `.aac` 这类容器才需要走 `AVAssetExportSession`（**慢，可能几秒**）。
    ///    这样"常见情况快、罕见情况才对"，而且 `importAudio` 保持同步、好测。
    ///
    /// ⚠️ 两条路都失败时给**人话**（见 `decodeToPCM` 的最后那句 throw）——
    ///    绝不把 `1937337955` 这种四字符码甩给用户。
    ///
    /// ⚠️⚠️ 2026-10-02 又改：**把"哪一步失败"带进给用户看的那句话里**。
    ///    起因：真机上连续两次失败，而用户看到的都只是一句笼统的"读不出来" ——
    ///    **他自己没有 Xcode、拿不到 NSLog**，于是我们俩都只能猜。
    ///    诊断必须**自己走到界面上**，不能只躺在设备日志里。
    ///    现在这句话会形如：
    ///      `（诊断：直接读 ×；转码 ×『…』；兜底解码 ×『…』；裸流解码 ×『…』）`
    ///    每一步的**系统原话**都在里面 —— 下次一试就知道卡在哪。
    /// ⚠️⚠️ 2026-10-02 再加一条（`decodeAdtsWithCoreAudio`）：**裸 AAC（ADTS）**。
    ///    前三条路的共同点是**都在嗅探文件头**，而 ADTS 是"一帧一帧的裸流、没有文件头"，
    ///    嗅探型 API 一律报 `'sync'`（= 认不出这个头）。只有"明确告诉系统这是 ADTS"才读得动。
    func importAudioWithFallback(from src: URL) async throws -> String {
        do {
            return try importAudio(from: src)
        } catch {
            // ① 失败：先看这个文件到底有没有音轨（"没有音轨"和"容器不认"要分开说）
            let firstError = error
            NSLog("[Sound] 直接读失败，尝试转码：\(firstError.localizedDescription)")

            // ② 转码成 m4a 再读
            var trail: [String] = ["直接读 ×『\(firstError.localizedDescription)』"]
            var converted: URL?
            do {
                converted = try await Self.transcodeToM4A(src)
            } catch {
                trail.append("转码 ×『\(error.localizedDescription)』")
            }
            if let converted {
                defer { try? FileManager.default.removeItem(at: converted) }
                do {
                    return try importAudio(from: converted)
                } catch {
                    trail.append("读转码结果 ×『\(error.localizedDescription)』")
                }
            }

            // ③ 兜底：`AVAssetReader` 直接解 PCM（不写中间文件、不走导出会话）
            do {
                let name = try importFromAssetReader(src: src)
                return name
            } catch {
                trail.append("兜底解码 ×『\(error.localizedDescription)』")
            }

            // ④ 裸 AAC（ADTS）：**唯一一条不靠嗅探的路**
            do {
                let decoded = try Self.decodeAdtsWithCoreAudio(src)
                do {
                    let name = try writePCMToCaf(decoded)
                    NSLog("[Sound] 裸流那条路成了：\(name)")
                    return name
                } catch {
                    trail.append("裸流写出 ×『\(error.localizedDescription)』")
                }
            } catch {
                trail.append("裸流解码 ×『\(error.localizedDescription)』")
            }

            // ⑤ 四条都不行：如实把过程摆出来（**别再说成"你的文件解不出来"**）
            NSLog("[Sound] 导入四条路全失败：\(trail.joined(separator: " ｜ "))")
            throw Self.err("这个音频试了四种解法都没成功。"
                + "（诊断：" + trail.joined(separator: "；") + "）")
        }
    }

    /// 兜底：用 `AVAssetReader` 解出 PCM，再按目标格式写成 caf（**不依赖导出会话**）。
    ///
    /// ⚠️ 同样必须是**实例方法** —— 它调的 `writePCMToCaf` 是实例成员
    ///    （`error: instance member 'importAudio' cannot be used on type ...`）。
    private func importFromAssetReader(src: URL) throws -> String {
        // ⚠️ 必须带 Self. —— decodeWithAssetReader 是 **static** 函数，
        //    而 importFromAssetReader 是实例方法：不带 Self. 会编译报
        //    error: static member ... cannot be used on instance of type ...。
        //    ⚠️ 上一轮我把 writePCMToCaf/importFromAssetReader 从 static 改成实例，
        //    却把这个调用点的 Self. 一起删了 —— 编译器当场抓出来。
        let decoded = try Self.decodeWithAssetReader(src)
        guard decoded.format.sampleRate > 0, decoded.buffer.frameLength > 0 else {
            throw Self.err("兜底解码拿到了空数据")
        }
        return try writePCMToCaf(decoded)
    }

    /// 用 **`AVAssetExportSession`** 把任意能解码的容器转成 m4a（AAC）。
    ///
    /// ⚠️ 为什么选它而不是手写 `AVAssetReader` + 自己管 PCM：
    ///    它是**文档化、稳定**的那条路，`AVAssetExportPresetAppleM4A` 由系统负责
    ///    解码 + 重编码，不用我们碰采样格式、也不用碰 `AVAssetTrack` 上那些
    ///    容易记错的成员（我上次就是栽在 `naturalTimeRange` 上）。
    ///
    /// ⚠️ **真机上失败过一版（2026-10-02，用户报 `.aac` 还是导不进）**，教训在这里：
    ///    · 我**没有显式设 `session.outputFileType`** —— 它默认是
    ///      `supportedFileTypes.first`（M4A 预置通常**是 `.mov`**！），
    ///      而我给的文件名是 `.m4a` → 类型与后缀不匹配，导出会失败。
    ///      iOS 18+ 那条 `export(to:as:)` 因为 `as: .m4a` 显式给了类型才侥幸没事，
    ///      **老版本那条 `exportAsynchronously` 分支就完全没设**。
    ///      现在**两种分支都先设 `outputFileType = .m4a`**（幂等，设两次没关系）。
    ///    · 我还把上游的真实错误**吞掉了**（只抛一句笼统的"读不出来"），
    ///      于是真机上失败时**连日志里都没有原因**。现在把
    ///      `session.error` / 抛出的错误**原样带进消息并写进 NSLog**。
    ///
    /// ⚠️ 输出放在**临时目录**：它是中间产物，用完就删（调用方 `defer` 了）。
    private static func transcodeToM4A(_ src: URL) async throws -> URL {
        let asset = AVURLAsset(url: src)
        // ① 「有没有音轨」要单独认出来 —— 它和"容器不认"是完全不同的两件事
        let tracks: [AVAssetTrack]
        do {
            tracks = try await asset.loadTracks(withMediaType: .audio)
        } catch {
            NSLog("[Sound] 转码失败：loadTracks 抛了 \(error)")
            throw Self.err("这个文件读不出来（可能是加密的，或者根本不是音频）："
                + error.localizedDescription)
        }
        guard !tracks.isEmpty else {
            throw Self.err("这个文件里没有声音（可能是纯视频，或者已经损坏）")
        }
        // ② 加密内容（Apple Music 下载的那种）单独说清楚，别让它到解码那一步才报怪码
        if let hasDRM = try? await asset.load(.hasProtectedContent), hasDRM {
            throw Self.err("这个文件有版权保护（加密的），任何 App 都读不了它")
        }
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            // ⚠️ 把系统说它支持哪些类型写进日志：失败时这是最有用的一行
            NSLog("[Sound] 转码失败：建不出 session。asset 可导出的类型 = "
                + "\(asset.availableMediaCharacteristicsWithMediaSelectionOptions)")
            throw Self.err("这个音频的格式转不了（换成 wav / m4a / mp3 再试一次）")
        }
        let out = FileManager.default.temporaryDirectory
            .appendingPathComponent("timetable-convert-\(UUID().uuidString).m4a")
        try? FileManager.default.removeItem(at: out)
        // ⚠️⚠️ 必须显式设：默认是 `supportedFileTypes.first`（M4A 预置是 `.mov`），
        //    和我们给的 `.m4a` 后缀不一致就会导出失败。两种分支都要设。
        if session.supportedFileTypes.contains(.m4a) {
            session.outputFileType = .m4a
        } else {
            NSLog("[Sound] 转码：这个 session 不支持 m4a，支持的是 \(session.supportedFileTypes)")
        }

        // ⚠️ 两条 API 形态：iOS 18+ 有 `export(to:as:)`；更老的只能用 `exportAsynchronously`。
        if #available(iOS 18.0, *) {
            do {
                try await session.export(to: out, as: .m4a)
            } catch {
                NSLog("[Sound] 转码失败（export(to:as:)）：\(error)")
                throw Self.err("这个音频转不出来：" + error.localizedDescription)
            }
        } else {
            session.outputURL = out
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                session.exportAsynchronously { cont.resume() }
            }
            if session.status != .completed {
                // ⚠️ 把状态和 error 都写出来 —— 上一次失败就是因为这里什么都没有
                NSLog("[Sound] 转码失败（exportAsynchronously）：status=\(session.status.rawValue) "
                    + "error=\(String(describing: session.error))")
                throw Self.err("这个音频转不出来："
                    + (session.error?.localizedDescription ?? "原因不明（status \(session.status.rawValue)）"))
            }
        }
        NSLog("[Sound] 转码完成（m4a）：\(out.lastPathComponent)")
        return out
    }

    // MARK: - 解码

    /// 解码结果：一段 PCM 缓冲 + 它的格式
    private struct Decoded {
        let buffer: AVAudioPCMBuffer
        let format: AVAudioFormat
    }

    /// 把一个音频文件解成 PCM（**只解前 30 秒**）。
    ///
    /// ⚠️⚠️ **2026-10-01：这里曾经加过一条 `AVAssetReader` 的"宽容路径"，然后被撤掉了。**
    ///    原因（诚实地记下来，别再重蹈）：
    ///    · 背景：用户从「文件」里选了一个 `.aac`，`AVAudioFile(forReading:)` 直接抛
    ///      `com.apple.coreaudio.avfaudio 错误 1937337955`。我判断需要一条更宽容的解码路径。
    ///    · 但**本机编不了 iOS**（Windows），那条路径全靠"看着对"往上推 ——
    ///      连续两次 CI 都在 `CustomSound.swift` 编译失败，而**当时以为 Codemagic 失败时不给日志**
    ///      （没跑到 publish 阶段就没有 artifacts），所以我只能靠猜，改一轮错一轮。
    ///    · 结论：**在没有编译器反馈的情况下继续盲改是不负责任的** —— 那会把
    ///      "已经能用的导入功能"（wav/m4a/mp3/caf 全都能用）一起搭进去。
    ///      所以撤回到已知良好状态，改成**如实告知 + 给出可操作建议**。
    ///
    /// ⚠️ 上面那句"失败时不给日志"**2026-10-02 被推翻了**：失败构建**也**上传 artifacts，
    ///    只是 `tools/codemagic.mjs --download` 会在失败时**静默留下上一次成功的产物**，
    ///    于是看起来像"拿不到"。现在有 `node tools/build-log.mjs [buildId|--last-failed]`
    ///    能把失败构建的日志扒出来（见 `docs/真机排查-闹钟试响与诊断.md`）——
    ///    **所以这条宽容路径这次真的做出来了**，见 `decodeAdtsWithCoreAudio`。
    ///
    /// ⚠️ 那个数（`1937337955`）**我写错过两次**（先写成 `!dat`、又写成 `'fmt?'`）：
    ///    它其实是 **`'sync'`**，意思是"这个文件里没有我认得的头"。
    ///    **同一个数错两次的教训：换算过一次就要回去查记录，别凭印象重算。**
    ///
    /// ⚠️ 失败时**不许把 OSStatus 甩给用户**（`1937337955` 那种四字符码没人看得懂）——
    ///    要给人话；四字符码只进诊断括号与日志（`osStatusText`）。
    private static func decodeToPCM(_ src: URL) throws -> Decoded {
        if let decoded = try? decodeWithAVAudioFile(src) { return decoded }
        // ⚠️ 第二条：`AVAssetReader` **直接解 PCM**，不经过"转码成 m4a 再读"。
        //    为什么值得留着这条：`AVAudioFile` 认不出的容器（`.aac` 裸流等）它往往认；
        //    而且它**不依赖 `AVAssetExportSession`**（那条路真机上失败过一次）。
        //    ⚠️ 它是同步的（`startReading` + `copyNextSampleBuffer`），所以这里能直接调。
        if let decoded = try? decodeWithAssetReader(src) { return decoded }
        // ⚠️ 第三条（2026-10-02 新增）：裸 AAC（ADTS）—— 前两条都是**嗅探文件头**，
        //    而 ADTS 没有文件头，所以两条都会以 `'sync'` 失败。这条**明确告诉系统**。
        if let decoded = try? decodeAdtsWithCoreAudio(src) { return decoded }
        // ⚠️⚠️ 字符串里**只能用中文直角引号「」，绝不能用全角双引号“”** ——
        //    Swift 把全角 `"` 当成字符串结束符，编译报 `error: Expected ',' separator`，
        //    而且报错行看起来完全没问题（这个坑 2026-10-01 真踩了一次、浪费一轮 CI）。
        throw Self.err("这个音频读不出来。换成 wav / m4a / mp3 再试一次；"
            + "`.aac` 这类「裸流」格式系统认不出来。"
            + "如果是从 Apple Music 等带版权保护的地方下载的，那种文件有加密，任何 App 都读不了。")
    }

    /// **最后一条路：裸 AAC（ADTS）** —— Core Audio 的 `AudioFile` + `ExtAudioFile`，
    /// 并且**显式告诉系统"这是 ADTS"**。
    ///
    /// ⚠️ 为什么非要有这一条（这是用户第 3 次报的那个 `.aac` 的**唯一**出路）：
    ///    · 用户那个 `.aac` 在电脑和平板上都**能正常播放**，但 App 说读不出来；
    ///    · `AVAudioFile(forReading:)` / `AVURLAsset` / `AVAssetReader` 全都报
    ///      `com.apple.coreaudio.avfaudio 错误 1937337955` = 四字符码 **`'sync'`**
    ///      = "我在这个文件里没找到我认得的头"；
    ///    · 根因：**ADTS 是"裸流"** —— 一帧一帧的 `FF F1 …` 同步字，**没有文件头**。
    ///      凡是"先嗅探再决定怎么解"的 API（上面那三个）**一律认不出来**；
    ///      只有"你明确告诉我它是 ADTS"才读得动。
    ///
    /// ⚠️ 为什么要两个 API 组合（这是官方那条路，不是我拼的）：
    ///    · `ExtAudioFileOpenURL` **没有** type 提示参数 → 它自己也认不出 ADTS；
    ///    · 所以要先用 `AudioFileOpenURL(url, .readPermission, kAudioFileAAC_ADTSType, &id)`
    ///      带提示打开，再 `ExtAudioFileWrapAudioFileID(id, false, &ext)` 把它接进
    ///      ExtAudioFile 的解码能力里（`ExtAudioFileSetProperty` / `ExtAudioFileRead`）。
    ///
    /// ⚠️ 客户端格式给 **float32 交错**：必须与 `decodeWithAssetReader` 交给
    ///    `writePCMToCaf` 的形状**同一种** —— 那里是照抄 `decoded.format` 写临时文件的，
    ///    两种解码结果形状不一致的话，其中一条又会变成 `-50`。
    ///
    /// ⚠️ 一次 `ExtAudioFileRead` 就要"最多 30 秒"的帧数：它在 EOF 处会自己停下并
    ///    回报真正读到的帧数，不用我们写拼接循环（省掉一整类"拼接错位"的 bug）。
    private static func decodeAdtsWithCoreAudio(_ src: URL) throws -> Decoded {
        // ① 带 type 提示打开（`kAudioFileAAC_ADTSType` 就是四字符码 `'adts'`）
        var fileID: AudioFileID?
        let opened = AudioFileOpenURL(src as CFURL, .readPermission, kAudioFileAAC_ADTSType, &fileID)
        guard opened == noErr, let fid = fileID else {
            throw Self.err("它不是 ADTS 裸流（\(Self.osStatusText(opened))）")
        }
        defer { AudioFileClose(fid) }

        // ② 接进 ExtAudioFile（真正干活的是它）
        var extRef: ExtAudioFileRef?
        let wrapped = ExtAudioFileWrapAudioFileID(fid, false, &extRef)
        guard wrapped == noErr, let ext = extRef else {
            throw Self.err("接不上解码器（\(Self.osStatusText(wrapped))）")
        }
        defer { ExtAudioFileDispose(ext) }

        // ③ 源格式：ADTS 把采样率/声道数写在**每一帧里**，这里读出来的就是真的
        var fileFormat = AudioStreamBasicDescription()
        var fileSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let got = ExtAudioFileGetProperty(
            ext, kExtAudioFileProperty_FileDataFormat, &fileSize, &fileFormat)
        guard got == noErr else { throw Self.err("读不出它的采样格式（\(Self.osStatusText(got))）") }
        let rate = fileFormat.mSampleRate > 0 ? fileFormat.mSampleRate : 44_100
        let channels = AVAudioChannelCount(fileFormat.mChannelsPerFrame > 0
            ? fileFormat.mChannelsPerFrame : 1)

        // ④ 客户端格式 = float32 交错（与 `decodeWithAssetReader` 那条路同形）
        guard let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate,
                                      channels: channels, interleaved: true) else {
            throw Self.err("没法创建解码格式")
        }
        var clientFormat = fmt.streamDescription.pointee
        let clientSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let set = ExtAudioFileSetProperty(
            ext, kExtAudioFileProperty_ClientDataFormat, clientSize, &clientFormat)
        guard set == noErr else {
            throw Self.err("解码器不接受 \(Self.describe(fmt))（\(Self.osStatusText(set))）")
        }

        // ⑤ 一次读到最多 30 秒
        let capacity = AVAudioFrameCount(rate * Self.maxSeconds)
        guard capacity > 0, let buffer = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: capacity)
        else { throw Self.err("内存不够（这段音频太长）") }
        // ⚠️ 读之前**必须自己把"这块内存能放多少"告诉它**：`frameLength` 设成容量，
        //    同时把 AudioBufferList 里每个 buffer 的 `mDataByteSize` 也设好。
        //    只设一边的话，某些系统版本会读回 0 帧 —— 那看起来就像"文件里没有声音"，
        //    而我们会把**系统的问题说成用户的文件的问题**（上一轮的教训，别再犯）。
        buffer.frameLength = capacity
        let list = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let bytesPerFrame = UInt32(fmt.streamDescription.pointee.mBytesPerFrame)
        for i in 0..<list.count {
            list[i].mDataByteSize = capacity * bytesPerFrame
        }
        var frames = capacity
        let read = ExtAudioFileRead(ext, &frames, buffer.mutableAudioBufferList)
        guard read == noErr else { throw Self.err("解码失败（\(Self.osStatusText(read))）") }
        guard frames > 0 else { throw Self.err("这个文件里没有声音") }
        buffer.frameLength = frames
        NSLog("[Sound] ADTS 裸流解出 \(frames) 帧（\(Double(frames) / rate) 秒，\(Self.describe(fmt))）")
        return Decoded(buffer: buffer, format: fmt)
    }

    /// `AVAssetReader` 直接解码（**不写中间文件、不依赖导出会话**）。
    ///
    /// ⚠️⚠️ 上一版我在这里栽过：写了 `track.naturalTimeRange` —— **那是 `AVAsset` 的成员，
    ///    不是 `AVAssetTrack` 的**，CI 报
    ///    `error: value of type 'AVAssetTrack' has no member 'naturalTimeRange'`。
    ///    现在**只用核对过的成员**：`asset.load(.tracks)` / `track.load(.formatDescriptions)` /
    ///    `track.load(.naturalSize)` 之类一律不碰；需要时长的用意是"帧容量给个上限"，
    ///    这里直接用 `maxSeconds` 推（**反而更稳**，不用碰任何 track 属性）。
    private static func decodeWithAssetReader(_ src: URL) throws -> Decoded {
        let asset = AVURLAsset(url: src)
        // ⚠️ 用 `tracks(withMediaType:)` 这个**同步**属性（不是 async 的 `loadTracks`）——
        //    因为本函数是同步的（`decodeToPCM` 也是同步的），async 版本在这里调不了。
        //    它在 iOS 16+ 标了 deprecated，但**仍然可用**；为了不把整条链改成 async，
        //    这里接受这个警告。（真正的 async 路径在 `transcodeToM4A` 里。）
        guard let track = asset.tracks(withMediaType: .audio).first else {
            throw Self.err("这个文件里没有声音")
        }
        let reader = try AVAssetReader(asset: asset)
        // ⚠️ 输出设置用**交错** float32 单声道：
        //    · 交错 → 整段 PCM 是**一个连续 buffer**（`mNumberBuffers == 1`），
        //      取数据那一步最不容易出错（非交错会变成 N 个 buffer，要自己算总长）。
        //    · `AVLinearPCMBitDepthKey` 这里给 32（Float32 的位宽）—— 两个键一起写清楚，
        //      免得系统按默认位宽理解。
        //    写法出自 Apple 文档 "Vendor-Specific Data Types"（AVFormatIDKey 那一组键）。
        //
        // ⚠️⚠️ 2026-10-02 修：**采样率/声道数一个都不许声明**（也不去读轨道的 formatDescriptions）。
        //    这里原先写死 `44_100` / `1`，于是 48kHz 立体声的文件（用户那两个 mp3 我实测就是）
        //    要在这里做一次重采样 —— 真机上 `copyNextSampleBuffer` 直接返回 nil，
        //    最后以「这个文件里没有声音」收场，而这个说法是**错的**：
        //    文件里有声音，是我们让它按它做不到的方式输出。
        //    现在只声明"我要 PCM、别压缩"，**采样率/声道数以实际出来的数据为准**
        //    （第一块 sample buffer 的 ASBD 就是真相 —— 这样也不用假设 reader 一定照办）。
        //
        // ⚠️⚠️ 为什么**不**去读 `track.formatDescriptions`（我第一版就是这么写的）：
        //    它是 `[Any]`，写 `first as? CMAudioFormatDescription` 会在 CI 上报
        //    `error: conditional downcast to CoreFoundation type 'CMAudioFormatDescription'
        //    (aka 'CMFormatDescription') will always succeed`（2026-10-02 真踩了一次、白等一轮排队）。
        //    `CMSampleBufferGetFormatDescription` 返回的就是同一个类型，**不需要任何转换**。
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        guard reader.canAdd(output) else { throw Self.err("这个音频的格式解不出来") }
        reader.add(output)
        guard reader.startReading() else {
            NSLog("[Sound] AVAssetReader 起不来：\(String(describing: reader.error))")
            throw Self.err("这个音频解不出来")
        }

        // ⚠️ 目标格式：和上面 reader 的输出设置**必须逐字对齐**（读数的人按它解释）。
        //    交错 float32 —— 交错时整段 PCM 是一个连续 buffer，可以直接当一整段用。
        //    它在**拿到第一块数据时**才确定（那之前谁也不知道真实采样率）。
        var pcmFormat: AVAudioFormat?
        var total: AVAudioFramePosition = 0
        var pieces: [AVAudioPCMBuffer] = []

        while true {
            guard let sample = output.copyNextSampleBuffer() else { break }
            defer { CMSampleBufferInvalidate(sample) }
            if pcmFormat == nil {
                var rate: Double = 44_100
                var channels: AVAudioChannelCount = 1
                if let fd = CMSampleBufferGetFormatDescription(sample),
                   let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee {
                    if asbd.mSampleRate > 0 { rate = asbd.mSampleRate }
                    if asbd.mChannelsPerFrame > 0 { channels = AVAudioChannelCount(asbd.mChannelsPerFrame) }
                }
                guard let made = AVAudioFormat(
                    commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: channels, interleaved: true
                ) else {
                    throw Self.err("没法创建输出格式")
                }
                NSLog("[Sound] AVAssetReader 实际输出 \(Self.describe(made))")
                pcmFormat = made
            }
            guard let fmt = pcmFormat else { break }
            // ⚠️ 只取前 `maxSeconds` 秒：按**真实**采样率算出总帧数上限，一路累加到满就停。
            //    （这样不需要读 `track` 的任何属性 —— 那正是上次踩雷的地方。）
            if total >= AVAudioFramePosition(Self.maxSeconds * fmt.sampleRate) { break }
            let frames = CMSampleBufferGetNumSamples(sample)
            guard frames > 0,
                  let buf = AVAudioPCMBuffer(pcmFormat: fmt,
                                             frameCapacity: AVAudioFrameCount(frames)) else { continue }
            buf.frameLength = AVAudioFrameCount(frames)
            // ⚠️ 调用前必须自己声明"我这里能放几个 buffer"—— **交错就是 1 个**。
            //    不声明的话系统不知道容量，会返回 `kCMSampleBufferError_ArrayTooSmall`。
            buf.mutableAudioBufferList.pointee.mNumberBuffers = 1
            let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
                sample,
                bufferListSizeNeededOut: nil,
                bufferListOut: buf.mutableAudioBufferList,
                bufferListSize: MemoryLayout<AudioBufferList>.size,
                blockBufferAllocator: kCFAllocatorDefault,
                blockBufferMemoryAllocator: kCFAllocatorDefault,
                flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                blockBufferOut: nil
            )
            if status != noErr {
                NSLog("[Sound] AVAssetReader 取 buffer 失败：\(status)")
                continue
            }
            pieces.append(buf)
            total += AVAudioFramePosition(frames)
        }
        if reader.status == .failed {
            NSLog("[Sound] AVAssetReader 失败：\(String(describing: reader.error))")
        }
        guard !pieces.isEmpty else { throw Self.err("这个文件里没有声音") }
        // ⚠️ 到这儿 `pcmFormat` 一定有了（`pieces` 非空就说明第一块走过了创建那一步），
        //    但它是可选类型，这里如实收一次 —— 用 `!` 会在"没数据"时崩在日志里，
        //    而"没数据"是这条兜底路的常见结局（那时用户该看到的是那句话，不是崩溃）。
        guard let outFormat = pcmFormat else { throw Self.err("这个文件里没有声音") }

        // 把分块拼成一块（`decodeToPCM` 的调用方按"一块 buffer"用）
        let cap = pieces.reduce(AVAudioFrameCount(0)) { $0 + $1.frameLength }
        guard let merged = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: cap) else {
            throw Self.err("内存不够（这段音频太长）")
        }
        var offset = AVAudioFrameCount(0)
        for p in pieces {
            guard let src = p.floatChannelData, let dst = merged.floatChannelData else { break }
            // ⚠️⚠️ **交错格式下要按"帧数 × 声道数"拷浮点数，不是只拷帧数**。
            //    `floatChannelData[0]` 在交错格式里指向的是**一整块交错数据**
            //    （立体声就是 L R L R …，长度是 帧数×2），只拷 `frameLength` 个浮点数
            //    等于每 2 个数只搬走第 1 个 —— 声音会变成半速的怪声。
            //    （单声道时 `channels == 1`、两种写法等价，所以这个 bug 只在立体声上现形。）
            let ch = Int(p.format.channelCount)
            dst[0].advanced(by: Int(offset) * ch).update(from: src[0], count: Int(p.frameLength) * ch)
            offset += p.frameLength
        }
        merged.frameLength = offset
        NSLog("[Sound] AVAssetReader 解出 \(offset) 帧（\(Double(offset) / outFormat.sampleRate) 秒）")
        return Decoded(buffer: merged, format: outFormat)
    }

    /// `AVAudioFile` 解码（对 wav / m4a / mp3 / caf 都够）
    private static func decodeWithAVAudioFile(_ src: URL) throws -> Decoded {
        let inFile = try AVAudioFile(forReading: src)
        let inFormat = inFile.processingFormat
        guard inFormat.sampleRate > 0, inFile.length > 0 else {
            throw Self.err("这个文件里没有声音")
        }
        let maxFrames = AVAudioFramePosition(Self.maxSeconds * inFormat.sampleRate)
        let frames = AVAudioFrameCount(min(inFile.length, maxFrames))
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: frames) else {
            throw Self.err("音频读不出来")
        }
        try inFile.read(into: buf, frameCount: frames)
        guard buf.frameLength > 0 else { throw Self.err("这个文件里没有声音") }
        return Decoded(buffer: buf, format: inFormat)
    }
}

// MARK: - 文件选择器的回调

extension CustomSoundLibrary: UIDocumentPickerDelegate {
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let done = pendingCompletion
        pendingCompletion = nil
        guard let src = urls.first else {
            done?(.failure(Self.err("没有选中文件")))
            return
        }
        // ⚠️⚠️ `documentPicker` 是**同步的 delegate 回调**，而转码那条路是 async ——
        //    所以**不能直接在这里写 `await`**（那会 `error: 'async' call in a function
        //    that does not support concurrency`）。
        //    必须起一个 `Task`：`done` 回调晚几十毫秒/几秒都不影响（它只用来回报网页）。
        //    **这个错只有真编译器能抓**，本机的 swift-check 只看括号配对 —— 所以改完必须跑 CI。
        Task {
            do {
                // 先快后慢：常见格式（wav/m4a/mp3/caf）第一步就成，只有 .aac 那类才转码
                let name = try await importAudioWithFallback(from: src)
                done?(.success(name))
            } catch {
                NSLog("[Sound] 导入失败：\(error)")
                done?(.failure(error))
            }
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let done = pendingCompletion
        pendingCompletion = nil
        // 取消不是错误，但也要回报一次 —— 否则网页侧那个按钮会一直转
        done?(.failure(Self.err("已取消")))
    }
}
