# Agent Note: setup-dsh 将 Knowledge 的 wiki-ingest LLM 配置为 custom 模式

Status: implemented

[English](2026-09-02-knowledge-wiki-ingest-llm-custom.md) | 中文

## Problem

`setup.sh` §6c 原样拷贝 `MemoryKnowledge/.env.example`。该模板文件出厂即 `LLM_MODE=proxy`、`LLM_BASE_URL` 为空、且没有 `LLM_API_KEY`；proxy 模式从 TMC 控制面推送的、按 `service_id` 区分的 `llm_binding` 解析 wiki-ingest LLM，而 `resolveLlmConfig` 在无 binding 时刻意清空凭据，让 ingest 大声失败而非静默回退到直连端点。standalone 部署没有 TMC，于是每次 wiki ingest 都报 `LLM apiKey 未配置：proxy 模式需 TMC 为该 service_id 推送 llm_binding…`，wiki 卡在 `status: failed`。

## Decision

`setup.sh` §6d 本就把共享的 `DSH_TDAI_LLM_*` 询问一次、写进网关配置与 `MemoryCore/.env.local`。现在 `write_knowledge_llm_env` 用这组值重写 `MemoryKnowledge/.env`——`LLM_MODE=custom` 加 `LLM_MODEL` / `LLM_BASE_URL` / `LLM_API_KEY`，即文档里为「无 TMC 部署」准备的 BYO 路径——并在两处调用：全新安装的 §6d（用刚询问到的值）与 `--upgrade`（从已有的 `MemoryCore/.env.local` 反向 source 出同一组值）。重写是对四条 `LLM_*` 行的幂等 `sed`（`LLM_API_KEY` 缺失时补写），重跑不会与 MemoryCore 漂移，且因现在承载 API key 而 `chmod 600`。

## Alternatives considered

**由本地面板推送按 `service_id` 区分的 `llm_binding`。** 拒绝：standalone 面板本就不推 binding，把云端控制面流程搬进本地路径，等于把一个缺失的控制面变成前置条件，而不是使用本就为此场景准备的 BYO 路径。

**只把克隆仓库的 `MemoryKnowledge/.env.example` 改成 `proxy`。** 拒绝：`proxy` 默认值对 TMC 管理的云端部署才是对的，改动克隆仓库会在每次 sync 时偏离 `feat/server_team`。

**在 `resolveLlmConfig` 里回退读 `TDAI_LLM_*` 环境变量。** 拒绝：代码注释已记录「静默直连回退」被刻意删除，因为它会掩盖缺失的 binding；修复应落在部署供给层，而非服务侧的逃生门。

## Verification

复现了失败（一个 17 文档的 wiki 处于 `status: failed`，报 apiKey 错误）。在共享端点/模型上配好 `custom` 并重启 MemoryKnowledge 后，`POST /v3/wiki/ingest` 到达 `status: ready`、`page_count: 109`、无 LLM 错误。`sed` 重写做了首次运行的转换正确性与第二次运行的幂等性单测（一条 `LLM_API_KEY` 行、值不变）。

## Consequences

全新的一次 `setup.sh` 运行，得到的 Knowledge 服务在共享端点上开箱即可完成 wiki ingest；`--upgrade` 也会把同一组值重新供给给早于该修复的部署，无需 `--force`、不重新询问。Knowledge 的 `.env` 权限收紧为 `600`。`--upgrade` 读的是已有 core 配置而非重新询问，已配置机器能幂等地拾取该修复；当 `MemoryCore/.env.local` 缺失或缺少 `TDAI_LLM_*` 时，仅告警并保持目标文件不动。