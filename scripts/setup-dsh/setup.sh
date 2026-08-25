#!/usr/bin/env bash
# One-click local environment bootstrap for DeepSeek Harness.
#
# Reproduces every piece of configuration that lives *outside* this checkout —
# under $DSH_HOME (default ~/.dsh) — plus the TencentDB-Agent-Memory stack
# that the local dsh Web profile talks to:
#
#   ~/.dsh/settings.yaml                LLM providers / models (copied from template)
#   ~/.dsh/.credentials.yaml            PROXY_USER_KEY (prompted, never committed)
#   ~/.dsh/profiles/web/{package.json, cordis.yml, cordis.patch.yml, pnpm-workspace.yaml}
#   ~/.dsh/tdai-stack/TencentDB-Agent-Memory   git clone + per-service config
#   ~/.dsh/tdai-stack/config/{proxy-config,tdai-gateway}.yaml   generated from templates/tdai-stack/
#   ~/.dsh/skills/gitlab-mr-workflow           optional GitLab MR workflow skill (see §7)
#   <repo>/.env                         DEEPSEEK_API_KEY + FEISHU_* (prompted) + GITLAB_TOKEN (§7)
#
# Idempotent: existing files are kept unless --force is passed. Secrets are
# prompted interactively (or read from the DSH_* env vars below); pass
# --non-interactive to fail instead of prompting.
#
# Options:
#   --dsh-home PATH     override the harness home (default $DSH_HOME or ~/.dsh)
#   --workspace PATH    workspace the profile `cwd` points at (default: this repo)
#   --branch REF        TencentDB-Agent-Memory branch (default: feat/server_team)
#   --skip-memory       do not clone/configure the memory stack
#   --skip-install      do not run pnpm/npm install in the memory services
#   --upgrade           migrate an EXISTING deployment in place: append the
#                       feishu-bot bots/credentials patch, refresh the memory
#                       stack deps + rebuild the panel web UI, refresh dsh
#                       deps + rebuild. Never touches secrets or regenerates
#                       generated files (no --force); safe to re-run.
#   --force             overwrite existing generated files
#   --non-interactive   never prompt; fail if a required value is missing
#   -h, --help          this help
#
# Secret env vars (used before prompting):
#   DSH_PROXY_USER_KEY            -> ~/.dsh/.credentials.yaml PROXY_USER_KEY
#   DSH_FEISHU_FALLBACK_CHAT_ID   -> profile cordis.patch.yml fallbackChatId
#   DSH_DEEPSEEK_API_KEY          -> <repo>/.env DEEPSEEK_API_KEY
#   DSH_FEISHU_APP_ID             -> <repo>/.env FEISHU_APP_ID
#   DSH_FEISHU_APP_SECRET         -> <repo>/.env FEISHU_APP_SECRET
#   DSH_PROXY_UPSTREAM_URL        -> proxy-config.yaml upstream.url (keep /v1: the
#                                    proxy appends endpoint paths to this base)
#   DSH_PROXY_UPSTREAM_API_KEY    -> proxy-config.yaml upstream.apiKey
#   DSH_KERNEL_GATEWAY_API_KEY    -> panel metadata-instances.json api_key (default: empty)
#   DSH_TDAI_LLM_API_KEY          -> memory core gateway tdai-gateway.yaml
#   DSH_TDAI_LLM_BASE_URL         -> memory core gateway tdai-gateway.yaml
#   DSH_TDAI_LLM_MODEL            -> memory core gateway tdai-gateway.yaml
#   DSH_MEMORY_DATA_DIR           -> gateway data.baseDir (default ~/.memory-tencentdb/memory-tdai)
#   DSH_GITLAB_BOT_USERNAME       -> enables GitLab MR integration (bot's GitLab username)
#   DSH_GITLAB_API_BASE           -> GitLab API base URL (default https://gitlab.com/api/v4)
#   DSH_GITLAB_TOKEN              -> bot PAT appended to <repo>/.env GITLAB_TOKEN
set -euo pipefail

# ── Resolve the checked-out repo root and defaults ───────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATES="$SCRIPT_DIR/templates"

# Shared with start-all.sh: stack_node_bin resolves the Node the memory stack
# runs on, so installs below target the same ABI the services start with.
# (Sourced before this script's own info/ok/warn/die, which override lib.sh's
# [stack]-prefixed versions.)
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

MEMORY_REPO_URL="${DSH_MEMORY_REPO_URL:-https://github.com/frendyxzc/TencentDB-Agent-Memory.git}"
MEMORY_BRANCH="${DSH_MEMORY_BRANCH:-feat/server_team}"

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
WORKSPACE="$REPO_ROOT"

SKIP_MEMORY=0
SKIP_INSTALL=0
UPGRADE=0
FORCE=0
NON_INTERACTIVE=0

info()  { printf '\033[1;34m[setup]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[setup]\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m[setup]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  awk 'NR>1 { if (/^set -euo pipefail$/) exit; sub(/^# ?/, ""); print }' "$0"
}

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh-home)        DSH_HOME="$2"; shift 2 ;;
    --workspace)       WORKSPACE="$2"; shift 2 ;;
    --branch)          MEMORY_BRANCH="$2"; shift 2 ;;
    --skip-memory)     SKIP_MEMORY=1; shift ;;
    --skip-install)    SKIP_INSTALL=1; shift ;;
    --upgrade)         UPGRADE=1; shift ;;
    --force)           FORCE=1; shift ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    *) die "unknown option: $1 (run with --help)" ;;
  esac
done

WORKSPACE="$(cd "$WORKSPACE" 2>/dev/null && pwd || true)"
[[ -n "$WORKSPACE" && -d "$WORKSPACE" ]] || die "workspace $WORKSPACE is not a directory"

DSH_HOME="${DSH_HOME/#\~/$HOME}"   # expand a leading tilde

# ── Prompting helpers (interactive unless --non-interactive) ───────────────
# ask_opt <env-var> <prompt> <default> — optional (non-secret) value. Env wins,
# then prompt; in --non-interactive the default is used verbatim (which may be
# an empty string, i.e. "skip").
ask_opt() {
  local env_var="$1" prompt="$2" default="${3:-}" val
  val="${!env_var:-}"
  [[ -n "$val" ]] && { printf '%s\n' "$val"; return; }
  if [[ "$NON_INTERACTIVE" == "1" ]]; then printf '%s\n' "$default"; return; fi
  local p="$prompt"; [[ -n "$default" ]] && p="$prompt [$default]"
  IFS= read -r -p "  $p: " val || true
  [[ -n "$val" ]] || val="$default"
  printf '%s\n' "$val"
}

# ask_secret <env-var> <prompt> — required secret. Env wins, then prompt;
# --non-interactive without an env value fails instead of guessing.
ask_secret() {
  local env_var="$1" prompt="$2" val
  val="${!env_var:-}"
  [[ -n "$val" ]] && { printf '%s\n' "$val"; return; }
  if [[ "$NON_INTERACTIVE" == "1" ]]; then
    die "missing required secret: \$$env_var (unset and --non-interactive)"
  fi
  IFS= read -r -s -p "  $prompt: " val || true
  # read -s suppresses the terminal echo; print the newline the user's Enter
  # would have produced. It must go to stderr: when this function is called
  # through $(...), a stdout newline would be captured as a leading newline
  # of the value (command substitution strips trailing newlines only).
  printf '\n' >&2
  printf '%s\n' "$val"
}

# ask_secret_opt <env-var> <prompt> — optional secret (empty = skip).
ask_secret_opt() {
  local env_var="$1" prompt="$2" val
  val="${!env_var:-}"
  [[ -n "$val" ]] && { printf '%s\n' "$val"; return; }
  if [[ "$NON_INTERACTIVE" == "1" ]]; then printf '\n'; return; fi
  IFS= read -r -s -p "  $prompt (leave empty to skip): " val || true
  # See ask_secret: the echo-replacement newline must not reach stdout.
  printf '\n' >&2
  printf '%s\n' "$val"
}

# die_on_newline <var-name> — fail when a value about to be interpolated into a
# generated config contains a literal newline. BSD sed cannot substitute one
# and reports only a truncated command; checking here names the offending value.
die_on_newline() {
  local name="$1" val="${!1:-}"
  if [[ "$val" == *$'\n'* ]]; then
    die "value of \$$name contains a newline; unset it and re-run (each value must be a single line)"
  fi
}

# write_if_absent <path> — materialize only when missing (or --force).
write_if_absent() {
  local path="$1"
  if [[ -e "$path" && "$FORCE" != "1" ]]; then
    warn "already exists, skipping: $path"
    return 1
  fi
  return 0
}

# ── Upgrade mode (--upgrade): in-place migration of an existing deployment ──
# Non-destructive by construction: it appends one idempotent patch entry to the
# profile, refreshes the memory stack dependencies (incl. the MemoryProxy
# better-sqlite3 verify-and-repair) and rebuilds the panel web UI, then
# refreshes/rebuilds the dsh workspace. It never regenerates a secret or
# overwrites a generated file (no --force), so it is safe to run repeatedly
# and after every `git pull`.

# ensure_proxy_npm_approvals <memory-proxy-dir> — record npm install-script
# approvals in MemoryProxy/package.json (idempotent, like the pnpm-workspace.yaml
# patches above). npm 11 blocks dependency install scripts unless the package.json
# `allowScripts` field names them; a blocked script makes npm silently omit
# better-sqlite3 — an optionalDependency — from node_modules entirely, so the
# package is never even present to repair. The approved set mirrors the proxy's
# upstream pnpm-workspace.yaml allowBuilds; npm 10 ignores the field, so the
# patch is inert under the pinned Node 22 toolchain and only matters when the
# ambient Node's npm is >= 11.
ensure_proxy_npm_approvals() {
  local dir="$1"
  (cd "$dir" && node -e '
    const fs = require("node:fs");
    const file = "package.json";
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    const allow = (pkg.allowScripts ??= {});
    let changed = false;
    for (const name of ["better-sqlite3", "esbuild", "node-pty", "protobufjs"]) {
      if (allow[name] !== true) { allow[name] = true; changed = true; }
    }
    if (changed) fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  ') || die "failed to write npm script approvals in $dir/package.json"
  ok "npm build approvals -> $dir/package.json (allowScripts)"
}

# ensure_proxy_sqlite <memory-proxy-dir> — verify the better-sqlite3 native
# binding is loadable and (re)install it when absent. Must run with the stack
# Node first in PATH (ensure_memory_deps does): the services start on Node v22
# (see start-all.sh), and under any other Node the check and the repair both
# lie — npm 11 blocks install scripts and silently omits better-sqlite3 (an
# optionalDependency) while still reporting the tree up to date, and a binding
# built under a different ABI fails to load with ERR_DLOPEN_FAILED. Missing,
# proxy storage degrades sqlite -> fs -> memory (the session->identity binding
# is dropped and memory-bridge answers 40101).
ensure_proxy_sqlite() {
  local dir="$1"
  if (cd "$dir" && node -e "require('better-sqlite3')" >/dev/null 2>&1); then
    ok "MemoryProxy better-sqlite3 native binding ready"
    return 0
  fi
  warn "MemoryProxy better-sqlite3 missing — installing explicitly"
  if ! (cd "$dir" && npm install better-sqlite3 --no-audit --no-fund); then
    die "MemoryProxy better-sqlite3 install failed — memory-bridge will 40101 without it"
  fi
  if (cd "$dir" && node -e "require('better-sqlite3')" >/dev/null 2>&1); then
    ok "MemoryProxy better-sqlite3 native binding installed"
  else
    die "MemoryProxy better-sqlite3 native binding failed to build — check /health storage.effective"
  fi
}

# ensure_memory_deps <memory-root> <force> — Memory 栈依赖安装 + panel web 构建。
# <force>=1: 即使 node_modules / web/dist 已存在也重装重建（--upgrade 与
# setup.sh --force 均以 1 调用）；<force>=0: 仅补缺（首次安装路径）。
# 修补 MemoryCore/Panel/Knowledge 的 pnpm allowBuilds 批准文件（幂等，且
# --skip-install 时也执行，留下后续手动安装可用的批准文件）：pnpm 11 不再读
# package.json 的 "pnpm" 字段，且依赖带未批准的 build script 时硬失败
# (ERR_PNPM_IGNORED_BUILDS)。上游仓库的 approve-builds 占位值是字面文本
# "set this to true or false"，pnpm 视为未批准，所以这里逐条决定：放行本栈真正
# 需要的脚本（better-sqlite3 native 绑定、esbuild 二进制），显式拒绝其余（列入
# deny 不触发硬错误）；没有 workspace yaml 的服务生成最小批准文件。
# MemoryProxy 用 npm，批准走 package.json 的 allowScripts（ensure_proxy_npm_approvals，
# 同样幂等且 --skip-install 时也执行）。所有安装都在栈的 Node（stack_node_bin，
# start-all.sh 用它启动服务）下运行：native 绑定按 ABI 区分，装错 Node 服务
# 启动时 ERR_DLOPEN_FAILED；MemoryProxy 的 better-sqlite3 每次运行都验证-修复
# （ensure_proxy_sqlite）：它是 proxy 的 sqlite 存储后端，缺失时 proxy 静默降级
# sqlite -> fs -> memory，memory-bridge 应答 40101。
ensure_memory_deps() {
  local root="$1" force="$2" svc yaml node_dir="" old_path="$PATH"

  for svc in MemoryCore MemoryPanel MemoryKnowledge; do
    yaml="$root/$svc/pnpm-workspace.yaml"
    if [[ ! -f "$yaml" ]]; then
      cat > "$yaml" <<'EOF'
allowBuilds:
  better-sqlite3: true
  esbuild: true
  protobufjs: true
EOF
    else
      sed -e 's/set this to true or false/false/g' \
          -e 's/^  better-sqlite3: false$/  better-sqlite3: true/' \
          -e 's/^  esbuild: false$/  esbuild: true/' \
          -e 's/^  protobufjs: false$/  protobufjs: true/' \
        "$yaml" > "$yaml.tmp"
      mv "$yaml.tmp" "$yaml"
    fi
    ok "pnpm build approvals -> $yaml"
  done
  ensure_proxy_npm_approvals "$root/MemoryProxy"

  if [[ "$SKIP_INSTALL" == "1" ]]; then
    warn "--skip-install: not installing memory service dependencies"
    return 0
  fi

  # Run every install under the Node the services start on (stack_node_bin,
  # the same resolution start-all.sh uses): a native binding built under a
  # different ABI fails to load, and npm 11 silently omits optional deps whose
  # install scripts it blocks. PATH is restored at the end of this function.
  if node_dir="$(stack_node_bin)"; then
    PATH="$node_dir:$PATH"
  fi

  if [[ "$force" == "1" || ! -d "$root/MemoryProxy/node_modules" ]]; then
    info "install MemoryProxy deps (npm)"
    (cd "$root/MemoryProxy" && npm install --no-audit --no-fund)
  fi
  # better-sqlite3 verify-and-repair on every run (see the function comment).
  ensure_proxy_sqlite "$root/MemoryProxy"
  for svc in MemoryCore MemoryPanel MemoryKnowledge; do
    if [[ "$force" == "1" || ! -d "$root/$svc/node_modules" ]]; then
      info "install $svc deps (pnpm)"
      (cd "$root/$svc" && pnpm install)
    fi
  done
  ok "memory service dependencies ready"

  # MemoryPanel serves its web UI from web/dist/; the upstream repo ships the
  # source but not the built artifacts, so a fresh clone returns 404 on / even
  # though /health reports 200.
  if [[ "$force" == "1" || ! -d "$root/MemoryPanel/web/dist" ]]; then
    info "build MemoryPanel web UI"
    (cd "$root/MemoryPanel/web" && npm ci && npm run build)
    ok "MemoryPanel web UI built -> $root/MemoryPanel/web/dist"
  fi
  PATH="$old_path"
}

# upgrade_feishu_bot_config — migrate a flat single-app `feishu-bot` profile to
# the multi-bot bots/credentials split by APPENDING a config-override patch entry
# (the same idempotent pattern §7b uses), never rewrites the insert block. The
# override is keyed by the marker comment, so a re-run is a no-op; it assumes the
# setup-generated flat entry (no prior feishu-bot `config`), so a hand-customized
# feishu-bot config that already carries `bots:`/`credentials:` is left alone.
upgrade_feishu_bot_config() {
  local patch="$PROFILE_DIR/cordis.patch.yml"
  if [[ ! -f "$patch" ]]; then
    warn "profile patch missing ($patch); run a full ./scripts/setup-dsh/setup.sh first"
    return 0
  fi
  if ! grep -q "id: feishu-bot" "$patch"; then
    info "feishu-bot is not mounted in $patch; skipping bot-config migration"
    return 0
  fi
  if grep -q "setup-dsh: feishu-bot bots/credentials" "$patch"; then
    ok "feishu-bot already migrated to bots/credentials; skipping"
    return 0
  fi
  if grep -q "bots:" "$patch" || grep -q "credentials:" "$patch"; then
    warn "feishu-bot already has bots/credentials config (hand-edited?); leaving it alone"
    return 0
  fi

  local app_id="${DSH_FEISHU_APP_ID:-}"
  if [[ -z "$app_id" ]]; then
    app_id="$(awk -F'=' '/^[[:space:]]*FEISHU_APP_ID=/{sub(/^[[:space:]]*/,"",$2); print $2; exit}' "$REPO_ROOT/.env" 2>/dev/null || true)"
  fi
  die_on_newline app_id

  {
    printf '\n'
    printf '# feishu-bot multi-bot config (added by setup.sh --upgrade; setup-dsh: feishu-bot bots/credentials)\n'
    printf '# Migrates the flat single-app feishu-bot to the bots/credentials split so the\n'
    printf '# Settings IM tab can map team/agent per bot. Secrets stay in the environment\n'
    printf '# (FEISHU_APP_ID / FEISHU_APP_SECRET), never in this file.\n'
    printf -- '- id: feishu-bot\n'
    printf '  config:\n'
    printf '    bots:\n'
    printf '      - id: main\n'
    if [[ -n "$app_id" ]]; then printf "        appId: '%s'\n" "$app_id"; fi
    printf '    credentials:\n'
    printf '      - id: main\n'
    printf '        appIdEnv: FEISHU_APP_ID\n'
    printf '        appSecretEnv: FEISHU_APP_SECRET\n'
  } >> "$patch"
  ok "feishu-bot bots/credentials config appended -> $patch"
}

# run_upgrade — the --upgrade body; ends the process on completion.
run_upgrade() {
  info "upgrade mode: migrating an existing deployment at $DSH_HOME"
  mkdir -p "$DSH_HOME"

  PROFILE_DIR="$DSH_HOME/profiles/web"
  upgrade_feishu_bot_config

  if [[ "$SKIP_MEMORY" != "1" ]]; then
    local memory_root="$DSH_HOME/tdai-stack/TencentDB-Agent-Memory"
    if [[ -d "$memory_root/.git" ]]; then
      info "refreshing memory stack deps and rebuilding panel web UI"
      ensure_memory_deps "$memory_root" 1
    else
      warn "memory stack not found at $memory_root; skipping (run the full setup.sh first)"
    fi
  fi

  # Refresh the workspace deps (links the newly-added @deepseek-ai/dsh-tdai-memory
  # package) and rebuild host libs + client bundles + the Web frontend.
  (cd "$REPO_ROOT" && pnpm install) || die "pnpm install failed in $REPO_ROOT"
  (cd "$REPO_ROOT" && pnpm run build) || die "pnpm run build failed in $REPO_ROOT"
  if [[ -f "$PROFILE_DIR/package.json" ]]; then
    (cd "$PROFILE_DIR" && pnpm install) || warn "profile pnpm install failed (non-fatal)"
  fi

  echo
  ok "upgrade complete."
  echo
  echo "Stop the running stack (if any), then restart to pick up the new code:"
  echo "  ./scripts/setup-dsh/stop-all.sh && ./scripts/setup-dsh/start-all.sh"
  echo "or, for just the Web UI:"
  echo "  cd $REPO_ROOT && pnpm dsh web --host 0.0.0.0 --port 3080"
  echo
  exit 0
}
if [[ "$UPGRADE" == "1" ]]; then run_upgrade; fi

# ── 1. Harness home ─────────────────────────────────────────────────────────
info "harness home: $DSH_HOME  ·  workspace: $WORKSPACE"
mkdir -p "$DSH_HOME"
chmod 700 "$DSH_HOME"

# ── 2. settings.yaml ───────────────────────────────────────────────────────
if write_if_absent "$DSH_HOME/settings.yaml"; then
  cp "$TEMPLATES/settings.yaml" "$DSH_HOME/settings.yaml"
  chmod 600 "$DSH_HOME/settings.yaml"
  ok "settings.yaml -> $DSH_HOME/settings.yaml"
fi

# ── 3. .credentials.yaml ───────────────────────────────────────────────────
# The proxy user key is a durable identity: MemoryCore's admin user is
# bootstrapped with it, so once it exists it must never be regenerated — not
# even under --force — or the proxy stops authenticating the agent. Create it
# only when absent; otherwise read it back out for the admin bootstrap below.
if [[ -e "$DSH_HOME/.credentials.yaml" ]]; then
  ok "keeping existing .credentials.yaml (PROXY_USER_KEY preserved)"
  if [[ -z "${PROXY_USER_KEY:-}" ]]; then
    PROXY_USER_KEY="$(awk '/^[[:space:]]*PROXY_USER_KEY:/{gsub(/"/,"",$2); print $2; exit}' "$DSH_HOME/.credentials.yaml" 2>/dev/null || true)"
  fi
else
  PROXY_USER_KEY="$(ask_secret_opt DSH_PROXY_USER_KEY 'Memory proxy user_key (sk-mem-..., empty to generate random)')"
  if [[ -z "$PROXY_USER_KEY" ]]; then
    PROXY_USER_KEY="sk-mem-$(openssl rand -hex 16)"
    ok "PROXY_USER_KEY: generated random key"
  fi
  die_on_newline PROXY_USER_KEY
  {
    printf '# dsh-managed credentials store. Every value here is a secret;\n'
    printf '# dsh refuses to boot if this file is not owner-only (0600).\n'
    printf 'PROXY_USER_KEY: "%s"\n' "$PROXY_USER_KEY"
  } > "$DSH_HOME/.credentials.yaml"
  chmod 600 "$DSH_HOME/.credentials.yaml"
  ok ".credentials.yaml -> $DSH_HOME/.credentials.yaml"
fi

# ── 4. web profile ─────────────────────────────────────────────────────────
PROFILE_DIR="$DSH_HOME/profiles/web"
mkdir -p "$PROFILE_DIR"

if write_if_absent "$PROFILE_DIR/package.json"; then
  cp "$TEMPLATES/profile-web/package.json" "$PROFILE_DIR/package.json"
  ok "profile package.json -> $PROFILE_DIR/package.json"
fi
if write_if_absent "$PROFILE_DIR/cordis.yml"; then
  cp "$TEMPLATES/profile-web/cordis.yml" "$PROFILE_DIR/cordis.yml"
  ok "profile cordis.yml -> $PROFILE_DIR/cordis.yml"
fi
if write_if_absent "$PROFILE_DIR/pnpm-workspace.yaml"; then
  cp "$TEMPLATES/profile-web/pnpm-workspace.yaml" "$PROFILE_DIR/pnpm-workspace.yaml"
  ok "profile pnpm-workspace.yaml -> $PROFILE_DIR/pnpm-workspace.yaml"
fi
if write_if_absent "$PROFILE_DIR/cordis.patch.yml"; then
  FALLBACK_CHAT_ID="$(ask_opt DSH_FEISHU_FALLBACK_CHAT_ID 'Feishu fallback chat id (approval cards; empty to skip)' '')"
  FEISHU_APP_ID="$(ask_opt DSH_FEISHU_APP_ID 'FEISHU_APP_ID (empty to skip)' '')"
  die_on_newline WORKSPACE
  die_on_newline FALLBACK_CHAT_ID
  die_on_newline FEISHU_APP_ID
  sed -e "s|__WORKSPACE__|$WORKSPACE|g" \
      -e "s|__FEISHU_APP_ID__|$FEISHU_APP_ID|g" \
      -e "s|__FALLBACK_CHAT_ID__|$FALLBACK_CHAT_ID|g" \
      "$TEMPLATES/profile-web/cordis.patch.yml" > "$PROFILE_DIR/cordis.patch.yml"
  ok "profile cordis.patch.yml -> $PROFILE_DIR/cordis.patch.yml"
fi

# ── 5. repo .env (gitignored) ──────────────────────────────────────────────
if [[ -e "$REPO_ROOT/.env" && "$FORCE" != "1" ]]; then
  warn "already exists, skipping: $REPO_ROOT/.env"
else
  ASK_DEEPSEEK="$(ask_secret_opt DSH_DEEPSEEK_API_KEY 'DEEPSEEK_API_KEY (direct-API tests/demos; empty to skip)')"
  ASK_FEISHU_ID="$(ask_opt DSH_FEISHU_APP_ID 'FEISHU_APP_ID (empty to skip)' '')"
  ASK_FEISHU_SECRET="$(ask_secret_opt DSH_FEISHU_APP_SECRET 'FEISHU_APP_SECRET')"
  die_on_newline ASK_DEEPSEEK
  die_on_newline ASK_FEISHU_ID
  die_on_newline ASK_FEISHU_SECRET
  umask 077
  {
    printf 'DEEPSEEK_API_KEY=%s\n' "$ASK_DEEPSEEK"
    printf 'FEISHU_APP_ID=%s\n' "$ASK_FEISHU_ID"
    printf 'FEISHU_APP_SECRET=%s\n' "$ASK_FEISHU_SECRET"
  } > "$REPO_ROOT/.env"
  ok ".env -> $REPO_ROOT/.env"
fi

# ── 6. TencentDB-Agent-Memory stack ─────────────────────────────────────────
MEMORY_ROOT="$DSH_HOME/tdai-stack/TencentDB-Agent-Memory"
# Shared install target for the two generated stack configs (proxy + gateway);
# start-all.sh passes proxy's config with --config, and MemoryCore's .env.local
# points TDAI_GATEWAY_CONFIG at the gateway one.
TDAI_STACK_CONFIG="$DSH_HOME/tdai-stack/config"

if [[ "$SKIP_MEMORY" == "1" ]]; then
  warn "--skip-memory: leaving the memory stack as-is (if any)"
else
  if [[ ! -d "$MEMORY_ROOT/.git" ]]; then
    mkdir -p "$(dirname "$MEMORY_ROOT")"
    info "cloning $MEMORY_REPO_URL (branch $MEMORY_BRANCH)"
    if [[ "$FORCE" == "1" && -d "$MEMORY_ROOT" ]]; then rm -rf "$MEMORY_ROOT"; fi
    git clone --branch "$MEMORY_BRANCH" "$MEMORY_REPO_URL" "$MEMORY_ROOT"
    ok "memory stack -> $MEMORY_ROOT"
  else
    (cd "$MEMORY_ROOT" && git checkout "$MEMORY_BRANCH" 2>/dev/null || true)
    ok "memory stack already present: $MEMORY_ROOT"
  fi

  # 6a. MemoryProxy (8096) — upstream + local core endpoints, generated into
  #     $DSH_HOME/tdai-stack/config/proxy-config.yaml (start-all.sh passes it
  #     with --config; the upstream repo's own MemoryProxy/config.yaml is unused).
  mkdir -p "$TDAI_STACK_CONFIG"
  if [[ ! -f "$TDAI_STACK_CONFIG/proxy-config.yaml" || "$FORCE" == "1" ]]; then
    PROXY_UPSTREAM_URL="$(ask_opt DSH_PROXY_UPSTREAM_URL 'Proxy upstream LLM URL (with /v1, e.g. https://host/compatible-mode/v1)' '')"
    [[ -n "$PROXY_UPSTREAM_URL" ]] || die "proxy upstream URL is required (set DSH_PROXY_UPSTREAM_URL)"
    PROXY_UPSTREAM_API_KEY="$(ask_secret_opt DSH_PROXY_UPSTREAM_API_KEY 'Proxy upstream LLM API key')"
    die_on_newline DSH_HOME
    die_on_newline PROXY_UPSTREAM_URL
    die_on_newline PROXY_UPSTREAM_API_KEY
    sed -e "s|__DSH_HOME__|$DSH_HOME|g" \
        -e "s|__PROXY_UPSTREAM_URL__|${PROXY_UPSTREAM_URL}|g" \
        -e "s|__PROXY_UPSTREAM_API_KEY__|${PROXY_UPSTREAM_API_KEY}|g" \
      "$TEMPLATES/tdai-stack/proxy-config.yaml" > "$TDAI_STACK_CONFIG/proxy-config.yaml.tmp"
    mv "$TDAI_STACK_CONFIG/proxy-config.yaml.tmp" "$TDAI_STACK_CONFIG/proxy-config.yaml"
    chmod 600 "$TDAI_STACK_CONFIG/proxy-config.yaml"
    ok "proxy config -> $TDAI_STACK_CONFIG/proxy-config.yaml"
  fi

  # 6b. MemoryPanel (8123) — copy .env.example; fill instance registry
  if [[ ! -f "$MEMORY_ROOT/MemoryPanel/.env" || "$FORCE" == "1" ]]; then
    cp "$MEMORY_ROOT/MemoryPanel/.env.example" "$MEMORY_ROOT/MemoryPanel/.env"
    # Bind every interface so a LAN browser can reach Memory Hub (the panel
    # itself already defaults HOST to 0.0.0.0; keeping it explicit here makes
    # the intent readable). The panel has no auth gate of its own, so on a
    # shared network the operator should firewall :8123. Also disable the
    # startup knowledge-service LLM-binding sync.
    sed -e 's/^HOST=.*/HOST=0.0.0.0/' \
        -e 's/^KNOWLEDGE_LLM_BINDING_SYNC=.*/KNOWLEDGE_LLM_BINDING_SYNC=false/' \
        "$MEMORY_ROOT/MemoryPanel/.env" > "$MEMORY_ROOT/MemoryPanel/.env.tmp"
    # The sed above only rewrites an existing HOST= line; when the upstream
    # .env.example carries none, append the LAN bind instead of silently
    # leaving the panel on the service's built-in default.
    grep -q '^HOST=' "$MEMORY_ROOT/MemoryPanel/.env.tmp" \
      || printf 'HOST=0.0.0.0\n' >> "$MEMORY_ROOT/MemoryPanel/.env.tmp"
    mv "$MEMORY_ROOT/MemoryPanel/.env.tmp" "$MEMORY_ROOT/MemoryPanel/.env"
    ok "panel .env -> $MEMORY_ROOT/MemoryPanel/.env"
  fi
  if [[ ! -f "$MEMORY_ROOT/MemoryPanel/config/metadata-instances.json" || "$FORCE" == "1" ]]; then
    GATEWAY_API_KEY="$(ask_opt DSH_KERNEL_GATEWAY_API_KEY 'Kernel gateway bearer (empty for local, no Bearer gate)' '')"
    die_on_newline GATEWAY_API_KEY
    # The panel schema requires a non-empty api_key even though the local
    # gateway never checks the Bearer value; an empty one makes the panel
    # crash on start (InstanceRegistryError 500). Fall back to the operator's
    # own proxy user key, or a fixed local marker when unavailable.
    if [[ -z "$GATEWAY_API_KEY" ]]; then
      GATEWAY_API_KEY="${PROXY_USER_KEY:-$(awk -F'"' '/^PROXY_USER_KEY:/{print $2; exit}' "$DSH_HOME/.credentials.yaml" 2>/dev/null)}"
      GATEWAY_API_KEY="${GATEWAY_API_KEY:-local}"
      ok "panel gateway api_key: empty input, using $GATEWAY_API_KEY"
    fi
    sed -e "s/REPLACE_WITH_KERNEL_BEARER_TOKEN/${GATEWAY_API_KEY}/g" \
      "$MEMORY_ROOT/MemoryPanel/config/metadata-instances.example.json" \
      > "$MEMORY_ROOT/MemoryPanel/config/metadata-instances.json"
    chmod 600 "$MEMORY_ROOT/MemoryPanel/config/metadata-instances.json"
    ok "panel metadata-instances.json -> $MEMORY_ROOT/MemoryPanel/config/metadata-instances.json"
  fi

  # 6c. MemoryKnowledge (8421) — copy .env.example
  if [[ ! -f "$MEMORY_ROOT/MemoryKnowledge/.env" || "$FORCE" == "1" ]]; then
    cp "$MEMORY_ROOT/MemoryKnowledge/.env.example" "$MEMORY_ROOT/MemoryKnowledge/.env"
    ok "knowledge .env -> $MEMORY_ROOT/MemoryKnowledge/.env"
  fi

  # 6d. MemoryCore (8420) — gateway config + LLM env (.env.local sourced before
  #     start). The gateway runs the standalone+sqlite layout this deployment
  #     uses, generated into $DSH_HOME/tdai-stack/config/; the upstream repo's
  #     own tdai-gateway.yaml is a different, docker-oriented default.
  CORE_ENV_FILE="$MEMORY_ROOT/MemoryCore/.env.local"
  GATEWAY_CONFIG="$TDAI_STACK_CONFIG/tdai-gateway.yaml"
  MEMORY_DATA_DIR="${DSH_MEMORY_DATA_DIR:-$HOME/.memory-tencentdb/memory-tdai}"
  # Ask once and share the values: both generated files below consume them,
  # and asking twice would let an interactive typo diverge the gateway config
  # from .env.local. Each file's block runs only when that file is (re)generated,
  # so the variables are always set whenever a block needs them.
  if [[ ! -f "$GATEWAY_CONFIG" || ! -f "$CORE_ENV_FILE" || "$FORCE" == "1" ]]; then
    TDAI_LLM_API_KEY="$(ask_secret DSH_TDAI_LLM_API_KEY 'MemoryCore TDAI_LLM_API_KEY')"
    TDAI_LLM_BASE_URL="$(ask_opt DSH_TDAI_LLM_BASE_URL 'MemoryCore TDAI_LLM_BASE_URL' 'https://api.lkeap.cloud.tencent.com/v1')"
    TDAI_LLM_MODEL="$(ask_opt DSH_TDAI_LLM_MODEL 'MemoryCore TDAI_LLM_MODEL' 'deepseek-v3.2')"
    die_on_newline TDAI_LLM_API_KEY
    die_on_newline TDAI_LLM_BASE_URL
    die_on_newline TDAI_LLM_MODEL
    die_on_newline MEMORY_DATA_DIR
  fi
  if [[ ! -f "$GATEWAY_CONFIG" || "$FORCE" == "1" ]]; then
    sed -e "s|__TDAI_LLM_API_KEY__|${TDAI_LLM_API_KEY}|g" \
        -e "s|__TDAI_LLM_BASE_URL__|${TDAI_LLM_BASE_URL}|g" \
        -e "s|__TDAI_LLM_MODEL__|${TDAI_LLM_MODEL}|g" \
        -e "s|__MEMORY_DATA_DIR__|${MEMORY_DATA_DIR}|g" \
      "$TEMPLATES/tdai-stack/tdai-gateway.yaml" > "$GATEWAY_CONFIG.tmp"
    mv "$GATEWAY_CONFIG.tmp" "$GATEWAY_CONFIG"
    chmod 600 "$GATEWAY_CONFIG"
    ok "gateway config -> $GATEWAY_CONFIG"
  fi
  if [[ ! -f "$CORE_ENV_FILE" || "$FORCE" == "1" ]]; then
    # The service directory is part of the cloned stack, but create it anyway:
    # a missing dir would make the redirect below fail *silently* — bash's
    # set -e does not abort on a failed redirect of a { ... } compound.
    mkdir -p "$(dirname "$CORE_ENV_FILE")"
    umask 077
    {
      printf 'export TDAI_LLM_API_KEY=%s\n' "$TDAI_LLM_API_KEY"
      printf 'export TDAI_LLM_BASE_URL=%s\n' "$TDAI_LLM_BASE_URL"
      printf 'export TDAI_LLM_MODEL=%s\n' "$TDAI_LLM_MODEL"
      printf 'export TDAI_GATEWAY_CONFIG=%s\n' "$GATEWAY_CONFIG"
    } > "$CORE_ENV_FILE"
    ok "core env -> $CORE_ENV_FILE"
  fi

  # 6e. Install service dependencies (matches what each service was built with).
  # The approve-builds repair, per-service installs, and panel web build live in
  # ensure_memory_deps, shared with --upgrade.
  ensure_memory_deps "$MEMORY_ROOT" "$FORCE"
  if [[ "$SKIP_INSTALL" != "1" ]]; then
    if [[ ! -d "$DSH_HOME/profiles/web/node_modules" || "$FORCE" == "1" ]]; then
      info "install web profile deps (pnpm)"
      (cd "$DSH_HOME/profiles/web" && pnpm install)
    fi
  fi

  # 6f. MemoryCore admin user — the core creates its database on first start
  #     but does not auto-create the admin user. If the database already
  #     exists (from a previous run of start-all.sh), insert the admin user
  #     keyed with the PROXY_USER_KEY so the agent can authenticate through
  #     the proxy. Without this step the agent reports "key不可用" because
  #     the proxy cannot validate the credential against the core.
  MEMORY_DB="$MEMORY_DATA_DIR/metadata/tdai_metadata_default/metadata.db"
  if [[ -f "$MEMORY_DB" ]]; then
    ADMIN_EXISTS=$(sqlite3 "$MEMORY_DB" "SELECT COUNT(*) FROM meta_users WHERE user_type='system_admin';" 2>/dev/null || echo 0)
    if [[ "$ADMIN_EXISTS" == "0" ]]; then
      # §3 always leaves PROXY_USER_KEY set (existing file read back or freshly
      # generated); re-read defensively in case the file changed since then.
      if [[ -z "${PROXY_USER_KEY:-}" ]]; then
        PROXY_USER_KEY="$(awk '/^[[:space:]]*PROXY_USER_KEY:/{gsub(/"/,"",$2); print $2; exit}' "$DSH_HOME/.credentials.yaml" 2>/dev/null || true)"
      fi
      if [[ -n "$PROXY_USER_KEY" ]]; then
        USER_ID="usr-$(openssl rand -hex 5)"
        KEY_ID="uky-$(openssl rand -hex 5)"
        NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
        sqlite3 "$MEMORY_DB" "
          INSERT INTO meta_users (user_id, auth_provider, external_id, username, status, user_type, created_at, updated_at, metadata_json)
          VALUES ('$USER_ID', 'local', '$USER_ID', 'admin', 'active', 'system_admin', '$NOW', '$NOW', '{}');
          INSERT INTO meta_user_keys (key_id, user_id, key_value, status, is_default, created_at, metadata_json)
          VALUES ('$KEY_ID', '$USER_ID', '$PROXY_USER_KEY', 'active', 1, '$NOW', '{}');
        "
        ok "MemoryCore admin user bootstrapped with PROXY_USER_KEY"
      else
        warn "MemoryCore database exists but PROXY_USER_KEY is not set; cannot bootstrap admin user"
      fi
    else
      ok "MemoryCore admin user already exists"
    fi
  else
    mkdir -p "$(dirname "$MEMORY_DB")"
    ok "MemoryCore database not yet created (first start of the core will create it)"
  fi
fi

# ── 7. GitLab MR integration (optional) ──────────────────────────────────────
# Enabled only when a bot username is supplied (env or prompt); an empty value
# skips the whole section. The integration mirrors the Feishu pattern: a skill
# teaches the agent the git/glab outbound workflow, and a poller plugin watches
# the created MRs for new comments / merge / close and wakes the owning session.
GITLAB_ARTIFACT_DIR="$REPO_ROOT/gitlab-mr"
GITLAB_BOT_USERNAME="$(ask_opt DSH_GITLAB_BOT_USERNAME 'GitLab bot username (empty to skip GitLab MR integration)' '')"
if [[ -n "$GITLAB_BOT_USERNAME" ]]; then
  GITLAB_API_BASE="$(ask_opt DSH_GITLAB_API_BASE 'GitLab API base URL' 'https://gitlab.com/api/v4')"
  GITLAB_TOKEN="$(ask_secret_opt DSH_GITLAB_TOKEN 'GitLab bot PAT (scope api; empty to set manually later)')"
  die_on_newline GITLAB_BOT_USERNAME
  die_on_newline GITLAB_API_BASE
  die_on_newline GITLAB_TOKEN

  # 7a. Skill — the agent's outbound workflow (git + glab commands, MR/comment
  #     conventions, merge-distill template). Installed under the user skills
  #     root so skill-filesystem discovers it without any further wiring.
  if [[ ! -e "$DSH_HOME/skills/gitlab-mr-workflow" || "$FORCE" == "1" ]]; then
    mkdir -p "$DSH_HOME/skills"
    cp -R "$GITLAB_ARTIFACT_DIR/gitlab-mr-workflow" "$DSH_HOME/skills/"
    ok "gitlab-mr skill -> $DSH_HOME/skills/gitlab-mr-workflow"
  else
    warn "gitlab-mr skill already exists, skipping: $DSH_HOME/skills/gitlab-mr-workflow"
  fi

  # 7b. Poller plugin — appended as a second patch entry so it stays separable
  #     from the Feishu block and survives a --force re-deploy of the profile.
  POLLER_PLUGIN="$GITLAB_ARTIFACT_DIR/gitlab-mr-poller.mjs"
  if [[ ! -f "$POLLER_PLUGIN" ]]; then
    warn "gitlab-mr poller not found at $POLLER_PLUGIN; skipping plugin mount (artifact moves with this checkout)"
  elif grep -q 'id: gitlab-mr' "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null; then
    warn "gitlab-mr already mounted in cordis.patch.yml; skipping"
  else
    cat >> "$PROFILE_DIR/cordis.patch.yml" <<EOF

# GitLab MR polling + watch tool (see gitlab-mr/README.md). The token reads
# GITLAB_TOKEN from the environment (root .env or the credentials store); the
# agent registers each MR it creates via the gitlab_watch_mr tool.
- insert:
    - id: gitlab-mr
      name: $POLLER_PLUGIN
      config:
        apiBase: '$GITLAB_API_BASE'
        botUsername: '$GITLAB_BOT_USERNAME'
EOF
    ok "gitlab-mr poller -> $PROFILE_DIR/cordis.patch.yml"
  fi

  # 7c. Token — append to the repo .env (only when supplied and not already
  #     present), so the poller and the agent's glab both read GITLAB_TOKEN.
  if [[ -n "$GITLAB_TOKEN" ]]; then
    if [[ ! -e "$REPO_ROOT/.env" ]]; then
      umask 077
      : > "$REPO_ROOT/.env"
    fi
    if grep -q '^GITLAB_TOKEN=' "$REPO_ROOT/.env"; then
      warn "GITLAB_TOKEN already present in .env; skipping"
    else
      printf 'GITLAB_TOKEN=%s\n' "$GITLAB_TOKEN" >> "$REPO_ROOT/.env"
      ok "GITLAB_TOKEN -> $REPO_ROOT/.env"
    fi
  fi
else
  info "GitLab MR integration skipped (no bot username)"
fi

# ── Summary ────────────────────────────────────────────────────────────────
echo
ok "bootstrap complete."
echo
echo "Start the full stack (in dependency order):  ./scripts/setup-dsh/start-all.sh"
echo "Stop it:                                    ./scripts/setup-dsh/stop-all.sh"
echo
echo "Or start services one by one:"
echo "  1. MemoryCore     :8420   cd $DSH_HOME/tdai-stack/TencentDB-Agent-Memory/MemoryCore && set -a && . ./.env.local && set +a && node --import tsx src/gateway/server.ts"
echo "  2. MemoryProxy    :8096   cd $DSH_HOME/tdai-stack/TencentDB-Agent-Memory/MemoryProxy && node --import tsx/esm src/index.ts --config $DSH_HOME/tdai-stack/config/proxy-config.yaml"
echo "  3. MemoryKnowledge :8421  cd $DSH_HOME/tdai-stack/TencentDB-Agent-Memory/MemoryKnowledge && pnpm dev"
echo "  4. MemoryPanel    :8123   cd $DSH_HOME/tdai-stack/TencentDB-Agent-Memory/MemoryPanel && pnpm dev"
echo "  5. dsh Web UI     :3080   cd $WORKSPACE && pnpm dsh web --host 0.0.0.0 --port 3080"
echo
echo "Verify memory at http://127.0.0.1:8123 (panel) after a chat."
