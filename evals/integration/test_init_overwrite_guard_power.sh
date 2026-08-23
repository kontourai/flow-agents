#!/usr/bin/env bash
# test_init_overwrite_guard_power.sh — fault-injection power proof for the #1288
# overwrite guard. Re-derivable evidence that the regression tests in
# src/cli/init-overwrite-guard.test.mjs actually catch the historical failures:
# each injection re-creates a pre-fix behavior at its enforcement point, proves the
# named regression test goes RED with the expected assertion, restores, and proves
# it goes GREEN again.
#
#   A) init.ts stops passing BOTH guard layers to install.sh (--only-absent and the
#      preserved excludes) — the original silent-overwrite: rsync clobbers the user
#      README. (Dropping only one layer is absorbed by the other BY DESIGN — the
#      rsync leg is guarded redundantly — so a single-layer injection staying green
#      is expected redundancy, not test power; this suite injects the full seam.)
#   B) the install.sh generator drops BOTH the ${EXCLUDE_ARGS[@]+...} and the
#      ${IGNORE_EXISTING_ARGS[@]+...} expansions from the rsync line while still
#      PARSING the options (review MEDIUM-1's scenario).
#   C) the generator re-adds the pre-fix `rsync --delete` (review BLOCKING-1):
#      unclassified destination files are deleted.
#   D) executePlanCopies copies "preserve" entries too — the --global claude-code
#      sync overwriting a user-authored agents file (review BLOCKING-2).
#   E) SINGLE-LAYER: init drops only --only-absent from the installer argv. The
#      e2e tests stay green (excludes still hold — redundancy by design); the
#      argv-level unit test for that layer must go red (round-4 FIX-5).
#   F) SINGLE-LAYER: init drops only the --exclude-path args. The e2e tests stay
#      green (--only-absent still holds); the argv-level unit test for the
#      exclude layer must go red (round-4 FIX-5).
#
# An injection that does NOT redden its SPECIFIC test (matched by test name in the
# failing-tests section, not by exit code alone) is a hard failure of this eval
# (the test lacks power), not a pass.
#
# ISOLATION: all mutation happens in a throwaway detached git worktree of the
# repository's current HEAD (its own checkout, its own dist/); the shared tree is
# never checked out, built over, or rm -rf'd. node_modules is shared read-only via
# symlink. Run from anywhere:
#   bash evals/integration/test_init_overwrite_guard_power.sh
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ -n "$(git -C "$ROOT_DIR" status --short -- src/cli/init.ts src/tools/build-universal-bundles.ts src/cli/install-plan.ts src/cli/init-overwrite-guard.test.mjs)" ]]; then
  echo "NOTE: the shared tree has uncommitted changes to guard sources; this eval tests HEAD, not the working tree." >&2
fi

WT="$(mktemp -d "${TMPDIR:-/tmp}/init-guard-power.XXXXXX")/wt"
if ! git -C "$ROOT_DIR" worktree add --detach "$WT" HEAD >/dev/null 2>&1; then
  echo "FAIL: could not create isolated worktree at $WT" >&2
  exit 1
fi
ln -s "$ROOT_DIR/node_modules" "$WT/node_modules"

pass=0
fail=0
_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

cleanup() {
  rm -f "$WT/node_modules" 2>/dev/null || true
  git -C "$ROOT_DIR" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
  rm -rf "$(dirname "$WT")"
  git -C "$ROOT_DIR" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

INJECTED_FILES=(src/cli/init.ts src/tools/build-universal-bundles.ts src/cli/install-plan.ts)

restore_all() {
  git -C "$WT" checkout -- "${INJECTED_FILES[@]}" 2>/dev/null || true
}

# require_clean — every injection starts from a pristine worktree state.
require_clean() {
  if [[ -n "$(git -C "$WT" status --short -- "${INJECTED_FILES[@]}")" ]]; then
    echo "FAIL: worktree not clean before injection $1; aborting" >&2
    exit 1
  fi
}

# apply_patch <file> <needle> <replacement> — exact-string replace, exactly one occurrence.
apply_patch() {
  node - "$WT/$1" "$2" "$3" <<'NODE'
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

build() { (cd "$WT" && npm run build --silent) >/dev/null 2>&1; }

# run_guard_test <name-pattern>; captures output, returns node --test's exit code.
run_guard_test() {
  (cd "$WT" && node --test --test-name-pattern "$1" src/cli/init-overwrite-guard.test.mjs) >/tmp/guard-power-run.log 2>&1
}

# expect_red <label> <name-pattern> <assertion-signature>
# RED means: non-zero exit AND the failing-tests section names THIS test AND the log carries
# the expected assertion signature — an unrelated process failure does not count.
expect_red() {
  if run_guard_test "$2"; then
    _fail "$1: injection was NOT caught (test stayed green — insufficient test power)"
    return
  fi
  if ! grep -q "✖ .*$2" /tmp/guard-power-run.log; then
    _fail "$1: run failed but not on the expected test '$2' (unrelated failure?)"
    sed -n '1,40p' /tmp/guard-power-run.log >&2
    return
  fi
  if ! grep -q "$3" /tmp/guard-power-run.log; then
    _fail "$1: expected assertion signature '$3' not found in the red output"
    sed -n '1,40p' /tmp/guard-power-run.log >&2
    return
  fi
  _pass "$1: injection caught (test '$2' red with expected assertion)"
}

# expect_green <label> <name-pattern>
expect_green() {
  if run_guard_test "$2" && grep -q "✔ .*$2" /tmp/guard-power-run.log; then
    _pass "$1: restored tree is green"
  else
    _fail "$1: restored tree not green on '$2'"
    sed -n '1,60p' /tmp/guard-power-run.log >&2
  fi
}

echo "=== #1288 overwrite-guard fault-injection power (isolated worktree: $WT) ==="

README_TEST="preserves a user-authored README.md byte-identical"
KIRO_TEST="never deletes unclassified destination files"
GLOBAL_TEST="global claude-code sync preserves"

echo "--- A: init.ts drops both guard layers (original silent overwrite) ---"
require_clean A
apply_patch src/cli/init.ts \
  "const installed = installBundle(bundle, options, plan.preserved);" \
  "const installed = installBundle(bundle, options, []);" || exit 1
apply_patch src/cli/init.ts \
  'args.push("--only-absent");' \
  '' || exit 1
build || { _fail "A: build failed under injection"; exit 1; }
expect_red "A" "$README_TEST" "# Base Bundle"
restore_all
build || { _fail "A: rebuild after restore failed"; exit 1; }
expect_green "A" "$README_TEST"

echo "--- B: generator drops both rsync guard expansions (parses the options, ignores them) ---"
require_clean B
apply_patch src/tools/build-universal-bundles.ts \
  '\${EXCLUDE_ARGS[@]+"\${EXCLUDE_ARGS[@]}"} ' \
  '' || exit 1
apply_patch src/tools/build-universal-bundles.ts \
  '\${IGNORE_EXISTING_ARGS[@]+"\${IGNORE_EXISTING_ARGS[@]}"} ' \
  '' || exit 1
build || { _fail "B: build failed under injection"; exit 1; }
rm -rf "$WT/dist"
expect_red "B" "$README_TEST" "# Base Bundle"
restore_all
build || { _fail "B: rebuild after restore failed"; exit 1; }
rm -rf "$WT/dist"
expect_green "B" "$README_TEST"

echo "--- C: generator re-adds the pre-fix rsync --delete ---"
require_clean C
apply_patch src/tools/build-universal-bundles.ts \
  'rsync -a --exclude=' \
  'rsync -a --delete --exclude=' || exit 1
build || { _fail "C: build failed under injection"; exit 1; }
rm -rf "$WT/dist"
expect_red "C" "$KIRO_TEST" "ENOENT"
restore_all
build || { _fail "C: rebuild after restore failed"; exit 1; }
rm -rf "$WT/dist"
expect_green "C" "$KIRO_TEST"

echo "--- D: executePlanCopies copies preserved entries too (global sync overwrite) ---"
require_clean D
apply_patch src/cli/install-plan.ts \
  'if (!actions.has(entry.action)) continue;' \
  'if (!actions.has(entry.action) && entry.action !== "preserve") continue; if (entry.action === "preserve") { fs.mkdirSync(path.dirname(entry.destPath), { recursive: true }); fs.copyFileSync(entry.sourcePath, entry.destPath); continue; }' || exit 1
build || { _fail "D: build failed under injection"; exit 1; }
expect_red "D" "$GLOBAL_TEST" "AssertionError"
restore_all
build || { _fail "D: rebuild after restore failed"; exit 1; }
expect_green "D" "$GLOBAL_TEST"

ONLY_ABSENT_TEST="installBundleArgs always carries --only-absent"
EXCLUDE_ARGS_TEST="installBundleArgs passes each preserved path as --exclude-path"

echo "--- E: single-layer — init drops only --only-absent (argv unit test must catch it) ---"
require_clean E
apply_patch src/cli/init.ts \
  'args.push("--only-absent");' \
  '' || exit 1
build || { _fail "E: build failed under injection"; exit 1; }
expect_red "E" "$ONLY_ABSENT_TEST" "AssertionError"
restore_all
build || { _fail "E: rebuild after restore failed"; exit 1; }
expect_green "E" "$ONLY_ABSENT_TEST"

echo "--- F: single-layer — init drops only the --exclude-path args (argv unit test must catch it) ---"
require_clean F
apply_patch src/cli/init.ts \
  'for (const rel of preservedRelPaths) args.push("--exclude-path", rel);' \
  'void preservedRelPaths;' || exit 1
build || { _fail "F: build failed under injection"; exit 1; }
expect_red "F" "$EXCLUDE_ARGS_TEST" "AssertionError"
restore_all
build || { _fail "F: rebuild after restore failed"; exit 1; }
expect_green "F" "$EXCLUDE_ARGS_TEST"

echo ""
echo "==========================="
echo "Results: ${pass} passed, ${fail} failed"
[[ "$fail" -eq 0 ]] || exit 1
