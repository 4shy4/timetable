package com.timetable.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat

/**
 * 主界面：一个 WebView，加载本机 127.0.0.1 上的服务。
 *
 * 设计取舍：**界面完全不重写**。气泡面板、课表、月历这些已经在 web/ 里调好了，
 * 而 core/ 本来就是平台无关的纯逻辑。所以安卓端只补"外壳"：
 * 起本地服务 → 把 WebView 指过去 → 申请通知权限。
 *
 * 这么做的直接好处：网页版改进界面，安卓版跟着一起变，不会出现两套 UI 分叉。
 */
class MainActivity : AppCompatActivity() {

  private var webView: WebView? = null
  private var server: LocalServer? = null
  private var store: Store? = null

  companion object {
    const val PORT = 17800
    private const val REQ_NOTIFY = 1001
    /** logcat 标签：`adb logcat -s TimetableWeb` 直接看页面里的报错 */
    const val WEB_TAG = "TimetableWeb"
    /** 启动时带上这个 extra 就打开页面的调试叠层（自动化测试用来拿气泡真实坐标） */
    const val EXTRA_DEBUG = "timetable.debug"
  }

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    store = appStore(applicationContext)
    // 数据一变就重排提醒闹钟 —— 让"到点提醒"在界面关掉之后依然有效。
    // 挂 onChanged（persist 的必经之路），所以新建/编辑/删除/导入课表都覆盖到。
    store!!.onChanged = { ReminderAlarms.reschedule(applicationContext) }
    server = LocalServer(
      AndroidAssets(assets),
      store!!,
      PORT,
      AndroidNotifier(applicationContext),
      // 版本号从 build.gradle 来（BuildConfig），不在 Kotlin 里硬编码
      BuildConfig.VERSION_NAME,
    ).also { it.start() }
    // 把"闹钟触发记录"接到服务上，供 /api/_diag 读（这台 ROM 不给 logcat，
    // 落盘的记录是唯一可靠的可观测性）
    server!!.firingLogProvider = { ReminderAlarms.readFiring(applicationContext) }
    server!!.alarmLogErrorProvider = { ReminderAlarms.lastLogError }
    // 系统铃声清单（闹钟的"选铃声"用）。⚠️ 做成**注入**而不是让 LocalServer 自己
    // import RingtoneManager：LocalServer 刻意不依赖 android.*，这样才能在普通 JVM 上
    // 被 tools/android-http.test.mjs 端到端跑（没有真机也能验证 HTTP 层）。
    server!!.alarmSoundsProvider = { listSystemRingtones(applicationContext) }
    // 启动时排一次：上次运行留下的闹钟可能在重启后已经没了
    ReminderAlarms.reschedule(applicationContext)

    // 常驻服务：切到后台也别被回收，否则提醒就没了
    ContextCompat.startForegroundService(this, Intent(this, LocalServerService::class.java))

    val wv = WebView(this)
    setContentView(wv, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    webView = wv

    wv.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true          // 网页用 localStorage 存视图偏好等
      databaseEnabled = true
      allowFileAccess = false
      // 只允许访问本地服务，不需要 file:// 或跨域
      mediaPlaybackRequiresUserGesture = false
      cacheMode = WebSettings.LOAD_NO_CACHE
      // 让网页里的 100dvh / safe-area 表现正常
      useWideViewPort = true
      loadWithOverviewMode = false
    }
    wv.setBackgroundColor(0xFFF5F6F8.toInt())

    /**
     * 让 WebView 里的 JS 错误**可见**。
     *
     * 为什么必须有：界面有一块渲染失败时，页面上只会"少一块"，什么提示都没有。
     * 没有这个，就只能靠猜是哪行代码挂了 —— 实测就是这么卡住的。
     * 页面的 console.error / 未捕获异常都会转到 logcat，用
     *   adb logcat -s TimetableWeb
     * 就能直接看到。
     */
    wv.webChromeClient = object : WebChromeClient() {
      override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
        // 按**真实级别**记，不要一律 ERROR —— 否则 info 级日志混进错误流，
        // 排查时 `logcat *:E` 全是噪音。
        val tag = WEB_TAG
        val text = msg.message() + " @ " + msg.sourceId() + ":" + msg.lineNumber()
        when (msg.messageLevel()) {
          ConsoleMessage.MessageLevel.ERROR -> Log.e(tag, text)
          ConsoleMessage.MessageLevel.WARNING -> Log.w(tag, text)
          ConsoleMessage.MessageLevel.DEBUG -> Log.d(tag, text)
          else -> Log.i(tag, text)
        }
        return true
      }
    }

    wv.webViewClient = object : WebViewClient() {
      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
      ) {
        // 资源加载失败（主文档或子资源）—— 白屏最常见的原因
        val desc = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) error.description?.toString() else ""
        Log.e(WEB_TAG, "资源加载失败 ${request.url} :: $desc")
      }

      override fun onPageFinished(view: WebView, url: String) {
        // 顺手把渲染结果记一笔：body 有没有内容、关键元素在不在。
        // 这样"到底是白屏还是渲染少了"一眼可辨，不用截图猜。
        view.evaluateJavascript(
          """
          (function(){
            try {
              var b = document.body;
              var nav = document.querySelectorAll('.nav-item').length;
              var stage = !!document.querySelector('.bubble-stage');
              var canvas = !!document.querySelector('.bubble-canvas');
              var title = document.querySelector('.topbar-title, #view-title, .title-block');
              console.log('[diag] title=' + (title ? title.textContent.trim() : '(无)')
                + ' navItems=' + nav + ' stage=' + stage + ' canvas=' + canvas
                + ' bodyTextLen=' + (b ? b.innerText.length : -1));
              // 气泡的**真实屏幕坐标**：自动化测试要靠它才能点准。
              // 气泡一直在飘，靠截图估坐标点不中（实测浪费了很多轮）。
              // 这是**只读**探针，不参与任何产品逻辑。
              var cv = document.querySelector('.bubble-canvas');
              if (cv) {
                var r = cv.getBoundingClientRect();
                console.log('[diag] canvas rect=' + Math.round(r.left) + ',' + Math.round(r.top)
                  + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
                  + ' dpr=' + window.devicePixelRatio);
                var dbg = document.querySelector('.bubble-debug');
                if (dbg) console.log('[diag] debug=' + dbg.textContent);
              }
            } catch (e) { console.log('[diag] 探针自身出错: ' + e.message); }
          })();
          """.trimIndent(),
          null,
        )
      }
    }

    // 只有 debug 构建才开远程调试（release 里这是个不必要的攻击面）
    if (BuildConfig.DEBUG) {
      WebView.setWebContentsDebuggingEnabled(true)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      wv.settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
    }

    wv.loadUrl("http://127.0.0.1:$PORT/" + if (intent?.getBooleanExtra(EXTRA_DEBUG, false) == true) "?debug=1" else "")

    askNotificationPermission()
  }

  /**
   * 列出系统铃声，供闹钟"选铃声"用。
   *
   * ⚠️ 这是**安卓上"能自定义铃声"的落地方式**：不做音频文件导入（那还要
   *    `onShowFileChooser` 那套东西，见 task 说明），直接把系统里已有的铃声
   *    列出来给用户挑 —— 用户想用自己的音乐，系统铃声里本来就有他的音乐。
   *
   * ⚠️ 类型带上 `TYPE_NOTIFICATION` 而不只是 `TYPE_ALARM`：不少机型的"闹钟"一档
   *    只有三四首，而用户心里"我的铃声"往往是通知音里的那一首。
   *
   * 返回 `[{title, uri}]`；uri 是 `content://`，网页那边存成 `custom:<uri>`
   * （就是 `core/alarms.js` 里"用户自己挑的那一首"那个前缀，安卓这边不导文件）。
   */
  private fun listSystemRingtones(ctx: android.content.Context): List<org.json.JSONObject> {
    val out = mutableListOf<org.json.JSONObject>()
    try {
      val rm = android.media.RingtoneManager(ctx)
      rm.setType(android.media.RingtoneManager.TYPE_ALARM or android.media.RingtoneManager.TYPE_NOTIFICATION)
      val cursor = rm.cursor ?: return out
      val seen = mutableSetOf<String>()
      try {
        while (cursor.moveToNext()) {
          val uri = rm.getRingtoneUri(cursor.position) ?: continue
          val key = uri.toString()
          if (!seen.add(key)) continue
          val title = cursor.getString(android.media.RingtoneManager.TITLE_COLUMN_INDEX) ?: continue
          out.add(org.json.JSONObject().put("title", title).put("uri", key))
        }
      } finally {
        cursor.close()
      }
    } catch (e: Exception) {
      // 铃声服务拿不到（个别 ROM 会）不能影响别的功能 —— 回空列表，界面就当没得选
      Log.w(WEB_TAG, "列系统铃声失败: ${e.javaClass.simpleName}: ${e.message}")
    }
    return out
  }

  /** Android 13+ 弹通知必须显式申请，否则通知会静默失败 */
  private fun askNotificationPermission() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
      == PackageManager.PERMISSION_GRANTED
    ) return
    ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
  }

  override fun onDestroy() {
    webView?.destroy()
    webView = null
    server?.stop()
    server = null
    super.onDestroy()
  }
}
