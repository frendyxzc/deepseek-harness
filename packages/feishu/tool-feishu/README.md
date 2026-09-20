---
description: "Give the agent Feishu (飞书) messaging tools: send a message to any recipient id and revise a sent message in place, over text and interactive cards."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-feishu

English | [中文](README.zh.md)

## Summary

Give the model a Feishu voice and an edit hand. With a Feishu provider mounted, the agent sends `feishu_send_message` to any recipient id — `open_id`, `user_id`, `union_id`, `email`, or `chat_id` — and revises its own earlier replies with `feishu_update_message` instead of posting duplicates. Both tools take plain text or an interactive card, return the Feishu message id, and run under one cooperative timeout budget. Send and update register independently, each behind its own config switch.

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

Mount this package in the composition that already carries [`@deepseek-ai/dsh-feishu`](../feishu/README.md) and a provider that can send — in every shipped composition that is [`@deepseek-ai/dsh-feishu-bot`](../feishu-bot/README.md). The [`dsh.setup` Web profile patch](../../../scripts/setup-dsh/templates/profile-web/cordis.patch.yml) mounts both tools with their defaults.

### When to choose it

Add this package when the agent should initiate or revise Feishu messages on its own, not only reply to a bound chat. Incoming replies in a Feishu chat need [`@deepseek-ai/dsh-feishu-receive`](../feishu-receive/README.md) as well; the tools alone write one way. Leave the tools out when another consumer already covers outbound messages — registering both lets the model choose between duplicate senders.

### Minimal configuration

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-feishu'
    - id: feishu-bot
      name: '@deepseek-ai/dsh-feishu-bot'
    - id: tool-feishu
      name: '@deepseek-ai/dsh-tool-feishu'
```

| Field | Default | Meaning |
|---|---|---|
| `send` | `true` | Register the `feishu_send_message` tool |
| `update` | `true` | Register the `feishu_update_message` tool |
| `timeoutMs` | `30000` | Cooperative timeout budget (ms) shared by both registered tools |

Both switches default to `true`, and `timeoutMs` must be a number by schema; the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-feishu) is the exhaustive source for every accepted field.

### What the tools do

`feishu_send_message` delivers `content` to `receiveId` through `ctx.feishu.sendMessage` and reports the created message id. Omitted `receiveIdType` and `msgType` fall to the provider defaults `open_id` and `text`; a blank `receiveId` or `content` fails the call before anything leaves the harness. `feishu_update_message` replaces the content of a message the agent already sent, identified by the `messageId` the send returned — text messages take plain text, and an interactive card message takes its replacement card JSON. Both calls are concurrency-safe: sends do not wait on each other, and each keeps its own timeout budget.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package is one thin Consumer over `ctx.feishu`: each tool validates its arguments, delegates the network call to the seam's provider selection, and formats the structured `{ messageId }` output for the model. It never touches credentials, endpoints, or provider state — those are the Service Definition and provider packages' concern. Each registration also appends one system-prompt section (`tool:feishu_send_message`, `tool:feishu_update_message`) so the model learns when to prefer updating over resending. Host cards stay generic: `presentCall`/`presentResult` show the recipient or message id and the sent content without leaking provider detail.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, both tool registrations, prompt guidance, and presentation |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion reserved for this package, empty with its reason documented |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Feishu subsystem](../../../docs/subsystems/feishu.md) — the `ctx.feishu` provider contract and `FeishuError` taxonomy the tools surface.
- [feishu](../feishu/README.md) — the seam whose provider executes every call.
- [feishu-receive](../feishu-receive/README.md) — the consumer that binds incoming chats so replies route back without these tools.
- [tool-catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-feishu) — the generated schema listing for both tools.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

The `feishu_send_message` tool is registered with a schema accepting `receiveId` (required), `content` (required), `receiveIdType` (optional, string-literal enum over `open_id`/`user_id`/`union_id`/`email`/`chat_id`), and `msgType` (optional, string-literal enum over `text`/`interactive`). The provider defaults omitted `receiveIdType` to `open_id` and `msgType` to `text`. The `feishu_update_message` tool is registered with a schema accepting `messageId` (required) and `content` (required), wraps `ctx.feishu.updateMessage`, and revises a previous reply by updating the original message instead of resending. Both tools return a structured `{ messageId: string }` result, and each system-prompt section below is appended to every agent turn.

##### System-prompt guidance (feishu_send_message)

```markdown
Use the feishu_send_message tool to send messages through Feishu (飞书) chat. Provide the recipient's open_id, user_id, or chat_id, and the message content. Use this to notify users, report results, or communicate with team members.
```

##### System-prompt guidance (feishu_update_message)

```markdown
Use the feishu_update_message tool to replace the content of a Feishu (飞书) message you sent earlier, identified by its message id. Prefer updating the original message over sending a new one when revising or correcting a previous reply — the user keeps one conversation thread instead of duplicates. Interactive card messages can also be replaced this way.
```

#### Token effect

Fixed — each system-prompt section is a single stable paragraph per session.

#### KV Cache effect

Append-only — each section is prefix-stable and does not invalidate KV cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Send and update only** — `feishu_list_chats` and `feishu_read_messages` are deferred.
- **One timeout for both tools** — `timeoutMs` is shared by every registered tool; a slow send and a slow update cannot budget differently.
- **Provider failures pass through as tool errors** — the `FeishuError` taxonomy reaches the model as the tool's error text; the tool adds no retry of its own.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This package reserves its invariant companion through `./invariant`, whose installer is empty: the tools hold no mutable registry or event sequence of their own, and every request-level invariant belongs to the `ctx.feishu` seam that executes them.

</details>
