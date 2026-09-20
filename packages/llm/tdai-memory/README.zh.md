---
description: "按飞书 bot 解析的 TDAI MemoryProxy 身份：会话会发送哪些 team/agent/task 请求头、Settings 下拉背后的 core 团队与智能体目录，以及记忆登记的边界在哪里。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tdai-memory

[English](README.md) | 中文

## 概述

使用本包后，每个飞书 bot 的会话会把记忆写入自己的 TDAI MemoryProxy 租户，而不会混进同一个共享存储。与已配置 bot 的聊天会携带该 bot 的 `x-team-id` 与 `x-agent-id`，外加配置好的默认 `x-task-id`——代理的头自动选择必须凑齐这三项才会登记会话并开始写入记忆。未配置的 bot 与普通 Web / harness 会话不发身份，因此留在这些存储之外。同一个 core 也提供设置下拉所用的团队与智能体列表。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

base bundle 已经挂载了本包，因此基于 base 的 profile 无需再加行：`ctx.tdaiMemory` 对 LLM 适配器可用；映射本身位于 `feishu-bot` settings 分区，其中既没有 team 也没有 agent id 的 bot 条目不会贡献任何身份请求头。

### 何时选择它

当部署在 dsh 旁边运行 TDAI MemoryProxy，并希望多个飞书应用写入各自独立的记忆存储时选择它；哪怕只有一个 bot 映射到自己的 team 与 agent 也值得。没有部署代理时跳过它：适配器通过可选的 `ctx.get('tdaiMemory')` 读取身份，因此本包缺失时 `dsh-llm-deepseek` 与 `dsh-llm-pi-ai` 仍照常组装请求。

### 最小配置

最小的挂载就是 base bundle 插入的那一行，它也是推荐的起点，因为它固定了默认任务：

```yaml
- id: tdai-memory
  name: '@deepseek-ai/dsh-tdai-memory'
  config:
    defaultTaskId: 'none'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `endpoint` | `http://127.0.0.1:8420` | 目录 Remote 读取的 TDAI core base URL |
| `serviceId` | `default` | 目录请求携带的 core tenant/service id |
| `serviceToken` | `local` | 目录请求携带的 core service token |
| `userKeyEnv` | `PROXY_USER_KEY` | 命名 core 用户密钥（`sk-mem-*`）的凭据引用 |
| `defaultTaskId` | `none` | 每个已配置 bot 的请求作为 `x-task-id` 发送的任务 |

`listTeams` 在联系 core 之前先经 `ctx.credentials` 解析 `userKeyEnv`，因此引用解析不到就是设置下拉空白的成因。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tdai-memory)是每个受支持字段及其 JSDoc 的完整来源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包持有三个可分离的部分——请求头构造、会话 → bot 绑定，以及 core 目录 Remote——它自己不持有任何配置：可变的按 bot 映射就是由 `dsh-feishu-bot` 安装、并由 Web 设置界面编辑的 `feishu-bot` 分区。

### 身份解析

`identityFor(botId)` 读取已解析的 `feishu-bot` 分区，返回其中 `id` 匹配的 `bots[]` 条目，因此到达线上的 `teamId` / `agentId` 已经通过 settings schema 校验。结果交给导出的纯函数 `tdaiMemoryHeaders`：它为非空的 id 发出 `x-team-id` 与 `x-agent-id`，并为 `resolveTaskId()` 发出 `x-task-id`——即 `Config.defaultTaskId` 去空白后的值，缺省时回落到 core 预置给每个 team 的 `none`。某个字段为空只会丢掉它自己的请求头，因此已配置但无身份的条目仍会贡献 task。

### 会话绑定

`bindSession(sessionId, botId)` 把这一对记录在进程内的 `Map` 中；`feishu-receive` 在接收消息时调用它，LLM 适配器每次请求调用 `headersForSession(sessionId)`。未绑定的会话解析为空请求头表，这就是普通 Web 会话保持请求无身份的方式；重启后每个聊天都处于未绑定状态，直到下一条消息重新绑定。

### core 目录

`listTeams` 与 `listAgents` 是 `tdaiMemory` 服务上的 Typert Remote，它们向 `endpoint` POST `/v3/meta/team/list`（请求体 `{ user_key }`）与 `/v3/meta/agent/list`（请求体 `{ team_id, status: 'active' }`），并使用 `authorization: Bearer <serviceToken>`、`x-tdai-service-id` 与 `x-tdai-user-key` 认证。非 2xx 响应或非零信封 `code` 会抛出 `tdai-memory: core <path> …` 错误；缺少字符串 id 或名称的实体会被丢弃，而不是作为空白下拉项呈现。

精确细节见 `src/index.ts`（配置、服务、请求头构造）、`src/types.ts`（目录选项结构）与 `tests/tdai-memory.spec.ts`（被钉住的请求头与 task 行为）。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖映射的归属方、会话绑定的两端，以及读取目录的界面。

- [feishu-bot](../../feishu/feishu-bot/README.zh.md)——安装本包所读 `feishu-bot` 分区的插件。
- [feishu-receive](../../feishu/feishu-receive/README.zh.md)——为每条入站消息调用 `bindSession` 的接收通道。
- [llm-deepseek](../llm-deepseek/README.zh.md)——把会话请求头解析进出站请求的适配器。
- [llm-pi-ai](../llm-pi-ai/README.zh.md)——第二个适配器，它为 harness 预留 TDAI 请求头名称。
- [ui-settings-im](../../client/ui-settings-im/README.zh.md)——用户填写 team 与 agent id 的设置标签页。
- [tdai-memory 子系统](../../../docs/subsystems/tdai-memory.zh.md)——本包的生成式服务面。
- [配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tdai-memory)——每个受支持字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

无。它解析出的身份只作为模型不可见的 HTTP 请求头到达代理；它不注册任何提示词、tool schema 或会话事件。

#### KV Cache 影响

无；这些请求头伴随请求体而非进入请求体，因此未变化的会话前缀仍与提供方缓存的字节完全一致，改动某个 bot 的 team 或 agent 只改变传输元数据。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些是当前包约束，每条都点明部署必须尊重的边界。

- **会话绑定不持久**——会话 → bot 映射是进程内的，重启后每个飞书聊天都处于未绑定状态，直到下一条消息重新绑定；这里不会持久化该配对。
- **只有 Chat Completions 协议携带这些请求头**——`dsh-llm-deepseek` 在其 Chat Completions 适配器中解析它们，而其 Messages 适配器不发 TDAI 头，因此走 Messages 路线的部署在代理侧什么都不会登记。
- **目录只是建议性的**——`listTeams` 与 `listAgents` 只提供下拉选项；core 不可达时手写的 team 或 agent id 依旧可用，这里也不会拿目录去校验 id。
- **用户密钥错误总是报出默认引用**——密钥解析不到时报 `set PROXY_USER_KEY`，即使 `userKeyEnv` 配置了别的引用，于是改名后的引用会得到指向错误变量的提示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

`defaultTaskId` 是最容易被改坏的值：`none` 对应代理自己的 `sessionInit.defaultTaskId`，钉住真实任务的部署必须让这一行与代理保持一致，否则代理不再登记会话、记忆会静默停止写入。两侧各自只断言自己那一半，所以改一侧需要同时检查两个仓库。

</details>

**运行时不变式：** `./invariant` 伴生入口注册的是刻意留空的 installer：settings schema 会在 `identityFor` 观察到 bot 列表之前完成校验，而内存内绑定的唯一后果——请求头——由适配器测试钉住。
