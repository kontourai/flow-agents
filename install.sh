#!/usr/bin/env bash
set -euo pipefail

DEST="${1:?usage: bash install.sh /path/to/workspace}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$DEST"
rsync -a "$SRC"/ "$DEST"/
if [[ -n "${FLOW_AGENTS_PACKS:-}" ]]; then
  FILTER_SCRIPT="$DEST/scripts/filter-installed-packs.mjs"
  if [[ ! -f "$FILTER_SCRIPT" ]]; then
    FILTER_SCRIPT="$DEST/scripts/filter-installed-packs.js"
  fi
  node "$FILTER_SCRIPT" "$DEST" --packs "$FLOW_AGENTS_PACKS"
fi
echo "Installed Claude Code bundle into $DEST"
