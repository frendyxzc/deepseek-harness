# @deepseek-ai/dsh-feishu-question

[English](README.md) | 中文

DeepSeek Harness 的飞书问题卡片应答器。通过所属会话中的交互式表单卡片，应答来自飞书会话 agent 的 user-questions 询问。

## 用途

注册一个路由型 `ctx.userQuestions` provider，接受所有属主 agent 已绑定到飞书会话的 ask——由 [`dsh-feishu-receive`](../feishu-receive/README.md) 通过 `feishu/chat-agent` 事件通告的每会话 agent，或其后代 subagent（在 `agent/created` 时经由会话的 `parentSession` 链绑定）——并将其渲染为一张交互式表单卡片：每题一节、lark_md 标题，单选题用下拉框，多选题每个选项一个勾选框，且每题恒附一个自由文本输入框，让人始终可以打字代替选择。Plan-mode 评审（`intent: plan-review`）走同一流程，使用橙色 "Plan review" 头部，并把计划全文渲染进卡片正文。

每张卡片携带一个在构建时铸造的一次性 nonce，内嵌于提交按钮的 `value`；一次提交在消费之前先对照该 nonce 自己的记录校验——回显的 nonce、以及卡片发送到的会话——因此伪造值、被篡改的回显、来自其他会话的点击都会被拒绝且不消费 nonce。同一题上自由文本优先于选择；空提交不消费任何东西，卡片保留以待再次作答。一次有效提交以解析出的答案 resolve 该 ask，并把卡片重绘为"问题 → 答案"摘要；其余路径全部失败关闭：`timeoutMs` 内无人作答以 `ASK_TIMEOUT` reject，回合被撤回以 `ASK_ABORTED` reject，同一会话的新消息以 `ASK_CANCELLED` 超越（supersede）该会话所有挂起卡片（plan mode 将其解释为"用户转而发言——留在 plan mode"），插件卸载则把所有挂起卡片结算为 `ASK_CANCELLED`。pending 登记先于发卡完成，因此与投递竞态到达的回调永不丢配；同一时刻至多 256 张卡片存活，超出则 ask 以 `ASK_BUSY` reject。user-questions seam 让每个接受该 ask 的提供方竞速取得第一个回答，因此飞书绑定的 ask 由会话卡片或默认 provider（Web UI）当中人类先作答的一侧结算，一边作答即撤回另一边。本路由未接受的 ask——属主 agent 无飞书绑定——仅交默认 provider，非飞书会话无需任何配置即保留原有 UI。

卡片点击通道与消息通道都在已注册的飞书 provider 上打开。兄弟插件并发加载，因此当尚无可用 provider 注册时，插件等待 `feishu/provider-added` 再打开两条通道；注册但不能接收卡片动作的 provider 会大声失败——没有点击通道就不可能应答。

### 配置

| 字段 | 类型 | 默认值 | 说明 |
| ---- | ---- | ------ | ---- |
| `timeoutMs` | `number` | `300000` | 一张问题卡片等待提交的时长（毫秒），超时自动 reject。必须是正的有限数值。 |

## 依赖

需要 `ctx.feishu`（飞书 seam——发卡、接收卡片动作与消息、重绘已结算卡片）与 `ctx.userQuestions`（`@deepseek-ai/dsh-user-questions`，本插件注册进其路由 provider seam）。消费 `@deepseek-ai/dsh-feishu-receive` 声明的 `feishu/chat-agent` 事件，以及 `@deepseek-ai/dsh-agent` 的 `agent/created` / `agent/disposed` 通告。

## 模型体验

间接地，通过应答器返回给 `UserQuestionService.ask()` 的解析后答案发挥作用——与其他任何 provider 的答案一样，这些答案被送达等待中的 `ask_user_question` 工具调用或 plan-mode 评审。

#### KV Cache 影响

无；应答器自身不向任何会话日志追加内容。

## 已知限制与后续工作

- **已结算卡片的重绘是尽力的**——`updateMessage` 失败时原卡片保留；nonce 已消费，迟到的提交仍是惰性的，但会话中可能短暂残留看似可操作的控件。
- **至多 256 张存活卡片**——超出上限的 ask 以 `ASK_BUSY` reject。
- **群聊仅校验会话 + nonce**——所属会话中的任何人都可以回答卡片；按操作者限制留待后续。
- **挂起卡片不跨重启存活**——进程重启会卸载插件，把所有挂起卡片结算为 `ASK_CANCELLED`；飞书侧卡片成为惰性的孤儿。
- **卡片点击走 provider 的接收通道**——没有 `startReceivingCardActions` 的 provider 无法承载本插件（此类 provider 在点击通道打开时注册即大声失败）；长连接 provider 在消息与卡片动作订阅者之间共享同一条连接。
