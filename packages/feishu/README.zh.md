# feishu/ — 飞书聊天能力家族

[English](README.md) | 中文

本家族提供与厂商无关的飞书（Feishu/Lark）聊天操作，以及消费这些操作的面向模型工具。

| 包 | 角色 | ctx key |
|---|---|---|
| [`feishu/`](feishu/README.md) | 定义飞书提供方注册、选择与共享错误 | `ctx.feishu` |
| [`feishu-bot/`](feishu-bot/README.md) | 提供飞书 Bot API 消息发送与 webhook 接收 | 注册到 `ctx.feishu` |
| [`tool-feishu/`](tool-feishu/README.md) | 向模型暴露 `feishu_send_message` | 注册到 `ctx.tools` |
| [`feishu-receive/`](feishu-receive/README.md) | 把收到的飞书消息路由到活跃 agent 会话 | 注册到 `ctx.feishu` |
| [`feishu-approval/`](feishu-approval/README.md) | 用交互式 Allow/Deny 卡片应答飞书聊天 agent 的审批请求 | 监听 `ctx.feishu` · `ctx.approval` |

子系统参考——发送消息的请求/结果词汇表、可用性、`FeishuError`——见 [docs/subsystems/feishu.md](../../docs/subsystems/feishu.md)。