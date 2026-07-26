package com.appindex.ConfigurationData

import java.io.Serializable

/**
 * 软件配置数据模块
 * 负责记录软件内用户配置情况，包含个性化设置、无障碍选项、
 * 快捷操作绑定、搜索参数偏好等所有用户自定义内容。
 */

/**
 * 配置命名空间
 * 采用分层键值结构，按功能模块划分命名空间。
 */
object ConfigNamespace {
    const val PERSONALIZATION = "personalization"
    const val ACCESSIBILITY = "accessibility"
    const val SHORTCUTS = "shortcuts"
    const val GESTURES = "gestures"
    const val SEARCH = "search"
    const val ADVANCED = "advanced"
}

/**
 * 通用配置项
 */
data class ConfigEntry(
    val key: String,
    val value: String,
    val valueType: ConfigValueType = ConfigValueType.STRING,
    val version: Int = 1,
    val modifiedAt: Long = System.currentTimeMillis()
) : Serializable

enum class ConfigValueType {
    STRING, BOOLEAN, INT, LONG, FLOAT, JSON
}

/**
 * 主题模式
 */
enum class ThemeMode {
    LIGHT,
    DARK,
    SYSTEM
}

/**
 * 键盘布局
 */
enum class KeyboardLayout {
    QWERTY,
    T9,
    COMPACT
}

/**
 * 个性化配置
 */
data class PersonalizationConfig(
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val accentColor: String = "#4A90D9",
    val backgroundColor: String? = null,
    val fontScale: Float = 1.0f,
    val cardOpacity: Float = 0.9f,
    val keyboardLayout: KeyboardLayout = KeyboardLayout.QWERTY,
    val animationEnabled: Boolean = true,
    val wallpaperUri: String? = null
) : Serializable

/**
 * 无障碍配置
 */
data class AccessibilityConfig(
    val silverHairMode: Boolean = false,
    val largeTextMode: Boolean = false,
    val highContrastMode: Boolean = false,
    val vibrationEnabled: Boolean = true,
    val voiceFeedbackEnabled: Boolean = false,
    val reduceMotion: Boolean = false
) : Serializable

/**
 * 快捷项
 */
data class ShortcutItem(
    val id: String,
    val keyword: String,
    val appId: String,
    val enabled: Boolean = true,
    val order: Int = 0
) : Serializable

/**
 * 手势项
 */
data class GestureItem(
    val id: String,
    val pattern: String,
    val actionType: String,
    val targetAppId: String? = null,
    val enabled: Boolean = true
) : Serializable

/**
 * 快捷操作配置
 */
data class QuickActionConfig(
    val shortcuts: List<ShortcutItem> = emptyList(),
    val gestures: List<GestureItem> = emptyList(),
    val floatingWindowEnabled: Boolean = false,
    val floatingPositionX: Int = 0,
    val floatingPositionY: Int = 200,
    val hotAppsEnabled: Boolean = true,
    val predictionBarEnabled: Boolean = true
) : Serializable

/**
 * 搜索配置
 */
data class SearchConfig(
    val fuzzyMatchEnabled: Boolean = true,
    val predictionEnabled: Boolean = true,
    val hotAppsEnabled: Boolean = true,
    val maxResults: Int = 50,
    val searchHistorySize: Int = 30,
    val defaultSearchMode: String = "SMART",
    val pinyinEnabled: Boolean = true,
    val t9Enabled: Boolean = true
) : Serializable

/**
 * 高级配置
 */
data class AdvancedConfig(
    val indexAutoRebuild: Boolean = true,
    val crashReportEnabled: Boolean = false,
    val debugMode: Boolean = false,
    val dataRetentionDays: Int = 90
) : Serializable

/**
 * 应用总配置
 */
data class AppConfiguration(
    val personalization: PersonalizationConfig = PersonalizationConfig(),
    val accessibility: AccessibilityConfig = AccessibilityConfig(),
    val quickActions: QuickActionConfig = QuickActionConfig(),
    val search: SearchConfig = SearchConfig(),
    val advanced: AdvancedConfig = AdvancedConfig(),
    val version: String = "1.0",
    val configVersion: Int = 1,
    val lastModified: Long = System.currentTimeMillis()
) : Serializable

/**
 * 配置变更事务
 */
data class ConfigTransaction(
    val entries: List<ConfigEntry>,
    val timestamp: Long = System.currentTimeMillis()
) : Serializable
