# Agent Note: Feishu provider-lifecycle events — `feishu/provider-added` / `feishu/provider-removed`

Status: implemented

English | [中文](2026-08-19-feishu-provider-lifecycle-events.zh.md)

## Problem

[The approval-cards Agent Note](../feature/2026-08-18-feishu-approval-cards.md) makes `dsh-feishu-approval` open its card tap channel at `apply` time by calling `ctx.feishu.startReceivingCardActions` synchronously. That call resolves the provider registry, but the registry's contents arrive on `dsh-feishu-bot`'s own plugin fiber, on no particular schedule: the Cordis Loader starts sibling entries concurrently and does not await activation, so `pnpm dsh web` failed deterministically with `FEISHU_PROVIDER_UNAVAILABLE` whenever the answerer's apply ran before the bot's registration. `dsh-feishu-receive` calls `ctx.feishu.startReceiving` the same way and carried the same latent race.

Resolving the provider at `apply` time creates an implicit load-order requirement ("list the provider before the consumers in cordis.yml"), which the Loader does not guarantee.

## Decision

The Feishu seam announces registry membership as typed events, mirroring the [subagent provider-lifecycle events](2026-07-05-subagent-provider-lifecycle-events.md):

- **`feishu/provider-added(provider)`** — a provider committed to the `ctx.feishu` registry. Emitted by `registerProvider` after the registration stores the provider; a throwing listener unwinds the yielded rollback, so the registration fails loud.
- **`feishu/provider-removed(id)`** — a provider left the registry (its registering fiber was disposed — an unload or an HMR reload). Emitted from the registration's disposer.

Both receive consumers mirror the registry instead of assuming order. Each `apply` attempts to open its channel and, when no usable provider has registered yet, waits for `feishu/provider-added` to open the channel on the registration. When the channel's provider leaves, `feishu/provider-removed` closes the channel and re-opens it on a remaining provider — or resumes waiting. The wait absorbs only `FEISHU_PROVIDER_UNAVAILABLE` and `FEISHU_PROVIDER_CONFIGURED_MISSING`, the two codes that say "no usable provider yet"; a provider that registers but cannot host the channel (`FEISHU_RECEIVE_UNSUPPORTED` and everything else) still fails loud at the earliest resolvable point — the thrown added-listener unwinds the provider's registration. There is deliberately NO load-order requirement left to document: the events make the ordering question disappear instead of pinning it.

## Alternatives considered

**Keep the synchronous resolve at `apply` and document "list the provider first".** Rejected: it claims a Loader ordering guarantee that does not exist — the deterministic boot failure this note fixes.

**Poll the registry until a provider appears.** Rejected: invents a private readiness protocol beside the one the framework already has (effect registration + disposal), and cannot notice a provider leaving, so an HMR reload would strand a channel bound to a disposed backend.

**Defer only the fail-loud check to the first approval ask.** Rejected: a misconfigured provider would boot clean and surface as a silent missing answerer at the first protected tool, violating the fail-loud-at-earliest-resolvable-point rule; the added-listener throw keeps the misconfiguration a load-time failure on the provider fiber.

## Consequences

- `feishu/provider-added`/`-removed` complete the seam's registry vocabulary: consumers deriving state from a named provider react to events instead of reading the registry at `apply` time; `dsh-feishu-approval` and `dsh-feishu-receive` are the reference implementations. See the [events catalog](../../../../docs/subsystems/feishu.md) and [producer/consumer map](../../../../docs/event-producer-consumer.md).
- **Addition fails loud; removal is contained.** An added-listener may unwind a registration; removed-listeners run during disposal, so consumers never throw there — both consumers close and re-open defensively, logging without failing the unloading fiber.
- **A window where a channel is closed.** While no usable provider is registered the consumers log a warning and cannot receive — but no Feishu chat agent exists then either (the receive router needs the same provider), so no card or message can be in flight. The honest state matches the absence.
