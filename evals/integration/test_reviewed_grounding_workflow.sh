#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$ROOT/evals/reference/reviewed-grounding-workflow/run.mjs"
PROVIDER="$ROOT/evals/fixtures/reviewed-grounding-workflow/provider.mjs"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
node "$RUNNER" >"$TMP/first.json"
node "$RUNNER" >"$TMP/second.json"
cmp -s "$TMP/first.json" "$TMP/second.json"
node "$RUNNER" --live-provider-module "$PROVIDER" >"$TMP/live.json"
node --input-type=module - "$TMP/first.json" "$TMP/live.json" <<'NODE'
import { readFileSync } from "node:fs";
const deterministic = JSON.parse(readFileSync(process.argv[2], "utf8"));
const live = JSON.parse(readFileSync(process.argv[3], "utf8"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
assert(deterministic.acquisition.repeated === "unchanged", "unchanged observation was not replayed");
assert(deterministic.extraction.unchangedProviderCalls === 0, "unchanged observation called the provider");
assert(deterministic.review.semanticItemCount > 0 && deterministic.review.semanticKinds.includes("proposal-value-changed"), "semantic change did not route to review");
assert(deterministic.action.beforeReview.outcome === "refused" && deterministic.failures.missingEvidence.some((gap) => gap.kind === "missing-reviewed-evidence"), "missing evidence did not produce a typed refusal");
assert(deterministic.action.afterReview.outcome === "allowed", "reviewed grounding did not allow the action");
assert(deterministic.action.drifted.outcome === "refused" && deterministic.action.drifted.gaps.some((gap) => gap.kind === "source-not-current") && deterministic.action.drifted.dimensions[0].sourceState.extractedValueChanged === false, "unchanged-value drift was not a typed visible refusal");
assert(deterministic.failures.tamperedPreparedContent.state === "unresolved" && deterministic.failures.tamperedPreparedContent.diagnostics[0].kind === "digest-mismatch", "tampered content did not fail at a typed boundary");
// forage,traverse,survey,lookout,surface -- pinned so that moving a public dependency is a
// deliberate edit here rather than a silent drift. surface: 2.13.0 -> 2.17.0 with
// kontourai/flow-agents#1362, which collapsed its duplicate devDependencies/
// optionalDependencies declarations into one exact dependencies entry. Safe for this
// reference workflow on evidence, not on assertion: all nine published surface schemas
// are byte-identical across 2.13.0..2.17.0, and the only export-surface change is
// additive, so the envelope/digest contract this file exercises is unchanged.
// surface: 2.17.0 -> 5.0.0 with kontourai/flow-agents#1422. One break reaches this workflow:
// Surface 4.0 binds the published claim value to the reviewed candidate and refuses a grounding
// decision made without claims, so run.mjs now supplies the claim it would publish.
// Survey 9.0.0 supplies the reviewed public producer/session contracts. survey: 8.4.0 -> 9.0.0:
// Survey 9 changes the Trust Bundle projection (buildSurveyTrustBundle emits the review-outcome
// policy and attestation evidence); this workflow imports only importExtractionEnvelope and
// buildReviewDecision, and every assertion above holds unchanged.
// surface: 5.0.0 -> 6.3.0 when the shared workflow and Knowledge moved to one Surface pin.
// Safe on evidence: src/reviewed-grounding-policy.ts, src/reviewed-extraction-evidence.ts and
// the modules they import (canonical-digest, reviewed-extraction-evidence-browser) are
// byte-identical between surface v5.0.0 and v6.3.0; src/types.ts only widens SchemaVersion to 9
// and adds retention, evidence-collector and stale-reason types.
// Every behavior assertion above passed on 6.3.0 before this pin moved.
// Lookout 0.8.9 requires acquisition's exact snapshot store and the recorder's
// last extracted reference. The reference now uses Forage's real in-memory
// store/ref builder/resolver and Lookout's extractedSnapshotRef contract.
assert(Object.values(deterministic.revisions).join(",") === "1.0.2,5.0.3,9.0.0,0.8.9,6.3.0", "public revisions are not pinned");
assert(!deterministic.action.afterReview.gaps.some((gap) => gap.kind === "claims-not-supplied" || gap.kind === "value-mismatch"), "the reviewed claim value is not bound to the decision");
assert(deterministic.failures.valueMismatch.outcome === "refused" && deterministic.failures.valueMismatch.gaps.some((gap) => gap.kind === "value-mismatch"), "a claim publishing a value other than the reviewed one was not refused with value-mismatch");
assert(live.liveTelemetry.provider === "reference-provider-adapter" && live.liveTelemetry.model === "reference-provider-model" && live.liveTelemetry.taskDigest === deterministic.extraction.taskDigest && live.liveTelemetry.usageTokens === 42 && live.liveTelemetry.latencyMs >= 0 && live.liveTelemetry.fixtureRevision === "reviewed-grounding-fixture/v1", "optional live execution telemetry is incomplete or unbound");
NODE
node --input-type=module -e "import('$RUNNER').then((module) => { if (typeof module.runReviewedGroundingReference !== 'function') process.exit(1); })"
echo "Reviewed grounding reference workflow passed"
