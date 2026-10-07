package com.timetable.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * 常驻服务：让本地数据/提醒在后台活着。
 *
 * 为什么需要它：日程提醒的价值就在"你不在看它的时候也会响"。
 * 普通 Activity 一切后台就可能被系统回收，提醒也就没了。
 * 这一版只负责"保活 + 通知渠道"，真正的到点调度放下一步（用 AlarmManager）。
 */
class LocalServerService : Service() {

  companion object {
    const val CHANNEL_ID = "timetable_reminders"
    private const val NOTI_ID = 1
  }

  override fun onCreate() {
    super.onCreate()
    createChannel()
    startForeground(NOTI_ID, buildNotification())
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = getSystemService(NotificationManager::class.java)
    if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
    val ch = NotificationChannel(
      CHANNEL_ID,
      "日程提醒",
      // 提醒要"能吵醒你"，所以用 HIGH；具体强度由网页那边的档位决定文案与时间
      NotificationManager.IMPORTANCE_HIGH,
    ).apply {
      description = "到点提醒你的日程"
      enableVibration(true)
    }
    mgr.createNotificationChannel(ch)
  }

  private fun buildNotification(): Notification =
    NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("日程表在运行")
      .setContentText("会在日程到点时提醒你")
      .setSmallIcon(android.R.drawable.ic_menu_my_calendar)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true)
      .build()

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

  /**
   * Android 15+ 对 `dataSync` 型前台服务有"6 小时 / 24 小时"上限。
   *
   * 到点系统不杀我们，而是**回调这里**；如果应用不自己停掉，就会被判 ANR
   * （"应用无响应"弹窗 —— 比服务停掉糟糕得多，用户会以为应用坏了）。
   * 所以这里直接 `stopSelf()`：停掉不影响数据（数据都在 db.json 里），
   * 下次打开 App 会重新 `startForegroundService` 拉起来。
   *
   * 老系统不会调到这个方法（compileSdk 35 下能正常编译）。
   */
  override fun onTimeout(startId: Int) {
    stopSelf()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
