// GOTO Engine Kotlin 版 - 项目级 build.gradle.kts
// 独立构建时：本文件作为项目根，声明插件版本，加载 :app 子模块。
// 作为 GOTO 应用子模块时：GOTO/settings.gradle.kts 直接指向 app/ 子目录，
//   本文件不会被加载（避免 plugins version 与宿主项目冲突）。

plugins {
    id("com.android.library") version "8.2.0" apply false
    id("org.jetbrains.kotlin.android") version "1.9.20" apply false
}

tasks.register("clean", Delete::class) {
    delete(rootProject.layout.buildDirectory)
}
