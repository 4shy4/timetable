package com.timetable.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * 开机自启：把常驻服务拉起来，并**重新注册提醒闹钟**。
 *
 * 为什么必须重注册：`AlarmManager` 里的闹钟**重启后就没了**（这是系统行为，
 * 不是 bug）。所以开机必须排一次，否则重启一次手机，提醒就永久失效 ——
 * 而且不会有任何报错，属于"静默失效"里最坑的一种。
 *
 * （桌面版是写注册表 Run 键，这里是收 BOOT_COMPLETED 广播 —— 目的相同。）
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    try {
      ContextCompat.startForegroundService(context, Intent(context, LocalServerService::class.java))
    } catch (_: Exception) {
      // Android 12+ 对后台启动前台服务有额外限制，失败不影响主流程
    }
    // 即使上面失败也要排闹钟 —— 两件事互不依赖
    try {
      ReminderAlarms.reschedule(context)
    } catch (_: Exception) {
      // 忽略
    }
  }
}
