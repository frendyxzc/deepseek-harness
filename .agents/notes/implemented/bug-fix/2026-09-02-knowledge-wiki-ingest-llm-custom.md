# Agent Note: Provision the Knowledge wiki-ingest LLM as custom in setup-dsh

Status: implemented

English | [中文](2026-09-02-knowledge-wiki-ingest-llm-custom.zh.md)

## Problem

`setup.sh` §6c copies `MemoryKnowledge/.env.example` verbatim. That stock file ships `LLM_MODE=proxy` with an empty `LLM_BASE_URL` and no `LLM_API_KEY`; proxy mode resolves the wiki-ingest LLM from a per-`service_id` `llm_binding` that the TMC control plane pushes, and `resolveLlmConfig` blanks credentials when no binding exists so ingest fails loudly rather than silently falling back to a direct endpoint. A standalone deploy has no TMC, so every wiki ingest failed with `LLM apiKey 未配置：proxy 模式需 TMC 为该 service_id 推送 llm_binding…` and the wiki stuck at `status: failed`.

## Decision

`setup.sh` §6d already asks for the shared `DSH_TDAI_LLM_*` values once and writes them into the gateway config and `MemoryCore/.env.local`. `write_knowledge_llm_env` now rewrites `MemoryKnowledge/.env` from those values — `LLM_MODE=custom` plus `LLM_MODEL` / `LLM_BASE_URL` / `LLM_API_KEY`, the documented BYO path for a deployment without a TMC — and is called from two places: the fresh-install §6d (using the just-asked values) and `--upgrade` (sourcing the same values back out of the existing `MemoryCore/.env.local`). The rewrite is an idempotent `sed` over the four `LLM_*` lines (appending `LLM_API_KEY` when absent), so a re-run cannot drift from MemoryCore, and it `chmod 600`s the file because it now carries the API key.

## Alternatives considered

**Push a per-`service_id` `llm_binding` from the local panel.** Rejected: the standalone panel does not push bindings, and routing the cloud control-plane flow into the local path would turn a missing control plane into a prerequisite instead of using the BYO path that already exists for this exact case.

**Patch the clone's `MemoryKnowledge/.env.example` to `proxy` only.** Rejected: the stock `proxy` default is correct for TMC-managed cloud deployments, and editing the clone diverges it from `feat/server_team` on every sync.

**Fall back to `TDAI_LLM_*` env inside `resolveLlmConfig`.** Rejected: the code comment records that a silent direct fallback was deliberately removed because it masked missing bindings; provisioning is the fix, not a service-side escape hatch.

## Verification

Reproduced the failure (a 17-document wiki at `status: failed` with the apiKey error). After provisioning `custom` on the shared endpoint/model and restarting MemoryKnowledge, `POST /v3/wiki/ingest` reached `status: ready` with `page_count: 109` and no LLM errors. The `sed` rewrite was unit-tested for first-run correctness and second-run idempotency (one `LLM_API_KEY` line, unchanged values).

## Consequences

A fresh `setup.sh` run now yields a Knowledge service whose wiki ingest works out of the box on the shared endpoint, and `--upgrade` re-provisions the same values onto a deployment that predates the fix without `--force` or a re-prompt. The Knowledge `.env` is tightened to `600`. The `--upgrade` path reads the existing core config rather than prompting, so an already-provisioned machine picks the fix up idempotently; when `MemoryCore/.env.local` is missing or lacks `TDAI_LLM_*`, it warns and leaves the target file untouched.