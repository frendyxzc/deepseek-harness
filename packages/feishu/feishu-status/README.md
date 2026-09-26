---
description: "Read-only Remote projection of the Feishu seam's effective connection status: one Remote call for the capability as a whole and one entry per registered bot, both display-safe and point-in-time, for Host status surfaces."
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu-status

English | [中文](README.zh.md)

## Summary

Show the current Feishu connection state in a status surface. This package registers the `feishuStatus` Remote service with two calls: `status()` reports the capability's effective state — which provider was selected, what that provider says about itself, and why selection failed — and `list()` reports one entry per registered bot for the multi-bot settings tab. Both read `ctx.feishu` on demand, so a view describes the registry as it stands and neither throws when selection fails. Values arrive display-safe: providers mask App IDs and reduce secrets to booleans before those values cross the wire.

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

Mount this package beside [`@deepseek-ai/dsh-feishu`](../feishu/README.md), the only service it injects, on the Host that serves the Web client. It registers no provider, opens no channel, and starts no timer, so unlike the other Feishu packages it does nothing until a Remote call arrives. The [`dsh.setup` Web profile patch](../../../scripts/setup-dsh/templates/profile-web/cordis.patch.yml) mounts it for exactly that reason.

### When to choose it

Add it when a process must report Feishu health to a client it serves — today that is the Web settings IM tab, which renders one row per configured bot. Leave it out of a headless composition: nothing else in the repository consumes `feishuStatus`, and an in-process plugin that needs the same information calls `ctx.feishu.describeStatus()` on the seam directly, which is where the state actually lives.

### Minimal configuration

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-feishu'
    - id: feishu-bot
      name: '@deepseek-ai/dsh-feishu-bot'
    - id: feishu-status
      name: '@deepseek-ai/dsh-feishu-status'
```

This plugin declares no `Config`, so the generated [configuration catalog](../../../docs/config-catalog.md) has no section for it: every value it reports is read from the seam, and what counts as healthy is configured entirely in [`@deepseek-ai/dsh-feishu`](../feishu/README.md) and in the bot provider that answers `status()`.

### What it publishes

| Remote | Returns | Read from |
|---|---|---|
| `feishuStatus.status()` | one `FeishuStatusView`: `state`, plus optional `providerId`, `provider`, and `selectionError` | `ctx.feishu.describeStatus()`, which applies the same selection rules as a real send without throwing |
| `feishuStatus.list()` | one `FeishuBotStatusView` per registered provider, in registration order | `ctx.feishu.listProviders()`, awaiting each provider's own `status()` |

`state` is one of `unavailable`, `unconfigured`, `connected`, or `error`. A provider with no `status()` method is projected from `available()` alone, and a provider whose `status()` throws degrades to that same fallback instead of failing the batch, so one unhealthy bot cannot hide the others; `appSecretConfigured` and `receiveActive` then report `false`.

### Who consumes it

The service is Remote-only: it deliberately declares no same-process Cordis `Context` merge, so in-process code sees the seam and only Remote clients see this gateway. Client bundles pick it up through the explicit [`@deepseek-ai/dsh-api-remotes`](../../api/remotes/README.md) assembly, which re-exports the generated `./remote` client and the `./types` payload shapes, and the IM tab of Web settings calls `ctx.remote.feishuStatus.list()` through [`@deepseek-ai/dsh-client-ui-settings-im`](../../client/ui-settings-im/README.md).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One class, one service key: `FeishuStatusGateway` extends `TypertRemoteService` under the namespace `feishuStatus`, and its two `@Remote('status')` and `@Remote('list')` methods are the whole API. Typert generates the Host registration and the typed client from those decorators, which is why the package exports `./typert` and `./remote` alongside `.` and `./types`.

`status()` projects a single seam call. `ctx.feishu.describeStatus()` re-runs the seam's selection — including its `provider` config and `DSH_FEISHU_PROVIDER` override — but never throws: a seam that cannot select anything returns `state: 'error'` with `selectionError` explaining why, and this gateway forwards that verbatim. The selected provider's `FeishuProviderStatus` is passed through untouched, because the masking that makes it display-safe is the provider's own work.

`list()` fans out instead of selecting. It walks the providers in registration order and awaits each `status()` inside a `try` whose failure is swallowed, so an unhealthy provider yields the `available()` fallback rather than an error. Both methods build their result with conditional spreads, keeping an absent optional field out of the payload instead of sending it as null, so the wire shape matches the declared optional types.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The gateway class, its service key, and the two `@Remote` projections |
| [`src/types.ts`](src/types.ts) | `FeishuStatusView` and `FeishuBotStatusView`, the payload types clients import |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Feishu subsystem](../../../docs/subsystems/feishu.md) — `describeStatus()`, `FeishuProviderStatus`, and the selection rules this gateway projects.
- [Typert subsystem](../../../docs/subsystems/typert.md) — how an `@Remote` method becomes a Host registration and a typed client.
- [IM status tab decision](../../../.agents/notes/implemented/architecture/2026-08-18-feishu-im-status-tab.md) — the surface this service exists to feed.
- [Stale status error fix](../../../.agents/notes/implemented/bug-fix/2026-09-14-feishu-stale-status-error.md) — why a recovered receive connection has to change what a provider reports.
- [Remote method calls](../../../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.md) — the `ok` / `value` / `error` envelope every Remote call returns.
- [feishu](../feishu/README.md) — the seam that owns every value this package reports.
- [feishu-bot](../feishu-bot/README.md) — the provider whose `status()` and receive channel fill the per-bot view.
- [`@deepseek-ai/dsh-api-remotes`](../../api/remotes/README.md) — the assembly that exposes the generated client to Web bundles.
- [`@deepseek-ai/dsh-client-ui-settings-im`](../../client/ui-settings-im/README.md) — the tab that calls `feishuStatus.list()`.

-----

<a id="model-experience"></a>
## Model Experience

None, as this Host-only status gateway registers no prompt, tool schema, system-prompt section, or session message of its own: it answers Remote calls about connection health, which no model request path reads.

#### KV Cache effect

None from this package: it never assembles model input and writes nothing to any session log, so mounting or removing it cannot change a request prefix or a replayed session.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Point-in-time state only** — a view carries no failure history and there is no subscription, so a surface refreshes by re-querying and anything that happened between two calls is invisible.
- **`list()` is only as good as its providers** — a provider without `status()`, or one whose `status()` throws, is reported from `available()` with `appSecretConfigured` and `receiveActive` as `false`, so a silent bot can read as an idle one.
- **Masking is the provider's job** — this gateway adds no redaction of its own, so a provider that reports an unmasked value publishes it to every Remote client that asks.
- **Only `list()` has a consumer today** — `status()` is generated and tested and answers a call, but the shipped Web surface reads the per-bot list; the capability-wide view waits for its own surface.
- **A transport failure looks like an empty registry** — Typert returns failures as values rather than throwing, and the IM tab maps any failed call to an empty list, so a client cannot tell "no bots" from "the Host is unreachable".

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published: every view here is projected directly from seam-owned state, so there is no relation this package could assert beyond what [`@deepseek-ai/dsh-feishu`](../feishu/README.md) already owns.

Keep the payload changes on both sides together. `src/types.ts` is what clients import, while the wire model comes from the `@Remote` return types, so a field added to one without the other produces a client that cannot see it; the `./typert` and `./remote` artifacts are generated and must never be edited by hand. `zod` is a runtime dependency only because those generated artifacts import it — nothing under `src/` validates with it.

</details>
