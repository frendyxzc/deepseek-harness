# Agent Note: A named Feishu bot resolved the flat single-app secret instead of its per-id reference

Status: implemented

English | [中文](2026-09-14-feishu-named-bot-secret-ref.zh.md)

## Problem

`credentialFor` returned the flat single-app fields for every bot whenever the composition's `credentials` list was empty (`botId === ... || config.credentials === undefined || config.credentials.length === 0`). Because the `Config` schema defaults `appSecretEnv` to `FEISHU_APP_SECRET`, a named bot resolved that flat default `appSecretEnv` and never fell through to its per-id reference. `qa` therefore authenticated with the flat app's secret, failing with `app secret invalid` and pinning `status()` to `error`, while the correctly stored `FEISHU_APP_SECRET_QA` was never consulted.

## Decision

`credentialFor` returns the flat single-app fields only for the flat single-app provider id (`FEISHU_BOT_PROVIDER_ID`). A named bot with no matching `credentials` entry falls through empty, so `resolveOptions` derives its App Secret from `feishuAppSecretRef(botId)` as the function's contract already stated.

## Alternatives considered

**Remove the `appSecretEnv` / `appIdEnv` schema defaults.** Rejected: the flat single-app path relies on those defaults, and dropping them would break the flat provider's conventional `FEISHU_APP_SECRET` resolution.

**Special-case a bot whose literal App ID matches the flat `FEISHU_APP_ID`.** Rejected: that re-introduces an implicit "this bot is the flat app" rule the per-id derivation already expresses without a hidden match.

## Consequences

- A named bot resolves its secret under `FEISHU_APP_SECRET_<ID>`, matching the Settings IM tab and the `feishuAppSecretRef` contract.
- A bot that was previously the flat single-app (its App ID equals `FEISHU_APP_ID`) must now store its secret under its own per-id reference (`FEISHU_APP_SECRET_<ID>`), not the flat `FEISHU_APP_SECRET`.

## Testing

`packages/feishu/feishu-bot/tests/index.spec.ts` boots the plugin with a `qa` bot and no `credentials` list, then asserts `status()` resolves `FEISHU_APP_SECRET_QA` and never the flat `FEISHU_APP_SECRET`.