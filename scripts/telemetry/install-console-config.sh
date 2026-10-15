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

When CONF is the telemetry.conf beside this script (the installed one) and
--telemetry-sink names only local-files, with no Console URL, endpoint, token
or tenant, the script records telemetry_sink_pin=local-files there. A pinned
install ignores the operator Console configs
(<workspace>/.kontourai/telemetry-console.conf and the user-global
telemetry-console.conf in .flow-agents under the home directory); an explicit
TELEMETRY_CONFIG_FILE still wins. Selecting a Console sink later removes the pin. A sink taken only from
FLOW_AGENTS_TELEMETRY_SINK(S) never pins.
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

# Remove every pin line, using the readers' grammar exactly: the line
# `telemetry_sink_pin=local-files`, optionally followed by a CR, and nothing else.
remove_local_only_pin() {
  local conf="$1"
  [[ -f "$conf" ]] || return 0
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/flow-agents-telemetry-conf.XXXXXX")"
  awk '$0 != "telemetry_sink_pin=local-files" && $0 != "telemetry_sink_pin=local-files\r" { print }' "$conf" >"$tmp"
  if cmp -s "$tmp" "$conf"; then rm -f "$tmp"; else mv "$tmp" "$conf"; fi
}

# True when CONF is the telemetry.conf beside this script, the one lib/config.sh reads as the
# installed default. The local-only pin means something only there; written into an operator
# conf it would be inert, so it is never written anywhere else.
is_installed_conf() {
  local conf="$1" conf_dir
  conf_dir="$(cd "$(dirname "$conf")" 2>/dev/null && pwd -P)" || return 1
  [[ "$(basename "$conf")" == "telemetry.conf" && "$conf_dir" == "$(cd "$SCRIPT_DIR" && pwd -P)" ]]
}

# Spelled with ${HOME:-}, not as a home-relative literal: the bundle build rewrites those.
# True when this script runs from the Flow Agents package itself (a source checkout, or the
# installed npm package whose scripts/ the `--global` claude-code and opencode hooks run from):
# its root package.json is named @kontourai/flow-agents. Its telemetry.conf is shared by every
# such install (and tracked, in a checkout), so it is never pinned. Without node the name cannot
# be read and the check passes.
is_flow_agents_package() {
  local package_json="$SCRIPT_DIR/../../package.json"
  [[ -f "$package_json" ]] || return 1
  command -v node >/dev/null 2>&1 || return 1
  node -e 'try { process.exit(require(process.argv[1]).name === "@kontourai/flow-agents" ? 0 : 1) } catch { process.exit(1) }' "$package_json"
}

user_global_console_conf() {
  printf '%s/.flow-agents/telemetry-console.conf' "${HOME:-}"
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
  # Set only by a --telemetry-sink argument: the local-only pin records an explicit choice,
  # never a sink inherited from FLOW_AGENTS_TELEMETRY_SINK(S) or the local-files default.
  local sink_flag_given=0
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
        sink_flag_given=1
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

  local has_console_values=0
  if [[ -n "$console_url" || -n "$console_endpoint" || -n "$console_token" || -n "$console_tenant" ]]; then
    has_console_values=1
  fi
  if [[ "$sink_flag_given" -eq 1 && "$console_sink_count" -eq 0 && "$has_console_values" -eq 0 ]] \
      && is_installed_conf "$conf"; then
    if is_flow_agents_package; then
      echo "install-console-config.sh: not pinning $conf local-only: it belongs to the Flow Agents package itself, not to one install" >&2
    else
      set_config_key "$conf" "telemetry_sink_pin" "local-files"
      echo "Pinned telemetry to local files in $conf: operator Console configs (.kontourai/telemetry-console.conf, $(user_global_console_conf)) are ignored for this install"
    fi
  fi

  if [[ "$has_console_values" -eq 0 && "$no_economics_relay" -eq 0 ]]; then
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
  # A Console selection is the latest stated intent, so it lifts an earlier local-only pin.
  [[ "$has_console_values" -eq 1 ]] && remove_local_only_pin "$conf"
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
