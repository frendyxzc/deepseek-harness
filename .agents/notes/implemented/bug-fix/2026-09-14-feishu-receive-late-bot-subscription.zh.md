# Agent Note: 接收通道打开后才新增的飞书 bot 收不到消息

Status: implemented

[English](2026-09-14-feishu-receive-late-bot-subscription.md) | 中文

## 问题

`dsh-feishu-receive` 只在第一个可用提供方注册时打开一次接收通道，并只保留一个合并后的 disposer。它的 `feishu/provider-added` 监听器在通道已打开时会直接提前返回（`if (!waitingForProvider) return`），因此之后注册的 bot——例如启动后通过设置界面的多 bot UI 新增的 bot（通过 `feishu-bot` 设置的 `onChange` 实时注册）——永远不会被订阅到接收通道。该 bot 的状态页仍然显示 `connected`，因为 `FeishuBotProvider.status()` 只检查凭据是否存在，而非是否已建立接收订阅，所以 bot 看起来是健康的，但用户发给它的每条消息都得不到回应。

## 决策

接收消费方改为按 provider id 为每个提供方各保留一个订阅，而不是一次性批量 `startReceivingAll`。`FeishuRuntime` 新增 `startReceivingProvider(provider, handler)`：它用 `startReceivingAll` 原本就应用的同一层 chat → provider 回复路由记录来包装 handler，并只订阅这一个提供方。`dsh-feishu-receive` 在加载时订阅所有已注册的提供方，每当 `feishu/provider-added` 触发时就添加新提供方——无论通道此前是否已有提供方——并在 `feishu/provider-removed` 时仅释放该提供方的订阅。可用却不能接收的提供方，在它是唯一候选时仍通过 added-listener 抛错而在注册期大声失败；在存在其他可接收提供方时则只是不被订阅，与 `startReceivingAll` 一致。

## 备选方案

**每次 `provider-added` 都重新调用 `startReceivingAll`。** 否决：每次调用都按提供方重新包装 handler，从而用新的 wrapper 重复订阅仍在接收的提供方——导致未变更 bot 的每条消息被重复投递——并且徒增它们的长连接抖动。

**文档化「新增 bot 后必须重启」。** 否决：设置界面向来实时新增 bot，重启要求会与实时新增这一交互表面自相矛盾，并把失败对运维者隐藏起来。

## 影响

- 启动后通过设置界面的多 bot UI 新增的 bot 现在能立即收到并回复消息，因为其接收订阅与 chat → provider 回复路由都在其注册提交的那一刻即已就位。
- 移除一个提供方不再关闭并重开所有通道：消费方只释放被移除提供方的订阅，因此其余 bot 的连接与在途投递不受影响。卡片动作消费方（`dsh-feishu-approval`）保持不变，仍等待提供方并在移除时重开，因为它只跟踪单一选定提供方的通道，沿用其与本文所述消费方共享的 [provider-lifecycle 事件](../architecture/2026-08-19-feishu-provider-lifecycle-events.zh.md)。

## 测试

`packages/feishu/feishu-receive/tests/feishu-receive.spec.ts` 新增一个回归测试：到达「通道打开后新增 bot」的消息仍会创建按聊天划分的 agent 并投递进去；同时更新生命周期测试以断言按提供方的行为：第二个提供方加入、被移除提供方的订阅被释放、只有发送能力的提供方在存在可接收提供方时被跳过。