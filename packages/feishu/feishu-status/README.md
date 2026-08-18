# @deepseek-ai/dsh-feishu-status

English | [中文](README.zh.md)

Read-only Host projection of the Feishu capability's effective connection status. `FeishuStatusGateway` registers the `feishuStatus` service and publishes one generated direct Remote, `feishuStatus/status`. Every call asks `ctx.feishu.describeStatus()` for the current selection-aware status and forwards it as a `FeishuStatusView`, so the view reflects the provider registry as it stands now.

The view carries the effective connection state (`unavailable`, `unconfigured`, `connected`, or `error`), the selected provider id, the selected provider's own display-safe status report (`FeishuProviderStatus`), and the selection failure explanation when the seam could not select a provider. Providers mask identifying values and reduce secrets to booleans before the view crosses the wire; this package adds no masking of its own. Its public payload types live under `./types`, and Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

The service is Remote-only and deliberately declares no same-process Cordis `Context` merge. Client packages consume it through the explicit [`api-remotes`](../../api/remotes/README.md) assembly rather than importing the Host implementation.

## Model Experience

None, as this Host-only status projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Point-in-time state only** — the result contains no durable failure history or subscription; the tab re-queries for updates.
