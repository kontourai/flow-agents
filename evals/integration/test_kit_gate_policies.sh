#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"
flow_agents_build_ts

PROBE_ROOT="$(mktemp -d)"
trap 'rm -rf "$PROBE_ROOT"' EXIT

cat >"$PROBE_ROOT/probe.mjs" <<'NODE'
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const [repo, root] = process.argv.slice(2);
const require = createRequire(path.join(repo, "package.json"));
const flow = await import(require.resolve("@kontourai/flow"));
const runtime = await import(pathToFileURL(path.join(repo, "build/src/builder-flow-runtime.js")));
const fixture = path.join(repo, "evals/fixtures/kit-gate-policies");
const kit = JSON.parse(fs.readFileSync(path.join(fixture, "kit.json"), "utf8"));
assert.equal(kit.id, "atelier");
const declaration = kit.flows.find((entry) => entry.id === "atelier.commission");
assert.ok(declaration, "the fixture must declare the loaded flow");
const subject = "local:work-item/atelier";
const sessionDir = path.join(root, ".kontourai/flow-agents/probe");
fs.mkdirSync(sessionDir, { recursive: true });
try {
  await flow.startRun(path.join(fixture, declaration.path), { cwd: root, runId: "probe", params: { subject } });
  const run = await flow.loadRun("probe", root);
  assert.equal(run.definition.id, "atelier.commission");
  assert.equal(run.state.current_step, "intake");
  const gate = { id: "intake-gate", ...run.definition.gates["intake-gate"] };
  const enteredAt = Date.parse(run.state.updated_at);
  assert.ok(Number.isFinite(enteredAt), "Flow must persist a real initial visit timestamp");
  const claim = {
    id: "selected", claimType: "atelier.intake.commission", subjectType: "work-item",
    status: "verified", value: "pass", createdAt: new Date(enteredAt - 10_000).toISOString(),
    metadata: {
      origin: "check", check_kind: "external", workflow_subject_ref: subject,
      gate_claim: {
        expectation_id: "selected-work", claim_type: "atelier.intake.commission", subject_type: "work-item",
        step_id: "intake", flow_run_head: flow.flowRunHead(run.state),
      },
    },
  };
  const selected = await runtime.bundleGateEvidence(
    { claims: [claim], evidence: [] }, gate, run.state, subject, root, sessionDir, [], run.config,
  );
  assert.ok(selected, "the declared non-Builder selection claim must attach 10 seconds before Flow's initial visit");
  assert.deepEqual(selected.expectationIds, ["selected-work"]);
  assert.equal(selected.visitEnteredAt, enteredAt);
  assert.equal(enteredAt - Date.parse(claim.createdAt), 10_000);
  console.log(JSON.stringify({
    flowVersion: JSON.parse(fs.readFileSync(path.join(repo, "node_modules/@kontourai/flow/package.json"), "utf8")).version,
    definition: run.definition.id, step: run.state.current_step,
    selectedWorkAccepted: true, claimPredatesVisitMs: 10_000,
  }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
NODE

node - "$PROBE_ROOT/probe.mjs" "$ROOT" "$PROBE_ROOT/runtime" <<'NODE'
const { spawnSync } = require("node:child_process");
const [probe, repo, root] = process.argv.slice(2);
const result = spawnSync(process.execPath, [probe, repo, root], {
  encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
  env: { ...process.env, XDG_STATE_HOME: `${root}/state` },
});
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) console.error(result.error.message);
process.exitCode = result.error ? 1 : (result.status ?? 1);
NODE
