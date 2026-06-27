#!/usr/bin/env bash
# install-codex-home.sh - Install Flow Agents as an isolated Codex home.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
usage() {
  cat >&2 <<'EOF'
usage: install-codex-home.sh [destination] [options]

Options:
  --telemetry-sink NAME   local-files, local-kontour-console,
                          kontour-hosted-console, user-hosted-console,
                          or legacy aliases. May be repeated.
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

# Stash the user's existing hooks.json (if any) BEFORE cleaning, so the merge
# step below can preserve user hooks across re-installs.
FA_USER_HOOKS_STASH=""
if [[ -f "$DEST/hooks.json" ]]; then
  FA_USER_HOOKS_STASH="$(mktemp /tmp/fa-user-hooks.XXXXXX.json)"
  cp "$DEST/hooks.json" "$FA_USER_HOOKS_STASH"
fi

# This is an isolated generated Codex home. Clean generated bundle content before
# overlaying so renamed/deleted source files do not survive across installs.
rm -rf \
  "$DEST/.flow-agents" \
  "$DEST/.codex" \
  "$DEST/AGENTS.md" \
  "$DEST/README.md" \
  "$DEST/console.telemetry.json" \
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

# Merge FA hooks into the flattened hooks.json, preserving any user hooks already present.
# The managed-hooks source is the bundle's .codex/hooks.json (pre-flatten, always present in dist/codex/).
# The rsync above wrote the FA hooks.json directly to $DEST/hooks.json.
# If the user had a hooks.json before this install, use the stash as the "existing" config so
# user-owned hook groups survive. Otherwise, $DEST/hooks.json is already correct (FA only).
FA_VERSION="$(node -p "require('$ROOT_DIR/package.json').version" 2>/dev/null || echo unknown)"
FA_MANAGED_HOOKS="$ROOT_DIR/dist/codex/.codex/hooks.json"
if command -v node >/dev/null 2>&1 && [[ -f "$FA_MANAGED_HOOKS" ]]; then
  if [[ -n "$FA_USER_HOOKS_STASH" && -f "$FA_USER_HOOKS_STASH" ]]; then
    # Merge user's prior hooks (stash) with the current FA managed hooks.
    node "$ROOT_DIR/scripts/install-merge.js" \
      --config "$FA_USER_HOOKS_STASH" \
      --managed-hooks "$FA_MANAGED_HOOKS" \
      --version "$FA_VERSION" \
      --install-record "$DEST/.flow-agents/install.json" \
      --runtime "codex" || true
    # Move the merged result into the destination.
    cp "$FA_USER_HOOKS_STASH" "$DEST/hooks.json"
    rm -f "$FA_USER_HOOKS_STASH"
  else
    # No prior user hooks: just write the version stamp (FA hooks are already correct from rsync).
    node "$ROOT_DIR/scripts/install-merge.js" \
      --config "$DEST/hooks.json" \
      --managed-hooks "$FA_MANAGED_HOOKS" \
      --version "$FA_VERSION" \
      --install-record "$DEST/.flow-agents/install.json" \
      --runtime "codex" || true
  fi
fi

if [[ ${#CONSOLE_CONFIG_ARGS[@]} -gt 0 || -n "${FLOW_AGENTS_TELEMETRY_SINK:-}" || -n "${FLOW_AGENTS_TELEMETRY_SINKS:-}" || -n "${FLOW_AGENTS_CONSOLE_URL:-}" || -n "${CONSOLE_TELEMETRY_URL:-}" || -n "${CONSOLE_URL:-}" || -n "${FLOW_AGENTS_CONSOLE_TOKEN_FILE:-}" || -n "${CONSOLE_TELEMETRY_TOKEN_FILE:-}" ]]; then
  bash "$DEST/scripts/telemetry/install-console-config.sh" "$DEST/scripts/telemetry/telemetry.conf" "${CONSOLE_CONFIG_ARGS[@]}"
fi

echo "Installed isolated Flow Agents Codex home at $DEST"
echo "Use: CODEX_HOME=$DEST codex --profile kdev"
