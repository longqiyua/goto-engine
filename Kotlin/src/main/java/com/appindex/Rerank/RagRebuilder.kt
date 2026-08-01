package com.appindex.Rerank

import com.appindex.model.AppInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * RAG 向量库重建器
 *
 * 读取应用清单 + Base 个人层快照 → 生成向量 → 构建索引。
 * 产出可序列化为 JSON 的 [BuildResult]，由 [RagTransitionController] 灰度上线。
 *
 * 对应 JS 版 `algorithms/rag/rag-rebuilder.js`。
 */
object RagRebuilder {

    /** 向量维度（BGE-small-zh-v1.5） */
    const val DIMENSION = 512

    /**
     * 向量条目：一个应用对应一条
     *
     * @param packageName  应用包名
     * @param documentText 文档文本（应用名+拼音+包名等拼接）
     * @param vector       嵌入向量（L2 归一化）
     */
    data class RagVectorEntry(
        val packageName: String,
        val documentText: String,
        val vector: FloatArray
    )

    /**
     * 索引条目
     *
     * @param idx 向量在 vectors 数组中的下标
     */
    data class IndexEntry(val idx: Int)

    /**
     * RAG 索引
     *
     * @param byPackage   包名 → 索引条目（O(1) 查找）
     * @param byIntentTag 意图标签 → 向量下标列表（语义召回）
     */
    data class RagIndex(
        val byPackage: Map<String, IndexEntry>,
        val byIntentTag: Map<String, List<Int>>
    )

    /**
     * 重建结果
     *
     * @param vectors 向量列表
     * @param index   RAG 索引
     */
    data class BuildResult(
        val vectors: List<RagVectorEntry>,
        val index: RagIndex
    )

    /**
     * 重建 RAG 向量库。
     *
     * @param apps     应用清单
     * @param snapshot 个人层快照（用于文档文本增强）
     * @param embedder 嵌入向量端口
     * @return 构建结果
     */
    fun rebuild(apps: List<AppInfo>, snapshot: PersonalSnapshot, embedder: EmbedderPort): BuildResult {
        val vectors = ArrayList<RagVectorEntry>(apps.size)
        val byPackage = HashMap<String, IndexEntry>()

        for ((idx, app) in apps.withIndex()) {
            val doc = buildDocumentText(app, snapshot)
            val vec = embedder.embed(doc)
            vectors.add(RagVectorEntry(app.packageName, doc, vec))
            byPackage[app.packageName] = IndexEntry(idx)
        }

        val byIntentTag = buildIntentTagIndex(apps, snapshot)
        val index = RagIndex(byPackage, byIntentTag)

        return BuildResult(vectors, index)
    }

    /**
     * 序列化向量库为 JSON 字符串。
     * 输出格式与 `vector-store.json` 对齐。
     */
    fun serializeVectorStore(result: BuildResult): String {
        val json = JSONObject()
        json.put("version", "1.0.0")
        json.put("dimension", DIMENSION)
        json.put("vectorGenerator", "kotlin-rag-rebuilder")

        val vectorsArray = JSONArray()
        for (entry in result.vectors) {
            val v = JSONObject()
            v.put("packageName", entry.packageName)
            v.put("documentText", entry.documentText)
            val vecArray = JSONArray()
            for (f in entry.vector) {
                vecArray.put(f.toDouble())
            }
            v.put("vector", vecArray)
            vectorsArray.put(v)
        }
        json.put("vectors", vectorsArray)

        return json.toString()
    }

    /**
     * 序列化 RAG 索引为 JSON 字符串。
     * 输出格式与 `rag-index.json` 对齐。
     */
    fun serializeRagIndex(result: BuildResult): String {
        val json = JSONObject()
        json.put("version", "1.0.0")
        json.put("dimension", DIMENSION)
        json.put("totalVectors", result.vectors.size)

        val byPackage = JSONObject()
        for ((pkg, entry) in result.index.byPackage) {
            byPackage.put(pkg, JSONObject().put("idx", entry.idx))
        }
        json.put("byPackage", byPackage)

        val byIntentTag = JSONObject()
        for ((tag, indices) in result.index.byIntentTag) {
            val arr = JSONArray()
            for (i in indices) {
                arr.put(i)
            }
            byIntentTag.put(tag, arr)
        }
        json.put("byIntentTag", byIntentTag)

        return json.toString()
    }

    // ============================================================
    // 内部工具
    // ============================================================

    /**
     * 构建应用文档文本：拼接应用名、拼音、首字母、包名等。
     * 个人层快照中的 affinities 可用于增强文档（如追加高频关联词）。
     */
    private fun buildDocumentText(app: AppInfo, snapshot: PersonalSnapshot): String {
        val parts = mutableListOf(
            app.label,
            app.pinyin,
            app.pinyinInitials,
            app.packageName
        )
        // 逐字拼音分词
        parts.addAll(app.pinyinArray)
        return parts.filter { it.isNotEmpty() }.joinToString(" ")
    }

    /**
     * 构建意图标签索引：以应用名和拼音首字母作为意图标签。
     * 实际生产中意图标签来自 seed 文件的 intentTags 字段，
     * 此处基于 AppInfo 可用字段做合理近似。
     */
    private fun buildIntentTagIndex(
        apps: List<AppInfo>,
        @Suppress("UNUSED_PARAMETER") snapshot: PersonalSnapshot
    ): Map<String, List<Int>> {
        val byIntentTag = HashMap<String, MutableList<Int>>()
        for ((idx, app) in apps.withIndex()) {
            // 应用名作为意图标签（支持按名召回）
            if (app.label.isNotEmpty()) {
                byIntentTag.getOrPut(app.label) { mutableListOf() }.add(idx)
            }
            // 拼音首字母作为意图标签（支持拼音召回）
            if (app.pinyinInitials.isNotEmpty()) {
                byIntentTag.getOrPut(app.pinyinInitials) { mutableListOf() }.add(idx)
            }
        }
        return byIntentTag
    }
}
