#!/usr/bin/env bash
# test_workflow_artifacts.sh - shared-contract artifact quality and E2E smoke tests
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

VALIDATOR="validate-workflow-artifacts"
REPO="$TMPDIR_EVAL/repo"
ARTIFACT_DIR="$REPO/.agents/flow-agents/workflow-contract-e2e"
mkdir -p "$ARTIFACT_DIR"

cat > "$REPO/AGENTS.md" <<'MARKDOWN'
# Test Repo
MARKDOWN

cat > "$ARTIFACT_DIR/workflow-contract-e2e--deliver-plan.md" <<'MARKDOWN'
---
role: plan
parent: workflow-contract-e2e--deliver
created: 2026-05-06T00:00:00Z
---

## Plan

Add deterministic artifact validation and wire it into integration evals.

## Definition Of Done

- **User outcome:** Maintainers can run one local command and know whether delivery artifacts still satisfy the shared contracts.
- **Scope:** Validator, integration smoke test, eval runner wiring, and docs.
- **Acceptance criteria:**
  - [ ] Valid artifact chains pass - Evidence: validator returns exit 0.
  - [ ] Missing Goal Fit fails - Evidence: validator returns non-zero and names Goal Fit.
  - [ ] Green-build-only artifacts fail - Evidence: validator reports acceptance evidence is missing.
  - [ ] Hidden NOT_VERIFIED fails - Evidence: validator reports explicit acceptance is required.
- **Usefulness checks:**
  - [ ] User-facing workflow is documented or discoverable
  - [ ] Local and global/project scope are separated when relevant
  - [ ] Dashboard/UI changes have visual evidence when relevant
  - [ ] Unknown, NOT_VERIFIED, and TODO gaps are resolved or explicitly accepted
- **Stop-short risks:** Static checks could pass while generated artifacts hide missing evidence.
- **Durable docs target:** docs/workflow-eval-strategy.md
- **Sandbox mode:** local-edit

### Wave 1 (parallel)

#### Task: Artifact validator
- **Files:** src/cli/validate-workflow-artifacts.ts
- **Changes:** Validate plan, delivery, and review artifact contracts.
- **Acceptance:** Good fixtures pass and bad fixtures fail with actionable messages.
- **Context:** Shared contracts in context/contracts/.
MARKDOWN

cat > "$ARTIFACT_DIR/workflow-contract-e2e--deliver-review.md" <<'MARKDOWN'
---
role: review
parent: workflow-contract-e2e--deliver
created: 2026-05-06T00:00:00Z
verdict: PASS
---

## Verification Report

Build:     [PASS] flow_agents_node validate-workflow-artifacts fixture, exit 0
Types:     [SKIP] no type checker configured for shell fixtures
Lint:      [SKIP] no linter configured for shell fixtures
Tests:     [PASS] bash evals/integration/test_workflow_artifacts.sh, exit 0
Security:  [SKIP] no production code path touched
Diff:      [PASS] validator and integration fixtures reviewed

### Acceptance Criteria
- [PASS] Valid artifact chains pass - Evidence: validator returned exit 0.
- [PASS] Missing Goal Fit fails - Evidence: validator returned non-zero and named Goal Fit.
- [PASS] Green-build-only artifacts fail - Evidence: validator reported missing acceptance evidence.
- [PASS] Hidden NOT_VERIFIED fails - Evidence: validator required explicit acceptance or routing.

### Goal Fit
- [PASS] User outcome - Evidence: one local integration command covers the artifact chain.
- [PASS] User-facing workflow - Evidence: docs name the command.
- [PASS] Durable docs target - Evidence: docs/workflow-eval-strategy.md.
- [PASS] Stop-short risks - Evidence: negative fixtures cover green-only and hidden NOT_VERIFIED.

### Verdict: PASS
Shared workflow artifacts satisfy the contract.
MARKDOWN

cat > "$ARTIFACT_DIR/workflow-contract-e2e--deliver.md" <<'MARKDOWN'
# Build workflow contract E2E tests

branch: main
worktree: main
created: 2026-05-06T00:00:00Z
status: delivered
type: deliver
iteration: 1

## Plan

See workflow-contract-e2e--deliver-plan.md.

## Definition Of Done

- **User outcome:** Maintainers can run one local command and know whether delivery artifacts still satisfy the shared contracts.
- **Scope:** Validator, integration smoke test, eval runner wiring, and docs.
- **Acceptance criteria:**
  - [x] Valid artifact chains pass - Evidence: validator returns exit 0.
  - [x] Missing Goal Fit fails - Evidence: validator returns non-zero and names Goal Fit.
  - [x] Green-build-only artifacts fail - Evidence: validator reports acceptance evidence is missing.
  - [x] Hidden NOT_VERIFIED fails - Evidence: validator reports explicit acceptance is required.
- **Usefulness checks:**
  - [x] User-facing workflow is documented or discoverable
  - [x] Local and global/project scope are separated when relevant
  - [x] Dashboard/UI changes have visual evidence when relevant
  - [x] Unknown, NOT_VERIFIED, and TODO gaps are resolved or explicitly accepted
- **Stop-short risks:** Static checks could pass while generated artifacts hide missing evidence.
- **Durable docs target:** docs/workflow-eval-strategy.md
- **Sandbox mode:** local-edit

## Execution Progress

### Wave 1 (completed)
- [x] Artifact validator - done
- [x] Integration fixtures - done

## Verification Report

Build:     [PASS] flow_agents_node validate-workflow-artifacts fixture, exit 0
Types:     [SKIP] no type checker configured for shell fixtures
Lint:      [SKIP] no linter configured for shell fixtures
Tests:     [PASS] bash evals/integration/test_workflow_artifacts.sh, exit 0
Security:  [SKIP] no production code path touched
Diff:      [PASS] validator and integration fixtures reviewed

### Acceptance Criteria
- [PASS] Valid artifact chains pass - Evidence: validator returned exit 0.
- [PASS] Missing Goal Fit fails - Evidence: validator returned non-zero and named Goal Fit.
- [PASS] Green-build-only artifacts fail - Evidence: validator reported missing acceptance evidence.
- [PASS] Hidden NOT_VERIFIED fails - Evidence: validator required explicit acceptance or routing.

### Goal Fit
- [PASS] User outcome - Evidence: one local integration command covers the artifact chain.
- [PASS] User-facing workflow - Evidence: docs name the command.
- [PASS] Durable docs target - Evidence: docs/workflow-eval-strategy.md.
- [PASS] Stop-short risks - Evidence: negative fixtures cover green-only and hidden NOT_VERIFIED.

### Verdict: PASS
Shared workflow artifacts satisfy the contract.

## Goal Fit Gate

- [x] Original user goal restated
- [x] Every acceptance criterion has evidence
- [x] User-facing workflow was exercised or documented
- [x] Local/project and global scope are handled when relevant
- [x] Unknown, NOT_VERIFIED, and TODO gaps are resolved or explicitly accepted
- [x] Dashboard/UI changes have visual evidence when relevant
- [x] Durable docs target is updated, scheduled for final acceptance, or marked not needed with reason

## Final Acceptance

- [x] CI/relevant checks passed
- [x] Merge/release decision recorded
- [x] Working artifacts archived or linked
- [x] Long-lived docs updated with why and how the feature was built
- [x] Follow-up issues or learning-review items created for deferred work
MARKDOWN

cat > "$ARTIFACT_DIR/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "workflow-contract-e2e",
  "status": "delivered",
  "phase": "done",
  "created_at": "2026-05-06T00:00:00Z",
  "updated_at": "2026-05-06T00:00:00Z",
  "artifact_paths": [
    "workflow-contract-e2e--deliver.md",
    "workflow-contract-e2e--deliver-plan.md",
    "workflow-contract-e2e--deliver-review.md"
  ],
  "next_action": {
    "status": "done",
    "summary": "Workflow artifact contract fixtures pass validation."
  }
}
JSON

cat > "$ARTIFACT_DIR/acceptance.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "workflow-contract-e2e",
  "source_request": "Build workflow contract E2E tests.",
  "criteria": [
    {
      "id": "valid-chain-passes",
      "description": "Valid artifact chains pass.",
      "status": "pass",
      "evidence_refs": [
        {
          "kind": "artifact",
          "file": "workflow-contract-e2e--deliver-review.md",
          "summary": "Verification artifact for the valid chain."
        }
      ]
    },
    {
      "id": "missing-goal-fit-fails",
      "description": "Missing Goal Fit fails.",
      "status": "pass",
      "evidence_refs": [
        {
          "kind": "source",
          "file": "evals/integration/test_workflow_artifacts.sh",
          "line_start": 1,
          "line_end": 1,
          "excerpt": "test_workflow_artifacts.sh - shared-contract artifact quality and E2E smoke tests"
        }
      ]
    },
    {
      "id": "green-build-only-fails",
      "description": "Green-build-only artifacts fail.",
      "status": "pass",
      "evidence_refs": [
        {
          "kind": "source",
          "file": "evals/integration/test_workflow_artifacts.sh",
          "line_start": 1,
          "line_end": 1,
          "excerpt": "test_workflow_artifacts.sh - shared-contract artifact quality and E2E smoke tests"
        }
      ]
    },
    {
      "id": "hidden-not-verified-fails",
      "description": "Hidden NOT_VERIFIED fails.",
      "status": "pass",
      "evidence_refs": [
        {
          "kind": "source",
          "file": "evals/integration/test_workflow_artifacts.sh",
          "line_start": 1,
          "line_end": 1,
          "excerpt": "test_workflow_artifacts.sh - shared-contract artifact quality and E2E smoke tests"
        }
      ]
    }
  ],
  "goal_fit": {
    "status": "pass",
    "summary": "Maintainers can run one local command and validate workflow artifacts."
  }
}
JSON

cat > "$ARTIFACT_DIR/evidence.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "workflow-contract-e2e",
  "verdict": "pass",
  "checks": [
    {
      "id": "workflow-artifact-validator",
      "kind": "test",
      "status": "pass",
      "command": "flow_agents_node validate-workflow-artifacts fixture",
      "summary": "Valid Markdown artifacts and sidecars pass.",
      "artifact_refs": [
        {
          "kind": "artifact",
          "file": "workflow-contract-e2e--deliver.md",
          "summary": "Delivery artifact validated by the workflow artifact validator."
        }
      ],
      "standard_refs": [
        {
          "standard": "junit",
          "ref": "reports/workflow-artifact-validator.xml",
          "role": "mapping",
          "summary": "JUnit-style test evidence can be linked without flattening it."
        }
      ]
    }
  ],
  "external_evidence": [
    {
      "system": "veritas",
      "ref": {
        "kind": "external",
        "url": "veritas://proof-lanes/workflow-contract-e2e",
        "summary": "Optional Veritas proof-lane reference."
      },
      "summary": "Optional Veritas proof-lane reference.",
      "standard": "veritas"
    }
  ],
  "not_verified_gaps": []
}
JSON

cat > "$ARTIFACT_DIR/handoff.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "workflow-contract-e2e",
  "summary": "Workflow artifact validation is complete.",
  "current_state_ref": "state.json",
  "next_steps": [
    "Keep sidecar schemas aligned with the Markdown workflow contracts."
  ],
  "blockers": [],
  "warnings": []
}
JSON

cat > "$ARTIFACT_DIR/critique.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "workflow-contract-e2e",
  "status": "pass",
  "required": true,
  "updated_at": "2026-05-06T00:00:00Z",
  "critiques": [
    {
      "id": "workflow-contract-review",
      "reviewer": "tool-code-reviewer",
      "reviewed_at": "2026-05-06T00:00:00Z",
      "verdict": "pass",
      "summary": "No blocking findings in the workflow artifact fixture.",
      "artifact_refs": ["workflow-contract-e2e--deliver.md"],
      "findings": []
    }
  ]
}
JSON

cat > "$ARTIFACT_DIR/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "workflow-contract-e2e",
  "status": "learned",
  "updated_at": "2026-05-06T00:00:00Z",
  "records": [
    {
      "id": "workflow-contract-fixture",
      "recorded_at": "2026-05-06T00:00:00Z",
      "source_refs": ["workflow-contract-e2e--deliver.md", "evidence.json"],
      "outcome": "success",
      "facts": ["The workflow artifact validator accepted the complete fixture chain."],
      "interpretation": "A passing learning record can route completed workflow evidence into durable system improvements.",
      "routing": [
        {
          "target": "eval",
          "action": "Keep workflow artifact fixture coverage in integration tests.",
          "status": "completed",
          "ref": "evals/integration/test_workflow_artifacts.sh"
        }
      ],
      "correction": {
        "needed": false,
        "evidence": "The complete fixture chain matched intended workflow artifact behavior."
      }
    }
  ]
}
JSON

cat > "$ARTIFACT_DIR/release.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "workflow-contract-e2e",
  "decision": "merge",
  "updated_at": "2026-05-06T00:00:00Z",
  "scope": "Workflow artifact validator fixtures and sidecar schemas.",
  "evidence_ref": "evidence.json",
  "gates": [
    {
      "name": "merge",
      "status": "pass",
      "summary": "Local static and integration checks passed.",
      "evidence_refs": ["evidence.json"]
    },
    {
      "name": "docs",
      "status": "pass",
      "summary": "Workflow docs are updated.",
      "evidence_refs": ["docs/workflow-eval-strategy.md"]
    }
  ],
  "rollback_plan": {
    "status": "not_required",
    "summary": "No deployment occurs for this fixture.",
    "owner": "maintainer"
  },
  "observability_plan": {
    "status": "not_required",
    "summary": "No runtime surface changes."
  },
  "post_deploy_checks": [],
  "docs": {
    "status": "updated",
    "summary": "Fixture coverage documents release readiness sidecar validation.",
    "refs": ["evals/integration/test_workflow_artifacts.sh"]
  }
}
JSON

if flow_agents_node "$VALIDATOR" --require-sidecars --require-critique "$ARTIFACT_DIR" >"$TMPDIR_EVAL/valid.out" 2>"$TMPDIR_EVAL/valid.err"; then
  _pass "valid plan/review/delivery artifact chain and sidecars pass"
else
  _fail "valid artifact chain failed: $(cat "$TMPDIR_EVAL/valid.out" "$TMPDIR_EVAL/valid.err")"
fi

BAD="$TMPDIR_EVAL/bad"
mkdir -p "$BAD"

cat > "$BAD/missing-goal-fit--deliver.md" <<'MARKDOWN'
# Missing Goal Fit

status: delivered
type: deliver

## Plan
Plan exists.

## Definition Of Done
- **User outcome:** User can inspect the result.
- **Acceptance criteria:**
  - [x] It works - Evidence: test output
- **Stop-short risks:** Goal Fit could be missing.
- **Durable docs target:** docs/test.md

## Verification Report
Build: [PASS] test

### Acceptance Criteria
- [PASS] It works - Evidence: test output.

### Verdict: PASS

## Final Acceptance
- [x] CI/relevant checks passed
MARKDOWN

if flow_agents_node "$VALIDATOR" "$BAD/missing-goal-fit--deliver.md" >"$TMPDIR_EVAL/missing.out" 2>&1; then
  _fail "missing Goal Fit artifact should fail"
elif rg -q 'Goal Fit' "$TMPDIR_EVAL/missing.out"; then
  _pass "missing Goal Fit artifact fails with actionable message"
else
  _fail "missing Goal Fit failure did not mention Goal Fit"
fi

cat > "$BAD/missing-sandbox--deliver-plan.md" <<'MARKDOWN'
---
role: plan
created: 2026-05-06T00:00:00Z
---

## Plan
Plan exists.

## Definition Of Done
- **User outcome:** User can inspect the result.
- **Acceptance criteria:**
  - [ ] It works - Evidence: test output
- **Stop-short risks:** Execution boundary could be ambiguous.
- **Durable docs target:** docs/test.md

### Wave 1 (parallel)

#### Task: Test
- **Files:** test.txt
- **Changes:** Test fixture.
- **Acceptance:** Validator reports missing sandbox mode.
MARKDOWN

if flow_agents_node "$VALIDATOR" "$BAD/missing-sandbox--deliver-plan.md" >"$TMPDIR_EVAL/missing-sandbox.out" 2>&1; then
  _fail "missing Sandbox mode artifact should fail"
elif rg -q 'Sandbox mode' "$TMPDIR_EVAL/missing-sandbox.out"; then
  _pass "missing Sandbox mode artifact fails with actionable message"
else
  _fail "missing Sandbox mode failure did not mention Sandbox mode"
fi

cat > "$BAD/invalid-sandbox--deliver-plan.md" <<'MARKDOWN'
---
role: plan
created: 2026-05-06T00:00:00Z
---

## Plan
Plan exists.

## Definition Of Done
- **User outcome:** User can inspect the result.
- **Acceptance criteria:**
  - [ ] It works - Evidence: test output
- **Stop-short risks:** Execution boundary could be ambiguous.
- **Durable docs target:** docs/test.md
- **Sandbox mode:** global-admin

### Wave 1 (parallel)

#### Task: Test
- **Files:** test.txt
- **Changes:** Test fixture.
- **Acceptance:** Validator reports invalid sandbox mode.
MARKDOWN

if flow_agents_node "$VALIDATOR" "$BAD/invalid-sandbox--deliver-plan.md" >"$TMPDIR_EVAL/invalid-sandbox.out" 2>&1; then
  _fail "invalid Sandbox mode artifact should fail"
elif rg -q 'invalid Sandbox mode' "$TMPDIR_EVAL/invalid-sandbox.out"; then
  _pass "invalid Sandbox mode artifact fails with actionable message"
else
  _fail "invalid Sandbox mode failure did not mention invalid Sandbox mode"
fi

cat > "$BAD/green-only--deliver.md" <<'MARKDOWN'
# Green Build Only

status: delivered
type: deliver

## Plan
Plan exists.

## Definition Of Done
- **User outcome:** User can act on the dashboard.
- **Acceptance criteria:**
  - [x] Build passes - Evidence: build output
- **Stop-short risks:** Build could pass while the dashboard is not useful.
- **Durable docs target:** docs/test.md

## Verification Report
Build: PASS
Verdict: PASS

## Goal Fit Gate
- [x] Original user goal restated

## Final Acceptance
- [x] CI/relevant checks passed
MARKDOWN

if flow_agents_node "$VALIDATOR" "$BAD/green-only--deliver.md" >"$TMPDIR_EVAL/green.out" 2>&1; then
  _fail "green-build-only artifact should fail"
elif rg -q 'green build is not enough' "$TMPDIR_EVAL/green.out"; then
  _pass "green-build-only artifact fails usefulness gate"
else
  _fail "green-build-only failure did not mention usefulness gate"
fi

cat > "$BAD/hidden-not-verified--deliver.md" <<'MARKDOWN'
# Hidden NOT_VERIFIED

status: delivered
type: deliver

## Plan
Plan exists.

## Definition Of Done
- **User outcome:** User can rely on verification.
- **Acceptance criteria:**
  - [x] Browser checked - Evidence: attempted screenshot
- **Stop-short risks:** Browser check might be unavailable.
- **Durable docs target:** docs/test.md

## Verification Report
Build: [PASS] test

### Acceptance Criteria
- [NOT_VERIFIED] Browser checked - browser was unavailable.

### Verdict: PASS

## Goal Fit Gate
- [x] Original user goal restated
- [x] Every acceptance criterion has evidence

## Final Acceptance
- [x] CI/relevant checks passed
MARKDOWN

if flow_agents_node "$VALIDATOR" "$BAD/hidden-not-verified--deliver.md" >"$TMPDIR_EVAL/notverified.out" 2>&1; then
  _fail "hidden NOT_VERIFIED artifact should fail"
elif rg -q 'NOT_VERIFIED' "$TMPDIR_EVAL/notverified.out"; then
  _pass "hidden NOT_VERIFIED artifact requires explicit decision"
else
  _fail "hidden NOT_VERIFIED failure did not mention NOT_VERIFIED"
fi

mkdir -p "$BAD/bad-sidecar"
cat > "$BAD/bad-sidecar/evidence.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "bad-sidecar",
  "verdict": "maybe",
  "checks": []
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/bad-sidecar" >"$TMPDIR_EVAL/bad-sidecar.out" 2>&1; then
  _fail "bad sidecar should fail"
elif rg -q 'verdict must be one of: pass, partial, fail, not_verified' "$TMPDIR_EVAL/bad-sidecar.out"; then
  _pass "bad sidecar fails with actionable message"
else
  _fail "bad sidecar failure did not mention verdict"
fi

mkdir -p "$BAD/contradictory-evidence"
cat > "$BAD/contradictory-evidence/evidence.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "contradictory-evidence",
  "verdict": "pass",
  "checks": [
    {
      "id": "failing-check",
      "kind": "test",
      "status": "fail",
      "summary": "A failing check cannot produce a pass verdict."
    }
  ]
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/contradictory-evidence" >"$TMPDIR_EVAL/contradictory-evidence.out" 2>&1; then
  _fail "contradictory evidence sidecar should fail"
elif rg -q 'pass verdict requires all non-skipped checks to pass' "$TMPDIR_EVAL/contradictory-evidence.out"; then
  _pass "contradictory evidence sidecar fails with actionable message"
else
  _fail "contradictory evidence failure did not mention pass verdict"
fi

mkdir -p "$BAD/empty-evidence"
cat > "$BAD/empty-evidence/evidence.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "empty-evidence",
  "verdict": "pass",
  "checks": []
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/empty-evidence" >"$TMPDIR_EVAL/empty-evidence.out" 2>&1; then
  _fail "pass evidence with no checks should fail"
elif rg -q 'checks must contain at least 1 item' "$TMPDIR_EVAL/empty-evidence.out"; then
  _pass "pass evidence with no checks fails with actionable message"
else
  _fail "empty evidence failure did not mention checks"
fi

mkdir -p "$BAD/bad-standard-ref"
cat > "$BAD/bad-standard-ref/evidence.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "bad-standard-ref",
  "verdict": "pass",
  "checks": [
    {
      "id": "unknown-standard",
      "kind": "policy",
      "status": "pass",
      "summary": "Unknown standards should not pass validation.",
      "standard_refs": [
        {
          "standard": "spreadsheet",
          "ref": "proof.xlsx"
        }
      ]
    }
  ]
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/bad-standard-ref" >"$TMPDIR_EVAL/bad-standard-ref.out" 2>&1; then
  _fail "unknown evidence standard should fail"
elif rg -q 'standard must be one of' "$TMPDIR_EVAL/bad-standard-ref.out"; then
  _pass "evidence sidecar rejects unknown standard refs"
else
  _fail "bad standard ref failure did not mention standard"
fi

mkdir -p "$BAD/legacy-string-ref"
cat > "$BAD/legacy-string-ref/acceptance.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "legacy-string-ref",
  "source_request": "Legacy refs are rejected.",
  "criteria": [
    {
      "id": "legacy-string-ref",
      "description": "Legacy string evidence refs fail validation.",
      "status": "pass",
      "evidence_refs": ["evidence.json"]
    }
  ],
  "goal_fit": {
    "status": "pass",
    "summary": "Legacy refs are rejected."
  }
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/legacy-string-ref" >"$TMPDIR_EVAL/legacy-string-ref.out" 2>&1; then
  _fail "legacy string evidence refs should fail"
elif rg -q 'evidence_refs\[0\] must be object' "$TMPDIR_EVAL/legacy-string-ref.out"; then
  _pass "custom validator rejects legacy string evidence refs"
else
  _fail "legacy string ref failure did not mention object refs"
fi

mkdir -p "$BAD/source-missing-required"
cat > "$BAD/source-missing-required/evidence.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "source-missing-required",
  "verdict": "pass",
  "checks": [
    {
      "id": "source-missing-required",
      "kind": "test",
      "status": "pass",
      "summary": "Source refs must include line and excerpt fields.",
      "artifact_refs": [
        {
          "kind": "source",
          "file": "src/index.ts"
        }
      ]
    }
  ]
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/source-missing-required" >"$TMPDIR_EVAL/source-missing-required.out" 2>&1; then
  _fail "source ref missing required fields should fail"
elif rg -q 'line_start is required|line_end is required|excerpt is required' "$TMPDIR_EVAL/source-missing-required.out"; then
  _pass "custom validator rejects source refs missing required fields"
else
  _fail "source missing required failure did not mention source fields"
fi

mkdir -p "$BAD/empty-non-source-ref"
cat > "$BAD/empty-non-source-ref/evidence.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "empty-non-source-ref",
  "verdict": "pass",
  "checks": [
    {
      "id": "empty-non-source-ref",
      "kind": "test",
      "status": "pass",
      "summary": "Empty non-source refs must fail.",
      "artifact_refs": [
        {
          "kind": "artifact"
        },
        {
          "kind": "command"
        }
      ]
    }
  ],
  "external_evidence": [
    {
      "system": "provider",
      "ref": {
        "kind": "provider"
      },
      "summary": "Provider refs need URLs.",
      "standard": "custom"
    }
  ]
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/empty-non-source-ref" >"$TMPDIR_EVAL/empty-non-source-ref.out" 2>&1; then
  _fail "empty non-source refs should fail"
elif rg -q 'must match at least one allowed schema|url is required' "$TMPDIR_EVAL/empty-non-source-ref.out"; then
  _pass "custom validator rejects empty non-source evidence refs"
else
  _fail "empty non-source ref failure did not mention required ref detail"
fi

mkdir -p "$BAD/open-critique"
cat > "$BAD/open-critique/critique.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "open-critique",
  "status": "pass",
  "required": true,
  "updated_at": "2026-05-06T00:00:00Z",
  "critiques": [
    {
      "id": "blocking-review",
      "reviewer": "tool-code-reviewer",
      "reviewed_at": "2026-05-06T00:00:00Z",
      "verdict": "fail",
      "summary": "A medium severity finding is still open.",
      "findings": [
        {
          "id": "medium-open",
          "severity": "medium",
          "status": "open",
          "description": "Open findings must be resolved before critique can pass."
        }
      ]
    }
  ]
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/open-critique" >"$TMPDIR_EVAL/open-critique.out" 2>&1; then
  _fail "critique pass with open finding should fail"
elif rg -q 'critique pass cannot have open findings' "$TMPDIR_EVAL/open-critique.out"; then
  _pass "critique sidecar blocks open findings"
else
  _fail "open critique failure did not mention open findings"
fi

mkdir -p "$BAD/bad-learning"
cat > "$BAD/bad-learning/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "bad-learning",
  "status": "learned",
  "updated_at": "2026-05-06T00:00:00Z",
  "records": [
    {
      "id": "missing-source",
      "recorded_at": "2026-05-06T00:00:00Z",
      "source_refs": [],
      "outcome": "success",
      "facts": ["A learning record without evidence should fail."],
      "interpretation": "Learning must be traceable.",
      "routing": [
        {
          "target": "eval",
          "action": "Reject untraceable learning records.",
          "status": "open"
        }
      ]
    }
  ]
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/bad-learning" >"$TMPDIR_EVAL/bad-learning.out" 2>&1; then
  _fail "learning record without source refs should fail"
elif rg -q 'source_refs must contain at least 1 item' "$TMPDIR_EVAL/bad-learning.out"; then
  _pass "learning sidecar requires traceable source refs"
else
  _fail "bad learning failure did not mention source refs"
fi

mkdir -p "$BAD/empty-learning"
cat > "$BAD/empty-learning/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "empty-learning",
  "status": "learned",
  "updated_at": "2026-05-06T00:00:00Z",
  "records": []
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/empty-learning" >"$TMPDIR_EVAL/empty-learning.out" 2>&1; then
  _fail "learned status with no records should fail"
elif rg -q 'records must contain at least 1 item' "$TMPDIR_EVAL/empty-learning.out"; then
  _pass "learning sidecar requires at least one record"
else
  _fail "empty learning failure did not mention records"
fi

mkdir -p "$BAD/learned-missing-correction"
cat > "$BAD/learned-missing-correction/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "learned-missing-correction",
  "status": "learned",
  "updated_at": "2026-05-06T00:00:00Z",
  "records": [
    {
      "id": "missing-correction",
      "recorded_at": "2026-05-06T00:00:00Z",
      "source_refs": ["evidence.json"],
      "outcome": "success",
      "facts": ["Terminal learned records must include a correction decision."],
      "interpretation": "Learned closeout cannot omit correction.needed.",
      "routing": [
        {
          "target": "none",
          "action": "No follow-up.",
          "status": "completed"
        }
      ]
    }
  ]
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/learned-missing-correction" >"$TMPDIR_EVAL/learned-missing-correction.out" 2>&1; then
  _fail "learned status without correction should fail"
elif rg -q 'correction.*needed.*required' "$TMPDIR_EVAL/learned-missing-correction.out"; then
  _pass "learning sidecar requires correction decision for learned status"
else
  _fail "missing correction failure did not mention correction.needed"
fi

mkdir -p "$BAD/open-learning-routing"
cat > "$BAD/open-learning-routing/learning.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "open-learning-routing",
  "status": "learned",
  "updated_at": "2026-05-06T00:00:00Z",
  "records": [
    {
      "id": "open-routing",
      "recorded_at": "2026-05-06T00:00:00Z",
      "source_refs": ["evidence.json"],
      "outcome": "mixed",
      "facts": ["A follow-up remains open."],
      "interpretation": "Open learning routing should keep the top-level status from being learned.",
      "routing": [
        {
          "target": "backlog",
          "action": "Create a follow-up issue.",
          "status": "open"
        }
      ]
    }
  ]
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/open-learning-routing" >"$TMPDIR_EVAL/open-learning-routing.out" 2>&1; then
  _fail "learned status with open routing should fail"
elif rg -q 'learning status learned cannot have open routing' "$TMPDIR_EVAL/open-learning-routing.out"; then
  _pass "learning sidecar keeps open routing out of learned status"
else
  _fail "open learning routing failure did not mention status"
fi

mkdir -p "$BAD/bad-release-gate"
cat > "$BAD/bad-release-gate/release.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "bad-release-gate",
  "decision": "merge",
  "updated_at": "2026-05-06T00:00:00Z",
  "scope": "Bad release fixture.",
  "evidence_ref": "evidence.json",
  "gates": [
    {
      "name": "merge",
      "status": "not_verified",
      "summary": "CI was not verified."
    }
  ],
  "rollback_plan": {
    "status": "not_required",
    "summary": "No deploy.",
    "owner": "maintainer"
  },
  "observability_plan": {
    "status": "not_required",
    "summary": "No runtime surface."
  },
  "post_deploy_checks": [],
  "docs": {
    "status": "updated",
    "summary": "Docs are irrelevant for this negative fixture."
  }
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/bad-release-gate" >"$TMPDIR_EVAL/bad-release-gate.out" 2>&1; then
  _fail "positive release decision with non-pass gate should fail"
elif rg -q 'positive release decision requires all required gates to pass' "$TMPDIR_EVAL/bad-release-gate.out"; then
  _pass "release sidecar blocks positive decisions with non-pass gates"
else
  _fail "bad release gate failure did not mention gate pass"
fi

mkdir -p "$BAD/bad-deploy-release"
cat > "$BAD/bad-deploy-release/release.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "bad-deploy-release",
  "decision": "deploy",
  "updated_at": "2026-05-06T00:00:00Z",
  "scope": "Bad deploy fixture.",
  "evidence_ref": "evidence.json",
  "gates": [
    {
      "name": "deploy",
      "status": "pass",
      "summary": "Deploy gate claims pass."
    }
  ],
  "rollback_plan": {
    "status": "missing",
    "summary": "Rollback is missing.",
    "owner": "maintainer"
  },
  "observability_plan": {
    "status": "missing",
    "summary": "Observability is missing."
  },
  "post_deploy_checks": [],
  "docs": {
    "status": "updated",
    "summary": "Docs are irrelevant for this negative fixture."
  }
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/bad-deploy-release" >"$TMPDIR_EVAL/bad-deploy-release.out" 2>&1; then
  _fail "deploy decision without operational plans should fail"
elif rg -q 'deploy decision requires rollback_plan status ready' "$TMPDIR_EVAL/bad-deploy-release.out" && rg -q 'deploy decision requires post_deploy_checks' "$TMPDIR_EVAL/bad-deploy-release.out"; then
  _pass "release sidecar requires deploy rollback and post-deploy checks"
else
  _fail "bad deploy release failure did not mention operational plans"
fi

mkdir -p "$BAD/bad-deploy-missing-gate"
cat > "$BAD/bad-deploy-missing-gate/release.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "bad-deploy-missing-gate",
  "decision": "deploy",
  "updated_at": "2026-05-06T00:00:00Z",
  "scope": "Bad deploy missing gate fixture.",
  "evidence_ref": "evidence.json",
  "gates": [
    {
      "name": "merge",
      "status": "pass",
      "summary": "Merge gate passed, but deploy gate is missing."
    }
  ],
  "rollback_plan": {
    "status": "ready",
    "summary": "Rollback is ready.",
    "owner": "maintainer"
  },
  "observability_plan": {
    "status": "ready",
    "summary": "Observability is ready."
  },
  "post_deploy_checks": [
    {
      "id": "smoke",
      "status": "planned",
      "summary": "Smoke test is planned."
    }
  ],
  "docs": {
    "status": "updated",
    "summary": "Docs are irrelevant for this negative fixture."
  }
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/bad-deploy-missing-gate" >"$TMPDIR_EVAL/bad-deploy-missing-gate.out" 2>&1; then
  _fail "deploy decision without deploy gate should fail"
elif rg -q 'positive release decision requires deploy gate to pass' "$TMPDIR_EVAL/bad-deploy-missing-gate.out"; then
  _pass "release sidecar requires matching gate for positive decisions"
else
  _fail "bad deploy missing gate failure did not mention matching gate"
fi

mkdir -p "$BAD/bad-deploy-check"
cat > "$BAD/bad-deploy-check/release.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "bad-deploy-check",
  "decision": "deploy",
  "updated_at": "2026-05-06T00:00:00Z",
  "scope": "Bad deploy check fixture.",
  "evidence_ref": "evidence.json",
  "gates": [
    {
      "name": "deploy",
      "status": "pass",
      "summary": "Deploy gate passed."
    }
  ],
  "rollback_plan": {
    "status": "ready",
    "summary": "Rollback is ready.",
    "owner": "maintainer"
  },
  "observability_plan": {
    "status": "ready",
    "summary": "Observability is ready."
  },
  "post_deploy_checks": [
    {
      "id": "smoke",
      "status": "fail",
      "summary": "Smoke test failed."
    }
  ],
  "docs": {
    "status": "updated",
    "summary": "Docs are irrelevant for this negative fixture."
  }
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/bad-deploy-check" >"$TMPDIR_EVAL/bad-deploy-check.out" 2>&1; then
  _fail "deploy decision with failed post-deploy check should fail"
elif rg -q 'deploy decision requires post_deploy_checks to be planned or pass' "$TMPDIR_EVAL/bad-deploy-check.out"; then
  _pass "release sidecar rejects failed deploy checks"
else
  _fail "bad deploy check failure did not mention post-deploy status"
fi

mkdir -p "$BAD/missing-sidecars"
cp "$ARTIFACT_DIR/workflow-contract-e2e--deliver.md" "$BAD/missing-sidecars/missing-sidecars--deliver.md"

if flow_agents_node "$VALIDATOR" --require-sidecars "$BAD/missing-sidecars" >"$TMPDIR_EVAL/missing-sidecars.out" 2>&1; then
  _fail "missing required sidecars should fail"
elif rg -q 'required sidecar is missing' "$TMPDIR_EVAL/missing-sidecars.out"; then
  _pass "missing required sidecars fail with actionable message"
else
  _fail "missing sidecar failure did not mention required sidecar"
fi

mkdir -p "$BAD/mismatched-sidecars"
cat > "$BAD/mismatched-sidecars/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "left",
  "status": "planned",
  "phase": "planning",
  "updated_at": "2026-05-06T00:00:00Z",
  "next_action": {
    "status": "continue",
    "summary": "Continue."
  }
}
JSON
cat > "$BAD/mismatched-sidecars/acceptance.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "right",
  "criteria": [
    {
      "id": "criterion",
      "description": "Criterion.",
      "status": "pending"
    }
  ],
  "goal_fit": {
    "status": "pending",
    "summary": "Pending."
  }
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/mismatched-sidecars" >"$TMPDIR_EVAL/mismatched-sidecars.out" 2>&1; then
  _fail "mismatched sidecar task slugs should fail"
elif rg -q 'sidecar task_slug mismatch' "$TMPDIR_EVAL/mismatched-sidecars.out"; then
  _pass "mismatched sidecar task slugs fail with actionable message"
else
  _fail "mismatched sidecar failure did not mention task_slug"
fi

mkdir -p "$BAD/bad-date"
cat > "$BAD/bad-date/state.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "bad-date",
  "status": "planned",
  "phase": "planning",
  "updated_at": "2026-05-06T00:00:00",
  "next_action": {
    "status": "continue",
    "summary": "Continue."
  }
}
JSON

if flow_agents_node "$VALIDATOR" "$BAD/bad-date" >"$TMPDIR_EVAL/bad-date.out" 2>&1; then
  _fail "date-time without timezone should fail"
elif rg -q 'updated_at must be date-time' "$TMPDIR_EVAL/bad-date.out"; then
  _pass "date-time without timezone fails with actionable message"
else
  _fail "bad date failure did not mention date-time"
fi

mkdir -p "$BAD/extra-criteria"
cp "$ARTIFACT_DIR/workflow-contract-e2e--deliver.md" "$BAD/extra-criteria/extra-criteria--deliver.md"
cp "$ARTIFACT_DIR/state.json" "$BAD/extra-criteria/state.json"
cp "$ARTIFACT_DIR/evidence.json" "$BAD/extra-criteria/evidence.json"
cp "$ARTIFACT_DIR/handoff.json" "$BAD/extra-criteria/handoff.json"
cp "$ARTIFACT_DIR/critique.json" "$BAD/extra-criteria/critique.json"
cat > "$BAD/extra-criteria/acceptance.json" <<'JSON'
{
  "schema_version": "1.0",
  "task_slug": "workflow-contract-e2e",
  "criteria": [
    {"id": "a", "description": "A.", "status": "pass"},
    {"id": "b", "description": "B.", "status": "pass"},
    {"id": "c", "description": "C.", "status": "pass"},
    {"id": "d", "description": "D.", "status": "pass"},
    {"id": "e", "description": "E.", "status": "pass"}
  ],
  "goal_fit": {
    "status": "pass",
    "summary": "Pass."
  }
}
JSON

if flow_agents_node "$VALIDATOR" --require-sidecars "$BAD/extra-criteria" >"$TMPDIR_EVAL/extra-criteria.out" 2>&1; then
  _fail "extra acceptance criteria should fail"
elif rg -q 'acceptance.json has 5 criteria but Markdown defines 4' "$TMPDIR_EVAL/extra-criteria.out"; then
  _pass "extra acceptance criteria fail with actionable message"
else
  _fail "extra criteria failure did not mention criteria mismatch"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "Workflow artifact integration passed."
  exit 0
fi

echo "Workflow artifact integration failed: $errors issue(s)."
exit 1
