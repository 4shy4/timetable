package com.timetable.app

import android.content.res.AssetManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * 静态资源的来源，抽成接口只为一件事：**让 HTTP 层能在没有设备的情况下被测**。
 *
 * 直接用 `AssetManager` 的话，这个类就只能到手机上才能验证 ——
 * 而测试正是为了在没手机的时候发现问题。安卓侧的实现是 [AndroidAssets]（把
 * AssetManager 包一层），测试侧从磁盘目录读。
 */
interface WebAssets {
  /** 读一个资源；不存在返回 null */
  fun read(path: String): ByteArray?
}

/** 安卓侧实现：从 APK 的 assets 里读 */
class AndroidAssets(private val mgr: AssetManager) : WebAssets {
  override fun read(path: String): ByteArray? = try {
    mgr.open(path).use { it.readBytes() }
  } catch (_: Exception) {
    null
  }
}

/**
 * 发系统通知的出口。抽成接口的理由和 [WebAssets] 一样：**让 HTTP 层能在没有
 * 设备的情况下被测**。安卓侧用 NotificationManager，测试侧记录调用。
 */
interface NotificationSink {
  /** 发一条通知。返回 false 表示系统层没发出去（比如没权限）。 */
  fun post(title: String, body: String): Boolean
}

/**
 * 极简本地 HTTP 服务：**只监听 127.0.0.1**，给 WebView 提供
 *   ① APK 里打包的静态资源（web/ 与 core/，与网页版同一份源码）
 *   ② 与桌面版同构的 REST 接口（实现见 Store）
 *
 * 为什么要有它（而不是直接 file:// 加载）：
 *   · file:// 下 ES module 会被 CORS 拦掉，fetch 也不能用；
 *   · localStorage 在 file:// 下是"不透明来源"，实测会丢；
 *   · 走 http://127.0.0.1 就和桌面版是同一种环境，网页代码一行都不用改。
 *
 * 为什么不用 NanoHTTPD：这个项目对"零依赖"很执着，而需求只有几十行，
 * 用 ServerSocket 手写更省事，也不用引第三个库。
 */
class LocalServer(
  private val assets: WebAssets,
  private val store: Store,
  private val port: Int = 17800,
  private val notifier: NotificationSink? = null,
  /**
   * 对外报告的版本号。**用参数注入而不是直接读 `BuildConfig`** ——
   * 这个类必须能在普通 JVM 上跑（否则那套端到端测试就废了，而它正是
   * 抓出真机白屏 bug 的地方）。安卓侧传 `BuildConfig.VERSION_NAME`，
   * 所以版本号的真相仍然只有 build.gradle 一处。
   */
  private val version: String = "0.0.0-test",
) {
  companion object {
    /** logcat 标签：`adb logcat -s TimetableHttp` 看服务端报错 */
    const val TAG = "TimetableHttp"

    /**
     * socket 读超时。真机上出现过"连上了但永不响应"：如果客户端没发完整请求，
     * 没有超时就会永久占着一个线程。10 秒足够正常请求，又不至于卡死。
     *
     */
    const val SOCKET_TIMEOUT_MS = 10_000

  }

  /** 最后一条请求行（诊断用） */
  @Volatile
  var lastRequestLine: String? = null
    private set

  /** 已处理的请求数 —— 用来判断"服务有没有在正常干活" */
  val servedCount = AtomicLong(0)

  /**
   * 最后一次处理请求时的异常。
   *
   * 为什么要留这个：原来异常被 catch 吞掉，服务端一个字节都不回、socket 还挂着，
   * 客户端干等到超时 → WebView 白屏，而日志里什么都没有。现在异常既回给客户端
   * （HTTP 500 + 文本），也留在这里，可以通过 `/api/_diag` 在设备上直接读到 ——
   * 这样即使 logcat 被 ROM 限制（实测这台 vivo 的 `logcat -d` 就是空的），
   * 也还能拿到线索。
   */
  @Volatile
  var lastError: String? = null
    private set

  /**
   * 闹钟触发记录（由安卓侧接进来）。
   * 这台 ROM 不提供 logcat，所以"闹钟到底醒了没有"只能靠落盘的记录判断。
   */
  @Volatile
  var firingLogProvider: (() -> List<String>)? = null

  /** 写触发记录失败的原因（由安卓侧接进来） */
  @Volatile
  var alarmLogErrorProvider: (() -> String?)? = null

  /**
   * 系统铃声目录（由安卓侧接进来）。
   *
   * ⚠️ 为什么做成可注入的 provider，而不是在这里直接调 `RingtoneManager`：
   *    LocalServer 刻意不依赖 `android.*`（这样能在普通 JVM 上端到端跑 HTTP 测试，
   *    见 tools/android-http.ps1）；一旦这里 import 了 android.media.RingtoneManager，
  *    整个测试脚手架就编译不过了。安卓侧在 MainActivity 里把真正的实现接上。
   *
   * 返回 `[{title, uri}]`；没接（电脑/JVM）时 /api/alarms/sounds 诚实地回空列表。
   */
  @Volatile
  var alarmSoundsProvider: (() -> List<JSONObject>)? = null

  /**
   * 分步计数器：用来在设备上定位"卡在哪一步"。
   *
   * 为什么需要：真机上出现过"请求永远不回"，而同样的代码在 JVM 里一切正常。
   * 没有分步计数就只能靠猜 —— 是 accept 没进来、还是读请求卡住、还是写响应卡住。
   */
  private val steps = java.util.concurrent.ConcurrentHashMap<String, AtomicLong>()
  private fun step(name: String) {
    steps.computeIfAbsent(name) { AtomicLong(0) }.incrementAndGet()
  }

  /** 诊断快照（给 /api/_diag 用） */
  fun diagSnapshot(): Map<String, Long> {
    val out = sortedMapOf<String, Long>()
    for ((k, v) in steps) out[k] = v.get()
    return out
  }

  private var server: ServerSocket? = null
  private val running = AtomicBoolean(false)

  /**
   * ⚠️ 线程池的两次踩坑，别再往回改：
   *
   * **第一版 `newFixedThreadPool(4)`** —— 真机白屏的元凶。每个线程处理完一个请求
   * 后会回到循环里等下一个（keep-alive，**必须**，否则 Node 的 undici 报"响应被
   * 截断"），而浏览器加载页面会并发开 6+ 个连接：前 4 个把线程占死，第 5 个开始
   * `execute` 抛 RejectedExecutionException，被 accept 循环的 catch 吞掉 → 那个
   * 连接永远不响应 → HTML 到了、其余资源全丢 → 白屏。
   *
   * **第二版 `newCachedThreadPool`** —— 修好了并发，但**没有上限**：连接洪泛时会
   * 无界创建线程。闲置连接最长占 10 秒（读超时），几十个连接就能堆出几十个线程。
   *
   * 现在用有界池：
   *   · core=8 —— 页面并发（HTML + 4 CSS + 多个 JS + API）一次大概 6~10 个
   *   · max=32 —— 突发时能顶住，但有硬上限
   *   · 队列 256，装满了**由调用线程执行**（CallerRunsPolicy）——
   *     宁可让 accept 线程慢一点，也不静默丢连接（那正是白屏的机制）
   */
  private val pool = java.util.concurrent.ThreadPoolExecutor(
    8, 32, 60L, java.util.concurrent.TimeUnit.SECONDS,
    java.util.concurrent.ArrayBlockingQueue(256),
    { r -> Thread(r, "timetable-http-worker").apply { isDaemon = true } },
    java.util.concurrent.ThreadPoolExecutor.CallerRunsPolicy(),
  )

  val url: String get() = "http://127.0.0.1:$port/"

  fun start() {
    if (running.getAndSet(true)) return
    server = ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"))
    lastError = null
    // 启动打一条，方便确认"我抓到的日志是这个进程的"
    System.err.println("[$TAG] 服务已启动 http://127.0.0.1:$port/")
    Thread {
      while (running.get()) {
        try {
          val sock = server?.accept() ?: break
          step("accepted")
          pool.execute { handle(sock) }
        } catch (e: Exception) {
          // 原来这里也是静默吞掉 —— 如果 accept 挂了（比如端口被占、socket 被关），
          // 表现出来就是"服务在监听但永不响应"，而日志里一片干净。
          if (running.get()) {
            step("acceptError")
            lastError = "accept: ${e.javaClass.simpleName}: ${e.message}"
            System.err.println("[$TAG] accept 出错: $lastError")
          } else break
        }
      }
    }.apply { isDaemon = true; name = "timetable-http" }.start()
  }

  fun stop() {
    running.set(false)
    try { server?.close() } catch (_: Exception) { }
    server = null
  }

  // -------------------------------------------------------------------------

  private fun handle(sock: Socket) {
    // 把 out 提到 try 外面，出错时才能回一个 500 给客户端
    var out: BufferedOutputStream? = null
    try {
      step("handle")
      // 读超时：真机上出现过"连上了但永不响应"。客户端如果不发完整请求
      // （或者发了但服务端读不到），没有超时就会永久占着一个线程。
      sock.soTimeout = SOCKET_TIMEOUT_MS
      sock.use { s ->
        val input = s.getInputStream()
        out = BufferedOutputStream(s.getOutputStream())
        step("conn")
        // 一个连接上可能连着好几个请求（HTTP/1.1 keep-alive）。
        // 客户端（浏览器 / WebView / Node fetch）默认会复用连接，如果服务端
        // 只处理一个请求就关掉，客户端会认为响应被截断 —— Node 的 undici 会直接
        // 抛断言错误（实测）。所以这里循环处理，直到对端不再发请求。
        while (true) {
          val req = readRequest(input) ?: break
          step("read")
          lastRequestLine = "${req.method} ${req.path}"
          sock.soTimeout = SOCKET_TIMEOUT_MS
          val body = when {
            req.path.startsWith("/api/") -> handleApi(req)
            else -> handleStatic(req)
          }
          step("route:" + if (req.path.startsWith("/api/")) "api" else "static")
          val (st, mime, bytes) = body
          writeResponse(out, st, mime, bytes)
          out.flush()
          servedCount.incrementAndGet()
          step("served")
          // 客户端声明要关，或 HTTP/1.0 且没说要 keep-alive → 收工
          val conn = (req.headers["connection"] ?: "").lowercase()
          if (conn.contains("close")) break
        }
      }
    } catch (e: Exception) {
      // ⚠️ 这里原来是个裸的 `catch (_: Exception) {}`，把错误吞掉了 ——
      //    实测后果（真机白屏）：请求处理一抛异常，服务端**一个字节都不回**、
      //    socket 还挂着，客户端一直等到超时。而且日志里什么都看不到。
      //    现在：① 记在 lastError（可通过 /api/_diag 读到）
      //          ② 尽力回一个 500 给客户端，别让它干等
      val msg = "${e.javaClass.simpleName}: ${e.message}"
      lastError = msg
      // 用 System.err 而不是 android.util.Log —— 这个类**必须能在普通 JVM 上跑**
      // （否则 tools/android-http.ps1 那套端到端测试就废了，而那正是抓出这个 bug
      //  的地方）。System.err 两边都能用：安卓上它会进 logcat（tag = System.err）。
      System.err.println("[$TAG] 处理请求出错: $msg (最后请求: $lastRequestLine)")
      e.printStackTrace()
      try {
        out?.let { writeResponse(it, 500, "text/plain; charset=utf-8", "server error: $msg"); it.flush() }
      } catch (_: Exception) { /* 回不了就算了，下面会关连接 */ }
    } finally {
      step("closed")
      // 出错也要把 socket 关掉，别让客户端干等
      try { sock.close() } catch (_: Exception) { }
    }
  }

  private class Req(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val body: String,
  )

  private fun readRequest(input: InputStream): Req? {
    // 读请求行 + 头（按 CRLF 到空行为止）
    val headerBytes = ByteArrayOutputStream()
    var prev = -1
    while (true) {
      val b = input.read()
      if (b < 0) break
      headerBytes.write(b)
      if (prev == '\r'.code && b == '\n'.code) {
        val text = String(headerBytes.toByteArray(), Charsets.UTF_8)
        if (text.endsWith("\r\n\r\n")) break
      }
      prev = b
    }
    val text = String(headerBytes.toByteArray(), Charsets.UTF_8)
    if (text.isBlank()) return null
    val lines = text.split("\r\n")
    val parts = lines.firstOrNull()?.split(" ") ?: return null
    if (parts.size < 2) return null
    val method = parts[0].uppercase()
    val rawPath = parts[1]
    val path = URLDecoder.decode(rawPath.substringBefore('?'), "UTF-8")

    val headers = mutableMapOf<String, String>()
    for (i in 1 until lines.size) {
      val idx = lines[i].indexOf(':')
      if (idx > 0) headers[lines[i].substring(0, idx).trim().lowercase()] = lines[i].substring(idx + 1).trim()
    }

    var body = ""
    val len = headers["content-length"]?.toIntOrNull() ?: 0
    if (len > 0) {
      val buf = ByteArray(len)
      var read = 0
      while (read < len) {
        val n = input.read(buf, read, len - read)
        if (n < 0) break
        read += n
      }
      body = String(buf, 0, read, Charsets.UTF_8)
    }
    return Req(method, path, headers, body)
  }

  private fun writeResponse(out: BufferedOutputStream, status: Int, mime: String, bytes: ByteArray) {
    val head = buildString {
      append("HTTP/1.1 $status ${statusText(status)}\r\n")
      append("Content-Type: $mime\r\n")
      append("Content-Length: ${bytes.size}\r\n")
      // 与桌面版一致：不缓存，改完立刻生效
      append("Cache-Control: no-store\r\n")
      // 保持连接（keep-alive）。之前这里写死 "Connection: close"，
      // 而客户端默认复用连接 —— 响应还没被读完就断了，Node 的 undici 直接抛断言。
      append("\r\n")
    }.toByteArray(Charsets.UTF_8)
    out.write(head)
    out.write(bytes)
  }

  /** reason phrase：503/501 之类以前会被写成 "Error"，不规范也不好排查 */
  private fun statusText(status: Int): String = when (status) {
    200 -> "OK"
    400 -> "Bad Request"
    404 -> "Not Found"
    405 -> "Method Not Allowed"
    502 -> "Bad Gateway"
    504 -> "Gateway Timeout"
    500 -> "Internal Server Error"
    501 -> "Not Implemented"
    else -> "Error"
  }

  private fun writeResponse(out: BufferedOutputStream, status: Int, mime: String, text: String) =
    writeResponse(out, status, mime, text.toByteArray(Charsets.UTF_8))

  // -------------------------------------------------------------------------
  // 静态资源
  // -------------------------------------------------------------------------

  private val mimeMap = mapOf(
    "html" to "text/html; charset=utf-8",
    "js" to "text/javascript; charset=utf-8",
    "mjs" to "text/javascript; charset=utf-8",
    "css" to "text/css; charset=utf-8",
    "json" to "application/json; charset=utf-8",
    "webmanifest" to "application/manifest+json; charset=utf-8",
    "svg" to "image/svg+xml",
    "png" to "image/png",
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "webp" to "image/webp",
    "ico" to "image/x-icon",
    "txt" to "text/plain; charset=utf-8",
  )

  /** assets 里的路径映射：/x → web/x；/core/y → core/y（网页里引用 core 用的是相对回退） */
  private fun assetPathFor(path: String): String? {
    val clean = path.trimStart('/')
    if (clean.isEmpty()) return "web/index.html"
    if (clean.startsWith("core/")) return clean
    return "web/$clean"
  }

  private fun handleStatic(req: Req): Triple<Int, String, ByteArray> {
    val asset = assetPathFor(req.path) ?: return notFound()
    val bytes = assets.read(asset)
    if (bytes != null) {
      val ext = asset.substringAfterLast('.', "").lowercase()
      val mime = mimeMap[ext] ?: "application/octet-stream"
      // ⚠️ 只有 HTML 需要打标。图片/CSS/JS 原样回 —— 白拷一遍大文件没有意义。
      if (ext == "html") return Triple(200, mime, withPlatformMarker(bytes))
      return Triple(200, mime, bytes)
    }
    // 找不到就回退到 index.html（SPA 路由兜底）
    val fallback = assets.read("web/index.html") ?: return notFound()
    // ⚠️ 兜底那条**也要**打标：用户直接进 /alarms 这类子路径时走的就是这条路，
    //    漏了的话"刷新一下闹钟板块就消失"（首屏拿不到标记），是最难解释的那种 bug。
    return Triple(200, mimeMap["html"]!!, withPlatformMarker(fallback))
  }

  /**
   * 给 HTML 入口**在内存里**注入一行"我在安卓壳里"的同步标记。
   *
   * 为什么必须这么做：安卓壳**没有 JS 桥**（`MainActivity` 全文没有
   * `addJavascriptInterface`），网页与壳之间只有 HTTP。于是 `web/adapter/native.js`
   * 的 `shellKind()` 在安卓上恒为 null —— 而闹钟板块的显示门控要看它。
   * 这行标记是网页唯一能在**首屏同步**就知道"我在壳里"的信号
   * （改成异步打 `/api/health` 会晚一步，界面会先闪一下"这台设备不支持闹钟"）。
   *
   * ⚠️ 绝不写回 assets 文件：写回的话，同一份网页以后**从浏览器打开**也会以为
   *    自己在壳里，数据就会跑去壳的 Store 里 —— 反过来也一样糟。
   *
   * ⚠️ 位置：插在 `<head>` 开标签之后；没有 `<head>` 就插在 `</head>` 之前；
   *    两个都没有就前置到最前面。**不能**只往最前面塞（那会跑到 `<html>`/`<!DOCTYPE>`
   *    之前，某些 WebView 会把页面当怪异模式解析）。
   */
  private fun withPlatformMarker(html: ByteArray): ByteArray {
    val text = String(html, Charsets.UTF_8)
    val marker = "<script>window.__timetablePlatform='android';</script>"
    if (text.contains(marker)) return html // 幂等：重复注入会让页面里出现两行一样的标记
    val lower = text.lowercase()
    val headStart = lower.indexOf("<head")
    val headOpenEnd = if (headStart >= 0) lower.indexOf('>', headStart) else -1
    val headEnd = lower.indexOf("</head>")
    val out = when {
      headOpenEnd >= 0 -> text.substring(0, headOpenEnd + 1) + marker + text.substring(headOpenEnd + 1)
      headEnd >= 0 -> text.substring(0, headEnd) + marker + text.substring(headEnd)
      else -> marker + text
    }
    return out.toByteArray(Charsets.UTF_8)
  }

  private fun notFound(): Triple<Int, String, ByteArray> =
    Triple(404, "text/plain; charset=utf-8", "not found".toByteArray())

  private fun jsonOk(obj: Any): Triple<Int, String, ByteArray> =
    Triple(200, "application/json; charset=utf-8", obj.toString().toByteArray(Charsets.UTF_8))

  private fun jsonErr(status: Int, message: String, extra: JSONObject? = null): Triple<Int, String, ByteArray> {
    val o = JSONObject().put("error", message)
    extra?.let { for (k in it.keys()) o.put(k, it.get(k)) }
    return Triple(status, "application/json; charset=utf-8", o.toString().toByteArray())
  }

  private fun parseBody(req: Req): JSONObject =
    try { if (req.body.isBlank()) JSONObject() else JSONObject(req.body) } catch (_: Exception) { JSONObject() }

  // -------------------------------------------------------------------------
  // API（与桌面版保持同构）
  // -------------------------------------------------------------------------

  private fun handleApi(req: Req): Triple<Int, String, ByteArray> {
    val p = req.path
    val m = req.method
    return try {
      when {
        p == "/api/health" -> jsonOk(JSONObject().apply {
          put("ok", true); put("name", "timetable"); put("version", version)
          put("platform", "android")
        })

        // 诊断：真机上不方便看日志时（有些 ROM 限制 logcat），用这个读服务端状态。
        // 只需要 `adb shell curl http://127.0.0.1:17800/api/_diag`。
        p == "/api/_diag" -> jsonOk(JSONObject().apply {
          put("served", servedCount.get())
          put("lastError", lastError ?: JSONObject.NULL)
          put("lastRequest", lastRequestLine ?: JSONObject.NULL)
          put("steps", JSONObject(diagSnapshot() as Map<*, *>))
          put("events", store.events().size)
          put("courses", store.courses().size)
          // 排演：**不记账**地问"此刻有哪些提醒该弹"（区分"闹钟没触发"和"算出来没东西"）
          put("dueNow", JSONArray(store.peekDueNotifications().map {
            "${it.title}|min=${it.minutes}|fireAt=${Store.stamp(it.fireAt)}"
          }))
          put("nextAlarmAt", store.nextAlarmAt()?.let { Store.stamp(it) } ?: JSONObject.NULL)
          put("firedLedger", JSONArray(store.firedLedger()))
          put("alarmFirings", JSONArray(firingLogProvider?.invoke() ?: emptyList<String>()))
          // 诊断代码自己失败也要看得见（曾经"排程记录根本没写"却查不出原因）
          put("alarmLogError", alarmLogErrorProvider?.invoke() ?: JSONObject.NULL)
        })

        p == "/api/state" && m == "GET" -> jsonOk(store.state())

        p == "/api/events" && m == "POST" -> jsonOk(store.upsertEvent(parseBody(req)))

        p.startsWith("/api/events/") && p.endsWith("/pop") && m == "POST" -> {
          val id = p.removePrefix("/api/events/").removeSuffix("/pop")
          // **按实例记账**：body 里带 occurrence + remainingMs 时只结束这一颗
          // （重复事件下周照常新生）。前端气泡算的剩余时间带上了"这次发生"的
          // 截止时刻，服务端算不出来，所以由它传。
          val body = runCatching { parseBody(req) }.getOrNull()
          val occ = body?.optString("occurrence", "")?.takeIf { it.isNotBlank() }
          val rm = body?.opt("remainingMs")?.let { if (it is Number) it.toLong() else null }
          val (ev, released) = store.popEvent(id, occ, rm)
          val mode = if (occ != null && store.isRecurring(ev)) "instance" else "event"
          jsonOk(JSONObject()
            .put("event", ev)
            .put("released", JSONArray(released))
            .put("mode", mode)
            .put("occurrence", occ?.let { Store.stamp(Store.parseMs(it) ?: 0L).substring(0, 10) } ?: JSONObject.NULL))
        }

        // 还原一颗（或全部）被戳破的泡泡 —— 回收气泡站用
        p.startsWith("/api/events/") && p.endsWith("/restore") && m == "POST" -> {
          val id = p.removePrefix("/api/events/").removeSuffix("/restore")
          val body = runCatching { parseBody(req) }.getOrNull()
          val occ = body?.optString("occurrence", "")?.takeIf { it.isNotBlank() }
          jsonOk(JSONObject().put("event", store.restorePopped(id, occ)))
        }

        // 回收气泡站的数据（每个事件一条，合并）
        p == "/api/recycle" && m == "GET" -> jsonOk(JSONObject().put("items", store.poppedRecords()))

        p == "/api/events/clear" && m == "POST" -> {
          store.clearEvents(parseBody(req).optBoolean("keepCourses", false))
          jsonOk(JSONObject().put("ok", true))
        }

        p.startsWith("/api/events/") -> {
          val id = p.removePrefix("/api/events/")
          when (m) {
            "PATCH" -> jsonOk(store.patchEvent(id, parseBody(req)))
            "DELETE" -> jsonOk(JSONObject().put("released", JSONArray(store.deleteEvent(id))))
            else -> jsonErr(405, "method not allowed")
          }
        }

        p == "/api/settings" && m == "PATCH" -> jsonOk(store.updateSettings(parseBody(req)))

        // ---- 闹钟（与桌面版 server/api.js:690-710 **同构**）-------------------
        //
        // ⚠️ 这几条路由以前**根本不存在** —— 网页侧 `web/adapter/store.js` 的
        //    saveAlarm/toggleAlarm/deleteAlarm 打过来直接吃 404，界面上就是
        //    "保存失败"，而闹钟板块在安卓上更是压根不显示。桌面版与安卓版
        //    共用同一个前端，所以**形状必须逐条对齐**，否则同一份前端在两端
        //    行为不同（那是最难查的一类 bug）。
        //
        // ⚠️ 业务判定在 Store.kt（校验/重复规则/归一化），这里只做"路径 → 调用"。
        //    错误一律靠 Store.ApiError 冒泡到下面的 catch —— 它带 status/code，
        //    前端要用 code 分辨"哪一项填错了"。
        p == "/api/alarms" && m == "POST" -> jsonOk(store.upsertAlarm(parseBody(req)))

        // 系统铃声目录：安卓的"自定义铃声"落地方式（不导入音频文件，见 A 段说明）。
        // ⚠️ 必须放在下面 `/api/alarms/` 的**前面** —— 否则 "sounds" 会被当成
        //    一个闹钟 id 去 PATCH/DELETE，回一句莫名其妙的"这条闹钟不在了"。
        p == "/api/alarms/sounds" && m == "GET" -> jsonOk(JSONObject().apply {
          put("sounds", JSONArray(alarmSoundsProvider?.invoke() ?: emptyList<JSONObject>()))
        })

        p.startsWith("/api/alarms/") && p.endsWith("/toggle") && m == "POST" -> {
          val id = p.removePrefix("/api/alarms/").removeSuffix("/toggle")
          // ⚠️ 开关单独一条（不让网页 PATCH 整条）：开关是最高频的操作，它不该把
          //    时刻/标签/铃声一起重发一遍 —— 那等于把网页手上的旧副本覆盖回库里。
          //    body 解析失败时按 "enabled !== false" 的真值语义 → 默认打开。
          val body = runCatching { parseBody(req) }.getOrNull()
          val on = body?.opt("enabled")?.let { it != false } ?: true
          jsonOk(store.toggleAlarm(id, on))
        }

        p.startsWith("/api/alarms/") -> {
          val id = p.removePrefix("/api/alarms/")
          when (m) {
            // PATCH 把路径上的 id **钉进** body：URL 是权威，body 里带别人的 id 不算数
            // （否则一次改名就可能把另一条闹钟覆盖掉）。
            "PATCH" -> jsonOk(store.upsertAlarm(parseBody(req).put("id", id)))
            "DELETE" -> jsonOk(JSONObject().put("ok", true).put("removed", store.removeAlarm(id)))
            // 405 而不是落到 else 的 404：404 在前端语义里是"这台设备没有这条路"，
            // 会整块降级；而"方法写错了"是完全不同的一件事。
            else -> jsonErr(405, "method not allowed: $m")
          }
        }


        p == "/api/courses" && m == "GET" -> jsonOk(JSONObject().put("courses", JSONArray(store.courses())))

        p == "/api/courses/import" && m == "POST" -> {
          val r = store.importCourses(parseBody(req))
          jsonOk(JSONObject().apply {
            put("added", r.added); put("skipped", r.skipped); put("total", r.total)
            put("problems", JSONArray(r.problems))
          })
        }

        p == "/api/backup" && m == "GET" -> jsonOk(store.state())

        p == "/api/restore" && m == "POST" -> {
          store.replaceAll(parseBody(req))
          jsonOk(JSONObject().put("events", store.events().size).put("courses", store.courses().size))
        }

        // ---- 提醒 ----------------------------------------------------------
        // due：网页端有个"页内提醒"循环会轮询这里（见 web/adapter/reminder.js），
        // 拿到就到点弹。桌面版返回的是 { items: [...] }，字段形状必须对齐，
        // 否则网页端悄悄什么都不弹（不报错，最难查）。
        // 提醒：items = 逐条提醒，digests = 课程摘要（"明天 3 门课"）。
        // 两者形状不同，所以分开返回 —— 桌面版也是这个结构（server/api.js）。
        p == "/api/reminders/due" && m == "GET" -> jsonOk(JSONObject().apply {
          put("items", JSONArray(store.dueReminders()))
          put("digests", JSONArray(store.dueDigests().map { d ->
            JSONObject().apply {
              put("key", d.key)
              put("slot", d.slot)
              put("title", d.title)
              put("body", d.body)
              put("count", d.count)
            }
          }))
        })

        // test：设置页的「发送一条测试通知」按钮打这里。
        // ⚠️ 这条以前没实现 —— 前端会调，而后端返回 404，点一下就是"测试失败"。
        // 通知是这个应用的卖点，所以必须真的发得出去。
        p == "/api/reminders/test" && m == "POST" -> {
          val sink = notifier
          val ok = sink?.post("日程表 · 测试通知", "如果你看到这条，说明通知是通的") ?: false
          if (ok) jsonOk(JSONObject().put("ok", true))
          else jsonErr(500, "没有可用的通知渠道（可能是没给通知权限）", JSONObject().put("ok", false))
        }

        // 账本：桌面版返回 { day, keys }。形状对齐，网页端/调试都能直接用。
        p == "/api/reminders/ledger" -> jsonOk(
          JSONObject()
            .put("day", java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date()))
            .put("keys", JSONArray(store.firedLedger())),
        )

        // 在线导入需要访问外网，v1 未实现。
        p.startsWith("/api/courses/tj/") -> jsonErr(
          501,
          "安卓版暂未实现在线拉取；请把数据粘贴进来导入（那一步完全在前端完成）",
        )
        p == "/api/courses/import-scheduler" -> {
          // 这条也走前端适配器，客户端会带 courses 直接调 /api/courses/import；
          // 若真调到这里，说明是旧路径，明确告知。
          jsonErr(501, "请改用 /api/courses/import（前端适配器已把数据转换好）")
        }

        p == "/api/system/autolaunch" -> jsonOk(JSONObject().put("autoLaunch", false))

        else -> jsonErr(404, "not found: $p")
      }
    } catch (e: Store.ApiError) {
      // ⚠️ code / errors 必须一起回给前端：网页侧要用 code 分辨"是小时填错了
      //    还是重复规则填错了"（`ALARM_HOUR` / `ALARM_WEEKDAYS` …），只给一句
      //    中文 message 的话，界面只能把整块标红、指不出是哪一项。
      jsonErr(e.status, e.message ?: "bad request", JSONObject().apply {
        e.code?.let { put("code", it) }
        e.errorsJson?.let { put("errors", it) }
      })
    } catch (e: Exception) {
      jsonErr(500, e.message ?: "internal error")
    }
  }
}

