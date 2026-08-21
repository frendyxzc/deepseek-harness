# Agent Note: pi-ai 在 chat-completions 请求上发送 Harness 会话身份头

Status: implemented

[English](2026-08-19-pi-ai-session-headers.md) | 中文

## Problem

`dsh-llm-deepseek` 会给每个请求附加 `x-deepseek-harness-user-id`、`x-deepseek-harness-session-id`，压缩请求再附加 `x-deepseek-harness-compact`，从而让反向代理把请求绑定到其 DSH 会话并注入上下文。`dsh-llm-pi-ai` 一个都没发：`options.sessionId` 只被传进了 pi-ai 自家的 provider 选项，请求只带了 `user-agent` 归属头。因此，一套 dsh 请求代理（例如 TencentDB-Agent-Memory 的 MemoryProxy）会把 pi-ai 流量看成"无会话头"，无法绑定会话——凡是由 pi-ai 路由提供的模型，选择器拦截、上下文注入、L0 回写全被跳过。这些头的语义与隐私边界由 [DeepSeek 请求身份决策](../feature/2026-08-11-deepseek-request-user-id-header.zh.md) 管辖；"归属头 vs 请求身份" 的划分由 [强制请求归属决策](../architecture/2026-06-21-mandatory-app-attribution-headers.zh.md) 管辖。

## Decision

pi-ai 适配器的 `requestHeaders` 辅助函数现在接收 `GenerateOptions`，在部署级 `profile.headers` 与 `user-agent` 归属头之后追加：`x-deepseek-harness-session-id`（取自 `options.sessionId`）和 `x-deepseek-harness-compact: 1`（当 `options.purpose === 'compaction'` 时）。它们放在最后展开，使 Harness 持有的名称在与部署自定义头的冲突中胜出，与 `user-agent` 已有的保留名纪律一致。

## Alternatives considered

**把会话头加进共享的 `attributionHeaders()` 辅助函数。** 否决：该辅助函数是提供商中立且静态的；随请求变化的会话值属于请求身份路径，不应进入应用归属，否则会波及无关适配器。

**同时发送 `x-deepseek-harness-user-id` 以达成完全线上对齐。** 否决：pi-ai 适配器没有匿名用户 id 来源，且消费方代理从 Bearer 鉴权推导用户；该头并非会话绑定所必需。

## Consequences

- pi-ai 与 llm-deepseek 请求现在携带相同的会话身份头；dsh 感知的代理可以统一绑定任意路由，与所选模型由哪个适配器服务无关。
- `x-deepseek-harness-user-id` 仍为 DeepSeek 专属，因此 pi-ai 请求既不铸造也不暴露匿名用户 id。
- 部署级 `headers` 仍可添加任意名称；但它们会让位于 `user-agent`、`x-deepseek-harness-session-id`、`x-deepseek-harness-compact`。