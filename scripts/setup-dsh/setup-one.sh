#!/usr/bin/env bash
# One-key bootstrap: run setup.sh driven by a config file instead of prompts.
#
#   bash scripts/setup-dsh/setup-one.sh [--env PATH] [setup.sh options...]
#
# Reads DSH_* values from a config file (default $DSH_SETUP_ENV_FILE or
# ~/.dsh/setup-dsh.env), exports them, and runs setup.sh with
# --non-interactive: values present in the file win, a missing required
# secret fails loudly, and an empty optional value behaves like a blank
# prompt. All options after --env are passed through to setup.sh.
#
# Options:
#   --env PATH   config file to read (default $DSH_SETUP_ENV_FILE or ~/.dsh/setup-dsh.env)
#   -h, --help   this help
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${DSH_SETUP_ENV_FILE:-$HOME/.dsh/setup-dsh.env}"

usage() {
  awk 'NR>1 { if (/^set -euo pipefail$/) exit; sub(/^# ?/, ""); print }' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) ENV_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) break ;;   # everything else belongs to setup.sh
  esac
done

[[ -f "$ENV_FILE" ]] || {
  echo "[setup-one] config file not found: $ENV_FILE" >&2
  echo "[setup-one] copy scripts/setup-dsh/setup.env.example and fill in the values" >&2
  exit 1
}

# set -a exports every assignment in the config file so the setup.sh child
# process inherits them as real environment variables (env wins in setup.sh).
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

exec bash "$SCRIPT_DIR/setup.sh" --non-interactive "$@"
