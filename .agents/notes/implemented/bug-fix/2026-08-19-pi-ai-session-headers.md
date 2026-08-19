# Agent Note: pi-ai sends Harness session-identity headers on chat-completions requests

Status: implemented

English | [中文](2026-08-19-pi-ai-session-headers.zh.md)

## Problem

`dsh-llm-deepseek` tags each request with `x-deepseek-harness-user-id`, `x-deepseek-harness-session-id`, and — on compaction — `x-deepseek-harness-compact`, so a reverse proxy can bind a request to its DSH session and inject context. `dsh-llm-pi-ai` sent none of them: `options.sessionId` only fed pi-ai's own provider option, and the request carried just the `user-agent` attribution. A dsh-requesting proxy (for example the TencentDB-Agent-Memory MemoryProxy) therefore saw pi-ai traffic as header-less and could not bind the session — skipping picker interception, context injection, and L0 write-back for every model served on a pi-ai route. The header semantics and their privacy boundary are owned by [the DeepSeek request-identity decision](../feature/2026-08-11-deepseek-request-user-id-header.md); the attribution-versus-identity split is owned by [the mandatory request-attribution decision](../architecture/2026-06-21-mandatory-app-attribution-headers.md).

## Decision

The pi-ai adapter's `requestHeaders` helper now accepts the `GenerateOptions` and appends, after the deployment `profile.headers` and the `user-agent` attribution: `x-deepseek-harness-session-id` (from `options.sessionId`) and `x-deepseek-harness-compact: 1` (when `options.purpose === 'compaction'`). They are spread last so Harness-owned names win collisions with deployment-set headers, the same reserved-name discipline already applied to `user-agent`.

## Alternatives considered

**Add the session header to the shared `attributionHeaders()` helper.** Rejected: that helper is provider-neutral and static; a per-request session value belongs to the request-identity path, not to app attribution, and would reach unrelated adapters.

**Send `x-deepseek-harness-user-id` too for full wire parity.** Rejected: the pi-ai adapter has no anonymous-user-id source, and the consuming proxy derives the user from Bearer auth; the header is not required for session binding.

## Consequences

- pi-ai and llm-deepseek requests now carry the same session-identity headers; a dsh-aware proxy can bind any route uniformly, independent of which adapter serves the selected model.
- `x-deepseek-harness-user-id` remains DeepSeek-only, so pi-ai requests neither mint nor expose an anonymous user id.
- Deployment `headers` can still add arbitrary names; they lose to `user-agent`, `x-deepseek-harness-session-id`, and `x-deepseek-harness-compact`.