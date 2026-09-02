# Feishu Chat

English | [中文](feishu.zh.md)

The Feishu (飞书/Lark) chat capability seam — a [capability seam](../../.agents/notes/implemented/feature/2026-08-18-feishu-capability-seam.md) that spans **send and receive** on one `ctx.feishu` service, split across packages: Service Definition ([dsh-feishu](../../packages/feishu/feishu), `ctx.feishu` + the provider registry), Service Provider ([dsh-feishu-bot](../../packages/feishu/feishu-bot), the Feishu Open API Bot provider), and Consumers ([dsh-tool-feishu](../../packages/feishu/tool-feishu), the `feishu_send_message` and `feishu_update_message` tools; [dsh-feishu-receive](../../packages/feishu/feishu-receive), the per-chat receive router; [dsh-feishu-approval](../../packages/feishu/feishu-approval), the approval-card answerer; [dsh-feishu-question](../../packages/feishu/feishu-question), the question-card answerer). Feishu is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A provider swap does not change how the model asks to send a message.

Source: [`packages/feishu/feishu/src/types.ts`](../../packages/feishu/feishu/src/types.ts)

## Send request and result

The model-facing tool argument is a recipient id plus text content. `receiveIdType` and `msgType` default at the provider (`open_id`, `text`); the tool enforces both with string-literal enums so the model cannot invent a value.

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
  /** Explicit provider id to route through; omitted uses the seam's selection (and per-chat routing). */
  readonly providerId?: string
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

## Message images

A message's embedded images are extracted from its content as `FeishuMessageImage` references, and a consumer fetches one image's bytes as a `FeishuMessageResource` through `getMessageResource`.

```ts type-equiv
/**
 * One image discovered in Feishu message content. The enclosing message's id
 * is the download scope: a consumer combines this `fileKey` with the event or
 * fetched message's `messageId` to fetch the image bytes.
 */
interface FeishuMessageImage {
  /** The Feishu image key used as the download file key. */
  readonly fileKey: string
}
```

```ts type-equiv
/** One binary image resource fetched from a Feishu/Lark message. */
interface FeishuMessageResource {
  /** Raw image bytes. */
  readonly data: Uint8Array
}
```

## Receive event

Incoming Feishu events, delivered over the official long-connection client ([`@larksuiteoapi/node-sdk`](../../packages/feishu/feishu-bot)), normalize to one event shape before reaching a receive handler. The client dials OUT to Feishu, so no public callback URL is required. The provider reduces text, rich-text (`post`), interactive card (`interactive`), and image content to plain text and attaches any image keys as `images`; a message with no readable text and no images is dropped. The received message id and any quoted / replied-to parent or thread-root ids ride along so a consumer can resolve the referenced message.

```ts type-equiv
/** One message received from Feishu. */
interface FeishuReceiveEvent {
  /** The event type (e.g. `im.message.receive_v1`). */
  readonly eventType: string
  /** The Feishu App ID that received this event, when the provider knows it. */
  readonly appId?: string
  /** The provider registry id that received this event, when the provider knows it. */
  readonly providerId?: string
  /** The sender's id. */
  readonly senderId: string
  /** The sender id type. */
  readonly senderIdType: FeishuReceiveIdType
  /** The chat or user id where the message was received. */
  readonly chatId: string
  /** The received message's id, when the event carries one. */
  readonly messageId?: string
  /** The immediately referenced (quoted / replied-to) message id, when present. */
  readonly parentId?: string
  /** The thread root message id, when the message is part of a reply thread. */
  readonly rootId?: string
  /** The message content as plain text (extracted from the event body). */
  readonly content: string
  /** Images discovered in the message content, scoped to this event's message id. */
  readonly images?: readonly FeishuMessageImage[]
  /** The raw event payload for provider-specific handling. */
  readonly raw: unknown
}
```

## Reading a referenced message

`getMessage(messageId, signal?)` fetches one message by id through the selected provider and returns it as a `FeishuMessage` with its content extracted as plain text and any image keys in `images`, so a consumer can read a quoted or replied-to message referenced by an incoming event. Interactive cards resolve to their original card JSON, so a markdown card component is read as its text rather than a preview placeholder. A provider without read support raises `FEISHU_GET_UNSUPPORTED`. The extraction uses the same text / post / interactive / image reduction as the receive path.

`getMessageResource(messageId, fileKey, signal?)` fetches the raw bytes of one image attached to a message by its file key, so a multimodal model can read it. A provider without resource read support raises `FEISHU_RESOURCE_UNSUPPORTED`.

```ts type-equiv
/** One message fetched by id from a Feishu/Lark backend. */
interface FeishuMessage {
  /** The message's id. */
  readonly messageId: string
  /** The message content type (e.g. `text`, `post`, `interactive`). */
  readonly msgType: string
  /** The readable plain text extracted from the message content. */
  readonly content: string
  /** Images discovered in the message content, scoped to this message's id. */
  readonly images?: readonly FeishuMessageImage[]
  /** The immediately referenced (quoted / replied-to) message id, when present. */
  readonly parentId?: string
  /** The thread root message id, when the message is part of a reply thread. */
  readonly rootId?: string
  /** The raw payload for provider-specific handling. */
  readonly raw: unknown
}
```

## Card action event

An operator tap on an interactive card button — or a form submission inside a card — delivered over the same long-connection channel as messages (never a second connection) and normalized to one shape before reaching a card-action handler. The `value` payload is attacker-controllable card data: consumers validate it against their own trusted state (e.g. a nonce minted when the card was built) before acting.

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
  /**
   * The submitted form controls' values, present when the tapped action
   * submitted a card form (a submit button inside a form container). Keys
   * are the control names the card builder chose; values are
   * control-shaped (selected indices, checked booleans, typed text).
   * Attacker-controllable card data with the same validation obligation
   * as {@link value}; absent for plain button taps that submit no form.
   */
  readonly formValue?: Record<string, unknown>
  /** The raw event payload for provider-specific handling. */
  readonly raw: unknown
}
```

## Updating a sent message

`updateMessage(messageId, content, signal?)` replaces the content of a message sent earlier through the selected provider — e.g. settling an interactive approval card after its buttons were consumed. `content` carries the same encoding as the original send (a card JSON string for cards). A provider without update support raises `FEISHU_UPDATE_UNSUPPORTED`.

## Provider availability

A provider's `available(): boolean` is a cheap LOCAL check (credential presence, parseable base URL) and **must not make network calls**. It is an input to execution-time selection, not a health system: `sendMessage()`/`startReceiving()` read it to pick a usable provider, and a selection failure surfaces as the structured `FeishuError` the caller routes on — which carries the branchable detail (the missing id or ambiguous candidate set) in its code and message.

Selection never depends on registration, config, or HMR order: a capability has an explicit provider id (config `provider`, or the `DSH_FEISHU_PROVIDER` env var feeding the same field), or auto-selects when exactly one usable provider is registered; multiple usable providers with no configured id is `FEISHU_PROVIDER_AMBIGUOUS`, not first-wins.

## Errors

`FeishuError extends HarnessError` ([core.md](core.md) error taxonomy) with a `code: string` (open, like every other seam's error — `LlmError`, `SubagentError`), not a closed union: a provider may raise its own codes without editing `dsh-feishu`, and consumers must tolerate an unknown code. Seam-neutral codes are raised by the shared `FeishuRuntime` contract: `FEISHU_PROVIDER_UNAVAILABLE`, `FEISHU_PROVIDER_CONFIGURED_MISSING`, `FEISHU_PROVIDER_CONFIGURED_UNAVAILABLE`, `FEISHU_PROVIDER_AMBIGUOUS`, `FEISHU_DUPLICATE_PROVIDER` (a registration-time programming error), `FEISHU_RECEIVE_UNSUPPORTED` (message or card-action receive), `FEISHU_UPDATE_UNSUPPORTED`, `FEISHU_GET_UNSUPPORTED`, `FEISHU_RESOURCE_UNSUPPORTED` (message resource read), and `FEISHU_PROVIDER_ERROR` (the catch-all for a provider's own failure surfaced through the seam). Provider-owned codes raised by `dsh-feishu-bot` include `FEISHU_PROVIDER_AUTH_FAILED`, `FEISHU_PROVIDER_CREDENTIAL_MISSING`, and `FEISHU_ABORTED`.

## The service

`FeishuRuntime` registers providers, rejects duplicate ids with `FEISHU_DUPLICATE_PROVIDER`, resolves providers at execution time with structured selection errors, sends, updates, and reads messages, fetches message image resources, starts the selected provider's receive channel for messages and card button actions (throwing `FEISHU_RECEIVE_UNSUPPORTED` for a provider without the matching capability), and projects a display-safe status through `status()`.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * Every registered provider, in registration order.
 * @returns the registered providers.
 */
listProviders(): readonly FeishuProvider[]

/**
 * Register a Feishu provider. Throws {@link FeishuError} `FEISHU_DUPLICATE_PROVIDER`
 * if its id is already registered. Returns a disposer; disposed with the calling fiber.
 * Emits `feishu/provider-added` once the registration commits (a throwing
 * listener rolls it back) and `feishu/provider-removed` when it is disposed.
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
 * Start receiving from every registered provider that can receive. Each
 * inbound event is stamped with its provider id and recorded against its chat
 * id, so a reply to that chat routes back through the same app. Returns a
 * combined disposer that closes every opened channel.
 * @param handler - the callback for each received {@link FeishuReceiveEvent}.
 * @returns a disposer that stops every channel this call opened.
 */
startReceivingAll(handler: FeishuReceiveHandler): () => void

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
 * Fetch one message by id through the selected provider — e.g. to read a
 * quoted or replied-to message referenced by an inbound event. Resolves the
 * provider at call time with the selection rules above; throws
 * {@link FeishuError} `FEISHU_GET_UNSUPPORTED` when the provider has no
 * `getMessage`, or the provider's own failure when the fetch does not
 * succeed.
 * @param messageId - the Feishu message id.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the fetched message with its content extracted as plain text.
 */
async getMessage(messageId: string, signal?: AbortSignal): Promise<FeishuMessage>

/**
 * Fetch one binary image attached to a message through the selected provider —
 * e.g. the image a user posted so a multimodal model can read it. Resolves
 * the provider at call time with the selection rules above; throws
 * {@link FeishuError} `FEISHU_RESOURCE_UNSUPPORTED` when the provider has no
 * `getMessageResource`, or the provider's own failure when the fetch does not
 * succeed.
 * @param messageId - the Feishu message id the image belongs to.
 * @param fileKey - the image's file key from the message content.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the raw image bytes.
 */
async getMessageResource(messageId: string, fileKey: string, signal?: AbortSignal): Promise<FeishuMessageResource>

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

Source: [`packages/feishu/feishu/src/index.ts`](../../packages/feishu/feishu/src/index.ts)

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

Source: [`packages/feishu/feishu-receive/src/index.ts`](../../packages/feishu/feishu-receive/src/index.ts)

<a id="feishuprovider-added--emit"></a>

#### `feishu/provider-added` — emit

A Feishu provider was registered with `ctx.feishu.registerProvider`. Load-time consumers (receive channels) subscribe here so they open on the registered provider regardless of parallel entry load order.

```ts cordis-catalog
/**
 * A Feishu provider was registered with `ctx.feishu.registerProvider`.
 * Load-time consumers (receive channels) subscribe here so they open on
 * the registered provider regardless of parallel entry load order.
 * @param provider - the registered provider.
 * @mode emit
 */
'feishu/provider-added'(provider: FeishuProvider): void
```

Source: [`packages/feishu/feishu/src/index.ts`](../../packages/feishu/feishu/src/index.ts)

<a id="feishuprovider-removed--emit"></a>

#### `feishu/provider-removed` — emit

A Feishu provider left the registry (its registering fiber unloaded).

```ts cordis-catalog
/**
 * A Feishu provider left the registry (its registering fiber unloaded).
 * @param id - the provider id that no longer resolves.
 * @mode emit
 */
'feishu/provider-removed'(id: string): void
```

Source: [`packages/feishu/feishu/src/index.ts`](../../packages/feishu/feishu/src/index.ts)
<!-- END GENERATED cordis-surface -->