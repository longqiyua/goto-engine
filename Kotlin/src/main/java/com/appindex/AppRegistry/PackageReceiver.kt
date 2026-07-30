package com.appindex.AppRegistry

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

/**
 * 应用变更监听 — Manifest 静态注册，常驻不依赖 ViewModel
 *
 * V2.1 架构扩展：监听 PACKAGE_ADDED/REMOVED/CHANGED/REPLACED
 *
 * 收到广播 → 增量更新 [AppListStore] → 通过 [PackageChangeListener] 通知 Engine 重建索引
 * Engine 模块是 library，不能直接依赖 app 模块，故用回调接口由 app 层注册
 */
class PackageReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val data: Uri? = intent.data
        val packageName = data?.schemeSpecificPart
        if (packageName.isNullOrEmpty()) return

        val added: List<String>
        val removed: List<String>
        val changed: List<String>

        when (action) {
            Intent.ACTION_PACKAGE_ADDED -> {
                added = listOf(packageName)
                removed = emptyList()
                changed = emptyList()
            }
            Intent.ACTION_PACKAGE_REMOVED -> {
                added = emptyList()
                removed = listOf(packageName)
                changed = emptyList()
            }
            Intent.ACTION_PACKAGE_CHANGED, Intent.ACTION_PACKAGE_REPLACED -> {
                // REPLACED = 同包名卸载后重装，视为变更（重新查询元数据）
                added = emptyList()
                removed = emptyList()
                changed = listOf(packageName)
            }
            else -> return
        }

        // 增量更新应用清单
        val store = AppListStore(context)
        try {
            store.applyDelta(added, removed, changed)
        } catch (e: Throwable) {
            Log.w(TAG, "applyDelta 失败: ${e.message}")
        }

        // 通知 app 层触发 Engine 重建索引
        try {
            listener?.onPackagesChanged(added, removed, changed)
        } catch (e: Throwable) {
            Log.w(TAG, "通知 listener 失败: ${e.message}")
        }
    }

    /**
     * 应用变更回调接口 — 由 app 层注册实现，触发 Engine 重建索引
     */
    interface PackageChangeListener {
        fun onPackagesChanged(added: List<String>, removed: List<String>, changed: List<String>)
    }

    companion object {
        private const val TAG = "PackageReceiver"

        @Volatile
        private var listener: PackageChangeListener? = null

        /** app 层注册回调（例如在 SearchService 初始化时） */
        fun setListener(l: PackageChangeListener?) {
            listener = l
        }
    }
}
