# Agent Note: Feishu capability seam — send and receive chat

Status: implemented

English | [中文](2026-08-18-feishu-capability-seam.zh.md)

## Problem

The harness has no way to reach a Feishu (飞书/Lark) chat: the agent cannot send a message to a user or group, and it cannot receive messages the user sends to the bot. Both directions share one dependency surface — a Feishu App ID/Secret and the Feishu Open API — but the model-facing send contract must not hard-code one vendor's HTTP shape, and the receive path must turn a long-connection event into an agent turn without coupling the receive transport to the agent loop.

## Decision

Feishu chat is a first-class capability seam following [the capability-seam Agent Note](../../implemented/architecture/2026-06-13-capability-seams.md), split across four packages:

1. `@deepseek-ai/dsh-feishu` (`packages/feishu/feishu`) owns `ctx.feishu`, provider registration, execution-time provider selection, the send/receive vocabulary, and `FeishuError`.
2. `@deepseek-ai/dsh-feishu-bot` (`packages/feishu/feishu-bot`) is the Feishu Open API Bot provider — tenant-token auth, `sendMessage`, and a long-connection `startReceiving` ([long-connection note](2026-08-18-feishu-long-connection-receive.md)).
3. `@deepseek-ai/dsh-tool-feishu` (`packages/feishu/tool-feishu`) owns the model-facing `feishu_send_message` tool schema (string-literal enums for `receiveIdType`/`msgType`), prompt guidance, and presentation.
4. `@deepseek-ai/dsh-feishu-receive` (`packages/feishu/feishu-receive`) routes each Feishu chat into its own agent session ([per-chat routing note](2026-08-19-feishu-per-chat-receive-routing.md)).

Providers register with `ctx.feishu`; only the tool and the receive consumer are model- or user-facing. Send and receive are one seam with one selection policy: a configured `provider` id (or the equivalent `DSH_FEISHU_PROVIDER` env var), or auto-select when exactly one usable provider is registered; multiple usable providers with no configured id is `FEISHU_PROVIDER_AMBIGUOUS`, not first-wins.

### Receive is `startReceiving`, not publisher/subscriber

`FeishuRuntime` exposes `startReceiving(handler): () => void`, which resolves the provider and calls its `startReceiving(handler)`. There is no `onReceive`/`dispatchReceive` fan-out or a `receiveHandlers` set on the seam: the one current consumer (`dsh-feishu-receive`) is the only receiver, and a second consumer is a future problem a pub/sub registry would solve by guessing at its contract. A send-only provider has no `startReceiving`, and the seam throws `FEISHU_RECEIVE_UNSUPPORTED`; `dsh-feishu-bot` starts the long-connection client asynchronously, surfacing setup failures through `status()` and the logger instead of a synchronous throw.

### Inbound delivery routes each chat to its own agent

`dsh-feishu-receive` starts the receive channel inside `ctx.effect` (its disposer closes the long connection) and routes each `FeishuReceiveEvent` to a dedicated per-chat agent ([per-chat routing note](2026-08-19-feishu-per-chat-receive-routing.md)). The provider extracts only text messages whose content decoded to non-empty; other message kinds are ignored.

### Credentials resolve per operation

`dsh-feishu-bot` resolves `appId`/`appSecret` per operation: a literal config value wins, otherwise the `appIdEnv`/`appSecretEnv` credential reference resolves through the credentials service (falling back to the launch environment). Literal fields carry `.role('secret')`, and the env references carry `.role('credential-ref')`. The tenant access token is cached and refreshed on expiry with a 60-second margin; on-demand refresh on an invalid-token error code is deferred (a documented limitation, not a false claim in the provider's own contract).

## Alternatives considered

**Two separate services (`ctx.feishuSend` / `ctx.feishuReceive`).** Send and receive share one dependency (App ID/Secret) and one provider-selection policy; splitting would duplicate selection, the error taxonomy, and the credential surface for no current consumer benefit.

**Providers register their own model-facing tools.** The web seam's lesson applies: a provider-registered `feishu_send_message` would make tool availability depend on whichever provider package loads, and provider-specific fields would leak into the model contract. `dsh-tool-feishu` is the single owner of model-facing names, schemas, and prompt guidance.

**Pub/sub receive fan-out on the seam.** Rejected as unowned surface: one consumer exists and it consumes every event, so a `Set<handler>` registry plus `dispatchReceive` adds state and disposal surface with no second subscriber to prove its contract.

**Hand-rolled user messages in the receive consumer.** `dsh-feishu-receive` constructs messages with `createUserMessage({ content, source: { kind: 'user' } })` rather than assembling a `MessageId`/`source` object by hand, so the message shape stays owned by `dsh-llm`.

## Consequences

- Feishu is an opt-in capability: the four packages mount through ordinary composition, and none are part of the agent-loop spine or shipped defaults.
- Inbound routing is per-chat, not single-agent: each chat gets its own agent session ([per-chat routing note](2026-08-19-feishu-per-chat-receive-routing.md)); sender attribution within a chat and resume across restarts are deferred in `dsh-feishu-receive`'s README.
- Card (`interactive`) messages are declared but card JSON construction is left to the caller; the model-facing tool does not validate or construct card schemas.
- Send and receive are covered by unit tests (seam selection and registry disposal, provider token/send/receive, tool enum validation and end-to-end send, consumer delivery) plus a real-composition test that boots the seam, provider, and tool through the Loader against a mocked Feishu HTTP boundary.