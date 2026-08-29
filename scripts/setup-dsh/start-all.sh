#!/usr/bin/env bash
# Start the full local dsh + memory stack in dependency order, fully automated.
#
#   1. MemoryCore     :8420   (kernel gateway — needs .env.local from setup.sh)
#   2. MemoryProxy    :8096   (dsh's LLM baseURL — needs proxy-config.yaml)
#   3. MemoryKnowledge :8421  (Wiki / Code-Graph)
#   4. MemoryPanel    :8123   (stateless control panel, binds all interfaces)
#   5. dsh Web UI     :3080   (binds all interfaces)
#
# Each service is daemonized (logs under $DSH_HOME/run/logs, pidfiles under
# $DSH_HOME/run/pids), and the script waits on its health endpoint before
# starting the next. Already-running services (detected by port) are skipped,
# so this is safe to re-run. Stop everything with ./stop-all.sh.
#
# Every service is pidfile-managed here, including MemoryCore and MemoryProxy:
# a legacy launchd instance (tdai-stack/start.sh) is unloaded and its plist
# parked before the port is touched, so the two management paths never fight.
#
# Options:
#   --workspace PATH   repo that serves the dsh Web UI (default: this repo)
#   -h, --help         this help
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

# The TencentDB memory stack pins Node v22; stack_node_bin resolves the bin
# dir (bundled node22 first, then Homebrew node@22, else the ambient node) so
# every service starts on it. setup.sh installs under the same resolution, so
# native bindings always match the runtime Node.
if node_dir="$(stack_node_bin)"; then
  PATH="$node_dir:$PATH"
fi

WORKSPACE="${DSH_WORKSPACE:-$REPO_ROOT}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) WORKSPACE="$2"; shift 2 ;;
    -h|--help)
      awk 'NR>1 { if (/^set -euo pipefail$/) exit; sub(/^# ?/, ""); print }' "$0"
      exit 0 ;;
    *) die "unknown option: $1 (run with --help)" ;;
  esac
done
WORKSPACE="$(cd "$WORKSPACE" 2>/dev/null && pwd || true)"
[[ -n "$WORKSPACE" && -d "$WORKSPACE" ]] || die "workspace $WORKSPACE is not a directory"

# Pre-flight: the memory stack must already be cloned (hard requirement), and
# each service's config must exist when that service would have to start here
# (an already-running service is skipped without touching its config).
require() { [[ -e "$1" ]] || die "missing $1 — run ./scripts/setup-dsh/setup.sh first"; }
require "$MEMORY_ROOT/MemoryCore/src/gateway/server.ts"
require "$MEMORY_ROOT/MemoryProxy/package.json"
require "$MEMORY_ROOT/MemoryKnowledge/package.json"
require "$MEMORY_ROOT/MemoryPanel/package.json"

# require_config <name> <port> <path> — the service needs its config only when
# it is the one that starts here; a service already listening is left alone.
require_config() {
  local name="$1" port="$2" path="$3"
  if ! is_listening "$port" && [[ ! -f "$path" ]]; then
    die "$name would start without $path — run ./scripts/setup-dsh/setup.sh first"
  fi
}
require_config core 8420 "$MEMORY_ROOT/MemoryCore/.env.local"
require_config proxy 8096 "$DSH_HOME/tdai-stack/config/proxy-config.yaml"
require_config knowledge 8421 "$MEMORY_ROOT/MemoryKnowledge/.env"
require_config panel 8123 "$MEMORY_ROOT/MemoryPanel/.env"
[[ -d "$WORKSPACE/node_modules" ]] || warn "$WORKSPACE/node_modules missing — run \`pnpm install\` in the workspace first"

mkdir -p "$PID_DIR" "$LOG_DIR"

# start_service <name> <port> <health-url> <timeout> <shell-command>
start_service() {
  local name="$1" port="$2" url="$3" timeout="$4" cmd="$5"
  # Take over from any legacy launchd instance before touching the port, and
  # wait for its socket to free up so the pidfile-managed process binds cleanly.
  unload_launchd "$name"
  wait_port_free "$port" 10
  if is_listening "$port"; then
    warn "$name already listening on :$port — skipping"
    return 0
  fi
  local pf; pf="$(pidfile "$name")"
  if [[ -f "$pf" ]] && kill -0 "$(cat "$pf" 2>/dev/null)" 2>/dev/null; then
    warn "$name already running (pid $(cat "$pf")) — skipping"
    return 0
  fi
  rm -f "$pf"
  info "starting $name (:$port) — log: $(logfile "$name")"
  bash -c "$cmd" > "$(logfile "$name")" 2>&1 &
  echo $! > "$pf"
  wait_healthy "$name" "$port" "$url" "$timeout"
}

# 1. MemoryCore :8420
start_service core 8420 "http://127.0.0.1:8420/health" 40 \
  "cd '$MEMORY_ROOT/MemoryCore' && set -a && . ./.env.local && set +a && node --import tsx src/gateway/server.ts"

# 1b. Bootstrap the MemoryCore admin user. The core builds its metadata
#     database lazily (first /v3/meta request), so on a fresh deployment the
#     database does not exist while setup.sh runs and its admin bootstrap is
#     skipped. Probing auth/verify forces the schema into existence, then the
#     admin user is inserted keyed with PROXY_USER_KEY — same SQL as setup.sh
#     §6f, and idempotent: an existing admin user is left alone.
bootstrap_memory_admin() {
  local data_dir="${DSH_MEMORY_DATA_DIR:-$HOME/.memory-tencentdb/memory-tdai}"
  local db="$data_dir/metadata/tdai_metadata_default/metadata.db"
  local i admin_exists key user_id key_id now

  # The probe key is deliberately invalid; the verify response is irrelevant,
  # what matters is that the request path builds the metadata schema.
  curl -sS -o /dev/null --max-time 5 -X POST \
    -H "content-type: application/json" \
    -H "x-tdai-service-id: default" \
    -d '{"user_key":"startup-probe"}' \
    "http://127.0.0.1:8420/v3/meta/auth/verify" 2>/dev/null || true
  for i in 1 2 3 4 5; do
    [[ -f "$db" ]] && break
    sleep 1
  done
  if [[ ! -f "$db" ]]; then
    warn "memory metadata db not created by probe — run setup.sh after the first chat to bootstrap the admin user"
    return 0
  fi

  admin_exists="$(sqlite3 "$db" "SELECT COUNT(*) FROM meta_users WHERE user_type='system_admin';" 2>/dev/null || echo 0)"
  if [[ "$admin_exists" != "0" ]]; then
    ok "memory admin user already present — skipping bootstrap"
    return 0
  fi

  key="$(awk '/^[[:space:]]*PROXY_USER_KEY:/{gsub(/"/,"",$2); print $2; exit}' "$DSH_HOME/.credentials.yaml" 2>/dev/null || true)"
  if [[ -z "$key" ]]; then
    warn "metadata db exists but PROXY_USER_KEY is not set; cannot bootstrap admin user"
    return 0
  fi

  user_id="usr-$(openssl rand -hex 5)"
  key_id="uky-$(openssl rand -hex 5)"
  now="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
  sqlite3 "$db" "
    INSERT INTO meta_users (user_id, auth_provider, external_id, username, status, user_type, created_at, updated_at, metadata_json)
    VALUES ('$user_id', 'local', '$user_id', 'admin', 'active', 'system_admin', '$now', '$now', '{}');
    INSERT INTO meta_user_keys (key_id, user_id, key_value, status, is_default, created_at, metadata_json)
    VALUES ('$key_id', '$user_id', '$key', 'active', 1, '$now', '{}');
  " && ok "memory admin user bootstrapped with PROXY_USER_KEY"
}
bootstrap_memory_admin

# 2. MemoryProxy :8096 — config is passed explicitly: the generated one lives
#    at $DSH_HOME/tdai-stack/config/proxy-config.yaml (the upstream repo's own
#    MemoryProxy/config.yaml is not consulted).
start_service proxy 8096 "http://127.0.0.1:8096/health" 30 \
  "cd '$MEMORY_ROOT/MemoryProxy' && node --import tsx/esm src/index.ts --config '$DSH_HOME/tdai-stack/config/proxy-config.yaml'"

# Proxy storage guard: MemoryProxy's sqlite storage is backed by better-sqlite3
# (an optionalDependency upstream, so a missing native binding silently
# degrades storage sqlite -> fs -> memory — dropping the session->identity
# binding and making memory-bridge/skill-bridge answer 40101). Check the
# *running* proxy (fresh start or an already-listening instance start_service
# skipped) reports matching requested/effective storage, so a degraded stack
# fails here instead of shipping broken memory. See setup.sh §6e for the
# install-time verification this complements.
guard_proxy_storage() {
  local health requested effective
  health="$(curl -sS --max-time 3 http://127.0.0.1:8096/health 2>/dev/null || true)"
  requested="$(printf '%s' "$health" | sed -n 's/.*"requested":"\([^"]*\)".*/\1/p')"
  effective="$(printf '%s' "$health" | sed -n 's/.*"effective":"\([^"]*\)".*/\1/p')"
  if [[ -n "$requested" && "$requested" != "$effective" ]]; then
    die "MemoryProxy storage degraded (requested=$requested, effective=${effective:-missing}) — run: ./scripts/setup-dsh/setup.sh --upgrade (it reinstalls better-sqlite3 under the stack Node)"
  fi
  if [[ -z "$effective" ]]; then
    warn "MemoryProxy /health reported no storage.effective — verify manually"
  fi
}
guard_proxy_storage

# 3. MemoryKnowledge :8421
start_service knowledge 8421 "http://127.0.0.1:8421/health" 40 \
  "cd '$MEMORY_ROOT/MemoryKnowledge' && pnpm dev"

# 4. MemoryPanel :8123
start_service panel 8123 "http://127.0.0.1:8123/health" 30 \
  "cd '$MEMORY_ROOT/MemoryPanel' && pnpm dev"

# 5. dsh Web UI :3080
# dsh-web has no unauthenticated HTTP health route: `/` (and every API path)
# is token-gated (401), while `/health` is 404 (the static fallback treats it
# as a missing asset). Pass an empty health URL so wait_healthy falls back to
# the TCP-port check instead of misreporting "not ready (http=401)".
start_service dsh-web 3080 "" 120 \
  "cd '$WORKSPACE' && pnpm dsh web --host 0.0.0.0 --port 3080"

echo
ok "all services up."
echo "  MemoryCore      http://127.0.0.1:8420/health"
echo "  MemoryProxy     http://127.0.0.1:8096/health"
echo "  MemoryKnowledge http://127.0.0.1:8421/health"
if LAN_IP="$(lan_ip)"; then
  echo "  MemoryPanel     http://127.0.0.1:8123  (control panel, LAN: http://$LAN_IP:8123)"
  echo "  dsh Web UI      http://127.0.0.1:3080  (LAN: http://$LAN_IP:3080)"
else
  warn "no LAN IP detected — panel and web UI reachable via loopback only"
  echo "  MemoryPanel     http://127.0.0.1:8123  (control panel)"
  echo "  dsh Web UI      http://127.0.0.1:3080"
fi
echo "Stop with:       ./scripts/setup-dsh/stop-all.sh"
