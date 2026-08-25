# Agent Note: Install the memory stack under the Node the services start on

Status: implemented

English | [中文](2026-08-25-setup-dsh-memory-stack-node-match.zh.md)

## Problem

`start-all.sh` starts every TencentDB memory service on Node v22 (bundled `$DSH_HOME/tdai-stack/node22`, then Homebrew `node@22`), but `setup.sh` installed and verified dependencies under the ambient Node. After the machine's ambient Node moved to v26 (npm 11), `setup.sh --upgrade` died at `MemoryProxy better-sqlite3 native binding failed to build`. Two independent traps hid behind one symptom:

- npm 11 blocks dependency install scripts unless `package.json` `allowScripts` names them. `better-sqlite3` is an optionalDependency upstream, so npm silently omitted it from `node_modules` entirely while `npm install better-sqlite3` still reported "up to date" — the package was never present to repair. (`npm install-scripts approve` cannot help either: it refuses a package that is not installed, so the approval tool is circular for exactly this case.)
- Native bindings are ABI-specific. A binding built under Node 26 (ABI 147) fails to load under the Node 22 (ABI 127) the services start on with `ERR_DLOPEN_FAILED`, and a Node-22-built binding makes the ambient-Node check falsely report "missing" forever. The check and the repair both had to run under the stack's Node.

## Decision

`lib.sh` gains `stack_node_bin`, the single resolution of the Node the stack runs on (bundled node22, then Homebrew node@22, else the ambient node). `start-all.sh` replaces its inline block with it; `setup.sh` sources `lib.sh` and runs every memory-stack install (proxy npm, core/panel/knowledge pnpm, panel web build) and the `better-sqlite3` verify-and-repair under that same Node, restoring `PATH` when done. The verify therefore checks exactly what the services will load, and the repair installs exactly the ABI they need.

For the fallback where no pinned Node exists anywhere, `ensure_proxy_npm_approvals` idempotently patches `MemoryProxy/package.json` with an `allowScripts` entry mirroring the proxy's own upstream `pnpm-workspace.yaml` `allowBuilds` (better-sqlite3/esbuild/node-pty/protobufjs), so npm 11 installs the optional dependency instead of omitting it; npm 10 ignores the field, so the patch is inert under the pinned toolchain. The approval patch runs even under `--skip-install`, like the pnpm-workspace.yaml patches (the pnpm-side approvals predate this fix — see the [MemoryCore admin bootstrap note](2026-08-23-setup-dsh-admin-bootstrap-after-core-start.md)). `start-all.sh`'s storage guard now points the repair at `setup.sh --upgrade` instead of a bare `npm install better-sqlite3` that would hit the same traps.

## Alternatives considered

**Approve scripts via `npm install-scripts approve`.** Rejected: the command only matches installed packages, and the omitted optional dependency is exactly the one not installed — the approval tool cannot unstick its own failure mode.

**Bump `better-sqlite3` to a version with Node 26 prebuilds.** Rejected: it would build the binding for the ambient Node while the services run Node 22, recreating the ABI failure on the other side, and it diverges the deployment from the upstream range.

**Duplicate the node22 path checks in `setup.sh`.** Rejected in favor of `lib.sh`'s `stack_node_bin`, which gives both scripts one home for the fact so they cannot drift apart.

## Verification

Reproduced the original failure: under the ambient Node 26/npm 11 the proxy's `npm ls better-sqlite3` reported `(empty)` while `npm install better-sqlite3` said "up to date". With `stack_node_bin` (→ Homebrew `node@22` here) prepended, the install fetched the binding and `require('better-sqlite3')` succeeded under Node 22 while the same binding failed under Node 26 with `ERR_DLOPEN_FAILED` — proving both the fix and why the check must run under the stack's Node. The `allowScripts` patch is idempotent (second run reports no change). Re-running `./scripts/setup-dsh/setup.sh --upgrade` completes the migration instead of dying at the binding check.

## Consequences

`setup.sh` and `start-all.sh` can no longer disagree about which Node the memory stack runs on: installs, the binding check, and service startup all use `stack_node_bin`. A machine without any Node 22 falls back to the ambient Node consistently in both scripts, where the `allowScripts` patch keeps npm 11 installs honest. The deployment-local `MemoryProxy/package.json` gains a generated `allowScripts` field; upstream `git pull` may drop it, and the next `setup.sh` run restores it.
