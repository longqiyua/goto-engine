package com.appindex.AppRegistry

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import com.appindex.BasicSearch.PinyinConverter
import com.appindex.model.AppInfo

/**
 * 应用增删改监听器（静态注册的 [BroadcastReceiver]）。
 *
 * 监听系统 `ACTION_PACKAGE_ADDED` / `REMOVED` / `REPLACED` / `CHANGED` 广播，
 * 增量更新 [AppListStore] 缓存，避免全量枚举 [PackageManager] 的开销。
 *
 * 注意：广播 Intent 的 data scheme 必须为 `"package"`，注册时需为
 * IntentFilter 添加 `addDataScheme("package")`，否则收不到广播。
 */
class PackageReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val data = intent.data ?: return
        val pkg = data.encodedSchemeSpecificPart
        if (pkg.isNullOrEmpty()) return

        val store = AppListStore(context)
        // 确保缓存已加载，避免在空缓存上做增量
        store.load()

        when (action) {
            Intent.ACTION_PACKAGE_ADDED,
            Intent.ACTION_PACKAGE_REPLACED -> {
                // REPLACED：覆盖更新（先移除旧信息再重新加入）
                val app = resolveApp(context, pkg) ?: return
                store.applyDelta(added = listOf(app), removed = listOf(pkg))
            }
            Intent.ACTION_PACKAGE_REMOVED -> {
                // 被替换时系统先发 REMOVED(EXTRA_REPLACING=true) 再发 ADDED，此时不应移除
                if (intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)) return
                store.applyDelta(added = emptyList(), removed = listOf(pkg))
            }
            Intent.ACTION_PACKAGE_CHANGED -> {
                // 组件启用/禁用等变化，重新解析覆盖
                val app = resolveApp(context, pkg) ?: return
                store.applyDelta(added = listOf(app), removed = listOf(pkg))
            }
        }
    }

    /** 根据 packageName 解析单个 [AppInfo]（不可见或已卸载时返回 null）。 */
    private fun resolveApp(context: Context, pkg: String): AppInfo? {
        val pm = context.packageManager
        val appInfo = try {
            pm.getApplicationInfo(pkg, PackageManager.GET_META_DATA)
        } catch (_: Throwable) {
            return null
        }
        val label = try {
            pm.getApplicationLabel(appInfo).toString()
        } catch (_: Throwable) {
            ""
        }
        if (label.isBlank()) return null
        return AppInfo(
            packageName = appInfo.packageName,
            label = label,
            pinyin = PinyinConverter.toPinyin(label),
            pinyinInitials = PinyinConverter.toInitials(label),
            pinyinArray = PinyinConverter.toPinyinArray(label),
            icon = appInfo.loadIcon(pm),
            isSystemApp = (appInfo.flags and ApplicationInfo.FLAG_SYSTEM) != 0
        )
    }
}
