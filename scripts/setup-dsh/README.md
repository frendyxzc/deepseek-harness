# setup-dsh — one-click local environment bootstrap

Reproduces the configuration this checkout relies on but does not ship: the
harness home under `~/.dsh` (settings, credentials, the `web` profile) and the
[TencentDB-Agent-Memory](https://github.com/frendyxzc/TencentDB-Agent-Memory)
stack that the profile's `llm-deepseek.baseURL` points at (`http://127.0.0.1:8096`).
When a bot username is supplied, it also installs the optional
[GitLab MR integration](#gitlab-mr-integration-optional) (`gitlab-mr/` at the repo root).

## Run

```sh
./scripts/setup-dsh/setup.sh
```

It is idempotent — existing files are kept unless `--force` is passed. Secrets
are prompted interactively unless supplied via the `DSH_*` env vars (see
`setup.sh --help`), or use `--non-interactive` to fail instead of prompting.

## One-key (config-driven) run

```sh
./scripts/setup-dsh/setup-one.sh [--env PATH] [setup.sh options...]
```

`setup-one.sh` reads the `DSH_*` values from a config file (default
`~/.dsh/setup-dsh.env`, override with `--env` or `$DSH_SETUP_ENV_FILE`), exports
them, and runs `setup.sh --non-interactive`: no prompts, missing required
secrets fail loudly. A filled-in template lives at
`scripts/setup-dsh/setup.env.example` — copy it to `~/.dsh/setup-dsh.env`
(`chmod 600`), fill the values, and keep it out of git.

## What it writes

| Target | Source | Secret? |
|---|---|---|
| `~/.dsh/settings.yaml` | `templates/settings.yaml` | no |
| `~/.dsh/.credentials.yaml` | prompted `PROXY_USER_KEY` | yes (0600) |
| `~/.dsh/profiles/web/*` | `templates/profile-web/*` | no (`cwd`/`fallbackChatId` filled from flags) |
| `<repo>/.env` | prompted `DEEPSEEK_API_KEY`, `FEISHU_*` | yes (gitignored) |
| `~/.dsh/tdai-stack/TencentDB-Agent-Memory` | git clone `feat/server_team` | — |
| `~/.dsh/tdai-stack/config/proxy-config.yaml` | `templates/tdai-stack/proxy-config.yaml` + prompted upstream URL/key | yes (0600) |
| `~/.dsh/tdai-stack/config/tdai-gateway.yaml` | `templates/tdai-stack/tdai-gateway.yaml` + prompted `TDAI_LLM_*` | yes (0600) |
| `…/MemoryPanel/.env` + `config/metadata-instances.json` | `.env.example` / prompted gateway bearer | partially |
| `…/MemoryKnowledge/.env` | `.env.example` | no |
| `…/MemoryCore/.env.local` | prompted `TDAI_LLM_*` (points `TDAI_GATEWAY_CONFIG` at `tdai-stack/config/tdai-gateway.yaml`) | yes (0600) |
| `…/{MemoryCore,MemoryPanel,MemoryKnowledge}/pnpm-workspace.yaml` | pnpm 11 build approvals: decides upstream `approve-builds` placeholders (`allowBuilds`: better-sqlite3/esbuild allowed, rest explicitly denied) | no |
| `…/metadata.db` → `meta_users` + `meta_user_keys` | Bootstraps the MemoryCore admin user keyed with `PROXY_USER_KEY` when the database exists but no admin user is present (so the agent can authenticate through the proxy) | yes |
| `~/.dsh/skills/gitlab-mr-workflow/` | `gitlab-mr/gitlab-mr-workflow/*` (repo) — GitLab MR workflow skill | no |
| `~/.dsh/profiles/web/cordis.patch.yml` (+`gitlab-mr` entry) | `gitlab-mr/gitlab-mr-poller.mjs` (repo) — poller plugin mount | no |
| `<repo>/.env` (+`GITLAB_TOKEN`) | prompted `DSH_GITLAB_TOKEN` | yes (gitignored, appended by §7) |

Templates under `templates/` are the source of truth for the non-secret DSH
config. Edit them and re-run with `--force` to redeploy.

## GitLab MR integration (optional)

Supplying `DSH_GITLAB_BOT_USERNAME` (or answering the prompt with a bot's GitLab
username) enables the GitLab MR closed loop; an empty value skips it entirely.
Enabled, setup.sh installs three things (see the [gitlab-mr README](../../gitlab-mr/README.md)):

1. **Skill** — `gitlab-mr/gitlab-mr-workflow` is copied to `~/.dsh/skills/`, the
   user skills root `skill-filesystem` scans, so the agent gains the git + `glab`
   outbound workflow (branch/commit/MR/comment) and the merge-distill template.
2. **Poller plugin** — a `gitlab-mr` patch entry is appended to
   `~/.dsh/profiles/web/cordis.patch.yml`, mounting `gitlab-mr-poller.mjs` (by
   absolute path into this checkout). It registers the `gitlab_watch_mr` tool
   and polls registered MRs so new comments / merge / close wake the owning
   session.
3. **Token** — `DSH_GITLAB_TOKEN` is appended to `<repo>/.env` as `GITLAB_TOKEN`
   (when supplied and not already present); both the poller and the agent's
   `glab` read it from the environment.

Relevant vars: `DSH_GITLAB_BOT_USERNAME` (enable), `DSH_GITLAB_API_BASE`
(default `https://gitlab.com/api/v4`), `DSH_GITLAB_TOKEN` (the bot PAT).
Set them in `~/.dsh/setup-dsh.env` (`setup.env.example` has a filled template)
for the no-prompt `setup-one.sh` path.

## Start the services (after setup)

```sh
./scripts/setup-dsh/start-all.sh    # start everything in dependency order
./scripts/setup-dsh/stop-all.sh     # stop everything it started
```

`start-all.sh` daemonizes each of the five services, writes logs under
`~/.dsh/run/logs/` and pidfiles under `~/.dsh/run/pids/`, and waits on each
service's `/health` (dsh Web UI: `/`) before starting the next. Services already
listening on their port are skipped, so it is safe to re-run. `stop-all.sh` kills
only the process trees recorded in those pidfiles — services you started by hand
are left alone.

Order and endpoints:

1. MemoryCore `:8420` (`/health`)
2. MemoryProxy `:8096` (`/health`)
3. MemoryKnowledge `:8421` (`/health`)
4. MemoryPanel `:8123` (`/health`, binds all interfaces)
5. dsh Web UI `:3080` (`/`, binds all interfaces)

The dsh Web UI is launched with `--host 0.0.0.0`, and MemoryPanel's generated
`.env` sets `HOST=0.0.0.0`, so a browser on another machine reaches them at
`http://<this machine's LAN IP>:3080` and `:8123` respectively. The remaining
`127.0.0.1` endpoints are same-machine server links — dsh → proxy (`:8096`),
proxy → core (`:8420`) — and correctly stay loopback. Both exposed surfaces run
unauthenticated, so firewall `:3080` and `:8123` on a shared network.

For one-off manual starts, the only service without a repository-owned start
helper is MemoryCore; source its `.env.local` before launching the gateway:

```sh
cd ~/.dsh/tdai-stack/TencentDB-Agent-Memory/MemoryCore
set -a && . ./.env.local && set +a
node --import tsx src/gateway/server.ts
```

## Ports

| Port | Service |
|---|---|
| 3080 | dsh Web GUI |
| 8096 | MemoryProxy (dsh's `llm-deepseek.baseURL`) |
| 8123 | MemoryPanel (team-memory-control, stateless panel) |
| 8420 | MemoryCore (kernel gateway) |
| 8421 | MemoryKnowledge (Wiki / Code-Graph) |

> This local deployment runs the stateless panel (`MemoryPanel`) on **8123**.
> The docker "memory-hub" image in the upstream repo's `deploy/global-images`
> uses **8125** — that is a different (containerized) deployment.
