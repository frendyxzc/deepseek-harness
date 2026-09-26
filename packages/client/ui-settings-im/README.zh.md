---
description: "Web 设置中的 IM 标签页：按 bot 显示的飞书连接状态药丸，以及把每个 bot 映射到默认 TDAI team 与 agent 的编辑器，包含只写的 App Secret 输入。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-im

[English](README.md) | 中文

## 概述

使用本包可以让一个 dsh 部署同时服务多个飞书 bot，并各自拥有默认值。在设置的「内置插件」分区中，IM 标签页列出已配置的 bot，每个都带一个连接状态药丸与一行字段——bot id、App ID、只写的 App Secret，以及从 TDAI 目录中选出的 team 与 agent——用户在此新增、移除与编辑条目。保存会写入宿主已校验的 `feishu-bot` settings 分区；对宿主不接受写入的文档，同样的字段以只读方式渲染。

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

在 Web 客户端组合中挂载这一行，设置的「内置插件」区域就会在插件列表旁边多出一个 **IM** 标签页。用户打开它即可看到每个已配置 bot 一张卡片，修改各 bot 默认使用的 team 与 agent，然后按下保存；状态与目录数据只在组件挂载后才拉取，因此插件激活本身不发起任何 Remote 调用。

### 何时选择它

当同一个部署服务多个飞书应用、且各应用的会话应默认落入不同的 TDAI team 与 agent（记忆代理正是靠这一对把存储分开）时选择它。若只有一个扁平应用且映射从不变动，就不需要它：组合的 `feishu-bot` 配置本就带有该列表，而本标签页只是它的 settings 平面编辑器。

### 最小配置

Web app bundle 插入的那一行就是完整的挂载，且该插件不接受任何组合配置：

```yaml
- id: ui-settings-im
  name: '@deepseek-ai/dsh-client-ui-settings-im'
```

标签页展示或编辑的一切都是宿主状态：由 `dsh-feishu-bot` 安装的 `feishu-bot` settings 分区、药丸背后的 `feishuStatus.list()` 投影、下拉背后的 `tdaiMemory` team 与 agent 目录，以及 App Secret 写入所落入的凭据存储。

### 标签页展示什么

页眉给出界面名称并说明模型：管理飞书 bot 连接，并按 App ID 映射默认团队与智能体，任务在会话时决定。其下一张可展开卡片承载列表。每行显示 bot id 或**未命名机器人**、条目携带时字面 App ID、一个连接状态药丸，以及五个字段——Bot ID、App ID、Team ID、Agent ID、App Secret——外加**移除**；**添加 bot**、**放弃修改**与**保存**位于卡片底部，而草稿与已读取列表不一致时页眉出现**有未保存的修改**。

两个目录字段是下拉而非文本框：team 与 agent 在 memory hub 中创建，因此标签页只提供目录返回的内容。team 列表为空时其下拉被禁用并提示目录不可用；agent 下拉在该 team 的智能体到达前保持禁用，并显示**请先选择 team**。

App Secret 只写不读。它的占位文案说明宿主是否已为该 bot 保存了值，输入新值会在下一次保存时替换旧值，留空则该凭据保持不变。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器侧拥有一切行为；宿主入口只是一个空的 `apply()` 占位。

### 标签页注册

`apply()` 注入 `slots`、`locale`、`remote`、它实际调用的三个 Remote 面（`remote.feishuStatus`、`remote.tdaiMemory`、`remote.credentials`）与 `configForms`；它注册 `settings.im` 字典，并等待 `settings.plugins.tab` 声明完成后才注册 `{ id: 'im', order: 20 }` 与 `FeishuStatusTab`，于是该标签页排在 `order: 10` 的插件列表标签之后。label 是 `t('tab')` 的 thunk，因此标签页会随当前语言自行改名。

### 读取与写入路径

`load()` 经绑定的 settings scope 拉取分区：`ready` 快照给出其中的 `bots` 列表与文档可写性；`unavailable` 快照什么都不给，编辑器也就不渲染卡片；尚未稳定的快照通过 scope 订阅等待，而不是靠猜测。`save()` 替换整个列表——去掉首尾空白、丢弃为空的可选字段，于是存储的分区只承载用户真正填过的内容——随后才写入每个新输入过值的 App Secret，最后用重新读取的视图回填草稿。

### 密钥引用推导

`secret-ref.ts` 复刻宿主的规则，于是一个尚不存在的 bot 也能在同一次保存里拿到自己的密钥：扁平的 `feishu-bot` id 保留 `FEISHU_APP_SECRET`，其他 id 被大写并清洗成 `FEISHU_APP_SECRET_<ID>`，若清洗结果为空或以数字开头则加上 `BOT_` 前缀。权威函数归 `dsh-feishu-bot` 所有，两个包各自在自己的测试里钉住同样的输出。

### 失败与空状态

读取被拒绝时渲染「映射暂不可用」一行；状态或目录读取失败则退化为空列表，这就是 core 中断看起来像「目录不可用」而不是错误的原因。抛错的保存——通常是被宿主拒绝的凭据写入——渲染失败提示行并保留草稿，用户输入不会丢失。

精确细节见 `src/client/index.ts`（注册与注入的动词）、`src/client/TdaiBotsEditor.tsx`（卡片）、`src/client/tdai-bots.ts`（settings 控制器）与 `src/client/secret-ref.ts`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖承载该标签页的分区、它编辑的状态，以及其读取背后的服务。

- [ui-settings-plugins](../ui-settings-plugins/README.zh.md)——投影 `settings.plugins.tab` 的「内置插件」分区。
- [ui-settings](../ui-settings/README.zh.md)——声明该 tab slot 与 settings scope 服务的领域底座。
- [ui-settings-plugin-inventory](../ui-settings-plugin-inventory/README.zh.md)——共用同一 slot 的相邻标签页。
- [feishu-bot](../../feishu/feishu-bot/README.zh.md)——本标签页所编辑分区的归属方，也是引用推导的权威。
- [feishu-status](../../feishu/feishu-status/README.zh.md)——连接状态药丸背后的宿主服务。
- [tdai-memory](../../llm/tdai-memory/README.zh.md)——下拉所读取的目录，也是保存的 id 所喂给的身份层。

-----

<a id="model-experience"></a>
## 模型体验

无。该包是浏览器端设置界面，只编辑 `feishu-bot` 映射，不注册任何面向模型的内容。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求，它保存的 team 与 agent id 只有在别的包把它们写成请求头时才与模型相关。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些是当前包约束，每条都点明标签页刻意不去断言什么。

- **状态按 bot id 匹配**——宿主尚未注册的 bot 没有对应状态条目，其药丸显示不可用，而不是某种待处理状态。
- **目录与状态失败都表现为空**——状态与目录读取会把失败结果渲染成空列表；只有映射读取带错误状态。
- **密钥无法读回**——该字段只表示是否已存在值，因此写错的密钥只能靠输入新值纠正，无法查看。
- **一次保存覆盖整张卡片**——先写 bot 列表、随后逐个写入有新值的密钥，因此某个密钥写入被拒时，映射已保存而该密钥缺失，只剩一条通用重试提示。
- **浏览器侧不做校验**——编辑器只把用户输入去掉空白后提交；未知的或重复的 bot id 意味着什么，由宿主的 `feishu-bot` schema 与接收通道决定。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

settings 命名空间与密钥引用规则都是刻意复刻宿主事实的客户端镜像，两者都以 `dsh-feishu-bot` 为权威：改任一名字都是跨两个包的改动，而它的测试钉住了相同的引用名。`settings.im` 字典里还有今天没有任何组件渲染的键，删除前先核对渲染点。

</details>

**运行时不变式：** `./invariant` 伴生入口注册的是刻意留空的 installer：命名空间及其 schema 归 `dsh-feishu-bot` 所有，本标签页的行为由其控制器与组件测试覆盖。
