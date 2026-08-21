#!/usr/bin/env bash
# Stop every service that start-all.sh launched, in reverse dependency order.
# Processes are stopped by pidfile; a legacy launchd instance (tdai-stack/
# start.sh) is unloaded first, and a process left listening on the service's
# port without a pidfile is stopped as a last resort.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

stop_one() {
  local name="$1" pf pid port
  # A legacy launchd instance must be unloaded before any kill: its KeepAlive
  # would resurrect the process otherwise.
  unload_launchd "$name"
  pf="$(pidfile "$name")"
  if [[ -f "$pf" ]]; then
    pid="$(cat "$pf" 2>/dev/null || true)"
    if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
      warn "$name: pid ${pid:-<empty>} not running — removing stale pidfile"
    else
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
    fi
    rm -f "$pf"
    # The pidfile records the launcher, not the listener: the service is not
    # stopped until its port is actually free (SIGKILL fallback included).
    stop_on_port "$name"
    ok "$name stopped"
    return 0
  fi
  # No pidfile: fall back to the port so processes started manually (or left
  # over from launchd) are still stopped.
  port="$(port_of "$name")"
  if [[ -n "$port" ]] && is_listening "$port"; then
    warn "$name: no pidfile — stopping listener on :$port"
    stop_on_port "$name"
    ok "$name stopped (by port :$port)"
    return 0
  fi
  warn "$name: not managed by start-all.sh — skipping"
}

for name in dsh-web panel knowledge proxy core; do
  stop_one "$name"
done

ok "done."
