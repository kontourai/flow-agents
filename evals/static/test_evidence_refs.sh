#!/usr/bin/env bash
# test_evidence_refs.sh — Structured evidence reference schema checks
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== Evidence Ref Schema Checks ==="

if node --input-type=module <<'NODE'
import Ajv2020 from "ajv/dist/2020.js";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const ajv = new Ajv2020({ allErrors: true });
const acceptanceSchema = JSON.parse(fs.readFileSync(path.join(root, "schemas/workflow-acceptance.schema.json"), "utf8"));
const evidenceSchema = JSON.parse(fs.readFileSync(path.join(root, "schemas/workflow-evidence.schema.json"), "utf8"));
const validateAcceptance = ajv.compile(acceptanceSchema);
const validateEvidence = ajv.compile(evidenceSchema);

const acceptance = {
  schema_version: "1.0",
  task_slug: "structured-evidence-ref-fixture",
  criteria: [
    {
      id: "AC1",
      description: "Behavior claim cites command and source evidence.",
      status: "pass",
      evidence_refs: [
        {
          kind: "command",
          excerpt: "npm run eval:static --silent",
          summary: "Static evals passed."
        },
        {
          kind: "source",
          url: "https://github.com/example/repo/blob/0123456789abcdef0123456789abcdef01234567/src/index.ts#L10-L18",
          file: "src/index.ts",
          line_start: 10,
          line_end: 18,
          excerpt: "export function implementedBehavior() { return true; }"
        }
      ]
    }
  ],
  goal_fit: {
    status: "pass",
    summary: "Structured refs validate."
  }
};

const evidence = {
  schema_version: "2.0",
  task_slug: "structured-evidence-ref-fixture",
  verdict: "pass",
  checks: [
    {
      id: "static-eval",
      kind: "test",
      status: "pass",
      command: "npm run eval:static --silent",
      observed_at_commit: "0123456789abcdef0123456789abcdef01234567",
      worktree_clean: true,
      summary: "Static evals passed.",
      artifact_refs: [
        {
          kind: "source",
          file: "evals/static/test_evidence_refs.sh",
          line_start: 1,
          line_end: 1,
          excerpt: "test_evidence_refs.sh - Structured evidence reference schema checks"
        }
      ]
    }
  ],
  external_evidence: [
    {
      system: "github",
      ref: {
        kind: "provider",
        url: "https://github.com/example/repo/actions/runs/1",
        summary: "Provider check run."
      },
      summary: "Provider evidence."
    }
  ]
};

const legacyAcceptance = structuredClone(acceptance);
legacyAcceptance.criteria[0].evidence_refs = ["legacy-string-ref"];

const invalidSource = structuredClone(evidence);
delete invalidSource.checks[0].artifact_refs[0].excerpt;

const emptyArtifact = structuredClone(evidence);
emptyArtifact.checks[0].artifact_refs = [{ kind: "artifact" }];

const emptyCommand = structuredClone(acceptance);
emptyCommand.criteria[0].evidence_refs = [{ kind: "command" }];

const emptyProvider = structuredClone(evidence);
emptyProvider.external_evidence[0].ref = { kind: "provider" };

const rejectedV1 = structuredClone(evidence);
rejectedV1.schema_version = "1.0";

const commandKindMissingCommandAndProvenance = structuredClone(evidence);
commandKindMissingCommandAndProvenance.checks[0] = {
  id: "command-kind-missing-provenance",
  kind: "command",
  status: "pass",
  summary: "A command-kind check cannot omit its execution and provenance."
};

const proseCommand = structuredClone(evidence);
proseCommand.checks[0].kind = "command";
proseCommand.checks[0].command = "The static checks passed successfully.";

const missingObservedCommit = structuredClone(evidence);
delete missingObservedCommit.checks[0].observed_at_commit;

const missingWorktreeClean = structuredClone(evidence);
delete missingWorktreeClean.checks[0].worktree_clean;

const malformedObservedCommit = structuredClone(evidence);
malformedObservedCommit.checks[0].kind = "command";
malformedObservedCommit.checks[0].observed_at_commit = "not-a-commit";

const upperCaseObservedCommit = structuredClone(evidence);
upperCaseObservedCommit.checks[0].kind = "command";
upperCaseObservedCommit.checks[0].observed_at_commit = "A".repeat(40);

const fortyOneCharacterCommit = structuredClone(evidence);
fortyOneCharacterCommit.checks[0].kind = "command";
fortyOneCharacterCommit.checks[0].observed_at_commit = "a".repeat(41);

const sixtyThreeCharacterCommit = structuredClone(evidence);
sixtyThreeCharacterCommit.checks[0].kind = "command";
sixtyThreeCharacterCommit.checks[0].observed_at_commit = "a".repeat(63);

const sixtyFourCharacterCommit = structuredClone(evidence);
sixtyFourCharacterCommit.checks[0].kind = "command";
sixtyFourCharacterCommit.checks[0].observed_at_commit = "a".repeat(64);

const nonBooleanWorktreeClean = structuredClone(evidence);
nonBooleanWorktreeClean.checks[0].kind = "command";
nonBooleanWorktreeClean.checks[0].worktree_clean = "true";

const dirtyEvidence = structuredClone(evidence);
dirtyEvidence.verdict = "not_verified";
dirtyEvidence.checks[0].kind = "command";
dirtyEvidence.checks[0].status = "not_verified";
dirtyEvidence.checks[0].worktree_clean = false;

const dirtyPass = structuredClone(evidence);
dirtyPass.checks[0].kind = "command";
dirtyPass.checks[0].worktree_clean = false;

if (!validateAcceptance(acceptance)) {
  throw new Error(`structured acceptance refs should validate: ${ajv.errorsText(validateAcceptance.errors)}`);
}
if (!validateEvidence(evidence)) {
  throw new Error(`structured evidence refs should validate: ${ajv.errorsText(validateEvidence.errors)}`);
}
if (validateAcceptance(legacyAcceptance)) {
  throw new Error("legacy string evidence refs should fail");
}
if (validateEvidence(invalidSource)) {
  throw new Error("source refs missing excerpt should fail");
}
if (validateEvidence(emptyArtifact)) {
  throw new Error("artifact refs without file/url and summary/excerpt should fail");
}
if (validateAcceptance(emptyCommand)) {
  throw new Error("command refs without excerpt/summary/url should fail");
}
if (validateEvidence(emptyProvider)) {
  throw new Error("provider refs without url should fail");
}
if (validateEvidence(rejectedV1)) {
  throw new Error("v1 evidence must be rejected and re-recorded as v2");
}
if (validateEvidence(commandKindMissingCommandAndProvenance)) {
  throw new Error("kind:command check missing command and provenance should fail");
}
if (validateEvidence(proseCommand)) {
  throw new Error("kind:command check with prose instead of a runnable command should fail");
}
if (validateEvidence(missingObservedCommit)) {
  throw new Error("command check without observed_at_commit should fail");
}
if (validateEvidence(missingWorktreeClean)) {
  throw new Error("command check without worktree_clean should fail");
}
if (validateEvidence(malformedObservedCommit)) {
  throw new Error("command check with malformed observed_at_commit should fail");
}
if (validateEvidence(upperCaseObservedCommit)) {
  throw new Error("command check with upper-case observed_at_commit should fail");
}
if (validateEvidence(fortyOneCharacterCommit)) {
  throw new Error("command check with 41-character observed_at_commit should fail");
}
if (validateEvidence(sixtyThreeCharacterCommit)) {
  throw new Error("command check with 63-character observed_at_commit should fail");
}
if (!validateEvidence(sixtyFourCharacterCommit)) {
  throw new Error(`command check with 64-character observed_at_commit should validate: ${ajv.errorsText(validateEvidence.errors)}`);
}
if (validateEvidence(nonBooleanWorktreeClean)) {
  throw new Error("command check with non-boolean worktree_clean should fail");
}
if (!validateEvidence(dirtyEvidence)) {
  throw new Error(`dirty v2 evidence should remain representable: ${ajv.errorsText(validateEvidence.errors)}`);
}
if (validateEvidence(dirtyPass)) {
  throw new Error("dirty command check must not assert pass");
}
NODE
then
  pass "v2 command checks require runnable commands and provenance; v1 and dirty pass claims fail"
else
  fail "structured evidence ref schema check failed"
fi

if [[ $errors -eq 0 ]]; then
  echo "=== PASS ==="
  exit 0
else
  echo "=== FAIL ($errors) ==="
  exit 1
fi
