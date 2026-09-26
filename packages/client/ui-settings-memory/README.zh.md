---
description: "Web Settings 的「记忆」分区：一个导航条目，展示浏览器将要打开的 TencentDB-Agent-Memory 面板地址，并在新标签页中跳转到那里。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-memory

[English](README.md) | 中文

## 概述

使用本包可为 Web 用户提供一个打开 TencentDB-Agent-Memory 面板的设置条目。用户在设置导航中选择 Memory，读取页面实际会打开的面板地址，并按下打开记忆面板在新标签页中启动它。地址跟随浏览器已经用来访问 dsh 的源：回环页面打开固定的本地面板端口，局域网页面在同一主机的那个端口上打开，因此当 dsh 跨网络共享时跳转链接仍然可用。该分区本身既不存储也不请求任何东西。

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

在 Web 客户端组合中挂载这一行，设置导航就会多出一个 **Memory** 条目：用户打开它、读取按钮将要使用的面板地址，并按下**打开记忆面板**在新标签页中启动 TencentDB-Agent-Memory 控制台。在此之前没有别的东西需要配置——该分区为其字典覆盖的每种语言都渲染同样的标题、简介、地址与按钮。

### 何时选择它

当部署在 dsh 旁边运行独立的记忆栈、并且用户需要那个控制台（会话记忆、技能、代码图谱、团队资产）时选择它。没有部署面板时跳过它：该分区只是跳转链接，只会宣传一个打不开的地址。渲染导航的外壳属于 [ui-settings-general](../ui-settings-general/README.zh.md)；本包只贡献这一个分区。

### 最小配置

Web app bundle 插入的那一行就是完整的挂载，且该插件不接受任何组合配置：

```yaml
- id: ui-settings-memory
  name: '@deepseek-ai/dsh-client-ui-settings-memory'
```

没有字段可以把链接指向别处：该分区能展示的唯一地址就是浏览器正在通信的主机上的面板端口，因此换一个面板源是对那个栈的部署改动，而不是这里的设置。

### 分区展示什么

该分区渲染**记忆面板**标题、说明面板所管理内容的简介行、`Panel URL: <address>` 一行，以及通过 `window.open(url, '_blank', 'noopener,noreferrer')` 打开该地址的主按钮。在外壳注入分区依赖之前组件返回 `null`，因此尚未解析完成的出口不会画出半页。

地址跟随浏览器已经用来访问 dsh 的源：回环页面展示并打开 `http://127.0.0.1:8123`，局域网页面展示并打开同一主机在 `8123` 端口上的地址（例如 `http://192.168.1.5:8123`）。该分区不发请求、不追加会话事件，也不写 settings。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

两半，其中只有一半做事：宿主入口导出空的 `apply()`，浏览器入口注册文案与分区。

### slot 注册

浏览器侧 `apply()` 注入 `slots`、`locale` 与 `connection`，注册 `settings.memory` 字典，并等待 `settings.section` 声明完成后才注册 `{ id: 'memory', order: 20 }` 与 `MemorySection`。order 20 把该条目排在通用（0）、模型（10）与内置插件（15）之后。`label` 是 `t('nav')` 的 thunk，条目也写明自己的 `locale` 命名空间，因此语言切换会就地重命名导航项，无需重新注册。

### 源解析

`panelUrl(hostname, isLoopback)` 就是全部的地址策略，组件把 `window.location.hostname` 与来自 connection 句柄的 `isLoopback` 标志交给它，二者在渲染时经 `inject` 取得。由于该标志就是浏览器自己的连接分类，分区描述的是该用户的浏览器真正会跟随的链接，而不是宿主对网络拓扑的猜测。

### 端口为什么是常量

`8123` 是独立的 TencentDB-Agent-Memory 控制台的部署事实，不是本仓库的可调项，因此它作为模块常量留在渲染它的组件旁边。常量上方的注释记录了它所编码的假设：面板与会话的记忆代理（`8096`）绑定在同一台机器上。

精确细节见 `src/client/index.ts`（注册）、`src/client/MemorySection.tsx`（`panelUrl` 策略与渲染）与 `src/client/locales.ts`（两份字典）。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖承载该条目的外壳、地址背后的标志，以及它链接到的记忆栈。

- [ui-settings-general](../ui-settings-general/README.zh.md)——投影 `settings.section` 导航的设置外壳。
- [ui-settings](../ui-settings/README.zh.md)——声明分区 slot 及其 scope 服务的领域底座。
- [connection](../connection/README.zh.md)——提供 `isLoopback` 的浏览器句柄。
- [tdai-memory](../../llm/tdai-memory/README.zh.md)——由同一个记忆栈服务的身份层。
- [ui-settings-im](../ui-settings-im/README.zh.md)——用户在其中配置按 bot 记忆身份的相邻界面。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端设置页，只渲染一个固定跳转链接，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些是当前包约束，全部源于该分区只是一个固定链接。

- **面板源是页面主机上的一个固定端口**——在把该源做成可配置之前，无法链接到别的端口或机器上的控制台。
- **可达性由面板自己的策略决定**——局域网浏览器能否加载 `http://<host>:8123` 取决于该服务的绑定决策，不在本仓库控制范围内。
- **分区无法判断面板是否已启动**——它无条件渲染地址且不做探测，因此未启动的控制台只在按钮打开的标签页里暴露。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

简介行仍然列举那个外部控制台的功能清单（会话记忆、技能、代码图谱、团队资产），这是该产品的用词而非本仓库的；当它重命名某项能力时，这里唯一需要改动的文件是 `src/client/locales.ts`。本仓库没有任何东西断言面板自身的路由，因此改文案就是全部更新。

</details>

**运行时不变式：** 不发布 `./invariant` 伴生入口：该分区不发事件、也不持有跨插件可变关系，因此其行为由 slot 账本与组件测试负责。
