package com.appindex.Rerank

import com.appindex.model.AppInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * RAG 重建算法纯函数 — 读应用清单 + base 个人层 snapshot → 生成向量库
 *
 * V2.1 架构扩展：月度 RAG 重建
 *
 * 设计：
 *   - object 单例，无状态，纯函数
 *   - [EmbedderPort] 由 app 层注入（base 小模型实现），Engine 不依赖具体模型
 *   - 向量维度 512（与现有公共 RAG 一致，bge-small-zh-v1.5）
 *   - 序列化方法 [serializeVectorStore] / [serializeRagIndex] 供 Worker 和 Facade 共用
 *
 * 三语言同步：JS/Rust 仅对齐算法纯函数（buildDocumentText / rebuild 逻辑）
 */
object RagRebuilder {

    /** 向量维度（与公共 RAG 一致） */
    const val DIMENSION = 512

    /**
     * Embedder 端口接口 — 由 app 层注入具体实现（base 小模型）
     */
    interface EmbedderPort {
        fun embed(text: String): FloatArray
    }

    /**
     * 为单个应用构建文档文本：appName + aliases(拼音) + 个人层 boost 信号
     *
     * 个人层 boost 信号：
     *   - heatmap 高频时段 top 应用
     *   - transition 高频目标应用
     *   - feedback 最近点击应用
     *   - affinity 偏好应用
     */
    fun buildDocumentText(app: AppInfo, snapshot: PersonalSnapshot): String {
        val sb = StringBuilder(128)
        sb.append(app.label)

        // 别名：拼音 + 首字母 + 逐字拼音
        if (app.pinyin.isNotEmpty()) sb.append(' ').append(app.pinyin)
        if (app.pinyinInitials.isNotEmpty()) sb.append(' ').append(app.pinyinInitials)
        for (p in app.pinyinArray) {
            if (p.isNotEmpty()) sb.append(' ').append(p)
        }

        // 个人层 boost 信号（若 snapshot 可用）
        if (!snapshot.degraded) {
            val pkg = app.packageName
            // heatmap 高频时段 top 应用
            val heatmapHit = snapshot.heatmap?.cells?.any { cell ->
                cell.topApps.any { it.packageName == pkg }
            } ?: false
            if (heatmapHit) sb.append(" 时段高频")

            // transition 高频目标应用
            val transitionHit = snapshot.transitionMatrix?.transitions?.values
                ?.any { edges -> edges.any { it.toPackage == pkg } } ?: false
            if (transitionHit) sb.append(" 跳转高频")

            // feedback 最近点击
            val feedbackHit = snapshot.recentFeedback.any { it.clickedPackage == pkg }
            if (feedbackHit) sb.append(" 最近点击")

            // affinity 偏好信号
            val aff = snapshot.affinities[pkg]
            if (aff != null && aff.currentWeight > 0.0) sb.append(" 偏好应用")
        }

        return sb.toString()
    }

    /**
     * 批量重建 RAG 向量库
     *
     * @param apps 应用清单
     * @param snapshot Base 个人层快照
     * @param embedder 嵌入器（app 层注入）
     * @return [RagBuildResult]（vectors + index）
     */
    fun rebuild(
        apps: List<AppInfo>,
        snapshot: PersonalSnapshot,
        embedder: EmbedderPort
    ): RagBuildResult {
        val vectors = ArrayList<RagVectorEntry>(apps.size)
        val byPackage = HashMap<String, Int>(apps.size)
        val byIntentTag = HashMap<String, MutableList<Int>>()
        val byCategory = HashMap<String, MutableList<Int>>()

        for ((idx, app) in apps.withIndex()) {
            val docText = buildDocumentText(app, snapshot)
            val vector = try {
                embedder.embed(docText)
            } catch (e: Throwable) {
                FloatArray(DIMENSION)
            }
            val intentTags = buildIntentTags(app, snapshot)
            val metadata = HashMap<String, Any>()
            metadata["packageName"] = app.packageName
            metadata["appName"] = app.label
            metadata["isSystemApp"] = app.isSystemApp

            vectors.add(
                RagVectorEntry(
                    id = idx,
                    packageName = app.packageName,
                    documentText = docText,
                    vector = vector,
                    intentTags = intentTags,
                    metadata = metadata
                )
            )
            byPackage[app.packageName] = idx
            for (tag in intentTags) {
                byIntentTag.getOrPut(tag) { ArrayList() }.add(idx)
            }
            // category：个人层无分类信息，按 system/user 简单归类
            val category = if (app.isSystemApp) "系统应用" else "用户应用"
            byCategory.getOrPut(category) { ArrayList() }.add(idx)
        }

        val index = RagIndex(
            byPackage = byPackage,
            byCategory = byCategory,
            byIntentTag = byIntentTag
        )
        return RagBuildResult(vectors = vectors, index = index)
    }

    /**
     * 序列化 vector-store JSON（与公共 RAG vector-store.json 结构对齐）
     */
    fun serializeVectorStore(result: RagBuildResult): String {
        val vectors = JSONArray()
        for (v in result.vectors) {
            val vecArr = JSONArray()
            for (f in v.vector) vecArr.put(f.toDouble())
            val meta = JSONObject()
            for ((k, value) in v.metadata) {
                when (value) {
                    is String -> meta.put(k, value)
                    is Boolean -> meta.put(k, value)
                    is Number -> meta.put(k, value)
                    else -> meta.put(k, value.toString())
                }
            }
            val tags = JSONArray()
            for (t in v.intentTags) tags.put(t)
            vectors.put(JSONObject().apply {
                put("id", v.id)
                put("packageName", v.packageName)
                put("documentText", v.documentText)
                put("vector", vecArr)
                put("intentTags", tags)
                put("metadata", meta)
            })
        }
        val root = JSONObject().apply {
            put("version", "1.0.0")
            put("embeddingModel", "bge-small-zh-v1.5")
            put("dimension", DIMENSION)
            put("vectorGenerator", "personal-rag-rebuilder")
            put("updatedAt", System.currentTimeMillis())
            put("vectors", vectors)
        }
        return root.toString()
    }

    /**
     * 序列化 rag-index JSON（与公共 RAG rag-index.json 结构对齐）
     */
    fun serializeRagIndex(result: RagBuildResult): String {
        val byPackage = JSONObject()
        for ((pkg, idx) in result.index.byPackage) {
            byPackage.put(pkg, JSONObject().apply { put("idx", idx) })
        }
        val byCategory = JSONObject()
        for ((cat, idxs) in result.index.byCategory) {
            val arr = JSONArray()
            for (i in idxs) arr.put(i)
            byCategory.put(cat, arr)
        }
        val byIntentTag = JSONObject()
        for ((tag, idxs) in result.index.byIntentTag) {
            val arr = JSONArray()
            for (i in idxs) arr.put(i)
            byIntentTag.put(tag, arr)
        }
        val root = JSONObject().apply {
            put("version", "1.0.0")
            put("dimension", DIMENSION)
            put("updatedAt", System.currentTimeMillis())
            put("totalVectors", result.vectors.size)
            put("byPackage", byPackage)
            put("byCategory", byCategory)
            put("byIntentTag", byIntentTag)
        }
        return root.toString()
    }

    /** 生成意图标签：基于个人层信号 */
    private fun buildIntentTags(app: AppInfo, snapshot: PersonalSnapshot): List<String> {
        val tags = ArrayList<String>()
        if (snapshot.degraded) return tags
        val pkg = app.packageName
        if (snapshot.heatmap?.cells?.any { it.topApps.any { a -> a.packageName == pkg } } == true) {
            tags.add("time_frequent")
        }
        if (snapshot.transitionMatrix?.transitions?.values
                ?.any { edges -> edges.any { it.toPackage == pkg } } == true) {
            tags.add("transition_target")
        }
        if (snapshot.recentFeedback.any { it.clickedPackage == pkg }) {
            tags.add("recent_click")
        }
        val aff = snapshot.affinities[pkg]
        if (aff != null && aff.currentWeight > 0.0) tags.add("preferred")
        return tags
    }
}

/** 单条 RAG 向量条目 */
data class RagVectorEntry(
    val id: Int,
    val packageName: String,
    val documentText: String,
    val vector: FloatArray,
    val intentTags: List<String>,
    val metadata: Map<String, Any>
) {
    // FloatArray 的 equals/hashCode 需手动处理（data class 默认按引用比较数组）
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is RagVectorEntry) return false
        return id == other.id &&
                packageName == other.packageName &&
                documentText == other.documentText &&
                intentTags == other.intentTags &&
                vector.contentEquals(other.vector) &&
                metadata == other.metadata
    }

    override fun hashCode(): Int {
        var r = id
        r = 31 * r + packageName.hashCode()
        r = 31 * r + documentText.hashCode()
        r = 31 * r + vector.contentHashCode()
        return r
    }
}

/** RAG 索引结构 */
data class RagIndex(
    val byPackage: Map<String, Int>,
    val byCategory: Map<String, List<Int>>,
    val byIntentTag: Map<String, List<Int>>
)

/** RAG 重建结果 */
data class RagBuildResult(
    val vectors: List<RagVectorEntry>,
    val index: RagIndex
)
