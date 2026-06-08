#!/usr/bin/env bash
# install-codex-home.sh - Install Flow Agents as an isolated Codex home.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$HOME/.flow-agents/codex}"
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

echo "Installed isolated Flow Agents Codex home at $DEST"
echo "Use: CODEX_HOME=$DEST codex --profile kdev"
