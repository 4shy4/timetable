package com.timetable.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import java.security.MessageDigest

/**
 * 安卓侧的通知出口：把通知真正发到系统通知中心。
 *
 * 为什么需要它：设置页有个「发送一条测试通知」按钮，打的是
 * `POST /api/reminders/test`。桌面版由后台服务发 Windows 通知；
 * 安卓端如果没实现这个路由，点了就是"测试失败" —— 而通知是这个应用的卖点。
 *
 * 这里用 [LocalServerService.CHANNEL_ID] 那个渠道（IMPORTANCE_HIGH，会响会震）。
 *
 * 另外它还负责**闹钟**那条路（见下面的 [post] 三参重载）：闹钟要按"闹钟"的
 * 行为响（`USAGE_ALARM`），而不是按普通通知响 —— 否则插着耳机/静音场景下
 * 行为完全不同，用户会觉得"闹钟不响"。
 */
class AndroidNotifier(private val context: Context) : NotificationSink {

  companion object {
    /** 提醒通知的 id 从这里递增，避免新通知覆盖旧的 */
    private const val BASE_ID = 1000

    /** 用系统默认闹钟音、但按"闹钟"行为播的那个渠道 */
    const val ALARM_CHANNEL_ID = "timetable_alarm_default"

    /** 指定了铃声的渠道 id 前缀 */
    private const val ALARM_CHANNEL_PREFIX = "timetable_alarm_"

    /**
     * 从闹钟记录的 `sound` 字段取出"系统铃声 URI"。
     *
     * 约定与 `core/alarms.js` 对齐：`custom:` 前缀 = 用户自己挑的那一首
     * （那边指"导入的音频文件"，安卓这边**不做文件导入**，落地成系统铃声 URI）。
     * 认不出来的（内置的 morning/triple/… 那些是**网页合成的音**，系统渠道放不出来）
     * 一律返回 null → 用系统默认闹钟音。
     *
     * ⚠️ 只放行 `content://` / `file://` / `android.resource://`：`sound` 是网页传上来的
     *    字符串，不校验的话一条乱写的数据会让 `setSound` 抛异常，整个闹钟就不响了。
     */
    fun soundUriOf(sound: String?): String? {
      val s = sound?.trim().orEmpty()
      if (s.isEmpty()) return null
      val raw = if (s.startsWith(Store.CUSTOM_SOUND_PREFIX)) s.removePrefix(Store.CUSTOM_SOUND_PREFIX) else s
      return if (raw.startsWith("content://") || raw.startsWith("file://") || raw.startsWith("android.resource://")) {
        raw
      } else {
        null
      }
    }
  }

  private var nextId = BASE_ID

  override fun post(title: String, body: String): Boolean =
    send(LocalServerService.CHANNEL_ID, title, body, alarmish = false)

  /**
   * 闹钟专用的重载：`soundUri` 为 null 时用**系统默认闹钟音**。
   *
   * ⚠️ 为什么不复用 [post] 两参版：那个走的是 `timetable_reminders` 渠道（普通提醒，
   *    用默认**通知**音）。闹钟得走自己的渠道，理由有两个：
   *      ① 声音必须是"闹钟音"这一档（`USAGE_ALARM`），不然静音/耳机下的行为不对；
   *      ② Android 8+ **渠道的声音建好之后不可改** —— 想换铃声只能**新建一个渠道 id**。
   *         所以这里按 uri 稳定派生 id（同一个铃声复用同一条渠道，不会每响一次
   *         就在系统设置里多出一条渠道）。
   */
  fun post(title: String, body: String, soundUri: String?): Boolean {
    val channelId = try {
      val mgr = context.getSystemService(NotificationManager::class.java) ?: return false
      ensureAlarmChannel(mgr, soundUri)
    } catch (_: Exception) {
      return false
    }
    return send(channelId, title, body, alarmish = true)
  }

  private fun send(channelId: String, title: String, body: String, alarmish: Boolean): Boolean = try {
    val mgr = context.getSystemService(NotificationManager::class.java) ?: return false
    if (!alarmish) ensureChannel(mgr)
    val b = NotificationCompat.Builder(context, channelId)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setSmallIcon(android.R.drawable.ic_menu_my_calendar)
      .setPriority(if (alarmish) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
    if (alarmish) {
      // CATEGORY_ALARM 让系统把它当闹钟对待：锁屏上更显眼、不被"静默通知"折叠
      b.setCategory(NotificationCompat.CATEGORY_ALARM)
    }
    mgr.notify(nextId++, b.build())
    true
  } catch (_: SecurityException) {
    // 没有 POST_NOTIFICATIONS 权限（Android 13+ 用户拒绝过）
    false
  } catch (_: Exception) {
    false
  }

  /**
   * 建/复用"闹钟"渠道，回渠道 id。
   *
   * `soundUri == null` → 用 `RingtoneManager.TYPE_ALARM` 的系统默认闹钟音。
   * ⚠️ 不是"什么都不设"：不设 `setSound` 的话渠道会用**默认通知音**，
   *    对闹钟来说那通常太轻，用户会认为"闹钟没响"。
   */
  private fun ensureAlarmChannel(mgr: NotificationManager, soundUri: String?): String {
    // Android 8 以下没有渠道概念，渠道 id 只是个占位
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return ALARM_CHANNEL_ID

    val uri: Uri? = soundUri?.let { Uri.parse(it) }
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
    val id = if (uri != null && soundUri != null) {
      ALARM_CHANNEL_PREFIX + sha1(soundUri).take(12)
    } else {
      ALARM_CHANNEL_ID
    }
    if (mgr.getNotificationChannel(id) != null) return id

    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    mgr.createNotificationChannel(
      NotificationChannel(id, "闹钟", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "闹钟到点时会响"
        enableVibration(true)
        setSound(uri, attrs)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      },
    )
    return id
  }

  private fun sha1(s: String): String {
    val md = MessageDigest.getInstance("SHA-1")
    val bytes = md.digest(s.toByteArray(Charsets.UTF_8))
    val sb = StringBuilder(bytes.size * 2)
    for (b in bytes) sb.append("%02x".format(b))
    return sb.toString()
  }

  private fun ensureChannel(mgr: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (mgr.getNotificationChannel(LocalServerService.CHANNEL_ID) != null) return
    mgr.createNotificationChannel(
      NotificationChannel(
        LocalServerService.CHANNEL_ID,
        "日程提醒",
        NotificationManager.IMPORTANCE_HIGH,
      ).apply {
        description = "到点提醒你的日程"
        enableVibration(true)
      },
    )
  }
}

