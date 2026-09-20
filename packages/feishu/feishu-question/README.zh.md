---
description: "在飞书（Feishu）聊天中应答 agent 的提问：每次询问一张交互卡片、每个选项一个按钮、卡片级一次性 nonce、Plan 评审卡片，以及失败即关闭的超时、中止、超越与投递处理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu-question

[English](README.md) | 中文

## 概述

向飞书聊天里的人提问并等待。当绑定到某个聊天的 agent 调用 `ask_user_question` 或提交计划评审时，本包向该聊天发送一张交互卡片，每个选项一个按钮，等到每个问题都被点击后才结算这次询问，并把卡片重绘为"问题 → 答案"摘要。任何情况都不会失败开放：无人作答的卡片以 `ASK_TIMEOUT` 拒绝，结束的轮次以 `ASK_ABORTED`，该聊天里的新消息以 `ASK_CANCELLED`。没有飞书绑定的询问原样委派下去，因此非飞书会话保留既有界面。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已经挂载 [`@deepseek-ai/dsh-feishu`](../feishu/README.zh.md) 并拥有可接收卡片点击之提供方的配置组合里挂载本包——在所有随产品发布的配置组合中，那个提供方就是 [`@deepseek-ai/dsh-feishu-bot`](../feishu-bot/README.zh.md)——此外还需要把每个聊天绑定到 agent 的 [`@deepseek-ai/dsh-feishu-receive`](../feishu-receive/README.zh.md)，以及由 [`@deepseek-ai/dsh-user-questions`](../../interaction/user-questions/README.zh.md) 提供的 `userQuestions` 服务。[`dsh.setup` 的 Web 配置补丁](../../../scripts/setup-dsh/templates/profile-web/cordis.patch.yml)以默认的五分钟等待挂载本应答器。

### 何时选择它

当 agent 必须提问的那个人能在飞书里被联系到、而不在浏览器前时，挂载本包。它只认领属主 agent 已绑定到某个飞书聊天的询问，其余请求原样经由 waterfall 交下去，因此它可以与 Web 应答器并存，而不是取代对方。计划评审走同一条路径：`exit_plan_mode` 通过 `ctx.userQuestions` 呈现计划，于是挂载一次即可同时应答提问与评审。当配置组合里没有任何东西向用户提问时就不要挂载；此时 `ask_user_question` 调用会报告没有应答者接受该请求。

### 最小配置

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-feishu'
    - id: feishu-bot
      name: '@deepseek-ai/dsh-feishu-bot'
    - id: feishu-question
      name: '@deepseek-ai/dsh-feishu-question'
      config:
        timeoutMs: 300000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `300000` | 一张卡片等待最后一次必需点击的时长，超时则询问以 `ASK_TIMEOUT` 拒绝；必须是正的有限数值 |

`timeoutMs` 是唯一字段，且在加载时校验：非正或非有限的数值会抛错并使本插件的 fiber 失败，而不是永远等待。兄弟审批应答器提供 `fallbackChatId`，本包刻意不提供——问题只值得在 agent 正在对话的那个聊天里问。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-feishu-question)是每个可接受字段的完整来源。

### 卡片呈现什么

一张卡片承载整次询问。其头部写着 `The agent has a question`；当任一问题带有 plan-review 意图时，头部变成橙色的 `Plan review`。问题的 `detail`——评审时就是计划本身的 markdown——渲染在问题之上并截断到 8000 字符，随后每个问题显示自己可选的加粗小标题、问题正文，以及每个选项一条带说明的项目符号。每个选项都是一个按钮，第一个按钮样式为 primary；v1 卡片 schema 没有自由文本控件，因此没有选项的问题改为渲染一条提示，邀请用户在聊天里直接输入回答。

### 一次询问如何结算

一张卡片每次点击只回答一个问题。被点按钮的 `value` 回显卡片的 nonce、问题 id 与选项下标，而这次点击会先对照该 nonce 自己的记录核对——回显 nonce 相符、归属聊天、这个问题确实存在于本卡片、下标在范围内——然后才记录答案。被拒绝的点击不消耗任何东西，重复点击会替换该问题的答案而不是追加第二条，因此只有每个带选项的问题都有答案时询问才 resolve。其余路径全部失败关闭：预算耗尽是 `ASK_TIMEOUT`，轮次的 signal 被中止是 `ASK_ABORTED`，该聊天落入新消息或本插件被销毁是 `ASK_CANCELLED`——计划评审把这个码解读为用户拿回回合转而发言——卡片发不出去是 `ASK_UNDELIVERABLE`，存活卡片超过 256 张是 `ASK_BUSY`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

两个映射持有本包全部状态：会话 id → 聊天，以及卡片 nonce → 存活卡片及其历次点击累积的答案。这些内容都不落盘，这正是重启之后已送达的卡片只会失效而不会恢复的原因。

卡片点击通道与消息通道是该功能的前提，并且成对打开：先 `startReceivingCardActions()`，再 `startReceiving()`，若第二次调用报告尚未注册任何提供方，则回滚第一次。当本插件激活时尚无可用提供方——同级插件并发加载——它记录日志并等待 `feishu/provider-added`；而注册了却无法接收卡片动作的提供方会让自己那次注册显式失败。当这两个通道的提供方离开时，effect 会关闭并在剩余提供方上重新打开，或重新开始等待，且这次重开绝不会抛进正在卸载的 fiber。消息通道正是防止过期卡片活得比对话更久的机制：聊天里的任何新消息都会超越（supersede）该聊天的所有挂起卡片。

次序安排保护决定不被竞态吞掉。待决记录与应答 promise 在发送卡片之前就已存在，而返回的 promise 带有一个临时拒绝守卫，因此投递过程中的中止、超越或销毁仍能结算这个监听器返回的 promise。早于发送响应到达的结算会记下最终内容，并在 message id 一到手就重绘。`questionCard()`、`answerSummaryCard()` 与 `noteCard()` 是基于 v1 schema 的纯构建函数，`parseOptionAnswer()` 把攻击者可控的选项下标映射为至多一条 `{ id, selected: [label] }` 记录，因此伪造或越界的下标什么都答不了；这四者都被导出以供测试。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置校验、聊天绑定、卡片生命周期、点击与消息处理，以及 waterfall 监听器 |
| [`src/card.ts`](src/card.ts) | v1 提问、答案摘要与结果说明三类卡片构建函数 |
| [`src/answers.ts`](src/answers.ts) | 从一次被点击按钮的值解析选项下标的纯函数 |
| [`src/invariant.ts`](src/invariant.ts) | 本包预留的不变式伴随插件，安装函数为空并记录原因 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [飞书子系统](../../../docs/subsystems/feishu.zh.md) — 本消费方所驱动的提供方契约、`FeishuCardActionEvent` 与接收通道。
- [问题卡片决策](../../../.agents/notes/implemented/feature/2026-08-19-feishu-question-cards.zh.md) — 为什么聊天卡片能应答一次询问；下文开发备注标出该设计里已被源码取代的部分。
- [提供方生命周期事件](../../../.agents/notes/implemented/architecture/2026-08-19-feishu-provider-lifecycle-events.zh.md) — 尚无提供方时本插件所等待的注册事件。
- [`@deepseek-ai/dsh-user-questions`](../../interaction/user-questions/README.zh.md) — 其 `user-questions/request` waterfall 由本插件应答的服务。
- [`@deepseek-ai/dsh-tool-ask-user`](../../interaction/tool-ask-user/README.zh.md) — 面向模型、负责提问的工具。
- [`@deepseek-ai/dsh-plan-mode`](../../plan/plan-mode/README.zh.md) — 经由同一次询问呈现计划评审的消费方。
- [feishu-receive](../feishu-receive/README.zh.md) — 公告聊天 → agent 绑定的消费方。
- [feishu-approval](../feishu-approval/README.zh.md) — 同一聊天中应答受保护工具调用的兄弟应答器。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，经由 `@deepseek-ai/dsh-user-questions`：其 `UserQuestionService.ask()` 把解析后的答案交给等待中的 `ask_user_question` 调用或计划评审，与其他任何应答器给出的答案形式完全一致，而本应答器自身不注册任何提示词、schema 或日志行。

#### KV Cache effect

本包不产生任何影响：它不向任何会话日志追加内容，而模型读到的答案无论由哪个界面收集都是同一条 `{ id, selected }` 记录，因此挂载或移除本应答器只改变向人提问的位置。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **已结算卡片的重绘只是尽力而为** — `updateMessage` 失败会让按钮留在界面上，尽管询问已经结算；nonce 已从存活表中移除，因此迟到的点击无效，但在聊天里看起来仍未作答。
- **同时最多 256 张存活卡片** — 超出该上限的询问以 `ASK_BUSY` 拒绝，而不是堆积无界状态；单一全局上限之后并没有按聊天或按会话的配额。
- **一次点击代表整个聊天作答** — 校验覆盖 nonce 回显、归属聊天与问题 id，因此群聊中任何看到这张卡片的成员都能结算询问；按操作者区分的限制尚未实现。
- **只有点击能作答，且必须答齐** — v1 schema 没有文本控件，因此没有选项的问题无法从卡片作答，而改用输入会超越并取消这次询问，而不是补上一条 `custom` 答案。
- **重启不留任何状态** — 绑定与待决记录只存在于进程内存，因此销毁会把所有存活卡片结算为 `ASK_CANCELLED`，已送达的卡片成为孤儿。
- **点击通道需要可接收的提供方** — 没有 `startReceivingCardActions` 的提供方无法承载本插件，并且该失败表现为加载时那次提供方注册失败，而不是首次询问时才发现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包通过 `./invariant` 预留了不变式伴随插件，其安装函数为空：nonce → 待决问题的关系是私有的运行期状态，没有属于自己的权威事件序列，而已被回答的问题经由 `@deepseek-ai/dsh-user-questions` 与请求会话自己的工具结果呈现。

`MAX_PENDING_QUESTIONS`（256）与 `MAX_DETAIL_CHARS`（8000）是固定的安全上限，而不是 `Config` 字段，因为提高任一数值改变的是上文记录的失败模式，而不是表达某种部署偏好。提供方移除之后的重开与聊天绑定跟踪刻意与 [`feishu-approval`](../feishu-approval/README.zh.md) 保持一致；在第三个消费方证明值得共享一个 seam 之前，每个应答器都把自己的生命周期内联保留。

[原始决策记录](../../../.agents/notes/implemented/feature/2026-08-19-feishu-question-cards.zh.md)中有两点已不再描述本包：渲染器是 [`src/card.ts`](src/card.ts) 里"每个选项一个按钮"的 v1 卡片，而不是下拉框加勾选框的表单（因此这里从不读取 `formValue`）；而 `user-questions/request` 如今是普通 waterfall，被认领的询问会终止这条链，而不再与 Web 应答器竞争。卡片形状以及"某次询问由谁作答"请以源码为准，而不是那份记录。

</details>
