# @deepseek-ai/dsh-feishu-bot

[English](README.md) | 中文

`ctx.feishu` 的飞书 Bot API 提供方。通过飞书开放平台发送并更新消息，并通过同一条飞书官方长连接客户端接收消息与卡片按钮动作。

## 用途

把 `FeishuBotProvider` 以 id `feishu-bot` 注册到 `ctx.feishu`。通过飞书 `/auth/v3/tenant_access_token/internal` 端点鉴权，通过 `/im/v1/messages` 发送消息，通过 `PATCH /im/v1/messages/:message_id` 更新已发送的消息，并通过 `@larksuiteoapi/node-sdk` 接收 `im.message.receive_v1` 事件与 `card.action.trigger` 卡片回调。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `appId` | `string` | — | 字面飞书 App ID（优先于 `appIdEnv`） |
| `appSecret` | `string` | — | 字面飞书 App Secret（优先于 `appSecretEnv`） |
| `appIdEnv` | `string` | `FEISHU_APP_ID` | 每次操作解析的凭据引用 |
| `appSecretEnv` | `string` | `FEISHU_APP_SECRET` | 每次操作解析的凭据引用 |
| `baseURL` | `string` | `https://open.feishu.cn/open-apis` | 飞书开放平台 base URL |

## 凭据

提供方每次操作按以下顺序解析每个凭据：
1. 来自配置的字面 `appId` / `appSecret`。
2. 通过 Harness 凭据服务解析的 `appIdEnv` / `appSecretEnv` 凭据引用，回退到启动环境。

租户 access token 被缓存并在到期时刷新，留 60 秒安全余量。

## 接收

`startReceiving(handler)` 与 `startReceivingCardActions(handler)` 共享同一个长连接客户端（`@larksuiteoapi/node-sdk`），主动连出飞书，无需公网回调 URL。第一个订阅者——无论是消息还是卡片动作——打开连接；最后一个 disposer 关闭连接，因此消息订阅者与卡片动作订阅者绝不会打开两条连接。`startReceiving` 分发每个 `im.message.receive_v1` 事件，只提取内容解码后非空的文本消息，忽略其他类型与空内容。`startReceivingCardActions` 把每个 `card.action.trigger` 回调分发为 `FeishuCardActionEvent`（operator open id、chat id、message id，以及被点击按钮的 `value` 载荷原样透传、不校验——由消费方对照自身可信状态校验）。启动是异步的：连接或凭据失败通过提供方 `status()` 的 error 状态与插件 logger 暴露。

## 更新已发送的消息

`updateMessage(messageId, content, signal?)` 替换本提供方早先发送的某条消息的内容——例如在按钮被消费后结算一张交互审批卡片——经由 `PATCH /im/v1/messages/:message_id`。`content` 采用与原始发送相同的编码（卡片则为卡片 JSON 字符串）。

## 模型体验

间接地，通过 `@deepseek-ai/dsh-tool-feishu`，后者经由 `ctx.feishu.sendMessage()` 调用提供方后端，并把结构化结果或错误呈现给模型。

#### KV Cache 影响

独立 —— 提供方配置变更不影响模型 KV cache。

## 已知局限与推迟工作

- **99991663/99991664 错误码的 token 刷新** —— 提供方仅在到期时刷新租户 access token；请求因 token 失效错误码失败时按需刷新被推迟。