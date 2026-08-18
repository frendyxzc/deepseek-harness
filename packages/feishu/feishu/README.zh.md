# @deepseek-ai/dsh-feishu

[English](README.md) | 中文

DeepSeek Harness 的飞书（Feishu/Lark）聊天能力 seam（`ctx.feishu`）。

## 用途

把 `FeishuRuntime` 服务注册为 `ctx.feishu` —— 每个 Cordis 上下文一个实例。它拥有提供方注册表、重复检测、执行期提供方选择以及 `FeishuError` 错误分类。

## 提供方选择

- 配置的 `provider` id 已注册且 `available()` → 使用该提供方。
- 配置的 id 未注册 → `FEISHU_PROVIDER_CONFIGURED_MISSING`。
- 配置的 id 已注册但不可用 → `FEISHU_PROVIDER_CONFIGURED_UNAVAILABLE`。
- 未配置 id，恰好注册了一个可用提供方 → 使用该提供方。
- 未配置 id，多个可用提供方 → `FEISHU_PROVIDER_AMBIGUOUS`。
- 未配置 id，没有可用提供方 → `FEISHU_PROVIDER_UNAVAILABLE`。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `provider` | `string` | — | 显式的提供方 id；当恰好注册了一个可用提供方时自动选择 |

## 扩展点

- `ctx.feishu.registerProvider(provider)` —— 注册一个 `FeishuProvider` 实现。返回 disposer。
- `ctx.feishu.sendMessage(request, signal?)` —— 通过选定提供方发送一条消息。
- `ctx.feishu.startReceiving(handler)` —— 启动选定提供方的接收通道；提供方会以每条 `FeishuReceiveEvent` 调用 `handler`。返回 disposer，对仅发送的提供方抛 `FEISHU_RECEIVE_UNSUPPORTED`。
- `ctx.feishu.describeStatus()` —— 为状态界面投影有效的连接状态（`FeishuRuntimeStatus`），套用相同的选择规则但不抛错；选择失败以 `state: 'error'` 与 `selectionError` 呈现。提供方可实现异步的 `status(): FeishuProviderStatus` 投影（脱敏 App ID、密钥布尔值、接收活跃度、最近失败）；未实现时由 `available()` 决定 `connected`/`unavailable`。

## 模型体验

间接地，通过 `@deepseek-ai/dsh-tool-feishu` 路由发送结果与提供方失败；本注册表自身不贡献任何提示或 schema。

#### KV Cache 影响

无直接失效；任何请求前缀变更由命名的消费方负责。

## 已知局限与推迟工作

- **卡片消息** —— 已声明 `interactive` msgType，但卡片 JSON 构造留给调用方；面向模型的工具尚不校验也不构造卡片 schema。