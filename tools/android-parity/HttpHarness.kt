// 在普通 JVM 上启动**真正的 LocalServer**，从磁盘读 web/ 作为静态资源，
// 然后等外部（Node）用 fetch 打它。这样 HTTP 层不需要安卓设备就能端到端验证。
//
// 为什么要这么绕：LocalServer 原本直接吃 Android 的 AssetManager，那就只有到
// 手机上才能发现问题 —— 而测试的意义恰恰是在没有手机时发现问题。所以把资源
// 来源抽成 WebAssets 接口，安卓侧包 AssetManager，这里从目录读。
//
// 测试侧实现：直接从磁盘目录读。root 必须是 assets 的根（仓库根目录），
// 因为资源键带 `web/`、`core/` 前缀。
class DirAssets(private val root: File) : WebAssets {
  override fun read(path: String): ByteArray? {
    val f = File(root, path)
    if (!f.isFile) return null
    return try { f.readBytes() } catch (_: Exception) { null }
  }
}

/**
 * 假的通知出口：把发出去的通知记下来。
 *
 * 有它才能测到"通知真的发出去了"这条**成功路径** —— 否则在不接安卓通知服务的
 * 环境里，/api/reminders/test 只会走失败分支，成功分支一行都覆盖不到。
 * 通知出口是可注入的（NotificationSink 接口），所以这里能拿到真实调用。
 */
object RecordingNotifier : NotificationSink {
  val sent = java.util.Collections.synchronizedList(mutableListOf<String>())

  override fun post(title: String, body: String): Boolean {
    sent.add("$title|$body")
    return true
  }
}

// 用法：HttpMergedKt <assetsRoot> <dataDir> <port>
//
// assetsRoot 要指向"assets 的根"，也就是**仓库根目录** —— 因为 LocalServer
// 里的资源键是 `web/index.html`、`core/countdown.js` 这种带前缀的路径，
// 对应 APK 里 assets/ 下面的实际位置。指到 web/ 会让所有静态资源 404
// （第一版就是这么错的，被 http 测试抓出来了）。
fun main(args: Array<String>) {
  val assetsRoot = File(args.getOrElse(0) { "." })
  val dataDir = File(args.getOrElse(1) { "build/android-parity-http" })
  val port = args.getOrElse(2) { "17801" }.toInt()

  if (!File(assetsRoot, "web/index.html").isFile) {
    System.err.println("assets root has no web/index.html: ${assetsRoot.absolutePath}")
    kotlin.system.exitProcess(2)
  }
  dataDir.mkdirs()

  val store = Store(File(dataDir, "db.json"))
  val server = LocalServer(DirAssets(assetsRoot), store, port, RecordingNotifier)
  server.start()

  // 告诉外部"起来了 + 端口是多少"
  println("READY ${server.url}")
  System.out.flush()

  // 打完一轮后由外部杀掉；这里只需要活着
  Thread.currentThread().join()
}
