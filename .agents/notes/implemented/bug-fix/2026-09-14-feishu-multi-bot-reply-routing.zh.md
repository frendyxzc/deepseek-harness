# Agent Note: 多 bot 部署下 p2p 回复走了错误的提供方

Status: implemented

[English](2026-09-14-feishu-multi-bot-reply-routing.md) | 中文

## 问题

回复通过 `FeishuRuntime.chatProvider`（一个 `chatId → providerId` 映射，在每条收到的事件上写入）路由回收下这条消息的应用。群聊回复的目标是 chat id，正好是映射的键，所以群聊回复路由正确。单聊（p2p）回复的目标是发送者的 `open_id`（`resolveReplyTarget`），但此前只记录了 chat id——`open_id` 查不到，落入提供方选择，在存在多个可用提供方时要么失败（`FEISHU_PROVIDER_AMBIGUOUS`），要么走错应用。

## 决策

`FeishuRuntime.subscribeProviderReceiving`——`startReceivingAll` 与 `startReceivingProvider` 共享的那个包装——把提供方记录到回复可能使用的每个 id 下：始终记录 `chatId`，并且当 `chatType === 'p2p'` 时额外记录 `senderId`。`routeProvider` 保持既有的 `request.providerId ?? chatProvider.get(request.receiveId)` 查找，现在能解析 p2p 回复，因为发送者 id 已按正确的键记录。

## 备选方案

**在每次发送时显式传递 provider id。** 否决：面向模型的 `feishu_send_message` 工具不暴露 provider id，且 `feishu-receive` 自己的确认回复仍需要该映射；双重键控把路由留在服务端，对模型不可见。

**改为按 agent session 键控路由映射。** 否决：session 已经为 LLM 身份携带 bot 绑定（`bindSession`），但路由回复需要模型给出的 receive-id 查找，因此映射必须仍以回复目标为键。

## 影响

- 多 bot 部署下，由某个 bot 收到的 p2p 消息现在会经该 bot 回复，与群聊路径一致。
- 两个 bot 共享同一个聊天仍然存在天然歧义：最后收到消息的 bot 拥有 `chatId` 键，因此同在一个群的两个 bot 仍可能交叉路由。这是有意为之——一个聊天就是一个对话，把一个聊天里的两个 bot 分开不在范围内。

## 测试

`packages/feishu/feishu/tests/feishu.spec.ts` 新增 `routes a one-on-one (p2p) reply back through the provider that received it`：接收一条 p2p 事件（sender `ou_1`、chat `oc_1`），断言 open_id 回复经接收到它的提供方解析，而不是另一个已注册的提供方。