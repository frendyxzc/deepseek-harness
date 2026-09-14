# Agent Note: A Feishu bot's status stays "error" after its receive long connection recovers

Status: implemented

English | [中文](2026-09-14-feishu-stale-status-error.zh.md)

## Problem

`FeishuBotProvider.status()` reports `state: 'error'` whenever `lastError` is set. `lastError` was recorded by any operation failure but cleared only inside a successful `sendMessage` / `updateMessage` / `getMessage` / `getMessageResource`. The receive long connection sets `lastError` on its `onError` and start/setup failures, but `onReady` and `onReconnected` never cleared it. A receive-only bot that hit one transient connection or credential failure therefore showed "error" forever — its credentials and connection were healthy again, but nothing cleared the stale value, so the Settings IM tab reported a connection error the live state did not match.

## Decision

`FeishuBotProvider` clears `lastError` at the three points that prove the earlier failure no longer holds: the receive channel's `onReady`, the receive channel's `onReconnected`, and a successful `getAccessToken` tenant-token fetch. Sends keep clearing it on success as before.

## Alternatives considered

**Clear `lastError` on every successful operation.** Rejected: the field already models the most recent failure with success points that matter for the consumer; clearing on an unrelated `getMessage` success would drop a still-live send failure. The three added points each directly refute the specific failure classes the receive and auth paths record.

**Derive `state` from live `receiveActive` instead of `lastError`.** Rejected: `lastError` carries the failure reason the status surface and diagnostics rely on; replacing it with a boolean loses the message and does not cover send/auth failures.

## Consequences

- A bot whose receive channel reconnects (or whose credentials start authenticating again) returns to `connected` on the next status poll instead of pinning a stale "error".
- The status surface stays honest: `error` now means a failure the most recent relevant success has not yet cleared.

## Testing

`packages/feishu/feishu-bot/tests/provider.spec.ts` adds `clears a recorded connection failure when the connection re-establishes (onReady)`, which drives `onError` then `onReady` and asserts the status moves from `error` back to `connected`.