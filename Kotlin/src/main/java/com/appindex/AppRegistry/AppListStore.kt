package com.appindex.AppRegistry

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import com.appindex.BasicSearch.PinyinConverter
import com.appindex.model.AppInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * 应用清单存储 — 持久化已安装应用清单，支持全量刷新与增量 diff 更新
 *
 * V2.1 架构扩展：应用监听 + 应用库
 *
 * 存储：Android filesDir/goto/apps/installed-apps.json
 * Engine 维护，不走 base。icon 不持久化，运行时按需加载。
 *
 * 线程安全：ReentrantReadWriteLock 保护内存清单与磁盘读写（禁止锁升级，load 中先释放读锁再取写锁）
 */
class AppListStore(private val context: Context) {

    private val lock = ReentrantReadWriteLock()

    @Volatile
    private var current: List<AppInfo> = emptyList()

    private val storeFile: File
        get() = File(File(context.filesDir, "goto/apps"), "installed-apps.json")

    private val packageManager: PackageManager
        get() = context.packageManager

    /**
     * 读取持久化清单；内存为空且磁盘不存在则触发全量刷新
     */
    fun load(): List<AppInfo> {
        // 先读检查内存缓存
        val cached = lock.read { current }
        if (cached.isNotEmpty()) return cached

        // 再尝试磁盘
        val file = storeFile
        if (file.exists()) {
            val parsed = parseFromDisk(file)
            if (parsed != null && parsed.isNotEmpty()) {
                lock.write { current = parsed }
                return parsed
            }
        }
        // 不存在或解析失败 → 全量刷新
        return fullRefresh()
    }

    /**
     * 全量枚举已安装应用并持久化（复用 PackageManager 逻辑）
     */
    fun fullRefresh(): List<AppInfo> = lock.write { fullRefreshLocked() }

    private fun fullRefreshLocked(): List<AppInfo> {
        val apps = enumerateInstalledApps()
        current = apps
        persistToDisk(apps)
        return apps
    }

    /**
     * 增量 diff 更新：added/removed/changed 包名列表
     * 返回更新后的完整清单
     */
    fun applyDelta(
        added: List<String>,
        removed: List<String>,
        changed: List<String>
    ): List<AppInfo> = lock.write {
        val byPkg = current.associateBy { it.packageName }.toMutableMap()

        // 删除
        for (pkg in removed) byPkg.remove(pkg)

        // 新增 + 变更：重新查询 PackageManager
        val toFetch = added + changed
        for (pkg in toFetch) {
            val info = queryApp(pkg)
            if (info != null) byPkg[pkg] = info else byPkg.remove(pkg)
        }

        val updated = byPkg.values.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })
        current = updated
        persistToDisk(updated)
        updated
    }

    /**
     * 返回当前内存清单快照
     */
    fun snapshot(): List<AppInfo> = lock.read { current }

    // ─── 内部：PackageManager 枚举 ───

    private fun enumerateInstalledApps(): List<AppInfo> {
        val pm = packageManager
        val packages = try {
            pm.getInstalledApplications(PackageManager.GET_META_DATA)
        } catch (e: Throwable) {
            return current
        }
        val apps = ArrayList<AppInfo>(packages.size)
        for (appInfo in packages) {
            if (appInfo.flags and ApplicationInfo.FLAG_SUSPENDED != 0) continue
            val label = getAppLabel(pm, appInfo)
            if (label.isBlank()) continue
            apps.add(buildAppInfo(appInfo, label))
        }
        return apps.sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.label })
    }

    private fun queryApp(packageName: String): AppInfo? {
        val pm = packageManager
        val appInfo = try {
            pm.getApplicationInfo(packageName, PackageManager.GET_META_DATA)
        } catch (e: PackageManager.NameNotFoundException) {
            return null
        } catch (e: Throwable) {
            return null
        }
        if (appInfo.flags and ApplicationInfo.FLAG_SUSPENDED != 0) return null
        val label = getAppLabel(pm, appInfo)
        if (label.isBlank()) return null
        return buildAppInfo(appInfo, label)
    }

    private fun buildAppInfo(appInfo: ApplicationInfo, label: String): AppInfo {
        return AppInfo(
            packageName = appInfo.packageName,
            label = label,
            pinyin = PinyinConverter.toPinyin(label),
            pinyinInitials = PinyinConverter.toInitials(label),
            pinyinArray = PinyinConverter.toPinyinArray(label),
            icon = null,  // 不持久化，运行时按需加载
            isSystemApp = (appInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0
        )
    }

    private fun getAppLabel(pm: PackageManager, appInfo: ApplicationInfo): String = try {
        pm.getApplicationLabel(appInfo).toString()
    } catch (e: Throwable) { "" }

    // ─── 内部：JSON 持久化 ───

    private fun persistToDisk(apps: List<AppInfo>) {
        try {
            val arr = JSONArray()
            for (a in apps) {
                val pa = JSONArray()
                for (p in a.pinyinArray) pa.put(p)
                arr.put(JSONObject().apply {
                    put("packageName", a.packageName)
                    put("label", a.label)
                    put("pinyin", a.pinyin)
                    put("pinyinInitials", a.pinyinInitials)
                    put("pinyinArray", pa)
                    put("labelLower", a.labelLower)
                    put("isSystemApp", a.isSystemApp)
                })
            }
            val root = JSONObject().apply {
                put("version", 1)
                put("updatedAt", System.currentTimeMillis())
                put("apps", arr)
            }
            val file = storeFile
            file.parentFile?.mkdirs()
            file.writeText(root.toString())
        } catch (e: Throwable) {
            // 持久化失败不影响内存清单
        }
    }

    private fun parseFromDisk(file: File): List<AppInfo>? {
        return try {
            val root = JSONObject(file.readText())
            val arr = root.optJSONArray("apps") ?: return emptyList()
            val apps = ArrayList<AppInfo>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val pkg = o.optString("packageName")
                if (pkg.isEmpty()) continue
                val label = o.optString("label")
                val pinyinArray = ArrayList<String>()
                val pa = o.optJSONArray("pinyinArray")
                if (pa != null) {
                    for (j in 0 until pa.length()) pinyinArray.add(pa.optString(j))
                }
                val labelLower = o.optString("labelLower").ifEmpty { label.lowercase() }
                apps.add(
                    AppInfo(
                        packageName = pkg,
                        label = label,
                        pinyin = o.optString("pinyin"),
                        pinyinInitials = o.optString("pinyinInitials"),
                        pinyinArray = pinyinArray,
                        labelLower = labelLower,
                        icon = null,
                        isSystemApp = o.optBoolean("isSystemApp", false)
                    )
                )
            }
            apps
        } catch (e: Throwable) {
            null
        }
    }
}
