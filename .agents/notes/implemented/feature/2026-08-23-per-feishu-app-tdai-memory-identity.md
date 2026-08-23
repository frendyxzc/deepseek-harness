# Agent Note: Per-Feishu-bot TDAI memory identity

Status: implemented

English | [中文](2026-08-23-per-feishu-app-tdai-memory-identity.zh.md)

## Problem

The TDAI MemoryProxy needs a team identity to bind an LLM session to a team for memory injection and L0 capture. With several Feishu bots (one Feishu app each), every session otherwise picks team/agent through the proxy's per-session asset form, and the harness had no way to pin one default per bot rather than one default for the whole deployment.

## Decision

Team and agent are resolved per Feishu bot, keyed by its stable `id`, not globally and not per chat:

- `@deepseek-ai/dsh-feishu-bot` owns the merged bot entity. Its settings section (`feishu-bot`) carries `bots: [{ id, appId?, teamId?, agentId? }]`; secrets live in a separate composition-only `credentials: [{ id, appSecret?, appSecretEnv?, appIdEnv?, baseURL? }]`, so the settings UI never receives — and therefore never overwrites — a `role('secret')` value. The flat single-app fields remain for backward compatibility, so a `bots`-less config behaves as before.
- `@deepseek-ai/dsh-tdai-memory` exposes `ctx.tdaiMemory` with no settings section of its own: `identityFor(botId)` reads `feishu-bot`'s resolved `bots` to resolve a session's team/agent, and it carries the TDAI core team/agent catalog Remote (`listTeams` / `listAgents`). It also sends a default `x-task-id` so single-agent teams register directly instead of falling into the proxy's bypass path ([default-task note](../../bug-fix/2026-08-23-feishu-default-task-memory-registration.md)).
- `@deepseek-ai/dsh-feishu-receive` receives from every provider (`startReceivingAll`) and binds each per-chat session to the bot that received it (`ctx.tdaiMemory.bindSession(sessionId, botId)`).
- The Feishu seam gained `listProviders()`, `startReceivingAll(handler)`, and `providerId` on both `FeishuReceiveEvent` and `FeishuSendRequest`. `sendMessage` routes through an explicit `providerId`, else the provider that last delivered the target chat (an in-memory `chatId → providerId` map `startReceivingAll` records), else the existing selection rules — so a reply goes back through the same bot without teaching the send tool anything.
- `@deepseek-ai/dsh-llm-pi-ai` and `@deepseek-ai/dsh-llm-deepseek` read `ctx.tdaiMemory.headersForSession(sessionId)` and send `x-team-id` / `x-agent-id`, which the proxy's `sessionInit.headerAutoSelect` matches to auto-initialize the binding.
- The Web Settings IM tab (`@deepseek-ai/dsh-client-ui-settings-im`) is a single bot manager: it edits `feishu-bot`'s `bots`, shows each bot's status via `@deepseek-ai/dsh-feishu-status`'s `list()` Remote, and offers team/agent dropdowns from the `tdai-memory` catalog.

## Alternatives considered

- **One global team/agent** (the shape built first): simplest, but one team serves every bot, which defeats per-bot defaults.
- **Per-chat mapping**: over-fits the stated requirement that every chat of a bot shares its default team/agent.
- **Threading team/agent through `GenerateOptions` or the session-log header**: would widen the LLM call contract and the durable session format for transport-only metadata; the per-session binding service keeps the identity out of model-visible requests.
- **Keeping secrets inside the settings-editable `bots` list**: rejected because `role('secret')` fields are redacted on describe and the settings layer merge replaces arrays wholesale — the UI would write the list back without the secret and silently erase it. The `credentials` split keeps secrets composition-only.

## Consequences

- Team/agent are per Feishu bot (shared by all its chats); a deployment default task is sent as `x-task-id` so single-agent teams register memory (see the [default-task note](../../bug-fix/2026-08-23-feishu-default-task-memory-registration.md)). Secrets (`appSecret` / `appSecretEnv`) are composition-only and survive UI edits to `bots`.
- Multi-provider reply routing is the seam's process-local `chatId → providerId` map and does not survive a restart — a restart re-binds each chat on its first inbound message, which is the same restart contract the per-chat agents already have.
- The identity headers are model-hidden transport metadata, so no session-log event or keyless snapshot is required. Coverage is the `tdai-memory`, `feishu`, `feishu-bot`, `feishu-receive`, `feishu-status`, `llm-deepseek`, `llm-pi-ai`, `api-remotes`, and `ui-settings-im` tests, plus `test:gui`.