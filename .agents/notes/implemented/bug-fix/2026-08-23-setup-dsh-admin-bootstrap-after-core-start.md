# Agent Note: Bootstrap the memory admin user once MemoryCore starts

Status: implemented

English | [中文](2026-08-23-setup-dsh-admin-bootstrap-after-core-start.zh.md)

## Problem

The TencentDB memory core builds its metadata database lazily: the SQLite schema materializes on the first `/v3/meta` request, not at process start, and the core never auto-creates the admin user. `setup.sh` bootstraps the admin only when the database file already exists, so on a fresh deployment the bootstrap is skipped. The panel then rejects every login with "user_key 无效或已吊销" until the operator re-runs `setup.sh` after the first chat — a step the deployment flow never mentions. A secondary gap: the credentials-store rewrite pattern anchored `PROXY_USER_KEY:` at line start, which stops matching once the harness rewrites `.credentials.yaml` into the indented `refs:` structure.

## Decision

`start-all.sh` runs a `bootstrap_memory_admin` step immediately after MemoryCore reports healthy. The step probes `POST /v3/meta/auth/verify` with a deliberately invalid key to force schema creation, waits up to five seconds for `{DSH_MEMORY_DATA_DIR:-~/.memory-tencentdb/memory-tdai}/metadata/tdai_metadata_default/metadata.db` to appear, and inserts the admin user keyed with `PROXY_USER_KEY` when no `system_admin` row exists — the same SQL as `setup.sh` §6f. Every failure path only warns and lets the remaining services start: a probe that does not create the database, a key missing from the credentials store, or a database that already has an admin user (the idempotent case). The credentials-store read in both scripts now matches optional leading whitespace so it keeps working after the harness rewrites the file.

`setup.sh` also approves the `protobufjs` build script alongside `better-sqlite3` and `esbuild`: pnpm 11 hard-fails `install` on an unapproved build script, and `MemoryKnowledge` depends on `protobufjs`.

## Alternatives considered

**Re-run `setup.sh` after the first chat.** Rejected because the bootstrap depends on an undocumented manual step whose failure mode is a rejected login with no pointer to the cause.

**Make the core create the admin user at startup.** Rejected because the core is an upstream clone; a local patch would diverge from `feat/server_team` and re-baseline on every sync.

**Bootstrap from the web profile or the panel.** Rejected because `start-all.sh` already owns service startup order and runs exactly when the core first becomes reachable, which is also when the schema can first be forced into existence.

## Verification

Deleting the admin rows and re-running `start-all.sh` against the running core reproduces the bootstrap (`memory admin user bootstrapped with PROXY_USER_KEY`); a second run skips it (`memory admin user already present`). `POST /v3/meta/auth/verify` returns `valid: true` with `user_type: system_admin` through both the core and the panel proxy after bootstrap.

## Consequences

A fresh deployment now reaches a working admin login from `setup.sh` + `start-all.sh` alone. The probe request depends on the core answering `/v3/meta/auth/verify` without a bearer gate, which holds for the local standalone layout; a deployment that gates the verify route sees only the documented warning and still needs the §6f fallback. The step runs on every start, so an operator who deletes the admin user from a live database gets it recreated on the next start.
