# Agent Note: Launch the LAN Web listener on one concrete address

Status: implemented

English | [中文](2026-10-18-web-lan-concrete-address-launch.zh.md)

## Problem

`scripts/setup-dsh/start-all.sh` served the Web UI with `pnpm dsh web --host 0.0.0.0 --port 3080`, and `setup.sh` printed the same command as the one-service manual path. Upstream's [bind one concrete Web address](../architecture/2026-09-19-concrete-web-bind-address.md) decision rejects the unspecified address in `dsh web --host` and in `webserver.config.host` — it measured that a wildcard bind hands remote code execution to every network the machine joins — and it deleted the bind-time LAN sampling that this fork's [LAN access re-enablement](../feature/2026-08-19-web-lan-access-re-enabled.md) recorded. After the `dsh-v0.2.1-rc.2` merge, `dsh web --host 0.0.0.0` exits 1 before it listens, so the stack launch would have died at its own readiness wait and the summary would have advertised a URL no process bound.

## Decision

The launcher names one concrete address instead of asking the listener to own them all. `start-all.sh` resolves the Web bind host in this order: the `--host` option, `DSH_WEB_HOST`, the `lan_ip` of the interface carrying the default route, then `127.0.0.1` with a warning when the machine has no LAN address. It passes that value both to `pnpm dsh web --host` and to `start_service`, so the "already listening" skip, the readiness probe, and the printed summary name the address the listener actually holds. `lib.sh`'s `is_listening` takes the address and prefers `lsof`, then `ss`, before the `nc` and `/dev/tcp` probes that can only dial one address; `wait_healthy` forwards the address to it. `setup.sh` prints the resolved address in its manual-start hints. The memory panel keeps its own `HOST=0.0.0.0`: that service lives in the separate TencentDB checkout and answers to no part of the Web bind policy.

## Alternatives considered

**Bind `127.0.0.1` and require an SSH tunnel for remote browsers.** Rejected — the fork's deployment exists so a laptop or phone on the same network opens the UI and the memory panel without extra tooling; a loopback bind would delete a supported workflow to avoid naming one address.

**Patch the wildcard bind back into `dsh web`.** Rejected — the rejection carries upstream's security reasoning, is asserted by `apps/cli/tests/built-bin.e2e.ts` and `packages/bundle/web-app/tests/startup.spec.ts`, and a fork-local override would re-accumulate conflict in every sync round. Binding the address the operator actually uses grants the same reach.

**Run one listener per address, loopback plus LAN.** Rejected — one port holds one listener, so a second process needs its own port and its own Session, profile, and token; it doubles the supervision this script already does for one.

## Consequences

A LAN bind answers only on that address: `http://127.0.0.1:3080` refuses while the LAN address serves, so `start-all.sh` prints the bound URL and `scripts/setup-dsh/README.md` states the same limit. Readiness, restart detection, and the port-free wait keep working because `lsof` and `ss` see any bind address; a host with neither can only probe the address it names, which the launcher now supplies. The fork still tells a LAN browser that the configuration plane is local-only (`ctx.remote.$host.isLoopback` in [ui-settings-general](../../../../packages/client/ui-settings-general/src/client/index.ts) and the Models store), although upstream now authenticates every browser with the process launch token and admits the listener's own bind address through the Host fence; retiring that client-side gate is a separate decision with its own exposure review.

## Testing

`bash -n` on `lib.sh`, `start-all.sh`, and `setup.sh`. Measured against the merged tree: `pnpm dsh web --host <LAN IPv4> --port 3980 --no-open` warned about plain HTTP and printed `dsh web: http://<LAN IPv4>:3980/?token=…`; the same port on `127.0.0.1` refused the connection; the token request answered `303` with an `HttpOnly` `SameSite=Strict` cookie whose audience is the bound authority; the clean path answered `200` with that cookie and `401` without it; `pnpm dsh web --host 0.0.0.0` exited 1 with the wildcard message and no URL line.
