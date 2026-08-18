# @deepseek-ai/dsh-feishu-bot

English | [中文](README.zh.md)

Feishu Bot API provider for `ctx.feishu`. Sends messages through the Feishu Open API and receives messages through Feishu's official long-connection client.

## Purpose

Registers the `FeishuBotProvider` with `ctx.feishu` under the id `feishu-bot`. Authenticates with the Feishu `/auth/v3/tenant_access_token/internal` endpoint, sends messages through `/im/v1/messages`, and receives `im.message.receive_v1` events through `@larksuiteoapi/node-sdk`.

## Config

| Field | Type | Default | Description |
|---|---|---|---|
| `appId` | `string` | — | Literal Feishu App ID (wins over `appIdEnv`) |
| `appSecret` | `string` | — | Literal Feishu App Secret (wins over `appSecretEnv`) |
| `appIdEnv` | `string` | `FEISHU_APP_ID` | Credential reference resolved for each operation |
| `appSecretEnv` | `string` | `FEISHU_APP_SECRET` | Credential reference resolved for each operation |
| `baseURL` | `string` | `https://open.feishu.cn/open-apis` | Feishu Open API base URL |

## Credentials

The provider resolves each credential per operation in this order:
1. Literal `appId` / `appSecret` from config.
2. The `appIdEnv` / `appSecretEnv` credential reference through the Harness credentials service, falling back to the launch environment.

The tenant access token is cached and refreshed on expiry, with a 60-second safety margin.

## Receiving

`startReceiving(handler)` starts Feishu's long-connection client (`@larksuiteoapi/node-sdk`), which dials OUT to Feishu and needs no public callback URL, then dispatches each `im.message.receive_v1` event to the handler. The provider extracts only text messages whose content decoded to non-empty; other message kinds and empty content are ignored. Setup is asynchronous: connection or credential failures surface through the provider `status()` error state and the plugin logger, and the returned disposer closes the connection.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-feishu`, which calls the provider backend through `ctx.feishu.sendMessage()` and surfaces the structured result or error to the model.

#### KV Cache effect

Independent — provider configuration changes do not affect model KV cache.

## Known Limitations and Deferred Work

- **Token refresh on 99991663/99991664** — the provider refreshes the tenant access token on expiry only; on-demand refresh when a request fails with an invalid-token error code is deferred.