# @deepseek-ai/dsh-feishu-receive

[English](README.md) | 中文

DeepSeek Harness 的飞书长连接接收消费方。把每个飞书聊天路由进各自的 agent 会话。

## 用途

启动 `ctx.feishu` 接收通道 —— 在已注册的飞书提供方上打开，或在尚无可用提供方注册时等待 `feishu/provider-added`（因为同级插件是并发加载的）——并在某个聊天首次发来消息时，为该聊天创建一个专属 root agent，然后把该聊天的每条消息作为用户 follow-up 注入到那个 agent。每个聊天的会话 id 都是全新的 `feishu-<uuid>`，聊天 → 会话的对应关系存放在内存映射里，因此同一个聊天在进程内复用同一个会话，重启后则重新开始（不做跨重启恢复）。该 agent 运行活跃会话的同一 preset —— 包括 `dsh-tool-feishu`，从而能在自己的聊天里回复 —— 并继承活跃会话的模型路由与工作目录。工作目录是必需的：接收通道必须在活跃 root 会话拥有 cwd 之后才能启动，否则任意聊天的首条消息会被拒绝（记入日志，不抛出），直到出现携带 cwd 的活跃 root。每个按聊天划分的 agent 会获得一个系统提示词上下文（`feishu:chat-context`，order 130），告知模型其飞书 chat id，并说明文本回复对用户不可见，除非通过 `feishu_send_message` 以 `receiveIdType: "chat_id"` 发送。每当一个按聊天划分的 agent 发布后，该消费方会发出 `feishu/chat-agent` 事件（`{ agent, chatId }`），以便其他飞书消费方——例如审批卡片应答器（`@deepseek-ai/dsh-feishu-approval`）——能绑定到存活的聊天 ↔ agent 路由，而无须自行重新推导。

### 配置

| 字段 | 类型 | 默认值 | 说明 |
| ---- | ---- | ------ | ---- |
| `cwd` | `string` | — | 当活跃 root agent 不存在或其 cwd 不可用时，按聊天划分 agent 的回退工作目录。未设置时，任意聊天的首条消息会被拒绝，直到出现携带 cwd 的活跃 root。在 `cordis.patch.yml` 中将其设为项目目录，接收通道即可在启动后立即可用。 |

## 依赖

要求组合中存在 `ctx.feishu`（飞书 seam）、`ctx.agents`（用于创建每个按聊天划分 agent 的 agent 注册表）、`ctx.agentPresets`（用于按活跃会话的 preset 组装每个 agent 的 roster）与 `ctx.systemPrompt`（用于注册按聊天划分的回复指导）。

## 模型体验

间接地，通过它注入到每个按聊天划分的会话日志的用户消息体现。该消费方自身不注册任何提示或 schema 内容。

#### KV Cache 影响

无直接失效；注入的消息遵循会话日志的仅追加语义。

## 已知局限与推迟工作

- **进程本地路由映射** —— 聊天 → 会话的对应关系在内存中、每次启动重建，且每个会话 id 都是全新 UUID，因此重启后每个聊天都会以新的会话开始（不保留跨重启历史）。
- **无发送者归属** —— 注入的消息只携带文本内容，不携带是哪位成员发送的；群聊中按发送者归属被推迟。