# @deepseek-ai/dsh-feishu-receive

[English](README.md) | 中文

DeepSeek Harness 的飞书消息接收消费方。把收到的飞书 webhook 事件路由进活跃 agent 会话。

## 用途

启动 `ctx.feishu` 接收通道，并把每条收到的消息作为用户 follow-up 注入到第一个 root agent，使 agent 能接收并回复发给飞书 bot 的消息。

## 依赖

要求组合中存在 `ctx.feishu`（飞书 seam）、`ctx.agents`（agent 注册表）与 `ctx.webServer`（provider 注册 webhook 路由所用的 Web 服务器）。对 Web 服务器的依赖同时也约束了启动顺序：只有在 Web 服务器就绪后接收通道才会启动；缺少 Web 服务器的组合会在激活阶段失败，而不是静默地不接收消息。

## 模型体验

间接地，通过它注入到会话日志的用户消息体现。该消费方自身不注册任何提示或 schema 内容。

#### KV Cache 影响

无直接失效；注入的消息遵循会话日志的仅追加语义。

## 已知局限与推迟工作

- **单 agent 路由** —— 只有第一个 root agent 通过 `followup` 接收消息（投递会唤醒空闲 agent）。按聊天或发送者路由到特定 agent 被推迟。
- **无消息过滤** —— 所有收到的文本消息都会被注入；按 chat_id 或发送者过滤被推迟。