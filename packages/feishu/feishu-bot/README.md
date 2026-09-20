---
description: "Run the Feishu Bot API behind ctx.feishu: one app or several bots, credential-resolved secrets, message send, update, read and image download, and long-connection chat and card callbacks."
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu-bot

English | [中文](README.zh.md)

## Summary

Send, revise, and read Feishu (飞书) messages and take card taps without exposing a public callback URL. This package registers one provider per configured app on `ctx.feishu`: a single app uses the flat fields, and `bots` registers several apps so each chat replies through the app that received it. Credentials resolve per operation through the credentials seam, so no secret needs to live in a configuration file, and the Web Settings IM tab edits bot identity while the process runs. Receiving dials out over one shared long connection, so a host behind NAT works.

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

Mount this package together with [`@deepseek-ai/dsh-feishu`](../feishu/README.md) and point `FEISHU_APP_ID` and `FEISHU_APP_SECRET` at one Feishu app that can send messages. It is the only shipped provider, so it carries every operation the seam offers, including receiving.

### When to choose it

Every composition that reaches Feishu mounts this package; the only real choice is how many apps it serves. Use the flat single-app fields when one app is enough, and use `bots` when several apps must each own their chats — the provider id is then the bot id, so `provider: <bot id>` pins a send to one app. Both the [`dsh.setup` Web profile patch](../../../scripts/setup-dsh/templates/profile-web/cordis.patch.yml) and the Web Settings IM tab assume this package; a different transport would replace it, not join it.

### Minimal configuration

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-feishu'
    - id: feishu-bot
      name: '@deepseek-ai/dsh-feishu-bot'
```

| Field | Default | Meaning |
|---|---|---|
| `appId` | unset | Literal App ID of the flat single app; wins over `appIdEnv` |
| `appSecret` | unset | Literal App Secret of the flat single app; wins over `appSecretEnv` |
| `appIdEnv` | `FEISHU_APP_ID` | Credential reference resolved for each operation |
| `appSecretEnv` | `FEISHU_APP_SECRET` | Credential reference resolved for each operation; per bot it defaults to a reference derived from the bot id |
| `baseURL` | `https://open.feishu.cn/open-apis` | Open API root; a value that cannot be parsed leaves the provider unavailable |
| `bots` | unset | Bot apps, editable through settings: each `{ id, appId?, teamId?, agentId? }` registers one provider under its own id |
| `credentials` | unset | Secrets and endpoint per bot, composition-only: each `{ id, appSecret?, appSecretEnv?, appIdEnv?, baseURL? }` |

A provider counts as available when both credentials have a source — a literal value or a reference — and the base URL parses. A reference that resolves to nothing still leaves the provider selectable, so its calls fail with `FEISHU_PROVIDER_CREDENTIAL_MISSING` and its status projection reports `state: 'unconfigured'`; the flat mount above therefore needs `FEISHU_APP_ID` and `FEISHU_APP_SECRET` to carry values. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-feishu-bot) is the exhaustive source for every accepted field.

### Several bots

```yaml
- insert:
    - id: feishu-bot
      name: '@deepseek-ai/dsh-feishu-bot'
      config:
        bots:
          - id: main
            appId: <FEISHU_APP_ID>
        credentials:
          - id: main
            appIdEnv: FEISHU_APP_ID
            appSecretEnv: FEISHU_APP_SECRET
```

A non-empty `bots` replaces the flat fields: each entry registers its own provider, and inbound events carry both the resolved App ID and the provider id, so a reply to that chat leaves through the same app. `bots` is the settings-editable half — the Web Settings IM tab writes the `feishu-bot` section, and a live change re-syncs the providers — while `credentials` is composition-only because the settings document redacts secret roles. When a `credentials` entry names no `appSecretEnv`, the reference defaults to `FEISHU_APP_SECRET` for the flat `feishu-bot` id and to `FEISHU_APP_SECRET_<BOT_ID>` (uppercased, non-alphanumerics replaced with `_`, prefixed with `BOT_` when the id begins with a digit) for every other bot. The IM tab stores each bot's secret under that same reference, so a secret typed there reaches the provider's next operation instead of waiting for a restart.

### Receiving, reading, and updating

Message events and card callbacks share ONE long-connection client that dials out to Feishu; the first subscriber — message or card-action — opens it, and the last disposer closes it, so two consumers never hold two connections for one app. Each inbound message reduces `text`, rich-text `post`, `interactive`, and `image` content to plain text plus image keys, records the quoted or thread parent when present, and drops a message with neither readable text nor images. Each card callback arrives as a `FeishuCardActionEvent` whose `value` is passed through unvalidated, because the tapping operator controls it.

`getMessage()` reads one message with `card_msg_content_type=user_card_content`, which returns a card's original JSON instead of the flattened client preview, so a referenced card is read as its markdown text. `getMessageResource()` downloads one image's bytes, and a deleted resource surfaces as `FEISHU_PROVIDER_ERROR` carrying Feishu's own `code` and `msg`. `updateMessage()` replaces a message this provider sent, carrying the same content encoding as the original send.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One class holds one app's provider; the plugin body turns config into the list of those classes. Nothing here caches a resolved credential beyond the current operation, so editing the settings section or the credential store changes the next call rather than requiring a remount.

Outbound calls are plain `fetch` requests against the Open API with a tenant access token header. The token is fetched from `/auth/v3/tenant_access_token/internal` and reused until 60 seconds before its stated expiry; the App ID and Secret are re-resolved whenever a token is actually minted. Failures normalize to `FEISHU_PROVIDER_ERROR` with Feishu's code and message, and a caller abort throws `FEISHU_ABORTED` rather than a transport error.

The receive channel is the only stateful part: one handler list per app, opened lazily by the first subscriber and closed by the last disposer, including the case where a disposer runs before the asynchronous setup finishes. Connection trouble never throws into a subscriber — it records the provider's last error, which the status projection reports, and the SDK reconnects.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin config, bot list, settings section, credential references, and provider registration |
| [`src/provider.ts`](src/provider.ts) | Open API calls, token cache, and the shared long-connection receive channel |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion reserved for this package, empty with its reason documented |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Feishu subsystem](../../../docs/subsystems/feishu.md) — the provider contract this class implements and the error codes it returns.
- [Long-connection receive decision](../../../.agents/notes/implemented/feature/2026-08-18-feishu-long-connection-receive.md) — why one dialed-out connection replaces a callback endpoint.
- [Named bot secret reference decision](../../../.agents/notes/implemented/bug-fix/2026-09-14-feishu-named-bot-secret-ref.md) — how a per-bot secret reference keeps bot edits from clobbering secrets.
- [Credential store boot race](../../../.agents/notes/implemented/bug-fix/2026-09-14-feishu-credential-store-boot-race.md) — why this plugin injects `credentials`.
- [feishu](../feishu/README.md) — the seam that selects this provider.
- [feishu-receive](../feishu-receive/README.md) — the consumer that subscribes these providers one by one.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-feishu`, which calls the seam and renders this provider's structured result or failure to the model without any prompt or schema of its own here.

#### KV Cache effect

None from this package: it contributes no request-prefix content, and a credential or endpoint change alters transport behavior while the model-visible text stays byte-identical.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Token refresh is scheduled, not reactive** — an expired-token failure mid-cache is reported as a provider error; refresh on a specific Feishu error code is deferred.
- **One app, one connection** — outbound requests share the process's default network configuration; no per-app proxy or `fetch` override is exposed.
- **Message types beyond text are reduced** — receiving and reading keep text, `post`, card, and image markers, so content types Feishu reports outside those arrive as placeholders or are dropped.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The package reserves its invariant companion through `./invariant`, whose installer is empty because no independent event sequence or mutable relation exists beyond what the seam enforces. `feishuAppSecretRef` is mirrored by the Web Settings IM client, so a change here must land in the same commit as the client's copy of the rule.

</details>
