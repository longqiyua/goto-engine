package com.appindex.AppRegistry

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import com.appindex.BasicSearch.PinyinConverter
import com.appindex.model.AppInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 应用清单持久化存储 — 维护已安装应用列表的内存缓存 + 文件持久化。
 *
 * 首次访问时全量枚举 [PackageManager] 并落盘；后续直接读文件。
 * 应用增删改由 [PackageReceiver] 触发增量更新（[applyDelta]）。
 *
 * 被 [com.appindex.component.DefaultEngineFacade.rebuildRag] 使用：
 *   - `store.snapshot()` 取内存缓存
 *   - `store.load()` 取持久化（首次全量枚举）
 *
 * 存储路径：`filesDir/goto/apps/installed-apps.json`
 *
 * @param context Android Context
 */
class AppListStore(private val context: Context) {

    private val storeFile: File =
        File(File(File(context.filesDir, "goto"), "apps").apply { mkdirs() }, "installed-apps.json")

    @Volatile
    private var cache: List<AppInfo> = emptyList()

    /** 当前内存缓存的应用列表（不触发加载）。 */
    fun snapshot(): List<AppInfo> = cache

    /**
     * 从文件加载应用列表；文件不存在或为空时首次全量枚举 [PackageManager] 并持久化。
     * @return 当前完整应用列表
     */
    fun load(): List<AppInfo> {
        if (cache.isNotEmpty()) return cache
        if (storeFile.exists()) {
            val fromFile = readFromFile()
            if (fromFile.isNotEmpty()) {
                cache = fromFile
                return cache
            }
        }
        // 文件不存在或为空 → 全量枚举
        cache = enumerateInstalledApps()
        persist(cache)
        return cache
    }

    /** 强制全量枚举 [PackageManager] 并持久化。 */
    fun fullRefresh(): List<AppInfo> {
        cache = enumerateInstalledApps()
        persist(cache)
        return cache
    }

    /**
     * 增量更新：合并新增应用、移除已卸载应用，并持久化。
     * @param added 新增应用列表
     * @param removed 已卸载应用的 packageName 列表
     * @return 更新后的完整列表
     */
    fun applyDelta(added: List<AppInfo>, removed: List<String>): List<AppInfo> {
        if (cache.isEmpty()) load()
        val removedSet = removed.toSet()
        // 以 packageName 为键覆盖合并（保留插入顺序）
        val merged = LinkedHashMap<String, AppInfo>()
        for (app in cache) {
            if (app.packageName !in removedSet) merged[app.packageName] = app
        }
        for (app in added) {
            merged[app.packageName] = app
        }
        cache = merged.values.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })
        persist(cache)
        return cache
    }

    /** 持久化应用列表到 JSON 文件（不含 icon，启动时按需重载）。 */
    private fun persist(apps: List<AppInfo>) {
        try {
            val arr = JSONArray()
            for (app in apps) {
                val obj = JSONObject()
                obj.put("packageName", app.packageName)
                obj.put("label", app.label)
                obj.put("pinyin", app.pinyin)
                obj.put("pinyinInitials", app.pinyinInitials)
                obj.put("isSystemApp", app.isSystemApp)
                arr.put(obj)
            }
            storeFile.writeText(arr.toString())
        } catch (_: Throwable) {
            // 持久化失败不影响内存缓存
        }
    }

    /** 从 JSON 文件读取应用列表（不含 icon，按需重载）。 */
    private fun readFromFile(): List<AppInfo> {
        return try {
            val arr = JSONArray(storeFile.readText())
            val apps = ArrayList<AppInfo>(arr.length())
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val label = obj.optString("label")
                if (label.isBlank()) continue
                apps.add(
                    AppInfo(
                        packageName = obj.optString("packageName"),
                        label = label,
                        pinyin = obj.optString("pinyin"),
                        pinyinInitials = obj.optString("pinyinInitials"),
                        pinyinArray = PinyinConverter.toPinyinArray(label)
                    )
                )
            }
            apps
        } catch (_: Throwable) {
            emptyList()
        }
    }

    /** 全量枚举 [PackageManager] 中带启动图标的可见应用。 */
    private fun enumerateInstalledApps(): List<AppInfo> {
        val pm = context.packageManager
        val packages = pm.getInstalledApplications(PackageManager.GET_META_DATA)
        val apps = ArrayList<AppInfo>(packages.size)
        for (appInfo in packages) {
            // 过滤被挂起的应用
            if (appInfo.flags and ApplicationInfo.FLAG_SUSPENDED != 0) continue
            val label = try {
                pm.getApplicationLabel(appInfo).toString()
            } catch (_: Throwable) {
                ""
            }
            if (label.isBlank()) continue
            apps.add(
                AppInfo(
                    packageName = appInfo.packageName,
                    label = label,
                    pinyin = PinyinConverter.toPinyin(label),
                    pinyinInitials = PinyinConverter.toInitials(label),
                    pinyinArray = PinyinConverter.toPinyinArray(label),
                    icon = appInfo.loadIcon(pm),
                    isSystemApp = (appInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0
                )
            )
        }
        return apps.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })
    }
}
