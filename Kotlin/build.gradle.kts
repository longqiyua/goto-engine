// GOTO Engine Kotlin 版 - 项目级 build.gradle.kts
// 单模块 Android Library 项目

plugins {
    id("com.android.library") version "8.2.0" apply false
    id("org.jetbrains.kotlin.android") version "1.9.20" apply false
}

tasks.register("clean", Delete::class) {
    delete(rootProject.layout.buildDirectory)
}
