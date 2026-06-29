#!/usr/bin/env bash
# config.sh — Load telemetry configuration with defaults

TELEMETRY_DIR="${TELEMETRY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TELEMETRY_CONFIG_FILE="${TELEMETRY_CONFIG_FILE:-${TELEMETRY_DIR}/telemetry.conf}"

# Defaults
TELEMETRY_ENABLED="${TELEMETRY_ENABLED:-true}"
# TELEMETRY_DIR is <workspace>/scripts/telemetry, so the workspace root is
# two levels up. Three levels escaped into the workspace's PARENT directory
# (caught by live acceptance smoke 2026-06-11: events landed in /tmp/.telemetry
# instead of the installed workspace).
TELEMETRY_DATA_DIR="${TELEMETRY_DATA_DIR:-$(cd "${TELEMETRY_DIR}/../.." && pwd)/.telemetry}"
TELEMETRY_SESSION_DIR="${TELEMETRY_SESSION_DIR:-${TELEMETRY_DATA_DIR}/sessions}"
TELEMETRY_ENRICH_SYSTEM="${TELEMETRY_ENRICH_SYSTEM:-true}"
TELEMETRY_ENRICH_WORKSPACE="${TELEMETRY_ENRICH_WORKSPACE:-true}"
TELEMETRY_ENRICH_AUTH="${TELEMETRY_ENRICH_AUTH:-true}"
TELEMETRY_SYNC_INCLUDE="${TELEMETRY_SYNC_INCLUDE:-*}"
TELEMETRY_SYNC_EXCLUDE="${TELEMETRY_SYNC_EXCLUDE:-neo-*,Neo,local-gamma-*}"
TELEMETRY_MAX_LOG_SIZE_MB="${TELEMETRY_MAX_LOG_SIZE_MB:-50}"
TELEMETRY_MAX_LOG_FILES="${TELEMETRY_MAX_LOG_FILES:-3}"
TELEMETRY_CHANNELS="${TELEMETRY_CHANNELS:-full}"
FLOW_AGENTS_TELEMETRY_CAPTURE_RAW_HOOK_INPUT="${FLOW_AGENTS_TELEMETRY_CAPTURE_RAW_HOOK_INPUT:-false}"
TELEMETRY_USAGE_TRACKING="${TELEMETRY_USAGE_TRACKING:-true}"
TELEMETRY_NOTIFICATIONS="${TELEMETRY_NOTIFICATIONS:-true}"
TELEMETRY_NOTIFICATION_PROFILE="${TELEMETRY_NOTIFICATION_PROFILE:-standard}"
TELEMETRY_GOVERNANCE="${TELEMETRY_GOVERNANCE:-true}"
TELEMETRY_GOVERNANCE_AUDIT_MAX_SIZE_MB="${TELEMETRY_GOVERNANCE_AUDIT_MAX_SIZE_MB:-25}"
TELEMETRY_GOVERNANCE_AUDIT_MAX_FILES="${TELEMETRY_GOVERNANCE_AUDIT_MAX_FILES:-5}"

# Channel defaults
TELEMETRY_CHANNEL_FULL_LOG_FILE="${TELEMETRY_CHANNEL_FULL_LOG_FILE:-${TELEMETRY_DATA_DIR}/full.jsonl}"
TELEMETRY_CHANNEL_FULL_REDACT="${TELEMETRY_CHANNEL_FULL_REDACT:-hook.raw_input,turn.prompt_text,tool.input,tool.output}"
TELEMETRY_CHANNEL_ANALYTICS_LOG_FILE="${TELEMETRY_CHANNEL_ANALYTICS_LOG_FILE:-${TELEMETRY_DATA_DIR}/analytics.jsonl}"
TELEMETRY_CHANNEL_ANALYTICS_REDACT="${TELEMETRY_CHANNEL_ANALYTICS_REDACT:-tool.input,tool.output,turn.prompt_text,delegation.targets.query,context.cwd,hook.raw_input,hook.last_assistant_message,hook.transcript_path}"
TELEMETRY_CHANNEL_ANALYTICS_ENDPOINT_URL="${TELEMETRY_CHANNEL_ANALYTICS_ENDPOINT_URL:-}"
CONSOLE_TELEMETRY_URL="${CONSOLE_TELEMETRY_URL:-${CONSOLE_URL:-}}"
CONSOLE_TELEMETRY_ENDPOINT_URL="${CONSOLE_TELEMETRY_ENDPOINT_URL:-}"
CONSOLE_TELEMETRY_TOKEN="${CONSOLE_TELEMETRY_TOKEN:-${CONSOLE_AUTH_TOKEN:-}}"
CONSOLE_TENANT_ID="${CONSOLE_TENANT_ID:-}"
# Pricing registry source (consumed by lib/pricing.sh). Explicit file/URL win;
# otherwise the URL is derived from the console below so all runtimes read one
# live pricing source. Falls back to the bundled pricing.json offline.
TELEMETRY_PRICING_FILE="${TELEMETRY_PRICING_FILE:-${FLOW_AGENTS_PRICING_FILE:-}}"
TELEMETRY_PRICING_URL="${TELEMETRY_PRICING_URL:-${FLOW_AGENTS_PRICING_URL:-}}"

# Load config file if it exists
if [[ -f "$TELEMETRY_CONFIG_FILE" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
    key=$(echo "$key" | tr -d '[:space:]')
    value=$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    
    # Handle channel-specific config
    if [[ "$key" =~ ^channel\.([^.]+)\.(.+)$ ]]; then
      channel_name="${BASH_REMATCH[1]}"
      channel_key="${BASH_REMATCH[2]}"
      if [[ "$channel_name" =~ ^[A-Za-z0-9_]+$ && "$channel_key" =~ ^[A-Za-z0-9_]+$ ]]; then
        var_name="TELEMETRY_CHANNEL_$(echo "$channel_name" | tr '[:lower:]' '[:upper:]')_$(echo "$channel_key" | tr '[:lower:]' '[:upper:]')"
        printf -v "$var_name" '%s' "$value"
      fi
    else
      # Standard config
      case "$key" in
        enabled) TELEMETRY_ENABLED="$value" ;;
        channels) TELEMETRY_CHANNELS="$value" ;;
        enrich_system) TELEMETRY_ENRICH_SYSTEM="$value" ;;
        enrich_workspace) TELEMETRY_ENRICH_WORKSPACE="$value" ;;
        enrich_auth) TELEMETRY_ENRICH_AUTH="$value" ;;
        max_log_size_mb) TELEMETRY_MAX_LOG_SIZE_MB="$value" ;;
        max_log_files) TELEMETRY_MAX_LOG_FILES="$value" ;;
        sync_include) TELEMETRY_SYNC_INCLUDE="$value" ;;
        sync_exclude) TELEMETRY_SYNC_EXCLUDE="$value" ;;
        usage_tracking) TELEMETRY_USAGE_TRACKING="$value" ;;
        notifications) TELEMETRY_NOTIFICATIONS="$value" ;;
        notification_profile) TELEMETRY_NOTIFICATION_PROFILE="$value" ;;
        governance) TELEMETRY_GOVERNANCE="$value" ;;
        governance_audit_max_size_mb) TELEMETRY_GOVERNANCE_AUDIT_MAX_SIZE_MB="$value" ;;
        governance_audit_max_files) TELEMETRY_GOVERNANCE_AUDIT_MAX_FILES="$value" ;;
        console_url) CONSOLE_TELEMETRY_URL="$value" ;;
        console_telemetry_url) CONSOLE_TELEMETRY_URL="$value" ;;
        console_telemetry_endpoint_url) CONSOLE_TELEMETRY_ENDPOINT_URL="$value" ;;
        console_telemetry_token) CONSOLE_TELEMETRY_TOKEN="$value" ;;
        console_tenant_id) CONSOLE_TENANT_ID="$value" ;;
        console_telemetry_redact) CONSOLE_TELEMETRY_REDACT="$value" ;;
        console_pricing_url) TELEMETRY_PRICING_URL="$value" ;;
        pricing_url) TELEMETRY_PRICING_URL="$value" ;;
        pricing_file) TELEMETRY_PRICING_FILE="$value" ;;
      esac
    fi
  done < "$TELEMETRY_CONFIG_FILE"
fi

CONSOLE_TELEMETRY_REDACT="${CONSOLE_TELEMETRY_REDACT:-${TELEMETRY_CHANNEL_ANALYTICS_REDACT}}"

# Derive the live pricing source from the console when not set explicitly, the
# same way the transport derives /api/telemetry/records. One live source for
# bash/Python/TS runtimes; lib/pricing.sh caches it and falls back to bundled.
if [[ -z "${TELEMETRY_PRICING_URL:-}" && -n "${CONSOLE_TELEMETRY_URL:-}" ]]; then
  TELEMETRY_PRICING_URL="${CONSOLE_TELEMETRY_URL%/}/api/telemetry/pricing"
fi

# Ensure directories exist
mkdir -p "$TELEMETRY_DATA_DIR" "$TELEMETRY_SESSION_DIR" 2>/dev/null
