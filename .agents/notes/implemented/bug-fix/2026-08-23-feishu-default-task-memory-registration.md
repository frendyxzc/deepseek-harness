# Agent Note: Send a default x-task-id so single-agent Feishu sessions register memory

Status: implemented

English | [中文](2026-08-23-feishu-default-task-memory-registration.zh.md)

## Problem

`dsh-tdai-memory` deliberately sent only `x-team-id` / `x-agent-id`, leaving the task a per-session proxy choice (as recorded by the [per-Feishu-bot identity note](../../feature/2026-08-23-per-feishu-app-tdai-memory-identity.md)). The proxy's header auto-select (`sessionInit.headerAutoSelect`) nevertheless registers a session directly only when team, agent, and task all resolve (`resolvePresetIdentity.canRegister`); with only team + agent it falls into the `agent_select` form, and the dsh form rejects a single-agent team (`agent stage requires ≥2 agents`). A Feishu session on a single-agent team therefore burned through `sessionInit.maxRetries` and was sealed as a `bypassed` terminal state: the proxy skipped injection and never wrote L0 conversation memory, while a header-less Web session on the same team auto-selected its single agent and task `none` and recorded memory normally.

## Decision

`dsh-tdai-memory` now sends a default task as `x-task-id` alongside the team/agent headers, so the proxy's header auto-select has all three and registers the session directly. The task is a deployment default rather than a per-bot identity field: `Config.defaultTaskId` (validated string) is emitted for every bound session, falling back to the protocol default `none` — the core's pre-seeded `isDefault` "no task" entry, which is also the proxy's `sessionInit.defaultTaskId`. The base bundle pins `defaultTaskId: 'none'` in `cordis.patch.yml`, overridable per deployment. The mapping stays pure: `tdaiMemoryHeaders(identity, taskId)` emits the task header only when a non-empty task is supplied, and `headersFor` omits every header for an unmapped bot, keeping unbound sessions header-less.

## Alternatives considered

**Register without the task.** Rejected: the proxy state machine guards `canRegister` on task presence by design, so omitting it reproduces the single-agent bypass.

**Add `taskId` to the per-bot `feishu-bot` entry.** Rejected: the task is a proxy-side session default, not per-bot identity; a deployment-wide default avoids multiplying configuration and keeps the header mapping aligned with the proxy's own `defaultTaskId`.

**Fix the proxy's single-agent form instead.** Rejected as the fix of record here: the MemoryProxy is vendored upstream (`TencentDB-Agent-Memory`), not a harness package, and the harness-side default task is the smallest change that also matches the header contract the proxy already honors.

## Consequences

Bound Feishu sessions on single-agent teams complete header auto-select registration and resume L0 conversation-memory writes. The default task is model/tool wire-field adjacent rather than model-visible prose, so no session-log event changes; the header emission is asserted by `tdai-memory` unit tests. Deployments whose core does not pre-seed `none` must pin a real `defaultTaskId`. Sessions already sealed `bypassed` in the proxy's sqlite store keep that terminal state until their binding is cleared (proxy restart with a reset store or removed entry), because the L1 terminal cache short-circuits re-registration.