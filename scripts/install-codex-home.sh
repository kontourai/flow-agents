#!/usr/bin/env bash
# install-codex-home.sh - Install Flow Agents as an isolated Codex home.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
usage() {
  cat >&2 <<'EOF'
usage: install-codex-home.sh [destination] [options]

Options:
  --telemetry-sink NAME   local-files, local-kontour-console, kontour-cloud,
                          or hosted-kontour-console. May be repeated.
  --console-url URL       Persist Console telemetry base URL.
  --console-endpoint URL  Persist full Console telemetry records endpoint URL.
  --console-token-file PATH
                          Read Console telemetry bearer token from a file.
  --console-tenant ID     Persist Console tenant identifier.
EOF
}

DEST="$HOME/.flow-agents/codex"
DEST_SET=0
CONSOLE_CONFIG_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --telemetry-sink|--telemetry-sinks|--console-url|--console-endpoint|--console-endpoint-url|--console-token-file|--console-tenant|--console-tenant-id)
      [[ $# -ge 2 ]] || { echo "install-codex-home.sh: $1 requires a value" >&2; exit 2; }
      CONSOLE_CONFIG_ARGS+=("$1" "$2")
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      echo "install-codex-home.sh: unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ "$DEST_SET" -eq 1 ]]; then
        echo "install-codex-home.sh: unexpected argument: $1" >&2
        usage
        exit 2
      fi
      DEST="$1"
      DEST_SET=1
      shift
      ;;
  esac
done
REAL_CODEX_HOME="${CODEX_REAL_HOME:-$HOME/.codex}"
if command -v npm >/dev/null 2>&1; then
  (cd "$ROOT_DIR" && FLOW_AGENTS_EXPORT_DIAGNOSTICS=0 npm run build:bundles --silent >/dev/null)
else
  echo "install-codex-home.sh: requires npm on PATH" >&2
  exit 1
fi

mkdir -p "$DEST"

# This is an isolated generated Codex home. Clean generated bundle content before
# overlaying so renamed/deleted source files do not survive across installs.
rm -rf \
  "$DEST/.agents" \
  "$DEST/.codex" \
  "$DEST/AGENTS.md" \
  "$DEST/README.md" \
  "$DEST/install.sh" \
  "$DEST/config.toml" \
  "$DEST/hooks.json" \
  "$DEST/agent-cards" \
  "$DEST/agents" \
  "$DEST/context" \
  "$DEST/docs" \
  "$DEST/evals" \
  "$DEST/integrations" \
  "$DEST/kits" \
  "$DEST/packaging" \
  "$DEST/powers" \
  "$DEST/prompts" \
  "$DEST/schemas" \
  "$DEST/scripts" \
  "$DEST/skills"
find "$DEST" -maxdepth 1 -type f -name 'k*.config.toml' -delete

rsync -a "$ROOT_DIR/dist/codex/." "$DEST/"
rsync -a "$ROOT_DIR/dist/codex/.codex/." "$DEST/"
rm -rf "$DEST/.codex" 2>/dev/null || true

for auth_file in auth.json version.json installation_id models_cache.json; do
  if [[ -f "$REAL_CODEX_HOME/$auth_file" ]]; then
    cp "$REAL_CODEX_HOME/$auth_file" "$DEST/$auth_file"
  fi
done

chmod 700 "$DEST" 2>/dev/null || true
[[ -f "$DEST/auth.json" ]] && chmod 600 "$DEST/auth.json" 2>/dev/null || true
if [[ ${#CONSOLE_CONFIG_ARGS[@]} -gt 0 || -n "${FLOW_AGENTS_TELEMETRY_SINK:-}" || -n "${FLOW_AGENTS_TELEMETRY_SINKS:-}" || -n "${FLOW_AGENTS_CONSOLE_URL:-}" || -n "${CONSOLE_TELEMETRY_URL:-}" || -n "${CONSOLE_URL:-}" || -n "${FLOW_AGENTS_CONSOLE_TOKEN_FILE:-}" || -n "${CONSOLE_TELEMETRY_TOKEN_FILE:-}" ]]; then
  bash "$DEST/scripts/telemetry/install-console-config.sh" "$DEST/scripts/telemetry/telemetry.conf" "${CONSOLE_CONFIG_ARGS[@]}"
fi

echo "Installed isolated Flow Agents Codex home at $DEST"
echo "Use: CODEX_HOME=$DEST codex --profile kdev"
