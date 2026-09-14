# Agent Note: A Feishu bot registered before the credential store's async load fails with a missing App Secret

Status: implemented

English | [中文](2026-09-14-feishu-credential-store-boot-race.zh.md)

## Problem

`dsh-credentials-local` loads `.credentials.yaml` asynchronously (`await this.loadInitial()` inside `Service.init`). `dsh-feishu-bot` injected only `feishu`, so Cordis could register its providers — and `dsh-feishu-receive` could then open their receive channels — before that load completed. A bot whose App Secret lives only in `.credentials.yaml` (e.g. a bot added through the Settings IM tab) resolved the credential store while its refs were still empty, `beginReceiveConnection` threw `FEISHU_PROVIDER_CREDENTIAL_MISSING`, the connection never opened, and `status()` pinned `error` forever (no `onReady` ever fired to clear `lastError`). The flat single-app bot was exempt only because its `FEISHU_APP_SECRET` resolves through the synchronous `.env` fallback, not the file.

## Decision

`dsh-feishu-bot` declares `credentials` in its `inject` (alongside `feishu`). Cordis therefore finishes the credential store's asynchronous load before `apply` registers any provider, so every provider's boot-time credential resolution reads the store after its refs are populated.

## Alternatives considered

**Retry a credential-missing receive setup after a delay.** Rejected: `FEISHU_PROVIDER_CREDENTIAL_MISSING` is also the real-misconfiguration signal; a retry would mask a genuinely absent secret and violate fail-loud-at-earliest-resolvable-point.

**Move the initial load to a synchronous read.** Rejected: file I/O at service construction blocks the boot fiber and abandons the file watcher's hot-reload contract.

## Consequences

- A bot added through the Settings IM tab — whose secret the tab writes to `.credentials.yaml` under `feishuAppSecretRef(id)` — resolves and connects at boot, and a later Settings save re-registers it through the same path, so new bots work without restart and without a `.env` entry.
- The dependency is already satisfied by every shipped composition (the base bundle mounts `dsh-credentials-local` with `dsh-feishu-bot`).

## Testing

`packages/feishu/feishu-bot/tests/index.spec.ts` adds `declares credentials in its inject so file-backed secrets load before providers register`, pinning the `inject` contract; the existing `resolves a named bot App Secret under its per-id reference` test continues to boot the plugin against a credential store mock.