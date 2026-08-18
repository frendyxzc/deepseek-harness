# Agent Note: Feishu receive over the official long-connection client

Status: implemented

English | [中文](2026-08-18-feishu-long-connection-receive.zh.md)

## Problem

Webhook receive requires a Feishu-reachable callback URL: Feishu POSTs each event to a public HTTPS endpoint, which an intranet-only deployment cannot expose (and cannot prove ownership of with the URL-verification challenge). The original `dsh-feishu-bot` hand-rolled that webhook route — URL verification, body buffering, event extraction — on the composition's web server, alongside a separate hand-rolled REST send path.

## Decision

Receive uses Feishu's official SDK (`@larksuiteoapi/node-sdk`) long-connection client. The client dials OUT to Feishu, so no public callback URL is required and an intranet deployment works. `dsh-feishu-bot.startReceiving(handler)` builds a `WSClient` and an `EventDispatcher` registered for `im.message.receive_v1`, resolves credentials once, and returns a disposer that closes the connection. Transport selection is gone: `receiveMode`, the webhook route, `webhookPath`, and `verificationToken` config were removed, so there is exactly one receive transport.

## Alternatives considered

**Keep webhook and long-connection behind a `receiveMode` flag.** Rejected: a switch doubles the receive surface and its tests for no current need; the long-connection client covers every deployment the webhook did, without the callback-URL burden.

**Use the SDK for send too.** Deferred: the hand-rolled tenant-token + `/im/v1/messages` send path is already proven and tested, and migrating send to the SDK's high-level client is independent of the receive transport.

## Consequences

- `@larksuiteoapi/node-sdk` is a new runtime dependency of `dsh-feishu-bot`, and setup is asynchronous: connection or credential failures surface through the provider `status()` error state and the plugin logger, not a synchronous `startReceiving` throw.
- `dsh-feishu-receive` drops its `webServer` injection; the receive channel no longer waits for a web server before starting.
- `FeishuProviderStatus` drops `verificationTokenConfigured` and `webhookPath`; long-connection state surfaces through `receiveActive` and `lastError`.