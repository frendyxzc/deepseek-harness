---
description: "为 agent 提供飞书消息工具：向任意接收者 id 发送消息，并可就地修订已发送的消息，支持文本与交互卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-feishu

[English](README.md) | 中文

## 概述

让模型拥有飞书的声音与修改的手。挂载飞书提供方后，agent 用 `feishu_send_message` 向任意接收者 id——`open_id`、`user_id`、`union_id`、`email` 或 `chat_id`——发送消息，并用 `feishu_update_message` 修订自己此前的回复而不重复刷屏。两个工具都接受纯文本或交互卡片，返回飞书消息 id，并共用一个协作式超时预算。发送与更新各自独立注册，分别由自己的配置开关控制。

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

在已经挂载 [`@deepseek-ai/dsh-feishu`](../feishu/README.zh.md) 并拥有可发送之提供方的配置组合里挂载本包——在所有随产品发布的配置组合中，那个提供方就是 [`@deepseek-ai/dsh-feishu-bot`](../feishu-bot/README.zh.md)。[`dsh.setup` 的 Web 配置补丁](../../../scripts/setup-dsh/templates/profile-web/cordis.patch.yml)以默认值挂载这两个工具。

### 何时选择它

当 agent 应当自主发起或修订飞书消息、而不只是回复已绑定的聊天时，挂载本包。来自飞书聊天的 incoming 回复还需要 [`@deepseek-ai/dsh-feishu-receive`](../feishu-receive/README.zh.md)；只挂工具是单向写出。当另一个消费方已经覆盖出站消息时就不要挂工具——同时注册会让模型在两个重复的发送者之间自行选择。

### 最小配置

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-feishu'
    - id: feishu-bot
      name: '@deepseek-ai/dsh-feishu-bot'
    - id: tool-feishu
      name: '@deepseek-ai/dsh-tool-feishu'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `send` | `true` | 注册 `feishu_send_message` 工具 |
| `update` | `true` | 注册 `feishu_update_message` 工具 |
| `timeoutMs` | `30000` | 两个已注册工具共用的协作式超时预算（毫秒） |

两个开关默认都是 `true`，且按 schema `timeoutMs` 必须是数值；生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-feishu)是每个可接受字段的完整来源。

### 两个工具做什么

`feishu_send_message` 通过 `ctx.feishu.sendMessage` 把 `content` 投递给 `receiveId`，并报告所创建消息的 id。省略的 `receiveIdType` 与 `msgType` 落到提供方的默认值 `open_id` 与 `text`；空白的 `receiveId` 或 `content` 在任何东西离开 harness 之前就让调用失败。`feishu_update_message` 替换 agent 此前已发送消息的内容，用发送返回的 `messageId` 定位——文本消息接受纯文本，交互卡片消息接受替换用的卡片 JSON。两次调用都是并发安全的：发送互不等待，各自保留自己的超时预算。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

本包是 `ctx.feishu` 之上的一个薄 Consumer：每个工具校验自己的参数、把网络调用委派给 seam 的提供方选择、并把结构化的 `{ messageId }` 输出格式化给模型。它从不触碰凭据、端点或提供方状态——那些属于 Service Definition 与提供方包的职责。每次注册还会追加一段系统提示词（`tool:feishu_send_message`、`tool:feishu_update_message`），让模型知道修订时应当更新而非重发。Host 卡片保持通用：`presentCall`/`presentResult` 展示接收者或消息 id 与所发送的内容，不泄露提供方细节。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置、两个工具的注册、提示词指导与呈现 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [飞书子系统](../../../docs/subsystems/feishu.zh.md) — 工具会向上呈现的 `ctx.feishu` 提供方契约与 `FeishuError` 分类。
- [feishu](../feishu/README.zh.md) — 真正执行每次调用的 seam。
- [feishu-receive](../feishu-receive/README.zh.md) — 绑定 incoming 聊天、让回复无需这些工具即可原路送回的消费方。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-feishu) — 两个工具的生成 schema 清单。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型看到什么

`feishu_send_message` 工具以如下 schema 注册：`receiveId`（必填）、`content`（必填）、`receiveIdType`（可选，`open_id`/`user_id`/`union_id`/`email`/`chat_id` 的字符串字面量枚举）与 `msgType`（可选，`text`/`interactive` 的字符串字面量枚举）。提供方把省略的 `receiveIdType` 默认为 `open_id`、`msgType` 默认为 `text`。`feishu_update_message` 工具以如下 schema 注册：`messageId`（必填）与 `content`（必填），包装 `ctx.feishu.updateMessage`，通过更新原消息而非重发来修订此前的回复。两个工具都返回结构化的 `{ messageId: string }` 结果，且下面每一段系统提示词都会追加到每个 agent 回合。

##### 系统提示词指导（feishu_send_message）

```markdown
Use the feishu_send_message tool to send messages through Feishu (飞书) chat. Provide the recipient's open_id, user_id, or chat_id, and the message content. Use this to notify users, report results, or communicate with team members.
```

##### 系统提示词指导（feishu_update_message）

```markdown
Use the feishu_update_message tool to replace the content of a Feishu (飞书) message you sent earlier, identified by its message id. Prefer updating the original message over sending a new one when revising or correcting a previous reply — the user keeps one conversation thread instead of duplicates. Interactive card messages can also be replaced this way.
```

#### Token 影响

固定 — 每段系统提示词在每个会话中都是一个稳定的段落。

#### KV Cache 影响

只追加 — 每段前缀稳定，不会使 KV 缓存复用失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **只有发送与更新** — `feishu_list_chats` 与 `feishu_read_messages` 尚未实现。
- **两个工具共用一个超时** — `timeoutMs` 被每个已注册工具共用；慢的发送与慢的更新无法分别设定预算。
- **提供方失败原样表现为工具错误** — `FeishuError` 分类以工具错误文本抵达模型；工具自身不做任何重试。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随插件：工具自身不持有任何可变注册表或事件序列，每个请求级别的不变式都属于执行它们的 `ctx.feishu` seam。

</details>
