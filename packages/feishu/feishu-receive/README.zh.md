---
description: "从飞书（Feishu）聊天驱动 agent 会话：每个提供方一条接收订阅、每个聊天一个专属根会话、收到回执、引用消息与图片解析，以及卡片应答器复用的聊天 → agent 绑定。"
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu-receive

[English](README.md) | 中文

## 概述

在飞书聊天里与 harness 协作，而不在终端前。本包打开 seam 的接收通道，并在一个聊天的第一条消息上创建一个专属根 agent，复用当前活动会话的 preset、模型路由与工作目录，此后把该聊天的每条消息都路由给它。agent 运行之前，聊天会先收到回执，被引用的消息则解析为其文本与图片。每个发布的 agent 都以 `feishu/chat-agent` 宣告，因此审批与提问卡片才能送达同一个聊天。聊天 → 会话的钉定存在于内存，所以重启后每个聊天都从头开始。

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

在 [`@deepseek-ai/dsh-feishu`](../feishu/README.zh.md) 之后挂载本包，并配上可接收的提供方——在所有随产品发布的配置组合中，那个提供方就是 [`@deepseek-ai/dsh-feishu-bot`](../feishu-bot/README.zh.md)——同时设置 `cwd`，这样一个在任何本地会话存在之前就要写文件的聊天仍能落进真实的工作区。

### 何时选择它

只要人应当能从飞书开启一场对话，就选择本包；当模型只凭自己的主动性发送时就不要挂，那种场景 [`@deepseek-ai/dsh-tool-feishu`](../tool-feishu/README.zh.md) 单独即可覆盖。它不取代任何其他入口：同一进程继续服务终端与 Web GUI，每个飞书聊天只是在它们旁边多出一个根会话。

### 最小配置

```yaml
- insert:
    - id: feishu-receive
      name: '@deepseek-ai/dsh-feishu-receive'
      config:
        cwd: /path/to/workspace
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `cwd` | 无默认值 | 当活动根会话没有工作目录时，按聊天创建的 agent 使用的工作目录；两者皆无时，聊天的第一条消息被拒绝，直到存在一个工作目录 |
| `ack` | `true` | 在 agent 开始前用 `已收到，正在处理…` 回应每条 incoming 消息；回执发送失败只记录日志 |

活动根会话自己的目录在它存在时优先，因为一个没有工作目录就创建的会话会持久化在 `_no-cwd/` 之下。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-feishu-receive)是每个可接受字段的完整来源。

### 每个聊天一个 agent

每个聊天在进程内恰好拥有一个根会话，以一个全新的 `feishu-<uuid>` 会话 id 命名。那个 agent 以活动根会话实际组合出的 preset 挂载，因此携带相同的工具与人设，并且复制该会话的 agent 选项——聊天正是借此继承你已经在用的模型路由。模板在第一条消息上捕获，因此之后修改本地会话不会改写已经进行的对话。创建仍在飞行中时同一聊天到达的后续消息共享那一次创建，而失败的创建会被丢弃，让下一条消息重试，而不是留下一个死钉。

### 一条消息如何投递

incoming 事件在模型运行之前就被回应。回执发往解析出的回复目标——一对一聊天发给发送者自己的 id，群聊发给 `chat_id`，因为飞书拒绝在 p2p 会话里用 `chat_id` 发送。随后被引用或回复的父消息经由 seam 读出，并以 `[引用消息]` 块前置；两条消息中的图片被下载、检查是否为可识别的栅格格式，并通过 attachment 服务存储为模型可见的 `image` 块。其中的每一步都可能落空，而允许落空：没有读取支持的提供方、被删除的图片、未知格式、或未挂载 attachment 存储，都让文本保持完整并只记录日志，而不是阻塞投递。

### agent 被告知什么

模型写出的文本不会自己抵达飞书，因此每个按聊天的 agent 都注册一段系统提示词上下文（`feishu:chat-context`，order 130），写明自己的回复目标并指示模型通过 `feishu_send_message` 作答。agent 一旦发布，本包就发出携带 `{ agent, chatId }` 的 `feishu/chat-agent`，审批与提问应答器借此绑定到聊天而无需重新推导路由。当按应用的记忆服务被挂载时，新会话会钉定到接收该消息的机器人，使该聊天保持一个记忆身份。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

插件主体是一个持有两个映射的 effect：聊天 id → 飞行中的 agent 句柄，以及提供方 id → 接收处置器。两者都不落盘，这正是一个聊天在一个进程内保持一场对话、而重启后开始新对话的原因。

提供方逐一订阅，而不是经由聚合通道，因为同级插件并发激活。effect 先接收 seam 已列出的全部，然后在 `feishu/provider-added` 上订阅、在 `feishu/provider-removed` 上处置；这正是启动后经设置 UI 添加的机器人无需重新订阅——也无需向已有提供方重复投递——就能开始接收的原因。当另一个可接收的提供方存在时，一个可用但无法接收的提供方会被跳过；只有那个唯一提供方只能发送的配置组合才会以 `FEISHU_RECEIVE_UNSUPPORTED` 失败。

每条消息都在接收回调之外运行自己的异步链，因此一次慢的引用消息读取无法拖住通道；抛出异常的链按其聊天记录日志，而不会浮到提供方里。这里创建的每个句柄都随本插件的 fiber 一起处置，随之拆掉它启动的那些对话。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、提供方订阅生命周期、按聊天 agent 创建与消息组装 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [飞书子系统](../../../docs/subsystems/feishu.zh.md) — 本消费方所驱动的 seam、提供方契约与错误码。
- [按聊天路由决策](../../../.agents/notes/implemented/feature/2026-08-19-feishu-per-chat-receive-routing.zh.md) — 为什么一个聊天是一个根会话，以及 `feishu/chat-agent` 为何存在。
- [迟到机器人订阅决策](../../../.agents/notes/implemented/bug-fix/2026-09-14-feishu-receive-late-bot-subscription.zh.md) — 为什么通道跟随提供方生命周期事件而非加载顺序。
- [消息图片读取决策](../../../.agents/notes/implemented/feature/2026-08-24-feishu-message-image-reading.zh.md) — incoming 图片如何变成以 attachment 为支撑的内容块。
- [按应用记忆身份决策](../../../.agents/notes/implemented/feature/2026-08-23-per-feishu-app-tdai-memory-identity.zh.md) — 为什么会话要钉定到接收其消息的机器人。
- [feishu](../feishu/README.zh.md) — 本包订阅其提供方注册表的 seam。
- [tool-feishu](../tool-feishu/README.zh.md) — 每个按聊天的 agent 必须调用才能被听见的工具。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，经由本包构建的每个按聊天的会话：它注入的 user 消息与它注册的那一段按聊天提示词上下文都通过 agent loop 的请求组装抵达模型，由后者持有最终请求。

#### KV Cache effect

每场聊天对话新增一处：注入的 user 消息遵循会话日志只追加的语义，而按聊天上下文只在那个 agent 创建时写入一次，因此其他聊天后来的流量不会使其缓存失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **不跨重启恢复** — 聊天 → 会话的钉定在内存里，且每个会话 id 都是新的 UUID，因此重启给每个聊天一场新对话，而不是续上已持久化的日志。
- **无发送者归属** — 群聊消息只以其文本抵达，agent 无法分辨是哪位成员在说话；群聊内的按发送者归属尚未实现。
- **更新的飞书内容类型以文本或空抵达** — 读取把消息归约为文本、富文本、卡片与图片，因此飞书报告在这些形式之外的内容只以剥掉占位符后的残余抵达 agent。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随插件，因为它所参与的接收顺序在 seam 处强制执行。投递诊断刻意使用 `console.log` 而非 `ctx.logger`：默认 logger 缓冲在内存里且从不进入 Web 进程日志，而这些行正是区分"引用缺失"与"读取失败"的手段。

</details>
