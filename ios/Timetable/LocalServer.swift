// 最小的本机静态 HTTP 服务：把打包进 App 的 web/ + core/ 发出去。
//
// 为什么非要起个 HTTP 服务（而不是用 loadFileURL 或自定义 scheme）：
//
//   ⚠️ **Origin 决定存储**。本应用的数据存在 WebView 的 IndexedDB 里（4b 的本地模式），
//      而 `http://127.0.0.1:17801` 是一个**稳定、被当作安全上下文**的 origin。
//      · loadFileURL → `file://` 是不透明源，WebKit 明确限制（storage/模块都受影响）
//      · 自定义 scheme → 非 http(s) 源下的 localStorage/IndexedDB 在 WKWebView 上
//        历来不可靠（这正是 Cordova/Ionic 这些壳都改用"本机 HTTP 服务"的原因）
//
//   ⚠️⚠️ **端口必须固定**。Origin = scheme + host + **port**，
//      端口一变就是另一个源 → 之前写的 IndexedDB 全部读不到 → 用户看到"数据没了"。
//      Cordova 的 local-webserver 插件文档专门警告过这一点（CB-9092）。
//      所以这里**写死端口**，被占用了就**明确报错**，绝不"随便换一个能用的端口" ——
//      那等于每次启动都把用户的数据藏起来。
//
// 不做 keep-alive（直接 `Connection: close`），少一层状态就少一类 bug。
// 这个服务只服务一个本机 WebView，性能完全不是问题。

import Foundation
import Network

/// 本机静态文件服务
final class LocalServer {
    /// ⚠️ 固定端口，别改成 0（随机）或"找第一个空闲的"。
    /// 换端口 = 换 origin = IndexedDB 读不到 = 用户以为数据丢了。见文件头。
    static let port: UInt16 = 17801

    /// 设上限是为了"一个畸形请求（声明了 Content-Length 却一直不发）别把连接
    /// 和内存挂住"——超出就按 400 明确回掉，而不是无限攒缓冲区。
    static let maxBodyBytes = 1 * 1024 * 1024

    private let root: URL
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "timetable.localserver")

    /// 服务基地址。WebView 就加载它。
    var baseURL: URL { URL(string: "http://127.0.0.1:\(Self.port)/")! }

    init(bundleRoot: URL) {
        self.root = bundleRoot
    }

    /// 启动。失败就抛 —— 让上层弹一个能看懂的错，而不是白屏。
    func start() throws {
        guard let nwPort = NWEndpoint.Port(rawValue: Self.port) else {
            throw ServerError.badPort
        }
        let params = NWParameters.tcp
        // 只监听回环：别的设备连不上，也不需要连
        params.requiredInterfaceType = .loopback
        let l = try NWListener(using: params, on: nwPort)
        l.newConnectionHandler = { [weak self] conn in
            self?.handle(conn)
        }
        l.stateUpdateHandler = { state in
            if case .failed(let err) = state {
                // 端口被占是最可能的失败。这里只记日志：上层已经拿到过 start() 的成功，
                // 真正的"起不来"会在下面的 ready 等待里暴露。
                NSLog("[LocalServer] listener failed: \(err)")
            }
        }
        l.start(queue: queue)
        listener = l
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    enum ServerError: LocalizedError {
        case badPort
        var errorDescription: String? {
            switch self {
            case .badPort: return "端口号不合法"
            }
        }
    }

    // MARK: - 连接处理

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        receive(conn, buffer: Data())
    }

    /// 读到 `\r\n\r\n` 就够判断请求行了。
    ///
    ///    请求体里，而请求行和数据是**分两段**到的（TCP 不保证一次收全）——
    ///    仍然只看 `\r\n\r\n` 的话，`respond` 会拿到一段空 JSON 就往下走，
    ///    表现成"AI 说我没给提示词"，而请求其实完好。所以现在：
    ///      ① 先解析出请求头和 `Content-Length`；
    ///      ② 需要 body 且还没收全 → 继续收（有上限，见 maxBodyBytes）；
    ///      ③ 收全了（或本来就是 GET）才交给 respond。
    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { conn.cancel(); return }
            var buf = buffer
            if let data { buf.append(data) }
            if error != nil { conn.cancel(); return }

            if let headerEnd = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buf[..<headerEnd.lowerBound], as: UTF8.self)
                // 请求体是头之后那一段（同一个字节流，去掉分隔符）
                let bodyStart = headerEnd.upperBound
                let bodyHave = buf.count - bodyStart
                let need = Self.contentLength(of: head)
                if need > 0, bodyHave < need {
                    // 还没收全 → 接着收，别急着响应
                    if need > Self.maxBodyBytes || buf.count > Self.maxBodyBytes {
                        self.send(conn, status: 400, reason: "Bad Request",
                                  contentType: "application/json; charset=utf-8",
                                  body: Data(#"{"error":"请求体太大"}"#.utf8))
                        return
                    }
                    self.receive(conn, buffer: buf)
                    return
                }
                let body: Data? = need > 0 ? buf.subdata(in: bodyStart..<(bodyStart + min(need, bodyHave))) : nil
                self.respond(conn, requestHead: head, body: body)
                return
            }
            // 请求头太长（或客户端在磨蹭）→ 直接断，别无限攒
            if buf.count > 64 * 1024 || isComplete {
                self.send(conn, status: 400, reason: "Bad Request",
                          contentType: "text/plain; charset=utf-8", body: Data("bad request\n".utf8))
                return
            }
            self.receive(conn, buffer: buf)
        }
    }

    /// 从请求头里取 `Content-Length`（取不到/不合法 → 0 = 没有请求体）
    ///
    /// ⚠️ 拆出来是为了能**单独验**：`Data` 的 `range(of:)` + 大小写不敏感的头
    ///    解析在这两端各写了一遍，写错了症状是"POST 收不到 body"，而那是静默的。
    static func contentLength(of requestHead: String) -> Int {
        for line in requestHead.split(separator: "\r\n", omittingEmptySubsequences: false) {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            if name != "content-length" { continue }
            let raw = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            let n = Int(raw) ?? 0
            return n > 0 ? min(n, maxBodyBytes) : 0
        }
        return 0
    }

    private func respond(_ conn: NWConnection, requestHead: String, body: Data?) {
        let lines = requestHead.split(separator: "\r\n", omittingEmptySubsequences: false)
        guard let requestLine = lines.first else {
            send(conn, status: 400, reason: "Bad Request", contentType: "text/plain; charset=utf-8", body: Data())
            return
        }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else {
            send(conn, status: 400, reason: "Bad Request", contentType: "text/plain; charset=utf-8", body: Data())
            return
        }
        let method = String(parts[0]).uppercased()

        // 去掉查询串
        var path = String(parts[1])
        if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
        path = path.removingPercentEncoding ?? path
        if path.isEmpty || path == "/" { path = "/index.html" }

        guard method == "GET" || method == "HEAD" else {
            send(conn, status: 405, reason: "Method Not Allowed", contentType: "text/plain; charset=utf-8", body: Data())
            return
        }

        // ⚠️ 本地模式**不需要** /api/*（数据在 IndexedDB 里，见 web/adapter/api-local.js）。
        //    但万一有人切到 remote 模式，这里要给一个**能被认出来的 JSON 404**，
        //    而不是 HTML —— api.js 拿到 HTML 会按"服务返回的不是数据"报错，
        //    那条路径是对的，但 JSON 404 的错误信息更直白。
        if path.hasPrefix("/api/") {
            let body = Data(#"{"error":"这是独立 App，没有电脑可连（请用「本机独立模式」）"}"#.utf8)
            send(conn, status: 404, reason: "Not Found",
                 contentType: "application/json; charset=utf-8", body: body, headOnly: method == "HEAD")
            return
        }

        // -------------------------------------------------------------------
        // `/__sounds/<文件名>` —— 让**网页能试听用户自己导入的音频**（2026-10-01 新增）
        //
        // 为什么需要这条：用户导入的音频存在 **App 容器的 Library/Sounds**（不在 bundle 根），
        // 静态文件那条路取不到 → "试听"就只能放合成音，而合成音和真声音是两回事
        // （这正是"试听和真铃声不一样"那个事故的教训）。
        // 有了这条路由，试听**播的就是真文件**，和闹钟用的是同一份。
        //
        // ⚠️ 只允许读 `Library/Sounds` 下、且**名字通过白名单校验**的文件：
        //    必须是我们自己的前缀（`timetable-custom-`，多首之前的老文件是
        //    `timetable-custom-t<档位>-…`，两种都放行）、不含路径分隔符。
        //    否则就成了"任意文件读取"漏洞（比如 `/__sounds/../../Documents/db.json`）。
        if path.hasPrefix("/__sounds/") {
            let raw = String(path.dropFirst("/__sounds/".count))
            let name = raw.removingPercentEncoding ?? raw
            let ok = CustomSoundLibrary.isSafeName(name)
            guard ok, let dir = CustomSoundLibrary.shared.soundsDirectory() else {
                send(conn, status: 403, reason: "Forbidden",
                     contentType: "text/plain; charset=utf-8", body: Data("forbidden\n".utf8),
                     headOnly: method == "HEAD")
                return
            }
            let file = dir.appendingPathComponent(name)
            guard let body = try? Data(contentsOf: file) else {
                send(conn, status: 404, reason: "Not Found",
                     contentType: "text/plain; charset=utf-8", body: Data("404\n".utf8),
                     headOnly: method == "HEAD")
                return
            }
            send(conn, status: 200, reason: "OK",
                 contentType: Self.mimeType(for: file.pathExtension), body: body,
                 headOnly: method == "HEAD")
            return
        }

        // 目录穿越保护：解析后必须仍在 root 下
        let target = root.appendingPathComponent(String(path.dropFirst()))
        let resolved = target.standardizedFileURL
        guard resolved.path.hasPrefix(root.standardizedFileURL.path) else {
            send(conn, status: 403, reason: "Forbidden", contentType: "text/plain; charset=utf-8", body: Data())
            return
        }

        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: resolved.path, isDirectory: &isDir), !isDir.boolValue,
              let body = try? Data(contentsOf: resolved) else {
            send(conn, status: 404, reason: "Not Found", contentType: "text/plain; charset=utf-8",
                 body: Data("404\n".utf8), headOnly: method == "HEAD")
            return
        }

        send(conn, status: 200, reason: "OK",
             contentType: Self.mimeType(for: resolved.pathExtension), body: body,
             headOnly: method == "HEAD")
    }

    private func send(_ conn: NWConnection, status: Int, reason: String,
                      contentType: String, body: Data, headOnly: Bool = false) {
        var head = "HTTP/1.1 \(status) \(reason)\r\n"
        head += "Content-Type: \(contentType)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Cache-Control: no-cache\r\n"
        // 不做 keep-alive：一个请求一条连接，省掉一整类状态 bug
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        if !headOnly { out.append(body) }
        conn.send(content: out, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    /// ⚠️ MIME 必须是 `text/javascript`（不是 text/plain）—— ES module 对 MIME 挑食，
    ///    类型不对会**静默不执行**（页面白屏，控制台才有一句）。
    ///
    /// ⚠️⚠️ 2026-10-01 补上音频类型 —— 这是"试听和真声音对不上"的**根本原因之一**：
    ///    过去这里没有 `caf/wav/m4a`，静态文件一律回落到 `application/octet-stream`，
    ///    而浏览器**不肯把 octet-stream 当音频播** → 于是当年得出"网页取不到 App 包里的
    ///    音频文件"这个结论，改用**网页自己合成的近似音**做试听（方案 A 就是来收拾它的）。
    ///    实际上那些 `.caf` 就在 **bundle 根**、和 `index.html` 同级，本机 HTTP 服务
    ///    完全能取到 —— **补上 MIME 之后，试听可以直接播真实文件**（= 永远不会对不上）。
    ///    ⚠️ 依然保留合成音兜底：电脑/纯浏览器上没有这些文件，那条路必须还能用。
    static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        // 音频（试听用；`<audio>` 会先发 Range 请求，服务端按整段回应也够用）
        case "caf": return "audio/x-caf"
        case "wav": return "audio/wav"
        case "m4a", "aac": return "audio/mp4"
        case "mp3": return "audio/mpeg"
        case "aiff", "aif": return "audio/aiff"
        default: return "application/octet-stream"
        }
    }
}
