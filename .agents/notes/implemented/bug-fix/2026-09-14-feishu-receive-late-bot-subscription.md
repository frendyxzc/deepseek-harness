# Agent Note: A Feishu bot added after the receive channel opens never receives messages

Status: implemented

English | [中文](2026-09-14-feishu-receive-late-bot-subscription.zh.md)

## Problem

`dsh-feishu-receive` opened the receive channel exactly once, when the first usable provider registered, and retained a single combined disposer. Its `feishu/provider-added` listener bailed out early whenever the channel was already open (`if (!waitingForProvider) return`), so a bot registered later — e.g. added through the settings multi-bot UI after boot, which registers live through `feishu-bot`'s settings `onChange` — was never subscribed to the receive channel. The bot's status tab still reported `connected`, because `FeishuBotProvider.status()` checks credential presence rather than whether a receive subscription exists, so the bot looked healthy while every message a user sent it went unanswered.

## Decision

The receive consumer keeps one subscription per provider, keyed by provider id, instead of one bulk `startReceivingAll` open. `FeishuRuntime` gains `startReceivingProvider(provider, handler)`, which wraps the handler with the same chat → provider reply-route recording `startReceivingAll` already applied and subscribes that one provider. `dsh-feishu-receive` subscribes every registered provider at load, adds each provider as `feishu/provider-added` fires — whether or not the channel already had a provider — and disposes only that provider's subscription on `feishu/provider-removed`. A provider that is available yet cannot receive still fails the registration loudly through the added-listener throw when it is the only candidate; alongside a receivable provider it is simply not subscribed, matching `startReceivingAll`.

## Alternatives considered

**Re-call `startReceivingAll` on every `provider-added`.** Rejected: each call wraps the handler afresh per provider, so it re-subscribes the providers already receiving with a new wrapper — double-delivering every message from the unchanged bots — and churns their long connections.

**Document "restart after adding a bot".** Rejected: the settings UI adds bots live, so a restart requirement would silently contradict the live-add surface and leave the failure invisible to the operator.

## Consequences

- A bot added through the settings multi-bot UI after boot now receives and replies to messages immediately, because its receive subscription and chat → provider reply route both exist as soon as its registration commits.
- Removing one provider no longer closes and re-opens every channel: the consumer disposes only the leaving provider's subscription, so the remaining bots' connections and in-flight delivery are undisturbed. The card-action consumer (`dsh-feishu-approval`) is unchanged and still waits for a provider and re-opens on removal, as its single-selected-provider channel tracks the [provider-lifecycle events](../architecture/2026-08-19-feishu-provider-lifecycle-events.md) it shares with this consumer.

## Testing

`packages/feishu/feishu-receive/tests/feishu-receive.spec.ts` adds a regression test that a message arriving on a bot registered after the channel opened still creates a per-chat agent and delivers to it, and updates the lifecycle tests to assert per-provider behavior: a second provider joins, a leaving provider's subscription is disposed, and a send-only provider is skipped alongside a receivable one.