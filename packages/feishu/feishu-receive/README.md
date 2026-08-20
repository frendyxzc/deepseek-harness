# @deepseek-ai/dsh-feishu-receive

English | [中文](README.zh.md)

Feishu long-connection receive consumer for the DeepSeek Harness. Routes each Feishu chat into its own agent session.

## Purpose

Starts the `ctx.feishu` receive channel — opening on a registered Feishu provider, or waiting for `feishu/provider-added` when no usable provider has registered yet, since sibling plugins load concurrently — and, on the first message from a chat, creates a dedicated root agent for that chat, then injects every message from the chat as a user follow-up to that agent. Each chat's session id is a fresh `feishu-<uuid>`, and the chat → session pin lives in an in-memory map, so the same chat reuses one conversation within a process and starts anew after a restart (no cross-restart resume). The agent runs the live session's preset — including `dsh-tool-feishu`, which lets it reply in its own chat — and inherits the live session's model route and working directory. The working directory is required: the receive channel must be started after the live root session has a cwd, or the first message from any chat is rejected (logged, not raised) until a live root with a cwd is available. Each per-chat agent gets a system-prompt context (`feishu:chat-context`, order 130) that tells the model its Feishu chat id and that text responses are invisible to the user unless sent through `feishu_send_message` with `receiveIdType: "chat_id"`. Once a per-chat agent is published, the consumer emits the `feishu/chat-agent` event (`{ agent, chatId }`) so other Feishu consumers — e.g. the approval-card answerer (`@deepseek-ai/dsh-feishu-approval`) — can bind to the live chat ↔ agent routing without re-deriving it.

Every incoming chat message also gets a short acknowledgement ("已收到，正在处理…") sent to the chat before the per-chat agent starts, so the user gets immediate feedback that the message arrived. A failed acknowledgement is logged and never blocks delivery.

### Configuration

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `cwd` | `string` | — | Fallback working directory for per-chat agents when no live root agent exists or the live root has no cwd. Without this, the first message from any chat is rejected until a live root with a cwd appears. Set it to the project directory in `cordis.patch.yml` so the receive channel works immediately on startup. |
| `ack` | `boolean` | `true` | Reply to every incoming chat message with a short acknowledgement before the per-chat agent starts. A failed send is logged and never blocks delivery. |

## Dependencies

Requires `ctx.feishu` (the Feishu seam), `ctx.agents` (the agent registry used to create each per-chat agent), `ctx.agentPresets` (the roster used to assemble each agent with the live session's preset), and `ctx.systemPrompt` (to register per-chat reply guidance) to be present in the composition.

## Model Experience

Indirectly, through the user messages it injects into each per-chat session log. The consumer itself registers no prompt or schema content.

#### KV Cache effect

No direct invalidation; injected messages follow the session log's append-only semantics.

## Known Limitations and Deferred Work

- **Process-local routing map** — the chat → session pin is in-memory and rebuilt on each start, and each session id is a fresh UUID, so a restart begins each chat with a new conversation (no cross-restart history).
- **No sender attribution** — the injected message carries only the text content, not which member sent it; per-sender attribution inside a group chat is deferred.