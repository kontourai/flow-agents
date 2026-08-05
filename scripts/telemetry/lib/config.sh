#!/usr/bin/env bash
# config.sh — Load telemetry configuration with defaults

TELEMETRY_DIR="${TELEMETRY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# TELEMETRY_DIR is <workspace>/scripts/telemetry, so the workspace root is
# two levels up.
TELEMETRY_WORKSPACE_ROOT="${TELEMETRY_WORKSPACE_ROOT:-$(cd "${TELEMETRY_DIR}/../.." && pwd)}"

# A workspace/global conf only counts as operator-created (and thus trusted
# with credentials) if it is mode 600 and owned by the current user.
# install-console-config.sh always chmod 600s the conf it writes; git can
# only store 644/755 (never 600), so this gate rejects a conf smuggled in via
# clone/tarball/PR/supply-chain even if it happens to land at the expected
# path. Portable across macOS/BSD stat (-f) and GNU/Linux stat (-c).
telemetry_conf_trusted() {
  local file="$1" mode owner
  # Reject symlinks outright: stat below reports the link's own mode/owner
  # (lstat semantics, no -L), but the config file is later read by following
  # the link, so a symlink lets `chmod -h 600 <link>` pass this gate while
  # the read lands on a different, untrusted target. Never trust a link.
  [[ -L "$file" ]] && return 1
  [[ -f "$file" ]] || return 1
  mode=$(stat -f '%Lp' "$file" 2>/dev/null) || mode=$(stat -c '%a' "$file" 2>/dev/null)
  owner=$(stat -f '%u' "$file" 2>/dev/null) || owner=$(stat -c '%u' "$file" 2>/dev/null)
  [[ "$mode" == "600" && -n "$owner" && "$owner" == "$(id -u)" ]]
}

# A candidate that exists on disk but fails telemetry_conf_trusted would
# otherwise be silently ignored (telemetry stays fail-open with no signal to
# the operator). Print a one-time, visible warning naming the path and the
# fix whenever this happens. Never warn when the file is simply absent, and
# never change which file TELEMETRY_CONFIG_FILE resolves to below -- this is
# purely additive/observational.
telemetry_conf_warn_untrusted() {
  local file="$1"
  # `-e` catches a regular file; `-L` additionally catches a symlink that
  # `-e` would miss (a symlink to a directory, or a dangling symlink) --
  # both of those are rejected by telemetry_conf_trusted's `-L` check above
  # but must still surface this warning, not silently emit none.
  [[ -e "$file" || -L "$file" ]] || return 0
  printf 'warning: config.sh: %s exists but is not trusted (must be mode 600, owned by the current user, and not a symlink); telemetry will ignore it and stay fail-open. Fix with: chmod 600 "%s"\n' "$file" "$file" >&2
}

# Config file resolution order: (1) explicit TELEMETRY_CONFIG_FILE env always
# wins; (2) a gitignored per-workspace conf at .kontourai/telemetry-console.conf
# if present and operator-trusted (project-specific override); (3) a
# gitignored user-global conf at ~/.flow-agents/telemetry-console.conf if
# present and operator-trusted, matching the existing ~/.flow-agents
# install-home convention (see scripts/discover-agents.sh,
# scripts/context-budget/budget-scan.sh) so one machine-wide install can carry owner
# credentials without per-workspace wiring; (4) the shipped telemetry.conf
# default. The shipped scripts/telemetry/telemetry.conf is tracked and ships
# into every packaged dist bundle, so it must never carry owner credentials.
# A candidate that exists but fails the trust gate falls through silently
# (telemetry stays fail-open).
TELEMETRY_LOCAL_CONFIG_FILE="${TELEMETRY_WORKSPACE_ROOT}/.kontourai/telemetry-console.conf"
TELEMETRY_GLOBAL_CONFIG_FILE="${HOME:-}/.flow-agents/telemetry-console.conf"
if [[ -n "${TELEMETRY_CONFIG_FILE:-}" ]]; then
  :
elif telemetry_conf_trusted "$TELEMETRY_LOCAL_CONFIG_FILE"; then
  TELEMETRY_CONFIG_FILE="$TELEMETRY_LOCAL_CONFIG_FILE"
else
  telemetry_conf_warn_untrusted "$TELEMETRY_LOCAL_CONFIG_FILE"
  if [[ -n "${HOME:-}" ]] && telemetry_conf_trusted "$TELEMETRY_GLOBAL_CONFIG_FILE"; then
    TELEMETRY_CONFIG_FILE="$TELEMETRY_GLOBAL_CONFIG_FILE"
  else
    [[ -n "${HOME:-}" ]] && telemetry_conf_warn_untrusted "$TELEMETRY_GLOBAL_CONFIG_FILE"
    TELEMETRY_CONFIG_FILE="${TELEMETRY_DIR}/telemetry.conf"
  fi
fi

# Defaults
TELEMETRY_ENABLED="${TELEMETRY_ENABLED:-true}"
# Local runtime telemetry defaults under .kontourai/telemetry; explicit
# TELEMETRY_DATA_DIR still wins.
TELEMETRY_DATA_DIR="${TELEMETRY_DATA_DIR:-${TELEMETRY_WORKSPACE_ROOT}/.kontourai/telemetry}"
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
# Economics relay (#469): a caller-pre-set env var is preserved as the starting point; the
# config-file key (parsed below) can override it, and if no key is present at all the
# default-on rule below turns it on once a console telemetry sink resolves.
FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY="${FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY:-}"
FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="${FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL:-}"
# Set (non-empty) only when the config file carries an explicit console_economics_relay key —
# distinguishes "operator said 0/1" from "key absent" for the default-on rule below.
console_economics_relay_raw=""
# Liveness relay (#567): same conf-driven, opt-out-not-silent-off shape as economics (#469) so an
# operator enables the hosted liveness mirror via console_liveness_relay=1 in the conf, NOT an env
# var/.profile. A caller-pre-set env var is the starting point; the config key overrides it; absent
# any key the default-on rule below turns it on once a console telemetry sink resolves.
FLOW_AGENTS_CONSOLE_LIVENESS_RELAY="${FLOW_AGENTS_CONSOLE_LIVENESS_RELAY:-}"
FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL="${FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL:-}"
console_liveness_relay_raw=""
# Pricing registry source (consumed by lib/pricing.sh). Explicit file/URL win;
# otherwise lib/pricing.sh uses the bundled pricing.json offline.
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
        console_economics_relay)
          case "$(echo "$value" | tr '[:upper:]' '[:lower:]')" in
            1|true|yes|on) console_economics_relay_raw="1" ;;
            0|false|no|off) console_economics_relay_raw="0" ;;
            *)
              printf 'warning: config.sh: unrecognized console_economics_relay value %q; treating as off\n' "$value" >&2
              console_economics_relay_raw="$value"
              ;;
          esac
          ;;
        console_economics_endpoint_url) FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL="$value" ;;
        console_liveness_relay)
          case "$(echo "$value" | tr '[:upper:]' '[:lower:]')" in
            1|true|yes|on) console_liveness_relay_raw="1" ;;
            0|false|no|off) console_liveness_relay_raw="0" ;;
            *)
              printf 'warning: config.sh: unrecognized console_liveness_relay value %q; treating as off\n' "$value" >&2
              console_liveness_relay_raw="$value"
              ;;
          esac
          ;;
        console_liveness_endpoint_url) FLOW_AGENTS_CONSOLE_LIVENESS_ENDPOINT_URL="$value" ;;
        console_pricing_url) TELEMETRY_PRICING_URL="$value" ;;
        pricing_url) TELEMETRY_PRICING_URL="$value" ;;
        pricing_file) TELEMETRY_PRICING_FILE="$value" ;;
      esac
    fi
  done < "$TELEMETRY_CONFIG_FILE"
fi

CONSOLE_TELEMETRY_REDACT="${CONSOLE_TELEMETRY_REDACT:-${TELEMETRY_CHANNEL_ANALYTICS_REDACT}}"

# Economics relay default-on rule (#469, opt-out not silent-off): an explicit
# console_economics_relay config key always wins. Otherwise, once a console telemetry sink is
# resolved (console_telemetry_url/console_telemetry_endpoint_url non-empty) the relay defaults ON —
# unless a caller already pre-set FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY in the environment, which is
# left untouched. economics-record.sh's own opt-in gate (unchanged) reads this exact variable.
if [[ -n "$console_economics_relay_raw" ]]; then
  FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY="$console_economics_relay_raw"
elif [[ -z "$FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY" \
      && ( -n "${CONSOLE_TELEMETRY_URL:-}" || -n "${CONSOLE_TELEMETRY_ENDPOINT_URL:-}" ) ]]; then
  FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY=1
fi

# Liveness relay default-on rule (#567), identical shape to economics above: an explicit
# console_liveness_relay config key always wins; otherwise, once a console telemetry sink resolves,
# the relay defaults ON unless a caller already pre-set FLOW_AGENTS_CONSOLE_LIVENESS_RELAY in the
# environment. relay.sh's own opt-in gate reads this exact variable.
if [[ -n "$console_liveness_relay_raw" ]]; then
  FLOW_AGENTS_CONSOLE_LIVENESS_RELAY="$console_liveness_relay_raw"
elif [[ -z "$FLOW_AGENTS_CONSOLE_LIVENESS_RELAY" \
      && ( -n "${CONSOLE_TELEMETRY_URL:-}" || -n "${CONSOLE_TELEMETRY_ENDPOINT_URL:-}" ) ]]; then
  FLOW_AGENTS_CONSOLE_LIVENESS_RELAY=1
fi

# Pricing URL is explicit-only (env or config). Do not derive the console
# pricing endpoint by default; the bundled registry is the reliable offline floor.

# Ensure directories exist
mkdir -p "$TELEMETRY_DATA_DIR" "$TELEMETRY_SESSION_DIR" 2>/dev/null
