package com.timetable.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * 本机数据存储 —— 与 `server/store.js` **行为对齐**。
 *
 * 为什么要用 Kotlin 重写一遍（而不是复用 node）：
 *   安卓上没有 arm64 的 node 运行时，而且 Android 从 targetSdk 29 起禁止
 *   从应用数据目录 exec 可执行文件（W^X）。所以本地服务只能用原生实现。
 *   为了不让"重写"变成"两套行为"，这份实现刻意：
 *     · 不含任何 android.* 依赖（只收一个 File），因此**能在普通 JVM 上跑单测**
 *     · 有一组跨实现对照测试，用同样的输入分别喂它和 server/store.js，
 *       比对输出 —— 见 tools/android-store-parity.test.mjs 与 docs/ANDROID-BUILD.md
 *
 * 对齐范围（v1 必须一致，否则网页版与安卓版行为会分叉）：
 *   · 事件字段与默认值（id/title/type/deadline/level/parentId/reminders…）
 *   · 截止时刻优先级：显式 deadline > start > end
 *   · 颜色归一化与旧数据迁移（level > tier > magnitude/importance）
 *   · 套娃层级校验（子级必须严于父级：红 > 黄 > 绿 > 蓝）
 *   · 课程导入：一门课多次上课 → 多条事件；事件 id 含星期与节次
 *
 * 数据落在一个 JSON 文件里（安卓上是 `filesDir/db.json`），与桌面版的
 * `data/db.json` 同构，所以可以用同一份备份文件互相导入。
 *
 * 只依赖一个 `File`，不碰 Context —— 这样它就是一个能在 JVM 上直接测的纯类。
 */
class Store(dbFile: File) {

  companion object {
    /** 与 core/level.js 的 BAND_REMINDER_PLAN 一致（单位：分钟，负数 = 开始之后） */
    val BAND_REMINDER_PLAN = mapOf(
      "year" to listOf(10, 0),
      "month" to listOf(10, 0),
      "week" to listOf(30, 0),
      "day" to listOf(60, 30, 10, 0),
      "hour" to listOf(60, 30, 10, 0, -5),
      "minute" to listOf(30, 10, 0, -5, -15),
      "second" to listOf(30, 10, 0, -5, -15),
    )
    const val HORIZON_HOURS = 25
    const val TICK_MS = 20_000L
    const val LOOKBACK_MS = 60_000L

    /**
     * 课程摘要的"新鲜期"：`now` 超过槽位时间这么久就**跳过不发**。
     * 与 `core/course-digest.js` 的 `DIGEST_FRESH_MS` 一致。
     * 例：中午才打开应用，不该补发"今天早上"的提醒 —— 那已经没用了。
     */
    const val DIGEST_FRESH_MS = 90 * 60_000L

    /** 剩余毫秒 → 档位 key。与 core/countdown.js 的 TIME_BANDS 同构 */
    fun bandKeyFor(remainingMs: Long): String = when {
      remainingMs >= 365L * 24 * 3600_000 -> "year"
      remainingMs >= 30L * 24 * 3600_000 -> "month"
      remainingMs >= 7L * 24 * 3600_000 -> "week"
      remainingMs >= 24 * 3600_000 -> "day"
      remainingMs >= 3600_000 -> "hour"
      remainingMs >= 60_000 -> "minute"
      else -> "second"
    }

    /** 这个事件此刻该用哪几个提醒提前量。与 store.js 的 effectiveReminders 一致 */
    fun planFor(remainingMs: Long): List<Int> {
      val plan = BAND_REMINDER_PLAN[bandKeyFor(remainingMs)] ?: BAND_REMINDER_PLAN.getValue("year")
      return plan.distinct().sortedDescending()
    }

    private val ISO = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply {
      timeZone = TimeZone.getDefault()
    }

    /** 颜色档位：rank 越大越"大"。与 core/level.js 一致 */
    val LEVEL_RANK = mapOf("sky" to 0, "emerald" to 1, "amber" to 2, "red" to 3)
    val LEVEL_COLOR_NAME = mapOf("sky" to "天蓝", "emerald" to "翠绿", "amber" to "黄", "red" to "红")
    const val DEFAULT_LEVEL = "sky"

    // -----------------------------------------------------------------------
    // 闹钟（与 core/alarms.js **同语义**）
    //
    // 为什么这些常量要抄一份到 Kotlin：闹钟的"字段合法性"是**跨端契约**
    // （网页写进去、桌面服务端读、iOS/安卓壳排）。抄漏一个值，
    // 症状是"网页上能选、安卓上认不出来" —— 而这种不一致只在换端时才暴露。
    // 对照点写在每一项后面，改 core 时必须同步改这里。
    // -----------------------------------------------------------------------

    /** 与 core/alarms.js 的 `ALARM_KINDS` 同语义（clock=固定时刻，timer=倒计时） */
    val ALARM_KINDS = listOf("clock", "timer")

    /** 与 core/alarms.js 的 `ALARM_REPEATS` 同语义 */
    val ALARM_REPEATS = listOf("once", "daily", "weekdays", "custom")

    /** 与 core/alarms.js 的 `ALARM_LIMIT` 同语义（产品上限，不是系统限制） */
    const val ALARM_LIMIT = 50

    /** 与 core/alarms.js 的 `TIMER_MIN_MS` / `TIMER_MAX_MS` 同语义 */
    const val TIMER_MIN_MS = 1_000L
    const val TIMER_MAX_MS = 24L * 3600 * 1000

    /** 与 core/alarms.js 的 `DEFAULT_SOUND_ID` 同语义 */
    const val DEFAULT_SOUND_ID = "triple"

    /**
     * 认得出来的铃声 id —— 与 core/alarms.js 的 `ALARM_SOUNDS` **逐条对应**。
     *
     * ⚠️ 这里**故意只列 id**（不要 label/preview/文件）：安卓侧的铃声落地方式与 iOS
     *    完全不同（iOS 是打进包里的 .caf 文件名，安卓是系统铃声 URI 或通知渠道），
     *    把 iOS 的文件名抄过来只会误导下一个人。这里要的只有一件事：
     *    **"这个 id 认不认得出来"**（认不出来 → 回落默认音，与 core 的 `soundById` 一致）。
     * ⚠️ `custom:*` 也要认（core 用前缀判定），见 [isKnownAlarmSound]。
     */
    val ALARM_SOUND_IDS = listOf(
      "morning", "triple", "low", "drop", "beep",
      "heartbeat", "siren", "chime", "accelerate", "dawn", "custom",
    )

    /** 与 core/alarms.js 的 `CUSTOM_SOUND_PREFIX` 同语义 */
    const val CUSTOM_SOUND_PREFIX = "custom:"

    /** 认不认得这个铃声 id（与 core/alarms.js 的 `soundById(id) != null` 同语义） */
    fun isKnownAlarmSound(id: Any?): Boolean {
      val key = id?.toString() ?: ""
      if (key.startsWith(CUSTOM_SOUND_PREFIX)) return true
      return ALARM_SOUND_IDS.contains(key)
    }

    /** 与 core/state-ops.js 的 `intOf` 同语义：**只认整数值**，认不出来给 null。 */
    fun intOrNull(raw: Any?): Int? {
      if (raw == null || raw == JSONObject.NULL) return null
      val d = when (raw) {
        is Number -> raw.toDouble()
        is String -> raw.trim().toDoubleOrNull()
        else -> null
      } ?: return null
      if (!d.isFinite()) return null
      val t = Math.floor(d)
      if (t != d) return null
      return t.toInt()
    }

    /** 数字？与 core 的 `Number.isFinite(Number(x))` 同语义（`Number('') === 0` 这个怪癖也照抄） */
    fun numberOrNull(raw: Any?): Double? {
      if (raw == null || raw == JSONObject.NULL) return null
      val d = when (raw) {
        is Number -> raw.toDouble()
        is String -> if (raw.trim().isEmpty()) 0.0 else raw.trim().toDoubleOrNull()
        is Boolean -> if (raw) 1.0 else 0.0
        else -> null
      }
      return if (d != null && d.isFinite()) d else null
    }

    /** 与 core/alarms.js 的 `strOf(v, max)` 同语义：trim 后截断 */
    fun strCut(raw: Any?, max: Int): String =
      (raw?.toString() ?: "").trim().let { if (it.length > max) it.substring(0, max) else it }

    /**
     * 与 core/alarms.js 的 `alarmId()` 同语义：认不出种子就随机。
     * 前缀 `alarm_` 是跨端约定（网页/服务端都用它），别改。
     */
    fun newAlarmId(seed: Any? = null): String {
      val s = (seed?.toString() ?: "").replace(Regex("[^\\w-]"), "")
      if (s.isNotEmpty()) return "alarm_$s"
      return "alarm_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8)
    }

    /** 默认等级相关工具保持不变 */

    /** 旧 magnitude(1–100)/importance(1–5) → 四档。与 core/level.js 的区间一致 */
    fun levelFromLegacyMagnitude(value: Number?): String {
      val v = value?.toDouble() ?: return DEFAULT_LEVEL
      return when {
        v >= 80 -> "red"
        v >= 60 -> "amber"
        v >= 40 -> "emerald"
        else -> "sky"
      }
    }

    /** 子级能否放进父级：必须**严于**（rank 更小） */
    fun canNestInside(parentKey: String, childKey: String): Boolean {
      val p = LEVEL_RANK[parentKey] ?: 0
      val c = LEVEL_RANK[childKey] ?: 0
      return c < p
    }

    /** 与 main.wxml 无关；把毫秒格式化成 store.js 同款的本地时间串 */
    fun stamp(ms: Long): String = ISO.format(Date(ms))

    fun parseMs(any: Any?): Long? {
      if (any == null || any == JSONObject.NULL) return null
      if (any is Number) return any.toLong()
      val s = any.toString().trim()
      if (s.isEmpty()) return null
      // 先按 ISO 试；再退回 Date.parse（Android 的 SimpleDateFormat 更严）
      return try {
        ISO.parse(s)?.time
      } catch (_: Exception) {
        try {
          // "2026-09-19T18:16:00" 这类
          val cleaned = s.replace(" ", "T")
          ISO.parse(cleaned.substring(0, minOf(19, cleaned.length)))?.time
        } catch (_: Exception) {
          null
        }
      }
    }
  }

  private val file: File = dbFile

  /** 全量数据。结构：{rev, updatedAt, settings, events:[], courses:[]} */
  @Volatile
  private var data: JSONObject = JSONObject()

  init {
    load()
  }

  @Synchronized
  fun load() {
    data = if (file.exists()) {
      try {
        JSONObject(file.readText())
      } catch (_: Exception) {
        fresh()
      }
    } else {
      fresh()
    }
    // 补齐缺失的顶层字段（老备份可能没有 courses）
    if (!data.has("events")) data.put("events", JSONArray())
    if (!data.has("courses")) data.put("courses", JSONArray())
    if (!data.has("settings")) data.put("settings", defaultSettings())
    if (!data.has("rev")) data.put("rev", 1)
    // ⚠️ 闹钟（2026-10-xx 加的字段）：**必须在 load 里补**，不能只靠 fresh()。
    //    老库（升级上来的）没有这一格，`state()` 又是把 data 原样吐给网页的，
    //    缺了这一格网页上 `state.alarms` 就是 undefined ——
    //    而闹钟板块对 undefined 的处理是"当作 0 条"，于是**用户升级后原来设的闹钟
    //    全部消失且不报错**（数据其实还在磁盘上，只是没被读出来）。
    //    与 server/store.js 的顶层形状保持一致（那边是 `alarms: []`）。
    if (!data.has("alarms")) data.put("alarms", JSONArray())
    // ⚠️ settings **内部**也要补：新增的设置项（如 courseDigest）在老库里不存在，
    //    而 `/api/state` 直接返回 data、不经过 settings()，所以必须在这里补到位。
    backfillSettings(data.optJSONObject("settings") ?: JSONObject().also { data.put("settings", it) })
  }

  private fun fresh(): JSONObject = JSONObject().apply {
    put("rev", 1)
    put("updatedAt", stamp(System.currentTimeMillis()))
    put("settings", defaultSettings())
    put("events", JSONArray())
    put("courses", JSONArray())
    put("alarms", JSONArray())
  }

  private fun defaultSettings(): JSONObject = JSONObject().apply {
    put("termStart", "")
    put("termWeeks", 20)
    put("defaultReminders", JSONArray(listOf(10, 0)))
    put("notify", JSONObject().put("desktop", true).put("sound", true))
    put("autoLaunch", false)
    put("sectionTimes", JSONArray())
    put("importedSources", JSONArray())
    // 课程摘要提醒（用户要求"前一天晚上提醒明天 / 早上提醒上午 / 中午提醒下午 /
    // 傍晚提醒晚上"）。默认**关**，与桌面端一致 —— 不改变用户现有行为。
    // 槽位时间与 core/course-digest.js 的 DIGEST_SLOTS 保持一致。
    put("courseDigest", defaultDigestSettings())
    // AI 接口配置（OpenAI 兼容）。与 `core/defaults.js` 的 `ai: {baseUrl,apiKey,model}`
    // **同一个形状、同一组默认值** —— 缺了它，`/api/state` 在安卓上就没有 `settings.ai`
    // 这一格，网页设置页读出来是 undefined（courseDigest 曾经就这么炸过一次）。
    put("ai", JSONObject().put("baseUrl", "").put("apiKey", "").put("model", ""))
  }

  /** 与 core/course-digest.js 的 defaultDigestSettings() 一致 */
  private fun defaultDigestSettings(): JSONObject = JSONObject().apply {
    put("enabled", false)
    put("perCourseReminders", false)
    put("slots", JSONObject().apply {
      put("tonight", JSONObject().put("on", true).put("at", "21:00"))
      put("morning", JSONObject().put("on", true).put("at", "07:30"))
      put("noon", JSONObject().put("on", true).put("at", "12:30"))
      put("evening", JSONObject().put("on", true).put("at", "17:30"))
    })
  }

  @Synchronized
  private fun persist() {
    data.put("updatedAt", stamp(System.currentTimeMillis()))
    data.put("rev", data.optInt("rev", 1) + 1)    // 原子写：先写临时文件再改名。断电不会写坏（与桌面版同样的做法）
    val tmp = File(file.parentFile, "db.json.tmp")
    tmp.writeText(data.toString())
    if (file.exists()) file.delete()
    tmp.renameTo(file)
    // 数据变了 → 通知外部重排提醒闹钟。
    //
    // 挂在 persist() 上而不是逐个写在 API 里：persist() 是**所有改动的必经之路**
    // （新建/编辑/删除/戳破/导入课表/清空/恢复都走它），挂这里就不可能漏。
    // 逐个接口手动调用的话，将来加一个新写接口就会忘记 —— 而症状是
    // "改了日程但提醒还按旧时间响"，非常难查。
    onChanged?.invoke()
  }

  /**
   * 数据变更回调。安卓侧用它重排 AlarmManager 闹钟；
   * 测试侧用它断言"写操作确实触发了回调"。
   * 刻意不是构造参数 —— 那个类要能在 JVM 上裸跑（不依赖 android.*）。
   */
  var onChanged: (() -> Unit)? = null

  @Synchronized
  fun state(): JSONObject = JSONObject(data.toString())

  @Synchronized
  fun settings(): JSONObject {
    val s = data.optJSONObject("settings") ?: defaultSettings().also { data.put("settings", it) }
    backfillSettings(s)
    return s
  }


  /**
   * 给 settings 补上缺的键（**不改用户已有的值**）。
   *
   * ⚠️ 为什么必须在 `load()` 里也调一次、而不是只在 [settings] 里补：
   *    `/api/state` 走的是 `state()`，它直接返回 `data` 的拷贝 ——
   *    **不经过 [settings]**。设置页读的是 `/api/state` 里的原始值，
   *    所以只在 [settings] 里补等于白补（我真机测出来才发现）。
   *
   * ⚠️ 也不能只判断"键在不在"：库里可能存着一个**空的** `slots: {}`
   *    （设置页被点过一次就会这样），键存在但内容不全 → 要逐槽位补。
   *
   * 与 `core/defaults.js` 的 `mergeDefaults` 同一套语义：已有的值优先。
   */
  private fun backfillSettings(s: JSONObject) {
    val def = defaultSettings()
    for (k in def.keys()) {
      if (!s.has(k)) s.put(k, def.opt(k))
    }
    // courseDigest 是嵌套的，要逐字段/逐槽位补
    val defCd = def.optJSONObject("courseDigest")!!
    val cd = s.optJSONObject("courseDigest")
    if (cd == null) {
      s.put("courseDigest", defCd)
    } else {
      if (!cd.has("enabled")) cd.put("enabled", false)
      if (!cd.has("perCourseReminders")) cd.put("perCourseReminders", false)
      val slots = cd.optJSONObject("slots") ?: JSONObject().also { cd.put("slots", it) }
      val defSlots = defCd.optJSONObject("slots")!!
      for (k in defSlots.keys()) {
        if (!slots.has(k)) slots.put(k, defSlots.optJSONObject(k))
      }
    }
  }

  @Synchronized
  fun events(): List<JSONObject> {
    val arr = data.optJSONArray("events") ?: return emptyList()
    return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
  }

  @Synchronized
  fun courses(): List<JSONObject> {
    val arr = data.optJSONArray("courses") ?: return emptyList()
    return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
  }

  @Synchronized
  fun updateSettings(patch: JSONObject): JSONObject {
    val s = settings()
    for (k in patch.keys()) s.put(k, patch.get(k))
    data.put("settings", s)
    persist()
    return s
  }

  // -------------------------------------------------------------------------
  // 提醒
  //
  // 与 server/scheduler.js + server/api.js 的 /api/reminders/due 对齐。
  //
  // 为什么安卓端也要自己算：网页里有个"页内提醒"循环会每 20 秒轮询这个端点
  // （web/adapter/reminder.js 的 serverTick），拿到 items 就在页内弹提醒。
  // 如果安卓端只返回空数组，那个循环就永远不响 —— 而且**不报错**，最难发现。
  //
  // 语义（照抄桌面版）：
  //   · 提醒提前量按"当前剩余时间档位"实时算（core/level.js 的 BAND_REMINDER_PLAN）
  //     —— 这就是"越接近截止，提醒越密"的落点
  //   · 往前看 25 小时，往后回看 60 秒
  //   · fired=true 表示"到点了，该弹了"；弹过之后记账，不再重复
  // -------------------------------------------------------------------------

  // 提醒档位表。这些已经在 companion object 里定义了，这里只是文档性的引用，
  // 不要再写一份（写重了会报 "Only one companion object is allowed per class"，
  // 而且错误会以"unresolved reference HORIZON_HOURS"这种面目出现，很绕）。
  // 见文件开头的 companion object。

  // ---------------------------------------------------------------------------
  // 重复规则展开 —— 与 server/scheduler.js 的 occurrencesIn 对齐
  //
  // ⚠️ 这一块不能省。第一版 dueReminders 直接拿了 deadline 当"发生时刻"，
  //    于是**周重复的日程和课表（weeks）都只会响第一次** —— 而这两类恰恰是
  //    这个应用最主要的使用场景（每周的课、每周的活动）。不展开就等于没提醒。
  //
  // 三种情形（照抄桌面版）：
  //   ① weekly / biweekly：按 byDay 逐日扫，算周差、按 step 取整周
  //   ② 单次 + weeks + type=course：按学期第一周周一 + (周-1)*7 + 星期几 定位
  //   ③ 其余：就一个 start
  // ---------------------------------------------------------------------------

  /** 该时刻所在周的周一 00:00 —— 与 scheduler.js 的 mondayOf 一致（周日算上周） */
  private fun mondayOf(ms: Long): Long {
    val c = java.util.Calendar.getInstance()
    c.timeInMillis = ms
    c.set(java.util.Calendar.HOUR_OF_DAY, 0)
    c.set(java.util.Calendar.MINUTE, 0)
    c.set(java.util.Calendar.SECOND, 0)
    c.set(java.util.Calendar.MILLISECOND, 0)
    // Calendar: SUNDAY=1 … SATURDAY=7；JS 的 getDay(): 周日=0
    val dow = c.get(java.util.Calendar.DAY_OF_WEEK)
    val delta = if (dow == java.util.Calendar.SUNDAY) -6 else java.util.Calendar.MONDAY - dow
    c.add(java.util.Calendar.DAY_OF_MONTH, delta)
    return c.timeInMillis
  }

  /**
   * 事件在 [fromMs, toMs] 区间内的所有发生时刻。
   * 返回排好序的毫秒时间戳。
   */
  /** 重复级别归一化后的结果 */
  data class RecurLevel(val freq: String, val interval: Int)

  /**
   * 归一化重复规则的**级别**与间隔。
   *
   * ⚠️ 与 `core/recurrence.js` 的 `recurLevelOf` **必须逐字一致** ——
   *    两端对同一条规则的理解不同，展开出的日期就会不一样。
   *
   * 用户要求："重复参数可以为日级、周级、月级、年级（每 N 日 / 每 N 周 / 每 N 月 / 每 N 年
   * 新生一次）"，"新生机制当然要严格遵循级别单位"。
   *
   * 数据格式：`{freq:'daily'|'weekly'|'monthly'|'yearly', interval:N}`；
   * 旧写法 `{freq:'biweekly'}` 等价于 `weekly + interval:2`。返回 null = 不重复。
   */
  fun recurLevelOf(rec: JSONObject?): RecurLevel? {
    if (rec == null) return null
    var freq = rec.optString("freq", "none")
    if (freq.isBlank() || freq == "none") return null
    var legacy: Int? = null
    if (freq == "biweekly") { freq = "weekly"; legacy = 2 }
    if (freq !in LEVEL_FREQS) return null
    val cap = LEVEL_CAPS[freq] ?: 52
    // ⚠️ 顺序要对：先看 interval 有没有给一个**合法**的值；
    //    只有它不合法时才回落到旧写法的 2。
    //    我第一版写成 `numOrNull(...) ?: 1.0` 再判 legacy —— 那样 interval 缺失时
    //    已经变成 1.0、"不合法"的判断永远不成立，biweekly 被当成每周（跨端断言当场抓到）。
    val raw = numOrNull(rec.opt("interval"))
    val valid = raw != null && raw.isFinite() && raw >= 1
    var n = if (valid) raw!! else (legacy?.toDouble() ?: 1.0)
    if (!n.isFinite() || n < 1) n = 1.0
    return RecurLevel(freq, minOf(cap, n.toInt()))
  }

  /** 与 core 的 INTERVAL_CAP 一致 */
  private val LEVEL_FREQS = setOf("daily", "weekly", "monthly", "yearly")
  private val LEVEL_CAPS = mapOf("daily" to 365, "weekly" to 52, "monthly" to 60, "yearly" to 20)

  /** JSON 里的值 → Double；非数字给 null（避免 "x" 被当成 0） */
  private fun numOrNull(raw: Any?): Double? = when (raw) {
    null, org.json.JSONObject.NULL -> null
    is Number -> raw.toDouble()
    is String -> raw.toDoubleOrNull()
    else -> null
  }

  /**
   * 这条重复规则"每几周"一次。
   *
   * ⚠️ 只有**周级**才有意义。其他级别请用 [recurLevelOf]。
   */
  fun intervalWeeksOf(rec: JSONObject?): Int {
    val lv = recurLevelOf(rec) ?: return 1
    return if (lv.freq == "weekly") lv.interval else 1
  }

  /**
   * 重复规则的可读文字（"每天"/"每周"/"每两周"/"每 3 月"）。
   * 与 core/recurrence.js 的 freqLabelOf 一致。
   */
  fun freqLabelOf(rec: JSONObject?): String {
    val lv = recurLevelOf(rec) ?: return "不重复"
    val n = lv.interval
    if (lv.freq == "weekly") {
      return when (n) {
        1 -> "每周"
        2 -> "每两周"
        else -> "每 $n 周"
      }
    }
    val unit = when (lv.freq) { "daily" -> "天"; "monthly" -> "月"; "yearly" -> "年"; else -> "" }
    if (n == 1) return "每$unit"
    return "每 $n $unit"
  }

  fun occurrencesIn(ev: JSONObject, fromMs: Long, toMs: Long): List<Long> {
    val startMs = parseMs(ev.opt("start")) ?: return emptyList()
    val rec = ev.optJSONObject("recurrence")
    val level = recurLevelOf(rec)
    val out = mutableListOf<Long>()

    // ---- 日级 / 月级 / 年级：严格按级别单位步进 ----
    //
    // 用户原话："你那个月级和年级你每个月天数一样的一起写，每年天数一样一起写，
    //           新生机制当然要严格遵循级别单位啊，不要用 31 号死规矩做判定，
    //           每个月特殊的灵活来，特殊的分开判断就ok"
    // 所以：月级以"月"步进、年级以"年"步进，落到同一天；
    //      该月/该年**没有这一天**（1/31 遇 2 月、2/29 遇平年）→ 那次不新生。
    // 判据是 Calendar 构造后 month/day 是否仍等于锚点（溢出会被识别出来）。
    if (level != null && level.freq != "weekly") {
      val untilMs = rec.optString("until", "").takeIf { it.isNotBlank() }?.let { parseMs("${it}T23:59:59") }
      val anchor = java.util.Calendar.getInstance().apply { timeInMillis = startMs }
      val aY = anchor.get(java.util.Calendar.YEAR)
      val aM = anchor.get(java.util.Calendar.MONTH)
      val aD = anchor.get(java.util.Calendar.DAY_OF_MONTH)
      val aH = anchor.get(java.util.Calendar.HOUR_OF_DAY)
      val aMin = anchor.get(java.util.Calendar.MINUTE)
      val step = level.interval
      val hit = sortedSetOf<Long>()
      // 从区间起点往前多跑一个步长，保证不漏掉区间左边界附近的发生
      var i = when (level.freq) {
        "daily" -> {
          val fromCal = java.util.Calendar.getInstance().apply { timeInMillis = fromMs }
          val startCal = java.util.Calendar.getInstance().apply { timeInMillis = startMs }
          val days = Math.floor(
            (fromCal.timeInMillis - startCal.timeInMillis).toDouble() / 86_400_000.0,
          ).toInt() / step * step - step
          maxOf(0, days)
        }
        "monthly" -> {
          val fromCal = java.util.Calendar.getInstance().apply { timeInMillis = fromMs }
          val k = (fromCal.get(java.util.Calendar.YEAR) - aY) * 12 + (fromCal.get(java.util.Calendar.MONTH) - aM) - step
          maxOf(0, k)
        }
        else -> maxOf(0, java.util.Calendar.getInstance().apply { timeInMillis = fromMs }
          .get(java.util.Calendar.YEAR) - aY - step)
      }
      while (true) {
        val occ = java.util.Calendar.getInstance().apply {
          timeInMillis = startMs
          set(java.util.Calendar.YEAR, aY)
          set(java.util.Calendar.MONTH, aM)
          set(java.util.Calendar.DAY_OF_MONTH, aD)
          set(java.util.Calendar.HOUR_OF_DAY, aH)
          set(java.util.Calendar.MINUTE, aMin)
          set(java.util.Calendar.SECOND, 0)
          set(java.util.Calendar.MILLISECOND, 0)
        }
        when (level.freq) {
          "daily" -> occ.add(java.util.Calendar.DAY_OF_MONTH, i)
          "monthly" -> occ.add(java.util.Calendar.MONTH, i)
          else -> occ.add(java.util.Calendar.YEAR, i)
        }
        val occMs = occ.timeInMillis
        // 溢出检查：1/31 + 1 月 → 3/3（月份对不上）；2/29 + 1 年 → 3/1（月/日对不上）
        val sameDay = occ.get(java.util.Calendar.DAY_OF_MONTH) == aD
        val sameMonth = if (level.freq == "monthly") {
          // 月级只看"日"是否还是锚点日；月份溢出时 day 也会变，所以两者一起判
          sameDay
        } else {
          sameDay && occ.get(java.util.Calendar.MONTH) == aM
        }
        if (level.freq == "daily") {
          if (occMs > toMs) break
          if (untilMs != null && occMs > untilMs) break
          if (occMs in fromMs..toMs && occMs >= startMs) hit.add(occMs)
        } else if (!sameMonth) {
          if (occMs > toMs) break
        } else {
          if (occMs > toMs) break
          if (untilMs != null && occMs > untilMs) break
          if (occMs in fromMs..toMs && occMs >= startMs) hit.add(occMs)
        }
        i += step
      }
      return hit.toList()
    }

    if (level != null && level.freq == "weekly") {
      val stepWeeks = level.interval
      val stepDays = stepWeeks * 7
      // byDay 用的是 JS 的 getDay() 语义（周日=0）；没给就用开始那天
      val byDay = (rec.optJSONArray("byDay")?.let { a -> (0 until a.length()).map { a.optInt(it) } }
        ?: emptyList())
        .ifEmpty { listOf(jsDayOfWeek(startMs)) }
      val untilMs = rec.optString("until", "").takeIf { it.isNotBlank() }?.let { parseMs("${it}T23:59:59") }

      val startCal = java.util.Calendar.getInstance().apply { timeInMillis = startMs }
      val timeH = startCal.get(java.util.Calendar.HOUR_OF_DAY)
      val timeM = startCal.get(java.util.Calendar.MINUTE)

      val cursor = java.util.Calendar.getInstance()
      cursor.timeInMillis = maxOf(fromMs, startMs)
      cursor.set(java.util.Calendar.HOUR_OF_DAY, 0)
      cursor.set(java.util.Calendar.MINUTE, 0)
      cursor.set(java.util.Calendar.SECOND, 0)
      cursor.set(java.util.Calendar.MILLISECOND, 0)

      val guard = toMs + stepDays * 86_400_000L
      val startMonday = mondayOf(startMs)
      var dayMs = cursor.timeInMillis
      // ⚠️ 必须去重：循环是**逐日**推进的，而对每个命中的日子都算同一个 `occ`
      //    （时分只来自 start）。所以"一周勾满 7 天"时，那一周里 7 天都命中、
      //    weekDiff 都等于本周 —— 同一个发生时刻被加 7 次。
      //    实测后果：气泡数从应有的 7 个涨到 45 个。
      //    `core/recurrence.js` 已同步修（两端必须一致）。
      val hit = sortedSetOf<Long>()
      while (dayMs <= guard) {
        if (untilMs != null && dayMs > untilMs) break
        val dow = jsDayOfWeek(dayMs)
        if (byDay.contains(dow)) {
          val occCal = java.util.Calendar.getInstance().apply { timeInMillis = dayMs }
          occCal.set(java.util.Calendar.HOUR_OF_DAY, timeH)
          occCal.set(java.util.Calendar.MINUTE, timeM)
          occCal.set(java.util.Calendar.SECOND, 0)
          occCal.set(java.util.Calendar.MILLISECOND, 0)
          val occ = occCal.timeInMillis
          val weekDiff = Math.round((mondayOf(occ) - startMonday).toDouble() / (7 * 86_400_000.0)).toInt()
          if (weekDiff >= 0 && weekDiff % stepWeeks == 0 && occ in fromMs..toMs) hit.add(occ)
        }
        // 逐日推进（用 Calendar 加一天，避开夏令时把 24h 当固定值算错）
        val c = java.util.Calendar.getInstance().apply { timeInMillis = dayMs }
        c.add(java.util.Calendar.DAY_OF_MONTH, 1)
        dayMs = c.timeInMillis
      }
      return hit.toList()
    }

    // 单次，但带课表的 weeks：按学期周次定位（这是课表能响提醒的关键）
    val weeks = ev.optJSONArray("weeks")?.let { a -> (0 until a.length()).map { a.optInt(it) } } ?: emptyList()
    if (weeks.isNotEmpty() && ev.optString("type") == "course") {
      val termStart = settings().optString("termStart", "")
      if (termStart.isNotBlank()) {
        val monday = parseMs("${termStart}T00:00:00")?.let { mondayOf(it) }
        if (monday != null) {
          val startCal = java.util.Calendar.getInstance().apply { timeInMillis = startMs }
          val timeH = startCal.get(java.util.Calendar.HOUR_OF_DAY)
          val timeM = startCal.get(java.util.Calendar.MINUTE)
          val dayIdx = jsDayOfWeek(startMs).let { if (it == 0) 6 else it - 1 } // 周一=0
          for (w in weeks) {
            val c = java.util.Calendar.getInstance()
            c.timeInMillis = monday
            c.add(java.util.Calendar.DAY_OF_MONTH, (w - 1) * 7 + dayIdx)
            c.set(java.util.Calendar.HOUR_OF_DAY, timeH)
            c.set(java.util.Calendar.MINUTE, timeM)
            c.set(java.util.Calendar.SECOND, 0)
            c.set(java.util.Calendar.MILLISECOND, 0)
            val occ = c.timeInMillis
            if (occ in fromMs..toMs) out.add(occ)
          }
          return out.sorted()
        }
      }
    }

    if (startMs in fromMs..toMs) out.add(startMs)
    return out
  }

  private fun jsDayOfWeek(ms: Long): Int {
    // Calendar 的 SUNDAY=1 … SATURDAY=7 → JS 的 0..6
    val c = java.util.Calendar.getInstance().apply { timeInMillis = ms }
    return c.get(java.util.Calendar.DAY_OF_WEEK) - 1
  }

  /**
   * 已响过的提醒 key。
   *
   * ⚠️ **必须落盘**（对应桌面版的 `data/fired.json`）。原来只存在进程内存里，
   *    而安卓端有**多个 Store 实例**：`LocalServer` 一个、`ReminderReceiver`
   *    每次醒来又 new 一个、`reschedule()` 里还有一个。各实例的账本互不可见，
   *    于是同一条提醒会被"网页轮询"和"系统闹钟"各弹一次 —— **重复通知**。
   *
   *    落盘之后：多实例共享、进程被杀也不丢、重启也不会重弹旧提醒。
   */
  private val firedFile = File(file.parentFile, "fired.json")
  private var firedKeys = linkedSetOf<String>()
  private var firedDay: String = ""

  private fun todayKey(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

  /** 跨天就清空；否则从盘上装载（首次装载时读文件） */
  private fun rollLedgerIfNeeded() {
    val d = todayKey()
    if (d == firedDay) return
    firedDay = d
    firedKeys = linkedSetOf()
    try {
      if (firedFile.exists()) {
        val o = JSONObject(firedFile.readText())
        if (o.optString("day", "") == d) {
          val arr = o.optJSONArray("keys") ?: JSONArray()
          for (i in 0 until arr.length()) firedKeys.add(arr.optString(i))
        }
      }
    } catch (_: Exception) {
      // 账本坏了就当空的（最多多弹一次，不影响正确性）
    }
  }

  private fun persistLedger() {
    try {
      val o = JSONObject().apply {
        put("day", firedDay)
        put("keys", JSONArray(firedKeys.toList()))
      }
      val tmp = File(file.parentFile, "fired.json.tmp")
      tmp.writeText(o.toString())
      // ⚠️ File.renameTo 是 java.io.File 的成员，Kotlin 里能直接调（返回 Boolean）。
      //    之前在合并出来的单文件里报 unresolved，是因为属性名写成了构造参数名 dbFile。
      if (firedFile.exists()) firedFile.delete()
      tmp.renameTo(firedFile)
    } catch (_: Exception) {
      // 写不进去也不能影响提醒本身
    }
  }

  /**
   * 记一笔"已响"。
   *
   * ⚠️ 写之前**必须先合并盘上的内容**：安卓端有多个 Store 实例
   * （LocalServer 一个、ReminderReceiver 每次醒来 new 一个），
   * 如果各自拿自己内存里的账本往盘上覆盖，后写的会把先写的抹掉 →
   * 那条提醒会被再弹一次。合并是"以盘上为准做并集"，谁都不会丢。
   */
  private fun markFired(key: String) {
    firedKeys.add(key)
    try {
      if (firedFile.exists()) {
        val o = JSONObject(firedFile.readText())
        // 只合并同一天的（跨天就该重来）
        if (o.optString("day", "") == firedDay) {
          val arr = o.optJSONArray("keys") ?: JSONArray()
          for (i in 0 until arr.length()) firedKeys.add(arr.optString(i))
        }
      }
    } catch (_: Exception) {
      // 盘上的读不出来就用内存里的
    }
    persistLedger()
  }

  @Synchronized
  fun firedLedger(): List<String> {
    rollLedgerIfNeeded()
    return firedKeys.toList()
  }

  /** 一条提醒（内部形态，JSON 由它派生） */
  data class Due(
    val key: String,
    val eventId: String,
    val title: String,
    val location: String,
    val minutes: Int,
    val fireAt: Long,
    val occurrence: Long,
    val fired: Boolean,
  )

  /**
   * 一条课程摘要（"明天 3 门课"）。
   *
   * 与逐条提醒的区别：摘要的标题/正文是**整段汇总**，不是某个 event 的提醒，
   * 所以不复用 [Due] 的形状。
   */
  data class Digest(
    val key: String,
    val slot: String,
    val title: String,
    val body: String,
    val count: Int,
    val fireAt: Long,
    val fired: Boolean,
  )

  /** 摘要槽位的定义（与 core/course-digest.js 的 DIGEST_SLOTS 逐字一致） */
  private data class DigestSlot(
    val key: String,
    val targetTomorrow: Boolean,
    val windowStart: Int,   // 当天分钟数，含
    val windowEnd: Int,     // 不含
    val defaultAt: String,
    val dayLabel: String,
  )

  private val DIGEST_SLOTS = listOf(
    DigestSlot("tonight", true, 0, 24 * 60, "21:00", "明天 "),
    DigestSlot("morning", false, 5 * 60, 12 * 60, "07:30", "今天上午 "),
    DigestSlot("noon", false, 12 * 60, 17 * 60, "12:30", "今天下午 "),
    DigestSlot("evening", false, 17 * 60, 24 * 60, "17:30", "今天晚上 "),
  )

  /** 'HH:MM' → 当天分钟数；非法给 null */
  private fun parseHHMM(s: String?): Int? {
    val m = Regex("^(\\d{1,2}):(\\d{2})$").find(s?.trim() ?: "") ?: return null
    val h = m.groupValues[1].toIntOrNull() ?: return null
    val mi = m.groupValues[2].toIntOrNull() ?: return null
    if (h !in 0..23 || mi !in 0..59) return null
    return h * 60 + mi
  }

  /** 与 core/course-digest.js 的 normalizeDigest 一致：缺什么补什么 */
  private fun normalizeDigest(raw: JSONObject?): JSONObject {
    val out = JSONObject().apply {
      put("enabled", raw?.optBoolean("enabled", false) == true)
      put("perCourseReminders", raw?.optBoolean("perCourseReminders", false) == true)
    }
    val slots = JSONObject()
    val given = raw?.optJSONObject("slots")
    for (s in DIGEST_SLOTS) {
      val g = given?.optJSONObject(s.key)
      // 必须用 parseHHMM 校验：`25:99` 格式合法但语义非法
      val at = g?.optString("at")?.takeIf { parseHHMM(it) != null } ?: s.defaultAt
      slots.put(s.key, JSONObject().put("on", g?.optBoolean("on", true) ?: true).put("at", at))
    }
    out.put("slots", slots)
    return out
  }

  /**
   * 算出"现在该响的课程摘要"。
   *
   * ⚠️ 与 `core/course-digest.js` 的 `dueDigests` **必须逐字一致** ——
   *    两端提醒时机不同会让用户觉得"手机上怎么这时候弹"。
   *
   * 判定（三个条件同时满足）：
   *   ① 槽位开着，且 now >= 槽位时间
   *   ② now 没比槽位时间晚太多（[DIGEST_FRESH_MS]）—— 否则中午才打开应用，
   *      不该补发"今天早上"的提醒，那已经没用了
   *   ③ 目标窗口里还有**没开始的课**
   * 只汇总 `type == "course"` 的事件（用户要求"摘要只管课程"）。
   */
  fun dueDigests(nowMs: Long = System.currentTimeMillis(), shouldMark: Boolean = true): List<Digest> {
    rollLedgerIfNeeded()
    val cfg = normalizeDigest(settings().optJSONObject("courseDigest"))
    if (!cfg.optBoolean("enabled", false)) return emptyList()
    val termStart = settings().optString("termStart", "")
    if (termStart.isBlank()) return emptyList()

    val cal = java.util.Calendar.getInstance().apply { timeInMillis = nowMs }
    val dayStart = java.util.Calendar.getInstance().apply {
      timeInMillis = nowMs
      set(java.util.Calendar.HOUR_OF_DAY, 0)
      set(java.util.Calendar.MINUTE, 0)
      set(java.util.Calendar.SECOND, 0)
      set(java.util.Calendar.MILLISECOND, 0)
    }.timeInMillis
    val nowMin = cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 + cal.get(java.util.Calendar.MINUTE)

    val out = mutableListOf<Digest>()
    for (slot in DIGEST_SLOTS) {
      val sc = cfg.optJSONObject("slots")?.optJSONObject(slot.key) ?: continue
      if (!sc.optBoolean("on", true)) continue
      val atMin = parseHHMM(sc.optString("at")) ?: continue
      if (nowMin < atMin) continue                                   // ① 还没到点
      if ((nowMin - atMin) * 60_000L > DIGEST_FRESH_MS) continue      // ② 太晚了，别补发

      val targetDay = if (slot.targetTomorrow) dayStart + 86_400_000L else dayStart
      // 目标窗口内的课，按时间排序。
      // ⚠️ 不要往事件 JSON 里塞临时字段（`__digestOcc` 那种）—— 那会被 persist()
      //    写进 db.json，污染数据。发生时刻直接放在 Pair 里带走。
      val upcoming = mutableListOf<Pair<Long, JSONObject>>()
      for (ev in events()) {
        if (ev.optString("type") != "course") continue
        val occ = courseStartOnDay(ev, targetDay, termStart) ?: continue
        val occMin = ((occ - targetDay) / 60_000L).toInt()
        if (occMin < slot.windowStart || occMin >= slot.windowEnd) continue
        if (occ <= nowMs) continue                                   // ③ 只留还没开始的
        upcoming.add(occ to ev)
      }
      if (upcoming.isEmpty()) continue

      val dayKey = dayKeyOf(targetDay)
      val key = "digest:${slot.key}:$dayKey"
      val already = firedKeys.contains(key)
      val due = !already
      if (due && shouldMark) markFired(key)

      val lines = upcoming.sortedBy { it.first }.map { (occ, ev) ->
        val c = java.util.Calendar.getInstance().apply { timeInMillis = occ }
        val hm = String.format("%02d:%02d", c.get(java.util.Calendar.HOUR_OF_DAY), c.get(java.util.Calendar.MINUTE))
        val where = ev.optString("location", "").takeIf { it.isNotBlank() }?.let { " @$it" } ?: ""
        "$hm ${ev.optString("title")}$where"
      }
      out.add(Digest(
        key = key,
        slot = slot.key,
        title = "${slot.dayLabel}${upcoming.size} 门课",
        body = lines.joinToString("\n"),
        count = upcoming.size,
        fireAt = nowMs,
        fired = due,
      ))
    }
    return out
  }

  /** 'YYYY-MM-DD'（本地日期）*/
  private fun dayKeyOf(ms: Long): String {
    val c = java.util.Calendar.getInstance().apply { timeInMillis = ms }
    return String.format(
      "%04d-%02d-%02d",
      c.get(java.util.Calendar.YEAR), c.get(java.util.Calendar.MONTH) + 1, c.get(java.util.Calendar.DAY_OF_MONTH),
    )
  }

  /**
   * 一门课在某一天有没有课；有就返回**那天的开始时刻**，否则 null。
   * 与 `core/course-digest.js` 的 `courseStartOn` 一致。
   */
  private fun courseStartOnDay(ev: JSONObject, dayStartMs: Long, termStart: String): Long? {
    val weeksArr = ev.optJSONArray("weeks") ?: return null
    if (weeksArr.length() == 0) return null
    val baseMs = parseMs(ev.opt("start")) ?: return null
    val termMon = mondayOf(parseMs("${termStart}T00:00:00") ?: return null)

    val dayMon = mondayOf(dayStartMs)
    val week = Math.round((dayMon - termMon).toDouble() / (7 * 86_400_000.0)).toInt() + 1
    val weeks = (0 until weeksArr.length()).map { weeksArr.optInt(it) }
    if (week !in weeks) return null

    // 星期也要对得上
    val dayCal = java.util.Calendar.getInstance().apply { timeInMillis = dayStartMs }
    val baseCal = java.util.Calendar.getInstance().apply { timeInMillis = baseMs }
    if (dayCal.get(java.util.Calendar.DAY_OF_WEEK) != baseCal.get(java.util.Calendar.DAY_OF_WEEK)) return null

    return dayStartMs +
      baseCal.get(java.util.Calendar.HOUR_OF_DAY) * 3600_000L +
      baseCal.get(java.util.Calendar.MINUTE) * 60_000L
  }

  /**
   * **提醒计算的唯一出处。**
   *
   * `dueReminders()`（给网页轮询）和 `AlarmManager` 排程都从这里取数 ——
   * 两边各算一套的话，页内提醒和系统通知迟早会对不上（一个响了另一个不响，
   * 或者时间不一样），而且这种不一致极难查。
   *
   * [withinMs] 决定往前看多远。轮询用 25 小时（HORIZON_HOURS）；
   * 排程只关心"下一个"和很近的几个，可以传小一点。
   *
   * [shouldMark] 为 true 时把"已到点"的项记进账本（轮询路径需要；
   * 排程路径不该记账 —— 它只是规划未来，还没真的弹）。
   */
  @Synchronized
  fun dueItems(
    nowMs: Long = System.currentTimeMillis(),
    withinMs: Long = HORIZON_HOURS * 3600_000L,
    shouldMark: Boolean = true,
  ): List<Due> {
    rollLedgerIfNeeded()
    val horizon = nowMs + withinMs
    val from = nowMs - LOOKBACK_MS
    val out = mutableListOf<Due>()

    for (ev in events()) {
      if (ev.optBoolean("done", false)) continue
      if (ev.optBoolean("autoReminders", true) == false) continue

      // ⚠️ 提醒密度必须**按每一次发生分别算**，不能按事件算一次。
      //    桌面版是 effectiveReminders(ev, now) —— 用的是"现在离本次还有多久"。
      //    如果只算一次（比如用第一个 deadline），那么"明天的周会"会一直用
      //    日档的稀疏提醒（提前 60/30/10 分钟），等它真的变成"一小时后"时
      //    也不会加密 —— 而"越接近越密"正是这套提醒设计的核心。
      //    实测：这一条写错会让"还没到点就提前触发"。
      for (occ in occurrencesIn(ev, from, horizon)) {
        val plan = planFor(occ - nowMs)
        for (minutes in plan) {
          // minutes 是提前量：10 = 提前 10 分钟；负值 = 开始之后多久
          val fireAt = occ - minutes * 60_000L
          if (fireAt < from || fireAt > horizon) continue
          val key = "${ev.optString("id")}@${stamp(occ)}@$minutes"
          val alreadyFired = firedKeys.contains(key)
          val due = fireAt <= nowMs
          // 注意：参数叫 shouldMark，别叫 markFired —— 那会和下面的 markFired() 方法重名
          if (due && !alreadyFired && shouldMark) markFired(key)
          out.add(
            Due(
              key = key,
              eventId = ev.optString("id"),
              title = ev.optString("title"),
              location = ev.optString("location", ""),
              minutes = minutes,
              fireAt = fireAt,
              occurrence = occ,
              fired = due && !alreadyFired,
            ),
          )
        }
      }
    }
    return out.sortedBy { it.fireAt }
  }

  /**
   * 当前"该响"的提醒列表。字段形状必须和桌面版一致：
   * key / eventId / title / location / minutes / fireAt / occurrence / fired
   *
   * fired 的语义：到点（fireAt <= now）且**还没弹过**。弹过就记账，下次返回 false，
   * 这样网页端的循环不会每 20 秒重复弹同一条。
   */
  fun dueReminders(nowMs: Long = System.currentTimeMillis()): List<JSONObject> =
    dueItems(nowMs, HORIZON_HOURS * 3600_000L, shouldMark = true).map { d ->
      JSONObject().apply {
        put("key", d.key)
        put("eventId", d.eventId)
        put("title", d.title)
        put("location", d.location)
        put("minutes", d.minutes)
        put("fireAt", stamp(d.fireAt))
        put("occurrence", stamp(d.occurrence))
        // 网页端只会对 fired=true 的项弹提醒（见 reminder.js 的 serverTick）
        put("fired", d.fired)
      }
    }

  /**
   * 下一个**尚未响过**的提醒时刻（毫秒）。没有就返回 null。
   *
   * 这是给 AlarmManager 用的：排程只关心"下一次该在什么时候醒"。
   * 过去的时刻一律跳过 —— 否则会拿一个早就过期的点去注册闹钟，
   * 系统会立刻触发（等于装完就弹一堆旧提醒）。
   */
  /**
   * 下一次闹钟该在什么时候醒（逐条提醒 + 课程摘要取**较早**的那个）。
   *
   * ⚠️ 加了摘要之后这里必须一起算 —— 否则摘要要等到下一个普通提醒才顺带发出，
   *    时间就不准了（`takeDueDigests` 只在闹钟醒来时才被调用）。
   *
   * ⚠️ 还要排除**已经记过账的**（`firedKeys`）。不然会出现死循环：
   *    闹钟在 21:00 醒来、发出 tonight 摘要并记账，然后排下一条时
   *    又选中同一个槽位（它还在 90 分钟新鲜期内）→ 反复醒。
   */
  fun nextAlarmAt(nowMs: Long = System.currentTimeMillis(), withinMs: Long = 7L * 24 * 3600_000L): Long? {
    val fromReminders = dueItems(nowMs, withinMs, shouldMark = false)
      .firstOrNull { it.fireAt > nowMs && !firedKeys.contains(it.key) }
      ?.fireAt
    val fromDigests = nextDigestAlarmAt(nowMs, withinMs)
    // ⚠️ 闹钟（2026-10-xx 加）。**必须一起取最小值** —— 这是"安卓上闹钟会响"
    //    的全部机制：整个壳只有**一个** PendingIntent（ReminderAlarms.REQ_CODE=8801），
    //    它醒来的时刻就是这里算出来的最小值。漏掉 alarms 的症状很隐蔽：
    //    闹钟在库里好好的、网页上显示得好好的、但**系统永远不知道它**
    //    （下一个唤醒只由提醒/摘要决定）→ 到点什么都不响。
    val fromAlarms = nextClockAlarmAt(nowMs, withinMs)
    return listOfNotNull(fromReminders, fromDigests, fromAlarms).minOrNull()
  }

  /**
   * 下一条"固定时刻的闹钟"该响的时刻（毫秒）。
   *
   * ⚠️ 三点与 core/alarms.js 的 `planAlarmSchedule` 对齐（**别自己发明规则**）：
   *   ① 只看 `enabled === true`：`nextFireAt` 本身**不看 enabled**，
   *      过滤是调用方的事（core 那边也是这么分工的）
   *   ② 只算 `kind === 'clock'`：计时器（timer）**不走系统闹钟** ——
   *      它要的是"现在 + 时长"，由网页直发一条消息给壳；
   *      混进来的话，每次数据变动都会把正在跑的倒计时重置一遍
   *   ③ 超过 `withinMs` 的**干脆不排**：宁可不排（到点后再排），
   *      也别为了一个 8 天后的闹钟把系统唤醒时刻占掉
   */
  fun nextClockAlarmAt(nowMs: Long, withinMs: Long = 7L * 24 * 3600_000L): Long? {
    val limit = nowMs + withinMs
    var best: Long? = null
    for (a in alarms()) {
      if (a.optString("kind", "clock") != "clock") continue
      if (!a.optBoolean("enabled", true)) continue
      val next = nextFireAt(a, nowMs) ?: continue
      if (next > limit) continue
      // 只保留"还没到"的：已过的那一刻不排（排了会立刻醒一次，白发一条通知）
      if (next <= nowMs) continue
      if (best == null || next < best!!) best = next
    }
    return best
  }

  /**
   * 下一条 [alarm] 的触发时刻（毫秒），已经错过的那次**向后顺延**。
   * 与 `core/alarms.js` 的 `nextFireAt(alarm, now)` **同语义**。
   *
   * ⚠️ 为什么必须是"顺延"而不是"算就完了"：`ReminderReceiver` 醒来时拿这个
   *    和 `now` 比对来判断"到点的是不是这条闹钟"（窗口见 [alarmFireWindowMs]）。
   *    如果这里返回的是"上一个已经过去的时刻"，那么用户改一次标签就会
   *    立刻误报一次"到点了"（实测会这样：改完参数 → 数据变动 → 重排 →
   *    结算时算出一个过去的时刻 → 落在容差窗口里 → 白响一声）。
   *    JS 侧不需要这个顺延，因为那边每次都是拿"当前真实时间"重算然后取最小；
   *    这里要的是"某一条的下次时刻"，语义不同。
   *
   * ⚠️ 与 core/alarms.js 的 `nextFireAt` 逐条对应：
   *    · `once` 时钟闹钟 = 最近那个时刻点：今天没到就今天，过了顺延到明天
   *      （"响完不删、由 markFired 置 enabled:false" 这个设计也照抄，见 [markAlarmFired]）
   *    · 秒与毫秒一律抹 0（JS 的 `cand.setHours(h, m, 0, 0)`）
   *    · 计时器 = `startedAt + durationMs`（`startedAt` 为空 → null；
   *      已过完给**过去那一刻**，与 JS 一致 —— 那是"已结束"，不是"没这条"）
   *    · 时钟那支：`maxAhead = (repeat==='once'||'daily') ? 1 : 7`，
   *      i 从 0 起、命中即返回；`custom` **一天都没勾** → return null
   *      （这就是"这条不排"，不许随便挑一天替用户决定）
   *    · `weekdays` 用 **JS 的 getDay 编号**（0=周日 … 6=周六）
   */
  fun nextFireAt(alarm: JSONObject, nowMs: Long): Long? {
    val a = normalizeAlarm(alarm, nowMs)
    val kind = a.optString("kind", "clock")
    if (kind == "timer") {
      val started = parseAlarmMs(a.opt("startedAt")) ?: return null
      return started + a.optLong("durationMs", 25 * 60_000L)
    }
    val repeat = a.optString("repeat", "once")
    val hour = a.optInt("atHour", 7)
    val minute = a.optInt("atMinute", 0)
    val days = if (repeat == "custom") weekdaysOf(a) else emptyList()
    val maxAhead = if (repeat == "once" || repeat == "daily") 1 else 7
    for (i in 0..maxAhead) {
      val ms = dayStartOf(nowMs, i) + (hour * 60L + minute) * 60_000L
      if (ms <= nowMs) continue
      if (repeat == "daily" || repeat == "once") return ms
      if (days.contains(jsDayOfWeek(ms))) return ms
    }
    return null
  }

  /**
   * 闹钟响过之后要改的字段。与 `core/alarms.js` 的 `markFired(alarm, now)` 同语义。
   *
   * ⚠️ 为什么**不删**这条：
   *   · `once`（单次）→ 只把 `enabled` 置 false，**留在列表里**。
   *     删掉的话用户会发现"我设的闹钟自己不见了"，而且他没法确认"到底响过没有"。
   *   · `timer`（计时器）→ 除了关掉，还要把 `startedAt` 清空 ——
   *     不清的话它算出来还是"已结束"，下次开关一动就会立刻再响一次。
   *   · 其它重复方式（daily/weekdays/custom）→ **原样不动**，它本来就该继续响。
   */
  fun markAlarmFired(id: String, nowMs: Long = System.currentTimeMillis()): JSONObject? {
    val arr = data.optJSONArray("alarms") ?: return null
    for (i in 0 until arr.length()) {
      val a = arr.optJSONObject(i) ?: continue
      if (a.optString("id") != id) continue
      val isTimer = a.optString("kind") == "timer"
      // ⚠️ 只有"单次"和"计时器"才关掉。**重复闹钟必须原样返回** ——
      //    第一版这里无条件 `put("enabled", false)`，症状是用户设的"每天 7:00"
      //    响一次之后自己就关了，第二天不响，而界面上还显示"每天"。
      //    这种错只有在真机上隔一天才看得出来，所以 parity 测试专门钉了这条。
      if (!isTimer && a.optString("repeat") != "once") return JSONObject(a.toString())
      val next = JSONObject(a.toString())
      next.put("enabled", false)
      if (isTimer) next.put("startedAt", JSONObject.NULL)
      next.put("updatedAt", stamp(nowMs))
      arr.put(i, next)
      persist()
      return next
    }
    return null
  }

  /**
   * 判定"刚才这一响，算不算这条闹钟到点了"的容差窗口（毫秒）。
   *
   * ⚠️ 为什么需要它、为什么是 90 秒：
   *   · 系统唤醒时刻（[nextAlarmAt] 算出来的）和接收器真正跑起来的时刻**不相等** ——
   *     `AlarmManager` 在精确模式被允许时会漂几秒；退化成
   *     `setAndAllowWhileIdle`（用户在系统设置里撤了"闹钟和提醒"的精确授权，
   *     见 [ReminderAlarms.canScheduleExact]）时系统**可能推迟几分钟**才叫醒我们。
   *   · 所以这个窗口要**足够宽**，宽到能接住被推迟的那次唤醒；但又不能太宽，
   *     否则"相邻的另一天"会串进来（窗口一旦 ≥ 12 小时，昨天和今天两条候选就重叠了）。
   *   · 90 秒 = 正常使用时足够（`_diag` 里那三次实测漂移都在秒级），
   *     同时比"最短的重复周期"（每天）小三个数量级，不会跨条误判。
   *
   * ⚠️ 判断用的是 [dueAlarms] 里那套"拿昨天/今天/明天三条候选分别夹窗口"，
   *    不是"拿 [nextFireAt] 比一次" —— 后者在系统推迟唤醒时会整整差一天。
   */
  fun alarmFireWindowMs(): Long = 90_000L

  /** 取这次"到点"的闹钟（可能多条同时到点，比如两条都设在 7:00） */
  fun dueAlarms(nowMs: Long = System.currentTimeMillis()): List<JSONObject> {
    val win = alarmFireWindowMs()
    return alarms().filter { a ->
      if (a.optString("kind", "clock") != "clock") return@filter false
      if (!a.optBoolean("enabled", true)) return@filter false
      // ⚠️ 不能只拿 [nextFireAt] 比：它是**顺延过的**下一次时刻。
      //    系统退化成 `setAndAllowWhileIdle` 时可能晚几分钟才叫醒我们，
      //    那一刻 9:00 的每天闹钟算出来已经是"明天 9:00"，diff 差了整整一天，
      //    于是"被推迟的那次"永远判不出到点 —— 用户看到的就是"闹钟偶尔不响"。
      //    所以改成拿**附近的每一个时刻候选**（今天、昨天、明天）去夹窗口：
      //      · 昨天/今天那两条接住"被系统推迟"的唤醒
      //      · 今天/明天那两条接住"唤醒早了几十秒"的情况
      //    跨零点也自动成立（23:59 的闹钟在 00:00:30 被叫醒时，候选里就有昨天 23:59）。
      val repeat = a.optString("repeat", "once")
      val days = if (repeat == "custom") weekdaysOf(a) else emptyList()
      for (i in -1..1) {
        val ms = dayStartOf(nowMs, i) +
          (a.optInt("atHour", 7) * 60L + a.optInt("atMinute", 0)) * 60_000L
        // 与 [nextFireAt] 同一套"这一天到底响不响"的规则
        if (repeat != "daily" && repeat != "once" && !days.contains(jsDayOfWeek(ms))) continue
        val diff = ms - nowMs
        if (diff <= win && diff >= -win) return@filter true
      }
      false
    }
  }

  /** 直接落库（**不走过一遍** fire 判定），给"重排之后核对"用；主要用于自检/诊断 */
  fun nextAlarmDebug(nowMs: Long = System.currentTimeMillis()): JSONObject = JSONObject().apply {
    put("next", nextAlarmAt(nowMs) ?: JSONObject.NULL)
    put("now", nowMs)
    put("count", alarms().size)
  }

  /**
   * "今天 + days 天"那一天的 00:00:00.000（毫秒，**本机时区**）。
   *
   * ⚠️ 为什么用 `Calendar` 逐字段加天、而不是 `now + days*86_400_000`：
   *    夏令时那天**不是** 24 小时（有 23 小时或 25 小时的日子），
   *    按固定毫秒加会让"明天 7:00"变成"明天 6:00"或"8:00"。
   *    JS 侧 `cand.setDate(getDate()+i)` 是**按日历字段加**的，同语义。
   */
  private fun dayStartOf(nowMs: Long, days: Int): Long {
    val c = java.util.Calendar.getInstance()
    c.timeInMillis = nowMs
    c.add(java.util.Calendar.DAY_OF_MONTH, days)
    c.set(java.util.Calendar.HOUR_OF_DAY, 0)
    c.set(java.util.Calendar.MINUTE, 0)
    c.set(java.util.Calendar.SECOND, 0)
    c.set(java.util.Calendar.MILLISECOND, 0)
    return c.timeInMillis
  }

  /**
   * 这条闹钟**实际上会在哪几天响**。与 `core/alarms.js` 的 `weekdaysOf(alarm)` 同语义。
   *   daily → 每天；weekdays → 周一到周五；custom → 用户勾的那几天；其它 → 空（= 不循环）
   * ⚠️ custom 时**只认 0..6 的整数**、去重、排序 —— 与 JS 的
   *    `[...new Set(arr.map(intOf).filter(...))].sort()` 一致（顺序会影响 parity 断言）。
   */
  fun weekdaysOf(alarm: JSONObject): List<Int> {
    val repeat = alarm.optString("repeat", "once")
    if (repeat == "daily") return (0..6).toList()
    if (repeat == "weekdays") return (1..5).toList()
    if (repeat != "custom") return emptyList()
    val arr = alarm.optJSONArray("weekdays") ?: return emptyList()
    val out = sortedSetOf<Int>()
    for (i in 0 until arr.length()) {
      val n = intOrNull(arr.opt(i)) ?: continue
      if (n in 0..6) out.add(n)
    }
    return out.toList()
  }

  /**
   * 把 `startedAt`/`updatedAt` 这类时间字段解析成毫秒。
   * 认得两种形状：ISO 串（`2026-10-01T07:30:00`，可能带时区后缀）与纯数字毫秒。
   */
  private fun parseAlarmMs(raw: Any?): Long? {
    if (raw == null || raw == JSONObject.NULL) return null
    if (raw is Number) return raw.toLong()
    val s = raw.toString().trim()
    if (s.isEmpty()) return null
    // 纯数字：直接当毫秒（JS 的 `Number(x)` 就是这个语义）
    s.toDoubleOrNull()?.let { if (it.isFinite()) return it.toLong() }
    if (!s.contains('T') && !s.contains('-')) return null
    return try { parseMs(s) } catch (_: Exception) { null }
  }

  /**
   * 下一个"真的有课可报"的摘要时刻。
   *
   * 只把槽位时间加进去是不够的：那个时段**本来没课**时，
   * 闹钟会白醒一次（醒来发现没内容，再排下一条）。所以这里实际展开一遍
   * 目标窗口里的课，**有课才排**。
   */
  private fun nextDigestAlarmAt(nowMs: Long, withinMs: Long): Long? {
    val cfg = normalizeDigest(settings().optJSONObject("courseDigest"))
    if (!cfg.optBoolean("enabled", false)) return null
    val termStart = settings().optString("termStart", "")
    if (termStart.isBlank()) return null

    val dayStart = java.util.Calendar.getInstance().apply {
      timeInMillis = nowMs
      set(java.util.Calendar.HOUR_OF_DAY, 0)
      set(java.util.Calendar.MINUTE, 0)
      set(java.util.Calendar.SECOND, 0)
      set(java.util.Calendar.MILLISECOND, 0)
    }.timeInMillis

    var best: Long? = null
    for (dayOffset in 0..7) {
      val day = dayStart + dayOffset * 86_400_000L
      for (slot in DIGEST_SLOTS) {
        val sc = cfg.optJSONObject("slots")?.optJSONObject(slot.key) ?: continue
        if (!sc.optBoolean("on", true)) continue
        val atMin = parseHHMM(sc.optString("at")) ?: continue
        val slotMs = day + atMin * 60_000L
        // 已经过去的、或超过窗口的，都不排
        if (slotMs <= nowMs || slotMs > nowMs + withinMs) continue
        // 已经发过的（同一个目标日）不再排 —— 防死循环
        val targetDay = if (slot.targetTomorrow) day + 86_400_000L else day
        if (firedKeys.contains("digest:${slot.key}:${dayKeyOf(targetDay)}")) continue
        // 目标窗口里必须有课，否则这一觉白醒
        val targetEnd = targetDay + 86_400_000L
        val hasCourse = events().any { ev ->
          if (ev.optString("type") != "course") return@any false
          val occ = courseStartOnDay(ev, targetDay, termStart) ?: return@any false
          val min = ((occ - targetDay) / 60_000L).toInt()
          min >= slot.windowStart && min < slot.windowEnd && occ > slotMs
        }
        if (!hasCourse) continue
        if (best == null || slotMs < best!!) best = slotMs
      }
    }
    return best
  }

  /**
   * **醒来时该弹的提醒** —— 排程闹钟触发后调这个。
   *
   * 和 [dueReminders] 的区别：这里只取"到点且还没弹过"的项（也就是网页端
   * `fired=true` 的那批），因为系统通知不该把"未来还没到点"的也弹出来。
   * 返回的同时**记账**，所以同一个闹钟重复触发也不会重复弹。
   *
   * ⚠️ 窗口只回看 [LOOKBACK_MS]（60 秒）而不是往前看 25 小时：
   *    闹钟是"掐点醒来"的，不是轮询。窗口开太大，一次醒来会把一堆
   *    很久以后才该响的提醒一起弹出去。
   */
  @Synchronized
  fun takeDueNotifications(nowMs: Long = System.currentTimeMillis()): List<Due> =
    dueItems(nowMs, withinMs = LOOKBACK_MS, shouldMark = true).filter { it.fired }

  /**
   * 取"该响的课程摘要"并**记账**（闹钟/通知用）。
   * 与 [takeDueNotifications] 同样：记账在 Store 里做，所以闹钟重复触发也不会重复弹。
   */
  fun takeDueDigests(nowMs: Long = System.currentTimeMillis()): List<Digest> =
    dueDigests(nowMs, shouldMark = true).filter { it.fired }

  /** 只读排演：不记账地问"此刻有哪些摘要该弹"（诊断用）*/
  fun peekDueDigests(nowMs: Long = System.currentTimeMillis()): List<Digest> =
    dueDigests(nowMs, shouldMark = false).filter { it.fired }

  /**
   * 只读排演：**不记账**地问"此刻有哪些提醒该弹"。用于诊断。
   *
   * 为什么需要：真机上出现过"闹钟注册了但通知没出来"，需要区分到底是
   * ① 闹钟没触发，还是 ② 触发了但算出来没东西可发。
   * 不能直接用 [takeDueNotifications] 来查 —— 它会记账，查一次就把要验的
   * 提醒消耗掉了（我第一次诊断就踩了这个坑）。
   */
  @Synchronized
  fun peekDueNotifications(nowMs: Long = System.currentTimeMillis()): List<Due> =
    dueItems(nowMs, withinMs = LOOKBACK_MS, shouldMark = false).filter { it.fired }

  /**
   * 关掉自动提醒的事件（用户可能手动改过提醒时间）。
   * 排程时用它决定要不要为某个事件设闹钟。
   */
  fun autoRemindersOn(ev: JSONObject): Boolean = ev.optBoolean("autoReminders", true)

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  /** 截止时刻（毫秒）：显式 deadline > start > end —— 与 store.js 的 deadlineOf 一致 */
  fun deadlineMs(ev: JSONObject): Long? =
    parseMs(ev.opt("deadline")) ?: parseMs(ev.opt("start")) ?: parseMs(ev.opt("end"))

  /**
   * 这个事件是不是"过期"（紫色）。
   *
   * 与网页端 `core/urgency.js` 的 `isOverdueEvent` 同义：剩余时间到 0 就算过期；
   * **父级过期时子级也算过期**（紫会往下传）。
   *
   * 用途：过期容器**只读** —— 能进去看，但不能往里加子泡泡。
   */
  fun isOverdue(ev: JSONObject, nowMs: Long = System.currentTimeMillis()): Boolean {
    val d = deadlineMs(ev) ?: return false
    if (d - nowMs <= 0) return true
    // 母气泡过期时，子气泡一起变紫 —— 判定也要一致
    val all = events().associateBy { it.optString("id") }
    var cur = all[ev.optString("parentId", "")]
    var guard = 0
    while (cur != null && guard < 32) {
      val cd = deadlineMs(cur)
      if (cd != null && cd - nowMs <= 0) return true
      cur = all[cur.optString("parentId", "")]
      guard++
    }
    return false
  }

  /** 等级归一化：level > tier > magnitude/importance > 默认 */
  fun levelOf(ev: JSONObject): String {
    val lv = ev.optString("level", "")
    if (LEVEL_RANK.containsKey(lv)) return lv
    val tier = ev.optString("tier", "")
    if (LEVEL_RANK.containsKey(tier)) return tier
    if (ev.has("magnitude") && !ev.isNull("magnitude")) return levelFromLegacyMagnitude(ev.optDouble("magnitude"))
    if (ev.has("importance") && !ev.isNull("importance")) return levelFromLegacyMagnitude(ev.optDouble("importance"))
    return DEFAULT_LEVEL
  }

  private fun normalizeLevel(input: JSONObject): String {
    val lv = input.optString("level", "")
    if (LEVEL_RANK.containsKey(lv)) return lv
    val tier = input.optString("tier", "")
    if (LEVEL_RANK.containsKey(tier)) return tier
    if (input.has("magnitude") && !input.isNull("magnitude")) return levelFromLegacyMagnitude(input.optDouble("magnitude"))
    if (input.has("importance") && !input.isNull("importance")) return levelFromLegacyMagnitude(input.optDouble("importance"))
    return DEFAULT_LEVEL
  }

  /**
   * 能被路由层翻译成 HTTP 状态/错误码的业务异常。
   *
   * ⚠️ `code` 与 `errorsJson` 是给**网页**看的（2026-10-xx 加，为闹钟补）：
   *    网页 `showAlarmError()` 是按**错误码**翻译人话的，靠中文匹配的话
   *    改一个字文案就会静默退化成"未知错误"。所以码必须原样传到 JSON 里。
   */
  class ApiError(
    message: String,
    val status: Int = 400,
    val code: String? = null,
    var errorsJson: JSONArray? = null,
  ) : Exception(message)

  @Synchronized
  fun upsertEvent(input: JSONObject): JSONObject {
    val title = input.optString("title", "").trim()
    if (title.isEmpty()) throw ApiError("title 不能为空")
    val start = input.opt("start")
    if (start == null || start == JSONObject.NULL || start.toString().isBlank()) throw ApiError("start 不能为空")

    val level = normalizeLevel(input)
    var parentId = input.optString("parentId", "").ifBlank { null }

    // 套娃层级校验：子元素的等级必须严于父容器
    if (parentId != null) {
      val p = parentId
      val parent = events().find { it.optString("id") == p }
      if (parent == null) {
        // ⚠️ 父容器不存在时**不报错**，降级为"最外层新建"。
        //
        // 为什么改：原来这里抛 400「父气泡不存在」，而用户遇到的是
        //   "只要创建就失败" —— 客户端（旧缓存 / 套娃路径残留）会把一个已经
        //   删掉的容器 id 一直发上来，一条 400 就把**创建这件事整个**堵死了，
        //   用户没有任何自救手段。
        //
        // 用户的意图是"新建一条日程"，父容器没了不该阻止这件事。
        // 真正要拒绝的是**层级不符**（那是用户能懂的约束），
        // 而"父不存在"属于状态过期 —— 能自愈就自愈。
        System.err.println("[TimetableStore] 丢弃失效的 parentId=$p（容器已不存在），按最外层新建")
        parentId = null
      } else if (isOverdue(parent)) {
        // 紫色（过期）容器**只读**：能进去看，但不能往里加子泡泡（用户要求）。
        // 客户端已经守了一道，这里必须**再守一道** —— 否则绕过界面直接调 API
        // 还是能塞进去，两边就不一致了（这个项目的原则是"判定和显示用同一套依据"）。
        throw ApiError("紫泡泡过期了，不能再往里加泡泡")
      } else {
        val parentLevel = levelOf(parent)
        if (!canNestInside(parentLevel, level)) {
          throw ApiError("${LEVEL_COLOR_NAME[parentLevel]}气泡里只能放更小的东西（不能放${LEVEL_COLOR_NAME[level]}）")
        }
      }
    }

    val now = stamp(System.currentTimeMillis())
    val deadline = resolveDeadlineMs(input)
    val base = JSONObject().apply {
      put("id", input.optString("id", "").ifBlank { "evt_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12) })
      put("title", title)
      put("type", input.optString("type", "personal"))
      put("location", input.optString("location", ""))
      put("teacher", input.optString("teacher", ""))
      put("notes", input.optString("notes", ""))
      put("start", start.toString())
      put("end", input.optString("end", start.toString()))
      put("deadline", stamp(deadline))
      put(
        "deadlineSource",
        when {
          input.has("deadline") && !input.isNull("deadline") -> "explicit"
          input.has("countdownParts") && !input.isNull("countdownParts") -> "distance"
          else -> "start"
        },
      )
      put("countdownParts", input.opt("countdownParts") ?: JSONObject.NULL)
      put("countdownAt", if (input.has("countdownParts") && !input.isNull("countdownParts")) System.currentTimeMillis() else JSONObject.NULL)
      put("fuzzy", input.optBoolean("fuzzy", false))
      put("level", level)
      put("parentId", parentId ?: JSONObject.NULL)
      put("allDay", input.optBoolean("allDay", false))
      put("recurrence", input.optJSONObject("recurrence") ?: JSONObject().put("freq", "none"))
      put("weeks", input.optJSONArray("weeks") ?: JSONArray())
      put("autoReminders", input.optBoolean("autoReminders", true))
      // 自动模式下提醒由"当时的剩余时间档位"在调度时算，这里先写一份默认值。
      // （与桌面版 store.js 的语义一致；真正的分档计划在网页端与调度器里算）
      put("reminders", input.optJSONArray("reminders") ?: (settings().optJSONArray("defaultReminders") ?: JSONArray(listOf(10, 0))))
      put("tags", input.optJSONArray("tags") ?: JSONArray())
      put("done", input.optBoolean("done", false))
      put("createdAt", now)
      put("updatedAt", now)
    }

    val arr = data.optJSONArray("events") ?: JSONArray().also { data.put("events", it) }
    var idx = -1
    for (i in 0 until arr.length()) {
      if (arr.optJSONObject(i)?.optString("id") == base.optString("id")) { idx = i; break }
    }

    if (idx >= 0) {
      val prev = arr.getJSONObject(idx)
      // 改完之后可能违反层级（把自己颜色调大超过父容器）→ 再校验一遍
      val pid = base.optString("parentId", "")
      if (pid.isNotBlank()) {
        val parent = events().find { it.optString("id") == pid }
        if (parent != null && !canNestInside(levelOf(parent), base.optString("level"))) {
          throw ApiError("改完之后颜色比父气泡还大了，父气泡里放不下")
        }
      }
      base.put("createdAt", prev.optString("createdAt", now))
      arr.put(idx, base)
    } else {
      arr.put(base)
    }
    persist()
    return base
  }

  /** deadline = 显式 deadline；否则 start（开完就算结束）。距离填法由客户端算好 deadline 传来 */
  private fun resolveDeadlineMs(input: JSONObject): Long {
    parseMs(input.opt("deadline"))?.let { return it }
    parseMs(input.opt("start"))?.let { return it }
    return System.currentTimeMillis()
  }

  @Synchronized
  fun patchEvent(id: String, patch: JSONObject): JSONObject {
    val arr = data.optJSONArray("events") ?: throw ApiError("事件不存在", 404)
    var idx = -1
    for (i in 0 until arr.length()) {
      if (arr.optJSONObject(i)?.optString("id") == id) { idx = i; break }
    }
    if (idx < 0) throw ApiError("事件不存在", 404)
    val ev = arr.getJSONObject(idx)

    val nextParent = if (patch.has("parentId")) {
      patch.optString("parentId", "").ifBlank { null }
    } else {
      ev.optString("parentId", "").ifBlank { null }
    }
    if (nextParent != null && nextParent == id) throw ApiError("不能把自己放进自己里")

    // 合并字段
    for (k in patch.keys()) {
      if (k == "id" || k == "createdAt") continue
      ev.put(k, patch.get(k))
    }
    // 归一化 + 层级再校验
    ev.put("level", normalizeLevel(ev))
    if (nextParent != null) {
      val parent = events().find { it.optString("id") == nextParent }
        ?: throw ApiError("父气泡不存在（patch 时收到 parentId=$nextParent）")
      // 过期容器只读 —— 拖拽改归属（拖到别的气泡上）也走这条 PATCH，同样要守
      if (isOverdue(parent)) throw ApiError("紫泡泡过期了，不能再往里放泡泡")
      if (!canNestInside(levelOf(parent), ev.optString("level"))) {
        throw ApiError("${LEVEL_COLOR_NAME[levelOf(parent)]}气泡里只能放更小的东西")
      }
      // 防套环
      if (isDescendant(nextParent, id)) throw ApiError("不能把气泡放进它自己的子气泡里")
      ev.put("parentId", nextParent)
    } else {
      ev.put("parentId", JSONObject.NULL)
    }
    ev.put("updatedAt", stamp(System.currentTimeMillis()))
    arr.put(idx, ev)
    persist()
    return ev
  }

  private fun isDescendant(candidateId: String, ancestorId: String): Boolean {
    val all = events().associateBy { it.optString("id") }
    var cur = all[candidateId]
    var guard = 0
    while (cur != null && guard < 256) {
      val pid = cur.optString("parentId", "")
      if (pid == ancestorId) return true
      cur = all[pid]
      guard++
    }
    return false
  }

  /**
   * 戳破：标记完成，并把**直接子级**释放到上一层。
   * 孙辈不跟着动（用户明确要求：只释放子一级）。
   */
  @Synchronized
  /**
   * 这个事件会不会展开出**多个实例**（需要"按实例记账"）。
   * 与 `core`/`server` 的 `isRecurring` 一致：有 freq 的重复日程、有 weeks 的课表课程。
   */
  fun isRecurring(ev: JSONObject): Boolean {
    val rec = ev.optJSONObject("recurrence")
    val freq = rec?.optString("freq", "none") ?: "none"
    if (freq.isNotBlank() && freq != "none") return true
    val weeks = ev.optJSONArray("weeks")
    return weeks != null && weeks.length() > 0
  }

  /** 实例账本的键（'YYYY-MM-DD'，**本地**日期 —— 用 UTC 在东八区会算成前一天）*/
  fun occurrenceKeyOf(date: java.util.Date): String {
    val c = java.util.Calendar.getInstance().apply { timeInMillis = date.time }
    return String.format(
      "%04d-%02d-%02d",
      c.get(java.util.Calendar.YEAR),
      c.get(java.util.Calendar.MONTH) + 1,
      c.get(java.util.Calendar.DAY_OF_MONTH),
    )
  }

  /**
   * 戳破一颗泡泡。
   *
   * ⚠️ **按实例记账**（与 `server/store.js` 的 popEvent 一致）。
   *
   * 原来无条件写 `done = true` —— 作用于**整个事件**，戳破"这周的跑步"
   * 整条重复就结束了，下周不再新生。改成：
   *   · 重复事件 → `popped['YYYY-MM-DD'] = { at, remainingMs }`，只结束这一颗
   *   · 非重复事件 → 仍然 `done = true`（语义清楚，兼容老数据）
   *
   * `remainingMs` 由**调用方**传（WebView 里的气泡算的，带上了"这次发生"的截止时刻）。
   */
  @Synchronized
  fun popEvent(id: String, occurrenceIso: String? = null, remainingMs: Long? = null): Pair<JSONObject, List<String>> {
    val arr = data.optJSONArray("events") ?: throw ApiError("事件不存在", 404)
    var target: JSONObject? = null
    for (i in 0 until arr.length()) {
      val e = arr.optJSONObject(i) ?: continue
      if (e.optString("id") == id) { target = e; break }
    }
    val ev = target ?: throw ApiError("事件不存在", 404)
    val grand = ev.optString("parentId", "").ifBlank { null }
    val released = mutableListOf<String>()
    for (i in 0 until arr.length()) {
      val c = arr.optJSONObject(i) ?: continue
      if (c.optString("parentId", "") == id) {
        c.put("parentId", grand ?: JSONObject.NULL)
        c.put("updatedAt", stamp(System.currentTimeMillis()))
        released.add(c.optString("id"))
      }
    }

    val now = stamp(System.currentTimeMillis())
    val occ = occurrenceIso?.let { parseMs(it) }
    if (occ != null && isRecurring(ev)) {
      // 重复事件：只记这一颗
      val popped = ev.optJSONObject("popped") ?: JSONObject().also { ev.put("popped", it) }
      popped.put(occurrenceKeyOf(java.util.Date(occ)), JSONObject().apply {
        put("at", now)
        put("remainingMs", remainingMs ?: JSONObject.NULL)
      })
      ev.put("updatedAt", now)
      persist()
      return ev to released
    }

    ev.put("done", true)
    ev.put("poppedAt", now)
    ev.put("updatedAt", now)
    persist()
    return ev to released
  }

  /**
   * 还原被戳破的泡泡（回收气泡站用）。
   * 传 `occurrenceIso` 只还原那一颗；不传则清掉这条事件的**全部**破裂记录。
   */
  @Synchronized
  fun restorePopped(id: String, occurrenceIso: String? = null): JSONObject {
    val arr = data.optJSONArray("events") ?: throw ApiError("事件不存在", 404)
    var target: JSONObject? = null
    for (i in 0 until arr.length()) {
      val e = arr.optJSONObject(i) ?: continue
      if (e.optString("id") == id) { target = e; break }
    }
    val ev = target ?: throw ApiError("事件不存在", 404)
    val now = stamp(System.currentTimeMillis())
    val popped = ev.optJSONObject("popped")
    if (occurrenceIso != null && popped != null) {
      parseMs(occurrenceIso)?.let { popped.remove(occurrenceKeyOf(java.util.Date(it))) }
    } else {
      ev.put("popped", JSONObject())
      ev.put("done", false)
      ev.remove("poppedAt")
    }
    ev.put("updatedAt", now)
    persist()
    return ev
  }

  /**
   * 回收气泡站的数据：**每个事件一条**（用户要求"合并"）。
   * 与 `server/store.js` 的 `poppedRecords()` 同构。
   */
  @Synchronized
  fun poppedRecords(): JSONArray {
    val out = JSONArray()
    for (e in events()) {
      val entries = mutableListOf<JSONObject>()
      e.optJSONObject("popped")?.let { pm ->
        for (k in pm.keys()) {
          val info = pm.optJSONObject(k)
          entries.add(JSONObject().apply {
            put("occurrence", k)
            put("at", info?.optString("at", "") ?: "")
            put("remainingMs", info?.opt("remainingMs") ?: JSONObject.NULL)
          })
        }
      }
      if (e.optBoolean("done", false) && e.optString("poppedAt", "").isNotBlank()) {
        parseMs(e.optString("poppedAt"))?.let { at ->
          entries.add(JSONObject().apply {
            put("occurrence", occurrenceKeyOf(java.util.Date(at)))
            put("at", e.optString("poppedAt", ""))
            put("remainingMs", JSONObject.NULL)
          })
        }
      }
      if (entries.isEmpty()) continue
      entries.sortBy { it.optString("occurrence") }
      val last = entries.last()
      out.put(JSONObject().apply {
        put("eventId", e.optString("id"))
        put("title", e.optString("title"))
        put("type", e.optString("type", "personal"))
        put("level", levelOf(e))
        put("location", e.optString("location", ""))
        put("teacher", e.optString("teacher", ""))
        put("count", entries.size)
        put("lastAt", last.optString("at", ""))
        put("entries", JSONArray(entries))
        put("done", e.optBoolean("done", false))
      })
    }
    // 最近破裂的排前面
    val sorted = (0 until out.length()).map { out.optJSONObject(it) }
      .sortedByDescending { it.optString("lastAt", "") }
    return JSONArray(sorted)
  }

  /** 删除：同样把直接子级释放到上一层（不连带删除） */
  @Synchronized
  fun deleteEvent(id: String): List<String> {
    val arr = data.optJSONArray("events") ?: return emptyList()
    var target: JSONObject? = null
    for (i in 0 until arr.length()) {
      val e = arr.optJSONObject(i) ?: continue
      if (e.optString("id") == id) { target = e; break }
    }
    target ?: throw ApiError("事件不存在", 404)
    val grand = target.optString("parentId", "").ifBlank { null }
    val released = mutableListOf<String>()
    val kept = JSONArray()
    for (i in 0 until arr.length()) {
      val e = arr.optJSONObject(i) ?: continue
      if (e.optString("id") == id) continue
      if (e.optString("parentId", "") == id) {
        e.put("parentId", grand ?: JSONObject.NULL)
        released.add(e.optString("id"))
      }
      kept.put(e)
    }
    data.put("events", kept)
    persist()
    return released
  }

  fun childrenOf(id: String): List<JSONObject> = events().filter { it.optString("parentId", "") == id }

  @Synchronized
  fun clearEvents(keepCourses: Boolean) {
    val arr = data.optJSONArray("events") ?: JSONArray()
    if (keepCourses) {
      val kept = JSONArray()
      for (i in 0 until arr.length()) {
        val e = arr.optJSONObject(i) ?: continue
        if (e.optString("type") == "course") kept.put(e)
      }
      data.put("events", kept)
    } else {
      data.put("events", JSONArray())
      data.put("courses", JSONArray())
    }
    persist()
  }

  @Synchronized
  fun replaceAll(payload: JSONObject) {
    data = JSONObject(payload.toString())
    if (!data.has("events")) data.put("events", JSONArray())
    if (!data.has("courses")) data.put("courses", JSONArray())
    if (!data.has("settings")) data.put("settings", defaultSettings())
    // ⚠️ 恢复备份时也要补这一格：老备份里没有 alarms，
    //    不补的话恢复到一半的库会让闹钟板块读到 undefined（症状见 load() 里那段注释）。
    if (!data.has("alarms")) data.put("alarms", JSONArray())
    persist()
  }

  // -------------------------------------------------------------------------
  // 闹钟（与 core/state-ops.js 的 upsertAlarm / removeAlarm / toggleAlarm 对齐，
  //       也就是 server/store.js 的 saveAlarm / deleteAlarm / toggleAlarm）
  //
  // ⚠️ 三条**设计决定**，从桌面端原样继承、别自己改：
  //   ① 闹钟**不进回收站、不记墓碑、不进同步** —— 它不是"事件"，没有历史价值，
  //      而且"删了还响"是这条链路上最糟的失败，所以宁可删干净
  //   ② **没有离线队列**：写失败就抛错（网页侧 store.js 也刻意不做队列），
  //      因为"看起来存上了、系统却排不进去"会让用户错过真正要响的闹钟
  //   ③ id 由**调用方**给（不是服务端生成）—— 网页新建时就得知道 id，
  //      否则"落库 → 排程"这两步没法对上号
  // -------------------------------------------------------------------------

  @Synchronized
  fun alarms(): List<JSONObject> {
    val arr = data.optJSONArray("alarms") ?: return emptyList()
    return (0 until arr.length()).mapNotNull { arr.optJSONObject(it) }
  }

  /**
   * 新增或更新一条闹钟。与 `core/state-ops.js` 的 `upsertAlarm(db, input, now)` 同语义。
   *
   * ⚠️ 返回**那一条**（不是整个数组）—— 网页的 `saveAlarm` 就是按这个形状解包的
   *    （`saved && saved.id ? saved : {...input}`）。返回数组的话，网页会静默把
   *    "刚存的那条"当成 `{0:…,1:…}`，症状是"加完闹钟列表里多出一条空的"。
   */
  @Synchronized
  fun upsertAlarm(input: JSONObject, nowMs: Long = System.currentTimeMillis()): JSONObject {
    // ① 先按"严格模式"归一 + 校验：越界的值**不许悄悄夹回去**，要报错。
    //    这条是刻意的：用户填 25 点，如果夹成 1 点存下去，
    //    他会在第二天凌晨 1 点被吵醒，而界面上显示的是 25:00（他没填错）。
    //    ⚠️ 校验走的是**原始 input**（不是 strict 归一后的值），理由同上。
    val errs = validateAlarm(input)
    if (errs.isNotEmpty()) {
      // 与 core 一致：抛第一条错误的 message，并把 code/errors 原样带给路由层
      throw ApiError(
        errs[0].message,
        400,
        errs[0].code,
        JSONArray(errs.map { JSONObject().put("code", it.code).put("message", it.message) }),
      )
    }

    val now = stamp(nowMs)
    val list = alarms()
    val rawId = input.optString("id", "")
    val idx = if (rawId.isEmpty()) -1 else list.indexOfFirst { it.optString("id") == rawId }

    if (idx >= 0) {
      val prev = list[idx]
      val next = normalizeAlarm(input, nowMs)
      // ⚠️ `createdAt` 保留旧值（与 core 的 `isoNow(prev.createdAt)` 一致）：
      //    编辑一次就重置创建时间的话，"这条是什么时候建的"就再也答不出来了
      next.put("createdAt", isoOr(prev.optString("createdAt"), now))
      next.put("updatedAt", now)
      next.put("id", prev.optString("id"))
      val out = JSONArray()
      // ⚠️ 逐条 put：**没有改的那些必须保持原对象**（引用不变）。
      //    这里虽然序列化成 JSON 后看不出区别，但 parity 测试会逐条比对形状 ——
      //    "只替换目标那一条"是 core 里写明的语义，别在这里顺手重建整个数组。
      for (i in list.indices) out.put(if (i == idx) next else list[i])
      data.put("alarms", out)
      persist()
      return next
    }

    if (list.size >= ALARM_LIMIT) {
      throw ApiError("最多只能有 50 条闹钟，先删掉几条再加", 400, "ALARM_LIMIT")
    }
    val created = normalizeAlarm(input, nowMs)
    created.put("id", if (rawId.isEmpty()) newAlarmId() else rawId)
    created.put("createdAt", now)
    created.put("updatedAt", now)
    val out = JSONArray()
    for (a in list) out.put(a)
    out.put(created)
    data.put("alarms", out)
    persist()
    return created
  }

  /**
   * 删掉一条。与 `core/state-ops.js` 的 `removeAlarm(db, id)` 同语义。
   *
   * ⚠️ 返回**删掉了几条**（0 或 1），而不是"成功/失败"：
   *    core 那边**找不到 id 不抛错**（幂等删除），路由层照抄这个决定 ——
   *    用户连点两下删除按钮不该看到红色报错。
   */
  @Synchronized
  fun removeAlarm(id: String): Int {
    val list = alarms()
    val kept = list.filter { it.optString("id") != id }
    val removed = list.size - kept.size
    val out = JSONArray()
    for (a in kept) out.put(a)
    data.put("alarms", out)
    // 与 core 一致：id 为空也照样"落一次库"（那边返回 list.slice()，即空操作）
    persist()
    return removed
  }

  /**
   * 开关一条。与 `core/state-ops.js` 的 `toggleAlarm(db, id, enabled, now)` 同语义。
   *
   * ⚠️ 找不到就**抛 404**（与删除不同！这是 core 里刻意的不对称）：
   *    开关是"我对这一条的操作"，那条已经不在时静默成功会让用户以为开关生效了。
   * ⚠️ 关掉计时器时**要清 startedAt**，否则重开那一刻算出来还是"已结束"，会立刻响。
   */
  @Synchronized
  fun toggleAlarm(id: String, enabled: Boolean, nowMs: Long = System.currentTimeMillis()): JSONObject {
    val list = alarms()
    val idx = list.indexOfFirst { it.optString("id") == id }
    if (idx < 0) throw ApiError("这条闹钟不在了（可能已被删除）", 404, "ALARM_NOT_FOUND")
    val prev = list[idx]
    val next = JSONObject(prev.toString())
    val want = enabled   // 路由层已经把 `enabled !== false` 解成布尔了
    next.put("enabled", want)
    if (prev.optString("kind") == "timer") next.put("startedAt", JSONObject.NULL)
    next.put("updatedAt", stamp(nowMs))
    val out = JSONArray()
    for (i in list.indices) out.put(if (i == idx) next else list[i])
    data.put("alarms", out)
    persist()
    return next
  }

  /** 一条闹钟的原始 JSON（诊断/测试用） */
  fun alarmById(id: String): JSONObject? = alarms().firstOrNull { it.optString("id") == id }

  /** 认得出的 ISO 就用它，否则用兜底值（对应 core 的 `isoNow(any, fallback)`） */
  private fun isoOr(raw: String?, fallback: String): String {
    if (raw.isNullOrEmpty()) return fallback
    return try { parseMs(raw).let { if (it == null) fallback else raw } } catch (_: Exception) { fallback }
  }

  /**
   * 严格模式用的校验。与 `core/alarms.js` 的 `validateAlarm(input)` 同语义。
   *
   * ⚠️ 校验的是**原始输入**（不过一遍夹取），所以越界的 25 点能被抓到。
   * ⚠️ 错误码（ALARM_HOUR 等）是**跨端契约**：网页 `showAlarmError()` 按码翻译人话，
   *    改动或新增码必须同时在 web/ui/views/alarms.js 里加翻译，否则会退化成"未知错误"。
   */
  fun validateAlarm(src: JSONObject): List<AlarmError> {
    val out = mutableListOf<AlarmError>()
    // 与 core 一样：先按严格模式归一（保留越界值），再判
    val a = normalizeAlarm(src, System.currentTimeMillis(), strict = true)
    val isTimer = src.optString("kind", "clock") == "timer"

    if (!isTimer) {
      val h = intOrNull(src.opt("atHour"))
      val mi = intOrNull(src.opt("atMinute"))
      val hourOk = h == null || (h in 0..23)
      val minOk = mi == null || (mi in 0..59)
      if (!hourOk) out.add(AlarmError("ALARM_HOUR", "小时要在 0–23 之间"))
      if (!minOk) out.add(AlarmError("ALARM_MINUTE", "分钟要在 0–59 之间"))
      if (!ALARM_REPEATS.contains(src.optString("repeat", "once"))) {
        out.add(AlarmError("ALARM_REPEAT", "重复方式认不出来"))
      }
      if (src.optString("repeat", "once") == "custom" && weekdaysOf(a).isEmpty()) {
        out.add(AlarmError("ALARM_WEEKDAYS", "自定义重复要至少选一天"))
      }
    } else {
      val d = numberOrNull(src.opt("durationMs"))
      if (d == null) out.add(AlarmError("ALARM_DURATION", "请填一个时长"))
      else if (d < TIMER_MIN_MS) out.add(AlarmError("ALARM_DURATION_MIN", "时长短于 1 秒"))
      else if (d > TIMER_MAX_MS) out.add(AlarmError("ALARM_DURATION_MAX", "时长超过 24 小时"))
    }
    val sound = src.opt("sound")
    if (sound != null && sound != JSONObject.NULL && sound.toString().isNotEmpty() && !isKnownAlarmSound(sound)) {
      out.add(AlarmError("ALARM_SOUND", "铃声认不出来，请重新选一个"))
    }
    // ⚠️ 用 40 截断后再判 24：与 core 的 `strOf(src.label, 40).length > 24` 一致 ——
    //    先截到 40 再比 24，意味着"填 30 个字"报错、"填 45 个字"也报错，
    //    两者都要报（不能因为它超得更多就当没超）
    if (strCut(src.opt("label"), 40).length > 24) out.add(AlarmError("ALARM_LABEL", "名字最长 24 个字"))
    return out
  }

  data class AlarmError(val code: String, val message: String)

  /**
   * 把任意形状的闹钟输入归一成**落库的形状**。
   * 与 `core/alarms.js` 的 `normalizeAlarm(raw, now, {strict})` 同语义。
   *
   * @param strict true = 保留越界值（交给 [validateAlarm] 报错）；
   *               false = 夹回合法范围（落库用，保证"库里的数据永远能算"）
   */
  fun normalizeAlarm(raw: JSONObject, nowMs: Long, strict: Boolean = false): JSONObject {
    val at = stamp(nowMs)
    val src = raw

    var kind = src.optString("kind", "clock")
    if (!ALARM_KINDS.contains(kind)) kind = "clock"
    var repeat = src.optString("repeat", "once")
    if (!ALARM_REPEATS.contains(repeat)) repeat = "once"

    val durationRaw = numberOrNull(src.opt("durationMs"))
    val duration: Long = if (durationRaw == null) {
      if (strict && src.has("durationMs")) 0L else 25L * 60_000
    } else if (strict) {
      Math.round(durationRaw)
    } else {
      Math.round(durationRaw).coerceIn(TIMER_MIN_MS, TIMER_MAX_MS)
    }

    fun hhMm(v: Any?, def: Int, lo: Int, hi: Int): Int {
      val n = intOrNull(v)
      if (strict) return n ?: def
      if (n == null) return def
      return n.coerceIn(lo, hi)
    }

    val weekdays = JSONArray()
    if (repeat == "custom") {
      val arr = src.optJSONArray("weekdays")
      val set = sortedSetOf<Int>()
      if (arr != null) for (i in 0 until arr.length()) {
        val n = intOrNull(arr.opt(i)) ?: continue
        if (n in 0..6) set.add(n)
      }
      for (d in set) weekdays.put(d)
    }

    val sound = if (isKnownAlarmSound(src.opt("sound"))) src.opt("sound").toString() else DEFAULT_SOUND_ID

    val out = JSONObject()
    out.put("id", (src.optString("id", "").take(64)).ifEmpty { newAlarmId() })
    out.put("kind", kind)
    out.put("atHour", hhMm(src.opt("atHour"), 7, 0, 23))
    out.put("atMinute", hhMm(src.opt("atMinute"), 0, 0, 59))
    out.put("durationMs", duration)
    out.put("repeat", repeat)
    out.put("weekdays", weekdays)
    out.put("label", strCut(src.opt("label"), 24))
    out.put("sound", sound)
    out.put("enabled", src.optBoolean("enabled", true))
    // ⚠️ 这三个字段的"认不出来给什么"必须与 core 一致，
    //    否则 parity 测试在"用户手改过 db.json"这种边界上就会红
    val started = if (src.has("startedAt")) parseAlarmMs(src.opt("startedAt")) else null
    out.put("startedAt", if (started == null) JSONObject.NULL else Store.stamp(started))
    out.put("paused", src.optBoolean("paused", false))
    // createdAt/updatedAt 只有在输入里有才带（upsert 里再补），保持"形状与输入同构"
    if (src.has("createdAt")) out.put("createdAt", isoOr(src.optString("createdAt"), at))
    if (src.has("updatedAt")) out.put("updatedAt", isoOr(src.optString("updatedAt"), at))
    return out
  }

  // -------------------------------------------------------------------------
  // 课表导入（与 server/store.js 的 importCourses 对齐）
  // -------------------------------------------------------------------------

  class ImportResult(val added: Int, val skipped: Int, val total: Int, val problems: List<String>)

  /**
   * 把课程记录展开成事件。
   *
   * 关键点（都是桌面版踩过坑才对的地方）：
   *   · **一门课的多次上课 = 多条事件**；事件 id 含星期与节次，否则会互相覆盖
   *   · courses 表里一门课一条，`meetings` 列出所有时段
   *   · 按 key 幂等：重复导入覆盖而不堆积
   */
  @Synchronized
  fun importCourses(payload: JSONObject): ImportResult {
    val list = payload.optJSONArray("courses") ?: JSONArray()
    val meta = payload.optJSONObject("meta") ?: JSONObject()
    val mode = payload.optString("mode", "merge")
    val sectionTimes = meta.optJSONArray("sectionTimes")
    val termStart = meta.optString("termStart", "")
    val source = meta.optString("source", "manual")

    if (mode == "replace") {
      data.put("courses", JSONArray())
      val arr = data.optJSONArray("events") ?: JSONArray()
      val kept = JSONArray()
      for (i in 0 until arr.length()) {
        val e = arr.optJSONObject(i) ?: continue
        if (e.optString("type") != "course") kept.put(e)
      }
      data.put("events", kept)
    }

    var added = 0
    var skipped = 0
    val problems = mutableListOf<String>()
    val currentEventKeys = mutableSetOf<String>()
    val eventsArr = data.optJSONArray("events") ?: JSONArray().also { data.put("events", it) }
    val coursesArr = data.optJSONArray("courses") ?: JSONArray().also { data.put("courses", it) }

    for (i in 0 until list.length()) {
      val raw = list.optJSONObject(i) ?: continue
      val title = raw.optString("title", "").trim()
      val day = raw.optInt("dayOfWeek", 0)
      val sections = (raw.optJSONArray("sections")?.let { a -> (0 until a.length()).map { a.optInt(it) } } ?: emptyList())
        .filter { it > 0 }
      val weeksIn = (raw.optJSONArray("weeks")?.let { a -> (0 until a.length()).map { a.optInt(it) } } ?: emptyList())
        .filter { it > 0 }
      if (title.isEmpty() || day <= 0 || sections.isEmpty()) {
        skipped++
        problems.add("跳过无效课程：${title.ifEmpty { "(无名称)" }}（缺 dayOfWeek / sections）")
        continue
      }
      // ⚠️ key 必须包含**老师 + 周次**，不能只用「课程名|星期|节次」。
      //
      // 实测踩到的坑：同一门课用同样的「课程名|星期|节次」导出 8 行 ——
      // 课程名、星期、节次**完全相同**，只是每周换老师、周次各不相同。
      // 旧 key 算出一样的字符串，第 2~8 行都落进"已存在"分支被覆盖，
      // 只剩最后一行，其它几周的课凭空消失。
      // 桌面端 server/store.js 已同步改（两端必须一致，否则同一次导入结果不同）。
      val weeksForKey = if (weeksIn.isNotEmpty()) weeksIn else emptyList()
      val key = raw.optString("key", "").ifBlank {
        "$title|$day|${sections.joinToString(",")}|${raw.optString("teacher", "")}|${weeksForKey.joinToString(",")}"
      }
      val weeks = if (weeksIn.isNotEmpty()) weeksIn else (1..(meta.optInt("termWeeks", 20))).toList()

      // courses 表：一门课一条，meetings 列出所有时段
      var found = -1
      for (j in 0 until coursesArr.length()) {
        if (coursesArr.optJSONObject(j)?.optString("key") == key) { found = j; break }
      }
      val meeting = JSONObject().apply {
        put("dayOfWeek", day)
        put("sections", JSONArray(sections))
        put("weeks", JSONArray(weeks))
        put("location", raw.optString("location", ""))
      }
      val record = JSONObject().apply {
        put("key", key)
        put("title", title)
        put("teacher", raw.optString("teacher", ""))
        put("location", raw.optString("location", ""))
        put("dayOfWeek", day)
        put("sections", JSONArray(sections))
        put("weeks", JSONArray(weeks))
        put("source", source)
        put("importedAt", stamp(System.currentTimeMillis()))
        put("meetings", JSONArray(listOf(meeting)))
      }
      if (found >= 0) {
        val prev = coursesArr.getJSONObject(found)
        val ms = prev.optJSONArray("meetings") ?: JSONArray()
        val sig = "$day|${sections.joinToString(",")}"
        var dup = false
        for (j in 0 until ms.length()) {
          val m = ms.optJSONObject(j) ?: continue
          val ms2 = "${m.optInt("dayOfWeek")}|${(m.optJSONArray("sections")?.let { a -> (0 until a.length()).joinToString(",") { a.optInt(it).toString() } } ?: "")}"
          if (ms2 == sig) { dup = true; break }
        }
        if (!dup) ms.put(meeting)
        record.put("meetings", ms)
        coursesArr.put(found, record)
      } else {
        coursesArr.put(record)
        added++
      }

      // events：一次上课一条，id 含星期与节次
      val evKey = raw.optString("eventKey", "").ifBlank { "course:$key|$day|${sections.joinToString(",")}" }
      // ⚠️ 节次是一段（第 1-2 节 = 8:00–9:35），不是一节。
      //    原来 start/end 都按 sections.first() 算，于是：
      //      · 结束时间被算成"第一节结束"（8:45），实际到 9:35
      //      · 节次范围整个丢掉，课表只能画在一行里
      //    现在按**最后一节**算结束时间，并把 sections 存进事件供课表连线。
      //    桌面端 server/store.js 已同步改（两端必须一致）。
      val slotStart = sectionStart(sectionTimes, sections.first()) ?: "08:00"
      val slotEnd = sectionEnd(sectionTimes, sections.last()) ?: "09:40"
      val startStamp = courseStamp(termStart, day, weeks.first(), slotStart)
      val endStamp = courseStamp(termStart, day, weeks.first(), slotEnd)

      var evIdx = -1
      for (j in 0 until eventsArr.length()) {
        if (eventsArr.optJSONObject(j)?.optString("id") == evKey) { evIdx = j; break }
      }
      val ev = JSONObject().apply {
        put("id", evKey)
        put("title", title)
        put("type", "course")
        put("location", raw.optString("location", ""))
        put("teacher", raw.optString("teacher", ""))
        put("start", startStamp)
        put("end", endStamp)
        put("deadline", startStamp)
        put("deadlineSource", "start")
        put("level", raw.optString("level", "emerald"))
        put("recurrence", JSONObject().put("freq", "none"))
        put("weeks", JSONArray(weeks))
        /** 这节课横跨的节次（第 1-2 节 → [1,2]）。课表靠它把格子连起来画 */
        put("sections", JSONArray(sections))
        put("reminders", settings().optJSONArray("defaultReminders") ?: JSONArray(listOf(10, 0)))
        put("tags", JSONArray(listOf("课程")))
        put("done", false)
        put("updatedAt", stamp(System.currentTimeMillis()))
      }
      if (evIdx >= 0) {
        val prev = eventsArr.getJSONObject(evIdx)
        ev.put("createdAt", prev.optString("createdAt", stamp(System.currentTimeMillis())))
        eventsArr.put(evIdx, ev)
      } else {
        ev.put("createdAt", stamp(System.currentTimeMillis()))
        eventsArr.put(ev)
      }
      currentEventKeys.add(evKey)
    }

    // 清理"上轮导入留下、这次已不存在"的课程事件（只清同为本次导入来源的）
    val importedKeys = (0 until list.length()).mapNotNull { list.optJSONObject(it)?.optString("key") }.toSet()
    val keptEvents = JSONArray()
    for (i in 0 until eventsArr.length()) {
      val e = eventsArr.optJSONObject(i) ?: continue
      val id = e.optString("id")
      if (e.optString("type") == "course" && id.startsWith("course:") && !currentEventKeys.contains(id)) {
        val k = id.removePrefix("course:").substringBefore("|")
        if (importedKeys.contains(k)) continue   // 这门课这次没导 → 清掉旧的
      }
      keptEvents.put(e)
    }
    data.put("events", keptEvents)

    // settings
    val s = settings()
    if (termStart.isNotBlank()) s.put("termStart", termStart)
    if (meta.has("termWeeks")) s.put("termWeeks", meta.optInt("termWeeks"))
    if (sectionTimes != null && sectionTimes.length() > 0) s.put("sectionTimes", sectionTimes)
    val src = s.optJSONArray("importedSources") ?: JSONArray()
    val srcSet = (0 until src.length()).map { src.optString(it) }.toMutableSet()
    srcSet.add(source)
    s.put("importedSources", JSONArray(srcSet.toList()))
    data.put("settings", s)

    persist()
    return ImportResult(added, skipped, coursesArr.length(), problems)
  }

  private fun sectionStart(times: JSONArray?, index: Int): String? {
    if (times == null) return null
    for (i in 0 until times.length()) {
      val t = times.optJSONObject(i) ?: continue
      if (t.optInt("index") == index) return t.optString("start", "")
    }
    return null
  }

  private fun sectionEnd(times: JSONArray?, index: Int): String? {
    if (times == null) return null
    for (i in 0 until times.length()) {
      val t = times.optJSONObject(i) ?: continue
      if (t.optInt("index") == index) return t.optString("end", "")
    }
    return null
  }

  /** 与 store.js 的 buildCourseStart 同构：学期第一周周一 + (week-1)*7 + (day-1) */
  private fun courseStamp(termStart: String, dayOfWeek: Int, week: Int, hhmm: String): String {
    val baseMs = parseMs(termStart) ?: System.currentTimeMillis()
    val cal = java.util.Calendar.getInstance()
    cal.timeInMillis = baseMs
    cal.set(java.util.Calendar.HOUR_OF_DAY, 0); cal.set(java.util.Calendar.MINUTE, 0)
    cal.set(java.util.Calendar.SECOND, 0); cal.set(java.util.Calendar.MILLISECOND, 0)
    // 回到该周的周一
    val dow = cal.get(java.util.Calendar.DAY_OF_WEEK) // 1=Sun
    val delta = if (dow == java.util.Calendar.SUNDAY) -6 else java.util.Calendar.MONDAY - dow
    cal.add(java.util.Calendar.DAY_OF_MONTH, delta + (week - 1) * 7 + (dayOfWeek - 1))
    val parts = hhmm.split(":")
    val h = parts.getOrNull(0)?.toIntOrNull() ?: 0
    val m = parts.getOrNull(1)?.toIntOrNull() ?: 0
    cal.set(java.util.Calendar.HOUR_OF_DAY, h); cal.set(java.util.Calendar.MINUTE, m)
    return stamp(cal.timeInMillis)
  }
}
