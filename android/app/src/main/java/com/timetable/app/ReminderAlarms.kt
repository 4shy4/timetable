package com.timetable.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import java.io.File

/**
 * 到点提醒的**原生排程**。
 *
 * 为什么需要它：`/api/reminders/due` 那条路（网页每 20 秒轮询）只在**界面开着**
 * 的时候有效 —— 关掉界面就不响了。而"到点提醒你"正是这个应用的卖点，
 * 所以必须由系统层掐点。这里用 `AlarmManager`：
 *
 *   · 只注册**一个**闹钟，指向"下一次该响的时刻"
 *   · 它响的时候（[ReminderReceiver]）在原生侧弹通知，并重新注册下一个
 *
 * 为什么是"一次一个"而不是每个提醒一个闹钟：
 *   每个提醒一个闹钟的话，一门每周的课一学期就是十几个待定闹钟，
 *   注册/取消的开销和出错面都大得多。而"醒来 → 算下一个 → 再注册"
 *   这个循环天然自洽，重启后也只需要重新注册一次。
 *
 * 为什么用 setExactAndAllowWhileIdle 而不是 set()：
 *   `set()` 在打盹（Doze）模式下会被推迟到几十分钟后，对"提前 10 分钟提醒"
 *   来说等于失效。代价是它更费电，所以**只在真的有待办提醒时才注册**。
 */
object ReminderAlarms {

  const val EXTRA_SOURCE = "source"
  private const val REQ_CODE = 8801

  /** 触发记录的文件名（放在 filesDir 下，供 /api/_diag 读） */
  const val FIRING_LOG = "alarm-firing.json"
  private const val FIRING_LOG_MAX = 30

  /**
   * 记一笔"闹钟醒了"。
   *
   * 为什么必须落盘：这台 vivo 的 ROM 不把应用的 System.err / logcat 交出来
   * （`adb logcat -d` 是空的），所以"闹钟到底有没有醒"在现场无从判断。
   * 写进文件之后，`/api/_diag` 就能读出来 —— 这是唯一可靠的可观测性。
   *
   * ⚠️ 必须同步：它会被 **HTTP 线程**（写事件 → onChanged → reschedule）
   *    和**闹钟线程**同时调用。而这里是"读整个文件 → 改 → 写回"，
   *    没有锁就会丢记录（并发写还会互相覆盖）。
   */
  fun appendFiring(ctx: Context, line: String) {
    synchronized(FIRING_LOCK) {
      try {
        val f = File(ctx.filesDir, FIRING_LOG)
        val old = if (f.exists()) f.readText() else "[]"
        val arr = try { org.json.JSONArray(old) } catch (_: Exception) { org.json.JSONArray() }
        arr.put(line)
        while (arr.length() > FIRING_LOG_MAX) arr.remove(0)
        // 先写临时文件再改名：进程在写入中途被杀不会留下半截 JSON
        val tmp = File(ctx.filesDir, "$FIRING_LOG.tmp")
        tmp.writeText(arr.toString())
        if (f.exists()) f.delete()
        tmp.renameTo(f)
        lastLogError = null
      } catch (e: Exception) {
        // 记录失败不能影响提醒本身 —— 但**必须留下痕迹**。
        // 这台设备上一度出现"排程记录根本没写、却查不出为什么"的情况，
        // 就是因为这里把异常整个吞了。诊断代码自己出问题也要看得见。
        lastLogError = "${e.javaClass.simpleName}: ${e.message}"
        System.err.println("[TimetableAlarm] 写触发记录失败: $lastLogError")
      }
    }
  }

  /** 最近一次写触发记录失败的原因（null = 正常）。经 /api/_diag 暴露 */
  @Volatile
  var lastLogError: String? = null
    private set

  private val FIRING_LOCK = Any()

  fun readFiring(ctx: Context): List<String> = synchronized(FIRING_LOCK) {
    try {
      val f = File(ctx.filesDir, FIRING_LOG)
      if (!f.exists()) emptyList()
      else org.json.JSONArray(f.readText()).let { a -> (0 until a.length()).map { a.optString(it) } }
    } catch (_: Exception) {
      emptyList()
    }
  }

  private fun pendingIntent(ctx: Context): PendingIntent {
    val i = Intent(ctx, ReminderReceiver::class.java).setAction(ReminderReceiver.ACTION_FIRE)
    var flags = PendingIntent.FLAG_UPDATE_CURRENT
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags = flags or PendingIntent.FLAG_IMMUTABLE
    return PendingIntent.getBroadcast(ctx, REQ_CODE, i, flags)
  }

  fun dbFile(ctx: Context): File = File(ctx.filesDir, "db.json")

  /**
   * 重新排下一次闹钟。**任何改动事件之后都该调它**（新建/编辑/删除/导入课表），
   * 否则改了日程但闹钟还指着旧时间。
   */
  fun reschedule(ctx: Context, nowMs: Long = System.currentTimeMillis()) {
    val am = ctx.getSystemService(AlarmManager::class.java) ?: run {
      appendFiring(ctx, "${Store.stamp(System.currentTimeMillis())} 拿不到 AlarmManager")
      return
    }
    val store = Store(dbFile(ctx))
    val next = store.nextAlarmAt(nowMs)
    val pi = pendingIntent(ctx)

    if (next == null) {
      // 没有待办提醒 → 取消闹钟，别让它白白占着精确闹钟的名额
      am.cancel(pi)
      return
    }

    val exact = canScheduleExact(am)
    try {
      if (exact) {
        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi)
      } else {
        // Android 12+ 用户可能没给"闹钟与提醒"权限；退化成不精确的
        // （会晚一点，但总比完全不响好）。
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next, pi)
      }
      // 每次排程都记一笔：真机上"闹钟不响"最难区分的就是
      // 「排程时就退化了」还是「排上了但系统没触发」。记下权限状态和实际用的 API，
      // 一眼就能分清。
      appendFiring(
        ctx,
        "${Store.stamp(System.currentTimeMillis())} 已排程 → ${Store.stamp(next)} "
          + "(精确=${exact}${if (exact) " setExactAndAllowWhileIdle" else " setAndAllowWhileIdle(退化)"})",
      )
    } catch (e: SecurityException) {
      // ⚠️ 原来这里是裸的空 catch，把错误吞了 —— 实测后果：闹钟**注册不上**
      //    但界面上看不出任何异常，只是到点不响。必须记下来。
      appendFiring(
        ctx,
        "${Store.stamp(System.currentTimeMillis())} 排程被拒(SecurityException): ${e.message}",
      )
      System.err.println("[TimetableAlarm] 排程被拒: ${e.message}")
    } catch (e: Exception) {
      appendFiring(
        ctx,
        "${Store.stamp(System.currentTimeMillis())} 排程失败(${e.javaClass.simpleName}): ${e.message}",
      )
      System.err.println("[TimetableAlarm] 排程失败: ${e.javaClass.simpleName}: ${e.message}")
    }
  }

  fun cancel(ctx: Context) {
    ctx.getSystemService(AlarmManager::class.java)?.cancel(pendingIntent(ctx))
  }

  /** Android 12+ 需要用户在系统里允许"闹钟与提醒"；之前的版本默认可以 */
  fun canScheduleExact(am: AlarmManager): Boolean =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.canScheduleExactAlarms() else true
}

/**
 * 闹钟到点：**在原生侧直接弹通知**，然后排下一个。
 *
 * 注意这里刻意不依赖本地 HTTP 服务 / WebView —— 闹钟可能在应用被杀掉之后
 * 触发，那时候服务不一定活着。所以它自己开 Store（读同一个 db.json）、
 * 自己算、自己发，链路最短。
 */
class ReminderReceiver : BroadcastReceiver() {

  companion object {
    const val ACTION_FIRE = "com.timetable.app.REMINDER_FIRE"
    /** 拿一个短唤醒锁，保证写账本 + 发通知这段不被立刻挂起 */
    private const val WAKE_MS = 10_000L
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_FIRE) return

    val pm = context.getSystemService(PowerManager::class.java)
    val lock = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "timetable:reminder")
    try {
      lock?.acquire(WAKE_MS)
      val store = Store(ReminderAlarms.dbFile(context))
      val notifier = AndroidNotifier(context)

      val nowMs = System.currentTimeMillis()
      val peek = store.peekDueNotifications(nowMs)
      val next = store.nextAlarmAt(nowMs)
      System.err.println(
        "[TimetableAlarm] 闹钟醒了 now=${Store.stamp(nowMs)} 待发=${peek.size} " +
          "下一条=${next?.let { Store.stamp(it) } ?: "无"}",
      )

      // takeDueNotifications 会**同时记账**，所以即使闹钟重复触发也不会重复弹
      var posted = 0
      for (d in store.takeDueNotifications(nowMs)) {
        val when_ = when {
          d.minutes == 0 -> "现在开始"
          d.minutes > 0 -> "${d.minutes} 分钟后"
          else -> "已开始 ${-d.minutes} 分钟"
        }
        val body = buildString {
          append(when_)
          if (d.location.isNotBlank()) append(" · ").append(d.location)
        }
        val ok = notifier.post("⏰ ${d.title}", body)
        posted += 1
        ReminderAlarms.appendFiring(context, "${Store.stamp(nowMs)} 发通知 ${d.title} min=${d.minutes} ok=$ok")
      }

      // 课程摘要（"明天 3 门课"）也走这条通道 —— 用户要求"前一天晚上提醒明天课程，
      // 早上提醒上午课程…"。和逐条提醒共用同一个 Store 账本，所以不会重复弹。
      for (g in store.takeDueDigests(nowMs)) {
        val ok = notifier.post("📚 ${g.title}", g.body)
        posted += 1
        ReminderAlarms.appendFiring(context, "${Store.stamp(nowMs)} 发摘要 ${g.title} (${g.count} 门) ok=$ok")
      }

      if (posted == 0) {
        ReminderAlarms.appendFiring(
          context,
          "${Store.stamp(nowMs)} 醒了但无到点提醒（排演 ${peek.size} 条，下一条 ${next?.let { Store.stamp(it) } ?: "无"}）",        )
      }

      // ---- 闹钟（定时器 / 计时器）----
      //
      // ⚠️ 这一段是"用户能自己加闹钟"真正兑现的地方：网页只管把闹钟**写进库**，
      //    到点叫醒完全靠这里（界面关着、应用被杀掉也照样响）。
      //
      // ⚠️ "到点"的判定用 `store.dueAlarms(now)`（±90 秒容差窗口，见
      //    `Store.alarmFireWindowMs`），**不要**改成"拿 nextAlarmAt 比一次"：
      //    用户在系统设置里撤掉"闹钟与提醒"的精确授权后，`ReminderAlarms` 会退化成
      //    `setAndAllowWhileIdle`，系统可能晚几分钟才叫醒我们 —— 那一刻按"下一次
      //    触发时刻"算出来已经是明天了，diff 整整差一天，于是**被推迟的那次永远
      //    判不出到点**。用户看到的就是"闹钟偶尔不响"，且完全无法复现。
      for (a in store.dueAlarms(nowMs)) {
        val kind = a.optString("kind", "clock")
        val hour = a.optInt("atHour", 7)
        val minute = a.optInt("atMinute", 0)
        val hhmm = "%02d:%02d".format(hour, minute)
        val label = a.optString("label", "").trim()
        val title = "⏰ " + label.ifBlank { if (kind == "timer") "计时器" else hhmm }
        val body = if (kind == "timer") "计时结束" else "闹钟到点了（$hhmm）"
        // sound 认不出来（内置铃声是网页合成的音，系统渠道放不出来）→ null 用系统默认闹钟音
        val soundUri = AndroidNotifier.soundUriOf(a.optString("sound", ""))
        val ok = notifier.post(title, body, soundUri)
        posted += 1
        // ⚠️ 必须记账：不记的话下一次唤醒（或系统的重复投递）会把它**再响一遍**。
        //    "单次/计时器"会被关掉，重复的照旧留着 —— 与 core/alarms.js 的
        //    markFired 同语义（见 Store.markAlarmFired）。
        store.markAlarmFired(a.optString("id"), nowMs)
        ReminderAlarms.appendFiring(
          context,
          "${Store.stamp(nowMs)} 发闹钟 ${a.optString("id")} $hhmm kind=$kind ok=$ok 铃声=${soundUri ?: "系统默认"}",
        )
      }
    } catch (e: Exception) {
      // 闹钟里出错不能崩（崩了系统会认为应用反复失败）
      ReminderAlarms.appendFiring(context, "${Store.stamp(System.currentTimeMillis())} 出错 ${e.javaClass.simpleName}: ${e.message}")
      System.err.println("[TimetableAlarm] 出错: ${e.javaClass.simpleName}: ${e.message}")
      e.printStackTrace()
    } finally {
      try { lock?.release() } catch (_: Exception) { }
    }

    // 排下一次：必须放在最后，且无论上面成功与否都要排
    try {
      ReminderAlarms.reschedule(context)
    } catch (e: Exception) {
      ReminderAlarms.appendFiring(context, "${Store.stamp(System.currentTimeMillis())} 重排出错 ${e.message}")
    }
  }
}
