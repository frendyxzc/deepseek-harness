# @deepseek-ai/dsh-feishu-status

[English](README.md) | 中文

飞书能力有效连接状态的只读宿主投影。`FeishuStatusGateway` 注册 `feishuStatus` 服务并发布一个生成的直接 Remote：`feishuStatus/status`。每次调用都向 `ctx.feishu.describeStatus()` 询问当前的选择感知状态并作为 `FeishuStatusView` 转发，因此视图反映的是提供方注册表此刻的状态。

视图携带有效连接状态（`unavailable`、`unconfigured`、`connected` 或 `error`）、选定提供方 id、选定提供方自己的显示安全状态报告（`FeishuProviderStatus`），以及 seam 无法选择提供方时的选择失败说明。提供方在视图过线前对标识性值做脱敏并把密钥降为布尔值；本包不自行脱敏。其公开载荷类型位于 `./types` 下，Typert 生成的宿主与客户端 Remote 工件由 `./typert` 与 `./remote` 暴露。

该服务仅 Remote，故意不声明同进程 Cordis `Context` 合并。客户端包通过显式的 [`api-remotes`](../../api/remotes/README.md) 装配消费它，而不是直接导入宿主实现。

## 模型体验

无：这个仅宿主的投影不注册任何提示、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知局限与推迟工作

- **仅即时状态** —— 结果不含持久失败历史或订阅；标签页通过重新查询获得更新。
