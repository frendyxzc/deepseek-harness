---
description: "在配置组合中承载飞书会话能力：提供方注册与逐次调用选择，发送、更新、读取，以及会话消息与卡片点击的接收通道，外加状态投影。"
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu

[English](README.md) | 中文

## 概述

只要配置组合需要飞书（Feishu）会话，就必须挂载本包。它承载 `ctx.feishu`：提供方在此注册，每次调用在此选择提供方，消费方在此完成发送、更新、读取、接收会话消息与卡片点击以及投影连接状态，且无需引入飞书 SDK。选择在每次执行时解析，因此稍后出现的提供方，或失去凭据的提供方，改变的是下一次调用而不是配置组合本身。本包不含任何传输实现；请一并挂载 `@deepseek-ai/dsh-feishu-bot`。

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

在任何读写飞书会话的配置组合中挂载本包一次，并至少搭配一个提供方。若没有任何提供方注册，所有操作都以 `FEISHU_PROVIDER_UNAVAILABLE` 失败，`describeStatus()` 也报告 `state: 'unavailable'`。

### 何时选择它

本包就是能力本身，不是其他包的替代品：配置组合要么挂载它，要么完全没有飞书会话。真正需要选择的是提供方——`@deepseek-ai/dsh-feishu-bot` 是唯一随产品发布的实现，而新的传输方式是通过 `ctx.feishu.registerProvider()` 注册自己，不是再建一份注册表。本仓库中的消费方是 [`dsh-feishu-receive`](../feishu-receive/README.zh.md)（入站会话）、[`dsh-tool-feishu`](../tool-feishu/README.zh.md)（面向模型的发送）、两个卡片应答方，以及 [`dsh-feishu-status`](../feishu-status/README.zh.md)（浏览器投影）；它们只通过自身的 `inject` 依赖本包。

### 最小配置

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-feishu'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | 未设置，其次 `$DSH_FEISHU_PROVIDER` | 每次操作使用的提供方 id；未设置时，若恰好有一个已注册且可用的提供方则自动选中它 |

随产品发布的配置组合在只有一个 bot 时留空 `provider`。当注册了多个 bot 且必须由其中一个负责发送时再显式设置。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-feishu)是所有可接受字段的完整来源。

### 提供方选择

选择在执行期解析，绝不依赖加载或配置顺序，且每种结果都有各自的稳定错误码：

- 已配置的 id 既已注册又 `available()` → 选择该提供方。
- 已配置的 id 未注册 → `FEISHU_PROVIDER_CONFIGURED_MISSING`。
- 已配置的 id 已注册但不可用 → `FEISHU_PROVIDER_CONFIGURED_UNAVAILABLE`。
- 未配置且恰好有一个可用提供方 → 选择该提供方。
- 未配置但有多个可用提供方 → `FEISHU_PROVIDER_AMBIGUOUS`，并在消息中列出候选。
- 未配置且没有可用提供方 → `FEISHU_PROVIDER_UNAVAILABLE`。

### 消费方能做什么

`sendMessage()` 在回到选择规则之前先看请求自身的历史：显式 `providerId` 优先，否则使用最近一次投递该 `receiveId` 的提供方，因此群聊的回复仍由收到消息的那个应用发出。若路由到的 id 此后被注销，则以 `FEISHU_PROVIDER_CONFIGURED_MISSING` 失败。`updateMessage()`、`getMessage()` 与 `getMessageResource()` 都经选中的提供方完成修改、读取与下载，一旦该提供方未实现对应操作，就抛出各自的 `*_UNSUPPORTED` 错误码。

接收提供三种订阅方式，因为“该由哪个提供方与飞书通信”对不同消费方有不同答案：`startReceiving()` 打开选中提供方的通道，`startReceivingAll()` 打开所有可用且支持接收的提供方，`startReceivingProvider()` 只打开你已持有的那一个提供方——当 bot 可能在启动之后才添加时，消费方就用这一种为新来的提供方订阅，而不必重新订阅已在投递消息的 bot。三者都会记录每个事件的回复目标与提供方，唯独 `startReceiving()` 不记录，回复路由仍交给选择规则。卡片点击通过 `startReceivingCardActions()` 到达，复用的正是消息订阅者打开的同一条通道而绝非第二条，因此不支持卡片的提供方会在订阅时报 `FEISHU_RECEIVE_UNSUPPORTED`。

`describeStatus()` 回答同一组选择问题但从不抛出异常：选择失败以 `state: 'error'` 和 `selectionError` 呈现，而展示安全的细节来自提供方自身的 `status()` 投影。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

这一设计只保留两条事实：一张以提供方 id 为键的注册表，以及一张由来站事件填充的“回复目标 → 提供方”映射。每个公开方法都在调用时刻经由其中之一解析，这正是消费方无需缓存提供方的原因。

注册是唯一的变更动作，并且是事务性的。`registerProvider()` 在一个 effect 生成器内装入条目，随后发出 `feishu/provider-added`；任何抛出异常的监听者都会回滚这次注册，于是无法服务某个提供方的消费方只会拒绝该提供方的注册，而不会拖垮启动。其释放函数——在注册方 fiber 卸载时运行——发出带 id 的 `feishu/provider-removed`。以同一个 id 再次注册会抛出 `FEISHU_DUPLICATE_PROVIDER`，而不会替换先前的条目。`listProviders()` 按注册顺序返回全部提供方。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、注册表、选择、接收订阅及状态投影 |
| [`src/types.ts`](src/types.ts) | `FeishuProvider` 契约、请求与结果词汇、状态视图、`FeishuError` |

类型词汇——接收 id 类型、消息类型、连接状态、脱敏后的 `FeishuProviderStatus`——定义于此，并由[飞书子系统](../../../docs/subsystems/feishu.zh.md)页面承载说明；本 README 不复述字段清单。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [飞书子系统](../../../docs/subsystems/feishu.zh.md) — seam 的类型定义、`FeishuError` 错误码及生成的 Cordis API。
- [飞书能力 seam 决策](../../../.agents/notes/implemented/feature/2026-08-18-feishu-capability-seam.zh.md) — 会话操作为何收拢在单一提供方注册表之后。
- [提供方生命周期事件决策](../../../.agents/notes/implemented/architecture/2026-08-19-feishu-provider-lifecycle-events.zh.md) — 注册为何要对外广播，以及抛出异常的监听者为何会回滚注册。
- [feishu-bot](../feishu-bot/README.zh.md) — 仓库内唯一的提供方实现。
- [feishu-receive](../feishu-receive/README.zh.md) — 逐个订阅提供方并把每个会话路由给专属智能体的消费方。
- [feishu-status](../feishu-status/README.zh.md) — 面向浏览器客户端的 `describeStatus()` Remote 投影。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，经由 `@deepseek-ai/dsh-tool-feishu`：该工具向模型渲染发送结果与提供方失败，而本注册表不提供任何提示词或 schema。

#### KV Cache effect

本身不贡献请求前缀内容；所有模型可见的变化都归消费工具与按会话的系统提示小节，切换提供方改变的是传输事实而非提示词文本。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **卡片 JSON 由调用方负责** — `interactive` 是受支持的消息类型，但本包不校验也不构造卡片 schema；每张卡片都由其作者自行拼装 JSON。
- **单一能力对应单一提供方** — 注册表持有提供方并在其中选择，但不提供扇出发送、按会话的提供方策略或故障切换链。
- **回复路由只存在于进程内存** — “回复目标 → 提供方”映射由本进程收到的事件建立，因此重启后的第一条回复只能靠选择规则路由，直到新的消息到达。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包不发布不变式伴随插件：提供方映射始终私有，而 `feishu/provider-added` 与 `feishu/provider-removed` 这一对事件只在唯一的写入与删除点发出，因此不存在需要额外断言的独立关系。

</details>
