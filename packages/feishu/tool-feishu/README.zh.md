# @deepseek-ai/dsh-tool-feishu

[English](README.md) | 中文

基于 `ctx.feishu` 的、面向模型的 `feishu_send_message` 工具。

## 用途

注册 `feishu_send_message` 工具及其系统提示引导。本包拥有工具 schema、校验、结果格式化与展示，从不拥有具体提供方。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `send` | `boolean` | `true` | 注册 `feishu_send_message` 工具 |
| `timeoutMs` | `number` | `30000` | 工具的协作超时预算（毫秒） |

## 模型体验

### 请求上下文与条件

#### 模型看到的内容

`feishu_send_message` 工具注册时的 schema 接收 `receiveId`（必填）、`content`（必填）、`receiveIdType`（可选，覆盖 `open_id`/`user_id`/`union_id`/`email`/`chat_id` 的字符串字面量 enum）以及 `msgType`（可选，覆盖 `text`/`interactive` 的字符串字面量 enum）。提供方把省略的 `receiveIdType` 默认为 `open_id`、`msgType` 默认为 `text`。它返回结构化结果 `{ messageId: string }`。下面的系统提示段落会附加到每个 agent 轮次。

##### 系统提示引导

```markdown
Use the feishu_send_message tool to send messages through Feishu (飞书) chat. Provide the recipient's open_id, user_id, or chat_id, and the message content. Use this to notify users, report results, or communicate with team members.
```

#### Token 影响

固定 —— 系统提示段落在每个会话中是单个稳定段落。

#### KV Cache 影响

仅追加 —— 段落前缀稳定，不会使 KV cache 复用失效。

## 已知局限与推迟工作

- **单一工具** —— 仅实现了 `feishu_send_message`。`feishu_list_chats` 与 `feishu_read_messages` 被推迟。
- **卡片消息** —— 已声明 `interactive` msgType，但工具不校验也不构造飞书卡片 JSON schema。