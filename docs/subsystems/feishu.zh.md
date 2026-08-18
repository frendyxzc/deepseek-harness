# 飞书聊天

[English](feishu.md) | 中文

飞书（Feishu/Lark）聊天能力 seam——一个同时跨越**发送与接收**、共用同一个 `ctx.feishu` 服务的[能力 seam](../../.agents/notes/implemented/feature/2026-08-18-feishu-capability-seam.md)，拆分为多个包：服务定义（[dsh-feishu](../../packages/feishu/feishu)，`ctx.feishu` + 提供方注册表）、服务提供方（[dsh-feishu-bot](../../packages/feishu/feishu-bot)，飞书开放平台 Bot 提供方）以及消费方（[dsh-tool-feishu](../../packages/feishu/tool-feishu)，`feishu_send_message` 工具；[dsh-feishu-receive](../../packages/feishu/feishu-receive)，按聊天路由的接收消费方；[dsh-feishu-approval](../../packages/feishu/feishu-approval)，审批卡片应答器）。飞书是**一个可选能力**，不属于 agent-loop 主干——因此其词汇表在这里，而非 [core.md](core.md)。更换提供方不会改变模型请求发送消息的方式。

来源：[`packages/feishu/feishu/src/types.ts`](../../packages/feishu/feishu/src/types.ts)

## 发送请求与结果

面向模型的工具参数是接收方 id 加文本内容。`receiveIdType` 与 `msgType` 由提供方给定默认值（`open_id`、`text`）；工具用字符串字面量 enum 约束两者，使模型无法凭空造值。

```ts type-equiv
/**
 * Target of a send-message operation. The provider resolves the concrete Feishu
 * recipient type (open_id, user_id, chat_id, etc.) from the target kind.
 */
interface FeishuSendRequest {
  /** The target recipient id. */
  readonly receiveId: string
  /** The recipient id type; defaults to `open_id` when omitted. */
  readonly receiveIdType?: FeishuReceiveIdType
  /** Message content as a plain text string. */
  readonly content: string
  /**
   * Message type. Card (`interactive`) content must be a JSON string per the
   * Feishu card schema; defaults to `text` when omitted.
   */
  readonly msgType?: FeishuMsgType
}
```

```ts type-equiv
/** Outcome of a successful send-message operation. */
interface FeishuSendResult {
  /** The Feishu-assigned message id. */
  readonly messageId: string
}
```

## 接收事件

收到的飞书事件，经官方长连接客户端（[`@larksuiteoapi/node-sdk`](../../packages/feishu/feishu-bot)）投递，在到达接收处理器之前，会被归一化为同一种事件形状。客户端主动连出飞书，因此无需公网回调 URL。提供方只提取内容解码后非空的文本消息；其他消息类型会被忽略。

```ts type-equiv
/** One message received from Feishu. */
interface FeishuReceiveEvent {
  /** The event type (e.g. `im.message.receive_v1`). */
  readonly eventType: string
  /** The sender's id. */
  readonly senderId: string
  /** The sender id type. */
  readonly senderIdType: FeishuReceiveIdType
  /** The chat or user id where the message was received. */
  readonly chatId: string
  /** The message content as plain text (extracted from the event body). */
  readonly content: string
  /** The raw event payload for provider-specific handling. */
  readonly raw: unknown
}
```

## 卡片动作事件

操作者点击交互卡片按钮的动作，经与消息相同的长连接通道投递（绝不另开第二条连接），在到达卡片动作处理器之前被归一化为同一种形状。`value` 载荷是攻击者可控的卡片数据：消费方在据此行动之前，必须对照自身可信状态（例如构建卡片时铸造的 nonce）校验它。

```ts type-equiv
/**
 * One card button action received from Feishu — an operator tapped a button on
 * an interactive card message delivered over the same channel as messages.
 */
interface FeishuCardActionEvent {
  /** The open id of the operator who tapped the button. */
  readonly operatorId: string
  /** The chat the card message lives in. */
  readonly chatId: string
  /** The message id of the tapped card message. */
  readonly messageId: string
  /**
   * The tapped button's value payload. Attacker-controllable card data:
   * consumers must validate it against trusted state (e.g. a nonce they
   * minted when the card was built) before acting on it.
   */
  readonly value: unknown
  /** The raw event payload for provider-specific handling. */
  readonly raw: unknown
}
```

## 更新已发送的消息

`updateMessage(messageId, content, signal?)` 替换早先通过选定提供方发送的某条消息的内容——例如在按钮被消费后结算一张交互审批卡片。`content` 采用与原始发送相同的编码（卡片则为卡片 JSON 字符串）。不支持更新的提供方会抛出 `FEISHU_UPDATE_UNSUPPORTED`。

## 提供方可用性

提供方的 `available(): boolean` 是一次廉价的**本地**检查（凭据存在、base URL 可解析），**绝不能发起网络调用**。它是执行期选择的输入，而非健康系统：`sendMessage()`/`startReceiving()` 读取它来挑选可用提供方，选择失败时会以调用方可路由的结构化 `FeishuError` 浮现——其 `code` 与 message 携带可分支的细节（缺失的 id 或歧义的候选集）。

选择从不依赖注册、配置或 HMR 顺序：能力要么有显式的提供方 id（配置 `provider`，或同一字段对应的 `DSH_FEISHU_PROVIDER` 环境变量），要么在恰好注册了一个可用提供方时自动选择；多个可用提供方且未配置 id 时是 `FEISHU_PROVIDER_AMBIGUOUS`，而不是先到先得。

## 错误

`FeishuError extends HarnessError`（[core.md](core.md) 错误分类），带 `code: string`（开放，如同其他所有 seam 的错误——`LlmError`、`SubagentError`），而非封闭联合：提供方可以在不改动 `dsh-feishu` 的情况下抛出自己的 code，消费方必须容忍未知 code。seam 中立的 code 由共享的 `FeishuRuntime` 契约抛出：`FEISHU_PROVIDER_UNAVAILABLE`、`FEISHU_PROVIDER_CONFIGURED_MISSING`、`FEISHU_PROVIDER_CONFIGURED_UNAVAILABLE`、`FEISHU_PROVIDER_AMBIGUOUS`、`FEISHU_DUPLICATE_PROVIDER`（注册期的编程错误）、`FEISHU_RECEIVE_UNSUPPORTED`（消息或卡片动作接收）、`FEISHU_UPDATE_UNSUPPORTED` 以及 `FEISHU_PROVIDER_ERROR`（提供方自身失败经 seam 浮现时的兜底）。由 `dsh-feishu-bot` 抛出的提供方 code 包括 `FEISHU_PROVIDER_AUTH_FAILED`、`FEISHU_PROVIDER_CREDENTIAL_MISSING` 和 `FEISHU_ABORTED`。

## 服务

`FeishuRuntime` 注册提供方，以 `FEISHU_DUPLICATE_PROVIDER` 拒绝重复 id，在执行期用结构化选择错误解析提供方，通过选定提供方发送并更新消息，启动选定提供方用于消息与卡片按钮动作的接收通道（对缺少相应能力的提供方抛出 `FEISHU_RECEIVE_UNSUPPORTED`），并通过 `status()` 投射一个展示安全的状态。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxfeishu--feishuruntime"></a>

### `ctx.feishu` — `FeishuRuntime`

The Feishu chat service. Registered as `ctx.feishu` (one instance per context).

Selection semantics (resolved at execution time, never order-dependent):

- A configured id that is registered and `available()` → that provider.
- A configured id not registered → `FEISHU_PROVIDER_CONFIGURED_MISSING`.
- A configured id registered but unavailable → `FEISHU_PROVIDER_CONFIGURED_UNAVAILABLE`.
- No id configured, exactly one registered usable provider → that provider.
- No id configured, multiple usable providers → `FEISHU_PROVIDER_AMBIGUOUS`.
- No id configured, no usable provider → `FEISHU_PROVIDER_UNAVAILABLE`.

```ts cordis-catalog
/**
 * Register a Feishu provider. Throws {@link FeishuError} `FEISHU_DUPLICATE_PROVIDER`
 * if its id is already registered. Returns a disposer; disposed with the calling fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerProvider(provider: FeishuProvider): () => void

/**
 * Send one message through the selected provider. Resolves the provider at call
 * time with the selection rules above; throws {@link FeishuError} when the
 * capability cannot run.
 * @param request - the target recipient and content.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the provider's send result.
 */
async sendMessage(request: FeishuSendRequest, signal?: AbortSignal): Promise<FeishuSendResult>

/**
 * Start receiving messages through the selected provider. Resolves the
 * provider at call time with the selection rules above; throws
 * {@link FeishuError} `FEISHU_RECEIVE_UNSUPPORTED` when the provider has no
 * `startReceiving`, or the provider's own failure when it cannot set up its
 * receive channel (e.g. unmatched credentials).
 * @param handler - the callback for each received {@link FeishuReceiveEvent}.
 * @returns a disposer that stops the receive channel.
 */
startReceiving(handler: FeishuReceiveHandler): () => void

/**
 * Start receiving card button actions through the selected provider.
 * Resolves the provider at call time with the selection rules above;
 * throws {@link FeishuError} `FEISHU_RECEIVE_UNSUPPORTED` when the
 * provider has no `startReceivingCardActions`. Card actions share the
 * provider's receive channel with {@link startReceiving} subscribers.
 * @param handler - the callback for each received {@link FeishuCardActionEvent}.
 * @returns a disposer that stops this card-action subscription.
 */
startReceivingCardActions(handler: FeishuCardActionHandler): () => void

/**
 * Replace the content of a message sent earlier through the selected
 * provider. Resolves the provider at call time with the selection rules
 * above; throws {@link FeishuError} `FEISHU_UPDATE_UNSUPPORTED` when the
 * provider has no `updateMessage`, or the provider's own failure when the
 * update does not succeed.
 * @param messageId - the provider message id returned by an earlier send.
 * @param content - the replacement content.
 * @param signal - optional cancellation signal forwarded to the provider.
 */
async updateMessage(messageId: string, content: string, signal?: AbortSignal): Promise<void>

/**
 * Project the effective connection state of this capability for status
 * surfaces. Applies the same selection rules as {@link sendMessage} without
 * throwing; selection failures surface as `state: 'error'` with
 * {@link FeishuRuntimeStatus.selectionError}. Providers without a `status`
 * method project from `available()`.
 * @returns the effective status view.
 */
async describeStatus(): Promise<FeishuRuntimeStatus>
```

Source: [`packages/feishu/feishu/src/index.ts:77`](../../packages/feishu/feishu/src/index.ts)

<a id="feishu-events"></a>

### `feishu/*` events

<a id="feishuchat-agent--emit"></a>

#### `feishu/chat-agent` — emit

A per-chat agent was published for one Feishu chat: the routing pin is live and every message from that chat now reaches this agent. Emitted once per chat per process, after `agent/created`, by `@deepseek-ai/dsh-feishu-receive`; consumers that need the chat ↔ agent binding (approval cards, per-chat surfaces) subscribe here instead of re-deriving the routing.

```ts cordis-catalog
/**
 * A per-chat agent was published for one Feishu chat: the routing pin is
 * live and every message from that chat now reaches this agent. Emitted
 * once per chat per process, after `agent/created`, by
 * `@deepseek-ai/dsh-feishu-receive`; consumers that need the chat ↔ agent
 * binding (approval cards, per-chat surfaces) subscribe here instead of
 * re-deriving the routing.
 * @param payload.agent - the published per-chat agent.
 * @param payload.chatId - the Feishu chat whose messages this agent serves.
 * @mode emit
 */
'feishu/chat-agent'(payload: { agent: Agent; chatId: string }): void
```

Types: [Agent](core.md)

Source: [`packages/feishu/feishu-receive/src/index.ts:40`](../../packages/feishu/feishu-receive/src/index.ts)
<!-- END GENERATED cordis-surface -->