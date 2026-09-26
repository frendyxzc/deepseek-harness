---
description: "在飞书聊天中审批受保护的工具调用：归属聊天里的 Allow/Deny 卡片、一次性按钮 nonce、失败即关闭的超时与取消，以及为没有聊天绑定的会话准备的备用聊天。"
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu-approval

[English](README.md) | 中文

## 概述

在手机上审批一个受保护的工具调用。当某个会话位于飞书聊天中——或它是该聊天下的子 agent——的 agent 需要审批时，本包向同一个聊天发送一张 **Allow once** / **Deny** 卡片，并依据被点击的按钮结算这次询问。每个按钮带有一次性 nonce，因此伪造的值、来自其他聊天的点击或重放都会被拒绝且不被消耗。任何情况都不会失败开放：无人点击的卡片在 `timeoutMs` 之后被拒绝，结束的轮次会取消询问。设置 `fallbackChatId` 之后，Web GUI、无头与 ACP 会话也能用同一个聊天审批。

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

在已经挂载 [`@deepseek-ai/dsh-feishu`](../feishu/README.zh.md) 并且拥有可接收卡片点击之提供方的配置组合里挂载本包——在所有随产品发布的配置组合中，那个提供方就是 [`@deepseek-ai/dsh-feishu-bot`](../feishu-bot/README.zh.md)。[`dsh.setup` 的 Web 配置补丁](../../../scripts/setup-dsh/templates/profile-web/cordis.patch.yml)以五分钟的等待和一个已配置的备用聊天挂载它。

### 何时选择它

当审批受保护操作的人可能不在浏览器前、但能在飞书里被联系到时，挂载本包。它只认领绑定到某个飞书聊天的会话以及备用聊天所发出的询问，其余请求原样经由 waterfall 交给下一位应答者，因此它可以与浏览器审批界面并存，而不是取代对方。当配置组合里没有任何东西需要审批，或某个聊天的操作者绝不应该被允许放行工具调用时，就不要挂载它；此时该聊天里 agent 的受保护调用只会无人应答并失败关闭。

### 最小配置

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-feishu'
    - id: feishu-bot
      name: '@deepseek-ai/dsh-feishu-bot'
    - id: feishu-approval
      name: '@deepseek-ai/dsh-feishu-approval'
      config:
        timeoutMs: 300000
        fallbackChatId: <FEISHU_CHAT_ID>
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `60000` | 一张卡片在被自动拒绝之前等待点击的时长；必须是正的有限数值 |
| `fallbackChatId` | 未设置 | 接收没有飞书聊天绑定之会话卡片的聊天；提供时必须非空，未设置则把这类询问交给下一位应答者 |

两个字段都在加载时校验：非正或非有限的 `timeoutMs`、空的 `fallbackChatId` 都会抛错并使本插件的 fiber 失败，而不是永远等待或发往一个无名聊天。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-feishu-approval)是每个可接受字段的完整来源。

### 哪个聊天应答

会话经由 [`dsh-feishu-receive`](../feishu-receive/README.zh.md) 为每个按聊天 agent 发出的 `feishu/chat-agent` 公告归属于某个聊天；子 agent 在 `agent/created` 时从自己的 `parentSession` 继承这一绑定，于是同一聊天下的整棵委派树都在该聊天应答。agent 被销毁时释放它的绑定。没有绑定的询问在配置了 `fallbackChatId` 时发往该聊天，而已有绑定的聊天始终优先于备用聊天。卡片本身写明工具、询问者被截断到 2000 字符的理由以及会话，并以 `interactive` 消息发往该聊天 id。

### 点击按钮会做什么

两张按钮在构建卡片时各自铸造 nonce，而一次点击会先与自己的 nonce 记录核对——期望的动作、会话 id 与归属聊天——然后才消耗那个 nonce。不匹配的点击被拒绝并记录日志，从而把后面一次合法点击保持完整；结算之后的点击是无效的，因此一张卡片恰好结算一次审批。点击 Allow 得到 `allowed-once`，点击 Deny 得到 `rejected`。超时回答 `rejected`，被中断的轮次回答 `cancelled`，销毁本插件会把所有存活卡片撤回为 `cancelled`。每次结算都通过 seam 的 `updateMessage` 用结果说明替换卡片；同时最多存在 256 张存活卡片，超出上限的询问会委派给下一位应答者。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

三个映射持有本包的全部状态：会话 id → 聊天、nonce → 待决卡片（同一张卡片的两个按钮指向同一条记录），以及按铸造顺序排列的存活卡片。这些内容都不落盘，这正是重启之后已送达的卡片只会失效而不会恢复的原因。

点击通道是该功能的前提。本插件在激活时通过 `startReceivingCardActions()` 打开它；当还没有可用提供方注册——同级插件并发加载——它记录日志并等待 `feishu/provider-added`，而注册了却无法接收卡片动作的提供方会让自己那次注册显式失败。当该通道的提供方离开时，effect 会在剩余提供方上重新打开，或重新开始等待，并且这次重开绝不会抛进正在卸载的 fiber。

投递与结算的次序经过安排，使竞态不会丢失决定。待决记录与应答 promise 在发送卡片之前就已存在，因此投递过程中的中止或销毁仍能结算这个监听器返回的 promise；发送失败会退役该记录并委派给下一位应答者，而不是在这里把询问失败关闭。结算会把记录标记为已结算、释放两个 nonce、清除定时器与中止监听器、恰好解析一次，并尽最大努力重绘卡片——重绘失败绝不会重新打开已经关闭的决定。每次询问都会把唯一的可用 provider 盖在卡片上，因此即便兄弟 fiber 的销毁次序无人保证，结算重绘仍能送达投递它的那个应用。`approvalCard()` 与 `noteCard()` 是纯构建函数，`tappedNonce()` 只从攻击者可控的值里读出 nonce；三者都被导出以供测试。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置校验、聊天绑定、nonce 记录、点击校验、卡片构建函数与 waterfall 监听器 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [飞书子系统](../../../docs/subsystems/feishu.zh.md) — 本消费方所驱动的提供方契约、`FeishuCardActionEvent` 与 `FeishuError` 错误码。
- [飞书审批卡片决策](../../../.agents/notes/implemented/feature/2026-08-18-feishu-approval-cards.zh.md) — 为什么一次卡片点击就能结算审批，以及 nonce 防住什么。
- [备用聊天决策](../../../.agents/notes/implemented/feature/2026-08-19-feishu-approval-fallback-chat.zh.md) — 为什么没有聊天绑定的会话仍然可以通过飞书审批。
- [审批 seam 决策](../../../.agents/notes/implemented/feature/2026-07-06-approval-seam.zh.md) — `approval/request` waterfall 及其各种结局。
- [提供方生命周期事件](../../../.agents/notes/implemented/architecture/2026-08-19-feishu-provider-lifecycle-events.zh.md) — 尚无提供方时本插件所等待的注册事件。
- [`@deepseek-ai/dsh-user-approval`](../../interaction/user-approval/README.zh.md) — 发起审批并记录 `approval/asked` / `approval/decided` 配对的服务。
- [feishu-receive](../feishu-receive/README.zh.md) — 公告聊天 → agent 绑定的消费方。
- [feishu-question](../feishu-question/README.zh.md) — 同一聊天中回答 agent 提问的兄弟应答者。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，经由 `@deepseek-ai/dsh-user-approval`：其 `ApprovalService` 持有面向模型的审批策略文本，以及请求会话上的 `approval/asked` / `approval/decided` 审计配对，而本应答者自身不添加任何提示词、schema 或日志行。

#### KV Cache effect

本包不产生任何影响：它不向任何会话日志追加内容，而模型读到的结局出自审批服务自己的审计配对，其文本无论由哪个界面应答都完全相同。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **已结算卡片的重绘只是尽力而为** — `updateMessage` 失败会让原始卡片留在原地；两个 nonce 已被消耗，因此迟到的点击依旧无效，但聊天可能短暂显示看起来仍可点击的按钮。
- **同时最多 256 张存活卡片** — 超出该上限的询问会委派给下一位应答者，而不是堆积无界状态；单一全局上限之后并没有按聊天或按会话的配额。
- **一次点击代表整个聊天作答** — 校验覆盖动作、会话与归属聊天，因此群聊中任何看到这张卡片的成员都能结算它；按操作者区分的限制尚未实现。
- **重启不留任何状态** — 绑定与待决记录只存在于进程内存，因此销毁会取消所有存活卡片，而已送达的卡片会变成无效。
- **点击通道需要可接收的提供方** — 没有 `startReceivingCardActions` 的提供方无法承载本插件，并且该失败表现为加载时那次提供方注册失败，而不是首次询问时才发现。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随插件：nonce → 决定的关系是私有的运行期状态，没有属于自己的权威事件序列，而持久的 `approval/asked` / `approval/decided` 配对属于 `@deepseek-ai/dsh-user-approval`，由它在那一侧断言。

`MAX_PENDING_CARDS`（256）与 `MAX_REASON_CHARS`（2000）是固定的安全上限，而不是 `Config` 字段，因为提高任一数值改变的是上文记录的失败模式，而不是表达某种部署偏好。提供方移除之后的重开与聊天绑定跟踪刻意与 [`feishu-question`](../feishu-question/README.zh.md) 保持一致；在第三个消费方证明值得共享一个 seam 之前，每个应答者都把自己的生命周期内联保留。

</details>
