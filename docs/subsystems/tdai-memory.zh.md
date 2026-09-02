# TDAI 记忆身份

[English](tdai-memory.md) | 中文

TDAI MemoryProxy 团队/agent 身份 seam——`ctx.tdaiMemory` 服务把外发 LLM 请求解析为飞书 bot 的团队/agent 头，并按 agent 会话绑定。按 bot 的映射位于 `feishu-bot` 设置分区（`bots[].teamId` / `bots[].agentId`）；该 seam 拥有运行时协调：`feishu-receive` 写入会话 → bot 绑定，`tdaiMemory` 把已绑定会话还原成 `llm-pi-ai` / `llm-deepseek` 适配器发送的团队/agent 头，`listTeams` / `listAgents` 是 Typert Remote，使配置 UI 可以提供下拉选项。每个已绑定会话还携带默认任务作为 `x-task-id`（见 `defaultTaskId`）。

来源：[`packages/llm/tdai-memory/src/index.ts`](../../packages/llm/tdai-memory/src/index.ts)

## 会话绑定

bot `X` 收到的飞书消息会把它所在的按聊天会话绑定到 `X`；该会话之后的每个 LLM 请求都携带该 bot 的团队/agent 头以及默认任务的 `x-task-id`。未绑定任何 bot 的会话（普通 Web/harness 会话）不发送身份头。头映射是纯函数 `tdaiMemoryHeaders`：空/缺失的 id 会被省略，因此未钉住的 bot 不发送任何内容。

## 行为

- 会话 → bot 绑定是以进程本地会话 id 为键的内存映射，重启后不保留（重启后每个飞书聊天本来就会重新开始，接收通道在收到第一条消息时重新绑定）。
- 核心目录是参考性的：核心不可达时手写的 id 仍然可用。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxtdaimemory--tdaimemoryservice"></a>

### `ctx.tdaiMemory` — `TdaiMemoryService`

Owns the session → bot bindings the Feishu receive channel writes, the team/agent header resolution the LLM adapters read, and the TDAI core catalog Remote the configuration UI reads for its dropdowns.

```ts cordis-catalog
/**
 * Resolved team/agent identity for one bot, read from the `feishu-bot` section.
 * @param botId - the Feishu bot id whose identity to resolve.
 * @returns the bot's team/agent identity, or undefined when the bot is unmapped.
 */
identityFor(botId: string): TdaiIdentity | undefined

/**
 * Headers for one bot, from its merged identity and the default task.
 * @param botId - the Feishu bot id whose headers to build.
 * @returns the TDAI headers for the bot's identity and default task, or an empty map when the bot is unmapped.
 */
headersFor(botId: string): Record<string, string>

/**
 * Bind one agent session to the bot that received it, so the LLM adapters
 * resolve that session's requests to the bot's team/agent headers.
 * @param sessionId - the session id the loop stamps on its requests.
 * @param botId - the Feishu bot id the session belongs to.
 */
bindSession(sessionId: string, botId: string): void

/**
 * Headers for one agent session: its bound bot's merged identity, or an empty
 * set when the session was never bound (a non-Feishu session) or the bot is
 * unmapped.
 * @param sessionId - the session id the loop stamped on its request.
 * @returns the TDAI headers for the session's bound bot, or an empty map when unbound.
 */
headersForSession(sessionId: string): Record<string, string>

/**
 * The teams the core catalog serves, for the configuration dropdown.
 * @returns the teams the core catalog serves.
 */
@Remote('listTeams') async listTeams(): Promise<TdaiTeamOption[]>

/**
 * The agents one team serves, for the configuration dropdown.
 * @param teamId - the team id whose agents to list.
 * @returns the team's active agents.
 */
@Remote('listAgents') async listAgents(teamId: string): Promise<TdaiAgentOption[]>
```

Source: [`packages/llm/tdai-memory/src/index.ts`](../../packages/llm/tdai-memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
