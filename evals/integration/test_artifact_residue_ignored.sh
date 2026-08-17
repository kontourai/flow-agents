#!/usr/bin/env bash
# #1264: a fresh install must not leave the evidence writer unable to observe itself.
#
# `workflow evidence` with command evidence executes each `--command` and captures Git
# provenance AT EXECUTION TIME, from inside the artifact root it is actively writing to.
# In a repository that does not ignore that root, the writer sees its own state.json,
# command log, lock files and transaction directories as a dirty working tree and refuses
# its own observation — reporting a precondition, never the cause.
#
# This was invisible for as long as it existed because THIS repository ignores
# `.kontourai/` in its own .gitignore, so the path worked where it was developed and was
# broken in every fresh install. That is why the assertions below run against a real
# `init` into a throwaway repo rather than against this one.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$ROOT/build/src/cli.js"
errors=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; errors=$((errors + 1)); }

printf '\ntest_artifact_residue_ignored\n'
[ -f "$CLI" ] || { printf '  SKIP  no build present\n'; exit 0; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"; mkdir -p "$HOME"
R="$TMP/repo"; mkdir -p "$R"
git -C "$R" init -q -b main
git -C "$R" config user.email residue@example.invalid
git -C "$R" config user.name "Residue"
printf 'node_modules\n' > "$R/.gitignore"
printf '# fixture\n' > "$R/README.md"
git -C "$R" add -A >/dev/null 2>&1
git -C "$R" commit -q -m base

node "$CLI" init --runtime claude-code --dest "$R" >/dev/null 2>&1 || { fail "init failed"; exit 1; }

# 1. The ignore exists, and covers the SHARED root. Scoping it to .kontourai/flow-agents
#    was measured insufficient: the Flow engine writes to the sibling .kontourai/flow.
if [ -f "$R/.kontourai/.gitignore" ]; then
  pass "init writes an ignore at the shared .kontourai root"
else
  fail "init did not write .kontourai/.gitignore"
fi

# 2. The property that actually matters, asserted as BEHAVIOUR rather than file contents:
#    after a run has been started, the working tree is clean. A file-contents assertion
#    would pass against an ignore that does not actually cover what the run writes — which
#    is exactly the bug the first version of this fix shipped.
git -C "$R" add -A >/dev/null 2>&1; git -C "$R" commit -q -m install >/dev/null 2>&1
S="wedge-residue"; D=".kontourai/flow-agents/$S"
mkdir -p "$R/$D"; printf 'Selected Work Item: wedge:residue\n' > "$R/$D/$S--pull-work.md"
git -C "$R" add -A >/dev/null 2>&1; git -C "$R" commit -q -m art >/dev/null 2>&1
(cd "$R" && node "$CLI" workflow start --flow builder.build --work-item 'wedge:residue' \
   --assignment-provider local-file >/dev/null 2>&1)

dirty="$(git -C "$R" status --short | wc -l | tr -d ' ')"
if [ "$dirty" = "0" ]; then
  pass "the working tree is clean after a run writes its state"
else
  fail "run state left $dirty dirty path(s); the writer will refuse its own provenance:"
  git -C "$R" status --short | head -5 | sed 's/^/          /'
fi

# 3. Never clobber. A project may have written its own rules here, and silently replacing
#    them is the user-data-loss class #1238 covered.
printf '# mine\n' > "$R/.kontourai/.gitignore"
node "$CLI" init --runtime claude-code --dest "$R" >/dev/null 2>&1
if [ "$(cat "$R/.kontourai/.gitignore")" = "# mine" ]; then
  pass "an existing .kontourai/.gitignore is preserved verbatim"
else
  fail "re-running init overwrote a user-authored .kontourai/.gitignore"
fi

printf '\n  %s failure(s)\n\n' "$errors"
[ "$errors" -eq 0 ] || exit 1
exit 0
