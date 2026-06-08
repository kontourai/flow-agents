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
  schema_version: "1.0",
  task_slug: "structured-evidence-ref-fixture",
  verdict: "pass",
  checks: [
    {
      id: "static-eval",
      kind: "test",
      status: "pass",
      command: "npm run eval:static --silent",
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
NODE
then
  pass "structured refs validate and incomplete refs fail"
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
