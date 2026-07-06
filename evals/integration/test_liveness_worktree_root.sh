#!/usr/bin/env bash
# test_liveness_worktree_root.sh -- integration eval for #357: the shared, git-common-dir-aware
# artifact-root resolver (flowAgentsArtifactRoot / defaultArtifactRootForRead, under
# src/lib/ in the main tree, and the CJS hook twin under scripts/hooks/lib/ -- see
# local-artifact-root.ts and local-artifact-paths.js).
#
# Uses a REAL `git worktree add` linked worktree (not a simulated divergent path -- the plan's
# own stop-short-risk note explicitly requires this, since `git rev-parse --git-common-dir`
# behaves identically to `--absolute-git-dir` outside a real linked worktree, so a simulated
# two-unrelated-repos setup would never actually exercise the git-common-dir resolution code
# path at all).
#
# Covers:
#   AC3 liveness-claim-from-worktree-shared-store: `liveness claim` invoked with cwd inside the
#     linked worktree (no --artifact-root) writes into the SAME liveness stream a
#     `liveness status` invocation from the PRIMARY checkout sees.
#   AC4 ensure-session-ownership-guard-shared-store: a claim held (via ensure-session) in the
#     PRIMARY checkout is recognized by `ensure-session`'s ownership guard when invoked for the
#     SAME subject from the linked worktree's cwd -- the guard must refuse (see the existing hold),
#     never silently proceed as if the subject were free.
#   AC5 current-pointer-shared-store-from-worktree: `ensure-session`'s current.json write (from
#     the worktree cwd, no --artifact-root) is visible to `workflow-sidecar current` invoked from
#     the PRIMARY checkout cwd (both resolve the SAME shared .kontourai/flow-agents root).
#   AC6 single-checkout-backward-compat (this eval's own contribution): byte-identical to
#     before this change ONLY for the two cases where the pre-#357 code and the new
#     git-common-dir resolver necessarily agree: (a) cwd is the repo ROOT of a plain
#     (non-worktree) checkout, and (b) cwd is not inside a git repo at all (fail-open). Both are
#     asserted below with a companion case proving byte-identical path.resolve(cwd,
#     ".kontourai/flow-agents") output.
#   AC6b subdirectory-resolves-to-shared-repo-root (#413 iteration-2 Fix 2, INTENDED CHANGE, not
#     byte-identical): when cwd is a SUBDIRECTORY of a plain (non-worktree) checkout, the OLD
#     code anchored the store to that subdir (path.resolve(cwd, ...)), but `git rev-parse
#     --git-common-dir` from a subdirectory returns a RELATIVE path this resolver walks up to the
#     repo root, so flowAgentsArtifactRoot now correctly resolves to
#     <repo-root>/.kontourai/flow-agents regardless of which subdirectory cwd is -- ONE shared
#     store per repo, matching every other cwd (primary checkout, linked worktree) this resolver
#     already unifies. This is intentional, correct shared-store behavior, NOT a regression to
#     revert -- asserted explicitly below so it stays a documented, tested behavior change
#     rather than an unverified side effect of the git-common-dir walk.
#
# Deterministic, no model spend, self-cleaning (mktemp -d + trap EXIT). The worktree fixture is
# entirely disposable, created and torn down inside this eval's own scratch directory -- it never
# touches this session's real worktree (see the plan's Sandbox mode note).
#
# Usage: bash evals/integration/test_liveness_worktree_root.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

WRITER="workflow-sidecar"
TMP="$(mktemp -d)"
errors=0

_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

if ! command -v git >/dev/null 2>&1; then
  echo "git is not installed -- cannot exercise a real 'git worktree add' fixture." >&2
  echo "ACCEPTED GAP: this eval requires git; recording as an explicit, non-silent skip (not a pass)." >&2
  exit 1
fi

flow_agents_build_ts || { echo "build failed" >&2; exit 1; }

# ==== SETUP: a real primary checkout + a real linked worktree ======================
echo ""
echo "=== SETUP: primary checkout + real 'git worktree add' linked worktree ==="

PRIMARY="$TMP/primary"
mkdir -p "$PRIMARY/kits"
(
  cd "$PRIMARY" \
    && git init -q \
    && git config user.email "test@test.local" \
    && git config user.name "test" \
    && printf '# marker\n' > kits/.keep \
    && git add -A \
    && git commit -q -m "init"
)
if [[ -d "$PRIMARY/.git" ]]; then
  _pass "SETUP: primary checkout is a real git repo with a kits/ marker"
else
  _fail "SETUP: primary checkout git init failed"
fi

WORKTREE="$TMP/linked-worktree"
if (cd "$PRIMARY" && git worktree add -q -b worktree-branch "$WORKTREE" >/dev/null 2>"$TMP/worktree-add.err"); then
  _pass "SETUP: 'git worktree add' created a genuine linked worktree"
else
  _fail "SETUP: 'git worktree add' failed: $(cat "$TMP/worktree-add.err")"
fi

# A linked worktree's OWN .git is a FILE (a gitdir: pointer), never a directory -- this is the
# exact condition the pre-fix cwd/`.git`-ancestor-walk resolvers could not see past.
if [[ -f "$WORKTREE/.git" && ! -d "$WORKTREE/.git" ]]; then
  _pass "SETUP: linked worktree's own .git is a FILE, not a directory (the condition this fix targets)"
else
  _fail "SETUP: linked worktree's .git was not the expected gitdir-pointer FILE"
fi

# Confirm the git primitive itself resolves the worktree to the PRIMARY checkout's real .git dir
# -- this is the exact resolution flowAgentsArtifactRoot()/defaultArtifactRootForRead() now use.
COMMON_DIR="$(cd "$WORKTREE" && git rev-parse --git-common-dir 2>/dev/null)"
if [[ -n "$COMMON_DIR" ]]; then
  ABS_COMMON_DIR="$(cd "$WORKTREE" && node -e 'console.log(require("path").resolve(process.argv[1], process.argv[2]))' "$WORKTREE" "$COMMON_DIR")"
  RESOLVED_SHARED_ROOT="$(dirname "$ABS_COMMON_DIR")"
  REAL_PRIMARY="$(cd "$PRIMARY" && pwd -P)"
  REAL_RESOLVED="$(cd "$RESOLVED_SHARED_ROOT" && pwd -P)"
  if [[ "$REAL_RESOLVED" == "$REAL_PRIMARY" ]]; then
    _pass "SETUP: 'git rev-parse --git-common-dir' from the worktree resolves to the PRIMARY checkout's repo root"
  else
    _fail "SETUP: git-common-dir resolution did not land on the primary checkout: got $REAL_RESOLVED, expected $REAL_PRIMARY"
  fi
else
  _fail "SETUP: 'git rev-parse --git-common-dir' failed from the linked worktree"
fi

# ==== AC3: liveness claim from worktree cwd is visible from the primary checkout ====
echo ""
echo "=== AC3: liveness claim (worktree cwd, no --artifact-root) visible from primary checkout ==="

SUBJECT="worktree-liveness-subject"
if (cd "$WORKTREE" && flow_agents_node "$WRITER" liveness claim "$SUBJECT" --actor worktree-actor \
  >"$TMP/claim.out" 2>"$TMP/claim.err"); then
  _pass "AC3: liveness claim from the worktree cwd (no --artifact-root) exits 0"
else
  _fail "AC3: liveness claim from the worktree cwd failed: $(cat "$TMP/claim.out" "$TMP/claim.err")"
fi

# The claim must land in the PRIMARY checkout's .kontourai/flow-agents/liveness store, NOT an
# isolated .kontourai/flow-agents under the worktree's own directory.
if [[ -f "$PRIMARY/.kontourai/flow-agents/liveness/events.jsonl" ]]; then
  _pass "AC3: the claim landed in the PRIMARY checkout's shared .kontourai/flow-agents/liveness store"
else
  _fail "AC3: no liveness/events.jsonl found under the primary checkout's .kontourai/flow-agents"
fi
if [[ ! -e "$WORKTREE/.kontourai/flow-agents/liveness/events.jsonl" ]]; then
  _pass "AC3: no ISOLATED per-worktree .kontourai/flow-agents/liveness store was created under the worktree"
else
  _fail "AC3: an isolated per-worktree liveness store was created -- the shared-root fix did not take effect"
fi

if (cd "$PRIMARY" && flow_agents_node "$WRITER" liveness status --subject "$SUBJECT" --json \
  >"$TMP/status.out" 2>"$TMP/status.err"); then
  _pass "AC3: liveness status from the PRIMARY checkout cwd (no --artifact-root) exits 0"
else
  _fail "AC3: liveness status from the primary checkout failed: $(cat "$TMP/status.out" "$TMP/status.err")"
fi
if grep -qF "worktree-actor" "$TMP/status.out"; then
  _pass "AC3: a reader in the PRIMARY checkout sees the claim made from the linked worktree's cwd"
else
  _fail "AC3: the primary checkout's liveness status did not see the worktree-made claim: $(cat "$TMP/status.out")"
fi

# ==== AC4: ensure-session's ownership guard recognizes a primary-checkout hold from worktree cwd
echo ""
echo "=== AC4: ensure-session ownership guard sees a primary-checkout hold from worktree cwd ==="

GUARD_WORK_ITEM="kontourai/flow-agents#8801"
GUARD_SLUG="kontourai-flow-agents-8801"

if (cd "$PRIMARY" && flow_agents_node "$WRITER" ensure-session \
  --work-item "$GUARD_WORK_ITEM" \
  --actor primary-holder \
  --source-request "Primary-checkout actor claims a free subject." \
  --summary "Establish the hold in the primary checkout." \
  >"$TMP/guard-primary.out" 2>"$TMP/guard-primary.err"); then
  _pass "AC4 setup: ensure-session from the primary checkout establishes a durable claim"
else
  _fail "AC4 setup: ensure-session from the primary checkout failed: $(cat "$TMP/guard-primary.out" "$TMP/guard-primary.err")"
fi

# A fresh liveness claim event for the SAME actor/subject, so the join classifies this `held`
# (self_is_holder / fresh_liveness_heartbeat) rather than merely `reclaimable` -- matches
# test_ensure_session_ownership_guard.sh's own convention of backing the assignment record with
# a real liveness event before asserting a second actor's refusal.
(cd "$PRIMARY" && flow_agents_node "$WRITER" liveness claim "$GUARD_SLUG" --actor primary-holder \
  >"$TMP/guard-liveness-claim.out" 2>"$TMP/guard-liveness-claim.err") || true

if (cd "$WORKTREE" && flow_agents_node "$WRITER" ensure-session \
  --work-item "$GUARD_WORK_ITEM" \
  --actor worktree-other-actor \
  --source-request "A different actor attempts entry from the linked worktree's cwd." \
  --summary "Should be refused -- the primary checkout's hold must be visible here too." \
  >"$TMP/guard-worktree.out" 2>"$TMP/guard-worktree.err"); then
  _fail "AC4: ensure-session from the worktree cwd should have been refused (primary checkout's hold is fresh) but exited 0"
else
  _pass "AC4: ensure-session from the worktree cwd refuses -- it sees the primary checkout's fresh hold (shared store, not isolated)"
fi
if grep -qF "primary-holder" "$TMP/guard-worktree.err"; then
  _pass "AC4: the refusal from the worktree cwd names the primary checkout's holder identity"
else
  _fail "AC4: refusal message did not name the primary checkout's holder identity: $(cat "$TMP/guard-worktree.err")"
fi

# ==== AC5: current.json (per-actor + legacy) written from worktree cwd is visible from primary =
echo ""
echo "=== AC5: current.json written from worktree cwd is visible from the primary checkout ==="

CURRENT_WORK_ITEM="kontourai/flow-agents#8802"
CURRENT_SLUG="kontourai-flow-agents-8802"

if (cd "$WORKTREE" && flow_agents_node "$WRITER" ensure-session \
  --work-item "$CURRENT_WORK_ITEM" \
  --actor worktree-current-actor \
  --source-request "ensure-session from the worktree cwd writes current.json." \
  --summary "Prove current.json lands in the shared store." \
  >"$TMP/current-worktree.out" 2>"$TMP/current-worktree.err"); then
  _pass "AC5 setup: ensure-session from the worktree cwd (no --artifact-root) exits 0"
else
  _fail "AC5 setup: ensure-session from the worktree cwd failed: $(cat "$TMP/current-worktree.out" "$TMP/current-worktree.err")"
fi

if [[ -f "$PRIMARY/.kontourai/flow-agents/current.json" ]]; then
  _pass "AC5: current.json landed under the PRIMARY checkout's shared .kontourai/flow-agents, not an isolated worktree copy"
else
  _fail "AC5: no current.json found under the primary checkout's .kontourai/flow-agents"
fi
if [[ ! -e "$WORKTREE/.kontourai/flow-agents/current.json" ]]; then
  _pass "AC5: no isolated per-worktree current.json was created under the worktree"
else
  _fail "AC5: an isolated per-worktree current.json was created -- the shared-root fix did not take effect"
fi

if (cd "$PRIMARY" && flow_agents_node "$WRITER" current --format slug \
  >"$TMP/current-primary.out" 2>"$TMP/current-primary.err"); then
  if [[ "$(cat "$TMP/current-primary.out")" == "$CURRENT_SLUG" ]]; then
    _pass "AC5: 'current' invoked from the PRIMARY checkout cwd (no --artifact-root) resolves the session ensure-session wrote from the worktree cwd"
  else
    _fail "AC5: primary-checkout 'current' resolved the wrong slug: $(cat "$TMP/current-primary.out"), expected $CURRENT_SLUG"
  fi
else
  _fail "AC5: 'current' from the primary checkout failed: $(cat "$TMP/current-primary.out" "$TMP/current-primary.err")"
fi

# stop-goal-fit.js / workflow-steering.js's own findRepoRoot (updated to prefer
# git-common-dir resolution) must ALSO resolve the primary checkout when invoked with cwd set
# to the LINKED WORKTREE -- proving the hook-side mirrors got the same fix, not just the CLI.
HOOK_ROOT_CHECK="$(node -e '
const { findRepoRoot } = require(process.argv[1]);
console.log(findRepoRoot(process.argv[2]));
' "$ROOT/scripts/hooks/stop-goal-fit.js" "$WORKTREE" 2>/dev/null)"
REAL_PRIMARY2="$(cd "$PRIMARY" && pwd -P)"
if [[ -n "$HOOK_ROOT_CHECK" ]]; then
  REAL_HOOK_ROOT="$(cd "$HOOK_ROOT_CHECK" && pwd -P)"
  if [[ "$REAL_HOOK_ROOT" == "$REAL_PRIMARY2" ]]; then
    _pass "AC5: stop-goal-fit.js's findRepoRoot(worktreeCwd) resolves the shared PRIMARY checkout root, not the worktree's own directory"
  else
    _fail "AC5: stop-goal-fit.js's findRepoRoot(worktreeCwd) did not resolve the primary checkout: got $REAL_HOOK_ROOT, expected $REAL_PRIMARY2"
  fi
else
  _fail "AC5: stop-goal-fit.js's findRepoRoot(worktreeCwd) returned nothing"
fi

HOOK_ROOT_CHECK_STEERING="$(node -e '
const { findRepoRoot } = require(process.argv[1]);
console.log(findRepoRoot(process.argv[2]));
' "$ROOT/scripts/hooks/workflow-steering.js" "$WORKTREE" 2>/dev/null)"
if [[ -n "$HOOK_ROOT_CHECK_STEERING" ]]; then
  REAL_HOOK_ROOT_STEERING="$(cd "$HOOK_ROOT_CHECK_STEERING" && pwd -P)"
  if [[ "$REAL_HOOK_ROOT_STEERING" == "$REAL_PRIMARY2" ]]; then
    _pass "AC5: workflow-steering.js's findRepoRoot(worktreeCwd) resolves the shared PRIMARY checkout root, not the worktree's own directory"
  else
    _fail "AC5: workflow-steering.js's findRepoRoot(worktreeCwd) did not resolve the primary checkout: got $REAL_HOOK_ROOT_STEERING, expected $REAL_PRIMARY2"
  fi
else
  _fail "AC5: workflow-steering.js's findRepoRoot(worktreeCwd) returned nothing"
fi

# ==== FIX 1 (#413 iteration-2, HIGH security): loud, not silent, fail-open inside a broken git
# working tree ==============================================================
# A SECOND, disposable linked worktree, deliberately corrupted (its own .git gitlink pointer
# rewritten to a nonexistent path) AFTER creation, so `git rev-parse --git-common-dir` from
# inside it genuinely FAILS (git resolution attempted, not merely absent) while the directory is
# still, by every other measure, inside a git working tree (a `.git` FILE exists right there).
# This is #357's exact silent-fail-open bug: prior to Fix 1, flowAgentsArtifactRoot/findRepoRoot
# would fall back to a cwd-local store with NO diagnostic at all. Uses its own worktree fixture
# (never $WORKTREE, which later AC sections below still depend on being intact).
echo ""
echo "=== FIX 1: loud WARNING when inside a git working tree but resolution fails (corrupted gitlink) ==="

BROKEN_WORKTREE="$TMP/broken-worktree"
if (cd "$PRIMARY" && git worktree add -q -b broken-worktree-branch "$BROKEN_WORKTREE" >/dev/null 2>"$TMP/broken-worktree-add.err"); then
  _pass "FIX 1 setup: a second, disposable linked worktree was created for the corruption fixture"
else
  _fail "FIX 1 setup: 'git worktree add' for the broken-worktree fixture failed: $(cat "$TMP/broken-worktree-add.err")"
fi

# Corrupt the gitlink: a linked worktree's own .git is normally a FILE containing
# `gitdir: <path-to-real-.git-entry>`. Point it at a nonexistent path so git-common-dir
# resolution genuinely fails from inside this worktree, while a `.git` FILE still exists here
# (the exact condition isInsideGitWorkingTree's discriminator detects).
printf 'gitdir: /nonexistent-gitdir-for-fix1-eval
' > "$BROKEN_WORKTREE/.git"

BROKEN_COMMON_DIR_CHECK="$(cd "$BROKEN_WORKTREE" && git rev-parse --git-common-dir 2>/dev/null)"
if [[ -z "$BROKEN_COMMON_DIR_CHECK" ]]; then
  _pass "FIX 1 setup: 'git rev-parse --git-common-dir' genuinely fails from inside the corrupted worktree"
else
  _fail "FIX 1 setup: corruption did not take effect -- git-common-dir still resolved: $BROKEN_COMMON_DIR_CHECK"
fi

if (cd "$BROKEN_WORKTREE" && flow_agents_node "$WRITER" liveness claim "fix1-corrupted-gitlink-subject" --actor fix1-actor \
  >"$TMP/fix1-claim.out" 2>"$TMP/fix1-claim.err"); then
  _pass "FIX 1: liveness claim from the corrupted worktree still exits 0 (loud warning, not a hard refuse -- this helper sits on read paths too)"
else
  _fail "FIX 1: liveness claim from the corrupted worktree unexpectedly failed (should warn and fall back, not refuse): $(cat "$TMP/fix1-claim.out" "$TMP/fix1-claim.err")"
fi

if grep -q "\[artifact-root\] WARNING: inside a git working tree but could not resolve the shared repo root" "$TMP/fix1-claim.err"; then
  _pass "FIX 1: a LOUD [artifact-root] WARNING was emitted to stderr for the corrupted-gitlink fail-open"
else
  _fail "FIX 1: expected a loud [artifact-root] WARNING on stderr, got: $(cat "$TMP/fix1-claim.err")"
fi

# The fallback must still be a cwd-local store under the (corrupted) worktree itself -- the
# warning is loud, but the actual fail-open target is unchanged from #357's baseline behavior.
if [[ -f "$BROKEN_WORKTREE/.kontourai/flow-agents/liveness/events.jsonl" ]]; then
  _pass "FIX 1: the fallback store landed at the cwd-local (corrupted worktree) path, as documented"
else
  _fail "FIX 1: no cwd-local fallback store found under the corrupted worktree after the loud warning"
fi

# Mutation-test note: deleting the isInsideGitWorkingTree() check (i.e. warning unconditionally,
# even for a cwd with no git repo at all) would make the AC6 non-git companion case below FAIL,
# since that case asserts pure, silent fail-open with no stderr expectations. Deleting the
# warnIfFailingOpenInsideGitTree() call entirely (i.e. reverting to pure silent fail-open) would
# make the grep assertion immediately above this note FAIL.

# ==== FIX 1b: a bad ambient GIT_DIR must resolve SILENTLY (proves Fix 3 runs BEFORE Fix 1's
# warning check) =============================================================================
# A nonexistent-path GIT_DIR, set as an AMBIENT env var, from a cwd that IS genuinely inside a
# real, uncorrupted git working tree (the PRIMARY checkout). Fix 3 (env-stripping) means this
# ambient GIT_DIR is deleted from the env BEFORE the internal `git rev-parse --git-common-dir`
# shell-out runs, so resolution succeeds normally here -- NO warning, NO fail-open at all. This
# is an important companion to FIX 1's own gitlink-corruption repro above: it proves Fix 1's loud
# warning is reserved for GENUINE resolution failures (corrupted .git, git unusable, etc.), not
# merely "some ambient git env var looked suspicious" -- an ambient GIT_DIR alone must never, by
# itself, cause a loud warning once Fix 3 has stripped it.
echo ""
echo "=== FIX 1b: an ambient (nonexistent) GIT_DIR resolves SILENTLY -- Fix 3's stripping runs first, no false-positive warning ==="

if (cd "$PRIMARY" && GIT_DIR=/nonexistent-git-dir-for-fix1b-eval flow_agents_node "$WRITER" liveness claim "fix1b-baddir-subject" --actor fix1b-actor \
  >"$TMP/fix1b-claim.out" 2>"$TMP/fix1b-claim.err"); then
  _pass "FIX 1b: liveness claim with an ambient (nonexistent) GIT_DIR exits 0"
else
  _fail "FIX 1b: liveness claim with an ambient GIT_DIR unexpectedly failed: $(cat "$TMP/fix1b-claim.out" "$TMP/fix1b-claim.err")"
fi

if grep -q "\[artifact-root\] WARNING" "$TMP/fix1b-claim.err"; then
  _fail "FIX 1b: unexpectedly emitted an [artifact-root] WARNING for a merely-ambient (stripped) GIT_DIR -- Fix 3's env-stripping regressed, or Fix 1 is firing as a false positive: $(cat "$TMP/fix1b-claim.err")"
else
  _pass "FIX 1b: no [artifact-root] WARNING was emitted -- the ambient GIT_DIR was correctly stripped before resolution (Fix 3), so Fix 1's warning never had a genuine failure to react to"
fi

if [[ -f "$PRIMARY/.kontourai/flow-agents/liveness/events.jsonl" ]] && grep -qF "fix1b-actor" "$PRIMARY/.kontourai/flow-agents/liveness/events.jsonl"; then
  _pass "FIX 1b: the claim landed in PRIMARY's own shared store, resolution was not disrupted by the ambient GIT_DIR"
else
  _fail "FIX 1b: the claim did not land in PRIMARY's own shared store as expected"
fi

# ==== FIX 1c: loud WARNING via a SECOND, distinct real corruption vector (unreadable .git/HEAD)
# =============================================================================================
# A DIFFERENT genuine git-resolution-failure vector from FIX 1's gitlink corruption above:
# an unreadable .git/HEAD inside yet another disposable worktree. Confirms the loud warning is
# not narrowly coupled to the specific "gitdir: pointer" corruption shape -- ANY genuine
# `git rev-parse --git-common-dir` failure from inside a real working tree triggers it. Skips
# gracefully (not a silent pass) when running as root, where chmod 000 does not restrict access.
echo ""
echo "=== FIX 1c: loud WARNING via a second, distinct corruption vector (unreadable .git/HEAD) ==="

if [[ "$(id -u)" == "0" ]]; then
  echo "  SKIP: running as root -- chmod 000 does not restrict access, cannot exercise this vector here."
else
  PERM_WORKTREE="$TMP/perm-broken-worktree"
  if (cd "$PRIMARY" && git worktree add -q -b perm-broken-worktree-branch "$PERM_WORKTREE" >/dev/null 2>"$TMP/perm-broken-worktree-add.err"); then
    _pass "FIX 1c setup: a third, disposable linked worktree was created for the permission-corruption fixture"
  else
    _fail "FIX 1c setup: 'git worktree add' for the perm-broken-worktree fixture failed: $(cat "$TMP/perm-broken-worktree-add.err")"
  fi

  # The linked worktree's real git-dir entry lives under the PRIMARY checkout's
  # .git/worktrees/<name>/ -- corrupt ITS HEAD file (unreadable), which is what
  # `git rev-parse --git-common-dir` from inside PERM_WORKTREE actually needs to read.
  REAL_GITDIR_ENTRY="$(cd "$PERM_WORKTREE" && git rev-parse --git-dir 2>/dev/null)"
  if [[ -n "$REAL_GITDIR_ENTRY" && -f "$REAL_GITDIR_ENTRY/HEAD" ]]; then
    chmod 000 "$REAL_GITDIR_ENTRY/HEAD"
    _pass "FIX 1c setup: made the linked worktree's own HEAD file unreadable"
  else
    _fail "FIX 1c setup: could not locate the linked worktree's real git-dir HEAD file to corrupt"
  fi

  PERM_COMMON_DIR_CHECK="$(cd "$PERM_WORKTREE" && git rev-parse --git-common-dir 2>/dev/null)"
  if [[ -z "$PERM_COMMON_DIR_CHECK" ]]; then
    _pass "FIX 1c setup: 'git rev-parse --git-common-dir' genuinely fails from inside the permission-corrupted worktree"
  else
    _fail "FIX 1c setup: corruption did not take effect -- git-common-dir still resolved: $PERM_COMMON_DIR_CHECK"
  fi

  if (cd "$PERM_WORKTREE" && flow_agents_node "$WRITER" liveness claim "fix1c-perm-corrupted-subject" --actor fix1c-actor \
    >"$TMP/fix1c-claim.out" 2>"$TMP/fix1c-claim.err"); then
    _pass "FIX 1c: liveness claim from the permission-corrupted worktree still exits 0 (loud warning, not a hard refuse)"
  else
    _fail "FIX 1c: liveness claim from the permission-corrupted worktree unexpectedly failed: $(cat "$TMP/fix1c-claim.out" "$TMP/fix1c-claim.err")"
  fi

  if grep -q "\[artifact-root\] WARNING: inside a git working tree but could not resolve the shared repo root" "$TMP/fix1c-claim.err"; then
    _pass "FIX 1c: a LOUD [artifact-root] WARNING was emitted to stderr for this second, distinct corruption vector"
  else
    _fail "FIX 1c: expected a loud [artifact-root] WARNING on stderr, got: $(cat "$TMP/fix1c-claim.err")"
  fi

  # Restore permissions so this eval's own cleanup (rm -rf "$TMP") can succeed.
  chmod 644 "$REAL_GITDIR_ENTRY/HEAD" 2>/dev/null || true
fi

# ==== AC6: single-checkout backward compat -- no worktree at all, path is byte-identical =======
echo ""
echo "=== AC6: single-checkout backward compat (no worktree) -- path unchanged from today ==="

PLAIN="$TMP/plain-repo"
mkdir -p "$PLAIN/kits"
(cd "$PLAIN" && git init -q && git config user.email "test@test.local" && git config user.name "test" \
  && printf '# marker\n' > kits/.keep && git add -A && git commit -q -m "init")

if (cd "$PLAIN" && flow_agents_node "$WRITER" liveness claim "plain-subject" --actor plain-actor \
  >"$TMP/plain-claim.out" 2>"$TMP/plain-claim.err"); then
  _pass "AC6: liveness claim from a plain (non-worktree) git repo cwd exits 0"
else
  _fail "AC6: liveness claim from a plain git repo cwd failed: $(cat "$TMP/plain-claim.out" "$TMP/plain-claim.err")"
fi
# In the single-checkout case, --git-common-dir resolves to .git under cwd itself, so
# path.dirname() of its absolute form is cwd -- the resolved root MUST be exactly
# <PLAIN>/.kontourai/flow-agents, byte-for-byte the same as plain path.resolve(cwd, ...).
if [[ -f "$PLAIN/.kontourai/flow-agents/liveness/events.jsonl" ]]; then
  _pass "AC6: the claim landed at exactly <repo>/.kontourai/flow-agents/liveness (unchanged, single-checkout path)"
else
  _fail "AC6: the claim did not land at the expected unchanged single-checkout path"
fi

LOCAL_ARTIFACT_ROOT_SUBDIR="lib"
LOCAL_ARTIFACT_ROOT_MODULE="$ROOT/build/src/$LOCAL_ARTIFACT_ROOT_SUBDIR/local-artifact-root.js"
RESOLVED_PLAIN_ROOT="$(node -e '
const { flowAgentsArtifactRoot } = require(process.argv[1]);
console.log(flowAgentsArtifactRoot(process.argv[2]));
' "$LOCAL_ARTIFACT_ROOT_MODULE" "$PLAIN")"
EXPECTED_PLAIN_ROOT="$(node -e 'console.log(require("path").resolve(process.argv[1], ".kontourai/flow-agents"))' "$PLAIN")"
if [[ "$RESOLVED_PLAIN_ROOT" == "$EXPECTED_PLAIN_ROOT" ]]; then
  _pass "AC6: flowAgentsArtifactRoot(cwd) for a plain single-checkout repo is byte-identical to plain path.resolve(cwd, '.kontourai/flow-agents')"
else
  _fail "AC6: flowAgentsArtifactRoot(cwd) diverged from the plain cwd-based path in the single-checkout case: got $RESOLVED_PLAIN_ROOT, expected $EXPECTED_PLAIN_ROOT"
fi

# Companion: a cwd with NO git repo at all (git resolution fails) must ALSO fall back to the
# exact plain cwd-based path -- the fail-open guarantee.
NONGIT="$TMP/non-git-dir"
mkdir -p "$NONGIT"
RESOLVED_NONGIT_ROOT="$(node -e '
const { flowAgentsArtifactRoot } = require(process.argv[1]);
console.log(flowAgentsArtifactRoot(process.argv[2]));
' "$LOCAL_ARTIFACT_ROOT_MODULE" "$NONGIT")"
EXPECTED_NONGIT_ROOT="$(node -e 'console.log(require("path").resolve(process.argv[1], ".kontourai/flow-agents"))' "$NONGIT")"
if [[ "$RESOLVED_NONGIT_ROOT" == "$EXPECTED_NONGIT_ROOT" ]]; then
  _pass "AC6: flowAgentsArtifactRoot(cwd) for a non-git directory fails open to the plain cwd-based path, byte-identical to today"
else
  _fail "AC6: flowAgentsArtifactRoot(cwd) for a non-git directory did not fail open correctly: got $RESOLVED_NONGIT_ROOT, expected $EXPECTED_NONGIT_ROOT"
fi

# ==== AC6b: subdirectory cwd resolves to the SHARED REPO-ROOT store (#413 iteration-2 Fix 2) ====
# Intentional, NOT byte-identical: `git rev-parse --git-common-dir` from a subdirectory returns a
# RELATIVE path this resolver walks up to the repo root, so a subdirectory invocation now
# correctly resolves to <repo-root>/.kontourai/flow-agents -- the SAME shared store every other
# cwd in this repo resolves to -- rather than the OLD cwd-anchored path.resolve(cwd, ...) a
# subdirectory invocation used to produce. See this eval's header docstring (AC6b) for the full
# rationale and the Fix 2a grep confirming no real call site depends on the old subdir-anchored
# behavior.
echo ""
echo "=== AC6b: subdirectory cwd resolves to the shared repo-root store (intended, not byte-identical) ==="

SUBDIR="$PLAIN/nested/deeper"
mkdir -p "$SUBDIR"
RESOLVED_SUBDIR_ROOT="$(node -e '
const { flowAgentsArtifactRoot } = require(process.argv[1]);
console.log(flowAgentsArtifactRoot(process.argv[2]));
' "$LOCAL_ARTIFACT_ROOT_MODULE" "$SUBDIR")"
EXPECTED_SUBDIR_ROOT="$(node -e 'console.log(require("path").resolve(process.argv[1], ".kontourai/flow-agents"))' "$PLAIN")"
OLD_CWD_ANCHORED_ROOT="$(node -e 'console.log(require("path").resolve(process.argv[1], ".kontourai/flow-agents"))' "$SUBDIR")"

if [[ "$RESOLVED_SUBDIR_ROOT" == "$EXPECTED_SUBDIR_ROOT" ]]; then
  _pass "AC6b: flowAgentsArtifactRoot(subdirCwd) resolves to the REPO-ROOT shared store <repo>/.kontourai/flow-agents, not the subdir"
else
  _fail "AC6b: flowAgentsArtifactRoot(subdirCwd) did not resolve to the repo-root store: got $RESOLVED_SUBDIR_ROOT, expected $EXPECTED_SUBDIR_ROOT"
fi
if [[ "$RESOLVED_SUBDIR_ROOT" != "$OLD_CWD_ANCHORED_ROOT" ]]; then
  _pass "AC6b: this genuinely differs from the OLD cwd-anchored subdir path (confirms this is the intended git-common-dir walk-up, not an accidental no-op)"
else
  _fail "AC6b: resolved root unexpectedly matched the old cwd-anchored subdir path -- the git-common-dir walk-up did not take effect for this cwd"
fi

# ==== FIX 3 (#413 iteration-2, MEDIUM security): ambient GIT_DIR/GIT_COMMON_DIR must NOT redirect
# resolution to a DIFFERENT real repo =========================================================
# A SECOND, wholly unrelated real git repo, plus a VALID (not merely nonexistent, unlike Fix 1b's
# corruption fixture) ambient GIT_DIR pointing at that other repo's .git directory, invoked from
# inside $PLAIN (the AC6 single-checkout fixture). Without Fix 3's env-stripping, git would honor
# the ambient GIT_DIR and --git-common-dir would resolve to the OTHER repo, silently redirecting
# the shared .kontourai/flow-agents store there. With Fix 3, resolution must depend on cwd alone.
echo ""
echo "=== FIX 3: an ambient GIT_DIR pointing at a DIFFERENT real repo does not redirect the resolved store ==="

OTHER_REPO="$TMP/fix3-other-repo"
mkdir -p "$OTHER_REPO/kits"
(cd "$OTHER_REPO" && git init -q && git config user.email "test@test.local" && git config user.name "test" \
  && printf '# marker\n' > kits/.keep && git add -A && git commit -q -m "init other repo")
if [[ -d "$OTHER_REPO/.git" ]]; then
  _pass "FIX 3 setup: a second, unrelated real git repo was created for the GIT_DIR redirection fixture"
else
  _fail "FIX 3 setup: 'git init' for the other-repo fixture failed"
fi

FIX3_SUBJECT="fix3-git-dir-redirect-subject"
if (cd "$PLAIN" && GIT_DIR="$OTHER_REPO/.git" flow_agents_node "$WRITER" liveness claim "$FIX3_SUBJECT" --actor fix3-actor \
  >"$TMP/fix3-claim.out" 2>"$TMP/fix3-claim.err"); then
  _pass "FIX 3: liveness claim with an ambient GIT_DIR pointing at another repo exits 0"
else
  _fail "FIX 3: liveness claim with an ambient GIT_DIR pointing at another repo unexpectedly failed: $(cat "$TMP/fix3-claim.out" "$TMP/fix3-claim.err")"
fi

if [[ -f "$PLAIN/.kontourai/flow-agents/liveness/events.jsonl" ]] && grep -qF "fix3-actor" "$PLAIN/.kontourai/flow-agents/liveness/events.jsonl"; then
  _pass "FIX 3: the claim landed in PLAIN's OWN shared store (cwd-anchored), not redirected by the ambient GIT_DIR"
else
  _fail "FIX 3: the claim did not land in PLAIN's own store -- ambient GIT_DIR may have redirected resolution"
fi
if [[ ! -d "$OTHER_REPO/.kontourai" ]]; then
  _pass "FIX 3: the OTHER repo (named by the ambient GIT_DIR) received NO .kontourai artifact at all -- resolution was not redirected there"
else
  _fail "FIX 3: the OTHER repo unexpectedly received a .kontourai artifact -- ambient GIT_DIR redirected resolution (Fix 3 regressed)"
fi

# Direct resolver-level assertion (no subprocess env-inheritance ambiguity): resolveSharedRepoRoot
# invoked with an explicit ambient GIT_DIR pointing at OTHER_REPO must still resolve PLAIN's own
# root, never OTHER_REPO's.
RESOLVED_WITH_BAD_GIT_DIR="$(cd "$PLAIN" && GIT_DIR="$OTHER_REPO/.git" node -e '
const { resolveSharedRepoRoot } = require(process.argv[1]);
console.log(resolveSharedRepoRoot(process.argv[2]));
' "$LOCAL_ARTIFACT_ROOT_MODULE" "$PLAIN")"
REAL_PLAIN="$(cd "$PLAIN" && pwd -P)"
REAL_OTHER_REPO="$(cd "$OTHER_REPO" && pwd -P)"
if [[ -n "$RESOLVED_WITH_BAD_GIT_DIR" ]]; then
  REAL_RESOLVED_WITH_BAD_GIT_DIR="$(cd "$RESOLVED_WITH_BAD_GIT_DIR" && pwd -P)"
  if [[ "$REAL_RESOLVED_WITH_BAD_GIT_DIR" == "$REAL_PLAIN" ]]; then
    _pass "FIX 3: resolveSharedRepoRoot(PLAIN cwd) with ambient GIT_DIR=<other repo> still resolves PLAIN's own root"
  elif [[ "$REAL_RESOLVED_WITH_BAD_GIT_DIR" == "$REAL_OTHER_REPO" ]]; then
    _fail "FIX 3: resolveSharedRepoRoot was REDIRECTED to the other repo named by ambient GIT_DIR -- Fix 3 regressed"
  else
    _fail "FIX 3: resolveSharedRepoRoot resolved to neither expected root: got $REAL_RESOLVED_WITH_BAD_GIT_DIR"
  fi
else
  _fail "FIX 3: resolveSharedRepoRoot(PLAIN cwd) with ambient GIT_DIR returned nothing"
fi

# ---- Summary ----
echo ""
echo "----------------------------------------------"
if [[ $errors -eq 0 ]]; then
  echo "test_liveness_worktree_root: all checks passed."
  exit 0
else
  echo "test_liveness_worktree_root: $errors check(s) failed."
  exit 1
fi
