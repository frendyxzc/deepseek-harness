# Agent Note: Bootstrap the memory admin user once MemoryCore starts

Status: implemented

[English](2026-08-23-setup-dsh-admin-bootstrap-after-core-start.md) | 中文

## Problem

TencentDB memory core 的元数据库是懒建的：SQLite schema 在首个 `/v3/meta` 请求时才落盘，而不是进程启动时，且 core 从不自动创建 admin 用户。`setup.sh` 只在数据库文件已存在时才引导 admin，因此全新部署时引导被跳过。面板随后拒绝一切登录（"user_key 无效或已吊销"），直到运维在首次对话后补跑一次 `setup.sh`——而部署流程从未提及这一步。另有一个次要缺口：凭据库的读取正则锚定行首的 `PROXY_USER_KEY:`，一旦 harness 把 `.credentials.yaml` 重写为带缩进的 `refs:` 结构就不再匹配。

## Decision

`start-all.sh` 在 MemoryCore 报告健康后立即执行 `bootstrap_memory_admin` 步骤。该步骤用故意无效的 key 探测 `POST /v3/meta/auth/verify` 以强制建库，最多等五秒让 `{DSH_MEMORY_DATA_DIR:-~/.memory-tencentdb/memory-tdai}/metadata/tdai_metadata_default/metadata.db` 出现，在没有 `system_admin` 行时插入以 `PROXY_USER_KEY` 为密钥的 admin 用户——与 `setup.sh` §6f 相同的 SQL。所有失败路径只告警并让其余服务继续启动：探测未能建库、凭据库缺少 key、或数据库已有 admin 用户（幂等情形）。两个脚本读取凭据库时现在都匹配可选前导空白，harness 重写文件后依然有效。

`setup.sh` 同时批准 `protobufjs` 的构建脚本（与 `better-sqlite3`、`esbuild` 并列）：pnpm 11 对未批准的构建脚本会硬失败 `install`，而 `MemoryKnowledge` 依赖 `protobufjs`。

## Alternatives considered

**首次对话后补跑 `setup.sh`。** 否决，因为引导依赖一个未文档化的手工步骤，其失败表现是登录被拒且无任何指向原因的线索。

**让 core 启动时创建 admin 用户。** 否决，因为 core 是上游克隆；本地补丁会偏离 `feat/server_team`，每次同步都要重新适配。

**从 web profile 或面板引导。** 否决，因为 `start-all.sh` 已拥有服务启动顺序，且恰好在 core 首次可达时运行——那也是 schema 首次能被强制建出的时刻。

## Verification

删除 admin 行后对运行中的 core 重跑 `start-all.sh` 可复现引导（`memory admin user bootstrapped with PROXY_USER_KEY`）；第二次运行则跳过（`memory admin user already present`）。引导后 `POST /v3/meta/auth/verify` 经 core 与面板代理均返回 `valid: true` 且 `user_type: system_admin`。

## Consequences

全新部署现在仅凭 `setup.sh` + `start-all.sh` 即可得到可用的 admin 登录。探测请求依赖 core 在无 bearer 门禁下应答 `/v3/meta/auth/verify`——本地 standalone 布局满足此条件；门禁了 verify 路由的部署只会看到文档所述的告警，仍需 §6f 兜底。该步骤每次启动都会运行，因此从活跃数据库删除 admin 用户的运维会在下次启动时看到它被重建。
