'use strict';

/**
 * GOTO Base Where Pattern Builder — AppUsageAggregate 数据模型（Fixture-only）
 *
 * 此模块定义 Pattern Builder 的输入数据模型 AppUsageAggregate。
 *
 * 重要：本阶段禁止接入 Android Usage Access，AppUsageAggregate 只能来源于：
 *   1. 测试 Fixture
 *   2. 用户主动导入
 *   3. 未来 Android 集成层（由 HOST 注入）
 *
 * Pattern Builder 不读取任何系统 API；它只接受 AppUsageAggregate 数组作为输入，
 * 推导出 TimingPattern / AppTransitionPattern 并写入 Base。
 */

const APP_USAGE_AGGREGATE_SCHEMA_VERSION = '1.0.0';

/**
 * 创建 AppUsageAggregate。
 * @param {object} init
 *   - {string} packageName 应用包名
 *   - {string} [sessionId] 会话 ID
 *   - {string} startedAt 会话开始时间（ISO 8601）
 *   - {string} endedAt 会话结束时间（ISO 8601）
 *   - {number} durationMs 总使用时长（毫秒）
 *   - {string} [previousPackageName] 上一个前台应用（用于转移模式）
 *   - {number} [transitionDelayMs] 从 previousPackageName 切换到 packageName 的延时
 *   - {object} [metadata]
 */
function createAppUsageAggregate(init) {
  init = init || {};
  return {
    packageName: init.packageName || '',
    sessionId: init.sessionId || '',
    startedAt: init.startedAt || '',
    endedAt: init.endedAt || '',
    durationMs: typeof init.durationMs === 'number' ? init.durationMs : 0,
    previousPackageName: init.previousPackageName || undefined,
    transitionDelayMs: typeof init.transitionDelayMs === 'number' ? init.transitionDelayMs : undefined,
    metadata: init.metadata || undefined,
    schemaVersion: init.schemaVersion || APP_USAGE_AGGREGATE_SCHEMA_VERSION
  };
}

module.exports = {
  APP_USAGE_AGGREGATE_SCHEMA_VERSION,
  createAppUsageAggregate
};
