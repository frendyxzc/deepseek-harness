# Agent Note: 飞书 IM 状态标签页

Status: implemented

[English](2026-08-18-feishu-im-status-tab.md) | 中文

## Problem

Web 设置页面无法呈现飞书集成的运行时状态。配置了飞书 bot provider 的部署无法显示连接是否活跃、正在使用哪个 App ID、或者消息接收是否在运行。排障需要直接阅读 Host 日志或检查 `cordis.yml`。

## Decision

**Seam 获得非抛错的状态投影。** `ctx.feishu.describeStatus()` 复用与运行时 provider 选择相同的规则（配置的 id → 恰好一个可用 → 错误），但返回 `FeishuRuntimeStatus` 判别联合而非抛错。现有选择错误消息逐字保留。Provider `status()` 是 `FeishuProvider` 上的可选方法；未实现它的 provider 仅从 `available()` 投影。

**专属 gateway 包将 seam 投影到 TypertRemote。** `@deepseek-ai/dsh-feishu-status` 拥有一个 `@Remote('status')` 方法，调用 `describeStatus()` 并将结果扁平化为 `FeishuStatusView`——在自身 `types.ts` 中定义的显式 wire 契约。标识值（App ID）在服务端脱敏；密钥归约为布尔值。gateway 不增加新能力，只是 seam 已知内容的只读投影。

**IM 标签页以 `settings.plugins.tab` 贡献注册。** `@deepseek-ai/dsh-client-ui-settings-im` 在 Plugins 分区注入一个 id `im`、order 20 的标签页。该标签页按需调用 `ctx.remote.feishuStatus.status()`——从不轮询——并呈现连接状态、provider id、脱敏 App ID、密钥配置状态、base URL、接收活跃度、以及任何最近错误或选择错误。locale 命名空间为 `settings.im`。

**Remote 在 remotes 装配中挂载。** `@deepseek-ai/dsh-api-remotes/client` 导入并挂载 `feishuStatusRemote`（与现有 `pluginInventoryRemote` 并列），并 re-export `FeishuStatusView`，使客户端包只引用一个装配。

## Alternatives considered

**通过转发事件的实时推送。** 否决：状态按需读取（标签页很少打开），对于每个会话只变化几次的状态而言，推送通道代价过高。标签页在每次渲染时重新读取。

**将状态归入 plugin-inventory。** 否决：inventory 列出 Cordis Loader 插件；IM 标签页呈现的是飞书能力的有效状态，是另一个界面。合并将使 inventory 承载能力特定的知识。

**扩展 `feishu-bot` 同时暴露 remote。** 否决：混淆了 provider 角色（建立连接）与 gateway 角色（投影状态以供观察）。分离遵循能力接缝模式：当 Service Definition / Provider / Consumer 角色独立演化时拆分。

**通用能力状态注册表。** 否决：当前没有第二个能力需要此功能，在第二个用例出现之前发明注册表是包规则所禁止的推测性选项。此处记录该模式（seam `describeStatus` → gateway → tab），待第二个界面出现时复用。

## Consequences

任何未来需要只读 Web 状态视图的能力遵循相同的三包形状：seam 扩展、gateway、客户端标签页。Gateway 的 wire 类型是边界；除非 `FeishuProviderStatus` 字段变更，provider 内部变更不会穿越它。

标签页在每次激活时读取一次，不订阅变更。长时间运行的会话中切换飞书 provider 后，状态保持陈旧直到标签页重新渲染（卸载 + 重新挂载）。未来的失效通道可在不改变 wire 契约的前提下修复此问题。

`feishu-status` gateway 以 peerDependency 依赖 `@deepseek-ai/dsh-feishu`；在未加载飞书 seam 的部署中挂载它将在插件加载时响亮失败，遵循误配置策略。
