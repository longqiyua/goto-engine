package com.appindex.Rerank

/**
 * 嵌入向量端口接口
 *
 * 由 app 层注入具体实现（如 BGE-small-zh ONNX 推理），
 * 供 [RagRebuilder] 在重建向量库时调用。
 *
 * 对应 JS 版 `bge-embedder.js` 的 embed 函数。
 */
interface EmbedderPort {
    /**
     * 将文本嵌入为向量。
     *
     * @param text 待嵌入的文本（应用名/拼音/包名等拼接的文档）
     * @return 浮点向量，长度应为 [RagRebuilder.DIMENSION]（512）
     */
    fun embed(text: String): FloatArray
}

/**
 * RAG 嵌入器全局持有者
 *
 * app 层在 BGE 模型加载完成后注入：
 * ```
 * RagEmbedderHolder.embedder = bgeEmbedder
 * ```
 *
 * 使用 @Volatile 保证多线程可见性。
 * [DefaultEngineFacade.rebuildRag] 通过此持有者获取 embedder，
 * 未注入时返回 false（跳过 RAG 重建）。
 */
object RagEmbedderHolder {
    @Volatile
    var embedder: EmbedderPort? = null
}
