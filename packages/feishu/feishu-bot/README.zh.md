# @deepseek-ai/dsh-feishu-bot

[English](README.md) | 中文

`ctx.feishu` 的飞书 Bot API 提供方。通过飞书开放平台发送并更新消息，并通过每个提供方各自的一条飞书官方长连接客户端接收消息与卡片按钮动作。用平铺凭据字段配置单个应用，或通过 `bots` 配置多个应用——每项注册自己的提供方，使人站群聊能路由回到接收它的应用。

## 用途

为每个已配置应用把一个 `FeishuBotProvider` 注册到 `ctx.feishu`（平铺单应用的 id 为 `feishu-bot`），各自使用自己的 provider id。通过飞书 `/auth/v3/tenant_access_token/internal` 端点鉴权，通过 `/im/v1/messages` 发送消息，通过 `PATCH /im/v1/messages/:message_id` 更新已发送的消息，通过 `GET /im/v1/messages/:message_id` 按 id 读取一条消息，并通过 `@larksuiteoapi/node-sdk` 接收 `im.message.receive_v1` 事件与 `card.action.trigger` 卡片回调。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `appId` | `string` | — | 字面飞书 App ID（优先于 `appIdEnv`） |
| `appSecret` | `string` | — | 字面飞书 App Secret（优先于 `appSecretEnv`） |
| `appIdEnv` | `string` | `FEISHU_APP_ID` | 每次操作解析的凭据引用 |
| `appSecretEnv` | `string` | `FEISHU_APP_SECRET` | 每次操作解析的凭据引用 |
| `baseURL` | `string` | `https://open.feishu.cn/open-apis` | 飞书开放平台 base URL |
| `bots` | `array` | — | bot 应用（设置可编辑）：每项 `{ id, appId?, teamId?, agentId? }` 以一个自己的 `id` 注册一个提供方；非空时取代平铺单应用 |
| `credentials` | `array` | — | 每个 bot 的秘密（仅组合期）：每项 `{ id, appSecret?, appSecretEnv?, appIdEnv?, baseURL? }` 提供 `bots` 项永不携带的秘密 |

## 多应用

当 `bots` 非空时，每项以一个自己的 `id` 成为一个提供方，平铺的 `appId` / `appSecret` 字段作为回退凭据。秘密刻意放在 `credentials`（仅组合期）而非 `bots`：设置 UI 读取 `bots` 但无法回传被脱敏的 `role('secret')` 值，分开存放意味着编辑 bot 的 `teamId` / `agentId` 绝不会覆盖其秘密。入站事件同时携带解析后的 `appId` 与提供方 `id`，飞书 seam 会把对某群聊的回复路由回接收它的那个提供方。

## 凭据

提供方每次操作按以下顺序解析每个凭据：
1. 来自配置的字面 `appId` / `appSecret`。
2. 通过 Harness 凭据服务解析的 `appIdEnv` / `appSecretEnv` 凭据引用，回退到启动环境。

租户 access token 被缓存并在到期时刷新，留 60 秒安全余量。

## 接收

`startReceiving(handler)` 与 `startReceivingCardActions(handler)` 共享同一个长连接客户端（`@larksuiteoapi/node-sdk`），主动连出飞书，无需公网回调 URL。第一个订阅者——无论是消息还是卡片动作——打开连接；最后一个 disposer 关闭连接，因此消息订阅者与卡片动作订阅者绝不会打开两条连接。`startReceiving` 分发每个 `im.message.receive_v1` 事件，把文本、富文本（`post`）与交互卡片（`interactive`）内容约简为纯文本，丢弃没有可读内容的消息（其他类型与空内容）。每条发出的 `FeishuReceiveEvent` 还会携带收到的 `messageId`，以及存在时的引用/回复 `parentId` 与话题根 `rootId`，以便消费方解析被引用的消息。`startReceivingCardActions` 把每个 `card.action.trigger` 回调分发为 `FeishuCardActionEvent`（operator open id、chat id、message id，以及被点击按钮的 `value` 载荷原样透传、不校验——由消费方对照自身可信状态校验）。启动是异步的：连接或凭据失败通过提供方 `status()` 的 error 状态与插件 logger 暴露。

## 读取被引用的消息

`getMessage(messageId, signal?)` 通过 `GET /im/v1/messages/:message_id` 按 id 拉取一条消息，并以 `FeishuMessage` 返回——内容提取为纯文本，存在时附带其 `parentId` / `rootId`。提取采用与 `startReceiving` 相同的 `text` / `post` / `interactive` 约简，因此被引用或回复的消息（包括富文本或卡片消息）与入站消息以相同方式读取。

## 更新已发送的消息

`updateMessage(messageId, content, signal?)` 替换本提供方早先发送的某条消息的内容——例如在按钮被消费后结算一张交互审批卡片——经由 `PATCH /im/v1/messages/:message_id`。`content` 采用与原始发送相同的编码（卡片则为卡片 JSON 字符串）。

## 模型体验

间接地，通过 `@deepseek-ai/dsh-tool-feishu`，后者经由 `ctx.feishu.sendMessage()` 调用提供方后端，并把结构化结果或错误呈现给模型。

#### KV Cache 影响

独立 —— 提供方配置变更不影响模型 KV cache。

## 已知局限与推迟工作

- **99991663/99991664 错误码的 token 刷新** —— 提供方仅在到期时刷新租户 access token；请求因 token 失效错误码失败时按需刷新被推迟。