package com.appindex.Rerank

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.appindex.AppRegistry.AppListStore
import java.util.concurrent.TimeUnit

/**
 * 月度 RAG 重建 Worker — WorkManager PERIODIC 30 天调度
 *
 * V2.1 架构扩展：月度 RAG 重建
 *
 * doWork 逻辑：
 *   1. 读 [AppListStore].snapshot()（空则 load）
 *   2. 通过 [RagBridgeHolder] 注入的 EngineBaseBridge 读 base 个人层 snapshot
 *   3. 调 [RagRebuilder].rebuild()（embedder 由 app 层通过 [RagEmbedderHolder] 注入）
 *   4. [RagTransitionController].startTransition() 写新库并启动灰度过渡
 *   5. 返回 Result.success()
 *
 * 约束：充电 + 空闲 + 网络连接
 * workName = "goto-rag-monthly"
 */
class RagMonthlyWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        return try {
            val context = applicationContext

            // 1. 读应用清单
            val store = AppListStore(context)
            var apps = store.snapshot()
            if (apps.isEmpty()) apps = store.load()

            // 2. embedder 由 app 层注入；未注入则稍后重试
            val embedder = RagEmbedderHolder.embedder
                ?: return Result.retry()

            // 3. 读 base 个人层（通过 bridge holder，避免 Worker 直接依赖注入）
            val bridge = RagBridgeHolder.bridge
            val snapshot = if (bridge != null && !bridge.degraded) {
                bridge.getPersonalSnapshot(
                    query = "",
                    candidatePackages = apps.map { it.packageName },
                    runtimeContext = RuntimeContext()
                )
            } else {
                PersonalSnapshot.degraded()
            }

            // 4. 重建向量库
            val buildResult = RagRebuilder.rebuild(apps, snapshot, embedder)

            // 5. 序列化 + 启动灰度过渡
            val vectorStoreJson = RagRebuilder.serializeVectorStore(buildResult)
            val ragIndexJson = RagRebuilder.serializeRagIndex(buildResult)
            RagTransitionController(context).startTransition(vectorStoreJson, ragIndexJson)

            Result.success()
        } catch (e: Throwable) {
            // 异常 → 重试
            Result.retry()
        }
    }

    companion object {
        const val WORK_NAME = "goto-rag-monthly"
        private const val REPEAT_DAYS = 30L

        /**
         * 调度月度 RAG 重建（30 天周期，约束充电+空闲+网络）
         * 使用 KEEP 策略：已存在同名任务则保留旧任务
         */
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiresCharging(true)
                .setRequiresDeviceIdle(true)
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val request = PeriodicWorkRequestBuilder<RagMonthlyWorker>(
                REPEAT_DAYS, TimeUnit.DAYS
            )
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
            )
        }
    }
}

/**
 * Embedder 注入 holder — app 层在初始化时注入具体实现
 * Engine 模块不依赖具体模型，保持 library 独立性
 */
object RagEmbedderHolder {
    @Volatile
    var embedder: RagRebuilder.EmbedderPort? = null
}

/**
 * EngineBaseBridge 注入 holder — app 层注入（Worker 无构造器参数注入能力，用静态 holder）
 */
object RagBridgeHolder {
    @Volatile
    var bridge: EngineBaseBridge? = null
}
