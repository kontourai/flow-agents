#!/usr/bin/env bash
# test_init_overwrite_guard_power.sh — fault-injection power proof for the #1288
# overwrite guard. Re-derivable evidence that the regression tests in
# src/cli/init-overwrite-guard.test.mjs actually catch the historical failures:
# each injection re-creates a pre-fix behavior at its enforcement point, proves the
# named regression test goes RED, restores, and proves it goes GREEN again.
#
#   A) init.ts stops passing the plan's preserved paths to install.sh
#      (the original silent-overwrite: rsync with no excludes).
#   B) the install.sh generator drops the ${EXCLUDE_ARGS[@]+...} expansion from the
#      rsync line while still PARSING --exclude-path (review MEDIUM-1's scenario).
#   C) the generator re-adds the pre-fix `rsync --delete` (review BLOCKING-1).
#   D) executePlanCopies copies "preserve" entries too — the --global claude-code
#      sync overwriting a user-authored agents file (review BLOCKING-2).
#
# An injection that does NOT redden its test is a hard failure of this eval (the
# test lacks power), not a pass.
#
# Mutates src/ temporarily; requires the three injected files to be clean in git and
# restores them (and rebuilds) on exit. Run from anywhere:
#   bash evals/integration/test_init_overwrite_guard_power.sh
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

INJECTED_FILES=(src/cli/init.ts src/tools/build-universal-bundles.ts src/cli/install-plan.ts)

if [[ -n "$(git status --short -- "${INJECTED_FILES[@]}")" ]]; then
  echo "FAIL: refusing to run fault injection over a dirty tree for: ${INJECTED_FILES[*]}" >&2
  exit 1
fi

pass=0
fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

restore_all() {
  git checkout -- "${INJECTED_FILES[@]}" 2>/dev/null || true
}
cleanup() {
  restore_all
  npm run build --silent >/dev/null 2>&1 || true
  rm -rf dist
}
trap cleanup EXIT

# apply_patch <file> <needle> <replacement> — exact-string replace, exactly one occurrence.
apply_patch() {
  node - "$1" "$2" "$3" <<'NODE'
const fs = require("node:fs");
const [file, needle, replacement] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
const count = text.split(needle).length - 1;
if (count !== 1) {
  console.error(`injection needle matched ${count} times (expected 1) in ${file}: ${needle}`);
  process.exit(1);
}
fs.writeFileSync(file, text.replace(needle, replacement));
NODE
}

build() { npm run build --silent >/dev/null 2>&1; }

# run_guard_test <name-pattern>; returns node --test's exit code.
run_guard_test() {
  node --test --test-name-pattern "$1" src/cli/init-overwrite-guard.test.mjs >/tmp/guard-power-run.log 2>&1
}

# expect_red <label> <name-pattern>
expect_red() {
  if run_guard_test "$2"; then
    _fail "$1: injection was NOT caught (test stayed green — insufficient test power)"
  else
    _pass "$1: injection caught (test went red)"
  fi
}

# expect_green <label> <name-pattern>
expect_green() {
  if run_guard_test "$2"; then
    _pass "$1: restored tree is green"
  else
    _fail "$1: restored tree still red"
    sed -n '1,60p' /tmp/guard-power-run.log >&2
  fi
}

echo "=== #1288 overwrite-guard fault-injection power ==="

README_TEST="preserves a user-authored README.md byte-identical"
KIRO_TEST="never deletes unclassified destination files"
GLOBAL_TEST="global claude-code sync preserves"

echo "--- A: init.ts drops the preserved excludes (original silent overwrite) ---"
apply_patch src/cli/init.ts \
  "const installed = installBundle(bundle, options, plan.preserved);" \
  "const installed = installBundle(bundle, options, []);" || exit 1
build || { _fail "A: build failed under injection"; exit 1; }
expect_red "A" "$README_TEST"
restore_all
build || { _fail "A: rebuild after restore failed"; exit 1; }
expect_green "A" "$README_TEST"

echo "--- B: generator drops the rsync exclude expansion (parses --exclude-path, ignores it) ---"
apply_patch src/tools/build-universal-bundles.ts \
  '\${EXCLUDE_ARGS[@]+"\${EXCLUDE_ARGS[@]}"} "$SRC"/' \
  '"$SRC"/' || exit 1
build || { _fail "B: build failed under injection"; exit 1; }
rm -rf dist
expect_red "B" "$README_TEST"
restore_all
build || { _fail "B: rebuild after restore failed"; exit 1; }
rm -rf dist
expect_green "B" "$README_TEST"

echo "--- C: generator re-adds the pre-fix rsync --delete ---"
apply_patch src/tools/build-universal-bundles.ts \
  'rsync -a --exclude=' \
  'rsync -a --delete --exclude=' || exit 1
build || { _fail "C: build failed under injection"; exit 1; }
rm -rf dist
expect_red "C" "$KIRO_TEST"
restore_all
build || { _fail "C: rebuild after restore failed"; exit 1; }
rm -rf dist
expect_green "C" "$KIRO_TEST"

echo "--- D: executePlanCopies copies preserved entries too (global sync overwrite) ---"
apply_patch src/cli/install-plan.ts \
  'if (entry.action !== "create" && entry.action !== "replace" && entry.action !== "force-overwrite") continue;' \
  'if (entry.action === "unchanged") continue;' || exit 1
build || { _fail "D: build failed under injection"; exit 1; }
expect_red "D" "$GLOBAL_TEST"
restore_all
build || { _fail "D: rebuild after restore failed"; exit 1; }
expect_green "D" "$GLOBAL_TEST"

echo ""
echo "==========================="
echo "Results: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]] || exit 1
