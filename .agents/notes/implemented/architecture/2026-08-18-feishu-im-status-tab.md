# Agent Note: Feishu IM status tab

Status: implemented

English | [中文](2026-08-18-feishu-im-status-tab.zh.md)

## Problem

The web settings page had no way to surface the Feishu integration's runtime state. A deployment that configured a Feishu bot provider could not show whether the connection was active, what App ID was in use, or whether message receiving was running. Troubleshooting required reading Host logs or inspecting `cordis.yml` directly.

## Decision

**Seam gains a non-throwing status projection.** `ctx.feishu.describeStatus()` applies the same selection rules as the runtime's provider resolution (configured id → exactly-one-available → error) but returns a `FeishuRuntimeStatus` discriminated union instead of throwing. The existing selection error messages are preserved verbatim. Provider `status()` is an optional method on `FeishuProvider`; a provider without it is projected from `available()` alone.

**A dedicated gateway package projects the seam over TypertRemote.** `@deepseek-ai/dsh-feishu-status` owns one `@Remote('status')` method that calls `describeStatus()` and flattens the result into `FeishuStatusView` — the explicit wire contract defined in its own `types.ts`. Identifying values (App ID) are masked server-side; secrets reduce to booleans. The gateway adds no new capability; it is a read-only projection of what the seam already knows.

**The IM tab registers as a `settings.plugins.tab` contribution.** `@deepseek-ai/dsh-client-ui-settings-im` injects a tab at id `im`, order 20, under the Plugins section. The tab calls `ctx.remote.feishuStatus.status()` on demand — never polling — and renders connection state, provider id, masked App ID, secret configuration, base URL, receive activity, and any last error or selection error. The locale namespace is `settings.im`.

**The remote is mounted in the remotes assembly.** `@deepseek-ai/dsh-api-remotes/client` imports and mounts `feishuStatusRemote` alongside the existing `pluginInventoryRemote`, and re-exports `FeishuStatusView` so client packages name one assembly.

## Alternatives considered

**Live push via forwarded events.** Rejected: status is read-on-demand (the tab is rarely open), and a push channel for state that changes a few times per session is disproportionate. The tab re-reads on every render.

**Status as part of plugin-inventory.** Rejected: the inventory lists Cordis Loader plugins; the IM tab renders the Feishu capability's effective state, which is a different surface. Merging them would overload the inventory with capability-specific knowledge.

**Extending `feishu-bot` to also expose the remote.** Rejected: conflates the provider role (establishing the connection) with the gateway role (projecting status for observation). Keeping them separate follows the capability-seam pattern: Service Definition / Provider / Consumer roles split when they evolve independently.

**A generic capability-status registry.** Rejected: no second capability needs this today, and inventing a registry ahead of its second use is the speculative option the package rules forbid. The pattern (seam `describeStatus` → gateway → tab) is documented here for reuse when a second surface appears.

## Consequences

Any future capability that needs a read-only web status view follows the same three-package shape: seam extension, gateway, client tab. The gateway's wire type is the boundary; changes to provider internals do not cross it unless `FeishuProviderStatus` fields change.

The tab reads once per activation and does not subscribe to changes. A long-running session that toggles the Feishu provider sees stale status until the tab re-renders (unmount + remount). A future invalidation channel could fix this without a wire-contract change.

The `feishu-status` gateway depends on `@deepseek-ai/dsh-feishu` as a peer; mounting it in a deployment that does not load the Feishu seam fails loud at plugin load, following the misconfiguration policy.
