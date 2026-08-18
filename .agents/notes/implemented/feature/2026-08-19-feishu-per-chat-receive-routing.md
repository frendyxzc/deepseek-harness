# Agent Note: Feishu receive routing — one agent session per chat

Status: implemented

English | [中文](2026-08-19-feishu-per-chat-receive-routing.zh.md)

## Problem

`dsh-feishu-receive` delivered every incoming Feishu message to `agents.roots()[0]` — the first root agent — so messages from every chat share one conversation and one history. A multi-chat bot needs isolation: each chat's thread must map to its own session, and the same chat must always return to the same session.

## Decision

`dsh-feishu-receive` maintains an in-memory chat_id → session mapping. The first message from a chat creates a dedicated root agent running the live session's preset — which includes `dsh-tool-feishu`, so the agent can reply in its own chat — and inheriting the live session's model route and `cwd`, so the loop's `{{model}}`/`{{provider}}`/`{{cwd}}` prompt variables resolve when its persona assembles. Each chat's session id is a fresh `feishu-<uuid>`; the chat → session pin lives only in the in-memory map, so the same chat reuses one conversation within a process and starts anew after a restart (no cross-restart resume). Later messages from the same chat reuse the cached agent; the in-flight create promise is cached so concurrent first messages do not mint duplicates. Every created agent is disposed with the consumer's fiber.

## Alternatives considered

**Keep single-agent fan-in to `roots()[0]`.** Rejected: all chats interleave in one session, so no per-chat isolation.

**Static `chatSessions` config map.** Rejected: requires the operator to list every chat by hand before it is routable; auto-create matches the "create a chat_id → session mapping" intent without a manual roster.

**Round-robin across existing root agents.** Rejected: it loses the stable chat → session identity that keeps one chat's history together.

**Deterministic `feishu:<chatId>` id + cross-restart resume (`ctx.agents.resume`).** Rejected: resuming a process-created session is not a stable contract — a resumed agent was reported active but no longer processed new follow-ups, so conversations stalled after a restart. A fresh session id per process sidesteps id collisions and matches the `dsh-feishu-bridge` reference's model (sticky in-memory map, no cross-restart resume).

## Consequences

- Each Feishu chat runs its own agent session with its own history, and the agent's replies return to that chat through `dsh-tool-feishu`.
- The chat → session pin is process-local and each session id is a fresh UUID, so a harness restart starts every chat with a new conversation (history does not survive restarts).
- The injected message carries only the text content; which group member sent it is not attributed (per-sender attribution is deferred).