# Agent Note: A p2p reply in a multi-bot setup routes through the wrong provider

Status: implemented

English | [中文](2026-09-14-feishu-multi-bot-reply-routing.zh.md)

## Problem

Replies route back to the app that received the inbound message through `FeishuRuntime.chatProvider`, a `chatId → providerId` map populated on each received event. A reply to a group chat targets the chat id, which is the map's key, so group replies route correctly. A one-on-one (p2p) reply targets the sender's `open_id` instead (`resolveReplyTarget`), but only the chat id was recorded — the `open_id` lookup missed, fell through to provider selection, and with multiple usable providers either failed (`FEISHU_PROVIDER_AMBIGUOUS`) or routed through the wrong app.

## Decision

`FeishuRuntime.subscribeProviderReceiving` — the wrapper shared by `startReceivingAll` and `startReceivingProvider` — records the provider under every id a reply may target: the `chatId` always, and the `senderId` additionally when `chatType === 'p2p'`. `routeProvider` keeps its existing `request.providerId ?? chatProvider.get(request.receiveId)` lookup, which now resolves for a p2p reply because the sender id is recorded under the correct key.

## Alternatives considered

**Pass the provider id explicitly on every send.** Rejected: the model-facing `feishu_send_message` tool does not expose a provider id, and `feishu-receive` would still need the mapping for its own acknowledgement; double-keying keeps the routing server-side and invisible to the model.

**Key the routing map by the agent session instead of the receive id.** Rejected: the session already carries a bot binding for LLM identity (`bindSession`), but routing a reply requires a receive-id look-up the model supplies, so the map must stay keyed on reply targets.

## Consequences

- A p2p message received by one bot in a multi-bot deployment now replies through that bot, matching the group-chat path.
- Two bots sharing one chat remain inherently ambiguous: whichever bot receives last owns the `chatId` key, so messages the bots are in the same group may still cross-route. This is deliberate — one chat is one conversation, and separating two bots in one chat is out of scope.

## Testing

`packages/feishu/feishu/tests/feishu.spec.ts` adds `routes a one-on-one (p2p) reply back through the provider that received it`, which receives a p2p event (sender `ou_1`, chat `oc_1`) and asserts the open_id reply resolves through the receiving provider rather than the other registered provider.