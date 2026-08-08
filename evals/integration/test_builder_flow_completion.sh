#!/usr/bin/env bash
# test_builder_flow_completion.sh — proves builder.build (composed with
# builder.publish-learn via uses_flow) reaches Flow run status "completed",
# and documents the mechanism that makes that possible.
#
# Background: @kontourai/flow's applyEvaluation only ever sets a run's status
# to "completed" when a PASSING gate's own step has `next: null`
# (node_modules/@kontourai/flow/dist/gates/flow-gates.js — mirrors
# flow's src/gates/flow-gates.ts). Both kits/builder/flows/build.flow.json and
# kits/builder/flows/publish-learn.flow.json, read as raw JSON, end their step
# chain at an UNGATED ceremonial step `{"id":"done","next":null}` — every
# gate sits on an earlier step. Naively evaluated with the bare @kontourai/flow
# library, a run following that raw shape would pass every gate and still
# never reach "completed"; it parks forever at status:"active",
# current_step:"done". This is not hypothetical shape-reading: the RED case
# below reproduces it end-to-end against a minimal flow definition that
# mirrors the exact shape shipped by every kit's *.flow.json file (see e.g.
# kits/knowledge/flows/ingest.flow.json — same "work step -> done -> null,
# no gate on done" pattern).
#
# What actually runs in production is different: src/builder-flow-run-adapter.ts
# never hands @kontourai/flow the raw kit JSON. It always compiles the flow
# through resolveEffectiveFlowDefinition() (flow-resolver.ts, under src's
# lib directory), which
# (since #941/#1136) collapses any step that is ungated, has `next: null`, and
# is referenced only as another step's `next` — i.e. exactly this ceremonial
# "done" sentinel — out of the effective definition, and rewrites the step
# that pointed at it (`learn`) to `next: null` directly. The GREEN case below
# resolves *that* effective definition (the exact function + exact flow id
# every real builder.build run compiles through) and drives it, gate by gate,
# with @kontourai/flow's own startRun/attachEvidence/evaluateRun/loadRun, to
# prove the real, shipped runtime reaches status "completed" at "learn".
#
# Together these two cases are the regression guard: if resolveEffectiveFlowDefinition's
# terminal-sentinel collapse (or its composition of builder.publish-learn's
# gates) ever regresses, the GREEN case goes red and this eval catches it
# before every real builder.build run parks on "done" forever.
#
# Deterministic, no model spend, no git/session/provider bureaucracy — this
# eval targets the Flow-evaluation mechanism directly via the same library
# functions the brief for this fix named (startRun/attachEvidence/evaluateRun/loadRun).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"

TMP="$(mktemp -d)"
# The driver imports the bare specifier "@kontourai/flow" and a relative
# path into the build output's flow-resolver.js — both resolve only when the
# driver file itself lives inside the repo tree (Node's ESM resolver walks up from
# the importing file's own directory, not the process cwd, to find
# node_modules). It is written under ROOT and removed on exit.
DRIVER="$ROOT/.eval-tmp-test-builder-flow-completion-driver.mjs"
trap 'rm -rf "$TMP" "$DRIVER"' EXIT

errors=0
_pass() { printf '  \xe2\x9c\x93 %s\n' "$1"; }
_fail() { printf '  \xe2\x9c\x97 %s\n' "$1"; errors=$((errors + 1)); }

flow_agents_build_ts || { echo "FAIL: build failed"; exit 1; }

cat > "$DRIVER" <<'NODE'
import { startRun, attachEvidence, evaluateRun, loadRun, validateDefinition } from "@kontourai/flow";
import fs from "node:fs";
import path from "node:path";

const [, , REPO, WORKDIR, MODE] = process.argv;

function bundleFor(entries) {
  const now = new Date().toISOString();
  const claims = [];
  const evidence = [];
  const events = [];
  for (const { claimType, subjectType, id } of entries) {
    claims.push({ id: `claim.${id}`, subjectType, subjectId: `subject/${id}`, claimType, fieldOrBehavior: `${id} fixture`, value: "pass", createdAt: now, updatedAt: now });
    evidence.push({ id: `evidence.${id}`, claimId: `claim.${id}`, evidenceType: "human_attestation", method: "attestation", sourceRef: "test_builder_flow_completion", excerptOrSummary: `${id} fixture`, observedAt: now, collectedBy: "test_builder_flow_completion" });
    events.push({ id: `event.${id}`, claimId: `claim.${id}`, status: "verified", actor: "test_builder_flow_completion", method: "attestation", evidenceIds: [`evidence.${id}`], createdAt: now, verifiedAt: now });
  }
  return { schemaVersion: 5, source: "test_builder_flow_completion", claims, evidence, policies: [], events };
}

async function driveGate(runId, cwd, gateId, entries) {
  const bundleFile = path.join(cwd, `bundle-${gateId.replace(/[:.]/g, "_")}.json`);
  fs.writeFileSync(bundleFile, JSON.stringify(bundleFor(entries)));
  await attachEvidence(runId, { cwd, gate: gateId, file: bundleFile, kind: "trust.bundle", bundle: true });
  const evaluated = await evaluateRun(runId, { cwd });
  const outcome = evaluated.outcomes?.at(-1);
  if (outcome?.status !== "pass") {
    throw new Error(`gate ${gateId} did not pass: ${JSON.stringify(outcome)}`);
  }
  return evaluated;
}

async function runRed() {
  // Minimal synthetic flow reproducing the EXACT shape shipped by every kit's
  // flow.json: a single gated step whose `next` points at an ungated
  // sentinel "done" step. Evaluated with the bare @kontourai/flow library
  // (no flow-agents composition), this is the failure mode described for
  // build.flow.json/publish-learn.flow.json if either were ever evaluated
  // raw, un-composed.
  const cwd = path.join(WORKDIR, "red");
  fs.mkdirSync(cwd, { recursive: true });
  const rawDef = {
    id: "terminal-sentinel-fixture",
    version: "1.0",
    steps: [
      { id: "work", next: "done" },
      { id: "done", next: null },
    ],
    gates: {
      "work-gate": {
        step: "work",
        expects: [{
          id: "work-done",
          kind: "trust.bundle",
          required: true,
          description: "Work is done.",
          bundle_claim: { claimType: "fixture.work.done", subjectType: "artifact", accepted_statuses: ["verified"] },
        }],
      },
    },
  };
  fs.writeFileSync(path.join(cwd, "raw.flow.json"), JSON.stringify(rawDef, null, 2));
  await startRun("raw.flow.json", { cwd, runId: "red-run" });
  await driveGate("red-run", cwd, "work-gate", [{ claimType: "fixture.work.done", subjectType: "artifact", id: "work-done" }]);
  const final = await loadRun("red-run", cwd);
  if (!(final.state.status === "active" && final.state.current_step === "done")) {
    throw new Error(`expected the ungated-terminal-step shape to park at status:active/current_step:done, got status:${final.state.status}/current_step:${final.state.current_step}`);
  }
  console.log(`RED: raw ungated-terminal-step flow parks at status:${final.state.status} current_step:${final.state.current_step} after its only gate passes (as expected — this is the mechanism the flow-agents resolver protects against)`);
}

async function runGreen() {
  // The exact resolver function src/builder-flow-run-adapter.ts's
  // loadShippedBuilderFlowDefinition() calls to compile the definition every
  // real builder.build run is started and evaluated against.
  const { resolveEffectiveFlowDefinition } = await import(path.join(REPO, "build", "src", "lib", "flow-resolver.js"));
  const effective = resolveEffectiveFlowDefinition("builder.build", REPO, { allowOverride: false });
  if (!effective) throw new Error("could not resolve the effective builder.build definition");
  const definition = validateDefinition(effective);

  const cwd = path.join(WORKDIR, "green");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "effective-build.flow.json"), JSON.stringify(definition, null, 2));
  await startRun("effective-build.flow.json", { cwd, runId: "green-run", params: { subject: "work-item/fixture-123" } });

  const plan = [
    ["pull-work-gate", [{ claimType: "builder.pull-work.selected", subjectType: "work-item", id: "selected-work" }]],
    ["design-probe-gate", [
      { claimType: "builder.design-probe.pickup-readiness", subjectType: "work-item", id: "pickup-probe-readiness" },
      { claimType: "builder.design-probe.decisions", subjectType: "decision", id: "probe-decisions-or-accepted-gaps" },
    ]],
    ["plan-gate", [{ claimType: "builder.plan.implementation", subjectType: "artifact", id: "implementation-plan" }]],
    ["execute-gate", [{ claimType: "builder.execute.scope", subjectType: "change", id: "implementation-scope" }]],
    ["verify-gate", [
      { claimType: "workflow.critique.review", subjectType: "workflow-critique", id: "clean-critique" },
      { claimType: "workflow.acceptance.criterion", subjectType: "flow-step", id: "acceptance-criteria" },
      { claimType: "builder.verify.tests", subjectType: "flow-step", id: "tests-evidence" },
    ]],
    ["merge-ready-gate", [{ claimType: "builder.merge-ready.readiness", subjectType: "change", id: "merge-readiness" }]],
    ["builder.publish-learn:pr-open-gate", [{ claimType: "builder.pr-open.pull-request", subjectType: "pull-request", id: "pull-request-opened" }]],
    ["builder.publish-learn:merge-ready-ci-gate", [{ claimType: "builder.merge-ready-ci.readiness", subjectType: "pull-request", id: "ci-merge-readiness" }]],
    ["builder.publish-learn:learn-gate", [
      { claimType: "builder.learn.decisions", subjectType: "decision", id: "decision-evidence" },
      { claimType: "builder.learn.evidence", subjectType: "release", id: "learning-evidence" },
    ]],
  ];

  for (const [gateId, entries] of plan) {
    const evaluated = await driveGate("green-run", cwd, gateId, entries);
    console.log(`  after ${gateId}: status=${evaluated.state.status} current_step=${evaluated.state.current_step}`);
  }

  const final = await loadRun("green-run", cwd);
  if (final.state.status !== "completed") {
    throw new Error(`expected the real builder.build run to reach status "completed", got status:${final.state.status} current_step:${final.state.current_step}`);
  }
  console.log(`GREEN: builder.build (composed with builder.publish-learn) reached status:${final.state.status} current_step:${final.state.current_step}`);
}

try {
  if (MODE === "red") await runRed();
  else if (MODE === "green") await runGreen();
  else throw new Error(`unknown mode: ${MODE}`);
} catch (error) {
  console.error(`FAIL[${MODE}]: ${error.message}`);
  process.exit(1);
}
NODE

# Real exit codes only: capture node's own exit status directly (never a
# masked pipeline tail — see docs/kit-authoring-guide.md's pipe-masked-exit
# lesson), then filter noisy-but-harmless ajv format warnings for display.
RED_LOG="$TMP/red.log"
if (cd "$ROOT" && node "$DRIVER" "$ROOT" "$TMP" red >"$RED_LOG" 2>&1); then
  grep -viE "unknown format" "$RED_LOG"
  _pass "raw ungated-terminal-step flow (bare @kontourai/flow, no flow-agents composition) parks forever at done — confirms the mechanism the brief described"
else
  grep -viE "unknown format" "$RED_LOG"
  _fail "RED case did not reproduce the expected raw parked-forever behavior"
fi

GREEN_LOG="$TMP/green.log"
if (cd "$ROOT" && node "$DRIVER" "$ROOT" "$TMP" green >"$GREEN_LOG" 2>&1); then
  grep -viE "unknown format" "$GREEN_LOG"
  _pass "the real builder.build definition (as compiled by src/builder-flow-run-adapter.ts's resolver) reaches status completed"
else
  grep -viE "unknown format" "$GREEN_LOG"
  _fail "the real builder.build definition did NOT reach status completed — every builder.build run would park forever"
fi

echo
if [[ "$errors" -eq 0 ]]; then
  echo "PASS: builder.build reaches completed via the shipped resolveEffectiveFlowDefinition composition; the raw ungated-terminal-step shape (guarded against by that resolver) is confirmed as the failure mode it protects against."
  exit 0
fi
echo "FAIL: $errors check(s) failed"
exit 1
