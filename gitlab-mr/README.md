# dsh-gitlab-mr — 内网 DSH 打通 GitLab MR 闭环

自托管/内网部署下，用「出站 = git(SSH) + glab(PAT) + skill，入站 = 轮询插件 + MR 登记工具」跑通
「改码 → 建独立分支 → 提交 → push → 建 MR → 登记跟踪 → 响应评论区二次修改 → MR 合并 → 沉淀经验」，
无需公网回调 URL，无需 Composio，无需接入 MCP。

两个资产：

| 文件 | 作用 |
|---|---|
| `gitlab-mr-poller.mjs` | 函数插件：提供 `gitlab_watch_mr` 登记工具 + 后台轮询已登记 MR，检测新评论（过滤 bot 作者）与 merged/closed，用 `agent.followup()` 唤醒对应会话 |
| `gitlab-mr-workflow/SKILL.md` | agent 出站 SOP：git/glab 命令、MR 规范、回复评论规范、合并后沉淀模板 |

**登记制（无需手工配置绑定会话）**：agent 建完 MR 后调一次 `gitlab_watch_mr`，插件把
「当前会话 ↔ MR」的绑定连同游标水位线一起持久化；之后这个 MR 的新评论/合并会自动 wake
回**创建它的那个会话**，重启后也记得（存在 state 文件里）。

## 0. 一键安装（推荐，走 setup-dsh）

已集成进 [`scripts/setup-dsh/setup.sh`](../scripts/setup-dsh/setup.sh)：只要提供 bot 用户名即启用
（交互提示，或填 `DSH_GITLAB_BOT_USERNAME` / `DSH_GITLAB_API_BASE` / `DSH_GITLAB_TOKEN`），
它会自动完成下面 §1–§3 的全部三步（skill → 插件挂载 → token 写 `.env`）。见
[setup-dsh README 的 GitLab 小节](../scripts/setup-dsh/README.md#gitlab-mr-integration-optional)。

```sh
./scripts/setup-dsh/setup.sh          # 交互回答 GitLab bot username / apiBase / PAT
# 或一键：
DSH_GITLAB_BOT_USERNAME=dsh-agent \
DSH_GITLAB_API_BASE='https://gitlab.example.com/api/v4' \
DSH_GITLAB_TOKEN=glpat-... \
  ./scripts/setup-dsh/setup.sh --non-interactive
```

## 1. 安装 skill（手动部署时）

```bash
# 项目级（进 git）或用户级（本机全局），二选一
cp -R gitlab-mr-workflow /path/to/project/.agents/skills/
cp -R gitlab-mr-workflow ~/.dsh/skills/
```

## 2. 挂载 poller 插件

`$DSH_HOME/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: gitlab-mr
      name: /absolute/path/to/gitlab-mr-poller.mjs
      config:
        apiBase: 'https://<你的gitlab域名>/api/v4'   # 自托管实例
        botUsername: dsh-agent                         # bot 的 GitLab username
        pollIntervalMs: 300000                         # 5 分钟
```

## 3. 环境变量

```bash
export GITLAB_TOKEN=<bot 账号的 PAT>   # scope 至少 api（读 MR/评论；agent 用 glab 写需含写权限）
```

poller 优先用 DSH 的 `ctx.credentials`（按 `tokenEnv` 引用的值）解析，缺失时回退到同名环境变量。token 永不写入配置。

## 4. 登记机制（替代手工绑定会话）

agent 在会话里跑完 `glab mr create` 后，调用工具：

```
gitlab_watch_mr(project="group/repo", mrIid=123)
```

插件内部用 `exec.agent.id` 取到当前会话 id，查该 MR 的当前最新 comment id 作为水位线
（历史评论不回放），把 `{ MR → sessionId → 游标 }` 写入 state 文件。之后：

- 该 MR 出现**新评论**（非 bot 作者、非 system 笔记）→ 立即 wake 回这个会话。
- 该 MR **合并** → wake 回会话做「沉淀」，并从追踪移除。
- 该 MR **关闭** → wake 提示停止，并从追踪移除。

若登记后会话被关掉/还没 resume，poller 会跳过不投递但**保留登记且不推进游标**，等会话回来后的下个轮询周期补投，不漏事件。

## 5. 配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `tokenEnv` | `GITLAB_TOKEN` | token 来源 |
| `apiBase` | `https://gitlab.com/api/v4` | 自托管改域名 |
| `botUsername` | —（必填） | 回环过滤：作者等于它的评论不投递 |
| `pollIntervalMs` | `300000` | 轮询间隔（最小 10s） |
| `stateFilePath` | `.dsh-gitlab-mr-state.json` | 登记/游标持久化文件（相对 `$DSH_HOME`） |
| `perPage` | `100` | 单次拉取评论数 |

## 6. 语义与限制

- **只追踪登记过的 MR**：不再扫描项目的 opened MR 全集，避免打扰无关 MR、也避免误投他人 MR 到你的会话。
- **登记时设水位线**：首次登记只记「当前最新 comment id」，历史评论不回放。
- **回环防抖**：`botUsername` 评论与 `system` 笔记不投递，但水位线仍推进，防重复触发。
- **合并/关闭即停**：`merged`/`closed` 时从追踪移除，`merged` 额外注入一条「沉淀」消息。
- **会话未运行则保留**：绑定会话不在线时跳过投递、不推进游标、不移除登记，恢复后下轮补投。
- **单机 state 文件**：游标是进程内 JSON，适合内网单实例；多副本需换共享存储。
- **加载约束**：本地 `.mjs` 是 bare plugin，若 `verify-cordis-config` 报未声明依赖，把它纳入你 profile 的 resolver manifest `dependencies`，或用自己的 bundle 包一层后按名字引用。

## 7. 快速验证

1. 启动 DSH，日志出现 `[gitlab-mr] 启动 …`。
2. 让 agent 用一个仓库跑通「建分支→提交→`glab mr create`」，然后调用 `gitlab_watch_mr`。
3. 在 GitLab 用非 bot 账号给这个 MR 发一条评论。
4. 等一个轮询周期（≤5 分钟），agent 会话应收到 `【GitLab MR 评论】…` 并被唤醒；合并该 MR 后收到 `【GitLab MR 合并】…` 并被唤醒做沉淀。