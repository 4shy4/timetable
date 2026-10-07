package com.timetable.app

import android.content.Context
import java.io.File

/**
 * 安卓侧的 `Store` 入口：把数据文件定位到应用私有目录。
 *
 * 真正的逻辑在 `Store.kt` 里，那个类**不依赖 android.***（只收一个 File），
 * 所以能在普通 JVM 上跑单测、和 server/store.js 做跨实现对照。
 * 这里只负责"文件放哪"这一件事，刻意保持极薄。
 */
fun appStore(context: Context): Store = Store(File(context.filesDir, "db.json"))
