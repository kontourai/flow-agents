#!/usr/bin/env bash
# Persist optional Console telemetry settings into an installed telemetry.conf.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: install-console-config.sh /path/to/telemetry.conf [options]

Options:
  --telemetry-sink NAME   local-files, local-kontour-console,
                          kontour-hosted-console, user-hosted-console,
                          or legacy aliases. May be repeated.
  --console-url URL       Console base URL. Derives /api/telemetry/records.
  --console-endpoint URL  Full Console telemetry records endpoint URL.
  --console-token-file PATH
                          File containing the bearer token.
  --console-tenant ID     Tenant identifier for hosted Console routing.
  --no-economics-relay    Write console_economics_relay=0 to opt out of the
                          automatic kit-economics relay (default-on once a
                          Console telemetry sink is configured; see
                          lib/config.sh).
EOF
}

die() {
  echo "install-console-config.sh: $*" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/console-presets.sh"

append_sinks() {
  local raw="$1"
  local sink
  raw="${raw//,/ }"
  for sink in $raw; do
    [[ -n "$sink" ]] && telemetry_sinks+=("$sink")
  done
}

has_control_chars() {
  [[ "$1" == *$'\n'* || "$1" == *$'\r'* || "$1" == *$'\t'* ]]
}

validate_url() {
  local label="$1"
  local value="$2"
  [[ -z "$value" ]] && return 0
  has_control_chars "$value" && die "$label must not contain control characters"
  if [[ "$value" == https://* ]]; then
    return 0
  fi
  if [[ "$value" == http://127.0.0.1:* || "$value" == http://127.0.0.1/* || "$value" == "http://127.0.0.1" ]]; then
    return 0
  fi
  if [[ "$value" == http://localhost:* || "$value" == http://localhost/* || "$value" == "http://localhost" ]]; then
    return 0
  fi
  die "$label must use https://, except localhost or 127.0.0.1 may use http://"
}

validate_token() {
  local value="$1"
  [[ -z "$value" ]] && return 0
  [[ "${#value}" -le 4096 ]] || die "Console token must be 4096 characters or fewer"
  has_control_chars "$value" && die "Console token must not contain control characters"
  [[ "$value" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || die "Console token contains unsupported characters"
}

read_token_file() {
  local file="$1"
  [[ -f "$file" ]] || die "--console-token-file does not exist: $file"
  local value
  value="$(tr -d '\r\n' <"$file")"
  [[ -n "$value" ]] || die "--console-token-file is empty"
  [[ "${#value}" -le 4096 ]] || die "Console token must be 4096 characters or fewer"
  printf '%s\n' "$value"
}

validate_tenant() {
  local value="$1"
  [[ -z "$value" ]] && return 0
  [[ "$value" =~ ^[A-Za-z0-9._:-]+$ ]] || die "--console-tenant contains unsupported characters"
}

set_config_key() {
  local conf="$1"
  local key="$2"
  local value="$3"
  [[ -z "$value" ]] && return 0
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/flow-agents-telemetry-conf.XXXXXX")"
  if [[ -f "$conf" ]]; then
    awk -v key="$key" 'BEGIN { prefix = key "=" } index($0, prefix) != 1 { print }' "$conf" >"$tmp"
  fi
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$conf"
}

main() {
  [[ $# -ge 1 ]] || { usage; exit 2; }
  local conf="$1"
  shift

  local console_url="${FLOW_AGENTS_CONSOLE_URL:-${CONSOLE_TELEMETRY_URL:-${CONSOLE_URL:-}}}"
  local console_endpoint="${FLOW_AGENTS_CONSOLE_ENDPOINT_URL:-${CONSOLE_TELEMETRY_ENDPOINT_URL:-}}"
  local console_token=""
  local console_token_file="${FLOW_AGENTS_CONSOLE_TOKEN_FILE:-${CONSOLE_TELEMETRY_TOKEN_FILE:-}}"
  local console_tenant="${FLOW_AGENTS_CONSOLE_TENANT:-${CONSOLE_TENANT_ID:-}}"
  local no_economics_relay=0
  telemetry_sinks=()
  if [[ -n "${FLOW_AGENTS_TELEMETRY_SINKS:-}" ]]; then
    append_sinks "$FLOW_AGENTS_TELEMETRY_SINKS"
  elif [[ -n "${FLOW_AGENTS_TELEMETRY_SINK:-}" ]]; then
    append_sinks "$FLOW_AGENTS_TELEMETRY_SINK"
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --telemetry-sink|--telemetry-sinks)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        append_sinks "$2"
        shift 2
        ;;
      --console-url)
        [[ $# -ge 2 ]] || die "--console-url requires a value"
        console_url="$2"
        shift 2
        ;;
      --console-endpoint|--console-endpoint-url)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        console_endpoint="$2"
        shift 2
        ;;
      --console-token-file)
        [[ $# -ge 2 ]] || die "--console-token-file requires a value"
        console_token_file="$2"
        shift 2
        ;;
      --console-tenant|--console-tenant-id)
        [[ $# -ge 2 ]] || die "$1 requires a value"
        console_tenant="$2"
        shift 2
        ;;
      --no-economics-relay)
        no_economics_relay=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "unknown option: $1"
        ;;
    esac
  done

  if [[ -n "$console_token_file" ]]; then
    console_token="$(read_token_file "$console_token_file")"
  fi

  if [[ "${#telemetry_sinks[@]}" -eq 0 ]]; then
    telemetry_sinks=("local-files")
  fi
  local sink
  local console_sink_count=0
  for sink in "${telemetry_sinks[@]}"; do
    case "$sink" in
      local-files)
        ;;
      local-kontour-console)
        console_sink_count=$((console_sink_count + 1))
        console_url="${console_url:-$(flow_agents_local_kontour_console_url)}"
        ;;
      kontour-hosted-console|kontour-cloud)
        console_sink_count=$((console_sink_count + 1))
        console_url="${console_url:-$(flow_agents_kontour_hosted_console_url)}"
        ;;
      user-hosted-console|hosted-kontour-console)
        console_sink_count=$((console_sink_count + 1))
        [[ -n "$console_url" || -n "$console_endpoint" ]] || die "user-hosted-console requires --console-url or --console-endpoint"
        ;;
      *)
        die "unknown telemetry sink: $sink"
        ;;
    esac
  done
  [[ "$console_sink_count" -le 1 ]] || die "select at most one Console telemetry sink"

  if [[ "$console_sink_count" -gt 0 && -z "$console_tenant" ]]; then
    echo "warning: install-console-config.sh: a Console telemetry sink was selected with no --console-tenant; records will be untenanted" >&2
  fi

  if [[ -z "$console_url" && -z "$console_endpoint" && -z "$console_token" && -z "$console_tenant" \
        && "$no_economics_relay" -eq 0 ]]; then
    return 0
  fi
  if [[ -z "$console_url" && -z "$console_endpoint" && ( -n "$console_token" || -n "$console_tenant" ) ]]; then
    die "--console-token-file and --console-tenant require --console-url or --console-endpoint"
  fi

  validate_url "--console-url" "$console_url"
  validate_url "--console-endpoint" "$console_endpoint"
  validate_token "$console_token"
  validate_tenant "$console_tenant"

  mkdir -p "$(dirname "$conf")"
  [[ -f "$conf" ]] || : >"$conf"
  set_config_key "$conf" "console_telemetry_url" "$console_url"
  set_config_key "$conf" "console_telemetry_endpoint_url" "$console_endpoint"
  set_config_key "$conf" "console_telemetry_token" "$console_token"
  set_config_key "$conf" "console_tenant_id" "$console_tenant"
  if [[ "$no_economics_relay" -eq 1 ]]; then
    set_config_key "$conf" "console_economics_relay" "0"
  fi
  if [[ -n "$console_token" ]]; then
    chmod 600 "$conf" 2>/dev/null || true
  fi

  local target="${console_endpoint:-$console_url}"
  if [[ -n "$target" ]]; then
    if [[ -n "$console_tenant" ]]; then
      echo "Configured Console telemetry in $conf for $target (tenant: $console_tenant)"
    else
      echo "Configured Console telemetry in $conf for $target"
    fi
  else
    echo "Recorded economics-relay opt-out in $conf"
  fi
}

main "$@"
