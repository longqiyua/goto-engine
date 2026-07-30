package com.appindex.Rerank

import android.content.Context
import org.json.JSONObject
import java.io.File

/**
 * RAG 灰度过渡控制器 — 管理新旧 RAG 库的双库灰度过渡
 *
 * V2.1 架构扩展：月度 RAG 重建
 *
 * 逻辑：
 *   - 过渡周期 [TRANSITION_DAYS] = 15 天
 *   - 新库写到 personal/rag/vector-store.v2.json + rag-index.v2.json
 *   - 过渡状态记录到 personal/rag/.transition（JSON：startedAt/newVectorPath/newIndexPath/oldVectorPath/oldIndexPath）
 *   - 线性权重：第1天 0%，第15天 100%，超过 15 天返回 1.0 并触发删除旧库
 *
 * 路径基准：{filesDir}/goto-base/shared/data/personal/rag/
 */
class RagTransitionController(private val context: Context) {

    private val transitionDays: Int = TRANSITION_DAYS

    private val ragDir: File
        get() = File(context.filesDir, "goto-base/shared/data/personal/rag")

    private val transitionFile: File
        get() = File(ragDir, ".transition")

    /**
     * 启动过渡：写新库，记录过渡状态
     * @param newVectors 新向量库 JSON 字符串
     * @param newIndex 新索引 JSON 字符串
     */
    fun startTransition(newVectors: String, newIndex: String) {
        val dir = ragDir
        dir.mkdirs()
        val newVectorPath = File(dir, "vector-store.v2.json")
        val newIndexPath = File(dir, "rag-index.v2.json")
        newVectorPath.writeText(newVectors)
        newIndexPath.writeText(newIndex)

        // 旧库路径（若存在则记录，便于收尾删除）
        val oldVectorPath = File(dir, "vector-store.json")
        val oldIndexPath = File(dir, "rag-index.json")

        val state = JSONObject().apply {
            put("startedAt", System.currentTimeMillis())
            put("newVectorPath", newVectorPath.absolutePath)
            put("newIndexPath", newIndexPath.absolutePath)
            put("oldVectorPath", if (oldVectorPath.exists()) oldVectorPath.absolutePath else JSONObject.NULL)
            put("oldIndexPath", if (oldIndexPath.exists()) oldIndexPath.absolutePath else JSONObject.NULL)
        }
        transitionFile.writeText(state.toString())
    }

    /**
     * 返回当前灰度权重 0.0~1.0
     * 第1天 0%，第15天 100%，线性插值；超过 15 天返回 1.0 并触发删除旧库
     */
    fun getBlendWeight(): Float {
        val startedAt = readStartedAt() ?: return 1.0f
        val elapsedDays = (System.currentTimeMillis() - startedAt) / DAY_MS.toFloat()
        if (elapsedDays >= transitionDays) {
            // 超过过渡周期 → 触发收尾
            try { finalizeTransition() } catch (_: Throwable) {}
            return 1.0f
        }
        if (elapsedDays <= 0f) return 0.0f
        return (elapsedDays / transitionDays).coerceIn(0.0f, 1.0f)
    }

    /**
     * 收尾过渡：删旧库，新库去 v2 后缀，清理过渡状态
     */
    fun finalizeTransition() {
        val state = readState() ?: return
        val dir = ragDir
        // 删旧库
        optString(state, "oldVectorPath")?.let { File(it).delete() }
        optString(state, "oldIndexPath")?.let { File(it).delete() }
        // 新库去 v2 后缀
        optString(state, "newVectorPath")?.let { src ->
            val srcFile = File(src)
            if (srcFile.exists()) srcFile.renameTo(File(dir, "vector-store.json"))
        }
        optString(state, "newIndexPath")?.let { src ->
            val srcFile = File(src)
            if (srcFile.exists()) srcFile.renameTo(File(dir, "rag-index.json"))
        }
        // 清理过渡状态
        transitionFile.delete()
    }

    /**
     * 是否正在过渡中
     */
    fun isTransitioning(): Boolean = transitionFile.exists()

    /**
     * 返回当前应使用的 (vectorPath, indexPath)，考虑灰度
     * 过渡中返回新库路径（调用方按 [getBlendWeight] 混合新旧）
     */
    fun getActivePaths(): Pair<String, String> {
        val state = readState()
        if (state != null) {
            val nv = optString(state, "newVectorPath")
            val ni = optString(state, "newIndexPath")
            if (nv != null && ni != null && File(nv).exists() && File(ni).exists()) {
                return Pair(nv, ni)
            }
        }
        return Pair(
            File(ragDir, "vector-store.json").absolutePath,
            File(ragDir, "rag-index.json").absolutePath
        )
    }

    private fun readState(): JSONObject? = try {
        if (transitionFile.exists()) JSONObject(transitionFile.readText()) else null
    } catch (_: Throwable) { null }

    private fun readStartedAt(): Long? {
        val s = readState() ?: return null
        return if (s.has("startedAt")) s.optLong("startedAt", 0L).takeIf { it > 0 } else null
    }

    /** 安全读取字符串字段，缺失或 null 返回 null */
    private fun optString(o: JSONObject, key: String): String? {
        if (!o.has(key) || o.isNull(key)) return null
        val v = o.optString(key, "")
        return if (v.isEmpty()) null else v
    }

    companion object {
        const val TRANSITION_DAYS = 15
        private const val DAY_MS = 24L * 60 * 60 * 1000
    }
}
