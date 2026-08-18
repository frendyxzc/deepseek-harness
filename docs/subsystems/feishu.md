# Feishu Chat

English | [中文](feishu.zh.md)

The Feishu (飞书/Lark) chat capability seam — a [capability seam](../../.agents/notes/implemented/feature/2026-08-18-feishu-capability-seam.md) that spans **send and receive** on one `ctx.feishu` service, split across packages: Service Definition ([dsh-feishu](../../packages/feishu/feishu), `ctx.feishu` + the provider registry), Service Provider ([dsh-feishu-bot](../../packages/feishu/feishu-bot), the Feishu Open API Bot provider), and Consumers ([dsh-tool-feishu](../../packages/feishu/tool-feishu), the `feishu_send_message` tool; [dsh-feishu-receive](../../packages/feishu/feishu-receive), the per-chat receive router). Feishu is **one optional capability**, not part of the agent-loop spine — so its vocabulary lives here, not in [core.md](core.md). A provider swap does not change how the model asks to send a message.

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

## Receive event

Incoming Feishu events, delivered over the official long-connection client ([`@larksuiteoapi/node-sdk`](../../packages/feishu/feishu-bot)), normalize to one event shape before reaching a receive handler. The client dials OUT to Feishu, so no public callback URL is required. The provider extracts only text messages whose content decoded to non-empty; other message kinds are ignored.

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

## Provider availability

A provider's `available(): boolean` is a cheap LOCAL check (credential presence, parseable base URL) and **must not make network calls**. It is an input to execution-time selection, not a health system: `sendMessage()`/`startReceiving()` read it to pick a usable provider, and a selection failure surfaces as the structured `FeishuError` the caller routes on — which carries the branchable detail (the missing id or ambiguous candidate set) in its code and message.

Selection never depends on registration, config, or HMR order: a capability has an explicit provider id (config `provider`, or the `DSH_FEISHU_PROVIDER` env var feeding the same field), or auto-selects when exactly one usable provider is registered; multiple usable providers with no configured id is `FEISHU_PROVIDER_AMBIGUOUS`, not first-wins.

## Errors

`FeishuError extends HarnessError` ([core.md](core.md) error taxonomy) with a `code: string` (open, like every other seam's error — `LlmError`, `SubagentError`), not a closed union: a provider may raise its own codes without editing `dsh-feishu`, and consumers must tolerate an unknown code. Seam-neutral codes are raised by the shared `FeishuRuntime` contract: `FEISHU_PROVIDER_UNAVAILABLE`, `FEISHU_PROVIDER_CONFIGURED_MISSING`, `FEISHU_PROVIDER_CONFIGURED_UNAVAILABLE`, `FEISHU_PROVIDER_AMBIGUOUS`, `FEISHU_DUPLICATE_PROVIDER` (a registration-time programming error), `FEISHU_RECEIVE_UNSUPPORTED`, and `FEISHU_PROVIDER_ERROR` (the catch-all for a provider's own failure surfaced through the seam). Provider-owned codes raised by `dsh-feishu-bot` include `FEISHU_PROVIDER_AUTH_FAILED`, `FEISHU_PROVIDER_CREDENTIAL_MISSING`, and `FEISHU_ABORTED`.

## The service

`FeishuRuntime` registers providers, rejects duplicate ids with `FEISHU_DUPLICATE_PROVIDER`, resolves providers at execution time with structured selection errors, sends messages through the selected provider, starts the selected provider's receive channel (throwing `FEISHU_RECEIVE_UNSUPPORTED` for a send-only provider), and projects a display-safe status through `status()`.

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
 * Project the effective connection state of this capability for status
 * surfaces. Applies the same selection rules as {@link sendMessage} without
 * throwing; selection failures surface as `state: 'error'` with
 * {@link FeishuRuntimeStatus.selectionError}. Providers without a `status`
 * method project from `available()`.
 * @returns the effective status view.
 */
async describeStatus(): Promise<FeishuRuntimeStatus>
```

Source: [`packages/feishu/feishu/src/index.ts:74`](../../packages/feishu/feishu/src/index.ts)
<!-- END GENERATED cordis-surface -->