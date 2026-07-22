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
assert(Object.values(deterministic.revisions).join(",") === "0.19.1,1.19.0,0.3.2,2.13.0", "public revisions are not pinned");
assert(live.liveTelemetry.provider === "reference-provider-adapter" && live.liveTelemetry.model === "reference-provider-model" && live.liveTelemetry.taskDigest === deterministic.extraction.taskDigest && live.liveTelemetry.usageTokens === 42 && live.liveTelemetry.latencyMs >= 0 && live.liveTelemetry.fixtureRevision === "reviewed-grounding-fixture/v1", "optional live execution telemetry is incomplete or unbound");
NODE
node --input-type=module -e "import('$RUNNER').then((module) => { if (typeof module.runReviewedGroundingReference !== 'function') process.exit(1); })"
echo "Reviewed grounding reference workflow passed"
