package com.appindex.prediction

import android.content.Context
import android.content.SharedPreferences
import com.appindex.model.AppInfo
import com.appindex.StatisticsData.UsageStatisticsManager

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                    智能预测引擎 — 软稳定机制                                    ║
 * ║                                                                              ║
 * ║  核心设计：                                                                    ║
 * ║  1. 预测栏 5 个槽位：3 个"本时段高频" + 2 个"全天高频"                         ║
 * ║  2. 软稳定：2 个全天高频应用位置固定，提供视觉连续性                             ║
 * ║  3. 动态变化：3 个时段高频应用随时间变化，保持新鲜感                             ║
 * ║  4. 冷启动保护：数据不足时，用最近使用过的应用填充                              ║
 * ║                                                                              ║
 * ║  时段划分：早(6-12) 午(12-18) 晚(18-24) 夜(0-6)                                ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */
class SmartPredictionEngine(context: Context) {

    private val usageStatisticsManager = UsageStatisticsManager(context)
    private val prefs: SharedPreferences =
        context.getSharedPreferences("smart_prediction", Context.MODE_PRIVATE)

    /**
     * 预测槽位数据
     */
    data class PredictionSlot(
        val packageName: String,
        val label: String,
        val slotType: SlotType,
        val rank: Int  // 在同类中的排名
    )

    enum class SlotType {
        TIME_SLOT,   // 本时段高频（动态变化）
        ALL_DAY      // 全天高频（软稳定，位置固定）
    }

    /**
     * 获取 5 槽位预测结果
     *
     * 布局：
     * [时段1] [时段2] [时段3] [全天1] [全天2]
     *   ↓       ↓       ↓       ↓       ↓
     *  动态    动态    动态    稳定    稳定
     *
     * @param allApps 所有应用列表（用于获取图标等）
     * @return 5 个预测槽位，按显示顺序排列
     */
    fun getPredictions(allApps: List<AppInfo>): List<PredictionSlot> {
        val predictions = mutableListOf<PredictionSlot>()

        // 1. 获取本时段高频应用（3个）
        val timeSlotApps = usageStatisticsManager.getCurrentTimeSlotTopApplications(3)
        val timeSlotPackages = timeSlotApps.map { it.packageName }.toSet()

        // 2. 获取全天高频应用（2个），排除已在时段列表中的应用
        val allDayApps = usageStatisticsManager.getAllDayTopApplications(10)
            .filter { it.packageName !in timeSlotPackages }
            .take(2)

        // 3. 构建时段槽位（前3个）
        timeSlotApps.forEachIndexed { index, stat ->
            predictions.add(PredictionSlot(
                packageName = stat.packageName,
                label = stat.label,
                slotType = SlotType.TIME_SLOT,
                rank = index + 1
            ))
        }

        // 4. 构建全天槽位（后2个）
        allDayApps.forEachIndexed { index, stat ->
            predictions.add(PredictionSlot(
                packageName = stat.packageName,
                label = stat.label,
                slotType = SlotType.ALL_DAY,
                rank = index + 1
            ))
        }

        // 5. 冷启动保护：如果数据不足，用最近使用过的应用填充
        return fillColdStart(predictions, allApps)
    }

    /**
     * 冷启动保护：当统计数据不足时，用最近使用过的应用填充空槽位
     */
    private fun fillColdStart(
        predictions: MutableList<PredictionSlot>,
        allApps: List<AppInfo>
    ): List<PredictionSlot> {
        if (predictions.size >= 5) return predictions

        // 获取最近使用过的应用（按最后使用时间排序）
        val recentApps = getRecentApps()
        val existingPackages = predictions.map { it.packageName }.toSet()

        var slotIndex = predictions.size
        for (recent in recentApps) {
            if (slotIndex >= 5) break
            if (recent.packageName !in existingPackages) {
                predictions.add(PredictionSlot(
                    packageName = recent.packageName,
                    label = recent.label,
                    slotType = if (slotIndex < 3) SlotType.TIME_SLOT else SlotType.ALL_DAY,
                    rank = slotIndex + 1
                ))
                slotIndex++
            }
        }

        // 如果还不够，随机填充常用应用
        if (predictions.size < 5) {
            val randomApps = allApps.shuffled()
            for (app in randomApps) {
                if (predictions.size >= 5) break
                if (app.packageName !in existingPackages) {
                    predictions.add(PredictionSlot(
                        packageName = app.packageName,
                        label = app.label,
                        slotType = if (predictions.size < 3) SlotType.TIME_SLOT else SlotType.ALL_DAY,
                        rank = predictions.size + 1
                    ))
                }
            }
        }

        return predictions
    }

    /**
     * 记录应用被预测栏点击启动
     */
    fun recordPredictionClick(packageName: String) {
        val clicks = prefs.getInt("click_$packageName", 0)
        prefs.edit().putInt("click_$packageName", clicks + 1).apply()
    }

    /**
     * 获取最近使用过的应用列表
     */
    private fun getRecentApps(): List<RecentApp> {
        val recentJson = prefs.getString(KEY_RECENT_APPS, "[]") ?: "[]"
        val arr = org.json.JSONArray(recentJson)
        val apps = mutableListOf<RecentApp>()

        for (i in 0 until arr.length()) {
            val obj = arr.getJSONObject(i)
            apps.add(RecentApp(
                packageName = obj.getString("packageName"),
                label = obj.getString("label"),
                lastUsed = obj.getLong("lastUsed")
            ))
        }

        return apps.sortedByDescending { it.lastUsed }
    }

    /**
     * 记录最近使用
     */
    fun recordRecentApp(packageName: String, label: String) {
        val recent = getRecentApps().toMutableList()
        recent.removeAll { it.packageName == packageName }
        recent.add(0, RecentApp(packageName, label, System.currentTimeMillis()))

        // 只保留最近20个
        while (recent.size > 20) recent.removeAt(recent.size - 1)

        val arr = org.json.JSONArray()
        recent.forEach { app ->
            arr.put(org.json.JSONObject().apply {
                put("packageName", app.packageName)
                put("label", app.label)
                put("lastUsed", app.lastUsed)
            })
        }

        prefs.edit().putString(KEY_RECENT_APPS, arr.toString()).apply()
    }

    data class RecentApp(
        val packageName: String,
        val label: String,
        val lastUsed: Long
    )

    companion object {
        private const val KEY_RECENT_APPS = "recent_apps"
    }
}
