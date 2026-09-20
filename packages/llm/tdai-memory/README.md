---
description: "Per-Feishu-bot TDAI MemoryProxy identity for outgoing LLM requests: which team/agent/task headers a session sends, the core team and agent catalog behind the Settings dropdowns, and where the memory-registration boundary sits."
kind: "package-reference"
---

# @deepseek-ai/dsh-tdai-memory

English | [中文](README.zh.md)

## Summary

Use this package so each Feishu bot's conversations accumulate memory in its own TDAI MemoryProxy tenant instead of one shared store. A chat with a mapped bot sends that bot's `x-team-id` and `x-agent-id`, plus the configured default `x-task-id` — the trio the proxy's header auto-select needs before it registers a session and starts writing memory. Unmapped bots and plain Web or harness sessions send no identity, so they stay outside the stores. The same core supplies the team and agent lists the Settings dropdowns offer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The base bundle already mounts the package, so a base-backed profile adds no row: `ctx.tdaiMemory` is available to the LLM adapters, and the mapping itself lives in the `feishu-bot` settings section, where a bot entry that carries neither a team nor an agent id contributes no identity header.

### When to choose it

Choose it when a deployment runs the TDAI MemoryProxy beside dsh and wants more than one Feishu app writing into separate memory stores; one bot mapped to its own team and agent is already worth it. Skip it when no proxy is deployed: the adapters read the identity through an optional `ctx.get('tdaiMemory')`, so `dsh-llm-deepseek` and `dsh-llm-pi-ai` keep assembling ordinary requests when this package is absent.

### Minimal configuration

The smallest mount is the row the base bundle inserts, and it is also the recommended starting point because it pins the default task:

```yaml
- id: tdai-memory
  name: '@deepseek-ai/dsh-tdai-memory'
  config:
    defaultTaskId: 'none'
```

| Field | Default | Meaning |
|---|---|---|
| `endpoint` | `http://127.0.0.1:8420` | TDAI core base URL the catalog Remotes read from |
| `serviceId` | `default` | Core tenant/service id sent on catalog requests |
| `serviceToken` | `local` | Core service token sent on catalog requests |
| `userKeyEnv` | `PROXY_USER_KEY` | Credential reference naming the core user key (`sk-mem-*`) |
| `defaultTaskId` | `none` | Task sent as `x-task-id` for every mapped bot's requests |

`listTeams` resolves `userKeyEnv` through `ctx.credentials` before it contacts the core, so an unresolved reference is why a Settings dropdown arrives empty. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tdai-memory) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package holds three separable pieces — the header builder, the session → bot bindings, and the core catalog Remotes — and owns no configuration of its own: the mutable per-bot mapping is the `feishu-bot` section that `dsh-feishu-bot` installs and the Web settings surface edits.

### Identity resolution

`identityFor(botId)` reads the resolved `feishu-bot` section and returns the `bots[]` entry whose `id` matches, so a `teamId` / `agentId` reaching the wire has already passed the settings schema. The result feeds the exported pure function `tdaiMemoryHeaders`, which emits `x-team-id` and `x-agent-id` for the non-empty ids and `x-task-id` for `resolveTaskId()` — `Config.defaultTaskId` trimmed, falling back to the `none` value the core pre-seeds into every team. An empty field drops just its own header, so a mapped entry without an identity still contributes the task.

### Session bindings

`bindSession(sessionId, botId)` records the pair in a process-local `Map`; `feishu-receive` calls it when it accepts an inbound message, and the LLM adapters call `headersForSession(sessionId)` per request. An unbound session resolves to an empty header map, which is how a plain Web session keeps its requests identity-free, and a restart leaves every chat unbound until its next message re-binds it.

### Core catalog

`listTeams` and `listAgents` are Typert Remotes on the `tdaiMemory` service that POST `/v3/meta/team/list` (body `{ user_key }`) and `/v3/meta/agent/list` (body `{ team_id, status: 'active' }`) to `endpoint`, authenticated with `authorization: Bearer <serviceToken>`, `x-tdai-service-id`, and `x-tdai-user-key`. A non-2xx response or a non-zero envelope `code` raises a `tdai-memory: core <path> …` error, and entities without a string id or name are dropped rather than surfaced as blank dropdown options.

Exact detail lives in `src/index.ts` (config, service, header builder), `src/types.ts` (the catalog option shapes), and `tests/tdai-memory.spec.ts` (the pinned header and task behavior).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the owner of the mapping, the two sides of the session binding, and the surfaces that read the catalog.

- [feishu-bot](../../feishu/feishu-bot/README.md) — the plugin that installs the `feishu-bot` section this package reads.
- [feishu-receive](../../feishu/feishu-receive/README.md) — the receive channel that calls `bindSession` for each inbound message.
- [llm-deepseek](../llm-deepseek/README.md) — the adapter that resolves a session's headers into the outgoing request.
- [llm-pi-ai](../llm-pi-ai/README.md) — the second adapter, which reserves the TDAI header names for harness use.
- [ui-settings-im](../../client/ui-settings-im/README.md) — the Settings tab where a user fills in the team and agent ids.
- [tdai-memory subsystem](../../../docs/subsystems/tdai-memory.md) — the generated service surface for this package.
- [Configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tdai-memory) — every accepted field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

None, as the identity it resolves reaches the proxy only as model-hidden HTTP request headers; it registers no prompt, tool schema, or session event.

#### KV Cache effect

None; the headers accompany the request body rather than entering it, so an unchanged conversation prefix keeps the exact bytes a provider cached, and editing a bot's team or agent changes only transport metadata.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are current package constraints, each naming the boundary a deployment has to respect.

- **Session bindings are not durable** — the session → bot map is process-local, so after a restart every Feishu chat is unbound until its next message re-binds it; nothing here persists the pairing.
- **Only the Chat Completions protocol carries the headers** — `dsh-llm-deepseek` resolves them in its Chat Completions adapter while its Messages adapter sends no TDAI header, so a Messages-route deployment registers nothing at the proxy.
- **The catalog is advisory** — `listTeams` and `listAgents` only supply dropdown options; a hand-written team or agent id keeps working when the core is unreachable, and nothing here validates an id against the catalog.
- **The user-key error names the default reference** — an unresolved key reports `set PROXY_USER_KEY` even when `userKeyEnv` configures a different reference, so a renamed reference fails with a message pointing at the wrong variable.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The `defaultTaskId` value is the easy thing to break: `none` mirrors the proxy's own `sessionInit.defaultTaskId`, and a deployment that pins a real task has to keep this row and the proxy in step or the proxy stops registering sessions and memory silently stops. Each side asserts only its own half, so changing one is a two-repository check.

</details>

**Runtime invariant:** The `./invariant` companion publishes an intentionally empty installer: the settings schema validates the bot list before `identityFor` can observe it, and the in-memory binding's only consequence — the request headers — is pinned by the adapter tests.
