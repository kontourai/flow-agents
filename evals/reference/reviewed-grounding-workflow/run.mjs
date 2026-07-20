#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createExtractionTaskSpec, createInMemoryPreparedArtifactStore, extract, resolvePreparedArtifact, serializePortableExtractionResult, toPortablePreparedArtifactState } from "@kontourai/traverse";
import { buildSemanticReviewWork, createObserveExtractDiff } from "@kontourai/lookout";
import { importExtractionEnvelope } from "@kontourai/survey";
import { buildReviewDecision } from "@kontourai/survey/review-workbench";
import { evaluateReviewedGroundingPolicy, projectReviewedExtractionEvidence } from "@kontourai/surface";

const source = { id: "public-record-17", url: "https://example.test/records/17", kind: "api-record", cadenceHint: "manual", renderPolicy: "never",
  targetSchema: [{ path: "status", type: "string", required: true, inferenceType: "explicit" }] };
const contents = new Map([["snapshot:record-17:v1", "Record 17\nStatus: Ready\n"], ["snapshot:record-17:v2", "Record 17\nStatus: Paused\n"]]);
const taskSpec = createExtractionTaskSpec({ version: "reviewed-grounding-reference/v1", targetSchema: source.targetSchema,
  guidance: "Copy the status value exactly and retain its source excerpt." });

export async function runReviewedGroundingReference(options = {}) {
  const providerAudit = { calls: 0, tokens: 0, latenciesMs: [] };
  const provider = deterministicProvider(providerAudit);
  const artifactStore = createInMemoryPreparedArtifactStore();
  const resultsBySnapshot = new Map();
  const recorded = [];
  const checks = [changed(null, "snapshot:record-17:v1", "2026-07-20T00:00:00.000Z"), unchanged("snapshot:record-17:v1", "2026-07-20T00:01:00.000Z"),
    changed("snapshot:record-17:v1", "snapshot:record-17:v2", "2026-07-20T00:02:00.000Z")];
  const composition = createObserveExtractDiff({
    acquisition: { async check() {
      const check = checks.shift();
      if (!check) throw new Error("Reference acquisition sequence is exhausted.");
      return check;
    } },
    extraction: { async extract({ snapshotRef }) {
      const content = contents.get(snapshotRef);
      if (content === undefined) throw new Error(`Unknown reference snapshot: ${snapshotRef}`);
      const result = await extract({ content, contentType: "text", sourceRef: source.url,
        preparedArtifact: { store: artifactStore, sourceSnapshotRef: snapshotRef }, targetSchema: source.targetSchema, taskSpec, provider });
      result.runId = snapshotRef.endsWith("v1")
        ? "traverse-extraction-run:00000000-0000-4000-8000-000000000001"
        : "traverse-extraction-run:00000000-0000-4000-8000-000000000002";
      result.extractedAt = snapshotRef.endsWith("v1") ? "2026-07-20T00:00:00.000Z" : "2026-07-20T00:02:00.000Z";
      resultsBySnapshot.set(snapshotRef, result); return result;
    } },
    recorder: { async record(observation) {
      const priorObservationId = recorded.at(-1)?.observationId ?? null;
      const observationId = `observation:${recorded.length + 1}`;
      recorded.push({ ...observation, observationId, priorObservationId }); return { observationId, priorObservationId };
    } },
  });
  const initial = expectObservation(await composition.observe(source));
  const callsAfterInitial = providerAudit.calls;
  const repeated = expectObservation(await composition.observe(source));
  const unchangedProviderCalls = providerAudit.calls - callsAfterInitial;
  const changedObservation = expectObservation(await composition.observe(source));
  const semanticReview = buildSemanticReviewWork({ prior: initial.proposalSet, current: changedObservation.proposalSet,
    observationIdentity: { prior: initial.observationId, current: changedObservation.observationId },
    selectEntities: (observation) => [observation], entityIdentity: (observation) => observation.sourceId,
    proposalsFor: (observation) => observation.proposals, fieldIdentity: (_observation, proposal) => proposal.fieldPath,
    schema: source.targetSchema, claimTarget: () => claimTarget() });
  if (!semanticReview.ok) throw new Error(`Semantic review construction failed: ${semanticReview.error.kind}`);

  const extraction = resultsBySnapshot.get("snapshot:record-17:v2");
  const envelope = serializePortableExtractionResult(extraction, { sourceRef: source.url, sourceSnapshotRef: "snapshot:record-17:v2" });
  const imported = importExtractionEnvelope(envelope, { importName: "public-record-17-v2", producerNamespace: "reference-workflow",
    sourceKind: "api-record", claimTarget: () => claimTarget() });
  const reviewItem = imported.reviewItems[0];
  if (!reviewItem) throw new Error("Extraction import did not create a review item.");
  const policy = groundingPolicy();
  const beforeReview = evaluateReviewedGroundingPolicy({ policy, evidence: [] });
  const reviewDecision = buildReviewDecision({ item: reviewItem, decision: "accept-proposed", note: "Exact source span confirms the value.",
    actorId: "reviewer:reference", reviewedAt: "2026-07-20T00:03:00.000Z" });
  const projected = projectReviewedExtractionEvidence({ evidenceId: "evidence.public-record-17.status", claimId: "claim.public-record-17.status",
    proposalIndex: 0, importRecord: imported.record, reviewItem, reviewDecision, collectedBy: "reference-workflow:collector", structuralTrust: "validated" });
  const currentSource = { evidenceId: projected.evidence.id, status: "current", expectedSnapshotRef: "snapshot:record-17:v2",
    observedSnapshotRef: "snapshot:record-17:v2", observedAt: "2026-07-20T00:03:00.000Z", extractedValueChanged: true };
  const afterReview = evaluateReviewedGroundingPolicy({ policy, evidence: [projected.evidence], sourceStates: [currentSource] });
  const drifted = evaluateReviewedGroundingPolicy({ policy, evidence: [projected.evidence], sourceStates: [{ ...currentSource,
    status: "drifted", observedSnapshotRef: "snapshot:record-17:v3", extractedValueChanged: false }] });
  const tamperedResolution = await resolvePreparedArtifact(extraction.preparedArtifact, { get: () => "Record 17\nStatus: Altered\n" });
  const tamperedEnvelope = JSON.parse(envelope);
  tamperedEnvelope.result.preparedArtifactState = toPortablePreparedArtifactState(tamperedResolution, extraction.preparedArtifact);
  const tamperedImport = importExtractionEnvelope(tamperedEnvelope, { importName: "public-record-17-tampered", producerNamespace: "reference-workflow",
    sourceKind: "api-record", claimTarget: () => claimTarget() });

  return { contract: "flow-agents.reviewed-grounding-reference/v1",
    revisions: await pinnedRevisions(),
    acquisition: { initial: initial.outcome, repeated: repeated.outcome, changed: changedObservation.outcome },
    extraction: { providerCalls: providerAudit.calls, unchangedProviderCalls, tokensUsed: providerAudit.tokens, taskDigest: taskSpec.digest,
      preparedArtifactRef: extraction.preparedArtifact.ref },
    review: { semanticItemCount: semanticReview.value.items.length,
      semanticKinds: semanticReview.value.items.map((item) => item.metadata.producer["lookout.kontourai.io/semantic-transition"].semanticKind),
      importName: imported.record.metadata.name, reviewItemName: reviewItem.metadata.name, reviewDecisionName: reviewDecision.metadata.name },
    action: { beforeReview, afterReview, drifted }, failures: { missingEvidence: beforeReview.gaps, tamperedPreparedContent: tamperedImport.record.status },
    ...(options.liveTelemetry ? { liveTelemetry: validateLiveTelemetry(options.liveTelemetry) } : {}) };
}

async function pinnedRevisions() {
  const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  const dependencies = manifest.devDependencies ?? {};
  return { traverse: dependencies["@kontourai/traverse"], survey: dependencies["@kontourai/survey"],
    lookout: dependencies["@kontourai/lookout"], surface: dependencies["@kontourai/surface"] };
}

function deterministicProvider(audit) { return { name: "deterministic-reference",
  capabilities: { supported: ["structured-output", "exact-excerpts", "task-specifications", "usage", "warnings"] },
  async extract(input) { const started = Date.now(); audit.calls += 1; const match = /Status: ([A-Za-z]+)/.exec(input.content);
    if (!match) throw new Error("Fixture status is missing."); audit.tokens += 7; audit.latenciesMs.push(Date.now() - started);
    return { proposals: [{ fieldPath: "status", candidateValue: match[1], confidence: 0.99,
      provenance: { excerpt: match[1], locator: "provider-value-is-recomputed" }, extractor: "deterministic-reference" }],
      raw: { response: "deterministic fixture result", model: "deterministic-reference-v1", tokensUsed: 7 } }; } }; }
function changed(priorSnapshotRef, currentSnapshotRef, checkedAt) { return { kind: "changed", sourceId: source.id, sourceUrl: source.url, checkedAt,
  warnings: [], priorSnapshotRef, currentSnapshotRef, changeBasis: priorSnapshotRef ? "hash" : "initial" }; }
function unchanged(snapshotRef, checkedAt) { return { kind: "unchanged-304", sourceId: source.id, sourceUrl: source.url, checkedAt, warnings: [], snapshotRef }; }
function expectObservation(result) { if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`); return result.value; }
function claimTarget() { return { subjectType: "public-record", subjectId: "17", facet: "record.status", claimType: "record.field", fieldOrBehavior: "status", impactLevel: "medium" }; }
function groundingPolicy() { return { id: "policy.publish-public-record", action: "publish-public-record", requiredClaimIds: ["claim.public-record-17.status"],
  requireExactLocator: true, requirePreparedArtifact: true, requireAcceptedReview: true, requireValidatedStructure: true, requireCurrentSource: true }; }
function validateLiveTelemetry(value) { const strings = ["provider", "model", "taskDigest", "fixtureRevision"];
  if (value === null || typeof value !== "object" || strings.some((key) => typeof value[key] !== "string" || value[key] === "")
    || !Number.isFinite(value.usageTokens) || !Number.isFinite(value.latencyMs)) throw new Error("Live telemetry is incomplete.");
  return { provider: value.provider, model: value.model, taskDigest: value.taskDigest, usageTokens: value.usageTokens,
    latencyMs: value.latencyMs, fixtureRevision: value.fixtureRevision }; }
async function main() { const flag = process.argv.indexOf("--live-telemetry");
  const liveTelemetry = flag === -1 ? undefined : JSON.parse(await readFile(process.argv[flag + 1], "utf8"));
  process.stdout.write(`${JSON.stringify(await runReviewedGroundingReference({ liveTelemetry }), null, 2)}\n`); }
if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
