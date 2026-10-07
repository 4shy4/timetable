// 独立 JVM 驱动：用和 Node 侧完全相同的输入跑一遍 Kotlin 的 Store，输出 JSON。
//
// 为什么不走 Gradle 的单元测试：AGP 的 testDebugUnitTest 与 Kotlin 输出目录
// 在这套组合下互相找不到类（报 ClassNotFoundException，但 class 文件确实编译出来了）。
// 而 Store 刻意**不依赖 android.***（只收一个 File），所以完全可以脱离 Gradle 直接跑：
// 用 kotlinc 编一遍，然后 java 运行。更少活动部件，也更容易复现。
//
// 比对逻辑在 tools/android-store-parity.test.mjs。
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Calendar

/**
 * 再下一个周一 09:00 —— 所有相对时间的锚点。
 *
 * 为什么锚在"下周一"而不是"明天"：
 *   · 它**必然在未来**（周重复类用例需要"未来的一次发生"）
 *   · 而且是个稳定的星期锚点，`M(n, h)` 的语义才清楚（周内第 n 天）
 *   · 星期几不随运行日期变化，所以"周一 09:00 的那次发生"这类断言不会飘
 */
val MONDAY_MS: Long = run {
  val c = java.util.Calendar.getInstance()
  val dow = c.get(java.util.Calendar.DAY_OF_WEEK)
  // 先回到本周一，再往后推一周 → 下周一
  val back = if (dow == java.util.Calendar.SUNDAY) -6 else java.util.Calendar.MONDAY - dow
  c.add(java.util.Calendar.DAY_OF_MONTH, back + 7)
  c.set(java.util.Calendar.HOUR_OF_DAY, 9)
  c.set(java.util.Calendar.MINUTE, 0)
  c.set(java.util.Calendar.SECOND, 0)
  c.set(java.util.Calendar.MILLISECOND, 0)
  c.timeInMillis
}

/** 基准 = 下周一 09:00 */
val BASE_MS: Long = MONDAY_MS

/** 相对基准的天/小时：T(0)=下周一 09:00，正数往后、负数往前 */
fun T(days: Int = 0, hours: Int = 0): String =
  Store.stamp(BASE_MS + days * 86_400_000L + hours * 3600_000L)

/** 下周一算第 0 天，指定小时 */
fun M(daysFromMonday: Int, hour: Int): String =
  Store.stamp(BASE_MS + daysFromMonday * 86_400_000L + (hour - 9) * 3600_000L)

/**
 * 同上，但能指定分钟。
 *
 * ⚠️ 必须有这个：批量把写死日期换成相对时间时，`08:49:00` 和 `08:50:00`
 *    都被粗心映射成了 `M(0,8)` —— 分秒没了，两个变量变成同一时刻，
 *    于是"到点前不该弹"的断言直接失效（失败信息还完全看不出原因）。
 *    凡是"差几分钟"的用例，都要用这个精确构造。
 */
fun M2(daysFromMonday: Int, hour: Int, minute: Int): String =
  Store.stamp(BASE_MS + daysFromMonday * 86_400_000L + (hour - 9) * 3600_000L + minute * 60_000L)

private fun j(vararg kv: Pair<String, Any?>): JSONObject {
  val o = JSONObject()
  for ((k, v) in kv) o.put(k, v ?: JSONObject.NULL)
  return o
}

private fun arr(vararg items: Any?): JSONArray {
  val a = JSONArray()
  for (i in items) a.put(i ?: JSONObject.NULL)
  return a
}

fun main(args: Array<String>) {
  val dir = File(args.getOrElse(0) { "build/android-parity" })
  dir.deleteRecursively()
  dir.mkdirs()
  val out = JSONObject()
  val store = Store(File(dir, "db.json"))

  // ---- 1) 套娃层级 ----
  val red = store.upsertEvent(j("title" to "红容器", "start" to T(30), "level" to "red"))
  val green = store.upsertEvent(
    j("title" to "绿", "start" to T(0), "level" to "emerald", "parentId" to red.optString("id")),
  )
  out.put("createdRedLevel", red.optString("level"))
  out.put("greenParentIsRed", green.optString("parentId") == red.optString("id"))
  out.put("redIntoRedRejected", try {
    store.upsertEvent(j("title" to "红2", "start" to T(0, 1), "level" to "red", "parentId" to red.optString("id")))
    false
  } catch (e: Store.ApiError) { true })
  // ⚠️ 行为变更：父容器不存在时**降级为最外层新建**，不再报错。
  //    原来抛 400，结果用户"只要创建就失败"（陈旧客户端一直发已删掉的容器 id）。
  //    用户的意图是"新建一条日程"，父没了不该阻止这件事。
  out.put("missingParentDegrades", try {
    val x = store.upsertEvent(j("title" to "x", "start" to T(0, 1), "level" to "sky", "parentId" to "evt_nope"))
    x.optString("parentId", "") == "" && x.optString("id", "").isNotEmpty()
  } catch (e: Store.ApiError) { false })

  // ---- 2) 旧数据迁移 ----
  out.put(
    "legacyLevels",
    JSONArray(listOf(100, 90, 70, 60, 40, 25).map {
      store.upsertEvent(j("title" to "旧$it", "start" to T(1), "magnitude" to it)).optString("level")
    }),
  )

  // 结构：红(3) → 黄(2) → 绿(1) → 蓝(0)
  // 注意等级顺序：rank 越小越"小"，子级必须**严于**父级。
  // 所以 amber(2) 是放不进 emerald(1) 的 —— 第一版把这一对搞反了，
  // 结果 store 正确拒绝、我却当成 bug。
  val amber = store.upsertEvent(
    j("title" to "黄", "start" to T(0, 2), "level" to "amber", "parentId" to red.optString("id")),
  )
  val green2 = store.upsertEvent(
    j("title" to "绿2", "start" to T(0, 2), "level" to "emerald", "parentId" to amber.optString("id")),
  )
  val blue = store.upsertEvent(
    j("title" to "蓝", "start" to T(0, 3), "level" to "sky", "parentId" to green2.optString("id")),
  )
  // 反向也必须被拒：绿(1) 不能装黄(2)
  out.put("emeraldCannotHoldAmber", try {
    store.upsertEvent(
      j("title" to "倒挂", "start" to T(0, 4), "level" to "amber", "parentId" to green2.optString("id")),
    )
    false
  } catch (e: Store.ApiError) { true })

  // ---- 3a) 只挪位置：改标题不能动 parentId ----
  // （必须在一个确实有父级的对象上测，否则这条断言毫无意义 —— 第一版就写错了）
  val renamed = store.patchEvent(amber.optString("id"), j("title" to "黄改名"))
  out.put("renameKeptParentInRed", renamed.optString("parentId") == red.optString("id"))

  // ---- 3b) 戳破黄：只释放直接子级（绿2），孙辈（蓝）不动 ----
  val pop = store.popEvent(amber.optString("id"))
  out.put("popReleasedCount", pop.second.size)
  val byTitle = store.events().associateBy { it.optString("title") }
  out.put("popAmberDone", byTitle["黄改名"]!!.optBoolean("done"))
  out.put("popReleasedGreen2ToRed", byTitle["绿2"]!!.optString("parentId") == red.optString("id"))
  out.put("popBlueStaysInGreen2", byTitle["蓝"]!!.optString("parentId") == green2.optString("id"))

  // ---- 3c) 拉出来：把绿2从红里拿出来 → 变成最外层 ----
  store.patchEvent(green2.optString("id"), j("parentId" to null))
  out.put("green2IsRootAfterUnparent", store.events().first { it.optString("title") == "绿2" }.optString("parentId", "") == "")

  // ---- 5) 课表导入 ----
  val payload = j(
    "meta" to j(
      "source" to "parity", "termStart" to T(0).substring(0, 10), "termWeeks" to 16,
      "sectionTimes" to arr(
        j("index" to 1, "start" to "08:00", "end" to "08:45"),
        j("index" to 2, "start" to "08:50", "end" to "09:35"),
        j("index" to 5, "start" to "13:30", "end" to "14:15"),
        j("index" to 6, "start" to "14:20", "end" to "15:05"),
      ),
    ),
    "mode" to "merge",
    "courses" to arr(
      j(
        "key" to "k1", "title" to "高等数学", "dayOfWeek" to 1, "sections" to arr(1, 2),
        "weeks" to arr(1, 2, 3, 4), "location" to "广楼G309", "teacher" to "单鑫",
        "eventKey" to "course:k1|1|1,2",
      ),
      j(
        "key" to "k1", "title" to "高等数学", "dayOfWeek" to 3, "sections" to arr(5, 6),
        "weeks" to arr(1, 2, 3, 4), "location" to "广楼G309", "teacher" to "单鑫",
        "eventKey" to "course:k1|3|5,6",
      ),
    ),
  )
  val imported = store.importCourses(payload)
  out.put("importAdded", imported.added)
  val evs = store.events().filter { it.optString("type") == "course" }
  out.put("courseEventCount", evs.size)
  out.put("courseStarts", JSONArray(evs.map { it.optString("start").substring(11, 16) }.sorted()))
  out.put("courseStartDiffersFromEnd", evs.all { it.optString("start") != it.optString("end") })
  out.put("courseMeetingCount", store.courses().first { it.optString("title") == "高等数学" }.getJSONArray("meetings").length())
  store.importCourses(payload)
  out.put("courseEventCountAfterReimport", store.events().count { it.optString("type") == "course" })

  // ---- 6) 截止时间优先级 ----
  val withDl = store.upsertEvent(
    j("title" to "有期限", "start" to T(2), "deadline" to T(5, 9), "level" to "sky"),
  )
  out.put("explicitDeadlineWins", withDl.optString("deadline").startsWith(T(5, 9).substring(0, 10)))
  val noDl = store.upsertEvent(j("title" to "无期限", "start" to T(3), "level" to "sky"))
  out.put("deadlineFallsBackToStart", noDl.optString("deadline").startsWith(T(3).substring(0, 10)))

  // ---- 8) 提醒：重复规则必须逐次展开 ----
  //
  // 这一块是最容易"看起来对、其实没用"的地方：第一版直接拿 deadline 当发生时刻，
  // 于是周重复的日程和带 weeks 的课表**只有第一次会响** —— 而那恰恰是主场景。
  // 用固定的 now 来断言，避免依赖运行时刻。
  val remindStore = Store(File(dir, "remind.json"))
  // 用"周一 09:00"的事件，让周重复的推算稳定
  val monday = M(0, 9)
  remindStore.upsertEvent(
    j(
      "title" to "每周例会", "start" to monday, "level" to "emerald",
      "recurrence" to j("freq" to "weekly"),
    ),
  )

  // 从现在往未来 25 小时看：周一 09:00 那一次应当被展开出来（如果 now 在其之前）
  val nowMs = Store.parseMs(M(0, 8))!!
  val occ = remindStore.occurrencesIn(remindStore.events().first(), nowMs, nowMs + 25 * 3600_000L)
  out.put("weeklyOccurrenceCount", occ.size)
  out.put("weeklyOccurrenceIsMonday9", occ.firstOrNull()?.let { Store.stamp(it) }?.startsWith(M(0, 9).substring(0, 16)) ?: false)

  // 双周：隔一周才该有
  val bi = remindStore.upsertEvent(
    j("title" to "双周会", "start" to monday, "level" to "emerald", "recurrence" to j("freq" to "biweekly")),
  )
  val biOcc = remindStore.occurrencesIn(bi, nowMs, nowMs + 20L * 24 * 3600_000L)
  out.put("biweeklyCountIn20Days", biOcc.size)

  // ---- 8f) 「每 N 周」可自定义（用户要求：每周/每两周不够用）----
  // 两端必须展开出**同样的日期**，所以这里把几种间隔都跑一遍。
  val every3 = remindStore.upsertEvent(
    j(
      "title" to "每三周会", "start" to monday, "level" to "emerald",
      "recurrence" to j("freq" to "weekly", "interval" to 3),
    ),
  )
  val e3 = remindStore.occurrencesIn(every3, MONDAY_MS, MONDAY_MS + 90L * 86_400_000L)
  out.put("every3WeeksCount", e3.size)
                       // 0,3,6,9,12 周 → 5 次（90 天≈12.8 周）
  out.put("every3WeeksSpacingDays", e3.zipWithNext { a, b -> (b - a) / 86_400_000L }.toSet())
  out.put("every3WeeksStamps", e3.map { Store.stamp(it).substring(0, 10) })

  // 旧写法 biweekly 必须仍然等价于 interval=2
  out.put("intervalWeeksLegacyBiweekly", remindStore.intervalWeeksOf(j("freq" to "biweekly")))
  out.put("intervalWeeksWeeklyDefault", remindStore.intervalWeeksOf(j("freq" to "weekly")))
  out.put("intervalWeeksPlain3", remindStore.intervalWeeksOf(j("freq" to "weekly", "interval" to 3)))
  // 边界：0 / 负数 / 非数字 / 超上限 → 归一化
  out.put("intervalWeeksZero", remindStore.intervalWeeksOf(j("freq" to "weekly", "interval" to 0)))
  out.put("intervalWeeksNegative", remindStore.intervalWeeksOf(j("freq" to "weekly", "interval" to -5)))
  out.put("intervalWeeksJunk", remindStore.intervalWeeksOf(j("freq" to "weekly", "interval" to "x")))
  out.put("intervalWeeksHuge", remindStore.intervalWeeksOf(j("freq" to "weekly", "interval" to 999)))
  // 显示文字
  out.put("labelEvery1", remindStore.freqLabelOf(j("freq" to "weekly")))
  out.put("labelEvery2", remindStore.freqLabelOf(j("freq" to "biweekly")))
  out.put("labelEvery3", remindStore.freqLabelOf(j("freq" to "weekly", "interval" to 3)))

  // ---- 一周勾满 7 天不能重复膨胀（JS 侧同一个 bug，两端都要钉住）----
  val all7 = remindStore.upsertEvent(
    j(
      "title" to "每天跑步", "start" to M(0, 7), "level" to "emerald",
      "recurrence" to j("freq" to "weekly", "byDay" to arr(0, 1, 2, 3, 4, 5, 6)),
    ),
  )
  val week1 = remindStore.occurrencesIn(all7, MONDAY_MS, MONDAY_MS + 7L * 86_400_000L)
  out.put("allSevenDaysPerWeek", week1.size)              // 应当是 7，不是 49
  out.put("allSevenDaysUnique", week1.toSet().size)       // 不能有重复

  // ---- 日/月/年级（用户要求"严格遵循级别单位"）----
  // 两端必须展开出**同样的日期**，所以把边界情况都跑一遍。
  fun stampsOf(ev: JSONObject, fromMs: Long, days: Long): List<String> =
    remindStore.occurrencesIn(ev, fromMs, fromMs + days * 86_400_000L)
      .map { Store.stamp(it).substring(0, 10) }

  // 日级：每 3 天（用固定的过去日期，避免"相对今天"造成不稳定）
  val dayEv = remindStore.upsertEvent(
    j("title" to "每三天", "start" to "2026-03-02T07:00:00", "level" to "emerald",
      "recurrence" to j("freq" to "daily", "interval" to 3)),
  )
  val dayFrom = Store.parseMs("2026-03-01T00:00:00")!!
  out.put("dailyEvery3Stamps", stampsOf(dayEv, dayFrom, 15))
  out.put("dailyEvery3Count", stampsOf(dayEv, dayFrom, 15).size)

  // 月级：31 号 —— 只有有 31 号的月份才新生（2 月/4 月跳过）
  val m31 = remindStore.upsertEvent(
    j("title" to "每月31号", "start" to "2026-01-31T09:00:00", "level" to "emerald",
      "recurrence" to j("freq" to "monthly")),
  )
  val mFrom = Store.parseMs("2026-01-01T00:00:00")!!
  out.put("monthly31Stamps", stampsOf(m31, mFrom, 152))     // 到 6 月初

  // 月级：30 号（2 月跳过，3/4/5 月都有）
  val m30 = remindStore.upsertEvent(
    j("title" to "每月30号", "start" to "2026-01-30T09:00:00", "level" to "emerald",
      "recurrence" to j("freq" to "monthly")),
  )
  out.put("monthly30Stamps", stampsOf(m30, mFrom, 121))     // 到 5 月初

  // 年级：2/29 起 —— 只在闰年新生
  val y229 = remindStore.upsertEvent(
    j("title" to "每年229", "start" to "2028-02-29T09:00:00", "level" to "emerald",
      "recurrence" to j("freq" to "yearly")),
  )
  val yFrom = Store.parseMs("2028-01-01T00:00:00")!!
  out.put("yearlyFeb29Stamps", stampsOf(y229, yFrom, 365 * 5 + 2))   // 到 2033 初

  // 级别归一化与显示
  out.put("levelDailyEvery3", remindStore.recurLevelOf(j("freq" to "daily", "interval" to 3))?.interval)
  out.put("levelMonthlyCap", remindStore.recurLevelOf(j("freq" to "monthly", "interval" to 9999))?.interval)
  out.put("levelYearlyCap", remindStore.recurLevelOf(j("freq" to "yearly", "interval" to 9999))?.interval)
  out.put("levelDailyJunk", remindStore.recurLevelOf(j("freq" to "daily", "interval" to "x"))?.interval)
  out.put("labelDaily", remindStore.freqLabelOf(j("freq" to "daily")))
  out.put("labelEvery3Days", remindStore.freqLabelOf(j("freq" to "daily", "interval" to 3)))
  out.put("labelMonthly", remindStore.freqLabelOf(j("freq" to "monthly")))
  out.put("labelYearly", remindStore.freqLabelOf(j("freq" to "yearly")))

  // ---- 按实例记账（用户要求"戳破一颗不结束整条"）----
  // 与 server/store.js 的 popEvent 一致：重复事件只记这一颗。
  val instEv = remindStore.upsertEvent(
    j("title" to "实例记账", "start" to M(0, 7), "level" to "emerald",
      "recurrence" to j("freq" to "daily")),
  )
  val instId = instEv.optString("id")
  val popDay = Store.parseMs(M(1, 7))!!
  val (poppedEv, _) = remindStore.popEvent(instId, Store.stamp(popDay), 2L * 86_400_000L)
  out.put("instancePopKeepsSeries", !poppedEv.optBoolean("done", false))   // 整条不能结束
  out.put("instancePopRecorded", poppedEv.optJSONObject("popped")?.length() ?: 0)
  val rcRec = (0 until remindStore.poppedRecords().length())
    .map { remindStore.poppedRecords().optJSONObject(it) }
    .firstOrNull { it.optString("eventId") == instId }
  out.put("recycleCount", rcRec?.optInt("count") ?: -1)
  // 提前完成 → 正数 remainingMs（前端会显示成 -2天）
  val entry0 = rcRec?.optJSONArray("entries")?.optJSONObject(0)
  out.put("recycleRemainingMs", entry0?.opt("remainingMs"))
  // 还原
  remindStore.restorePopped(instId)
  out.put("restoreClearsPopped", (remindStore.events().first { it.optString("id") == instId }
    .optJSONObject("popped")?.length() ?: 0))

  // ---- 课程摘要 ----
  //
  // ⚠️ 这里**不能**用 harness 的 `MONDAY_MS` —— 它是"下周一 **09:00**"（带时分，
  //    因为别的用例需要"未来的一次发生"）。用它当学期起点会让：
  //      · `MONDAY_MS + 12h` 变成 21:30（不是中午）
  //      · 课落在学期起点**之前** → 周次算成 0 → 被 weeks 过滤掉
  //    我第一次就是这么错的。改成独立的"**本周一午夜**"锚点。
  val WEEK_MON_MS: Long = run {
    val c = java.util.Calendar.getInstance()
    val dow = c.get(java.util.Calendar.DAY_OF_WEEK)
    val back = if (dow == java.util.Calendar.SUNDAY) -6 else java.util.Calendar.MONDAY - dow
    c.add(java.util.Calendar.DAY_OF_MONTH, back)
    c.set(java.util.Calendar.HOUR_OF_DAY, 0)
    c.set(java.util.Calendar.MINUTE, 0)
    c.set(java.util.Calendar.SECOND, 0)
    c.set(java.util.Calendar.MILLISECOND, 0)
    c.timeInMillis
  }
  val digTermStart = Store.stamp(WEEK_MON_MS).substring(0, 10)
  remindStore.updateSettings(j("termStart" to digTermStart))
  // 本周一 14:00 的课（落在"中午"窗口 12:00–17:00），第 1 周
  remindStore.importCourses(
    j(
      "courses" to arr(
        j("key" to "digest-test", "title" to "摘要测试课", "dayOfWeek" to 1,
          "sections" to arr(9), "weeks" to arr(1),
          "location" to "测试楼101"),
      ),
      "meta" to j(
        "source" to "digest-test",
        "termStart" to digTermStart,
        "termWeeks" to 16,
        // ⚠️ 导入是**按节次表**算时刻的（不是用 start）。不给的话第 9 节默认 18:30，
        //    落在"中午"窗口之外，摘要就不出现。
        "sectionTimes" to arr(j("index" to 9, "start" to "14:00", "end" to "14:45")),
      ),
      "mode" to "merge",
    ),
  )
  val noonSlotMs = WEEK_MON_MS + 12 * 3600_000L + 30 * 60_000L      // 本周一 12:30
  val noonNow = noonSlotMs + 5 * 60_000L                            // 本周一 12:35
  remindStore.updateSettings(
    j("courseDigest" to j(
      "enabled" to true,
      "perCourseReminders" to false,
      "slots" to j(
        "tonight" to j("on" to false, "at" to "21:00"),
        "morning" to j("on" to false, "at" to "07:30"),
        "noon" to j("on" to true, "at" to "12:30"),
        "evening" to j("on" to false, "at" to "17:30"),
      ),
    )),
  )
  val digs = remindStore.dueDigests(noonNow, shouldMark = false)
  out.put("digestCount", digs.size)
  out.put("digestSlot", digs.firstOrNull()?.slot)
  out.put("digestTitle", digs.firstOrNull()?.title)
  out.put("digestBodyHasCourse", digs.firstOrNull()?.body?.contains("摘要测试课") ?: false)
  out.put("digestBodyHasLocation", digs.firstOrNull()?.body?.contains("@测试楼101") ?: false)
  out.put("digestKey", digs.firstOrNull()?.key)
  // ⚠️ 这两个是给**日期敏感**断言用的锚点：digestKey 里带"本周一"的日期，
  //    写死成某个具体日期的话，只要今天不是写测试那天就会红（实测会红）。
  //    断言侧拿这两个键现算期望值，而不是把日期抄进 EXPECT。
  out.put("anchorMonday", Store.stamp(WEEK_MON_MS).substring(0, 10))
  out.put("digestDay", Store.stamp(noonSlotMs).substring(0, 10))
  // ⚠️ 别把这两个锚点搞混：`BASE_MS`/`T()`/`M()` 是**下周一**（every3Weeks 那类用例用它），
  //    `WEEK_MON_MS` 是**本周一**（摘要槽位用它）。混了就会整整差一周。
  out.put("baseNextMonday", Store.stamp(BASE_MS).substring(0, 10))
  // 更晚的时段（傍晚）不该报中午的课
  out.put("digestNoEveningForNoonCourse",
    remindStore.dueDigests(MONDAY_MS + 17 * 3600_000L + 35 * 60_000L, shouldMark = false).isEmpty())
  // 太晚了不补发（超过新鲜期）
  out.put("digestTooLateSkipped",
    remindStore.dueDigests(noonSlotMs + 91 * 60_000L, shouldMark = false).isEmpty())
  // 关掉总开关就不响
  remindStore.updateSettings(j("courseDigest" to j("enabled" to false)))
  out.put("digestDisabledSilent", remindStore.dueDigests(noonNow, shouldMark = false).isEmpty())

  // ---- 缺省值补全必须**两条路径都覆盖** ----
  //
  // ⚠️ 这是真机测出来的坑：`/api/state` 走 `state()`，它直接返回 data 的拷贝、
  //    **不经过 `settings()`**。我第一版只补了 `settings()`，于是设置页
  //    （读的是 /api/state）还是看不到 courseDigest。
  //    所以两条路径都要断言，而且槽位要**逐个**检查（空 `slots: {}` 也算不全）。
  fun slotCount(o: JSONObject?): Int = o?.optJSONObject("slots")?.length() ?: -1
  out.put("stateHasCourseDigest", slotCount(remindStore.state().optJSONObject("settings")?.optJSONObject("courseDigest")))
  out.put("settingsHasCourseDigest", slotCount(remindStore.settings().optJSONObject("courseDigest")))
  out.put("stateHasSectionTimes", remindStore.state().optJSONObject("settings")?.has("sectionTimes") ?: false)

  // ---- 闹钟要按时醒，而且**不能死循环** ----
  //
  // 加了摘要之后 `nextAlarmAt` 必须把摘要时刻算进去，否则摘要要等到下一个
  // 普通提醒才顺带发出，时间就不准了。
  // 同时必须排除"已记账"的槽位 —— 不然闹钟 21:00 醒来发完摘要、再排下一条时
  // 又选中同一个槽位（还在 90 分钟新鲜期内），会反复醒。
  remindStore.updateSettings(
    j("courseDigest" to j(
      "enabled" to true,
      "slots" to j(
        "tonight" to j("on" to false, "at" to "21:00"),
        "morning" to j("on" to false, "at" to "07:30"),
        "noon" to j("on" to true, "at" to "12:30"),
        "evening" to j("on" to false, "at" to "17:30"),
      ),
    )),
  )
  // 11:00 时看下一条闹钟：今天 12:30 那个中午摘要还没发，应当被排上
  val alarmBeforeSlot = remindStore.nextAlarmAt(WEEK_MON_MS + 11 * 3600_000L)
  out.put("nextAlarmHitsDigestSlot", alarmBeforeSlot == noonSlotMs)
  // 把它发掉（记账）之后，下一条**不能再是同一个槽位** —— 这是防死循环的关键
  remindStore.updateSettings(
    j("courseDigest" to j(
      "enabled" to true,
      "slots" to j(
        "tonight" to j("on" to false, "at" to "21:00"),
        "morning" to j("on" to false, "at" to "07:30"),
        "noon" to j("on" to true, "at" to "12:30"),
        "evening" to j("on" to false, "at" to "17:30"),
      ),
    )),
  )
  val taken = remindStore.takeDueDigests(noonNow)   // 记账
  out.put("takenDigestCount", taken.size)
  val alarmAfterSlot = remindStore.nextAlarmAt(noonNow)
  out.put("nextAlarmNotSameSlot", alarmAfterSlot != noonSlotMs)

  // 课表：带 weeks 的单次事件要按学期周次逐周展开
  remindStore.updateSettings(j("termStart" to T(0).substring(0, 10)))
  val courseEv = remindStore.upsertEvent(
    j(
      "title" to "高等数学", "start" to M(2, 8), "end" to M(2, 9),
      "level" to "emerald", "type" to "course", "weeks" to arr(1, 2, 3, 4),
    ),
  )
  val cOcc = remindStore.occurrencesIn(courseEv, nowMs, nowMs + 40L * 24 * 3600_000L)
  out.put("courseOccurrenceCount", cOcc.size)    // 4 周各一次
  out.put("courseOccurrencesAllWednesday", cOcc.all { Store.stamp(it).contains("T08:00") })

  // dueReminders：到点前沿应当给出 fired=false 的项，到点后给 fired=true
  //
  // ⚠️ 取 08:49 而不是 08:50：09:00 的会按"分档"计划有提前 10 分钟的提醒，
  //    fireAt 正好是 08:50:00。用 08:50:00 去断言"不该弹"，等于把测试压在
  //    边界那一秒上 —— 实测就是这么误报的（我一度以为实现有 bug）。
  val t0849 = Store.parseMs(M2(0, 8, 49))!!
  val t0850 = Store.parseMs(M2(0, 8, 50))!!
  val before = remindStore.dueReminders(t0849)
  val atFire = remindStore.dueReminders(t0850)
  out.put("dueNoneFiredAt0849", before.count { it.optBoolean("fired") } == 0)
  // 到了 08:50（= 提前 10 分钟那一刻）就该有一项 fired=true
  out.put("dueFiredExactlyAtFireAt", atFire.any { it.optBoolean("fired") })
  // 同一条提醒不该重复弹：账本记账后第二次调用应当不再 fired
  val again = remindStore.dueReminders(t0850)
  out.put("dueNotRepeatedSameKey", again.count { it.optBoolean("fired") } == 0)

  val atTime = remindStore.dueReminders(Store.parseMs(M(0, 9))!!)
  out.put("dueHasFiredAtTime", atTime.any { it.optBoolean("fired") })

  // ---- 8b) 排程：nextAlarmAt / takeDueNotifications ----
  //
  // 这两个是 AlarmManager 那条路的核心（"关掉界面也能提醒"）。它们跑在 JVM 上，
  // 所以能被断言 —— 真正碰 AlarmManager 的那层（ReminderAlarms/ReminderReceiver）
  // 依赖 Context，测不到，只能靠"计算对了 + 调用点接对了"来保证。
  val schedStore = Store(File(dir, "sched.json"))
  schedStore.upsertEvent(j("title" to "上午会", "start" to M(0, 9), "level" to "emerald"))

  // 08:00 时：下一个闹钟应当指向"最近的那次**未来**提醒"，而且必须 > now
  // （否则系统会立刻触发，等于装完弹一堆旧的）。
  //
  // 期望值从 dueItems 推导，**不写死具体时刻** —— 档位表改了断言不该跟着碎。
  // 09:00 的会剩 1 小时 → 档位是 hour（>= 3600000），计划 [60,30,10,0,-5]，
  // 于是 fireAt 有 08:00 / 08:30 / 08:50 / 09:00 / 09:05；
  // 08:00 那一刻的"下一次"是 08:30，**不是** 08:00（严格大于，同刻不算未来）。
  // 第一版断言写的是 08:00（我以为会用 day 档的提前 60 分钟）—— 断言错，不是实现错。
  val t0800 = Store.parseMs(M(0, 8))!!
  val n0800 = schedStore.nextAlarmAt(t0800)
  val expectedNext = schedStore.dueItems(t0800, 7L * 24 * 3600_000L, shouldMark = false)
    .map { it.fireAt }.filter { it > t0800 }.minOrNull()
  out.put("nextAlarmIsInFuture", n0800 != null && n0800 > t0800)
  out.put("nextAlarmMatchesEarliestFuture", n0800 == expectedNext)

  // 过了的点必须跳过：在 08:30:01 问"下一次"，答案不能是 08:30（已过去）
  //
  // ⚠️ 必须用 M2 构造，别手写 `MONDAY_MS + 8*3600_000` —— 基准是 **09:00**，
  //    加 8 小时得到的是 17:00（== 下午五点），于是"当天上午的会"早过了，
  //    断言就变成"期望有下一次、实际 null"。实测就是这么错的。
  val t0830 = Store.parseMs(M2(0, 8, 30))!! + 1000L
  val n0830 = schedStore.nextAlarmAt(t0830)
  out.put("nextAlarmSkipsPast", n0830 != null && n0830 > t0830)
  // 失败时要有可诊断的信息（原来只报 true/false，完全看不出为什么）
  out.put("debugNextAlarm", "${n0830?.let { Store.stamp(it) } ?: "null"} (now=${Store.stamp(t0830)})")

  // 没有事件时不该有闹钟（否则会白白占着精确闹钟名额）
  val emptyStore = Store(File(dir, "empty.json"))
  out.put("nextAlarmNullWhenNoEvents", emptyStore.nextAlarmAt(Store.parseMs(M(0, 8))!!) == null)

  // 醒来时该弹的：08:49 还没到点 → 一条都不该弹
  val wake0849 = schedStore.takeDueNotifications(Store.parseMs(M(0, 8))!!)
  out.put("takeDueEmptyBefore", wake0849.isEmpty())

  // 09:00:30（已到点）：应当拿到"到点且没弹过"的项，并且**同时记账**
  val wake0900 = schedStore.takeDueNotifications(Store.parseMs(M(0, 9))!!)
  out.put("takeDueHasItemsAtTime", wake0900.isNotEmpty())
  out.put("takeDueAllFired", wake0900.all { it.fired })
  // 再调一次必须为空 —— 否则闹钟重复触发会重复弹
  out.put("takeDueNotRepeated", schedStore.takeDueNotifications(Store.parseMs(M(0, 9))!!).isEmpty())

  // takeDueNotifications 的窗口是"回看 60 秒"，不是"往前看 25 小时"：
  // 一次唤醒不该把很久以后才该响的也弹出来
  val far = schedStore.autoRemindersOn(schedStore.events().first())
  out.put("autoRemindersDefaultsOn", far)

  // ---- 8d) 账本必须**落盘且被多个 Store 实例共享** ----
  //
  // 安卓端有多个 Store 实例（LocalServer 一个、ReminderReceiver 每次醒来 new 一个）。
  // 原来账本只在进程内存里，各实例互不可见 → 同一条提醒会被"网页轮询"和
  // "系统闹钟"各弹一次。这个回归就是钉住"跨实例不会重复弹"。
  val ledgerDir = File(dir, "ledger")
  ledgerDir.mkdirs()
  val ledgerDb = File(ledgerDir, "db.json")

  val a = Store(ledgerDb)
  a.upsertEvent(j("title" to "落盘账本", "start" to M(2, 10), "level" to "emerald"))
  val t1000 = MONDAY_MS + 2 * 86_400_000L + 3600_000L + 30_000L
  val firstPop = a.takeDueNotifications(t1000).size
  out.put("ledgerFirstFires", firstPop > 0)

  // 关键：**另一个实例**（模拟 ReminderReceiver）在同一时刻不该再弹一次
  val b = Store(ledgerDb)
  out.put("ledgerSharedAcrossInstances", b.takeDueNotifications(t1000).isEmpty())

  // 落盘文件真的写了
  out.put("ledgerFileWritten", File(ledgerDir, "fired.json").exists())

  // 而且重启（新实例、新的一天之内）依然记得
  val c = Store(ledgerDb)
  out.put("ledgerSurvivesRestart", c.takeDueNotifications(t1000).isEmpty())
  out.put("ledgerNotEmpty", c.firedLedger().isNotEmpty())

  // ---- 8c) 数据变更回调：写操作必须触发（AlarmManager 靠它重排）----
  var changed = 0
  schedStore.onChanged = { changed += 1 }
  schedStore.upsertEvent(j("title" to "回调测试", "start" to T(6), "level" to "sky"))
  out.put("onChangedFiredOnUpsert", changed >= 1)
  val cntAfterUpsert = changed
  val ev2 = schedStore.events().first { it.optString("title") == "回调测试" }
  schedStore.patchEvent(ev2.optString("id"), j("title" to "回调测试2"))
  out.put("onChangedFiredOnPatch", changed > cntAfterUpsert)
  val cntAfterPatch = changed
  schedStore.deleteEvent(ev2.optString("id"))
  out.put("onChangedFiredOnDelete", changed > cntAfterPatch)

  // ---- 11) 过期容器只读：能看，但不能往里加子泡泡 ----
  //
  // 用户要求：紫泡泡（过期）**可以进去看**，但不该再往里加东西 —— 过期了就翻篇了。
  // 客户端守了一道（点背景加子气泡会被拒），服务端**必须再守一道**，
  // 否则绕过界面直接调 API 还是能塞进去，两边就不一致了。
  val roDir = File(dir, "readonly")
  roDir.mkdirs()
  val ro = Store(File(roDir, "db.json"))
  val past = Store.stamp(System.currentTimeMillis() - 3600_000L)   // 一小时前 = 已过期
  val future = Store.stamp(System.currentTimeMillis() + 7L * 24 * 3600_000L)

  val overdueRed = ro.upsertEvent(j("title" to "过期的红", "start" to past, "level" to "red"))
  out.put("overdueDetected", ro.isOverdue(overdueRed))

  // 往里加子气泡 → 必须被拒
  out.put("overdueRejectsChild", try {
    ro.upsertEvent(
      j("title" to "子", "start" to future, "level" to "sky", "parentId" to overdueRed.optString("id")),
    )
    false
  } catch (e: Store.ApiError) { true })

  // 没过期的容器照常可以加
  val freshRed = ro.upsertEvent(j("title" to "没过期的红", "start" to future, "level" to "red"))
  out.put("freshAcceptsChild", try {
    ro.upsertEvent(
      j("title" to "子2", "start" to future, "level" to "sky", "parentId" to freshRed.optString("id")),
    )
    true
  } catch (e: Store.ApiError) { false })

  // 拖拽改归属（走 PATCH）也要被拒
  val loose = ro.upsertEvent(j("title" to "游离的蓝", "start" to future, "level" to "sky"))
  out.put("overdueRejectsPatchReparent", try {
    ro.patchEvent(loose.optString("id"), j("parentId" to overdueRed.optString("id")))
    false
  } catch (e: Store.ApiError) { true })

  // 但**拉出来**必须仍然允许（从紫母气泡里把子气泡拉出来是用户明确要过的功能）
  val willExpire = ro.upsertEvent(j("title" to "即将过期", "start" to future, "level" to "red"))
  ro.upsertEvent(
    j("title" to "里面的子", "start" to future, "level" to "sky", "parentId" to willExpire.optString("id")),
  )
  ro.patchEvent(willExpire.optString("id"), j("deadline" to past))   // 把父改到过去 → 变紫
  val nowOverdue = ro.events().first { it.optString("id") == willExpire.optString("id") }
  out.put("parentBecameOverdue", ro.isOverdue(nowOverdue))
  val inner = ro.events().first { it.optString("title") == "里面的子" }
  out.put("canStillPullOutFromOverdue", try {
    ro.patchEvent(inner.optString("id"), j("parentId" to null))
    true
  } catch (e: Store.ApiError) { false })

  // ---- 9) 删父释放子（在一个新结构上测，避免前面的操作把关系改掉）----
  val delRed = store.upsertEvent(j("title" to "待删红", "start" to T(4), "level" to "red"))
  val delChild = store.upsertEvent(
    j("title" to "待删子", "start" to T(4, 1), "level" to "sky", "parentId" to delRed.optString("id")),
  )
  out.put("childReallyNestedBeforeDelete", store.childrenOf(delRed.optString("id")).size)
  store.deleteEvent(delRed.optString("id"))
  val afterDel = store.events()
  out.put("deletedParentGone", afterDel.none { it.optString("id") == delRed.optString("id") })
  out.put(
    "childSurvivedAndReleased",
    afterDel.firstOrNull { it.optString("id") == delChild.optString("id") }?.optString("parentId", "") == "",
  )

  // ---- 9b) 闹钟（安卓"闹钟简版"）：CRUD + nextAlarmAt 必须把 alarms 算进去 ----
  //
  // 为什么单独用一个 Store：闹钟的"下次触发"完全是绝对时刻（不像事件那样相对 BASE_MS 展开），
  // 混进上面那个被折腾过几十次的库会让"到底是谁贡献了这个时刻"说不清。
  val aDir = File(dir, "alarms")
  aDir.deleteRecursively()
  aDir.mkdirs()
  val as0 = Store(File(aDir, "db.json"))
  // ⚠️ M()/M2() 返回的是**字符串**（core 那边的形状），要比时刻得先 parseMs
  val aNow = Store.parseMs(M2(0, 8, 30))!!     // 周一 08:30（相对 BASE_MS，不写死日期）
  val a0900 = Store.parseMs(M(0, 9))!!
  val a1000 = Store.parseMs(M(0, 10))!!

  out.put("alarmsDefaultEmpty", as0.alarms().isEmpty())

  // ⚠️ 没有闹钟、也没有事件时，nextAlarmAt 必须是 null —— 否则壳会注册一个假闹钟，
  //    精确闹钟名额被白占（安卓上这个名额很金贵）。
  out.put("nextAlarmNullWhenNoAlarms", as0.nextAlarmAt(aNow) == null)

  val clock1 = as0.upsertAlarm(
    j("kind" to "clock", "atHour" to 9, "atMinute" to 0, "repeat" to "once", "label" to "起床"),
    aNow,
  )
  out.put("alarmSaveReturnsSingle", clock1.optString("id").startsWith("alarm_"))
  out.put("alarmShapeAtHour", clock1.optInt("atHour"))
  out.put("alarmShapeAtMinute", clock1.optInt("atMinute"))
  out.put("alarmShapeRepeat", clock1.optString("repeat"))
  out.put("alarmShapeSound", clock1.optString("sound"))       // 没给 sound → 默认 triple
  out.put("alarmShapeEnabled", clock1.optBoolean("enabled"))
  out.put("alarmShapeLabel", clock1.optString("label"))
  out.put("alarmShapeHasCreatedAt", clock1.has("createdAt") && clock1.has("updatedAt"))

  // 闹钟进了 nextAlarmAt（以前完全不看 alarms —— 症状是"加了闹钟从来不响"）
  val aNext1 = as0.nextAlarmAt(aNow)
  out.put("nextAlarmSeesClockAlarm", aNext1 == a0900)
  out.put("nextAlarmClockAlarmStamp", if (aNext1 == null) "null" else Store.stamp(aNext1))

  // 已关掉的不排、且不该顶替更晚的那条
  as0.upsertAlarm(j("id" to clock1.optString("id"), "kind" to "clock", "atHour" to 9,
    "atMinute" to 0, "repeat" to "once", "enabled" to false), aNow)
  out.put("nextAlarmSkipsDisabled", as0.nextAlarmAt(aNow) == null)
  val reEnabled = as0.toggleAlarm(clock1.optString("id"), true, aNow)
  out.put("alarmToggleBackOn", reEnabled.optBoolean("enabled"))
  out.put("nextAlarmAfterToggleOn", as0.nextAlarmAt(aNow) == a0900)
  out.put("alarmToggleMissingThrows", try {
    as0.toggleAlarm("alarm_nope", true, aNow); false
  } catch (e: Store.ApiError) { e.status == 404 && e.code == "ALARM_NOT_FOUND" })

  // 编辑：id/createdAt 必须保持，updatedAt 要动
  val edited = as0.upsertAlarm(j("id" to clock1.optString("id"), "kind" to "clock", "atHour" to 10,
    "atMinute" to 0, "repeat" to "once", "label" to "改成十点"), aNow + 60_000L)
  out.put("alarmEditKeepsId", edited.optString("id") == clock1.optString("id"))
  out.put("alarmEditKeepsCreatedAt", edited.optString("createdAt") == clock1.optString("createdAt"))
  out.put("alarmEditMovesUpdatedAt", edited.optString("updatedAt") != clock1.optString("updatedAt"))
  out.put("alarmEditChangesFire", as0.nextAlarmAt(aNow) == a1000)
  out.put("alarmEditCountStillOne", as0.alarms().size == 1)

  // ---- 下次触发时刻的算法（必须与 core/alarms.js 的 nextFireAt 同语义）----
  val rep = Store(File(aDir, "db-rep.json"))
  val daily = rep.upsertAlarm(j("kind" to "clock", "atHour" to 9, "repeat" to "daily"), aNow)
  out.put("alarmDailyNextIsToday", rep.nextFireAt(daily, aNow) == a0900)

  val dailyPast = rep.upsertAlarm(
    j("kind" to "clock", "atHour" to 8, "atMinute" to 0, "repeat" to "daily"), aNow,
  )
  out.put("alarmDailyRollsToTomorrow", rep.nextFireAt(dailyPast, aNow) == Store.parseMs(M(1, 8))!!)

  // 周三 09:00（aNow 是周一）。weekdays 里存的是"用户勾的那几天本身"（0=周日，照 JS getDay）
  val wed = rep.upsertAlarm(
    j("kind" to "clock", "atHour" to 9, "repeat" to "custom", "weekdays" to arr(3)), aNow,
  )
  out.put("alarmWeeklyPicksWednesday", rep.nextFireAt(wed, aNow) == Store.parseMs(M(2, 9))!!)
  out.put("alarmWeeklyKeepsWeekdays", wed.optJSONArray("weekdays")?.optInt(0))
  out.put("alarmWeekdaysSortedDeduped",
    rep.upsertAlarm(j("kind" to "clock", "repeat" to "custom", "weekdays" to arr(5, 1, 5, 9)),
      aNow).optJSONArray("weekdays").toString())

  // custom 一天都没勾 → 不排（core 里明确"不随便挑一天"），校验会先拦下
  out.put("alarmCustomNoWeekdayRejected", try {
    rep.upsertAlarm(j("kind" to "clock", "repeat" to "custom", "weekdays" to JSONArray()), aNow); false
  } catch (e: Store.ApiError) { e.code == "ALARM_WEEKDAYS" && e.status == 400 })

  // 计时器：startedAt + durationMs，过了也给"过去那一刻"（不是 null）
  val timer = rep.upsertAlarm(
    j("kind" to "timer", "durationMs" to 25 * 60_000, "startedAt" to Store.stamp(aNow)), aNow,
  )
  out.put("alarmTimerNextIsStartPlusDuration", rep.nextFireAt(timer, aNow) == aNow + 25 * 60_000L)
  out.put("alarmTimerFiredMarksOffAndClearsStarted",
    rep.markAlarmFired(timer.optString("id"), aNow + 26 * 60_000L)?.let {
      !it.optBoolean("enabled") && it.opt("startedAt") == JSONObject.NULL
    })
  val once = rep.upsertAlarm(j("kind" to "clock", "atHour" to 9, "repeat" to "once"), aNow)
  out.put("alarmOnceFiredMarksOff",
    rep.markAlarmFired(once.optString("id"), aNow)?.let { !it.optBoolean("enabled") })
  // 重复闹钟响完不该被关掉（否则用户设的"每天"响一天就没了）
  out.put("alarmRepeatFiredStaysOn",
    rep.markAlarmFired(daily.optString("id"), aNow)?.let { it.optBoolean("enabled") })

  // ---- "到点了"的判定窗口（ReminderReceiver 靠它决定要不要发闹钟通知）----
  val dueStore = Store(File(aDir, "db-due.json"))
  val dueAl = dueStore.upsertAlarm(j("kind" to "clock", "atHour" to 9, "atMinute" to 0,
    "repeat" to "daily", "label" to "该起床了"), a0900)
  out.put("dueAlarmsInsideWindow", dueStore.dueAlarms(a0900).any { it.optString("id") == dueAl.optString("id") })
  out.put("dueAlarmsWithTolerance", dueStore.dueAlarms(a0900 + 30_000L).any { it.optString("id") == dueAl.optString("id") })
  out.put("dueAlarmsTooEarly", dueStore.dueAlarms(a0900 - 10 * 60_000L).none { it.optString("id") == dueAl.optString("id") })
  out.put("dueAlarmsTooLate", dueStore.dueAlarms(a0900 + 10 * 60_000L).none { it.optString("id") == dueAl.optString("id") })
  out.put("dueAlarmsSkipsDisabled", dueStore.toggleAlarm(dueAl.optString("id"), false, a0900)
    .let { dueStore.dueAlarms(a0900).none { a -> a.optString("id") == dueAl.optString("id") } })

  // ---- 校验：越界必须报错，**不许悄悄夹回去**（夹回去 = 用户设 25 点被凌晨 1 点吵醒）----
  out.put("alarmHour25Rejected", try {
    as0.upsertAlarm(j("kind" to "clock", "atHour" to 25), aNow); false
  } catch (e: Store.ApiError) { e.code == "ALARM_HOUR" && e.status == 400 })
  out.put("alarmMinute60Rejected", try {
    as0.upsertAlarm(j("kind" to "clock", "atHour" to 9, "atMinute" to 60), aNow); false
  } catch (e: Store.ApiError) { e.code == "ALARM_MINUTE" })
  out.put("alarmBadSoundRejected", try {
    as0.upsertAlarm(j("kind" to "clock", "atHour" to 9, "sound" to "nonexistent_sound"), aNow); false
  } catch (e: Store.ApiError) { e.code == "ALARM_SOUND" && e.status == 400 })
  // 但"宽松归一化"这一层仍然兜底成 triple（用户手改 db.json 写坏了声音时，库里要能算出时刻）
  out.put("alarmBadSoundFallsBack",
    as0.normalizeAlarm(j("kind" to "clock", "atHour" to 9, "sound" to "nonexistent_sound"), aNow)
      .optString("sound") == "triple")
  out.put("alarmCustomSoundIdAccepted", as0.upsertAlarm(
    j("kind" to "clock", "atHour" to 9, "sound" to "custom:mine"), aNow,
  ).let { it.optString("sound") == "custom:mine" })
  out.put("alarmLongLabelRejected", try {
    as0.upsertAlarm(j("kind" to "clock", "atHour" to 9, "label" to "字".repeat(30)), aNow); false
  } catch (e: Store.ApiError) { e.code == "ALARM_LABEL" })

  // ---- 上限 50 条 ----
  val limStore = Store(File(aDir, "db-limit.json"))
  for (i in 1..50) limStore.upsertAlarm(j("kind" to "clock", "atHour" to (i % 24), "label" to "第 $i 条"), aNow)
  out.put("alarmLimitReached50", limStore.alarms().size)
  out.put("alarmLimitRejects51st", try {
    limStore.upsertAlarm(j("kind" to "clock", "atHour" to 6, "label" to "第 51 条"), aNow); false
  } catch (e: Store.ApiError) { e.code == "ALARM_LIMIT" && e.status == 400 })

  // ---- 删除 ----
  val delStore = Store(File(aDir, "db-del.json"))
  val del1 = delStore.upsertAlarm(j("kind" to "clock", "atHour" to 9, "label" to "待删"), aNow)
  out.put("alarmDeleteReturnsOne", delStore.removeAlarm(del1.optString("id")))
  out.put("alarmDeleteIdempotent", delStore.removeAlarm(del1.optString("id")))
  out.put("alarmDeleteEmptiesNext", delStore.nextAlarmAt(aNow) == null)

  // ---- 落盘 + 重启后还在（壳与网页是两个进程，靠 db.json 交接）----
  // ⚠️ 上面"校验被拒"的那些用例一条都没落库（这正是要断言的：拒了就不许改库），
  //    所以 as0 里应当只剩"编辑过的那条"+"custom:mine 那条"整整两条。
  val aReload = Store(File(aDir, "db.json"))
  out.put("alarmSurvivesReload", aReload.alarms().size == 2 &&
    aReload.alarms().any { it.optString("label") == "改成十点" })
  out.put("alarmsPersistedInState", aReload.state().has("alarms"))
  out.put("nextAlarmAfterReload", aReload.nextAlarmAt(aNow) == a0900)

  // ---- 10) 落盘 ----
  val reopened = Store(File(dir, "db.json"))
  out.put("persistedEventCount", reopened.events().size)

  println(out.toString(2))
}
