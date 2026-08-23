# dsh-tdai-memory

[English](README.md) | 中文

为出站 LLM 请求提供 TDAI MemoryProxy 团队 / 智能体身份，按飞书 bot 解析、按智能体会话绑定。

按 bot 的 team/agent 映射位于 `feishu-bot` 设置段（`bots[].teamId` / `bots[].agentId`）。本包拥有运行时协调与 core 目录：`ctx.tdaiMemory` 承载 `feishu-receive` 写入的「会话 → bot」绑定，为 `llm-pi-ai` / `llm-deepseek` 适配器把会话解析回其 bot 的 team/agent 头，并把 `listTeams` / `listAgents` 作为 Typert Remotes 暴露，让配置 UI 能提供下拉。每个已绑定会话还会以 `x-task-id` 携带默认任务（见 `defaultTaskId`）：代理的头自动选择要求 team + agent + task 三者齐全才会直接登记会话，缺少 task 时，单智能体团队会落入代理的旁路（bypass）路径、永不写入记忆。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `endpoint` | `string` | `http://127.0.0.1:8420` | 目录 Remote 读取的 TDAI core base URL |
| `serviceId` | `string` | `default` | 目录请求携带的 core tenant/service id |
| `serviceToken` | `string` | `local` | 目录请求携带的 core service token |
| `userKeyEnv` | `string` | `PROXY_USER_KEY` | 命名 core 用户密钥（`sk-mem-*`）的凭据引用 |
| `defaultTaskId` | `string` | `none` | 作为 `x-task-id` 发送的默认任务，与代理自身 `sessionInit.defaultTaskId` 对齐 |

## 行为

- 由 bot `X` 收到的飞书消息会将其 per-chat 会话绑定到 `X`；该会话的每次 LLM 请求都会携带该 bot 的 team/agent 头，外加默认任务的 `x-task-id`。
- 未绑定到任何 bot 的会话（普通 Web / harness 会话）不发身份头。
- 请求头映射是纯函数 `tdaiMemoryHeaders`：空 / 缺省 id 会被省略，因此未配置身份的 bot 不会发任何头。

## 已知限制与待办

- 会话 → bot 绑定是以进程内会话 id 为键的内存映射，跨重启不保留（重启本就为每个飞书群重建会话，接收通道会在首条消息时重新绑定）。
- core 目录是建议性的：当 core 不可达时，手写 id 仍然可用。