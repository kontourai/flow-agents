#!/usr/bin/env bash
# test_veritas_governance_adapter.sh - optional Veritas governance adapter coverage
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMPDIR_EVAL="$(mktemp -d)"
errors=0

cleanup() {
  rm -rf "$TMPDIR_EVAL"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

ADAPTER="veritas-governance"
VALIDATOR="validate-workflow-artifacts"
REPO="$TMPDIR_EVAL/repo"
ARTIFACT_DIR="$REPO/.agents/flow-agents/veritas-fixture"
mkdir -p "$ARTIFACT_DIR" "$TMPDIR_EVAL/bin" "$REPO/.veritas"
FAKE_PASS="$ROOT/evals/fixtures/veritas-governance-adapter/fake-veritas-pass.sh"
FAKE_UNCONFIGURED="$ROOT/evals/fixtures/veritas-governance-adapter/fake-veritas-unconfigured.sh"
FAKE_SECRET_FAIL="$ROOT/evals/fixtures/veritas-governance-adapter/fake-veritas-secret-fail.sh"

cat >"$ARTIFACT_DIR/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "veritas-fixture",
  "status": "in_progress",
  "phase": "execution",
  "owner": "eval",
  "created_at": "2026-06-01T00:00:00Z",
  "updated_at": "2026-06-01T00:00:00Z",
  "source_request": "Fixture workflow for Veritas adapter.",
  "artifact_paths": ["state.json", "acceptance.json", "handoff.json"],
  "next_action": {
    "status": "continue",
    "summary": "Run Veritas governance adapter.",
    "target_phase": "verification"
  }
}
JSON

cat >"$ARTIFACT_DIR/acceptance.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "veritas-fixture",
  "source_request": "Fixture workflow for Veritas adapter.",
  "criteria": [
    {
      "id": "veritas-fixture",
      "description": "Veritas evidence is mapped by reference.",
      "status": "pending",
      "evidence_refs": [
        {
          "kind": "artifact",
          "file": "evidence.json",
          "summary": "Veritas evidence sidecar."
        }
      ]
    }
  ],
  "goal_fit": {
    "status": "pending",
    "summary": "Fixture goal fit is pending.",
    "open_gaps": []
  }
}
JSON

cat >"$ARTIFACT_DIR/handoff.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "veritas-fixture",
  "summary": "Fixture handoff for Veritas adapter.",
  "current_state_ref": "state.json",
  "next_steps": ["Run adapter."],
  "blockers": [],
  "warnings": []
}
JSON

PASS_ARTIFACT="$REPO/.veritas/readiness-pass.json"
printf '{"status":"pass","producer":"fake-veritas"}\n' >"$PASS_ARTIFACT"
VERITAS_ARGV_LOG="$TMPDIR_EVAL/pass-argv.log" VERITAS_EXPECT_ROOT="$REPO" \
  flow_agents_node "$ADAPTER" evidence \
    --artifact-dir "$ARTIFACT_DIR" \
    --repo-root "$REPO" \
    --veritas-root "$REPO" \
    --veritas-bin "$FAKE_PASS" \
    --veritas-artifact "$PASS_ARTIFACT" \
    --max-age-seconds 300 >"$TMPDIR_EVAL/pass.out" 2>"$TMPDIR_EVAL/pass.err"
pass_status=$?

if [[ "$pass_status" -eq 0 ]] \
  && rg -q '^readiness --check evidence --working-tree --root ' "$TMPDIR_EVAL/pass-argv.log" \
  && node -e 'const fs=require("fs"); const ev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (ev.verdict!=="pass") process.exit(1); const c=ev.checks[0]; if (c.kind!=="policy" || c.status!=="pass") process.exit(2); if (c.standard_refs[0].standard!=="veritas") process.exit(3); if (ev.external_evidence[0].standard!=="veritas") process.exit(4); if (JSON.stringify(ev).includes("veritas_rule")) process.exit(5);' "$ARTIFACT_DIR/evidence.json"; then
  _pass "adapter invokes configurable Veritas command and maps passing evidence by reference"
else
  _fail "adapter pass case failed: $(cat "$TMPDIR_EVAL/pass.out" "$TMPDIR_EVAL/pass.err" 2>/dev/null)"
fi

if flow_agents_node "$VALIDATOR" --require-sidecars --skip-markdown-validation "$ARTIFACT_DIR" >"$TMPDIR_EVAL/validate-pass.out" 2>"$TMPDIR_EVAL/validate-pass.err"; then
  _pass "adapter-produced evidence sidecar validates"
else
  _fail "adapter-produced evidence sidecar did not validate: $(cat "$TMPDIR_EVAL/validate-pass.out" "$TMPDIR_EVAL/validate-pass.err")"
fi

CUSTOM_EVIDENCE="$TMPDIR_EVAL/custom/evidence.json"
VERITAS_ARGV_LOG="$TMPDIR_EVAL/relative-artifact-argv.log" \
  flow_agents_node "$ADAPTER" evidence \
    --artifact-dir "$ARTIFACT_DIR" \
    --evidence-path "$CUSTOM_EVIDENCE" \
    --repo-root "$REPO" \
    --veritas-bin "$FAKE_PASS" \
    --veritas-artifact ".veritas/readiness-pass.json" \
    --max-age-seconds 300 >"$TMPDIR_EVAL/relative-artifact.out" 2>"$TMPDIR_EVAL/relative-artifact.err"
relative_artifact_status=$?

if [[ "$relative_artifact_status" -eq 0 ]] \
  && node -e 'const fs=require("fs"); const path=require("path"); const ev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const expected=path.resolve(process.argv[2], ".veritas/readiness-pass.json"); if (ev.verdict!=="pass") process.exit(1); if (ev.checks[0].artifact_refs[0].file!==expected) process.exit(2); if (ev.external_evidence[0].ref.file!==expected) process.exit(3);' "$CUSTOM_EVIDENCE" "$REPO"; then
  _pass "relative native artifact resolves against non-default repo root and custom evidence path is honored"
else
  _fail "relative artifact/custom evidence case failed: $(cat "$TMPDIR_EVAL/relative-artifact.out" "$TMPDIR_EVAL/relative-artifact.err" 2>/dev/null)"
fi

if flow_agents_node "$ADAPTER" evidence \
  --artifact-dir "$ARTIFACT_DIR" \
  --repo-root "$REPO" \
  --veritas-bin "$FAKE_UNCONFIGURED" \
  --veritas-artifact "$REPO/.veritas/unconfigured.json" >"$TMPDIR_EVAL/fail.out" 2>"$TMPDIR_EVAL/fail.err" \
  && node -e 'const fs=require("fs"); const ev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (ev.verdict!=="not_verified") process.exit(1); if (ev.checks[0].status!=="not_verified") process.exit(2); if (!/exit status 78/.test(ev.checks[0].summary)) process.exit(3);' "$ARTIFACT_DIR/evidence.json"; then
  _pass "nonzero/unconfigured Veritas records not_verified evidence"
else
  _fail "nonzero Veritas case failed: $(cat "$TMPDIR_EVAL/fail.out" "$TMPDIR_EVAL/fail.err" 2>/dev/null)"
fi

if flow_agents_node "$ADAPTER" evidence \
  --artifact-dir "$ARTIFACT_DIR" \
  --repo-root "$REPO" \
  --veritas-bin "$FAKE_SECRET_FAIL" >"$TMPDIR_EVAL/secret-fail.out" 2>"$TMPDIR_EVAL/secret-fail.err" \
  && node -e 'const fs=require("fs"); const ev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const text=JSON.stringify(ev); if (ev.verdict!=="not_verified") process.exit(1); if (!/exit status 17/.test(ev.checks[0].summary)) process.exit(2); if (/fixture-token-redaction-sentinel|fixture-api-key-redaction-sentinel/.test(text)) process.exit(3); if (!text.includes("[REDACTED]")) process.exit(4); if (!/Output truncated/.test(ev.checks[0].summary)) process.exit(5); if (/detail line 40/.test(text)) process.exit(6);' "$ARTIFACT_DIR/evidence.json"; then
  _pass "nonzero Veritas output is redacted and bounded before persistence"
else
  _fail "secret-bearing nonzero Veritas case failed: $(cat "$TMPDIR_EVAL/secret-fail.out" "$TMPDIR_EVAL/secret-fail.err" 2>/dev/null)"
fi

if flow_agents_node "$ADAPTER" evidence \
  --artifact-dir "$ARTIFACT_DIR" \
  --repo-root "$REPO" \
  --veritas-bin "$TMPDIR_EVAL/bin/not-a-real-veritas" >"$TMPDIR_EVAL/missing-bin.out" 2>"$TMPDIR_EVAL/missing-bin.err" \
  && node -e 'const fs=require("fs"); const ev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (ev.verdict!=="not_verified") process.exit(1); if (!/Unable to run Veritas executable/.test(ev.checks[0].summary)) process.exit(2);' "$ARTIFACT_DIR/evidence.json"; then
  _pass "missing executable records not_verified evidence"
else
  _fail "missing executable case failed: $(cat "$TMPDIR_EVAL/missing-bin.out" "$TMPDIR_EVAL/missing-bin.err" 2>/dev/null)"
fi

MISSING_ARTIFACT="$REPO/.veritas/missing.json"
VERITAS_ARGV_LOG="$TMPDIR_EVAL/missing-artifact-argv.log" \
  flow_agents_node "$ADAPTER" evidence \
    --artifact-dir "$ARTIFACT_DIR" \
    --repo-root "$REPO" \
    --veritas-bin "$FAKE_PASS" \
    --veritas-artifact "$MISSING_ARTIFACT" >"$TMPDIR_EVAL/missing-artifact.out" 2>"$TMPDIR_EVAL/missing-artifact.err"
missing_artifact_status=$?

if [[ "$missing_artifact_status" -eq 0 ]] \
  && node -e 'const fs=require("fs"); const ev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (ev.verdict!=="not_verified") process.exit(1); if (!/expected native artifact is missing/.test(ev.checks[0].summary)) process.exit(2);' "$ARTIFACT_DIR/evidence.json"; then
  _pass "missing native artifact records not_verified evidence"
else
  _fail "missing native artifact case failed: $(cat "$TMPDIR_EVAL/missing-artifact.out" "$TMPDIR_EVAL/missing-artifact.err" 2>/dev/null)"
fi

UNREADABLE_ARTIFACT="$REPO/.veritas/unreadable.json"
printf '{"status":"pass"}\n' >"$UNREADABLE_ARTIFACT"
chmod 000 "$UNREADABLE_ARTIFACT"
VERITAS_ARGV_LOG="$TMPDIR_EVAL/unreadable-argv.log" \
  flow_agents_node "$ADAPTER" evidence \
    --artifact-dir "$ARTIFACT_DIR" \
    --repo-root "$REPO" \
    --veritas-bin "$FAKE_PASS" \
    --veritas-artifact "$UNREADABLE_ARTIFACT" >"$TMPDIR_EVAL/unreadable.out" 2>"$TMPDIR_EVAL/unreadable.err"
unreadable_status=$?
chmod 600 "$UNREADABLE_ARTIFACT"

if [[ "$unreadable_status" -eq 0 ]] \
  && node -e 'const fs=require("fs"); const ev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (ev.verdict!=="not_verified") process.exit(1); if (!/unreadable/.test(ev.checks[0].summary)) process.exit(2);' "$ARTIFACT_DIR/evidence.json"; then
  _pass "unreadable native artifact records not_verified evidence"
else
  _fail "unreadable native artifact case failed: $(cat "$TMPDIR_EVAL/unreadable.out" "$TMPDIR_EVAL/unreadable.err" 2>/dev/null)"
fi

STALE_ARTIFACT="$REPO/.veritas/stale.json"
printf '{"status":"pass"}\n' >"$STALE_ARTIFACT"
touch -t 202001010000 "$STALE_ARTIFACT"
VERITAS_ARGV_LOG="$TMPDIR_EVAL/stale-argv.log" \
  flow_agents_node "$ADAPTER" evidence \
    --artifact-dir "$ARTIFACT_DIR" \
    --repo-root "$REPO" \
    --veritas-bin "$FAKE_PASS" \
    --veritas-artifact "$STALE_ARTIFACT" \
    --max-age-seconds 0 >"$TMPDIR_EVAL/stale.out" 2>"$TMPDIR_EVAL/stale.err"
stale_status=$?

if [[ "$stale_status" -eq 0 ]] \
  && node -e 'const fs=require("fs"); const ev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (ev.verdict!=="not_verified") process.exit(1); if (!/stale/.test(ev.checks[0].summary)) process.exit(2);' "$ARTIFACT_DIR/evidence.json"; then
  _pass "stale native artifact records not_verified evidence"
else
  _fail "stale artifact case failed: $(cat "$TMPDIR_EVAL/stale.out" "$TMPDIR_EVAL/stale.err" 2>/dev/null)"
fi

if flow_agents_node "$ADAPTER" evidence --artifact-dir "$ARTIFACT_DIR" --skip >"$TMPDIR_EVAL/skip.out" 2>"$TMPDIR_EVAL/skip.err" \
  && node -e 'const fs=require("fs"); const ev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (ev.verdict!=="partial") process.exit(1); if (ev.checks[0].status!=="skip") process.exit(2);' "$ARTIFACT_DIR/evidence.json"; then
  _pass "explicit skip records skip evidence"
else
  _fail "skip case failed: $(cat "$TMPDIR_EVAL/skip.out" "$TMPDIR_EVAL/skip.err" 2>/dev/null)"
fi

if flow_agents_node "$ADAPTER" evidence --artifact-dir "$ARTIFACT_DIR" --not-configured >"$TMPDIR_EVAL/not-configured.out" 2>"$TMPDIR_EVAL/not-configured.err" \
  && node -e 'const fs=require("fs"); const ev=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (ev.verdict!=="not_verified") process.exit(1); if (ev.checks[0].status!=="not_verified") process.exit(2); if (!/not configured/.test(ev.checks[0].summary)) process.exit(3);' "$ARTIFACT_DIR/evidence.json"; then
  _pass "no-config path records not_verified evidence"
else
  _fail "not-configured case failed: $(cat "$TMPDIR_EVAL/not-configured.out" "$TMPDIR_EVAL/not-configured.err" 2>/dev/null)"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "Veritas governance adapter integration eval passed."
  exit 0
fi

echo "Veritas governance adapter integration eval failed with $errors error(s)." >&2
exit 1
