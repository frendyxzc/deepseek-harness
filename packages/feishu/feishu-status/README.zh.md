---
description: "飞书 seam 有效连接状态的只读 Remote 投影：面向整个能力的一次 Remote 调用，加上每个已注册 bot 一条记录，两者都是显示安全且即时的，供 Host 状态界面使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu-status

[English](README.md) | 中文

## 概述

在状态界面里显示当前的飞书连接状态。本包注册 `feishuStatus` Remote 服务，包含两个调用：`status()` 报告整个能力的有效状态——选中了哪个提供方、该提供方如何描述自己，以及选择为何失败；`list()` 为多 bot 设置标签页报告每个已注册 bot 一条记录。两者都按需读取 `ctx.feishu`，因此视图描述的就是此刻的注册表，并且选择失败时都不会抛异常。数值以显示安全的形式抵达：提供方在值上线之前就会掩码 App ID 并把 secret 归约为布尔值。

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

把本包挂载在 [`@deepseek-ai/dsh-feishu`](../feishu/README.zh.md) 旁边——那是它唯一注入的服务——并放在服务 Web 客户端的那台 Host 上。它不注册提供方、不打开通道、不启动定时器，因此与其他飞书包不同，在 Remote 调用抵达之前它什么都不做。[`dsh.setup` 的 Web 配置补丁](../../../scripts/setup-dsh/templates/profile-web/cordis.patch.yml)正是因为这一点挂载它。

### 何时选择它

当某个进程必须向它所服务的客户端报告飞书健康度时挂载它——今天就是 Web 设置的 IM 标签页，为每个已配置 bot 渲染一行。在无头的配置组合里就不要挂载：仓库里没有别的东西消费 `feishuStatus`，而需要同一份信息的进程内插件会直接调用 seam 上的 `ctx.feishu.describeStatus()`，状态本来就在那里。

### 最小配置

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-feishu'
    - id: feishu-bot
      name: '@deepseek-ai/dsh-feishu-bot'
    - id: feishu-status
      name: '@deepseek-ai/dsh-feishu-status'
```

本插件不声明 `Config`，因此生成的[配置目录](../../../docs/config-catalog.zh.md)里没有它的章节：它报告的每个值都来自 seam，而"什么算健康"完全配置在 [`@deepseek-ai/dsh-feishu`](../feishu/README.zh.md) 以及应答 `status()` 的 bot 提供方里。

### 它发布什么

| Remote | 返回 | 读取自 |
|---|---|---|
| `feishuStatus.status()` | 一条 `FeishuStatusView`：`state`，以及可选的 `providerId`、`provider` 与 `selectionError` | `ctx.feishu.describeStatus()`，它套用与真实发送相同的选择规则却不抛异常 |
| `feishuStatus.list()` | 每个已注册提供方一条 `FeishuBotStatusView`，按注册顺序 | `ctx.feishu.listProviders()`，并 await 每个提供方自己的 `status()` |

`state` 取 `unavailable`、`unconfigured`、`connected` 或 `error` 之一。没有 `status()` 方法的提供方只由 `available()` 投影；`status()` 抛异常的提供方也退化到同一个兜底值而不是让整批失败，因此一个不健康的 bot 不会挡住其他 bot，此时 `appSecretConfigured` 与 `receiveActive` 报为 `false`。

### 谁在消费它

该服务仅供 Remote 使用：它刻意不声明进程内的 Cordis `Context` 合并，因此进程内代码看到的是 seam，只有 Remote 客户端看到这个 gateway。客户端包通过显式的 [`@deepseek-ai/dsh-api-remotes`](../../api/remotes/README.zh.md) 装配取用它的生成的 `./remote` 客户端与 `./types` 载荷类型，而 Web 设置的 IM 标签页经由 [`@deepseek-ai/dsh-client-ui-settings-im`](../../client/ui-settings-im/README.zh.md) 调用 `ctx.remote.feishuStatus.list()`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

一个类、一个服务键：`FeishuStatusGateway` 继承 `TypertRemoteService` 并使用 `feishuStatus` 命名空间，其 `@Remote('status')` 与 `@Remote('list')` 两个方法就是全部 API。Typert 由这些装饰器生成 Host 注册与带类型的客户端，这正是本包在 `.` 与 `./types` 之外还导出 `./typert` 和 `./remote` 的原因。

`status()` 投影的是一次 seam 调用。`ctx.feishu.describeStatus()` 会重跑 seam 的选择——包括其 `provider` 配置与 `DSH_FEISHU_PROVIDER` 覆盖——但绝不抛异常：无法选出任何提供方的 seam 返回 `state: 'error'` 并带上解释原因的 `selectionError`，本 gateway 原样转发。被选中提供方的 `FeishuProviderStatus` 也原样透传，因为让它显示安全的掩码是提供方自己的工作。

`list()` 则是扇出而非选择。它按注册顺序遍历提供方，并在一个吞掉失败的 `try` 里 await 每个 `status()`，因此不健康的提供方给出的是 `available()` 兜底值而不是错误。两个方法都用条件展开构造结果，把缺失的可选字段留在载荷之外而不是发成 null，于是线上形状与声明的可选类型一致。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | gateway 类、其服务键，以及两个 `@Remote` 投影 |
| [`src/types.ts`](src/types.ts) | `FeishuStatusView` 与 `FeishuBotStatusView`，客户端导入的载荷类型 |
| [`src/invariant.ts`](src/invariant.ts) | 本包预留的不变式伴随插件，安装函数为空并记录原因 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [飞书子系统](../../../docs/subsystems/feishu.zh.md) — 本 gateway 所投影的 `describeStatus()`、`FeishuProviderStatus` 与选择规则。
- [Typert 子系统](../../../docs/subsystems/typert.zh.md) — 一个 `@Remote` 方法如何变成 Host 注册与带类型的客户端。
- [IM 状态标签页决策](../../../.agents/notes/implemented/architecture/2026-08-18-feishu-im-status-tab.zh.md) — 本服务所服务的界面。
- [状态残留 error 修复](../../../.agents/notes/implemented/bug-fix/2026-09-14-feishu-stale-status-error.zh.md) — 为什么恢复后的接收连接必须改变提供方报告的内容。
- [Remote 方法调用](../../../.agents/notes/implemented/architecture/2026-08-02-typert-remote-method-calls.zh.md) — 每次 Remote 调用返回的 `ok` / `value` / `error` 信封。
- [feishu](../feishu/README.zh.md) — 持有本包所报告每个值的 seam。
- [feishu-bot](../feishu-bot/README.zh.md) — 其 `status()` 与接收通道填满按 bot 视图的提供方。
- [`@deepseek-ai/dsh-api-remotes`](../../api/remotes/README.zh.md) — 把生成的客户端暴露给 Web 包的装配。
- [`@deepseek-ai/dsh-client-ui-settings-im`](../../client/ui-settings-im/README.zh.md) — 调用 `feishuStatus.list()` 的标签页。

-----

<a id="model-experience"></a>
## 模型体验

没有影响，因为这个仅供 Host 的状态 gateway 不注册任何提示词、工具 schema、系统提示词章节或会话消息：它回答关于连接健康度的 Remote 调用，而模型请求路径不会读取。

#### KV Cache effect

本包不产生任何影响：它从不组装模型输入，也不向任何会话日志写入内容，因此挂载或移除它都不会改变请求前缀或重放的会话。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **只有即时状态** — 视图不携带失败历史，也没有订阅，因此界面靠重新查询刷新，两次调用之间发生的事情完全不可见。
- **`list()` 的上界就是提供方的质量** — 没有 `status()` 的提供方，或其 `status()` 抛异常的提供方，都由 `available()` 报告，并把 `appSecretConfigured` 与 `receiveActive` 记为 `false`，于是沉默的 bot 可能被读成空闲的 bot。
- **掩码提供方的责任** — 本 gateway 不追加任何脱敏，因此报告了未掩码值的提供方会把它发布给每个发问的 Remote 客户端。
- **今天只有 `list()` 有消费方** — `status()` 已生成、已测试并能应答调用，但随产品发布的 Web 界面读取的是按 bot 列表；面向整个能力的视图仍在等待自己的界面。
- **传输失败看起来像空注册表** — Typert 以值而非异常返回失败，而 IM 标签页把任何失败调用映射为空列表，因此客户端无法区分"没有 bot"与"Host 不可达"。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包通过 `./invariant` 预留了不变式伴随插件，其安装函数为空：这里的每个视图都直接投影自 seam 持有的状态，因此除 [`@deepseek-ai/dsh-feishu`](../feishu/README.zh.md) 已经拥有的关系之外，本包没有可断言的东西。

让两侧载荷改动保持同批。`src/types.ts` 是客户端导入的内容，而线上模型来自 `@Remote` 的返回类型，因此只改一处就会出现看不见该字段的客户端；`./typert` 与 `./remote` 是生成产物，绝不可手工编辑。`zod` 之所以是运行时依赖，只是因为那些生成产物会导入它——`src/` 之下没有任何代码用它做校验。

</details>
