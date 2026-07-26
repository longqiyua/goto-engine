# GOTO Engine Kotlin 版 - 消费者 ProGuard 规则
# 保持引擎核心类不被混淆（组件层 API 契约需要反射）

-keep class com.appindex.component.** { *; }
-keep class com.appindex.model.** { *; }
-keep class com.appindex.BasicSearch.** { *; }
-keep class com.appindex.FuzzyMatch.** { *; }
-keep class com.appindex.AdaptiveRefresh.** { *; }
-keep class com.appindex.prediction.** { *; }
-keep class com.appindex.Database.** { *; }

# Kotlin 协程相关
-keepclassmembers class kotlinx.coroutines.** { *; }
