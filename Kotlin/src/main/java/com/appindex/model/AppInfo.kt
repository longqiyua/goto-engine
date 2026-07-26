package com.appindex.model

import android.graphics.drawable.Drawable

/**
 * 应用信息数据模型
 */
data class AppInfo(
    val packageName: String,
    val label: String,
    val pinyin: String,              // 完整拼音拼接 (如 "weixin")
    val pinyinInitials: String,      // 拼音首字母 (如 "wx")
    val pinyinArray: List<String>,   // 逐字拼音数组 (如 ["wei","xin"])，用于纯拼音分词匹配
    val labelLower: String = label.lowercase(), // 预计算小写，避免重复调用
    val icon: Drawable? = null,
    val isSystemApp: Boolean = false
)
