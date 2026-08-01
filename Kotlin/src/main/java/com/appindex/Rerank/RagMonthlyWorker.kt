package com.appindex.Rerank

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.appindex.AppRegistry.AppListStore
import java.util.concurrent.TimeUnit

/**
 * RAG 月度重建 Worker — 30 天周期触发向量库重建 + 灰度过渡。
 *
 * 对应 V2.1 定档的"月度自主重建"能力：读应用清单 + base 个人层（Worker 中
 * 降级为 [PersonalSnapshot.degraded]）→ 生成向量 → 启动灰度过渡。
 *
 * 调用签名与 [com.appindex.component.DefaultEngineFacade.rebuildRag] 完全对齐：
 *   - [RagRebuilder.rebuild] / [RagRebuilder.serializeVectorStore] /
 *     [RagRebuilder.serializeRagIndex] / [RagTransitionController.startTransition]
 *
 * 运行约束：充电 + 设备空闲 + 网络可用（通过 [schedule] 注册时设定）。
 */
class RagMonthlyWorker(
    context: Context,
    params: WorkerParameters
) : Worker(context, params) {

    override fun doWork(): Result {
        return try {
            // embedder 未注入时稍后重试（由 app 层通过 RagEmbedderHolder 注入）
            val embedder = RagEmbedderHolder.embedder
                ?: return Result.retry()

            // 读应用清单：优先内存快照，其次持久化文件（首次全量枚举）
            val store = AppListStore(applicationContext)
            var apps = store.snapshot()
            if (apps.isEmpty()) apps = store.load()

            // Worker 中无 base 桥接，使用降级快照
            val snapshot = PersonalSnapshot.degraded()

            val buildResult = RagRebuilder.rebuild(apps, snapshot, embedder)
            val vectorJson = RagRebuilder.serializeVectorStore(buildResult)
            val indexJson = RagRebuilder.serializeRagIndex(buildResult)
            RagTransitionController(applicationContext).startTransition(vectorJson, indexJson)

            Result.success()
        } catch (t: Throwable) {
            // 重建失败不重试，等待下一个周期触发
            Result.failure()
        }
    }

    companion object {
        /** 唯一周期任务名。 */
        const val WORK_NAME = "goto_rag_monthly_rebuild"

        /** 重建周期（天）。 */
        const val REBUILD_INTERVAL_DAYS = 30L

        /**
         * 注册月度重建周期任务：30 天周期 + 充电/空闲/网络约束。
         * 重复注册时保留已存在任务（[ExistingPeriodicWorkPolicy.KEEP]）。
         */
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiresCharging(true)         // 充电中
                .setRequiresDeviceIdle(true)       // 设备空闲
                .setRequiredNetworkType(NetworkType.CONNECTED)  // 网络可用
                .build()

            val request = PeriodicWorkRequestBuilder<RagMonthlyWorker>(
                REBUILD_INTERVAL_DAYS, TimeUnit.DAYS
            ).setConstraints(constraints).build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }
    }
}
