#!/usr/bin/env bash
# Stop every service that start-all.sh launched, in reverse dependency order.
# Only processes recorded in $DSH_HOME/run/pids are touched; services started
# outside start-all.sh are left alone.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

stop_one() {
  local name="$1" pf pid
  pf="$(pidfile "$name")"
  if [[ ! -f "$pf" ]]; then
    warn "$name: not managed by start-all.sh — skipping"
    return 0
  fi
  pid="$(cat "$pf" 2>/dev/null || true)"
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    warn "$name: pid ${pid:-<empty>} not running — removing stale pidfile"
    rm -f "$pf"
    return 0
  fi
  info "stopping $name (pid $pid)"
  stop_tree "$pid" TERM
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    warn "$name did not stop gracefully — SIGKILL"
    stop_tree "$pid" KILL
  fi
  rm -f "$pf"
  ok "$name stopped"
}

for name in dsh-web panel knowledge proxy core; do
  stop_one "$name"
done

ok "done."
