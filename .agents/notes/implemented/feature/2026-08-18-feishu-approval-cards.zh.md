# Agent Note：飞书审批卡片——飞书聊天 agent 的远程工具审批

Status: implemented

[English](2026-08-18-feishu-approval-cards.md) | 中文

## 问题

`dsh-feishu-receive` 把每个飞书聊天运行成各自的 agent 会话，但这些会话在终端前没有本地人类：当工具调用需要审批时，`approval/request` waterfall 没有任何能触达远程操作者的应答器，请求只能 fail-closed 为 `unavailable`，每个受保护工具都被阻塞。社区参考实现 [wz-heng/dsh-feishu-bridge](https://github.com/wz-heng/dsh-feishu-bridge) 用飞书交互卡片解决了这个问题；本 Note 把该机制移植到 harness 自身的能力 seam 上，而不是进程外的桥。

## 决策

机制横跨三个既有 seam 加一个新的消费方包：

- **飞书 seam（`dsh-feishu`）** 增加卡片动作面：`FeishuCardActionEvent`（operator open id、chat id、message id，以及被点击按钮的 `value`——攻击者可控的卡片数据，原样透传不校验）、`ctx.feishu.startReceivingCardActions(handler)` 与 `ctx.feishu.updateMessage(messageId, content, signal?)`。提供方缺少相应能力时抛 `FEISHU_RECEIVE_UNSUPPORTED` / `FEISHU_UPDATE_UNSUPPORTED`。
- **长连接提供方（`dsh-feishu-bot`）** 把 `card.action.trigger` 注册到与 `im.message.receive_v1` 相同的 `EventDispatcher`：消息与卡片动作订阅者共享同一条 WS 连接（首个订阅者打开，最后一个 disposer 关闭），`updateMessage` 通过 PATCH `/im/v1/messages/:message_id` 实现。
- **`dsh-feishu-receive`** 在发布每个按聊天划分的 agent 时发出 `feishu/chat-agent` 事件（`{ agent, chatId }`），让消费方直接绑定存活的聊天 ↔ agent 路由，而无须自行推导。
- **`dsh-feishu-approval`** 以 `prepend: true` 为每个被绑定的 agent 应答 `approval/request`——来自该事件的按聊天 agent，或在 `agent/created` 时经其会话 `parentSession` 链绑定的 subagent 后代。它向所属聊天发送交互卡片（工具名、截断后的理由、**Allow once** / **Deny** 按钮），为每个按钮铸造一次性 nonce，并在消费之前对照该 nonce 自身的记录——按钮动作、session id、聊天——校验点击，因此伪造的 value、被篡改的 session、跨聊天点击与重放的 nonce 都会被拒绝且不消耗。一次有效的 Allow 解析为 `allowed-once`；其余一切均 fail-closed：Deny → `rejected`，`timeoutMs`（默认 60 秒）内无人应答 → `rejected`，turn 被撤销 → `cancelled`，插件被处置 → 所有挂起卡片以 `cancelled` 结算。卡片无法送达时经 `next()` 委托给下一个应答器，而不是在这里失败。结算时通过 `updateMessage` 尽力重绘卡片。插件在可用提供方注册时打开其点击通道；当该提供方无法接收卡片动作时，使该注册响亮失败（[provider-lifecycle events](../architecture/2026-08-19-feishu-provider-lifecycle-events.zh.md)）。配置的 `fallbackChatId` 把应答扩展到没有飞书聊天绑定的会话（[回退聊天](2026-08-19-feishu-approval-fallback-chat.zh.md)）。

## 备选方案

**保留进程外的 Python 桥。** 否决：它在 harness 之外重复实现传输、凭据与 agent 路由，且无法观察会话生命周期；卡片动作通道与接收路由已打开的长连接共用同一条。

**用聊天内输入的命令审批（如 `approve`）。** 否决：纯文本命令与会话内容竞争，需要路由器并不携带的发送者归属，也没有原子的一次点击语义；卡片按钮自带 nonce，一次回调即结算。

**持久化挂起审批的存储。** 否决：挂起卡片本质上是短暂的——重启无法把一张存活卡片重绘进新的聊天状态——且持久的审计对（`approval/asked` / `approval/decided`）已经属于请求会话上的 `dsh-user-approval`。

**让 `dsh-feishu-receive` 自己拥有审批。** 否决：接收路由的职责是聊天 ↔ agent 路由；审批是独立的消费方，通过发布的 `feishu/chat-agent` 事件绑定，seam 也因此保持提供方可替换。

## 后果

- 无人值守的飞书聊天可以一次点击远程审批受保护工具；缺席、超时、撤销与投递失败全部 fail-closed（拒绝或委托），绝不放行。
- 卡片点击与消息共用同一条长连接——没有第二条连接，也不需要公网回调 URL。
- 结算重绘是尽力的：`updateMessage` 失败时原卡片仍然可见，但已消费的 nonce 使迟到的点击无效。
- 挂起审批存放在内存中，处置时以 `cancelled` 结算；重启会撤销它们，而不是复活过期卡片。
