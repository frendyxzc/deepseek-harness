# @deepseek-ai/dsh-tool-feishu

English | [中文](README.zh.md)

Model-facing `feishu_send_message` tool over `ctx.feishu`.

## Purpose

Registers the `feishu_send_message` tool and its system-prompt guidance. This package owns the tool schema, validation, result formatting, and presentation, never concrete providers.

## Config

| Field | Type | Default | Description |
|---|---|---|---|
| `send` | `boolean` | `true` | Register the `feishu_send_message` tool |
| `timeoutMs` | `number` | `30000` | Cooperative timeout budget (ms) for the tool |

## Model Experience

### Request context and condition

#### What the model sees

The `feishu_send_message` tool is registered with a schema accepting `receiveId` (required), `content` (required), `receiveIdType` (optional, string-literal enum over `open_id`/`user_id`/`union_id`/`email`/`chat_id`), and `msgType` (optional, string-literal enum over `text`/`interactive`). The provider defaults omitted `receiveIdType` to `open_id` and `msgType` to `text`. It returns a structured `{ messageId: string }` result. The system-prompt section below is appended to every agent turn.

##### System-prompt guidance

```markdown
Use the feishu_send_message tool to send messages through Feishu (飞书) chat. Provide the recipient's open_id, user_id, or chat_id, and the message content. Use this to notify users, report results, or communicate with team members.
```

#### Token effect

Fixed — the system-prompt section is a single stable paragraph per session.

#### KV Cache effect

Append-only — the section is prefix-stable and does not invalidate KV cache reuse.

## Known Limitations and Deferred Work

- **Single tool** — only `feishu_send_message` is implemented. `feishu_list_chats` and `feishu_read_messages` are deferred.
- **Card messages** — the `interactive` msgType is declared but the tool does not validate or construct Feishu card JSON schemas.