// GOTO Engine Kotlin 版 - 模块级 build.gradle.kts
// 作为 Android Library 模块构建（源码位于项目根的 src/main/java）

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.appindex.engine"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets {
        getByName("main") {
            // 源码位于项目根的 src/main/java（与 com/appindex/... 包结构对应）
            java.srcDirs("../src/main/java")
            manifest.srcFile("src/main/AndroidManifest.xml")
        }
        getByName("test") {
            java.srcDirs("../src/test/java")
        }
    }
}

dependencies {
    // Kotlin 协程（AppSearchEngine / FuzzyMatchEngine 并行匹配）
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // AndroidX 基础（仅 Context / PackageManager，无 UI 依赖）
    implementation("androidx.core:core-ktx:1.12.0")

    // JSON 处理（用于 JsonCodec.kt）
    implementation("org.json:json:20231013")

    // V2.1: WorkManager（RagMonthlyWorker 月度 RAG 重建调度）
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // 测试
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")
    testImplementation("org.robolectric:robolectric:4.11.1")
    testImplementation("androidx.test:core:1.5.0")
}
