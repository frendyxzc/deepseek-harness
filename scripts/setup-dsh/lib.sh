#!/usr/bin/env bash
# Shared runtime helpers for start-all.sh / stop-all.sh.
# Sourced (not executed): the caller keeps its own `set` options.
set -euo pipefail

# Harness home, same resolution as setup.sh: $DSH_HOME or ~/.dsh.
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_HOME="${DSH_HOME/#\~/$HOME}"

RUN_DIR="$DSH_HOME/run"
PID_DIR="$RUN_DIR/pids"
LOG_DIR="$RUN_DIR/logs"
MEMORY_ROOT="$DSH_HOME/tdai-stack/TencentDB-Agent-Memory"

info()  { printf '\033[1;34m[stack]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[stack]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[stack]\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m[stack]\033[0m %s\n' "$*" >&2; exit 1; }

pidfile() { printf '%s/%s.pid' "$PID_DIR" "$1"; }
logfile() { printf '%s/%s.log' "$LOG_DIR" "$1"; }

# is_listening <port> — true when a process is already bound to the TCP port.
is_listening() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1
  fi
}

# lan_ip — the machine's primary LAN IPv4, or empty when none is found.
# macOS: the interface carrying the default route. Linux: the first address
# reported by `hostname -I`.
lan_ip() {
  local iface ip=""
  case "$(uname -s)" in
    Darwin)
      iface="$(route -n get default 2>/dev/null | awk '/interface:/ { print $2; exit }')"
      if [[ -n "$iface" ]]; then
        ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      fi
      ;;
    Linux)
      ip="$(hostname -I 2>/dev/null | awk '{ print $1 }')"
      ;;
  esac
  [[ -n "$ip" ]] || return 1
  printf '%s\n' "$ip"
}

# pids_in_tree <pid> — the pid plus every descendant, space-separated.
pids_in_tree() {
  local pid="$1" out="$pid" child children
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  for child in $children; do
    out="$out $(pids_in_tree "$child")"
  done
  printf '%s' "$out"
}

# stop_tree <pid> <signal> — signal a process and all its descendants.
stop_tree() {
  local pid="$1" signal="$2" p
  for p in $(pids_in_tree "$pid"); do
    kill -"$signal" "$p" 2>/dev/null || true
  done
}

# wait_healthy <name> <port> <url> <timeout-seconds> — block until the service
# answers `url` with 2xx (or, when url is empty, until `port` is listening).
wait_healthy() {
  local name="$1" port="$2" url="$3" max="${4:-60}" i=0 code="" pid=""
  while (( i < max )); do
    if [[ -n "$url" ]]; then
      code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$url" 2>/dev/null || true)"
      [[ "$code" =~ ^2 ]] && { ok "$name healthy at $url"; return 0; }
    elif is_listening "$port"; then
      ok "$name listening on :$port"; return 0
    fi
    [[ -f "$(pidfile "$name")" ]] && pid="$(cat "$(pidfile "$name")" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      die "$name exited during startup — see $(logfile "$name")"
    fi
    sleep 1
    i=$((i + 1))
  done
  die "$name not ready within ${max}s (http=${code:-timeout}) — see $(logfile "$name")"
}
