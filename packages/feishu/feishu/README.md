# @deepseek-ai/dsh-feishu

English | [中文](README.zh.md)

Feishu (飞书/Lark) chat capability seam (`ctx.feishu`) for the DeepSeek Harness.

## Purpose

Registers the `FeishuRuntime` service as `ctx.feishu` — one instance per Cordis context. It owns the provider registry, duplicate detection, execution-time provider selection, and the `FeishuError` taxonomy.

## Provider selection

- A configured `provider` id that is registered and `available()` → that provider.
- A configured id not registered → `FEISHU_PROVIDER_CONFIGURED_MISSING`.
- A configured id registered but unavailable → `FEISHU_PROVIDER_CONFIGURED_UNAVAILABLE`.
- No id configured, exactly one registered usable provider → that provider.
- No id configured, multiple usable providers → `FEISHU_PROVIDER_AMBIGUOUS`.
- No id configured, no usable provider → `FEISHU_PROVIDER_UNAVAILABLE`.

## Config

| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | `string` | — | Explicit provider id; auto-selects when exactly one usable provider is registered |

## Extension points

- `ctx.feishu.registerProvider(provider)` — register a `FeishuProvider` implementation. Returns a disposer.
- `feishu/provider-added` — emitted when a provider commits to the registry; a throwing listener rolls the registration back. Load-time consumers such as the card-action answerer subscribe here because Cordis may load sibling plugins concurrently, so configuration order does not prove registration order.
- `feishu/provider-removed` — emitted with the provider id when a registration's disposer runs (the registering fiber unloaded).
- `ctx.feishu.sendMessage(request, signal?)` — send one message through the selected provider.
- `ctx.feishu.startReceiving(handler)` — start the selected provider's receive channel; the provider calls `handler` with each `FeishuReceiveEvent`. Returns a disposer, and throws `FEISHU_RECEIVE_UNSUPPORTED` for a send-only provider.
- `ctx.feishu.startReceivingCardActions(handler)` — subscribe to card button actions (`FeishuCardActionEvent`) through the selected provider's receive channel — the same channel `startReceiving` opens, never a second one. Returns a disposer, and throws `FEISHU_RECEIVE_UNSUPPORTED` when the provider has no card-action support. Handlers must settle fast; anything slow belongs behind the handler.
- `ctx.feishu.updateMessage(messageId, content, signal?)` — replace the content of a message sent earlier through the selected provider (e.g. settling an interactive card after its buttons were consumed); throws `FEISHU_UPDATE_UNSUPPORTED` when the provider has no update support.
- `ctx.feishu.getMessage(messageId, signal?)` — fetch one message by id from the selected provider with its content extracted as plain text (e.g. to read a quoted or replied-to message referenced by an inbound `FeishuReceiveEvent`); throws `FEISHU_GET_UNSUPPORTED` when the provider has no read support.
- `ctx.feishu.describeStatus()` — project the effective connection state (`FeishuRuntimeStatus`) for status surfaces, applying the same selection rules without throwing; selection failures surface as `state: 'error'` with `selectionError`. Providers may implement an async `status(): FeishuProviderStatus` projection (masked App ID, secret booleans, receive activity, last failure); without one, `available()` decides `connected`/`unavailable`.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-feishu`, which routes send-message results and provider failures while this registry contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Card messages** — the `interactive` msgType is declared but card JSON construction is left to the caller; the model-facing tool does not yet validate or construct card schemas.