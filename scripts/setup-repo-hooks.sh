#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel)"
cd "$ROOT_DIR"

git config --local core.hooksPath .githooks
echo "Configured repo-local Git hooks: core.hooksPath=.githooks"
