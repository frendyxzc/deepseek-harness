# @deepseek-ai/dsh-feishu-approval

[English](README.md) | 中文

DeepSeek Harness 的飞书审批卡片应答器。通过所属聊天中的交互式 Allow/Deny 卡片，解析来自飞书聊天 agent 的工具审批请求。

## 用途

为每个绑定到某个飞书聊天的 agent 应答 `approval/request` waterfall——包括 [`dsh-feishu-receive`](../feishu-receive/README.md) 通过 `feishu/chat-agent` 事件通告的每聊天 agent，以及其后代 subagent（在 `agent/created` 时通过其会话的 `parentSession` 链绑定）。当被拥有 agent 的工具调用需要审批时，插件向所属聊天发送一张交互卡片：工具名、提问方的理由（上限 2000 字符），以及 **Allow once** / **Deny** 按钮。每个按钮携带一个在构建卡片时铸造的一次性 nonce；点击会先对照该 nonce 自身的记录——按钮动作、session id 与聊天——校验**之后**才消费，因此伪造的 value、被篡改的 session、来自其他聊天的点击或重放的 nonce 都会被拒绝且不消耗该 nonce。一次有效的 Allow 点击把审批解析为 `allowed-once`；其余一切均 fail-closed：Deny 点击解析为 `rejected`，无人应答的卡片在 `timeoutMs` 后解析为 `rejected`，被撤销的 turn 解析为 `cancelled`，插件被处置时把所有挂起卡片以 `cancelled` 撤销。当卡片完全无法送达时，该请求会委托给下一个已组合的应答器，而不是在这里失败。每次解析都会通过 seam 的 `updateMessage` 尽力把卡片重绘为结果；插件先于任何兜底应答器被咨询（以 `prepend: true` 注册），同时把它不拥有的每个请求经 `next()` 委托出去。

卡片点击通道在已注册的飞书提供方上打开。同级插件是并发加载的，因此当尚无可用提供方注册时，插件会等待 `feishu/provider-added`，届时再打开通道；已注册但无法接收卡片动作的提供方会使其注册响亮失败——没有点击通道就无法应答。

配置了 `fallbackChatId` 时，没有飞书聊天绑定的会话——从 Web GUI、headless 或 ACP 触发的会话——的审批请求也会以一张卡片在该聊天中应答，使远程操作者可以审批不是经飞书触发的工作。已绑定的聊天始终优先于回退聊天；回退卡片携带同样的一次性 nonce，且只能由该回退聊天内部的点击解析。未配置 `fallbackChatId` 时，未绑定会话的审批委托给下一个已组合的应答器。

### 配置

| 字段 | 类型 | 默认值 | 描述 |
| ----- | ---- | ------- | ----------- |
| `timeoutMs` | `number` | `60000` | 一张审批卡片等待点击的时长，超时后自动拒绝。必须是正的有限数值。 |
| `fallbackChatId` | `string` | 未设置 | 接收"无飞书聊天绑定的会话"（Web GUI、headless、ACP）审批卡片的飞书聊天。省略 = 未绑定会话的审批委托给下一个应答器。提供时必须是非空聊天 id。 |

## 依赖

需要 `ctx.feishu`（飞书 seam——发送卡片、接收卡片动作、重绘已解析卡片）与 `ctx.approval`（`@deepseek-ai/dsh-user-approval`，本插件应答其 `approval/request` waterfall）。消费 `@deepseek-ai/dsh-feishu-receive` 声明的 `feishu/chat-agent` 事件，以及 `@deepseek-ai/dsh-agent` 的 `agent/created` / `agent/disposed` 通告。

## 模型体验

间接地，通过 `ApprovalService` 发挥作用——后者拥有面向模型的审批策略文本以及请求会话上持久的 `approval/asked` / `approval/decided` 审计对，而应答器自身从不添加模型可见内容。

#### KV Cache 影响

无；应答器自身不向任何会话日志追加内容。

## 已知限制与待办

- **已解析卡片的重绘是尽力的**——`updateMessage` 失败时原卡片保留；nonce 已被消费，迟到的点击仍然无效，但聊天中可能短暂显示看似可操作的按钮。
- **最多 256 张活跃卡片**——超出上限的审批请求会委托给下一个应答器，而不是铸造新卡片。
- **卡片点击经由提供方的接收通道**——没有 `startReceivingCardActions` 的提供方无法承载本插件（点击通道打开时，该提供方的注册响亮失败）；长连接提供方在消息与卡片动作订阅者之间共享同一条连接。
