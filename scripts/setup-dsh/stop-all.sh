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

# The loopback bridge shares :3080 with the Web UI, so it is stopped first by
# its own pidfile. A bridge left behind by a crashed launcher has no pidfile;
# two listeners on the port identify it, because a lone loopback listener is
# the Web UI itself, which stop_one still owns. stop_on_port would otherwise
# stop an arbitrary one of the two.
stop_loopback_bridge() {
  local count pid
  count="$(lsof -nP -tiTCP:3080 -sTCP:LISTEN 2>/dev/null | wc -l | tr -d ' ')"
  (( count > 1 )) || return 0
  pid="$(lsof -nP -tiTCP@127.0.0.1:3080 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [[ -n "$pid" ]] || return 0
  warn "stopping unmanaged loopback bridge on 127.0.0.1:3080 (pid $pid)"
  kill "$pid" 2>/dev/null || true
}

if [[ -f "$(pidfile dsh-web-loopback)" ]]; then
  stop_one dsh-web-loopback
fi
stop_loopback_bridge
for name in dsh-web panel knowledge proxy core; do
  stop_one "$name"
done

ok "done."
