---
description: "Own the Feishu chat capability in a composition: provider registration and per-call selection, send, update, read, and receive channels for chats and card taps, plus status projection."
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu

English | [中文](README.zh.md)

## Summary

Mount this package when a composition needs Feishu (飞书) chat at all. It owns `ctx.feishu`: where providers register, how one is chosen for each call, and what consumers can do — send, update, read, receive chats and card taps, and project connection status — without importing the Feishu SDK. Selection runs per operation, so a provider added later or one that loses its credentials changes the next call rather than the composition. No transport ships here; mount `@deepseek-ai/dsh-feishu-bot` beside it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package once in any composition that reads or writes Feishu chats, together with at least one provider. With no provider registered, every operation fails with `FEISHU_PROVIDER_UNAVAILABLE` and `describeStatus()` reports `state: 'unavailable'`.

### When to choose it

This is the capability itself, not an alternative to another package: a composition either mounts it or has no Feishu chat at all. The provider is the choice — `@deepseek-ai/dsh-feishu-bot` is the only shipped one, and a new transport registers itself through `ctx.feishu.registerProvider()` rather than adding a second registry. Consumers in this repository are [`dsh-feishu-receive`](../feishu-receive/README.md) (inbound chats), [`dsh-tool-feishu`](../tool-feishu/README.md) (model-facing sends), the two card answerers, and [`dsh-feishu-status`](../feishu-status/README.md) (browser projection); each mounts this package only through its own `inject`.

### Minimal configuration

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-feishu'
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | unset, then `$DSH_FEISHU_PROVIDER` | Provider id used on every operation; unset selects automatically when exactly one registered provider is available |

Shipped compositions leave `provider` unset with one bot. Set it once several bots register and one of them must own sends. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-feishu) is the exhaustive source for every accepted field.

### Provider selection

Selection resolves at execution time, never from load or configuration order, and each outcome has its own stable code:

- A configured id that is registered and `available()` → that provider.
- A configured id that is not registered → `FEISHU_PROVIDER_CONFIGURED_MISSING`.
- A configured id that is registered but unavailable → `FEISHU_PROVIDER_CONFIGURED_UNAVAILABLE`.
- Nothing configured, exactly one usable provider → that provider.
- Nothing configured, several usable providers → `FEISHU_PROVIDER_AMBIGUOUS`, naming the candidates.
- Nothing configured and none usable → `FEISHU_PROVIDER_UNAVAILABLE`.

### What a consumer can do

`sendMessage()` routes by the request's own history before it consults selection: an explicit `providerId` wins, otherwise the provider that last delivered this `receiveId` is used, so a reply to a group chat leaves through the app that received it. A routed-away id that has since unregistered fails with `FEISHU_PROVIDER_CONFIGURED_MISSING`. `updateMessage()`, `getMessage()`, and `getMessageResource()` revise, read, and download through the selected provider, and each throws its own `*_UNSUPPORTED` code when that provider does not implement the operation.

Receiving has three subscription shapes because "which provider should talk to Feishu?" is a different question per consumer: `startReceiving()` opens the selected provider's channel, `startReceivingAll()` opens every available provider that can receive, and `startReceivingProvider()` opens one provider you already hold — the form a consumer uses when a bot can be added after boot, so it can subscribe the newcomer without re-subscribing the bots already delivering messages. All three record each event's reply target against its provider, except `startReceiving()` itself, which leaves reply routing to selection. Card taps arrive through `startReceivingCardActions()` on the very same channel a message subscriber opens, never a second one, so a provider without card support reports `FEISHU_RECEIVE_UNSUPPORTED` at subscription time.

`describeStatus()` answers the same selection questions without throwing: a selection failure surfaces as `state: 'error'` with `selectionError`, and a provider's own `status()` projection supplies the display-safe detail.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The design keeps two facts, and nothing else: a registry keyed by provider id, and a reply-target → provider map fed by inbound events. Every public method resolves through one of them at call time, which is why no consumer caches a provider.

Registration is the only mutation, and it is transactional. `registerProvider()` installs the entry inside an effect generator, then emits `feishu/provider-added`; a listener that throws rolls the registration back, so a consumer that cannot serve a provider denies that provider rather than breaking boot. The disposer — run when the registering fiber unloads — emits `feishu/provider-removed` with the id. Registering a second provider under one id throws `FEISHU_DUPLICATE_PROVIDER` instead of replacing the first. Providers list in registration order through `listProviders()`.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, registry, selection, receive subscription, and status projection |
| [`src/types.ts`](src/types.ts) | `FeishuProvider` contract, request and result vocabulary, status views, `FeishuError` |

The type vocabulary — receive-id types, message types, connection states, the masked `FeishuProviderStatus` — is defined here and documented on the [Feishu subsystem](../../../docs/subsystems/feishu.md) page, which owns it; nothing in this README restates a field list.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Feishu subsystem](../../../docs/subsystems/feishu.md) — the seam's type definitions, `FeishuError` codes, and generated Cordis API.
- [Feishu capability seam decision](../../../.agents/notes/implemented/feature/2026-08-18-feishu-capability-seam.md) — why chat operations sit behind one provider registry.
- [Provider lifecycle events decision](../../../.agents/notes/implemented/architecture/2026-08-19-feishu-provider-lifecycle-events.md) — why registration announces itself and a throwing listener rolls back.
- [feishu-bot](../feishu-bot/README.md) — the only provider implementation shipped here.
- [feishu-receive](../feishu-receive/README.md) — the consumer that subscribes providers individually and routes each chat to its own agent.
- [feishu-status](../feishu-status/README.md) — the Remote projection of `describeStatus()` for browser clients.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-feishu`, which renders send results and provider failures for the model while this registry contributes no prompt or schema of its own.

#### KV Cache effect

No request-prefix content of its own; the consuming tool and the per-chat system-prompt section own every model-visible change, and switching providers changes transport facts rather than prompt text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Card JSON is the caller's business** — `interactive` is an accepted message type, but this package validates and constructs no card schema; each card author builds its own JSON.
- **One provider per capability** — the registry holds providers and selects among them, but composes no fan-out send, per-chat provider policy, or failover chain.
- **Reply routing is process memory** — the receive-target → provider map is built from events this process received, so a restart routes the first reply by selection until a message arrives again.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published: the provider map stays private and the `feishu/provider-added` / `feishu/provider-removed` pair is emitted at the single set and delete sites, so no independent relation remains for an invariant to assert.

</details>
