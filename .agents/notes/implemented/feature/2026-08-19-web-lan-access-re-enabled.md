# Agent Note: Re-enable LAN access with `--host 0.0.0.0`

Status: implemented

English | [中文](2026-08-19-web-lan-access-re-enabled.zh.md)

## Problem

The web app had shipped `--host 0.0.0.0` as the explicit all-interfaces opt-in ([web bind address](2026-07-22-web-bind-address.md)) and built the `/api` trust fence around it ([api browser-trust boundary](../architecture/2026-07-28-api-browser-trust-boundary.md)). A later review made the command provider reject that flag with a remote-code-execution warning and rewrote the READMEs to say the flag is unsupported until authentication exists, but recorded none of that rationale in an Agent Note. Code and docs therefore contradicted the two design notes, while LAN-browser use — the workflow the flag exists for — had no supported path.

## Decision

`dsh web --host 0.0.0.0` binds every interface again. The default stays `127.0.0.1`, so same-machine use never acquires network reachability implicitly. Binding all interfaces auto-derives the machine's LAN IPv4 literals into the `/api` trust fence, so a LAN browser reaches the app while the fence still refuses a rebound or cross-site request. The deployment remains unauthenticated: the fence is a confused-deputy and DNS-rebinding defense, not authentication, so anyone who can reach the bound port may start a session whose default preset runs `bash` on the host. That exposure is the explicit, documented cost of opting in; authentication for genuinely remote deployments stays deferred work.

## Alternatives considered

**Keep rejecting `--host 0.0.0.0` until authentication exists.** Rejected — it blocks the ordinary LAN-browser workflow indefinitely on work with no schedule, while the existing fence already bounds the browser-originated attack surface; the residual exposure is a trusted-network assumption the operator accepts by opting in.

**Add an authentication layer now.** Rejected as out of scope — it is a separate, larger decision left as deferred work; this change alters only reachability, not the fence.

**Make `0.0.0.0` the default.** Rejected for the same reason as the [web bind address](2026-07-22-web-bind-address.md) decision: same-machine use should not become network-wide implicitly.

## Consequences

The opt-in stays explicit and the loopback default is unchanged, so the safety concern is resolved by operator choice rather than by banning the workflow. A LAN deployment exposes the unauthenticated session surface to every host on the network, and `--trusted-host` declares named authorities beyond the derived LAN literals. Privileged configuration methods remain loopback-only regardless of `trustedHosts`. The plain-HTTP LAN origin is not a secure context, so `crypto.randomUUID()` is undefined in that browser; the client mints RPC-correlation and draft-attachment ids through `crypto.getRandomValues()` instead of the secure-context-only API. The settings shell and the Models page tell a LAN browser that the configuration plane is loopback-only rather than surfacing the raw transport 403. The Memory settings section's jump link to the standalone memory panel follows the page's own host (loopback stays `127.0.0.1`, a LAN origin reuses that host on the panel port), so the panel link keeps resolving when the GUI is opened across the network.