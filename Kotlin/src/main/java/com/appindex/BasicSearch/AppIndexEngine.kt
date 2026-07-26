package com.appindex.BasicSearch

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import com.appindex.model.AppInfo
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 应用索引引擎
 *
 * 职责：
 * 1. 扫描系统已安装的所有应用
 * 2. 预计算拼音和首字母索引
 * 3. 维护内存中的应用列表
 *
 * 性能：
 * - 首次索引：约 50-100ms（取决于安装应用数量）
 * - 内存占用：约 200 个应用 × 200 字节 ≈ 40KB
 */
class AppIndexEngine(private val context: Context) {

    private val packageManager: PackageManager = context.packageManager

    /**
     * 已索引的应用列表（线程安全通过协程保证）
     */
    private var _indexedApps: List<AppInfo> = emptyList()
    val indexedApps: List<AppInfo> get() = _indexedApps

    /**
     * 索引所有已安装应用
     * 在 IO 线程执行，避免阻塞主线程
     */
    suspend fun indexAllApps(): List<AppInfo> = withContext(Dispatchers.IO) {
        val startTime = System.nanoTime()

        val apps = mutableListOf<AppInfo>()

        // 获取所有已安装应用
        val packages = packageManager.getInstalledApplications(
            PackageManager.GET_META_DATA
        )

        for (appInfo in packages) {
            // 过滤掉没有启动图标的不可见应用
            if (appInfo.flags and ApplicationInfo.FLAG_SUSPENDED != 0) continue

            val label = getAppLabel(appInfo)
            if (label.isBlank()) continue

            val pinyin = PinyinConverter.toPinyin(label)
            val initials = PinyinConverter.toInitials(label)
            val pinyinArray = PinyinConverter.toPinyinArray(label)

            apps.add(
                AppInfo(
                    packageName = appInfo.packageName,
                    label = label,
                    pinyin = pinyin,
                    pinyinInitials = initials,
                    pinyinArray = pinyinArray,
                    icon = appInfo.loadIcon(packageManager),
                    isSystemApp = (appInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0
                )
            )
        }

        // 按应用名称排序（支持按拼音排序）
        _indexedApps = apps.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })

        val elapsed = (System.nanoTime() - startTime) / 1_000_000
        android.util.Log.d("AppIndex", "索引完成: ${apps.size} 个应用, 耗时 ${elapsed}ms")

        _indexedApps
    }

    /**
     * 获取应用显示名称
     */
    private fun getAppLabel(appInfo: ApplicationInfo): String {
        return try {
            packageManager.getApplicationLabel(appInfo).toString()
        } catch (e: Exception) {
            ""
        }
    }

    /**
     * 重新索引（当应用安装/卸载时调用）
     */
    suspend fun reindex(): List<AppInfo> {
        return indexAllApps()
    }

    /**
     * 获取应用总数
     */
    fun getAppCount(): Int = _indexedApps.size
}
