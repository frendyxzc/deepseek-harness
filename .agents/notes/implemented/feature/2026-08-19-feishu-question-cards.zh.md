# Agent Note：飞书问题卡片——飞书会话 agent 的交互应答与及时反馈

Status: implemented

[English](2026-08-19-feishu-question-cards.md) | 中文

## 问题

`dsh-feishu-receive` 把每个飞书会话运行为独立的 agent 会话，但终端前没有本地人类：`ask_user_question` 的询问（以及走同一 seam 的 plan-mode 评审）找不到能触达远程操作者的应答器，ask 只能落到 Web host 注册的默认 provider——对纯聊天会话来说是错误的界面。另一方面，向机器人发消息的聊天用户在 agent 的第一条 `feishu_send_message` 到达之前得不到任何反馈，而一次修正回复要付出一条重复消息而非一次编辑。spring-agent 参考实现用飞书表单卡片与回复卡片更新解决了这两件事；本 note 把这些机制移植到 harness 自己的 seam 上，但不沿用其持久化 + 重启 run 的模型。

## 决策

两处 seam 扩展、一个新消费方包，以及两项及时反馈行为：

- **飞书 seam（`dsh-feishu`）**获得 `FeishuCardActionEvent.formValue`——被点击动作提交了卡片表单时携带的各表单控件值，与 `value` 一样是攻击者可控数据、负有相同的校验义务。`dsh-feishu-bot` 在 `action.form_value` 是 plain object 时透传它。多选、自由文本、多题一次提交全部由一次 form submit 承载。
- **user-questions seam（`dsh-user-questions`）**获得路由应答方：可选的 `accepts(request)` 谓词使一个 provider 成为路由应答方；`ask()` 把请求交给每个谓词接受它的路由应答方以及唯一的默认 provider，第一个人类回答胜出——其余应答通过派生 abort 信号撤回。未声明者继续竞争唯一的默认槽（`DUPLICATE_PROVIDER` 不变），因此 Web 的 apiproxy provider 零改动：飞书绑定的 ask 同时到达会话卡片与 Web UI，任一侧均可结算。
- **`dsh-feishu-question`** 注册一个路由 provider，认领所有属主 agent 已绑定到飞书会话的 ask——经 `feishu/chat-agent` 通告的每会话 agent，或在 `agent/created` 时经会话 `parentSession` 链绑定的后代 subagent——并渲染为交互式表单卡片：单选下拉框、多选每选项一个勾选框、每题恒附自由文本输入框。pending 登记先于发卡完成（与投递竞态到达的回调永不丢配）；提交按钮携带一次性 nonce，一次提交在消费之前先对照该 nonce 自己的记录校验——回显的 nonce、所属会话——因此伪造值、跨会话点击、重放都被拒绝且不消费。同一题上自由文本优先于选择；空提交保留卡片。有效提交 resolve 该 ask 并把卡片重绘为"问题 → 答案"摘要；其余路径全部失败关闭：`timeoutMs`（默认 300 秒）内无人作答 → `ASK_TIMEOUT`，回合被撤回 → `ASK_ABORTED`，同一会话的新消息以 `ASK_CANCELLED` 超越该会话所有挂起卡片（plan mode 将其解释为"用户转而发言——留在 plan mode"），插件卸载 → 所有挂起卡片结算为 `ASK_CANCELLED`。本路由未接受的 ask——属主 agent 无飞书绑定——仅交默认 provider，非飞书会话无需配置即保留原有 UI；飞书绑定的 ask 与默认 provider 竞速，人类可从会话卡片或 Web UI 任一侧作答。控件元素名派生自 nonce 前缀，因此重复提问永不与飞书的控件唯一 id 约束冲突。
- **`dsh-feishu-receive` 确认回执**：每条入站会话消息在每会话 agent 启动前先收到一条简短确认（"已收到，正在处理…"）；`ack` 默认 true，发送失败仅记日志——投递从不依赖它。
- **`dsh-tool-feishu` 更新工具**：`feishu_update_message(messageId, content)` 封装 `ctx.feishu.updateMessage`（与 `feishu_send_message` 并列注册，`update` 默认 true），其 system prompt 段落指导模型修订上一条回复时更新原消息而非重发。

## 曾考虑的替代方案

**移植 spring-agent 的持久化 + 重启 run 模型。**否决：harness 在进程内为每个会话保有一个常驻 agent；卡片回调到达时 ask Promise 即结算，不存在需要持久化的挂起问题或需要重启的 run。挂起卡片在卸载时结算为 `ASK_CANCELLED`；重启留下惰性孤儿卡片，而不是复活过期问题。

**每选项一个按钮（审批卡片风格）。**否决：多选与自由文本本来就需要表单，多题 ask 需要一次提交，`form_value` 在一次回调里承载全部；按钮无法表达打字答案。

**每个 host 选定唯一的默认 user-questions provider。**否决：Web host 需要同时拥有 apiproxy 默认与飞书应答器——`accepts` 使两者并存、`ask()` 让它们竞速，且默认槽的唯一性保持不变。

**cardkit 流式回复卡片。**推迟：v1 用整卡 `updateMessage` 替换近似进度体验；流式卡片留待后续。

## 后果

- 无人值守的飞书会话可以远程通过表单卡片回答 `ask_user_question` 与 plan-mode 评审；缺席、超时、撤回、超越、投递失败全部失败关闭，未绑定会话静默保留其默认 provider。
- 同时可从飞书与 Web UI 到达的会话会把每次提问同时显示在两个界面；第一个人类回答结算该提问，另一个应答经派生 abort 信号撤回。
- 聊天用户对每条消息立即得到反馈，并看到修正落在原处而非重复消息。
- 群聊仅校验会话 + nonce——所属会话中的任何人都可以回答；按操作者限制留待后续。
- `formValue` seam 字段是通用的：未来任何卡片消费方都可以构建表单而无需再次改 seam。
