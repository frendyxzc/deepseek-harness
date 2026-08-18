# Agent Note：飞书接收走官方长连接客户端

状态：已实现

[English](2026-08-18-feishu-long-connection-receive.md) | 中文

## 问题

webhook 接收需要一个飞书可达的回调 URL：飞书会把每个事件 POST 到一个公网 HTTPS 端点，而纯内网部署无法暴露这样的端点（也无法通过 URL 验证挑战证明对端点的所有权）。最初的 `dsh-feishu-bot` 在组合的 web server 上手工实现了那条 webhook 路由——URL 验证、请求体缓冲、事件提取——另外还有一条手工实现的 REST 发送路径。

## 决策

接收改用飞书官方 SDK（`@larksuiteoapi/node-sdk`）的长连接客户端。客户端主动连出飞书，因此无需公网回调 URL，内网部署即可工作。`dsh-feishu-bot.startReceiving(handler)` 构建一个 `WSClient` 和一个注册了 `im.message.receive_v1` 的 `EventDispatcher`，解析一次凭据，并返回一个关闭连接的 disposer。传输选择被移除：`receiveMode`、webhook 路由、`webhookPath` 与 `verificationToken` 配置都被删除，因此只有一种接收传输。

## 放弃的备选方案

**用 `receiveMode` 开关同时保留 webhook 与长连接。** 被拒：一个开关会让接收面和它的测试翻倍，而当前并没有这种需求；长连接客户端覆盖了 webhook 能覆盖的所有部署场景，还免去了回调 URL 的负担。

**发送也改用 SDK。** 推迟：手工实现的租户 token + `/im/v1/messages` 发送路径已经过验证与测试，而把发送迁移到 SDK 的高层客户端与接收传输是相互独立的。

## 后果

- `@larksuiteoapi/node-sdk` 成为 `dsh-feishu-bot` 的新增运行时依赖，且启动是异步的：连接或凭据失败通过提供方 `status()` 的 error 状态与插件 logger 暴露，而不是一次同步的 `startReceiving` 抛错。
- `dsh-feishu-receive` 去掉了 `webServer` 注入；接收通道不再等待 web server 之后才启动。
- `FeishuProviderStatus` 去掉了 `verificationTokenConfigured` 与 `webhookPath`；长连接状态通过 `receiveActive` 与 `lastError` 暴露。