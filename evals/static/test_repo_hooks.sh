#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

pass() {
  echo "PASS: $1"
}

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_file() {
  [[ -f "$1" ]] || fail "$1 is missing"
  pass "$1 exists"
}

require_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  grep -Fq -- "$pattern" "$file" || fail "$label"
  pass "$label"
}

require_not_contains() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if grep -Fq -- "$pattern" "$file"; then
    fail "$label"
  fi
  pass "$label"
}

require_file ".githooks/pre-push"
[[ -x ".githooks/pre-push" ]] || fail ".githooks/pre-push is not executable"
pass ".githooks/pre-push is executable"

git ls-files --error-unmatch ".githooks/pre-push" >/dev/null 2>&1 || fail ".githooks/pre-push is not tracked"
pass ".githooks/pre-push is tracked"

mode="$(git ls-files --stage ".githooks/pre-push" | awk '{print $1}')"
[[ "$mode" == "100755" ]] || fail ".githooks/pre-push index mode is $mode, expected 100755"
pass ".githooks/pre-push is tracked with executable mode"

require_contains ".githooks/pre-push" "npm run validate:repo-hooks --silent" "pre-push runs repo hook drift check"
require_contains ".githooks/pre-push" "npm run validate:source --silent" "pre-push runs source validation"
require_not_contains ".githooks/pre-push" "--global" "pre-push does not use global Git config"

require_file "scripts/setup-repo-hooks.sh"
require_contains "scripts/setup-repo-hooks.sh" "git config --local core.hooksPath .githooks" "setup uses repo-local hooksPath"
require_not_contains "scripts/setup-repo-hooks.sh" "--global" "setup does not use global Git config"

require_contains "package.json" "\"setup:repo-hooks\": \"bash scripts/setup-repo-hooks.sh\"" "package exposes repo hook setup command"
require_contains "package.json" "\"validate:repo-hooks\": \"bash evals/static/test_repo_hooks.sh\"" "package exposes repo hook drift check"

require_file "docs/developer-hook-setup.md"
require_contains "docs/developer-hook-setup.md" ".githooks/pre-push" "docs mention repo pre-push hook"
require_contains "docs/developer-hook-setup.md" "git config --local core.hooksPath .githooks" "docs use local hooksPath setup"
require_contains "docs/developer-hook-setup.md" "scripts/hooks/" "docs distinguish runtime hooks path"
require_contains "docs/developer-hook-setup.md" "Runtime hooks" "docs distinguish runtime hooks"
require_not_contains "docs/developer-hook-setup.md" "git config --global core.hooksPath" "docs avoid global hooksPath setup"

echo "Repo Git hook drift checks passed."
