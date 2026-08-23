# dsh-tdai-memory

English | [中文](README.zh.md)

TDAI MemoryProxy team/agent identity for outgoing LLM requests, resolved per Feishu bot and bound per agent session.

The per-bot team/agent mapping lives in the `feishu-bot` settings section (`bots[].teamId` / `bots[].agentId`). This package owns the runtime coordination and the core catalog: `ctx.tdaiMemory` holds the session → bot bindings `feishu-receive` writes, resolves a session's bot back to its team/agent headers for the `llm-pi-ai` / `llm-deepseek` adapters, and exposes `listTeams` / `listAgents` as Typert Remotes so the configuration UI can offer dropdowns. Every bound session also carries the default task as `x-task-id` (see `defaultTaskId`): the proxy's header auto-select registers a session directly only when team + agent + task all resolve, and absent a task a single-agent team falls into the proxy's bypass path and never writes memory.

## Config

| Field | Type | Default | Description |
|---|---|---|---|
| `endpoint` | `string` | `http://127.0.0.1:8420` | TDAI core base URL the catalog Remote reads from |
| `serviceId` | `string` | `default` | Core tenant/service id sent on catalog requests |
| `serviceToken` | `string` | `local` | Core service token sent on catalog requests |
| `userKeyEnv` | `string` | `PROXY_USER_KEY` | Credential reference naming the core user key (`sk-mem-*`) |
| `defaultTaskId` | `string` | `none` | Default task sent as `x-task-id`, aligned with the proxy's own `sessionInit.defaultTaskId` |

## Behavior

- A Feishu message received by bot `X` binds its per-chat session to `X`; every LLM request from that session then carries the bot's team/agent headers plus the default task's `x-task-id`.
- Sessions not bound to any bot (plain Web/harness sessions) send no identity headers.
- The header mapping is the pure function `tdaiMemoryHeaders`: empty/absent ids are omitted, so an unpinned bot sends nothing.

## Known Limitations and Deferred Work

- The session → bot binding is an in-memory map keyed by the process-local session id, so it does not survive a restart (a restart starts each Feishu chat anew anyway, and the receive channel re-binds on the first message).
- The core catalog is advisory: a hand-written id still works when the core is unreachable.