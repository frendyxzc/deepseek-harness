# Agent Note: 发送默认 x-task-id，使单智能体飞书会话能登记记忆

Status: implemented

[English](2026-08-23-feishu-default-task-memory-registration.md) | 中文

## Problem

`dsh-tdai-memory` 原本只发送 `x-team-id` / `x-agent-id`，把任务留给代理按会话决定（如 [per-Feishu-bot 身份 note](../../feature/2026-08-23-per-feishu-app-tdai-memory-identity.md) 所记录）。但代理的头自动选择（`sessionInit.headerAutoSelect`）只有在 team、agent、task 三者都解析出来时（`resolvePresetIdentity.canRegister`）才会直接登记会话；只有 team + agent 时会落入 `agent_select` 表单，而 dsh 表单拒绝单智能体团队（`agent stage requires ≥2 agents`）。于是单智能体团队上的飞书会话会耗尽 `sessionInit.maxRetries`，被封印为 `bypassed` 终态：代理跳过注入、永不写 L0 对话记忆；而同一团队上不带头的 Web 会话却能自动选中唯一智能体与任务 `none`，正常记录记忆。

## Decision

`dsh-tdai-memory` 现在会在 team/agent 头之外，以 `x-task-id` 发送一个默认任务，让代理的头自动选择凑齐三者、直接登记会话。任务是部署级默认值而非 per-bot 身份字段：`Config.defaultTaskId`（校验字符串）对每个已绑定会话发出，缺省回退到协议默认 `none` —— 即 core 预置的 `isDefault`「不关联任务」条目，同时也是代理的 `sessionInit.defaultTaskId`。基础 bundle 在 `cordis.patch.yml` 里固定 `defaultTaskId: 'none'`，可按部署覆盖。映射保持纯函数：`tdaiMemoryHeaders(identity, taskId)` 仅在给定非空任务时发出任务头；`headersFor` 对未映射 bot 省略全部头，未绑定会话依旧不发头。

## Alternatives considered

**不携带任务直接登记。** 被驳回：代理状态机按设计以 `canRegister` 守卫在「task 存在」上，省略它会复现单智能体旁路。

**在 per-bot 的 `feishu-bot` 条目里加 `taskId`。** 被驳回：任务是代理侧的会话默认值，而非 per-bot 身份；部署级默认避免了成倍配置，并让头映射与代理自身的 `defaultTaskId` 对齐。

**改为修复代理的单智能体表单。** 未被采用作为本次修复：MemoryProxy 是 vendored 上游（`TencentDB-Agent-Memory`），不是 harness 包；harness 侧的默认任务既是最小改动，也契合代理已遵守的头契约。

## Consequences

单智能体团队上已绑定的飞书会话能完成头自动选择登记，恢复 L0 对话记忆写入。默认任务属于模型/工具的线缆字段而非模型可见文案，因此无会话日志事件变更；头输出由 `tdai-memory` 单元测试断言。core 未预置 `none` 的部署必须固定一个真实的 `defaultTaskId`。已被封存为 `bypassed` 的会话在其代理 sqlite 存储被清除之前（重启代理并重置存储或删除该条目）会保持该终态，因为 L1 终态缓存会短路重新登记。