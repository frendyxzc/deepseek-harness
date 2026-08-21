# Agent Note: 飞书能力 seam —— 发送与接收聊天

Status: implemented

[English](2026-08-18-feishu-capability-seam.md) | 中文

## 问题

harness 无法触达飞书（Feishu/Lark）聊天：agent 既不能给用户或群组发消息，也不能接收用户发给 bot 的消息。两个方向共享同一个依赖面——飞书 App ID/Secret 与飞书开放平台 API——但面向模型的发送契约不能硬编码某一厂商的 HTTP 形状；接收路径则要把长连接事件变成一次 agent 轮次，同时不把接收传输耦合到 agent loop。

## 决策

飞书聊天是遵循[能力 seam Agent Note](../../implemented/architecture/2026-06-13-capability-seams.zh.md)的一等能力 seam，拆分为四个包：

1. `@deepseek-ai/dsh-feishu`（`packages/feishu/feishu`）拥有 `ctx.feishu`、提供方注册、执行期提供方选择、发送/接收词汇表以及 `FeishuError`。
2. `@deepseek-ai/dsh-feishu-bot`（`packages/feishu/feishu-bot`）是飞书开放平台 Bot 提供方——租户 token 鉴权、`sendMessage` 与长连接 `startReceiving`（[长连接 note](2026-08-18-feishu-long-connection-receive.zh.md)）。
3. `@deepseek-ai/dsh-tool-feishu`（`packages/feishu/tool-feishu`）拥有面向模型的 `feishu_send_message` 工具 schema（`receiveIdType`/`msgType` 用字符串字面量 enum）、提示引导与展示。
4. `@deepseek-ai/dsh-feishu-receive`（`packages/feishu/feishu-receive`）把每个飞书聊天路由进各自的 agent 会话（[按聊天路由 note](2026-08-19-feishu-per-chat-receive-routing.zh.md)）。

提供方向 `ctx.feishu` 注册；只有工具与接收消费方是面向模型或面向用户的。发送与接收是同一个 seam、用同一套选择策略：配置了 `provider` id（或等价的 `DSH_FEISHU_PROVIDER` 环境变量），或在恰好注册了一个可用提供方时自动选择；多个可用提供方且未配置 id 时是 `FEISHU_PROVIDER_AMBIGUOUS`，而非先到先得。

### 接收是 `startReceiving`，不是发布/订阅

`FeishuRuntime` 暴露 `startReceiving(handler): () => void`，负责解析提供方并调用其 `startReceiving(handler)`。seam 上不存在 `onReceive`/`dispatchReceive` 扇出，也没有 `receiveHandlers` 集合：当前唯一的消费方（`dsh-feishu-receive`）是唯一接收方，第二个消费方是未来的问题，发布/订阅注册表只能靠猜它的契约来解决。仅发送的提供方没有 `startReceiving`，seam 会抛 `FEISHU_RECEIVE_UNSUPPORTED`；`dsh-feishu-bot` 异步启动长连接客户端，启动失败通过 `status()` 与 logger 暴露，而非同步抛错。

### 入站投递把每个聊天路由到各自的 agent

`dsh-feishu-receive` 在 `ctx.effect` 内启动接收通道（其 disposer 会关闭长连接），并把每条 `FeishuReceiveEvent` 路由到一个专属的按聊天划分 agent（[按聊天路由 note](2026-08-19-feishu-per-chat-receive-routing.zh.md)）。提供方只提取内容解码后非空的文本消息；其他消息类型被忽略。

### 凭据每次操作解析一次

`dsh-feishu-bot` 每次操作解析一次 `appId`/`appSecret`：字面配置值优先，否则 `appIdEnv`/`appSecretEnv` 凭据引用经由凭据服务解析（回退到启动环境）。字面字段带 `.role('secret')`，环境引用带 `.role('credential-ref')`。租户 access token 被缓存并在到期时刷新，留 60 秒余量；错误码表明 token 失效时按需刷新被推迟（这是文档化的局限，而非提供方自身契约中的虚假声明）。

## 已考虑的替代方案

**拆成两个服务（`ctx.feishuSend` / `ctx.feishuReceive`）。** 发送与接收共享同一依赖（App ID/Secret）和同一套提供方选择策略；拆分会在牺牲任何当前消费方收益的情况下复制选择逻辑、错误分类与凭据面。

**由提供方注册各自的面向模型工具。** web seam 的教训在此适用：由提供方注册的 `feishu_send_message` 会让工具可用性取决于加载了哪个提供方包，且提供方专属字段会泄漏进模型契约。`dsh-tool-feishu` 是面向模型的名称、schema 与提示引导的唯一拥有者。

**在 seam 上做发布/订阅接收扇出。** 因是无主 surface 而被否定：只有一个消费方且它会消费每条事件，因此 `Set<handler>` 注册表加 `dispatchReceive` 只会增加状态与处置 surface，却没有第二个订阅者来证明其契约。

**在接收消费方里手搓用户消息。** `dsh-feishu-receive` 用 `createUserMessage({ content, source: { kind: 'user' } })` 构造消息，而不是手工拼 `MessageId`/`source` 对象，使消息形状归 `dsh-llm` 所有。

## 后果

- 飞书是可选能力：四个包通过常规组合挂载，均不属于 agent-loop 主干或出厂默认。
- 入站路由按聊天划分、而非单 agent：每个聊天各自有一个 agent 会话（[按聊天路由 note](2026-08-19-feishu-per-chat-receive-routing.zh.md)）；聊天内的发送者归属与跨重启恢复被推迟，记录在 `dsh-feishu-receive` 的 README 中。
- 卡片（`interactive`）消息已声明，但卡片 JSON 构造留给调用方；面向模型的工具不校验也不构造卡片 schema。
- 发送与接收由单元测试（seam 选择与注册表处置、提供方 token/发送/接收、工具 enum 校验与端到端发送、消费方投递）以及一个真实组合测试覆盖：后者通过 Loader 启动 seam、提供方与工具，并在 mock 的飞书 HTTP 边界上验证。