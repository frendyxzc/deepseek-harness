# Agent Note：飞书提供方生命周期事件 —— `feishu/provider-added` / `feishu/provider-removed`

Status: implemented

[English](2026-08-19-feishu-provider-lifecycle-events.md) | 中文

## 问题

[审批卡片 Agent Note](../feature/2026-08-18-feishu-approval-cards.md) 让 `dsh-feishu-approval` 在 `apply` 时同步调用 `ctx.feishu.startReceivingCardActions` 来打开卡片点击通道。该调用要解析提供方注册表，但注册表的内容由 `dsh-feishu-bot` 自己的插件 fiber 提供，没有确定的时序：Cordis Loader 并发启动同级 entry 且不等待激活完成，因此每当应答器的 apply 先于 bot 的注册执行，`pnpm dsh web` 就会以 `FEISHU_PROVIDER_UNAVAILABLE` 确定性地启动失败。`dsh-feishu-receive` 以同样的方式调用 `ctx.feishu.startReceiving`，带着相同的潜在竞态。

在 `apply` 时解析提供方制造了一个隐式的加载顺序要求（“在 cordis.yml 中把提供方排在消费方之前”），而 Loader 并不保证这种顺序。

## 决策

飞书 seam 以类型化事件公告注册表成员关系，与 [subagent 提供方生命周期事件](2026-07-05-subagent-provider-lifecycle-events.md) 平行：

- **`feishu/provider-added(provider)`** —— 提供方提交进 `ctx.feishu` 注册表。由 `registerProvider` 在注册存储提供方之后发出；抛出异常的监听器会回滚已让出的 rollback，注册因此响亮失败。
- **`feishu/provider-removed(id)`** —— 提供方离开注册表（注册它的 fiber 被处置——卸载或 HMR 重载）。从注册的 disposer 中发出。

两个接收消费方都镜像注册表而不是假设顺序。各自的 `apply` 尝试打开自己的通道；当尚无可用提供方注册时，等待 `feishu/provider-added` 在注册时打开通道。当通道的提供方离开时，`feishu/provider-removed` 关闭通道并在剩余提供方上重新打开——或者恢复等待。等待只吸收 `FEISHU_PROVIDER_UNAVAILABLE` 与 `FEISHU_PROVIDER_CONFIGURED_MISSING` 这两个表示“尚无可用提供方”的错误码；已注册但无法承载通道的提供方（`FEISHU_RECEIVE_UNSUPPORTED` 及一切其他错误）仍在最早可解决的点响亮失败——抛出的 added 监听器回滚该提供方的注册。刻意不再留下任何需要文档化的加载顺序要求：事件让顺序问题消失，而不是把它钉死。

## 备选方案

**保留 `apply` 时的同步解析并文档化“提供方排前面”。** 否决：这声称了一个 Loader 并不存在的顺序保证——正是本 Note 修复的确定性启动失败。

**轮询注册表直到提供方出现。** 否决：在框架已有的机制（effect 注册 + 处置）之外另造一个私有的就绪协议；而且无法感知提供方离开，HMR 重载会让通道挂在一个已处置的后端上。

**只把响亮失败检查推迟到第一次审批请求。** 否决：配置错误的提供方会干净地启动，然后在第一个受保护工具处表现为一个静默缺失的应答器，违反“最早可解决点响亮失败”规则；added 监听器抛出使该错误配置保持在提供方 fiber 上的加载期失败。

## 后果

- `feishu/provider-added`/`-removed` 补全了 seam 的注册表词汇：从命名提供方派生状态的消费方改为对事件反应，而不是在 `apply` 时读取注册表；`dsh-feishu-approval` 与 `dsh-feishu-receive` 是参考实现。参见[事件目录](../../../../docs/subsystems/feishu.md)与[生产者/消费者映射](../../../../docs/event-producer-consumer.md)。
- **新增响亮失败；移除被包含。** added 监听器可以回滚注册；removed 监听器在处置期间运行，因此消费方在那里绝不抛出——两个消费方都防御性地关闭并重开，记录日志而不使卸载中的 fiber 失败。
- **存在通道关闭的窗口。** 当没有可用提供方注册时，消费方记录警告且无法接收——但此时也不存在任何飞书聊天 agent（接收路由器需要同一个提供方），因此不可能有卡片或消息在途。诚实状态与实际缺席一致。
