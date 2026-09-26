---
description: "Drive agent sessions from Feishu (飞书) chats: one receive subscription per provider, one dedicated root session per chat, acknowledgements, quoted-message and image resolution, and a chat → agent binding the card answerers reuse."
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu-receive

English | [中文](README.zh.md)

## Summary

Work with the harness from a Feishu chat instead of a terminal. This package opens the seam's receive channel and, on a chat's first message, creates a dedicated root agent that reuses the live session's preset, model route, and working directory, then routes every later message to it. Before the agent runs, the chat is acknowledged and a quoted message is resolved into its text and images. Each published agent is announced with `feishu/chat-agent`, so approval and question cards reach the same chat. The chat → session pin is in-memory, so a restart starts each chat fresh.

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

Mount this package behind [`@deepseek-ai/dsh-feishu`](../feishu/README.md) and the provider that can receive — in every shipped composition that is [`@deepseek-ai/dsh-feishu-bot`](../feishu-bot/README.md) — and set `cwd`, so a chat that writes before any local session exists still lands in a real workspace.

### When to choose it

Choose this package whenever a human should be able to open a conversation from Feishu; leave it out when the model only sends on its own initiative, which [`@deepseek-ai/dsh-tool-feishu`](../tool-feishu/README.md) covers by itself. It replaces no other entry point: the same process keeps serving the terminal and the Web GUI, and each Feishu chat simply adds another root session beside them.

### Minimal configuration

```yaml
- insert:
    - id: feishu-receive
      name: '@deepseek-ai/dsh-feishu-receive'
      config:
        cwd: /path/to/workspace
```

| Field | Default | Meaning |
|---|---|---|
| `cwd` | no default | Working directory for per-chat agents when the live root session has none; without either, a chat's first message is rejected until a working directory exists |
| `ack` | `true` | Answer every incoming message with `已收到，正在处理…` before the agent starts; a failed acknowledgement only logs |

The live root session's own directory wins when it has one, because a session created without a working directory would persist under `_no-cwd/`. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-feishu-receive) is the exhaustive source for every accepted field.

### One agent per chat

Each chat owns exactly one root session inside the process, named by a fresh `feishu-<uuid>` session id. That agent is mounted with the preset the live root session actually composed, so it carries the same tools and persona, and it copies that session's agent options, which is how a chat inherits the model route you are already using. The template is captured on the first message, so changing the local session afterwards does not rewrite conversations already under way. Messages from one chat that arrive while creation is still in flight share that single creation, and a failed creation is dropped so the next message retries instead of leaving a dead pin behind.

### How a message is delivered

An incoming event is answered before the model runs. The acknowledgement goes to the resolved reply target — the sender's own id for a one-on-one chat, the `chat_id` for a group, because Feishu rejects `chat_id` sends in a p2p conversation. A quoted or replied-to parent is then read through the seam and prepended as a `[引用消息]` block, and images from either message are downloaded, checked for a recognized raster format, and stored through the attachment service as model-facing `image` blocks. Every part of that can miss, and missing is allowed: a provider without read support, a deleted image, an unknown format, or an unmounted attachment store leaves the text intact and logs instead of blocking delivery.

### What the agent is told

Text the model writes never reaches Feishu by itself, so each per-chat agent registers a system-prompt context (`feishu:chat-context`, order 130) that names its own reply target and instructs the model to answer through `feishu_send_message`. Once the agent is published, this package emits `feishu/chat-agent` with `{ agent, chatId }`, which is how the approval and question answerers bind to a chat without re-deriving the routing. When a per-app memory service is mounted, the new session is pinned to the bot that received the message, so that chat keeps one memory identity.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin body is one effect that owns two maps: chat id to in-flight agent handle, and provider id to receive disposer. Neither is persisted, which is why one chat keeps one conversation inside a process and starts a new one after a restart.

Providers are subscribed one at a time rather than through the aggregate channel, because sibling plugins activate in parallel. The effect takes whatever the seam already lists, then subscribes on `feishu/provider-added` and disposes on `feishu/provider-removed`; that is what lets a bot added through the settings UI after boot start receiving without re-subscribing — and double-delivering to — the providers already live. An available provider that cannot receive is skipped while another receivable provider exists, and only a composition whose single provider is send-only fails, with `FEISHU_RECEIVE_UNSUPPORTED`.

Each message runs its own asynchronous chain outside the receive callback, so a slow referenced-message read cannot stall the channel; a chain that throws is logged against its chat instead of surfacing in the provider. Every handle created here is disposed together with this plugin's fiber, which tears down the conversations it started.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, provider subscription lifecycle, per-chat agent creation, and message assembly |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Feishu subsystem](../../../docs/subsystems/feishu.md) — the seam, provider contract, and error codes this consumer drives.
- [Per-chat routing decision](../../../.agents/notes/implemented/feature/2026-08-19-feishu-per-chat-receive-routing.md) — why one chat is one root session and what `feishu/chat-agent` exists for.
- [Late bot subscription decision](../../../.agents/notes/implemented/bug-fix/2026-09-14-feishu-receive-late-bot-subscription.md) — why the channel follows provider lifecycle events instead of load order.
- [Message image reading decision](../../../.agents/notes/implemented/feature/2026-08-24-feishu-message-image-reading.md) — how inbound images become attachment-backed content blocks.
- [Per-app memory identity decision](../../../.agents/notes/implemented/feature/2026-08-23-per-feishu-app-tdai-memory-identity.md) — why a session is pinned to the bot that received its message.
- [feishu](../feishu/README.md) — the seam whose provider registry this package subscribes.
- [tool-feishu](../tool-feishu/README.md) — the tool every per-chat agent must call to be heard.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through each per-chat session this package builds: the user messages it injects and the one per-chat prompt context it registers reach the model through the agent loop's request assembly, which owns the final request.

#### KV Cache effect

One addition per chat conversation: the injected user messages follow the session log's append-only semantics, and the per-chat context is written once when that agent is created, so later traffic from other chats cannot invalidate it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No cross-restart resume** — the chat → session pin is in-memory and every session id is a fresh UUID, so a restart gives each chat a new conversation instead of continuing the persisted log.
- **No sender attribution** — a group message arrives as its text alone, so the agent cannot tell which member spoke; per-sender attribution inside a group is deferred.
- **Newer Feishu content types arrive as text or nothing** — reading reduces messages to text, rich text, cards, and images, so content Feishu reports outside those forms reaches the agent as a placeholder-stripped remnant.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No invariant companion is published because the receive order it participates in is enforced at the seam. Delivery diagnostics deliberately use `console.log` rather than `ctx.logger`: the default logger buffers in memory and never reaches the Web process log, where these lines are the way to tell a missing reference from a failed read.

</details>
