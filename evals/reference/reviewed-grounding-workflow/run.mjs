#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createInMemorySnapshotStore } from "@kontourai/forage";
import { buildSnapshotSourceRef, resolveSnapshotSourceRef } from "@kontourai/forage/fetch";
import { createExtractionTaskSpec, createInMemoryPreparedArtifactStore, extract, resolvePreparedArtifact, serializePortableExtractionResult, toPortablePreparedArtifactState } from "@kontourai/traverse";
import { buildSemanticReviewWork, createObserveExtractDiff, extractedSnapshotRef } from "@kontourai/lookout";
import { importExtractionEnvelope } from "@kontourai/survey";
import { buildReviewDecision } from "@kontourai/survey/review-workbench";
import { evaluateReviewedGroundingPolicy, projectReviewedExtractionEvidence, restoreReviewedExtractionEvidence } from "@kontourai/surface";

const source = { id: "public-record-17", url: "https://example.test/records/17", kind: "api-record", cadenceHint: "manual", renderPolicy: "never",
  targetSchema: [{ path: "status", type: "string", required: true, inferenceType: "explicit" }] };
const contents = new Map([["snapshot:record-17:v1", "Record 17\nStatus: Ready\n"], ["snapshot:record-17:v2", "Record 17\nStatus: Paused\n"]]);
const taskSpec = createExtractionTaskSpec({ version: "reviewed-grounding-reference/v1", targetSchema: source.targetSchema,
  guidance: "Copy the status value exactly and retain its source excerpt." });

export async function runReviewedGroundingReference(options = {}) {
  const providerAudit = { calls: 0, tokens: 0, latenciesMs: [] };
  const provider = deterministicProvider(providerAudit);
  const artifactStore = createInMemoryPreparedArtifactStore();
  const snapshots = createInMemorySnapshotStore();
  const initialSnapshot = fixtureSnapshot(contents.get("snapshot:record-17:v1"), "2026-07-20T00:00:00.000Z");
  const changedSnapshot = fixtureSnapshot(contents.get("snapshot:record-17:v2"), "2026-07-20T00:02:00.000Z");
  const driftedSnapshot = fixtureSnapshot("Record 17\nStatus: Paused\nDetails: revised\n", "2026-07-20T00:04:00.000Z");
  const refs = { initial: buildSnapshotSourceRef(initialSnapshot), changed: buildSnapshotSourceRef(changedSnapshot), drifted: buildSnapshotSourceRef(driftedSnapshot) };
  const captures = new Map([[refs.initial, initialSnapshot], [refs.changed, changedSnapshot]]);
  const resultsBySnapshot = new Map();
  const lastExtracted = new Map();
  const recorded = [];
  const checks = [changed(null, refs.initial, "2026-07-20T00:00:00.000Z"), unchanged(refs.initial, "2026-07-20T00:01:00.000Z"),
    changed(refs.initial, refs.changed, "2026-07-20T00:02:00.000Z")];
  const composition = createObserveExtractDiff({
    snapshots,
    acquisition: { async check() {
      const check = checks.shift();
      if (!check) throw new Error("Reference acquisition sequence is exhausted.");
      if (check.kind === "changed") await snapshots.put(captures.get(check.currentSnapshotRef));
      return check;
    } },
    extraction: { async extract({ snapshotRef }) {
      const resolved = await resolveSnapshotSourceRef(snapshots, snapshotRef);
      if (!resolved.ok) throw new Error(`Reference snapshot resolution failed: ${resolved.error.kind}`);
      const content = resolved.snapshot.body;
      if (typeof content !== "string") throw new Error("Reference snapshot is not textual.");
      const result = await extract({ content, contentType: "text", sourceRef: source.url,
        preparedArtifact: { store: artifactStore, sourceSnapshotRef: snapshotRef }, targetSchema: source.targetSchema, taskSpec, provider });
      result.runId = snapshotRef === refs.initial
        ? "traverse-extraction-run:00000000-0000-4000-8000-000000000001"
        : "traverse-extraction-run:00000000-0000-4000-8000-000000000002";
      result.extractedAt = snapshotRef === refs.initial ? "2026-07-20T00:00:00.000Z" : "2026-07-20T00:02:00.000Z";
      resultsBySnapshot.set(snapshotRef, result); return result;
    } },
    recorder: {
      async lastExtractedSnapshotRef(observedSource) { return lastExtracted.get(sourceKey(observedSource)) ?? null; },
      async record(observation) {
        const priorObservationId = recorded.at(-1)?.observationId ?? null;
        const observationId = `observation:${recorded.length + 1}`;
        recorded.push({ ...observation, observationId, priorObservationId });
        const handled = extractedSnapshotRef(observation);
        if (handled !== null) lastExtracted.set(sourceKey(observation.source), handled);
        return { observationId, priorObservationId };
      },
    },
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

  const extraction = resultsBySnapshot.get(refs.changed);
  const envelope = serializePortableExtractionResult(extraction, { sourceRef: source.url, sourceSnapshotRef: refs.changed });
  const imported = importExtractionEnvelope(envelope, { importName: "public-record-17-v2", producerNamespace: "reference-workflow",
    sourceKind: "api-record", claimTarget: () => claimTarget() });
  const reviewItem = imported.reviewItems[0];
  if (!reviewItem) throw new Error("Extraction import did not create a review item.");
  const policy = groundingPolicy();
  const reviewDecision = buildReviewDecision({ item: reviewItem, decision: "accept-proposed", note: "Exact source span confirms the value.",
    actorId: "reviewer:reference", reviewedAt: "2026-07-20T00:03:00.000Z" });
  const projected = projectReviewedExtractionEvidence({ evidenceId: "evidence.public-record-17.status", claimId: "claim.public-record-17.status",
    proposalIndex: 0, importRecord: imported.record, reviewItem, reviewDecision, collectedBy: "reference-workflow:collector", structuralTrust: "validated" });
  // Surface >= 4 binds the value the action would publish to the reviewed candidate value
  // (`value-mismatch`) and refuses a decision made without claims (`claims-not-supplied`). The value
  // published here is the one the reviewed evidence itself carries, recovered from that evidence.
  const reviewed = restoreReviewedExtractionEvidence(projected.evidence);
  const claimId = "claim.public-record-17.status";
  const claims = [{ id: claimId, value: reviewed.importRecord.spec.envelope.result.proposals[reviewed.proposalIndex].candidateValue }];
  const beforeReview = evaluateReviewedGroundingPolicy({ policy, evidence: [], claims });
  const currentSource = { evidenceId: projected.evidence.id, status: "current", expectedSnapshotRef: refs.changed,
    observedSnapshotRef: refs.changed, observedAt: "2026-07-20T00:03:00.000Z", extractedValueChanged: true };
  const afterReview = evaluateReviewedGroundingPolicy({ policy, evidence: [projected.evidence], sourceStates: [currentSource], claims });
  // A claim publishing a value other than the reviewed one (the superseded v1 value) is refused.
  const valueMismatch = evaluateReviewedGroundingPolicy({ policy, evidence: [projected.evidence], sourceStates: [currentSource],
    claims: [{ id: claimId, value: "Ready" }] });
  await snapshots.put(driftedSnapshot);
  const drifted = evaluateReviewedGroundingPolicy({ policy, evidence: [projected.evidence], claims, sourceStates: [{ ...currentSource,
    status: "drifted", observedSnapshotRef: refs.drifted, observedAt: driftedSnapshot.fetchedAt, extractedValueChanged: false }] });
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
    action: { beforeReview, afterReview, drifted }, failures: { missingEvidence: beforeReview.gaps, valueMismatch: { outcome: valueMismatch.outcome, gaps: valueMismatch.gaps }, tamperedPreparedContent: tamperedImport.record.status },
    ...(options.liveProviderModule ? { liveTelemetry: await observeLiveProvider(options.liveProviderModule) } : {}) };
}

async function pinnedRevisions() {
  const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  const dependencies = { ...(manifest.devDependencies ?? {}), ...(manifest.dependencies ?? {}) };
  return { forage: dependencies["@kontourai/forage"], traverse: dependencies["@kontourai/traverse"], survey: dependencies["@kontourai/survey"],
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
function fixtureSnapshot(body, fetchedAt) { return { sourceId: source.id, url: source.url, status: 200, fetchedAt,
  body, bytes: new TextEncoder().encode(body), declaredCharset: "utf-8", bodyHash: createHash("sha256").update(body).digest("hex") }; }
function sourceKey(observedSource) { return JSON.stringify([observedSource.id, observedSource.url, observedSource.kind]); }
function expectObservation(result) { if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`); return result.value; }
function claimTarget() { return { subjectType: "public-record", subjectId: "17", facet: "record.status", claimType: "record.field", fieldOrBehavior: "status", impactLevel: "medium" }; }
function groundingPolicy() { return { id: "policy.publish-public-record", action: "publish-public-record", requiredClaimIds: ["claim.public-record-17.status"],
  requireExactLocator: true, requirePreparedArtifact: true, requireAcceptedReview: true, requireValidatedStructure: true, requireCurrentSource: true }; }
async function observeLiveProvider(modulePath) {
  const loaded = await import(pathToFileURL(resolve(modulePath)).href);
  const provider = loaded.default ?? loaded.provider;
  if (!provider || typeof provider.extract !== "function" || typeof provider.name !== "string" || provider.name === "") {
    throw new Error("Live provider module must export a named extraction provider.");
  }
  const started = performance.now();
  const result = await extract({ content: contents.get("snapshot:record-17:v2"), contentType: "text", sourceRef: source.url,
    targetSchema: source.targetSchema, taskSpec, provider });
  const latencyMs = Math.max(0, performance.now() - started);
  const model = result.raw?.model;
  const usageTokens = result.raw?.tokensUsed;
  if (typeof model !== "string" || model === "" || !Number.isFinite(usageTokens) || usageTokens < 0) {
    throw new Error("Live provider result must report model and non-negative token usage.");
  }
  return { provider: provider.name, model, taskDigest: taskSpec.digest, usageTokens, latencyMs,
    fixtureRevision: "reviewed-grounding-fixture/v1" };
}
async function main() { const flag = process.argv.indexOf("--live-provider-module");
  const liveProviderModule = flag === -1 ? undefined : process.argv[flag + 1];
  if (flag !== -1 && !liveProviderModule) throw new Error("--live-provider-module requires a module path.");
  process.stdout.write(`${JSON.stringify(await runReviewedGroundingReference({ liveProviderModule }), null, 2)}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
