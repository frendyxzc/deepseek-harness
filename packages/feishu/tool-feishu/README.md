# @deepseek-ai/dsh-tool-feishu

English | [中文](README.zh.md)

Model-facing `feishu_send_message` and `feishu_update_message` tools over `ctx.feishu`.

## Purpose

Registers the `feishu_send_message` and `feishu_update_message` tools and their system-prompt guidance. This package owns the tool schemas, validation, result formatting, and presentation, never concrete providers.

## Config

| Field | Type | Default | Description |
|---|---|---|---|
| `send` | `boolean` | `true` | Register the `feishu_send_message` tool |
| `update` | `boolean` | `true` | Register the `feishu_update_message` tool |
| `timeoutMs` | `number` | `30000` | Cooperative timeout budget (ms) for the tools |

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

- **Send and update only** — `feishu_list_chats` and `feishu_read_messages` are deferred.
- **Card messages** — the `interactive` msgType is declared but the tool does not validate or construct Feishu card JSON schemas.