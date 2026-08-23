# @deepseek-ai/dsh-feishu-bot

English | [中文](README.zh.md)

Feishu Bot API provider for `ctx.feishu`. Sends and updates messages through the Feishu Open API and receives messages and card button actions through ONE shared official long-connection client per provider. Configure one app with the flat credential fields, or several apps through `bots` — each entry registers its own provider so inbound chats route back to the app that received them.

## Purpose

Registers one `FeishuBotProvider` per configured app with `ctx.feishu` (the flat single-app id is `feishu-bot`), each under its own provider id. Authenticates with the Feishu `/auth/v3/tenant_access_token/internal` endpoint, sends messages through `/im/v1/messages`, updates a sent message through `PATCH /im/v1/messages/:message_id`, reads one message by id through `GET /im/v1/messages/:message_id`, and receives `im.message.receive_v1` events plus `card.action.trigger` card callbacks through `@larksuiteoapi/node-sdk`.

## Config

| Field | Type | Default | Description |
|---|---|---|---|
| `appId` | `string` | — | Literal Feishu App ID (wins over `appIdEnv`) |
| `appSecret` | `string` | — | Literal Feishu App Secret (wins over `appSecretEnv`) |
| `appIdEnv` | `string` | `FEISHU_APP_ID` | Credential reference resolved for each operation |
| `appSecretEnv` | `string` | `FEISHU_APP_SECRET` | Credential reference resolved for each operation |
| `baseURL` | `string` | `https://open.feishu.cn/open-apis` | Feishu Open API base URL |
| `bots` | `array` | — | Bot apps (settings-editable): each `{ id, appId?, teamId?, agentId? }` registers one provider under its own `id`; non-empty replaces the flat single app |
| `credentials` | `array` | — | Secrets per bot (composition-only): each `{ id, appSecret?, appSecretEnv?, appIdEnv?, baseURL? }` supplies the secrets a `bots` entry never carries |

## Multiple apps

When `bots` is non-empty, each entry becomes one provider under its own `id`, and the flat `appId` / `appSecret` fields serve as the fallback credentials. Secrets intentionally live in `credentials` (composition-only), not `bots`: the settings UI reads `bots` but cannot reply a redacted `role('secret')` value, so keeping them separate means editing a bot's `teamId` / `agentId` can never overwrite its secret. Inbound events carry both the resolved `appId` and the provider `id`, and the Feishu seam routes a reply to a chat back through the provider that received it.

## Credentials

The provider resolves each credential per operation in this order:
1. Literal `appId` / `appSecret` from config.
2. The `appIdEnv` / `appSecretEnv` credential reference through the Harness credentials service, falling back to the launch environment.

The tenant access token is cached and refreshed on expiry, with a 60-second safety margin.

## Receiving

`startReceiving(handler)` and `startReceivingCardActions(handler)` share ONE long-connection client (`@larksuiteoapi/node-sdk`), which dials OUT to Feishu and needs no public callback URL. The first subscriber — message or card-action — opens the connection; the last disposer closes it, so a message subscriber and a card-action subscriber never open two connections. `startReceiving` dispatches each `im.message.receive_v1` event, reducing text, rich-text (`post`), and interactive card (`interactive`) content to plain text and dropping messages with no readable content (other types and empty content). Each emitted `FeishuReceiveEvent` also carries the received `messageId` and, when present, the quoted / replied-to `parentId` and thread `rootId` so a consumer can resolve the referenced message. `startReceivingCardActions` dispatches each `card.action.trigger` callback as a `FeishuCardActionEvent` (operator open id, chat id, message id, and the tapped button's `value` payload passed through UNVALIDATED — consumers validate it against their own trusted state). Setup is asynchronous: connection or credential failures surface through the provider `status()` error state and the plugin logger.

## Reading a referenced message

`getMessage(messageId, signal?)` fetches one message by id through `GET /im/v1/messages/:message_id` and returns it as a `FeishuMessage` with its content extracted as plain text, plus its `parentId` / `rootId` when present. The extraction uses the same `text` / `post` / `interactive` reduction as `startReceiving`, so a quoted or replied-to message (including a rich-text or card message) is read the same way an inbound one is.

## Updating a sent message

`updateMessage(messageId, content, signal?)` replaces the content of a message this provider sent earlier — e.g. settling an interactive approval card after its buttons were consumed — through `PATCH /im/v1/messages/:message_id`. `content` carries the same encoding as the original send (a card JSON string for cards).

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-feishu`, which calls the provider backend through `ctx.feishu.sendMessage()` and surfaces the structured result or error to the model.

#### KV Cache effect

Independent — provider configuration changes do not affect model KV cache.

## Known Limitations and Deferred Work

- **Token refresh on 99991663/99991664** — the provider refreshes the tenant access token on expiry only; on-demand refresh when a request fails with an invalid-token error code is deferred.