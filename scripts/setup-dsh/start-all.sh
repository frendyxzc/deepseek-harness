#!/usr/bin/env bash
# Start the full local dsh + memory stack in dependency order, fully automated.
#
#   1. MemoryCore     :8420   (kernel gateway — needs .env.local from setup.sh)
#   2. MemoryProxy    :8096   (dsh's LLM baseURL — needs config.yaml)
#   3. MemoryKnowledge :8421  (Wiki / Code-Graph)
#   4. MemoryPanel    :8123   (stateless control panel, binds all interfaces)
#   5. dsh Web UI     :3080   (binds all interfaces)
#
# Each service is daemonized (logs under $DSH_HOME/run/logs, pidfiles under
# $DSH_HOME/run/pids), and the script waits on its health endpoint before
# starting the next. Already-running services (detected by port) are skipped,
# so this is safe to re-run. Stop everything with ./stop-all.sh.
#
# Options:
#   --workspace PATH   repo that serves the dsh Web UI (default: this repo)
#   -h, --help         this help
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

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
# each service's config must exist (soft — only needed when that service has to
# start here; an already-running service is skipped without touching its config).
require() { [[ -e "$1" ]] || die "missing $1 — run ./scripts/setup-dsh/setup.sh first"; }
require "$MEMORY_ROOT/MemoryCore/src/gateway/server.ts"
require "$MEMORY_ROOT/MemoryProxy/package.json"
require "$MEMORY_ROOT/MemoryKnowledge/package.json"
require "$MEMORY_ROOT/MemoryPanel/package.json"
[[ -f "$MEMORY_ROOT/MemoryCore/.env.local" ]] || warn "core .env.local missing — core will fail if it needs to start here (run setup.sh)"
[[ -f "$MEMORY_ROOT/MemoryProxy/config.yaml" ]] || warn "proxy config.yaml missing — proxy will fail if it needs to start here (run setup.sh)"
[[ -f "$MEMORY_ROOT/MemoryPanel/.env" ]] || warn "panel .env missing — panel will fail if it needs to start here (run setup.sh)"
[[ -d "$WORKSPACE/node_modules" ]] || warn "$WORKSPACE/node_modules missing — run \`pnpm install\` in the workspace first"

mkdir -p "$PID_DIR" "$LOG_DIR"

# start_service <name> <port> <health-url> <timeout> <shell-command>
start_service() {
  local name="$1" port="$2" url="$3" timeout="$4" cmd="$5"
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

# 2. MemoryProxy :8096
start_service proxy 8096 "http://127.0.0.1:8096/health" 30 \
  "cd '$MEMORY_ROOT/MemoryProxy' && npm start"

# 3. MemoryKnowledge :8421
start_service knowledge 8421 "http://127.0.0.1:8421/health" 40 \
  "cd '$MEMORY_ROOT/MemoryKnowledge' && pnpm dev"

# 4. MemoryPanel :8123
start_service panel 8123 "http://127.0.0.1:8123/health" 30 \
  "cd '$MEMORY_ROOT/MemoryPanel' && pnpm dev"

# 5. dsh Web UI :3080
start_service dsh-web 3080 "http://127.0.0.1:3080/" 120 \
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
