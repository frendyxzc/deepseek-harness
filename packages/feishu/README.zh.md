---
description: "飞书会话包组：提供方中立的会话 seam、Bot API 提供方、按会话路由智能体、面向模型的会话工具、审批与提问卡片，以及状态投影。"
kind: "package-group"
---

# feishu/ — 飞书（Feishu）会话能力家族

[English](README.md) | 中文

## 概述

挂载这些包即可通过飞书（Feishu）会话使用 Harness：智能体读取并回复会话消息，人员在手机上批准受保护的工具调用并回答智能体的提问，Web 设置的 IM 标签页展示每个 bot 的连接状态。`feishu` 拥有本组其他包共同使用的提供方中立 seam；`feishu-bot` 是唯一随产品发布的提供方。其余包把会话路由进智能体会话、向模型暴露会话工具、结算审批与提问请求，并向浏览器客户端投影状态。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`feishu`](feishu/README.zh.md) | 提供方注册表、执行期提供方选择，以及共享的 `FeishuError` 错误码 |
| [`feishu-bot`](feishu-bot/README.zh.md) | Bot API 提供方：经由开放接口发送、读取与更新消息，并在单条长连接上接收会话消息与卡片点击 |
| [`feishu-receive`](feishu-receive/README.zh.md) | 为每个会话运行一个智能体会话，并投递其中的来话消息、被引用文本与图片 |
| [`tool-feishu`](tool-feishu/README.zh.md) | 向模型提供 `feishu_send_message` 与 `feishu_update_message`，并注册对应系统提示指引 |
| [`feishu-approval`](feishu-approval/README.zh.md) | 用所属会话中的允许/拒绝卡片结算会话智能体的审批请求 |
| [`feishu-question`](feishu-question/README.zh.md) | 用所属会话中的点选卡片回答智能体提问与计划评审 |
| [`feishu-status`](feishu-status/README.zh.md) | 通过两个 Remote 方法把 seam 的连接状态投影给浏览器客户端 |

<a id="related-documentation"></a>
## 相关文档

- [飞书子系统](../../docs/subsystems/feishu.zh.md) — seam 的请求与结果词汇、可用性规则及 `FeishuError` 错误码。
- [飞书能力 seam](../../.agents/notes/implemented/feature/2026-08-18-feishu-capability-seam.zh.md) — 会话操作为何收拢在单一提供方注册表之后。
- [长连接接收](../../.agents/notes/implemented/feature/2026-08-18-feishu-long-connection-receive.zh.md) — 无需公网回调 URL 即可接收入站事件。
- [按会话接收路由](../../.agents/notes/implemented/feature/2026-08-19-feishu-per-chat-receive-routing.zh.md) — 每个会话一个智能体会话，以及它换来的代价。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

只有 `feishu-bot` 直接调用飞书开放接口；本组其他包一律经由 `ctx.feishu` 访问会话。卡片应答方把按钮被点击时的 `value` 视为攻击者可控内容，只有在用自己的待决记录校验通过后才消耗一次性 nonce。

</details>
