'use strict';

/**
 * GOTO Base Where Pattern Builder — 统一入口
 *
 * 导出所有 Pattern Builder 和数据类型。
 * Pattern Builder 从 Personal Layer 数据（QueryEvent / SelectionEvent / AppUsageAggregate）
 * 推导 Where 所需的 Pattern。
 *
 * 禁止事项：
 *   - 禁止接入 Android Usage Access
 *   - 禁止读取系统通知 / 位置 / 日历 / 联系人
 *   - 禁止接入云同步 / Embedding / RAG / LLM
 */

const { TimingPatternBuilder } = require('./timing-pattern-builder.js');
const { AppTransitionPatternBuilder } = require('./app-transition-pattern-builder.js');
const { GotoInternalPatternBuilder } = require('./goto-internal-pattern-builder.js');
const {
  APP_USAGE_AGGREGATE_SCHEMA_VERSION,
  createAppUsageAggregate
} = require('./app-usage-aggregate-types.js');

module.exports = {
  TimingPatternBuilder,
  AppTransitionPatternBuilder,
  GotoInternalPatternBuilder,
  APP_USAGE_AGGREGATE_SCHEMA_VERSION,
  createAppUsageAggregate
};
