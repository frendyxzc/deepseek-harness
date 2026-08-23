# setup-dsh — 一键本地环境引导

[English](README.md) | 中文

复现本 checkout 依赖但未随仓库发布的配置：`~/.dsh` 下的 harness 主目录（settings、credentials、`web` profile），以及该 profile 的 `llm-deepseek.baseURL` 所指向的 [TencentDB-Agent-Memory](https://github.com/frendyxzc/TencentDB-Agent-Memory) 技术栈（`http://127.0.0.1:8096`）。提供 bot 用户名时，它还会安装可选的 [GitLab MR 集成](#gitlab-mr-integration-optional)（仓库根目录的 `gitlab-mr/`）。

## Run

```sh
./scripts/setup-dsh/setup.sh
```

它是幂等的——除非传入 `--force`，已有文件会被保留。密钥以交互方式提示输入，除非通过 `DSH_*` 环境变量提供（见 `setup.sh --help`），或使用 `--non-interactive` 以报错代替提示。

## One-key (config-driven) run

```sh
./scripts/setup-dsh/setup-one.sh [--env PATH] [setup.sh options...]
```

`setup-one.sh` 从配置文件读取 `DSH_*` 值（默认 `~/.dsh/setup-dsh.env`，可用 `--env` 或 `$DSH_SETUP_ENV_FILE` 覆盖），导出后运行 `setup.sh --non-interactive`：无提示，缺失的必需密钥会大声报错。填好的模板在 `scripts/setup-dsh/setup.env.example`——复制到 `~/.dsh/setup-dsh.env`（`chmod 600`），填入各值，并让它不进 git。

## What it writes

| 目标 | 来源 | 密钥？ |
|---|---|---|
| `~/.dsh/settings.yaml` | `templates/settings.yaml` | 否 |
| `~/.dsh/.credentials.yaml` | 提示输入的 `PROXY_USER_KEY` | 是（0600） |
| `~/.dsh/profiles/web/*` | `templates/profile-web/*` | 否（`cwd`/`fallbackChatId` 由参数填入） |
| `<repo>/.env` | 提示输入的 `DEEPSEEK_API_KEY`、`FEISHU_*` | 是（gitignored） |
| `~/.dsh/tdai-stack/TencentDB-Agent-Memory` | git clone `feat/server_team` | — |
| `~/.dsh/tdai-stack/config/proxy-config.yaml` | `templates/tdai-stack/proxy-config.yaml` + 提示输入的上游 URL/key | 是（0600） |
| `~/.dsh/tdai-stack/config/tdai-gateway.yaml` | `templates/tdai-stack/tdai-gateway.yaml` + 提示输入的 `TDAI_LLM_*` | 是（0600） |
| `…/MemoryPanel/.env` + `config/metadata-instances.json` | `.env.example` / 提示输入的 gateway bearer | 部分 |
| `…/MemoryPanel/web/dist/` | 在 `MemoryPanel/web/` 中 `npm ci && npm run build`（上游只随仓库发布源码；没有这一步，面板对 `/` 返回 404） | 否 |
| `…/MemoryKnowledge/.env` | `.env.example` | 否 |
| `…/MemoryCore/.env.local` | 提示输入的 `TDAI_LLM_*`（把 `TDAI_GATEWAY_CONFIG` 指向 `tdai-stack/config/tdai-gateway.yaml`） | 是（0600） |
| `…/{MemoryCore,MemoryPanel,MemoryKnowledge}/pnpm-workspace.yaml` | pnpm 11 构建审批：决定上游 `approve-builds` 占位符（`allowBuilds`：放行 better-sqlite3/esbuild，其余显式拒绝） | 否 |
| `…/metadata.db` → `meta_users` + `meta_user_keys` | 数据库存在但没有 admin 用户时，用 `PROXY_USER_KEY` 引导 MemoryCore admin 用户（使 agent 能通过代理认证） | 是 |
| `~/.dsh/skills/gitlab-mr-workflow/` | `gitlab-mr/gitlab-mr-workflow/*`（仓库）—— GitLab MR 工作流 skill | 否 |
| `~/.dsh/profiles/web/cordis.patch.yml`（+`gitlab-mr` 条目） | `gitlab-mr/gitlab-mr-poller.mjs`（仓库）—— poller 插件挂载 | 否 |
| `<repo>/.env`（+`GITLAB_TOKEN`） | 提示输入的 `DSH_GITLAB_TOKEN` | 是（gitignored，由 §7 追加） |

`templates/` 下的模板是非密钥 DSH 配置的事实来源。改它们并用 `--force` 重新运行以重新部署。

## GitLab MR integration (optional)

提供 `DSH_GITLAB_BOT_USERNAME`（或用 bot 的 GitLab 用户名回答提示）即启用 GitLab MR 闭环；空值则完全跳过。启用后 setup.sh 安装三样东西（见 [gitlab-mr README](../../gitlab-mr/README.zh.md)）：

1. **Skill** —— `gitlab-mr/gitlab-mr-workflow` 复制到 `~/.dsh/skills/`，即用户 skills 根目录 `skill-filesystem` 扫描的位置，使 agent 获得 git + `glab` 出站工作流（建分支/提交/MR/评论）与合并沉淀模板。
2. **Poller 插件** —— 向 `~/.dsh/profiles/web/cordis.patch.yml` 追加 `gitlab-mr` patch 条目，按指向本 checkout 的绝对路径挂载 `gitlab-mr-poller.mjs`。它注册 `gitlab_watch_mr` 工具并轮询已登记 MR，让新评论 / 合并 / 关闭唤醒所属会话。
3. **Token** —— `DSH_GITLAB_TOKEN` 以 `GITLAB_TOKEN` 追加到 `<repo>/.env`（提供且尚不存在时）；poller 与 agent 的 `glab` 都从环境读取它。

相关变量：`DSH_GITLAB_BOT_USERNAME`（启用）、`DSH_GITLAB_API_BASE`（默认 `https://gitlab.com/api/v4`）、`DSH_GITLAB_TOKEN`（bot 的 PAT）。把它们写进 `~/.dsh/setup-dsh.env`（`setup.env.example` 有填好的模板），走无提示的 `setup-one.sh` 路径。

## Start the services (after setup)

```sh
./scripts/setup-dsh/start-all.sh    # start everything in dependency order
./scripts/setup-dsh/stop-all.sh     # stop everything it started
```

`start-all.sh` 把五个服务分别守护化，日志写到 `~/.dsh/run/logs/`、pidfile 写到 `~/.dsh/run/pids/`，并在启动下一个前等待每个服务的 `/health`（dsh Web UI：`/`）。已在监听端口上运行的服务会被跳过，因此重复运行是安全的。`stop-all.sh` 只杀掉 pidfile 中记录的进程树——手工启动的服务不受影响。

MemoryCore 就绪后，`start-all.sh` 还会用 `PROXY_USER_KEY` 自动引导 admin 用户（core 的元数据库是懒建库，首次部署时 setup.sh 的引导会因库不存在而跳过；探针请求建库后若 `meta_users` 里没有 `system_admin` 就补插，已存在则跳过）。

顺序与端点：

1. MemoryCore `:8420`（`/health`）
2. MemoryProxy `:8096`（`/health`）
3. MemoryKnowledge `:8421`（`/health`）
4. MemoryPanel `:8123`（`/health`，绑定所有接口）
5. dsh Web UI `:3080`（`/`，绑定所有接口）

dsh Web UI 以 `--host 0.0.0.0` 启动，MemoryPanel 生成的 `.env` 设置 `HOST=0.0.0.0`，因此另一台机器上的浏览器分别经 `http://<本机局域网 IP>:3080` 与 `:8123` 访问它们。其余 `127.0.0.1` 端点是同机服务链路——dsh → 代理（`:8096`）、代理 → core（`:8420`）——保持回环是正确的。两个暴露面都无认证运行，因此在共享网络上要防火墙封禁 `:3080` 与 `:8123`。

对于一次性手工启动，唯一没有仓库自带启动辅助脚本的服务是 MemoryCore；启动 gateway 前先 source 它的 `.env.local`：

```sh
cd ~/.dsh/tdai-stack/TencentDB-Agent-Memory/MemoryCore
set -a && . ./.env.local && set +a
node --import tsx src/gateway/server.ts
```

## Ports

| 端口 | 服务 |
|---|---|
| 3080 | dsh Web GUI |
| 8096 | MemoryProxy（dsh 的 `llm-deepseek.baseURL`） |
| 8123 | MemoryPanel（团队记忆控制、无状态面板） |
| 8420 | MemoryCore（内核 gateway） |
| 8421 | MemoryKnowledge（Wiki / Code-Graph） |

> 本本地部署在 **8123** 上运行无状态面板（`MemoryPanel`）。
> 上游仓库 `deploy/global-images` 中的 docker "memory-hub" 镜像
> 使用 **8125** —— 那是另一套（容器化）部署。
