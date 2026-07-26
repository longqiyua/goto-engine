# GOTO Engine 插件开发指南

> 本指南说明如何为 GOTO Engine 开发独立插件。插件通过 `plugin-api.js` 注册，可观察/重排搜索结果、注入上下文、订阅反馈事件，无需修改引擎源码。

## 1. 快速开始

### 1.1 加载顺序

```html
<!-- 1. 语义模块（可选） -->
<script src="GOTO-ENGINE/semantic/semantic-loader.js" onerror="window.__semanticLoadFailed=true"></script>

<!-- 2. 引擎运行时 -->
<script src="GOTO-ENGINE/goto-engine.js"></script>

<!-- 3. 稳定组件 API -->
<script src="GOTO-ENGINE/goto-engine-component.js"></script>

<!-- 4. 插件 API 宿主 -->
<script src="GOTO-ENGINE/plugin-api.js"></script>

<!-- 5. 反馈通道（可选） -->
<script src="GOTO-ENGINE/feedback.js"></script>

<!-- 6. 你的插件 -->
<script src="my-plugin.js"></script>
```

### 1.2 最小插件示例

```js
// my-plugin.js
GOTOPlugin.register(
  {
    id: 'demo-rerank',
    name: 'Demo Rerank',
    version: '1.0.0',
    author: 'you',
    description: '将微信置顶',
    permissions: ['search.read', 'search.rerank']
  },
  {
    afterSearch: function(ctx) {
      var env = ctx.envelope;
      if (!env.ok || !env.data) return;
      var items = env.data.items;
      var wxIdx = -1;
      for (var i = 0; i < items.length; i++) {
        if (items[i].name === '微信') { wxIdx = i; break; }
      }
      if (wxIdx > 0) {
        var wx = items.splice(wxIdx, 1)[0];
        items.unshift(wx);
        // 重新编号
        items.forEach(function(it, idx) { it.rank = idx + 1; });
      }
      return env;
    }
  }
);
```

注册后，所有通过 `GOTOPlugin.query()` 发起的搜索都会自动经过该插件。

## 2. 插件清单（Manifest）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 唯一标识，2-64 位字母数字与连字符 |
| `name` | string | 是 | 人类可读名称 |
| `version` | string | 是 | Semver 版本号 |
| `author` | string | 否 | 作者或组织 |
| `description` | string | 否 | 简短说明 |
| `permissions` | string[] | 是 | 申请的权限作用域 |

### 2.1 权限作用域

| 权限 | 说明 | 对应 Hook |
|---|---|---|
| `search.read` | 观察查询与结果 | `afterSearch` |
| `search.rerank` | 修改结果排序 | `afterSearch`（返回新 envelope） |
| `search.options` | 修改查询选项 | `beforeSearch` |
| `render.modify` | 修改渲染目标 | `beforeRender` |
| `context.write` | 注入单次查询上下文 | `beforeSearch`（修改 options.context） |
| `feedback.send` | 派发反馈事件 | 调用 `GOTOFeedback.send()` |
| `feedback.receive` | 订阅反馈事件 | `onFeedback` |
| `engine.maintain` | 触发维护例程 | 调用 `window._maintain()` 等 |

> 当前版本不强制校验权限，但未来版本会根据 manifest.permissions 限制 hook 注册。请如实声明。

## 3. Hook 详解

### 3.1 beforeSearch

```js
beforeSearch: function(ctx) {
  // ctx = { query: 'wx', options: { limit: 12, requestId: '...', context: {} } }
  // 返回值：可返回 Partial<QueryOptions> 来合并覆盖 options
  return { limit: 20 };  // 强制提升 limit
}
```

### 3.2 afterSearch

```js
afterSearch: function(ctx) {
  // ctx = { query: 'wx', envelope: { ok, data, ... } }
  // 返回值：可返回修改后的 envelope（必须保持 ok/apiVersion/data 契约）
  var env = ctx.envelope;
  if (env.ok && env.data) {
    env.data.items = env.data.items.filter(function(it) {
      return it.score > 50;  // 过滤低分结果
    });
    env.data.total = env.data.items.length;
  }
  return env;
}
```

### 3.3 beforeRender

```js
beforeRender: function(ctx) {
  // ctx = { target: '#output', envelope: {...} }
  // 返回值：可返回新的目标选择器字符串
  return '#my-plugin-output';
}
```

### 3.4 onFeedback

```js
onFeedback: function(feedback) {
  // feedback = { id, ts, type, scope, query, expected, actual, note, severity, meta }
  if (feedback.type === 'correction') {
    console.log('用户纠正：', feedback.expected, '≠', feedback.actual);
    // 自学习：根据纠正信号调整插件权重
  }
}
```

### 3.5 onError

```js
onError: function(errorInfo) {
  // errorInfo = { phase, error, ctx?, manifest?, query? }
  console.warn('[Plugin Error]', errorInfo.phase, errorInfo.error.message);
}
```

## 4. 反馈通道（feedback.js）

反馈通道用于插件之间、插件与宿主之间传递纠正信号、建议、错误报告。

### 4.1 发送反馈

```js
GOTOFeedback.send({
  type: 'correction',     // correction | suggestion | bug | quality | generic
  scope: 'search',        // search | render | context | plugin | engine
  query: 'wx',
  expected: '微信',
  actual: '微博',
  note: '用户点击了微信但微博排第一',
  severity: 'warn'        // info | warn | error
});
```

### 4.2 配置远端上报（可选）

```js
GOTOFeedback.configure({
  endpoint: 'https://your-collector.example.com/goto-feedback',
  flushIntervalMs: 30000,    // 30 秒批量上报
  anonymizeQuery: true,      // 哈希查询字符串
  includeUserAgent: false    // 不上报 UA
});
```

不配置 `endpoint` 时，反馈仅保存在本地 `localStorage`（键名 `goto_feedback_log`，最多 200 条）。

### 4.3 查询反馈日志

```js
GOTOFeedback.list({ type: 'correction' });  // 按字段过滤
GOTOFeedback.list();                          // 全部
GOTOFeedback.clear();                         // 清空本地日志
GOTOFeedback.status();                        // { buffered, pendingRemote, endpoint, localOnly }
```

## 5. 通过 Plugin API 查询

插件开发完成后，业务代码应通过 `GOTOPlugin.query()` 而非直接调用 `GOTOEngineComponent`，以确保插件 hook 生效：

```js
var env = GOTOPlugin.query('weix', { limit: 8 });
if (env.ok) {
  GOTOPlugin.render('#output', env, 'json');
}
```

## 6. 插件生命周期

| 阶段 | 行为 |
|---|---|
| 注册 | `GOTOPlugin.register(manifest, hooks)` — 立即生效 |
| 查询 | `beforeSearch` → 引擎执行 → `afterSearch` |
| 渲染 | `beforeRender` → 组件渲染 |
| 反馈 | `GOTOFeedback.send()` → `onFeedback` 派发到所有插件 |
| 卸载 | `GOTOPlugin.unregister(id)` — 移除所有 hook |

## 7. 最佳实践

1. **只扩展，不替换**：通过 hook 观察与重排，不要直接覆盖 `GOTOEngine.runSearchPipeline`。
2. **防御性编程**：所有 hook 内访问 `ctx.envelope.data` 前先检查 `ctx.envelope.ok`。
3. **保持契约**：`afterSearch` 返回的 envelope 必须保留 `ok`/`apiVersion`/`data`/`meta` 结构。
4. **避免阻塞**：hook 应同步快速返回；耗时操作放异步队列，不阻塞搜索主链。
5. **声明权限**：如实填写 manifest.permissions，未来版本会强制校验。
6. **测试**：注册后调用 `GOTOPlugin.status()` 与 `GOTOPlugin.query('test')` 验证集成。
7. **隐私优先**：使用 `GOTOFeedback.configure({ anonymizeQuery: true })` 哈希查询内容后再上报。

## 8. 调试

```js
// 查看已注册插件
console.log(GOTOPlugin.list());

// 查看宿主状态
console.log(GOTOPlugin.status());

// 模拟一次查询（触发所有 beforeSearch/afterSearch）
GOTOPlugin.query('wx', { limit: 5 });

// 模拟一次反馈派发
GOTOFeedback.send({ type: 'quality', scope: 'search', note: 'test' });
```

## 9. 与 EXTENSIONS.md 的关系

`EXTENSIONS.md` 描述的是**直接覆盖引擎方法**的扩展模式（适合深度定制，需要修改源码或绑定 `GOTOEngine.xxx`）。
本指南描述的是**通过插件 API 注册 hook**的扩展模式（适合第三方插件，不修改源码）。

两种模式可以共存：核心引擎方法被覆盖后，插件 hook 仍然在 `GOTOPlugin.query()` 路径上生效。

## 10. 文件清单

| 文件 | 作用 |
|---|---|
| `goto-engine.js` | 引擎运行时（搜索/索引/学习/统计） |
| `goto-engine-component.js` | 稳定组件 API（版本化 envelope） |
| `component-api.d.ts` | 组件 API 类型契约 |
| `interface.d.ts` | 引擎底层接口类型 |
| `plugin-api.js` | **插件 API 宿主**（本指南核心） |
| `plugin-api.d.ts` | 插件 API 类型契约 |
| `feedback.js` | 反馈通道（本地缓冲 + 可选远端上报） |
| `semantic/` | 可选语义联想模块 |
| `EXTENSIONS.md` | 直接覆盖式扩展指南 |
| `PLUGIN-GUIDE.md` | 本文件 |
