# GOTO Engine Kotlin 版 - ProGuard 规则
# 与 consumer-rules.pro 一致

-keep class com.appindex.component.** { *; }
-keep class com.appindex.model.** { *; }
-keep class com.appindex.BasicSearch.** { *; }
-keep class com.appindex.FuzzyMatch.** { *; }
-keep class com.appindex.AdaptiveRefresh.** { *; }
-keep class com.appindex.prediction.** { *; }
-keep class com.appindex.Database.** { *; }
