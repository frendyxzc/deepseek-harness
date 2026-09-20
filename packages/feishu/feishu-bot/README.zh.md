---
description: "在 ctx.feishu 之后运行飞书 Bot API：单应用或多 bot、凭据引用式密钥、消息发送/更新/读取与图片下载，以及长连接的会话消息与卡片点击回调。"
kind: "package-reference"
---

# @deepseek-ai/dsh-feishu-bot

[English](README.md) | 中文

## 概述

无需暴露公网回调 URL，就能发送、修改和读取飞书消息，并接收卡片点击。本包按配置的应用数量在 `ctx.feishu` 上各注册一个提供方：单个应用使用扁平字段，`bots` 则注册多个应用，于是每个会话都由收到消息的那个应用回复。凭据在每次操作时通过凭据 seam 解析，因此密钥不必写进配置文件，而 Web 设置的 IM 标签页可在进程运行期间编辑 bot 身份信息。接收侧只通过一条共享长连接向外拨号，因此位于 NAT 之后同样可用。

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

将本包与 [`@deepseek-ai/dsh-feishu`](../feishu/README.zh.md) 一同挂载，并把 `FEISHU_APP_ID` 与 `FEISHU_APP_SECRET` 指向一个具备发送权限的飞书应用。它是唯一随产品发布的提供方，因此 seam 提供的全部操作——包括接收——都由它承担。

### 何时选择它

凡是访问飞书的配置组合都要挂载本包；真正的选择在于要服务几个应用。一个应用足够时使用扁平字段；需要多个应用各自拥有自己的会话时使用 `bots`——此时提供方 id 就是 bot id，于是 `provider: <bot id>` 可以把发送锁定到某个应用。[`dsh.setup` 的 Web 配置补丁](../../../scripts/setup-dsh/templates/profile-web/cordis.patch.yml)与 Web 设置的 IM 标签页都以本包为前提；更换传输实现是替换它，而不是与它并存。

### 最小配置

```yaml
- insert:
    - id: feishu
      name: '@deepseek-ai/dsh-feishu'
    - id: feishu-bot
      name: '@deepseek-ai/dsh-feishu-bot'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `appId` | 未设置 | 扁平单应用的字面 App ID；优先于 `appIdEnv` |
| `appSecret` | 未设置 | 扁平单应用的字面 App Secret；优先于 `appSecretEnv` |
| `appIdEnv` | `FEISHU_APP_ID` | 每次操作时解析的凭据引用 |
| `appSecretEnv` | `FEISHU_APP_SECRET` | 每次操作时解析的凭据引用；按 bot 时默认使用由 bot id 推导出的引用 |
| `baseURL` | `https://open.feishu.cn/open-apis` | 开放接口根地址；无法解析该值会使提供方不可用 |
| `bots` | 未设置 | 可在设置中编辑的 bot 应用：每个 `{ id, appId?, teamId?, agentId? }` 以自己的 id 注册一个提供方 |
| `credentials` | 未设置 | 仅供配置组合使用的每个 bot 的密钥与端点：`{ id, appSecret?, appSecretEnv?, appIdEnv?, baseURL? }` |

当两个凭据都存在来源——字面值或引用——且根地址可解析时，提供方即为可用。若引用解析不到值，提供方依旧可被选中，但其调用会以 `FEISHU_PROVIDER_CREDENTIAL_MISSING` 失败，状态投影报出 `state: 'unconfigured'`；因此上面的扁平挂载要求 `FEISHU_APP_ID` 与 `FEISHU_APP_SECRET` 确有取值。生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-feishu-bot)是所有可接受字段的完整来源。

### 多个 bot

```yaml
- insert:
    - id: feishu-bot
      name: '@deepseek-ai/dsh-feishu-bot'
      config:
        bots:
          - id: main
            appId: <FEISHU_APP_ID>
        credentials:
          - id: main
            appIdEnv: FEISHU_APP_ID
            appSecretEnv: FEISHU_APP_SECRET
```

非空的 `bots` 会取代扁平字段：每个条目注册自己的提供方，入站事件同时携带解析出的 App ID 与提供方 id，于是该会话的回复仍经同一个应用发出。`bots` 是可编辑的那一半——Web 设置的 IM 标签页写入 `feishu-bot` 配置节，运行中的改动会重新同步提供方——而 `credentials` 只能写在配置组合里，因为设置文档会对 secret 角色做脱敏。当某个 `credentials` 条目未指定 `appSecretEnv` 时，引用默认取扁平 `feishu-bot` id 对应的 `FEISHU_APP_SECRET`，其余 bot 则为 `FEISHU_APP_SECRET_<BOT_ID>`（转大写、非字母数字替换为 `_`，若 id 以数字开头则再加 `BOT_` 前缀）。IM 标签页按同一规则保存每个 bot 的密钥，因此在那里输入的密钥会直接进入提供方的下一次操作，无需重启。

### 接收、读取与更新

消息事件与卡片回调共用同一条向外拨号的长连接客户端；第一个订阅者——无论消息还是卡片动作——打开连接，最后一个释放函数关闭它，因此两个消费方绝不会为同一个应用维持两条连接。每条入站消息会把 `text`、富文本 `post`、`interactive` 与 `image` 内容归约为纯文本加图片键，记录被引用或所属话题的父消息（若存在），并丢弃既无可读文本也无图片的消息。每次卡片回调都以 `FeishuCardActionEvent` 送达，其 `value` 原样透传而不做校验，因为该内容出自点击卡片的操作者。

`getMessage()` 读取单条消息时带上 `card_msg_content_type=user_card_content`，从而返回卡片的原始 JSON 而不是客户端压缩后的预览，于是被引用的卡片按其 markdown 文本读回。`getMessageResource()` 下载单张图片的字节，已删除的资源会以 `FEISHU_PROVIDER_ERROR` 呈现并携带飞书自身的 `code` 与 `msg`。`updateMessage()` 替换本提供方此前发出的消息，内容编码须与原始发送一致。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

一个类持有某个应用的提供方；插件主体负责把配置换算成这些类的列表。除当前操作之外不缓存任何已解析的凭据，因此修改设置节或凭据存储影响的是下一次调用，无需重新挂载。

出站调用就是对开放接口发起普通 `fetch` 请求并带上租户令牌请求头。令牌取自 `/auth/v3/tenant_access_token/internal`，并在其声明的过期时间前 60 秒内复用；只有真正重新签发令牌时才会重新解析 App ID 与 App Secret。失败统一归一为 `FEISHU_PROVIDER_ERROR` 并携带飞书的 code 与消息，而调用方取消抛出的是 `FEISHU_ABORTED` 而非传输错误。

接收通道是唯一有状态的部分：每个应用一份处理函数列表，由第一个订阅者惰性打开，由最后一个释放函数关闭，包括释放函数早于异步初始化完成而运行的情形。连接故障不会抛给订阅者——它记录提供方的最近错误，供状态投影报告，并由 SDK 负责重连。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件配置、bot 列表、设置节、凭据引用与提供方注册 |
| [`src/provider.ts`](src/provider.ts) | 开放接口调用、令牌缓存以及共享长连接接收通道 |
| [`src/invariant.ts`](src/invariant.ts) | 本包预留的不变式伴随插件，安装函数为空并记录原因 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [飞书子系统](../../../docs/subsystems/feishu.zh.md) — 本类所实现的提供方契约及其返回的错误码。
- [长连接接收决策](../../../.agents/notes/implemented/feature/2026-08-18-feishu-long-connection-receive.zh.md) — 为什么用一条向外拨号的连接取代回调端点。
- [按 bot 命名密钥引用决策](../../../.agents/notes/implemented/bug-fix/2026-09-14-feishu-named-bot-secret-ref.zh.md) — 按 bot 区分的密钥引用如何避免编辑 bot 时覆盖密钥。
- [凭据存储启动竞态](../../../.agents/notes/implemented/bug-fix/2026-09-14-feishu-credential-store-boot-race.zh.md) — 本插件为何 `inject` 凭据服务。
- [feishu](../feishu/README.zh.md) — 选择该提供方的 seam。
- [feishu-receive](../feishu-receive/README.zh.md) — 逐个订阅这些提供方的消费方。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，经由 `@deepseek-ai/dsh-tool-feishu`：该工具调用 seam 并把本提供方的结构化结果或失败渲染给模型，本包自身不注册任何提示词或 schema。

#### KV Cache effect

本包不产生任何影响：它不贡献请求前缀内容，凭据或端点的变化只改变传输行为，模型可见文本保持逐字节一致。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **令牌刷新按计划而非按需** — 缓存期内出现令牌失效只会按提供方错误上报；针对特定飞书错误码的即时刷新仍未实现。
- **一个应用一条连接** — 出站请求沿用进程默认网络配置，未暴露按应用的代理或 `fetch` 覆盖入口。
- **文本之外的消息类型会被归约** — 接收与读取只保留文本、`post`、卡片和图片标记，因此飞书以这些之外类型上报的内容只会变成占位或被丢弃。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

本包通过 `./invariant` 预留了不变式伴随插件，其安装函数为空，因为在 seam 已保障的契约之外不存在独立的事件序列或可变关系。`feishuAppSecretRef` 的规则在 Web 设置 IM 客户端中被镜像了一份，因此这里的改动必须与客户端那份同批提交。

</details>
