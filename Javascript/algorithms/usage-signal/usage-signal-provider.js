'use strict';

/**
 * GOTO Base — UsageSignalProvider 接口定义
 *
 * Phase 3C：使用统计权限边界
 *
 * 目的：
 *   明确区分 GOTO 内部统计（无需系统权限）和全手机使用统计（需要 Usage Access）。
 *   本阶段只建立接口与数据边界，不申请真实 Usage Access。
 *
 * 数据所有权：
 *   - GOTO 内部统计 → Personal Base（直接保存）
 *   - 全手机使用统计 → 未来由 HOST 取得 Usage Access 后写入 Personal Base
 *
 * 禁止：
 *   - 在未获得用户授权前调用任何 UsageStatsManager API
 *   - 模拟为"已获得权限"
 *   - 用 Mock 数据冒充真实使用统计
 */

/**
 * AppUsageSignal — 单个应用的单次使用信号
 *
 * @typedef {object} AppUsageSignal
 * @property {string} packageName 应用包名
 * @property {number} foregroundMs 前台使用时长（毫秒）
 * @property {number} launchCount 启动次数
 * @property {number} lastUsedTimestamp 最后使用时间戳（ms since epoch）
 * @property {string} source 数据来源：'system_usage_stats' | 'goto_internal'
 * @property {number} sampledAt 采样时间戳
 */

/**
 * AppUsageAggregate — 单个应用的聚合统计
 *
 * @typedef {object} AppUsageAggregate
 * @property {string} packageName
 * @property {number} totalForegroundMs 总前台时长
 * @property {number} totalLaunchCount 总启动次数
 * @property {number} dailyAvgLaunches 日均启动次数
 * @property {number[]} hourlyDistribution 24 小时分布（每个小时的启动次数）
 * @property {number} appSwitchInCount 被切换进入次数
 * @property {number} appSwitchOutCount 被切换离开次数
 * @property {number} aggregatedAt 聚合时间戳
 * @property {string} source 数据来源
 */

/**
 * UsageSignalProvider — 使用信号提供者接口
 *
 * 实现方需要：
 *   1. 检测是否有系统权限（HOST 调用）
 *   2. 如无权限，返回空数组（不得伪造数据）
 *   3. 如有权限，返回真实 UsageStatsManager 数据
 *
 * 本阶段只提供接口定义和"无权限"的默认实现。
 */
class UsageSignalProvider {
  constructor() {
    this._permissionGranted = false;  // 本阶段永远为 false
  }

  /**
   * 检测是否已获得 Usage Access 权限。
   * 本阶段固定返回 false。
   *
   * @returns {Promise<boolean>}
   */
  async hasUsageAccessPermission() {
    return false;
  }

  /**
   * 请求 Usage Access 权限。
   * 本阶段不实现真实请求——由 HOST 在 Android 层处理。
   *
   * @returns {Promise<boolean>} 是否获得权限
   */
  async requestUsageAccessPermission() {
    // 本阶段：不申请权限，返回 false
    // 真实实现将在 Phase 4+ 由 HOST 通过 Android Intent 处理
    return false;
  }

  /**
   * 获取指定时间范围内的应用使用信号。
   * 本阶段（无权限）返回空数组。
   *
   * @param {number} startTimestamp 开始时间戳（ms since epoch）
   * @param {number} endTimestamp 结束时间戳
   * @returns {Promise<AppUsageSignal[]>}
   */
  async getUsageSignals(startTimestamp, endTimestamp) {
    if (!await this.hasUsageAccessPermission()) {
      return [];
    }
    // 真实实现将在获得权限后填充
    return [];
  }

  /**
   * 获取指定应用的聚合统计。
   * 本阶段（无权限）返回 null。
   *
   * @param {string} packageName
   * @returns {Promise<AppUsageAggregate|null>}
   */
  async getUsageAggregate(packageName) {
    if (!await this.hasUsageAccessPermission()) {
      return null;
    }
    return null;
  }

  /**
   * 获取所有已观测应用的包名列表。
   * 本阶段（无权限）返回空数组。
   *
   * @returns {Promise<string[]>}
   */
  async getObservedPackageNames() {
    if (!await this.hasUsageAccessPermission()) {
      return [];
    }
    return [];
  }

  /**
   * 获取权限状态（用于 UI 显示）。
   */
  getPermissionStatus() {
    return {
      granted: this._permissionGranted,
      source: 'host_android_usage_stats',
      canRequest: true,  // UI 可显示"申请权限"按钮
      description: '需要 Usage Access 权限以获取全手机应用使用统计'
    };
  }
}

/**
 * GotoInternalStatsProvider — GOTO 内部统计提供者
 *
 * 这些统计无需系统特殊权限，直接由 Personal Base 保存：
 *   - 搜索查询
 *   - 点击应用
 *   - GOTO 内启动应用
 *   - 查询耗时
 *   - 点击前后排名
 *
 * 这是已经实现的部分（PersonalLearning 已覆盖）。
 * 本接口仅作为类型契约存在，便于未来扩展。
 */
class GotoInternalStatsProvider {
  constructor(personalLearning) {
    this._pl = personalLearning;
  }

  /**
   * 获取内部统计（无需系统权限）。
   */
  async getInternalStats() {
    if (!this._pl) return null;
    try {
      return await this._pl.getStats();
    } catch (_) {
      return null;
    }
  }

  /**
   * 获取查询→应用亲和度（无需系统权限）。
   */
  async getQueryAffinity(normalizedQuery) {
    if (!this._pl) return [];
    try {
      return await this._pl.getAffinities(normalizedQuery);
    } catch (_) {
      return [];
    }
  }

  /**
   * 内部统计始终可用（不依赖系统权限）。
   */
  isAvailable() {
    return !!this._pl;
  }
}

module.exports = {
  UsageSignalProvider,
  GotoInternalStatsProvider
};
