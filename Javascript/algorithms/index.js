'use strict';

/**
 * GOTO-Engine Algorithms — 统一入口
 *
 * Re-export 所有从 goto-base 迁移过来的算法模块。
 * 原 goto-base 路径已保留薄垫片（带 deprecation 警告）以保持向后兼容。
 *
 * 目录划分：
 *   - boost/         BoostCalculator
 *   - semantic/      SemanticSearch
 *   - learning/      学习算法 + PersonalLearning + QueryNormalizer
 *   - where-pattern/ Where Pattern + builders
 *   - usage-signal/  UsageSignal
 */

module.exports = {
  // boost
  BoostCalculator: require('./boost/BoostCalculator.js'),
  // semantic
  SemanticSearch: require('./semantic/SemanticSearch.js'),
  // learning
  learningAlgorithms: require('./learning/learning-algorithms.js'),
  learningTypes: require('./learning/learning-types.js'),
  personalRanker: require('./learning/personal-ranker.js'),
  queryNormalizer: require('./learning/query-normalizer.js'),
  personalLearning: require('./learning/personal-learning.js'),
  queryNormalizerWrapper: require('./learning/query-normalizer-wrapper.js'),
  // where-pattern
  wherePattern: require('./where-pattern/index.js'),
  wherePatternTypes: require('./where-pattern/where-pattern-types.js'),
  wherePatternLearning: require('./where-pattern/where-pattern-learning.js'),
  wherePatternStore: require('./where-pattern/where-pattern-store.js'),
  // usage-signal
  usageSignalProvider: require('./usage-signal/usage-signal-provider.js'),
  androidUsageSignalBridge: require('./usage-signal/android-usage-signal-bridge.js')
};
