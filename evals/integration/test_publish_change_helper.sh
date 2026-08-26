#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/publish-change-helper.js"
TMPDIR_EVAL="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

json_query() {
  node -e 'const fs=require("fs"); let cur=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for (const part of process.argv[2].split(".")) cur=Array.isArray(cur) ? cur[Number(part)] : cur[part]; console.log(cur);' "$1" "$2"
}

echo "=== Publish Change Helper ==="

BODY="$TMPDIR_EVAL/body.md"
cat > "$BODY" <<'MD'
Summary line.

- first item
- second item

```sh
printf 'hello\n'
```

Closes #60
MD

cat > "$TMPDIR_EVAL/render-input.json" <<JSON
{
  "provider": "github",
  "change_provider": {"role": "ChangeProvider", "kind": "github"},
  "title": "Workflow hardening",
  "body_file": "$BODY",
  "expected_closing_refs": ["kontourai/flow-agents#60"]
}
JSON

node "$SCRIPT" render \
  --input-json "$TMPDIR_EVAL/render-input.json" \
  --body-out "$TMPDIR_EVAL/rendered-body.md" \
  > "$TMPDIR_EVAL/rendered.json"
status=$?
[[ "$status" -eq 0 ]] && pass "renders change request successfully" || fail "renders change request successfully"

cmp -s "$BODY" "$TMPDIR_EVAL/rendered-body.md" && pass "body file rendering preserves multiline markdown exactly" || fail "body file rendering preserves multiline markdown exactly"
node -e 'const fs=require("fs"); const expected=fs.readFileSync(process.argv[1],"utf8"); const actual=JSON.parse(fs.readFileSync(process.argv[2],"utf8")).body; process.exit(actual === expected ? 0 : 1);' "$BODY" "$TMPDIR_EVAL/rendered.json"
[[ "$?" -eq 0 ]] && pass "rendered JSON body preserves real multiline text" || fail "rendered JSON body preserves real multiline text"
[[ "$(json_query "$TMPDIR_EVAL/rendered.json" "change_provider.role")" == "ChangeProvider" ]] && pass "rendered request keeps provider-neutral ChangeProvider role" || fail "rendered request keeps provider-neutral ChangeProvider role"

cat > "$TMPDIR_EVAL/closing-pass.json" <<'JSON'
{
  "provider": "github",
  "default_owner": "kontourai",
  "default_repo": "flow-agents",
  "expected_closing_refs": ["#60"],
  "provider_output": {
    "recognized_closing_refs": ["kontourai/flow-agents#60"]
  }
}
JSON

node "$SCRIPT" validate-closing-refs \
  --input-json "$TMPDIR_EVAL/closing-pass.json" \
  > "$TMPDIR_EVAL/closing-pass.out"
status=$?
[[ "$status" -eq 0 ]] && pass "recognized closing refs pass validation" || fail "recognized closing refs pass validation"
[[ "$(json_query "$TMPDIR_EVAL/closing-pass.out" "status")" == "pass" ]] && pass "closing ref pass result is explicit" || fail "closing ref pass result is explicit"

cat > "$TMPDIR_EVAL/closing-missing.json" <<'JSON'
{
  "provider": "github",
  "default_owner": "kontourai",
  "default_repo": "flow-agents",
  "expected_closing_refs": ["#60"],
  "provider_output": {
    "recognized_closing_refs": []
  }
}
JSON

if node "$SCRIPT" validate-closing-refs \
  --input-json "$TMPDIR_EVAL/closing-missing.json" \
  > "$TMPDIR_EVAL/closing-missing.out" \
  2> "$TMPDIR_EVAL/closing-missing.err"; then
  fail "missing recognized closing refs should fail"
elif [[ "$(json_query "$TMPDIR_EVAL/closing-missing.out" "status")" == "fail" ]] && rg -q "missing recognized closing refs" "$TMPDIR_EVAL/closing-missing.err"; then
  pass "missing closing refs fail with actionable output"
else
  fail "missing closing refs failure was not actionable"
fi

cat > "$TMPDIR_EVAL/docs-files.json" <<'JSON'
{"files": ["docs/workflow-usage-guide.md", "docs/work-item-adapters.md"]}
JSON
cat > "$TMPDIR_EVAL/empty-checks.json" <<'JSON'
[]
JSON

node "$SCRIPT" evaluate-provider-checks \
  --change-files-json "$TMPDIR_EVAL/docs-files.json" \
  --provider-checks-json "$TMPDIR_EVAL/empty-checks.json" \
  > "$TMPDIR_EVAL/docs-checks.out"
status=$?
[[ "$status" -eq 0 ]] && pass "docs-only missing provider checks are accepted as skip" || fail "docs-only missing provider checks are accepted as skip"
[[ "$(json_query "$TMPDIR_EVAL/docs-checks.out" "evidence_status")" == "skip" ]] && pass "docs-only missing checks map to evidence skip" || fail "docs-only missing checks map to evidence skip"
[[ "$(json_query "$TMPDIR_EVAL/docs-checks.out" "release_gate_status")" == "not_required" ]] && pass "docs-only missing checks map to release not_required" || fail "docs-only missing checks map to release not_required"

for risk in runtime schema package hook security; do
  case "$risk" in
    runtime) path="scripts/kit.js" ;;
    schema) path="schemas/workflow-evidence.schema.json" ;;
    package) path="package.json" ;;
    hook) path="scripts/hooks/quality-gate.js" ;;
    security) path="security/policy.md" ;;
  esac
  printf '{"files":["%s"]}\n' "$path" > "$TMPDIR_EVAL/$risk-files.json"
  if node "$SCRIPT" evaluate-provider-checks \
    --change-files-json "$TMPDIR_EVAL/$risk-files.json" \
    --provider-checks-json "$TMPDIR_EVAL/empty-checks.json" \
    > "$TMPDIR_EVAL/$risk-checks.out" \
    2> "$TMPDIR_EVAL/$risk-checks.err"; then
    fail "$risk missing provider checks should not pass"
  elif [[ "$(json_query "$TMPDIR_EVAL/$risk-checks.out" "evidence_status")" == "not_verified" ]] \
    && [[ "$(json_query "$TMPDIR_EVAL/$risk-checks.out" "release_gate_status")" == "hold" ]]; then
    pass "$risk missing provider checks map to not_verified and hold"
  else
    fail "$risk missing provider checks did not map to not_verified and hold"
  fi
done

mkdir -p "$TMPDIR_EVAL/final-state"
git -C "$TMPDIR_EVAL/final-state" init -q
git -C "$TMPDIR_EVAL/final-state" config user.email "eval@example.invalid"
git -C "$TMPDIR_EVAL/final-state" config user.name "Publish Helper Eval"
printf 'evidence.json\nrelease.json\ntrust.bundle\n' > "$TMPDIR_EVAL/final-state/.gitignore"
printf 'tracked fixture\n' > "$TMPDIR_EVAL/final-state/tracked.txt"
git -C "$TMPDIR_EVAL/final-state" add .gitignore tracked.txt
git -C "$TMPDIR_EVAL/final-state" commit -qm "seed clean reconciliation fixture"
cat > "$TMPDIR_EVAL/final-state/evidence.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "final-state",
  "updated_at": "2026-05-29T00:00:00Z",
  "verdict": "pass",
  "summary": "Final orchestrated evidence passed.",
  "checks": [
    {"id": "focused-tests", "kind": "test", "status": "pass", "summary": "Focused tests passed."}
  ]
}
JSON
cat > "$TMPDIR_EVAL/final-state/release.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "final-state",
  "updated_at": "2026-05-29T00:00:00Z",
  "decision": "merge",
  "scope": "Final state reconciliation fixture.",
  "summary": "Final release state passed.",
  "evidence_ref": "evidence.json",
  "gates": [
    {"id": "merge", "kind": "merge", "status": "pass", "required": true, "summary": "Merge gate passed.", "evidence_refs": ["evidence.json"]}
  ],
  "rollback_plan": {"status": "not_required", "summary": "Merge-only fixture."}
}
JSON

if node "$SCRIPT" reconcile-final-state "$TMPDIR_EVAL/final-state" > "$TMPDIR_EVAL/reconcile-without-bundle.out"; then
  fail "schema 1.0 evidence without trust.bundle must not confirm reconciliation"
elif [[ "$(json_query "$TMPDIR_EVAL/reconcile-without-bundle.out" "status")" == "not_verified" ]] \
  && rg -q 'trust\.bundle is required' "$TMPDIR_EVAL/reconcile-without-bundle.out"; then
  pass "schema 1.0 evidence without trust.bundle is non-confirming"
else
  fail "missing trust.bundle result was not explicit"
fi

cat > "$TMPDIR_EVAL/final-state/trust.bundle" <<'JSON'
{
  "schemaVersion": 2,
  "source": "publish-change-helper-fixture",
  "claims": [{
    "id": "focused-tests",
    "subjectType": "flow",
    "subjectId": "final-state",
    "claimType": "workflow.check.test",
    "fieldOrBehavior": "focused tests",
    "value": "pass",
    "status": "verified",
    "createdAt": "2026-05-29T00:00:00Z",
    "updatedAt": "2026-05-29T00:00:00Z",
    "metadata": {
      "origin": "check",
      "check_kind": "test",
      "observed_commands": [{
        "command": "npm test",
        "exit_code": 0,
        "output_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "observed_at_commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "worktree_clean": true,
        "verification_workspace_snapshot": {
          "version": 1,
          "kind": "git-worktree",
          "algorithm": "sha256",
          "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "head_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "worktree_clean": true
        }
      }, {
        "command": "npm run lint",
        "exit_code": 0,
        "output_sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "observed_at_commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "worktree_clean": true,
        "verification_workspace_snapshot": {
          "version": 1,
          "kind": "git-worktree",
          "algorithm": "sha256",
          "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "head_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "worktree_clean": true
        }
      }],
      "verification_workspace_snapshot": {
        "version": 1,
        "kind": "git-worktree",
        "algorithm": "sha256",
        "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "head_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "worktree_clean": true
      }
    }
  }],
  "evidence": [{
    "id": "focused-tests-output",
    "claimId": "focused-tests",
    "evidenceType": "test_output",
    "method": "validation",
    "sourceRef": "run:focused-tests",
    "excerptOrSummary": "npm test",
    "observedAt": "2026-05-29T00:00:00Z",
    "collectedBy": "ci",
    "passing": true,
    "execution": {"runner": "bash", "label": "npm test", "exitCode": 0}
  }, {
    "id": "focused-lint-output",
    "claimId": "focused-tests",
    "evidenceType": "test_output",
    "method": "validation",
    "sourceRef": "run:focused-lint",
    "excerptOrSummary": "npm run lint",
    "observedAt": "2026-05-29T00:00:00Z",
    "collectedBy": "ci",
    "passing": true,
    "execution": {"runner": "bash", "label": "npm run lint", "exitCode": 0}
  }],
  "policies": [],
  "events": []
}
JSON

node --input-type=module - "$ROOT/build/src/builder-flow-runtime.js" "$TMPDIR_EVAL/final-state" "$TMPDIR_EVAL/final-state/trust.bundle" <<'NODE'
const [modulePath, projectRoot, bundleFile] = process.argv.slice(2);
const { captureReviewWorkspaceSnapshot } = await import(modulePath);
const fs = await import('node:fs');
const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
const snapshot = captureReviewWorkspaceSnapshot(projectRoot, []);
bundle.claims[0].metadata.verification_workspace_snapshot = snapshot;
for (const observation of bundle.claims[0].metadata.observed_commands) {
  observation.observed_at_commit = snapshot.head_sha;
  observation.worktree_clean = true;
  observation.verification_workspace_snapshot = snapshot;
}
fs.writeFileSync(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);
NODE

node "$SCRIPT" reconcile-final-state "$TMPDIR_EVAL/final-state" > "$TMPDIR_EVAL/reconcile.out"
status=$?
[[ "$status" -eq 0 ]] && pass "valid trust.bundle and release sidecars pass" || fail "valid trust.bundle and release sidecars pass"
[[ "$(json_query "$TMPDIR_EVAL/reconcile.out" "status")" == "pass" ]] && pass "final reconciliation result is explicit" || fail "final reconciliation result is explicit"
[[ "$(json_query "$TMPDIR_EVAL/reconcile.out" "authoritative_refs.0")" == "$TMPDIR_EVAL/final-state/trust.bundle" ]] && pass "trust.bundle is the confirming reconciliation authority" || fail "trust.bundle is the confirming reconciliation authority"

cp -a "$TMPDIR_EVAL/final-state" "$TMPDIR_EVAL/final-state-dirty"
printf 'dirty bytes\n' >> "$TMPDIR_EVAL/final-state-dirty/tracked.txt"
cp -a "$TMPDIR_EVAL/final-state" "$TMPDIR_EVAL/final-state-stale"
printf 'new committed bytes\n' >> "$TMPDIR_EVAL/final-state-stale/tracked.txt"
git -C "$TMPDIR_EVAL/final-state-stale" add tracked.txt
git -C "$TMPDIR_EVAL/final-state-stale" commit -qm "advance current workspace"
cp -a "$TMPDIR_EVAL/final-state" "$TMPDIR_EVAL/final-state-unrelated"
git -C "$TMPDIR_EVAL/final-state-unrelated" checkout --orphan unrelated -q
git -C "$TMPDIR_EVAL/final-state-unrelated" rm -qr --cached .
printf 'unrelated root\n' > "$TMPDIR_EVAL/final-state-unrelated/tracked.txt"
git -C "$TMPDIR_EVAL/final-state-unrelated" add tracked.txt
git -C "$TMPDIR_EVAL/final-state-unrelated" commit -qm "unrelated workspace"
mkdir -p "$TMPDIR_EVAL/final-state-missing-git"
cp "$TMPDIR_EVAL/final-state/release.json" "$TMPDIR_EVAL/final-state-missing-git/release.json"
cp "$TMPDIR_EVAL/final-state/trust.bundle" "$TMPDIR_EVAL/final-state-missing-git/trust.bundle"
for current_state_case in dirty stale unrelated missing-git; do
  if node "$SCRIPT" reconcile-final-state "$TMPDIR_EVAL/final-state-$current_state_case" > "$TMPDIR_EVAL/reconcile-$current_state_case.out"; then
    fail "$current_state_case workspace must not confirm reconciliation"
  elif [[ "$(json_query "$TMPDIR_EVAL/reconcile-$current_state_case.out" "status")" == "not_verified" ]]; then
    pass "$current_state_case workspace is non-confirming"
  else
    fail "$current_state_case workspace result was not explicit"
  fi
done

for reconciliation_case in mixed non-check missing-command-provenance false-evidence nonzero-observation uppercase-output-hash missing-observation extra-observation mismatched-command missing-digest bad-digest bad-version bad-algorithm explicit-command-kind claimtype-command artifact-command-mismatch missing-execution extra-declared-command reordered-declared-command duplicate-declared-command summary-only-command-ref url-only-command-ref; do
  mkdir -p "$TMPDIR_EVAL/final-state-$reconciliation_case"
  cp "$TMPDIR_EVAL/final-state/release.json" "$TMPDIR_EVAL/final-state-$reconciliation_case/release.json"
  cp "$TMPDIR_EVAL/final-state/trust.bundle" "$TMPDIR_EVAL/final-state-$reconciliation_case/trust.bundle"
done
node - "$TMPDIR_EVAL/final-state-mixed/trust.bundle" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims.push({ id: 'failing-check', subjectType: 'flow', subjectId: 'final-state', claimType: 'workflow.check.test', fieldOrBehavior: 'failing check', value: 'fail', status: 'disputed', createdAt: '2026-05-29T00:00:00Z', updatedAt: '2026-05-29T00:00:00Z', metadata: { origin: 'check', check_kind: 'test' } });
bundle.evidence.push({ id: 'failing-check-output', claimId: 'failing-check', evidenceType: 'test_output', method: 'validation', sourceRef: 'run:failing-check', excerptOrSummary: 'npm test', observedAt: '2026-05-29T00:00:00Z', collectedBy: 'ci', passing: false, execution: { runner: 'bash', label: 'npm test', exitCode: 1 } });
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-non-check/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
delete bundle.claims[0].metadata; fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-missing-command-provenance/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
delete bundle.claims[0].metadata.observed_commands;
delete bundle.claims[0].metadata.verification_workspace_snapshot;
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-false-evidence/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.evidence[0].passing = false; fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-nonzero-observation/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].metadata.observed_commands[0].exit_code = 1; fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-uppercase-output-hash/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].metadata.observed_commands[0].output_sha256 = 'A'.repeat(64); fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-missing-observation/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].metadata.observed_commands.pop(); fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-extra-observation/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].metadata.observed_commands.push({ ...bundle.claims[0].metadata.observed_commands[1], command: 'npm run unrelated' });
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-mismatched-command/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].metadata.observed_commands[0].command = 'npm run unrelated'; fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
for snapshot_case in missing-digest bad-digest bad-version bad-algorithm; do
  node - "$TMPDIR_EVAL/final-state-$snapshot_case/trust.bundle" "$snapshot_case" <<'NODE'
const fs = require('node:fs');
const [file, kind] = process.argv.slice(2); const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
const snapshot = bundle.claims[0].metadata.verification_workspace_snapshot;
if (kind === 'missing-digest') delete snapshot.digest;
if (kind === 'bad-digest') snapshot.digest = 'D'.repeat(64);
if (kind === 'bad-version') snapshot.version = 2;
if (kind === 'bad-algorithm') snapshot.algorithm = 'sha512';
for (const observation of bundle.claims[0].metadata.observed_commands) observation.verification_workspace_snapshot = structuredClone(snapshot);
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
done
node - "$TMPDIR_EVAL/final-state-explicit-command-kind/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].metadata.check_kind = 'command';
delete bundle.claims[0].metadata.observed_commands;
delete bundle.claims[0].metadata.verification_workspace_snapshot;
for (const evidence of bundle.evidence) delete evidence.execution;
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-claimtype-command/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].claimType = 'workflow.check.command';
delete bundle.claims[0].metadata.check_kind;
delete bundle.claims[0].metadata.observed_commands;
delete bundle.claims[0].metadata.verification_workspace_snapshot;
for (const evidence of bundle.evidence) delete evidence.execution;
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-artifact-command-mismatch/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].metadata.artifact_refs = [{ kind: 'command', excerpt: 'npm run unrelated', summary: 'Declared command.' }];
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-missing-execution/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].metadata.artifact_refs = [{ kind: 'command', excerpt: 'npm test', summary: 'Declared command.' }];
for (const evidence of bundle.evidence) delete evidence.execution;
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-extra-declared-command/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].metadata.artifact_refs = [{ kind: 'command', excerpt: 'npm test' }, { kind: 'command', excerpt: 'npm run lint' }, { kind: 'command', excerpt: 'npm run unrelated' }];
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-reordered-declared-command/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].metadata.artifact_refs = [{ kind: 'command', excerpt: 'npm run lint' }, { kind: 'command', excerpt: 'npm test' }];
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node - "$TMPDIR_EVAL/final-state-duplicate-declared-command/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].metadata.artifact_refs = [{ kind: 'command', excerpt: 'npm test' }, { kind: 'command', excerpt: 'npm test' }];
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
for command_ref_case in summary-only-command-ref url-only-command-ref; do
  node - "$TMPDIR_EVAL/final-state-$command_ref_case/trust.bundle" "$command_ref_case" <<'NODE'
const fs = require('node:fs');
const [file, kind] = process.argv.slice(2); const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims[0].metadata.check_kind = 'external';
bundle.claims[0].metadata.artifact_refs = [kind === 'summary-only-command-ref'
  ? { kind: 'command', summary: 'A command ran.' }
  : { kind: 'command', url: 'https://example.invalid/command-log' }];
delete bundle.claims[0].metadata.observed_commands;
delete bundle.claims[0].metadata.verification_workspace_snapshot;
for (const evidence of bundle.evidence) delete evidence.execution;
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
done
for reconciliation_case in mixed non-check missing-command-provenance false-evidence nonzero-observation uppercase-output-hash missing-observation extra-observation mismatched-command missing-digest bad-digest bad-version bad-algorithm explicit-command-kind claimtype-command artifact-command-mismatch missing-execution extra-declared-command reordered-declared-command duplicate-declared-command summary-only-command-ref url-only-command-ref; do
  if node "$SCRIPT" reconcile-final-state "$TMPDIR_EVAL/final-state-$reconciliation_case" > "$TMPDIR_EVAL/reconcile-$reconciliation_case.out"; then
    fail "$reconciliation_case trust.bundle must not confirm reconciliation"
  elif [[ "$(json_query "$TMPDIR_EVAL/reconcile-$reconciliation_case.out" "status")" == "not_verified" ]]; then
    pass "$reconciliation_case trust.bundle is non-confirming"
  else
    fail "$reconciliation_case trust.bundle result was not explicit"
  fi
done

cp -a "$TMPDIR_EVAL/final-state" "$TMPDIR_EVAL/final-state-superseded-failure"
node - "$TMPDIR_EVAL/final-state-superseded-failure/trust.bundle" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
bundle.claims.push({ id: 'superseded-failing-check', subjectType: 'flow', subjectId: 'final-state', claimType: 'workflow.check.test', fieldOrBehavior: 'historical failing check', value: 'fail', status: 'disputed', producerStatus: 'superseded', createdAt: '2026-05-29T00:00:00Z', updatedAt: '2026-05-29T00:00:00Z', metadata: { origin: 'check', check_kind: 'test' } });
bundle.evidence.push({ id: 'superseded-failing-output', claimId: 'superseded-failing-check', evidenceType: 'test_output', method: 'validation', sourceRef: 'run:superseded-failing-check', excerptOrSummary: 'npm test', observedAt: '2026-05-29T00:00:00Z', collectedBy: 'ci', passing: false, execution: { runner: 'bash', label: 'npm test', exitCode: 1 } });
fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
if node "$SCRIPT" reconcile-final-state "$TMPDIR_EVAL/final-state-superseded-failure" > "$TMPDIR_EVAL/reconcile-superseded-failure.out" \
  && [[ "$(json_query "$TMPDIR_EVAL/reconcile-superseded-failure.out" "status")" == "pass" ]]; then
  pass "superseded historical failure does not poison current passing checks"
else
  fail "superseded historical failure should not poison current passing checks"
fi

mkdir -p "$TMPDIR_EVAL/final-state-malformed"
cp "$TMPDIR_EVAL/final-state/release.json" "$TMPDIR_EVAL/final-state-malformed/release.json"
printf '{not json\n' > "$TMPDIR_EVAL/final-state-malformed/trust.bundle"
if node "$SCRIPT" reconcile-final-state "$TMPDIR_EVAL/final-state-malformed" > "$TMPDIR_EVAL/reconcile-malformed.out"; then
  fail "malformed trust.bundle must not confirm reconciliation"
elif [[ "$(json_query "$TMPDIR_EVAL/reconcile-malformed.out" "status")" == "not_verified" ]] \
  && rg -q 'trust\.bundle is not valid' "$TMPDIR_EVAL/reconcile-malformed.out"; then
  pass "malformed trust.bundle is non-confirming with an actionable result"
else
  fail "malformed trust.bundle result was not explicit"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "Publish change helper checks passed"
else
  echo "Publish change helper checks failed: $errors"
fi

exit "$errors"
