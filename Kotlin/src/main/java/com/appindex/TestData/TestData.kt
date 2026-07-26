package com.appindex.TestData

import java.io.Serializable

/**
 * 用户测试数据模块
 * 记录自适应刷新模块在测试阶段采集的用户输入节奏样本，
 * 包括打字速度、停顿间隔、输入模式偏好等数据；
 * 存储不同参数配置下的搜索响应延迟与用户体验评分；
 * 为自适应刷新算法的参数调优提供实验数据依据。
 */

/**
 * 输入样本点
 */
data class InputSample(
    val timestamp: Long,
    val char: String,
    val intervalMs: Long,
    val isBackspace: Boolean = false,
    val isError: Boolean = false
) : Serializable

/**
 * 单次响应延迟记录
 */
data class LatencyRecord(
    val query: String,
    val inputLength: Int,
    val submitTime: Long,
    val resultTime: Long,
    val latencyMs: Long,
    val paramSnapshot: AdaptiveRefreshSettings
) : Serializable

/**
 * 用户体验评分
 */
data class ExperienceScore(
    val score: Int,        // 1-5
    val comment: String?,
    val recordedAt: Long
) : Serializable

/**
 * 打字测试记录
 */
data class TypingTestRecord(
    val testId: String,
    val userId: String? = null,
    val startTime: Long,
    val endTime: Long,
    val inputText: String,
    val language: String,        // "zh" / "en"
    val charCount: Int,
    val wordCount: Int,
    val errors: Int,
    val inputSamples: List<InputSample> = emptyList(),
    val speedWpm: Double,
    val speedCpm: Double,
    val averageIntervalMs: Double,
    val variance: Double,
    val pMax: Double,
    val errorRate: Double
) : Serializable

/**
 * 自适应刷新参数配置快照
 */
data class AdaptiveRefreshSettings(
    val pMax: Double,
    val tAvg: Double,
    val sigma: Double,
    val e: Double,
    val t1: Double,
    val t2: Double,
    val adaptiveDelay: Double,
    val lastUpdateTime: Long
) : Serializable

/**
 * 测试会话
 */
data class TestSession(
    val sessionId: String,
    val userId: String? = null,
    val batchName: String? = null,
    val records: List<TypingTestRecord> = emptyList(),
    val latencyRecords: List<LatencyRecord> = emptyList(),
    val experienceScores: List<ExperienceScore> = emptyList(),
    val createdAt: Long,
    val updatedAt: Long,
    val notes: String? = null
) : Serializable

/**
 * 测试数据集
 */
data class TestDataSet(
    val version: Int = 1,
    val sessions: List<TestSession> = emptyList(),
    val exportFormat: String = "json",
    val retentionDays: Int = 30
) : Serializable
