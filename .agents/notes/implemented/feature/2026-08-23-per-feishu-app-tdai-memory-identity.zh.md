# Agent Note: Per-Feishu-bot TDAI memory identity

Status: implemented

[English](2026-08-23-per-feishu-app-tdai-memory-identity.md) | 中文

## Problem

TDAI MemoryProxy 需要团队身份，才能把 LLM 会话绑定到某个团队以进行记忆注入和 L0 采集。当存在多个飞书 bot（每个属一个飞书应用）时，每个会话只能在代理的按会话资产表单里选 team/agent，而 harness 也没有「按 bot 设默认值」而非「全部署一个默认值」的机制。

## Decision

团队和智能体按飞书 bot 解析，键是其稳定的 `id`，而非全局、也非按群：

- `@deepseek-ai/dsh-feishu-bot` 拥有合并后的 bot 实体。它的设置段（`feishu-bot`）承载 `bots: [{ id, appId?, teamId?, agentId? }]`；秘密放在独立的、仅组合期的 `credentials: [{ id, appSecret?, appSecretEnv?, appIdEnv?, baseURL? }]`，因此设置 UI 永不收到、也就永不覆盖 `role('secret')` 值。单应用平铺字段保留以向后兼容，不含 `bots` 的配置行为与之前一致。
- `@deepseek-ai/dsh-tdai-memory` 暴露 `ctx.tdaiMemory`，自身不再拥有设置段：`identityFor(botId)` 读 `feishu-bot` 的解析后 `bots` 来解析会话的 team/agent，并承载 TDAI core 的 team/agent 目录 Remote（`listTeams` / `listAgents`）。它还会发送默认 `x-task-id`，使单智能体团队能直接登记，而非落入代理的旁路路径（[默认任务 note](../../bug-fix/2026-08-23-feishu-default-task-memory-registration.md)）。
- `@deepseek-ai/dsh-feishu-receive` 从每个 provider 收消息（`startReceivingAll`），并把每个 per-chat 会话绑定到接收它的 bot（`ctx.tdaiMemory.bindSession(sessionId, botId)`）。
- 飞书 seam 新增 `listProviders()`、`startReceivingAll(handler)`，并在 `FeishuReceiveEvent` 与 `FeishuSendRequest` 上新增 `providerId`。`sendMessage` 依次路由：显式 `providerId` → 该 chat 上次收到的 provider（`startReceivingAll` 记录的进程内 `chatId → providerId` 映射）→ 既有选择规则，因此回复无需让发送工具知道任何事就自动送回同一个 bot。
- `@deepseek-ai/dsh-llm-pi-ai` 与 `@deepseek-ai/dsh-llm-deepseek` 读取 `ctx.tdaiMemory.headersForSession(sessionId)`，发送 `x-team-id` / `x-agent-id`，代理的 `sessionInit.headerAutoSelect` 据此匹配以自动初始化绑定。
- Web 设置 IM 标签页（`@deepseek-ai/dsh-client-ui-settings-im`）是单一的 bot 管理器：它编辑 `feishu-bot` 的 `bots`，通过 `@deepseek-ai/dsh-feishu-status` 的 `list()` Remote 显示每个 bot 的状态，并用 `tdai-memory` 目录提供 team/agent 下拉。

## Alternatives considered

- **单一全局 team/agent**（最初实现的形态）：最简单，但一个 team 服务所有 bot，违背按 bot 默认值的目标。
- **按群映射**：过度贴合需求——用户要的是同一 bot 的所有群共享其默认 team/agent。
- **把 team/agent 塞进 `GenerateOptions` 或 session-log header**：会为纯传输元数据扩大 LLM 调用契约与持久会话格式；per-session 绑定服务把这些身份挡在模型可见请求之外。
- **把秘密留在设置可编辑的 `bots` 列表里**：被驳回，因为 `role('secret')` 字段在 describe 时被脱敏，且设置层合并对数组是整体替换——UI 会不带秘密地写回列表而静默抹掉它。`credentials` 拆分让秘密仅留在组合期。

## Consequences

- team/agent 按飞书 bot（该 bot 所有群共享）；作为 `x-task-id` 发送一个部署级默认任务，使单智能体团队能登记记忆（见 [默认任务 note](../../bug-fix/2026-08-23-feishu-default-task-memory-registration.md)）。秘密（`appSecret` / `appSecretEnv`）仅组合期，能经受 UI 对 `bots` 的编辑。
- 多 provider 回复路由是 seam 的进程内 `chatId → providerId` 映射，跨重启不保留——重启后由每个群的首条入站消息重新绑定，这与 per-chat agent 既有的重启契约一致。
- 身份头是模型隐藏的传输元数据，因此无需会话日志事件或 keyless snapshot。覆盖为 `tdai-memory`、`feishu`、`feishu-bot`、`feishu-receive`、`feishu-status`、`llm-deepseek`、`llm-pi-ai`、`api-remotes`、`ui-settings-im` 的测试，外加 `test:gui`。