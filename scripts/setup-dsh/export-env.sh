#!/bin/bash
# Export current runtime configuration as DSH_* env vars for setup-one.sh.
#
# Reads your running config files (~/.dsh/, repo/.env, memory stack) and prints
# DSH_*="value" lines to stdout. Capture the output and use it on a fresh
# clone to reproduce this computer's configuration:
#
#   bash scripts/setup-dsh/export-env.sh > ~/.dsh/setup-dsh.env
#   chmod 600 ~/.dsh/setup-dsh.env
#   ./scripts/setup-dsh/setup-one.sh --env ~/.dsh/setup-dsh.env
#
# Options:
#   --dsh-home DIR   DSH_HOME directory (default: $HOME/.dsh)
#   --repo DIR       deepseek-harness repo root (default: parent of scripts/)
#   -h, --help       this help

set -eu

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh-home) DSH_HOME="$2"; shift 2 ;;
    --repo) REPO_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^#//;2s/^ //'
      exit 0 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

# --- helpers -----------------------------------------------------------------

# Read a value from a simple KEY=value .env file (first '=' after key).
env_val() {
  local f="$1" k="$2"
  [[ -f "$f" ]] || return 1
  awk -F= -v k="$k" '$1 == k {sub(/^[^=]*=/, ""); print; exit}' "$f"
}

# Read a flat YAML scalar value:  key: "quoted" or key: bare_word
# Fails (returns 1 / empty) if the file does not exist.
yaml_val() {
  local f="$1" k="$2"
  [[ -f "$f" ]] || return 1
  awk -F': ' -v k="$k" \
    '$1 == k {gsub(/^"|"$/, "", $2); print $2; found=1; exit}
     END {exit !found}' "$f" 2>/dev/null || true
}

# Read a value nested under a two-level section:  section: ...  key: value
# Strips surrounding quotes. Resets section on any top-level key.
yaml_nested_val() {
  local f="$1" section="$2" key="$3"
  [[ -f "$f" ]] || return 1
  awk -v sec="$section" -v k="$key" \
    '$1 == sec ":" {s=1; next}
     /^[a-zA-Z]/ && !/^ / {s=0}
     s && $1 == k ":" {gsub(/^"|"$/, "", $2); print $2; found=1; exit}
     END {exit !found}' "$f" 2>/dev/null || true
}

say() { printf '%s\n' "$*"; }
blank() { echo; }

# --- header ------------------------------------------------------------------

cat <<'HEADER'
# Exported by scripts/setup-dsh/export-env.sh
# Source: your running configuration files (~/.dsh, repo .env, memory stack).
# WARNING: Every value contains real credentials. Keep out of git.
#          Delete this file when no longer needed.

HEADER

# --- DSH_PROXY_USER_KEY ------------------------------------------------------
CREDS="$DSH_HOME/.credentials.yaml"
if [[ -f "$CREDS" ]]; then
  PROXY_USER_KEY="$(awk '/^PROXY_USER_KEY:/{gsub(/"/,"",$2); print $2; exit}' "$CREDS")"
fi
if [[ -n "${PROXY_USER_KEY:-}" ]]; then
  say "# from $CREDS"
  say "DSH_PROXY_USER_KEY=\"$PROXY_USER_KEY\""
else
  say "# $CREDS not found — set PROXY_USER_KEY or leave empty"
  say 'DSH_PROXY_USER_KEY=""'
fi

# --- DSH_FEISHU_FALLBACK_CHAT_ID ---------------------------------------------
PROFILE="$DSH_HOME/profiles/web/cordis.patch.yml"
FALLBACK=""
[[ -f "$PROFILE" ]] && FALLBACK="$(awk '/fallbackChatId:/{print $NF}' "$PROFILE")"
blank
if [[ -n "${FALLBACK:-}" ]]; then
  say "# from $PROFILE"
  say "DSH_FEISHU_FALLBACK_CHAT_ID=\"$FALLBACK\""
else
  say "# fallbackChatId not found in $PROFILE — approval cards routed per-chat"
  say 'DSH_FEISHU_FALLBACK_CHAT_ID=""'
fi

# --- Repo .env (DEEPSEEK_API_KEY / FEISHU_APP_ID / FEISHU_APP_SECRET) --------
ENV_FILE="$REPO_DIR/.env"
blank
if [[ -f "$ENV_FILE" ]]; then
  say "# from $ENV_FILE"
else
  say "# WARN: $ENV_FILE not found"
fi
for pair in DEEPSEEK_API_KEY:DSH_DEEPSEEK_API_KEY \
            FEISHU_APP_ID:DSH_FEISHU_APP_ID \
            FEISHU_APP_SECRET:DSH_FEISHU_APP_SECRET; do
  src="${pair%%:*}"
  dst="${pair##*:}"
  val="$(env_val "$ENV_FILE" "$src")"
  say "$dst=\"$val\""
done

# --- DSH_PROXY_UPSTREAM_* ----------------------------------------------------
PROXY_CFG="$DSH_HOME/tdai-stack/config/proxy-config.yaml"
blank
if [[ -f "$PROXY_CFG" ]]; then
  say "# from $PROXY_CFG"
else
  say "# WARN: $PROXY_CFG not found"
fi
UPSTREAM_URL="$(yaml_nested_val "$PROXY_CFG" "upstream" "url")"
UPSTREAM_API_KEY="$(yaml_nested_val "$PROXY_CFG" "upstream" "apiKey")"
say "DSH_PROXY_UPSTREAM_URL=\"$UPSTREAM_URL\""
say "DSH_PROXY_UPSTREAM_API_KEY=\"$UPSTREAM_API_KEY\""

# --- DSH_KERNEL_GATEWAY_API_KEY ----------------------------------------------
META="$DSH_HOME/tdai-stack/TencentDB-Agent-Memory/MemoryPanel/config/metadata-instances.json"
blank
if [[ -f "$META" ]]; then
  say "# from $META"
  GATEWAY_KEY="$(grep -o '"api_key": *"[^"]*"' "$META" | head -1 | cut -d'"' -f4)"
  say "DSH_KERNEL_GATEWAY_API_KEY=\"$GATEWAY_KEY\""
else
  say "# $META not found — gateway api_key will fall back to PROXY_USER_KEY or 'local'"
  say 'DSH_KERNEL_GATEWAY_API_KEY=""'
fi

# --- DSH_TDAI_LLM_* + DSH_MEMORY_DATA_DIR ------------------------------------
GATEWAY_CFG="$DSH_HOME/tdai-stack/config/tdai-gateway.yaml"
blank
if [[ -f "$GATEWAY_CFG" ]]; then
  say "# from $GATEWAY_CFG"
else
  say "# WARN: $GATEWAY_CFG not found"
fi

LLM_API_KEY="$(yaml_nested_val "$GATEWAY_CFG" "llm" "apiKey")"
LLM_BASE_URL="$(yaml_nested_val "$GATEWAY_CFG" "llm" "baseUrl")"
LLM_MODEL="$(yaml_nested_val "$GATEWAY_CFG" "llm" "model")"
DATA_DIR="$(yaml_nested_val "$GATEWAY_CFG" "data" "baseDir")"

say "DSH_TDAI_LLM_API_KEY=\"$LLM_API_KEY\""
say "DSH_TDAI_LLM_BASE_URL=\"$LLM_BASE_URL\""
say "DSH_TDAI_LLM_MODEL=\"$LLM_MODEL\""

if [[ -n "$DATA_DIR" ]]; then
  blank
  say "# from $GATEWAY_CFG (data.baseDir)"
  say "DSH_MEMORY_DATA_DIR=\"$DATA_DIR\""
fi