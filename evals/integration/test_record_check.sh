#!/usr/bin/env bash
# test_record_check.sh — integration eval for `workflow-sidecar record-check` (#380, AC7).
#
# Proves:
#   1. `record-check <dir> -- <command>` RUNS the command and records a kind:"command" check
#      with a real execution.label, composed losslessly into the trust.bundle (through the same
#      readBundleState + mergeChecksById + writeTrustBundle path every other writer uses).
#   2. A passing command → exit 0, claim status "verified" (Surface deriveClaimStatus).
#   3. A failing command → exit NONZERO from record-check itself (loud, not silently swallowed)
#      AND a claim status "disputed" is still recorded (the failure is captured, not dropped).
#   4. A prior check recorded by record-evidence survives a subsequent record-check call
#      (compose-safe, not a parallel bundle-writing implementation — #298/#270 class).
#   5. `--command "<shell string>"` is accepted as an alternative to `-- <command...>` and is
#      rejected when the string is not a runnable shell command (#412 parity with
#      record-gate-claim --command).
#   6. record-check is reachable via the REAL CLI entry point (main()'s switch), not just as an
#      exported function — this guards against the "added the function but forgot to wire it
#      into the switch" stop-short risk called out in the delivery plan.
#
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_record_check.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

WRITER="workflow-sidecar"
TMPDIR_EVAL="$(mktemp -d)"
errors=0

cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

SESSION_ROOT="$TMPDIR_EVAL/repo/.kontourai/flow-agents"
SLUG="record-check-eval"
SESSION_DIR="$SESSION_ROOT/$SLUG"
mkdir -p "$SESSION_ROOT"

flow_agents_node "$WRITER" ensure-session \
  --artifact-root "$SESSION_ROOT" \
  --task-slug "$SLUG" \
  --title "record-check eval" \
  --source-request "Integration eval for record-check (#380)." \
  --summary "Seed session for record-check assertions." \
  --criterion "record-check runs a command and records a capture-backed check" \
  --timestamp "2026-07-05T09:00:00Z" >"$TMPDIR_EVAL/seed.out" 2>"$TMPDIR_EVAL/seed.err"

if [[ ! -d "$SESSION_DIR" ]]; then
  _fail "eval setup: ensure-session did not create the session dir: $(cat "$TMPDIR_EVAL/seed.out" "$TMPDIR_EVAL/seed.err")"
  echo ""
  echo "$errors check(s) failed."
  exit 1
fi

# ─── 1/2/6: record-check <dir> -- <command> (pass path), via the REAL CLI entry point ────────
if flow_agents_node "$WRITER" record-check "$SESSION_DIR" --timestamp "2026-07-05T09:01:00Z" -- echo record-check-eval-ok \
  >"$TMPDIR_EVAL/rc-pass.out" 2>"$TMPDIR_EVAL/rc-pass.err"; then
  _pass "record-check (pass path) exits 0 for a succeeding command, via the real CLI switch dispatch"
else
  _fail "record-check (pass path) unexpectedly failed: $(cat "$TMPDIR_EVAL/rc-pass.out" "$TMPDIR_EVAL/rc-pass.err")"
fi

if [[ -f "$SESSION_DIR/trust.bundle" ]] && node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/rc-pass-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${SESSION_DIR}/trust.bundle', 'utf8'));
const claim = bundle.claims.find((c) => (c.metadata || {}).check_kind === 'command' && c.fieldOrBehavior && c.fieldOrBehavior.includes('echo record-check-eval-ok'));
if (!claim) { process.stderr.write('no kind:"command" claim found for the echo command\n'); process.exit(1); }
if (claim.status !== 'verified') { process.stderr.write('expected claim status verified for a passing command, got ' + claim.status + '\n'); process.exit(1); }
const ev = bundle.evidence.find((e) => e.claimId === claim.id);
if (!ev || !ev.execution || ev.execution.label !== 'echo record-check-eval-ok') { process.stderr.write('execution.label was not set to the executed command: ' + JSON.stringify(ev && ev.execution) + '\n'); process.exit(1); }
if (ev.execution.isError !== false) { process.stderr.write('execution.isError should be false for a passing command\n'); process.exit(1); }
NODEOF
then
  _pass "AC7: record-check (pass) records a kind:\"command\" check with real execution.label and claim status verified"
else
  _fail "AC7: record-check (pass) bundle assertion failed: $(cat "$TMPDIR_EVAL/rc-pass-assert.err")"
fi

# ─── #270/#380 MEDIUM fix: record-check persists a REAL sha256 digest of the captured output ──
# onto claim.metadata.output_digest, never the raw output text (secret-safe by construction).
# The executed command's TEXT ("rc-digest-output-8f2a1c9b3d" piped through base64) is deliberately DIFFERENT
# from its OUTPUT TEXT ("cmMtZGlnZXN0LW91dHB1dC04ZjJhMWM5YjNk") so that asserting the output text is absent from the
# bundle cannot be confused with the (legitimate, expected) presence of the command text itself
# in execution.label/fieldOrBehavior.
if flow_agents_node "$WRITER" record-check "$SESSION_DIR" --timestamp "2026-07-05T09:01:30Z" --id digest-check --command "printf 'rc-digest-output-8f2a1c9b3d' | base64" \
  >"$TMPDIR_EVAL/rc-digest.out" 2>"$TMPDIR_EVAL/rc-digest.err"; then
  _pass "record-check (digest eval command) exits 0"
else
  _fail "record-check (digest eval command) unexpectedly failed: $(cat "$TMPDIR_EVAL/rc-digest.out" "$TMPDIR_EVAL/rc-digest.err")"
fi

if [[ -f "$SESSION_DIR/trust.bundle" ]] && node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/rc-digest-assert.err"
import { readFileSync } from 'node:fs';
const bundleText = readFileSync('${SESSION_DIR}/trust.bundle', 'utf8');
const bundle = JSON.parse(bundleText);
const claim = bundle.claims.find((c) => c.subjectId && c.subjectId.endsWith('/digest-check'));
if (!claim) { process.stderr.write('no claim found for the digest-check command\n'); process.exit(1); }
const od = (claim.metadata || {}).output_digest;
if (!od || typeof od !== 'object') { process.stderr.write('claim.metadata.output_digest is missing: ' + JSON.stringify(claim.metadata) + '\n'); process.exit(1); }
if (od.algorithm !== 'sha256') { process.stderr.write('expected algorithm sha256, got ' + od.algorithm + '\n'); process.exit(1); }
if (typeof od.hex !== 'string' || !/^[0-9a-f]{64}$/.test(od.hex)) { process.stderr.write('output_digest.hex is not a 64-char lowercase hex sha256 digest: ' + JSON.stringify(od.hex) + '\n'); process.exit(1); }
const expectedHex = '163efc60e68c74a22225e8844f8a9f8b7d9ed30b2424bdbf939a3e41085348fe';
if (od.hex !== expectedHex) { process.stderr.write('output_digest.hex does not match the expected sha256 of the captured output: got ' + od.hex + ' expected ' + expectedHex + '\n'); process.exit(1); }
// Secret-safety: the RAW output text must never appear anywhere in the persisted bundle text —
// only its digest may. (The command TEXT itself legitimately appears in execution.label/summary;
// that is NOT what this assertion is checking.)
if (bundleText.includes('cmMtZGlnZXN0LW91dHB1dC04ZjJhMWM5YjNk')) { process.stderr.write('SECURITY REGRESSION: the raw captured output text was found in trust.bundle — output_digest must be a hash only, never raw output\n'); process.exit(1); }
NODEOF
then
  _pass "#270/#380: record-check persists a real 64-hex sha256 digest of the captured output onto claim.metadata.output_digest, and the raw output text is never persisted (secret-safe by construction)"
else
  _fail "#270/#380: record-check digest assertion failed: $(cat "$TMPDIR_EVAL/rc-digest-assert.err")"
fi

# ─── 3: record-check <dir> -- <command> (fail path) ──────────────────────────────────────────
if flow_agents_node "$WRITER" record-check "$SESSION_DIR" --timestamp "2026-07-05T09:02:00Z" -- false \
  >"$TMPDIR_EVAL/rc-fail.out" 2>"$TMPDIR_EVAL/rc-fail.err"; then
  _fail "record-check (fail path) should exit nonzero for a failing command, but exited 0"
else
  _pass "record-check (fail path) exits nonzero (loud) for a failing command, never silently swallowed"
fi

if [[ -f "$SESSION_DIR/trust.bundle" ]] && node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/rc-fail-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${SESSION_DIR}/trust.bundle', 'utf8'));
const claim = bundle.claims.find((c) => (c.metadata || {}).check_kind === 'command' && c.fieldOrBehavior && c.fieldOrBehavior.includes('false'));
if (!claim) { process.stderr.write('no kind:"command" claim found for the false command\n'); process.exit(1); }
if (claim.status !== 'disputed') { process.stderr.write('expected claim status disputed for a failing command, got ' + claim.status + '\n'); process.exit(1); }
const ev = bundle.evidence.find((e) => e.claimId === claim.id);
if (!ev || !ev.execution || ev.execution.isError !== true) { process.stderr.write('execution.isError should be true for a failing command\n'); process.exit(1); }
NODEOF
then
  _pass "AC7: record-check (fail) records a kind:\"command\" check with status fail/disputed — the failure is captured, not dropped"
else
  _fail "AC7: record-check (fail) bundle assertion failed: $(cat "$TMPDIR_EVAL/rc-fail-assert.err")"
fi

# ─── 4: a PRIOR check (recorded by record-evidence) survives a SUBSEQUENT record-check call ───
if flow_agents_node "$WRITER" record-evidence "$SESSION_DIR" \
  --verdict pass \
  --check-json '{"id":"prior-evidence-check","kind":"test","status":"pass","summary":"Prior evidence check passed."}' \
  --timestamp "2026-07-05T09:03:00Z" >"$TMPDIR_EVAL/prior-evidence.out" 2>"$TMPDIR_EVAL/prior-evidence.err"; then
  _pass "eval setup: record-evidence seeds a prior check before the compose-safety assertion"
else
  _fail "eval setup: record-evidence failed: $(cat "$TMPDIR_EVAL/prior-evidence.out" "$TMPDIR_EVAL/prior-evidence.err")"
fi

if flow_agents_node "$WRITER" record-check "$SESSION_DIR" --timestamp "2026-07-05T09:04:00Z" -- echo second-record-check-call \
  >"$TMPDIR_EVAL/rc-second.out" 2>"$TMPDIR_EVAL/rc-second.err"; then
  _pass "record-check (second call) succeeds after a prior record-evidence call"
else
  _fail "record-check (second call) unexpectedly failed: $(cat "$TMPDIR_EVAL/rc-second.out" "$TMPDIR_EVAL/rc-second.err")"
fi

if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/rc-compose-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${SESSION_DIR}/trust.bundle', 'utf8'));
const claims = bundle.claims;
const priorCheck = claims.find((c) => c.subjectId && c.subjectId.endsWith('/prior-evidence-check'));
const passCheck = claims.find((c) => (c.metadata || {}).check_kind === 'command' && c.fieldOrBehavior && c.fieldOrBehavior.includes('echo record-check-eval-ok'));
const failCheck = claims.find((c) => (c.metadata || {}).check_kind === 'command' && c.fieldOrBehavior && c.fieldOrBehavior.includes('false'));
const secondCheck = claims.find((c) => (c.metadata || {}).check_kind === 'command' && c.fieldOrBehavior && c.fieldOrBehavior.includes('echo second-record-check-call'));
if (!priorCheck) { process.stderr.write('prior record-evidence check was LOST after a subsequent record-check call (#298/#270 compose-safety regression)\n'); process.exit(1); }
if (!passCheck || !failCheck || !secondCheck) { process.stderr.write('an earlier record-check claim was lost after a later record-check call\n'); process.exit(1); }
NODEOF
then
  _pass "record-check is compose-safe: a prior record-evidence check AND earlier record-check claims all survive a subsequent record-check call"
else
  _fail "record-check compose-safety assertion failed: $(cat "$TMPDIR_EVAL/rc-compose-assert.err")"
fi

# ─── 5: --command "<shell string>" parity flag; rejects prose (#412) ─────────────────────────
if flow_agents_node "$WRITER" record-check "$SESSION_DIR" --timestamp "2026-07-05T09:05:00Z" --command "git rev-parse HEAD" \
  >"$TMPDIR_EVAL/rc-command-flag.out" 2>"$TMPDIR_EVAL/rc-command-flag.err"; then
  _pass "record-check --command \"<shell string>\" (parity flag with record-gate-claim) succeeds"
else
  _fail "record-check --command failed: $(cat "$TMPDIR_EVAL/rc-command-flag.out" "$TMPDIR_EVAL/rc-command-flag.err")"
fi

if flow_agents_node "$WRITER" record-check "$SESSION_DIR" --timestamp "2026-07-05T09:06:00Z" --command "Manually confirmed the output looks correct." \
  >"$TMPDIR_EVAL/rc-command-prose.out" 2>"$TMPDIR_EVAL/rc-command-prose.err"; then
  _fail "record-check --command should reject prose, but accepted it"
elif grep -qi "not a runnable shell command" "$TMPDIR_EVAL/rc-command-prose.out" "$TMPDIR_EVAL/rc-command-prose.err"; then
  _pass "record-check --command rejects a prose value at record time (#412 parity with record-gate-claim --command)"
else
  _fail "record-check --command prose rejection message was unexpected: $(cat "$TMPDIR_EVAL/rc-command-prose.out" "$TMPDIR_EVAL/rc-command-prose.err")"
fi

# ─── Usage error: neither `-- <command>` nor --command supplied ─────────────────────────────
if flow_agents_node "$WRITER" record-check "$SESSION_DIR" --timestamp "2026-07-05T09:07:00Z" \
  >"$TMPDIR_EVAL/rc-no-command.out" 2>"$TMPDIR_EVAL/rc-no-command.err"; then
  _fail "record-check with no command at all should die with a usage error, but exited 0"
elif grep -qi "requires a command" "$TMPDIR_EVAL/rc-no-command.out" "$TMPDIR_EVAL/rc-no-command.err"; then
  _pass "record-check with neither -- <command> nor --command dies with an actionable usage error"
else
  _fail "record-check no-command error message was unexpected: $(cat "$TMPDIR_EVAL/rc-no-command.out" "$TMPDIR_EVAL/rc-no-command.err")"
fi

# ─── #362 AC6/AC7: record-check's ambiguous-absence-command classification ──────────────────
# A bare (non-negated, non-count-asserted, non-chained) grep/diff invocation whose exit code is
# exactly 1 is exit-code-ambiguous (zero matches could be the author's intended PASS for an
# absence check, or an unintended miss for a presence check) — record-check stamps a distinct
# "not_verified" status (never silently pass, never silently fail) and surfaces a loud, actionable
# stderr note, but does NOT itself exit nonzero (the command DID run; this is not a tool error).
FIXTURE_FILE="$TMPDIR_EVAL/repo/ac6-fixture.txt"
echo "some content with no matching pattern here" >"$FIXTURE_FILE"

# AC6: bare `grep` exit 1 (pattern genuinely absent) → recorded status not_verified + loud stderr
# note, record-check itself exits 0 (never hard-fail on an ambiguous, not a tool-error, outcome).
if flow_agents_node "$WRITER" record-check "$SESSION_DIR" --timestamp "2026-07-05T09:08:00Z" --id ac6-ambiguous-grep -- grep -E 'this-pattern-does-not-exist-anywhere' "$FIXTURE_FILE"   >"$TMPDIR_EVAL/rc-ambiguous.out" 2>"$TMPDIR_EVAL/rc-ambiguous.err"; then
  _pass "AC6: record-check with a bare grep exit-1 (ambiguous absence) exits 0, never hard-fails"
else
  _fail "AC6 REGRESSION: record-check with a bare grep exit-1 (ambiguous absence) should exit 0 (never a tool error, never hard-fail), but exited nonzero: $(cat "$TMPDIR_EVAL/rc-ambiguous.out" "$TMPDIR_EVAL/rc-ambiguous.err")"
fi

if grep -qi "ambiguous" "$TMPDIR_EVAL/rc-ambiguous.err" && grep -qi "not_verified" "$TMPDIR_EVAL/rc-ambiguous.err"; then
  _pass "AC6: record-check emits a loud stderr note naming both 'ambiguous' and the recorded 'not_verified' status for a bare grep exit-1"
else
  _fail "AC6: record-check's ambiguous stderr note was missing expected substrings ('ambiguous' and 'not_verified'): $(cat "$TMPDIR_EVAL/rc-ambiguous.err")"
fi

# AC7: the same stderr note nudges toward a self-asserting rewrite ('! grep ...' / 'grep -c ... | grep -qx 0').
if grep -qi "self-asserting" "$TMPDIR_EVAL/rc-ambiguous.err"; then
  _pass "AC7: record-check's ambiguous stderr note nudges toward a self-asserting recorded-command form"
else
  _fail "AC7: record-check's ambiguous stderr note did not mention 'self-asserting': $(cat "$TMPDIR_EVAL/rc-ambiguous.err")"
fi

if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/rc-ambiguous-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${SESSION_DIR}/trust.bundle', 'utf8'));
const claim = bundle.claims.find((c) => c.subjectId && c.subjectId.endsWith('/ac6-ambiguous-grep'));
if (!claim) { process.stderr.write('no claim found for the ac6-ambiguous-grep check\n'); process.exit(1); }
if (claim.value !== 'not_verified') { process.stderr.write('expected claim value not_verified for an ambiguous bare-grep exit-1, got ' + claim.value + '\n'); process.exit(1); }
NODEOF
then
  _pass "AC6: record-check stamps check status not_verified (not a new 'ambiguous' enum value — mapped onto the existing not_verified status per the plan/ADR 0008/0010) for a bare grep exit-1"
else
  _fail "AC6: record-check ambiguous-status bundle assertion failed: $(cat "$TMPDIR_EVAL/rc-ambiguous-assert.err")"
fi

# Regression guard: a SELF-ASSERTING form (`! grep ...`, negation flips intent into the command's
# own exit code) exiting 0 records a clean pass — never misclassified ambiguous just because the
# underlying binary is grep. Uses the NATURAL `--command '! grep ...'` form (not a `bash -lc`
# workaround) — isRunnableCommandText now strips a leading `!` before evaluating runnability
# (coherence fix: the ambiguous-absence advisory's own suggested remediation must not itself be
# rejected by the #412 runnability guard), so `--command` accepts this literal negated form.
if flow_agents_node "$WRITER" record-check "$SESSION_DIR" --timestamp "2026-07-05T09:08:30Z" --id ac6-self-asserting-negation --command "! grep -E 'this-pattern-does-not-exist-anywhere' $FIXTURE_FILE" \
  >"$TMPDIR_EVAL/rc-negation.out" 2>"$TMPDIR_EVAL/rc-negation.err"; then
  _pass "record-check --command '! grep ...' (natural self-asserting negated form) exits 0, as expected for a plain pass"
else
  _fail "record-check --command '! grep ...' unexpectedly failed: $(cat "$TMPDIR_EVAL/rc-negation.out" "$TMPDIR_EVAL/rc-negation.err")"
fi

if grep -qi "not a runnable shell command" "$TMPDIR_EVAL/rc-negation.out" "$TMPDIR_EVAL/rc-negation.err"; then
  _fail "REGRESSION: record-check --command '! grep ...' was rejected as non-runnable — isRunnableCommandText's leading-'!' strip is not working"
else
  _pass "record-check --command '! grep ...' is ACCEPTED by the runnability guard (leading '!' is stripped before evaluation)"
fi

if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/rc-negation-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${SESSION_DIR}/trust.bundle', 'utf8'));
const claim = bundle.claims.find((c) => c.subjectId && c.subjectId.endsWith('/ac6-self-asserting-negation'));
if (!claim) { process.stderr.write('no claim found for the ac6-self-asserting-negation check\n'); process.exit(1); }
if (claim.value !== 'pass') { process.stderr.write('expected claim value pass for a self-asserting negated grep, got ' + claim.value + '\n'); process.exit(1); }
NODEOF
then
  _pass "regression guard: a self-asserting '! grep ...' form records a clean pass, never misclassified ambiguous"
else
  _fail "regression guard assertion failed: $(cat "$TMPDIR_EVAL/rc-negation-assert.err")"
fi

# AC5-parity regression guard: bare grep exit >= 2 (a real tool error — missing file) still hard
# FAILs (nonzero record-check exit), proving the exit-1-only carve-out is narrowly scoped.
if flow_agents_node "$WRITER" record-check "$SESSION_DIR" --timestamp "2026-07-05T09:09:00Z" --id ac6-exit2-hard-fail -- grep -E 'pattern' "$TMPDIR_EVAL/this-file-does-not-exist-ac6"   >"$TMPDIR_EVAL/rc-exit2.out" 2>"$TMPDIR_EVAL/rc-exit2.err"; then
  _fail "REGRESSION: record-check with a bare grep exit >= 2 (missing file, a real tool error) should hard-fail (nonzero exit), but exited 0"
else
  _pass "record-check with a bare grep exit >= 2 (missing file) still hard-fails (nonzero exit) — the exit-1-only carve-out does not weaken real tool-error detection"
fi

if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/rc-exit2-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${SESSION_DIR}/trust.bundle', 'utf8'));
const claim = bundle.claims.find((c) => c.subjectId && c.subjectId.endsWith('/ac6-exit2-hard-fail'));
if (!claim) { process.stderr.write('no claim found for the ac6-exit2-hard-fail check\n'); process.exit(1); }
if (claim.value !== 'fail') { process.stderr.write('expected claim value fail for a bare grep exit >= 2, got ' + claim.value + '\n'); process.exit(1); }
NODEOF
then
  _pass "record-check with a bare grep exit >= 2 records a hard fail claim value (not ambiguous, not_verified)"
else
  _fail "exit>=2 hard-fail claim-value assertion failed: $(cat "$TMPDIR_EVAL/rc-exit2-assert.err")"
fi

# ─── Mutation test (#362 AC6 recordCheck ambiguity branch): temporarily disable recordCheck's ──
# `ambiguous` computation in a SCRATCH COPY of the compiled build/ output, confirm the AC6 bare-
# grep-exit-1 fixture above now records status "fail" (not "not_verified") against that mutated
# binary (eval "goes red" without the branch), then restore the original compiled file
# immediately. Proves the eval is actually exercising this specific classification branch, not
# passing vacuously for an unrelated reason.
DIST_SIDECAR="$ROOT/build/src/cli/workflow-sidecar.js"
AMBIGUOUS_SCRATCH="$TMPDIR_EVAL/ambiguous-mutation-scratch"
mkdir -p "$AMBIGUOUS_SCRATCH"

if [[ -f "$DIST_SIDECAR" ]]; then
  cp "$DIST_SIDECAR" "$AMBIGUOUS_SCRATCH/workflow-sidecar.orig.js"
  node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/ambiguous-mutation-patch.err"
import { readFileSync, writeFileSync } from 'node:fs';
const file = '${AMBIGUOUS_SCRATCH}/workflow-sidecar.orig.js';
let src = readFileSync(file, 'utf8');
const needle = 'const ambiguous = exitCode === 1 && isAmbiguousAbsenceCommand(displayCommand ?? "");';
if (!src.includes(needle)) { process.stderr.write('mutation: recordCheck ambiguous-branch text not found — source pattern drifted, cannot mutation-test\n'); process.exit(1); }
src = src.split(needle).join('const ambiguous = false;');
writeFileSync('${AMBIGUOUS_SCRATCH}/workflow-sidecar.mutated.js', src);
NODEOF

  if [[ -s "$TMPDIR_EVAL/ambiguous-mutation-patch.err" ]]; then
    _fail "mutation-test setup failed (recordCheck ambiguous-branch source pattern did not match compiled output): $(cat "$TMPDIR_EVAL/ambiguous-mutation-patch.err")"
  else
    if node --check "$AMBIGUOUS_SCRATCH/workflow-sidecar.mutated.js" 2>"$TMPDIR_EVAL/ambiguous-mutation-syntax.err"; then
      cp "$AMBIGUOUS_SCRATCH/workflow-sidecar.mutated.js" "$DIST_SIDECAR"

      flow_agents_node "$WRITER" record-check "$SESSION_DIR" --timestamp "2026-07-05T09:10:00Z" --id ac6-mutation-check -- grep -E 'this-pattern-does-not-exist-anywhere' "$FIXTURE_FILE"         >"$TMPDIR_EVAL/rc-mutation.out" 2>"$TMPDIR_EVAL/rc-mutation.err"
      MUTATION_EXIT=$?

      if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/rc-mutation-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${SESSION_DIR}/trust.bundle', 'utf8'));
const claim = bundle.claims.find((c) => c.subjectId && c.subjectId.endsWith('/ac6-mutation-check'));
if (!claim) { process.stderr.write('no claim found for the ac6-mutation-check check\n'); process.exit(1); }
if (claim.value !== 'fail') { process.stderr.write('expected the mutated (ambiguity-disabled) binary to record claim value fail (not not_verified), got ' + claim.value + '\n'); process.exit(1); }
NODEOF
      then
        if [[ "$MUTATION_EXIT" -eq 0 ]]; then
          _fail "mutation-test: with the ambiguous branch neutered, record-check should hard-fail (nonzero exit) on the same bare-grep exit-1 fixture, but it exited 0"
        else
          _pass "mutation-test: with the ambiguous branch neutered, the same bare-grep exit-1 fixture now records a hard FAIL and exits nonzero (eval correctly goes red without the branch, proving the eval exercises it)"
        fi
      else
        _fail "mutation-test: bare-grep exit-1 fixture did not flip to a hard fail claim value even with the ambiguous branch neutered — the eval may not be exercising the intended branch: $(cat "$TMPDIR_EVAL/rc-mutation-assert.err")"
      fi
    else
      _fail "mutation-test setup: mutated workflow-sidecar.js (recordCheck ambiguous branch) failed a syntax check, refusing to run it: $(cat "$TMPDIR_EVAL/ambiguous-mutation-syntax.err")"
    fi

    # Restore the real compiled branch immediately — never leave the mutated binary in place —
    # and re-run the same fixture to confirm the restored binary classifies it ambiguous again.
    cp "$AMBIGUOUS_SCRATCH/workflow-sidecar.orig.js" "$DIST_SIDECAR"
    flow_agents_node "$WRITER" record-check "$SESSION_DIR" --timestamp "2026-07-05T09:10:30Z" --id ac6-restore-check -- grep -E 'this-pattern-does-not-exist-anywhere' "$FIXTURE_FILE"       >"$TMPDIR_EVAL/rc-restore.out" 2>"$TMPDIR_EVAL/rc-restore.err"
    RESTORE_EXIT=$?
    if node --input-type=module <<NODEOF 2>"$TMPDIR_EVAL/rc-restore-assert.err"
import { readFileSync } from 'node:fs';
const bundle = JSON.parse(readFileSync('${SESSION_DIR}/trust.bundle', 'utf8'));
const claim = bundle.claims.find((c) => c.subjectId && c.subjectId.endsWith('/ac6-restore-check'));
if (!claim) { process.stderr.write('no claim found for the ac6-restore-check check\n'); process.exit(1); }
if (claim.value !== 'not_verified' || "$RESTORE_EXIT" != "0") { process.stderr.write('expected the restored binary to record claim value not_verified and exit 0, got value=' + claim.value + ' exit=$RESTORE_EXIT\n'); process.exit(1); }
NODEOF
    then
      _pass "mutation-test cleanup: the real compiled ambiguous branch is restored and classifies a bare-grep exit-1 as not_verified (exit 0) again"
    else
      _fail "mutation-test cleanup REGRESSION: the ambiguous branch did not come back correctly after restoring the original compiled file: $(cat "$TMPDIR_EVAL/rc-restore-assert.err")"
    fi
  fi
else
  _fail "mutation-test setup: could not locate the compiled build/src/cli/workflow-sidecar.js to mutate for the recordCheck ambiguous branch (ran 'npm run build' first?)"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "record-check integration passed."
  exit 0
fi

echo "record-check integration failed: $errors issue(s)."
exit 1
