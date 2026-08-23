import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseArgs, flagString } from "../lib/args.js";
import { atomicWriteFile } from "../lib/fs.js";
import { execTrustedGitSync, resolveTrustedLocalGitCommit } from "../lib/trusted-git.js";
import { inspectBuilderFlowSession, publishChangeAuthorityRef } from "../builder-flow-runtime.js";
import { validateRunStateConsistency } from "@kontourai/flow";
import { readLocalAssignmentStatus, resolveCurrentAssignmentActor, withSubjectLockAsync } from "./assignment-provider.js";
import { validateTrustBundle } from "./workflow-sidecar.js";
import { resolveEffectiveChangeProviderSettings } from "./effective-change-provider-settings.js";
import { executeMergeChangeProvider } from "./merge-change-provider.js";
import { assertAuthenticatedMergeChangeObservation, assertIssuedMergeChangeAction, buildUnsignedMergeChangeAuthorization, issueMergeChangeAction, MERGE_CHANGE_STRATEGIES, type AuthenticatedMergeChangeObservation, type IssuedMergeChangeAction, type MergeChangeStrategy } from "../merge-change-operation-authority.js";
import { assertAuthenticatedPublishChangeObservation, issuePublishChangeAction } from "../publish-change-operation-authority.js";
import type { ChangeProviderSettings, PublishChangeActionBinding } from "./public-contracts.js";
import { invokeExternalLifecycleAuthority, type ExternalLifecycleMutationResult } from "../external-lifecycle-authority.js";

const FLAGS = new Set(["session-dir", "strategy", "authorization-file"]);
const REQUEST_FLAGS = new Set(["session-dir", "strategy", "out", "requested-at", "expires-at", "nonce"]);
const VALIDATE_FLAGS = new Set(["session-dir", "head-ref"]);
const DELIVERY_FILES = ["trust.bundle", "trust.checkpoint.attestation.json", "trust.checkpoint.intoto.json", "trust.checkpoint.json", "trust.checkpoint.sig.json"] as const;

type SessionContext = { sessionDir: string; artifactRoot: string; projectRoot: string; slug: string };
type CompletedMerge = { action: IssuedMergeChangeAction; observation: AuthenticatedMergeChangeObservation };
type CanonicalRunDefinitions = { startDefinition: Record<string, unknown>; effectiveDefinition: Record<string, unknown> };
type MergeChangeCliDependencies = Readonly<{
  /** Internal test seam; the public CLI always uses the authenticated defaults. */
  currentAction?: (context: SessionContext, strategy: MergeChangeStrategy) => Promise<IssuedMergeChangeAction>;
  provider?: ChangeProviderSettings;
  executeProvider?: (provider: ChangeProviderSettings, action: IssuedMergeChangeAction) => Promise<AuthenticatedMergeChangeObservation>;
  /** Internal test seam; production always invokes the protected lifecycle helper. */
  authorizeOperation?: (context: SessionContext, action: IssuedMergeChangeAction, authorizationFile: string) => ExternalLifecycleMutationResult;
}>;

function projectRootForSession(sessionDirInput: string): SessionContext {
  const sessionDir = path.resolve(sessionDirInput);
  const artifactRoot = path.dirname(sessionDir);
  const kontouraiRoot = path.dirname(artifactRoot);
  if (path.basename(artifactRoot) !== "flow-agents" || path.basename(kontouraiRoot) !== ".kontourai") throw new Error("merge-change execute --session-dir must be .kontourai/flow-agents/<slug>");
  return { sessionDir, artifactRoot, projectRoot: path.dirname(kontouraiRoot), slug: path.basename(sessionDir) };
}

function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function readRegularFile(file: string, label: string): Buffer {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error(`${label} must be a bounded regular file`);
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function git(projectRoot: string, args: string[]): Buffer {
  return Buffer.from(execTrustedGitSync(projectRoot, args, "buffer"));
}

function assertCleanWorktree(projectRoot: string): void {
  const status = git(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).toString("utf8");
  if (status.trim()) throw new Error("merge-change requires a clean worktree before authenticating terminal delivery");
}

function assertCurrentAssignment(context: SessionContext): string {
  const current = resolveCurrentAssignmentActor();
  const assignment = readLocalAssignmentStatus(context.artifactRoot, context.slug).record;
  if (!assignment || assignment.actor_key !== current.actorKey || !isDeepStrictEqual({ ...assignment.actor, human: assignment.actor.human ?? null }, current.actor)) {
    throw new Error("merge-change requires the session's active, matching assignment actor");
  }
  return current.actorKey;
}

function deliveryNamesFromHead(context: SessionContext, terminalHead: string): string[] {
  return git(context.projectRoot, ["ls-tree", "-r", "--name-only", terminalHead, "--", `delivery/${context.slug}`]).toString("utf8").split("\n").filter(Boolean).map((file) => path.posix.basename(file)).sort();
}

function assertCheckpointCompanionIntegrity(bundle: unknown, checkpoint: Buffer, attestation: Record<string, unknown>, companion: Buffer, expectedName: string): void {
  let statement: unknown;
  if (attestation.status === "unsigned") {
    try { statement = JSON.parse(companion.toString("utf8")); } catch { throw new Error("merge-change terminal checkpoint companion is not valid JSON"); }
  } else if (attestation.status === "signed") {
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(companion.toString("utf8")) as Record<string, unknown>; } catch { throw new Error("merge-change signed checkpoint companion is not valid JSON"); }
    if (envelope.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string" || !Array.isArray(envelope.signatures) || envelope.signatures.length === 0) throw new Error("merge-change signed checkpoint companion has an invalid DSSE envelope");
    try { statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")); } catch { throw new Error("merge-change signed checkpoint companion payload is not valid JSON"); }
  } else {
    throw new Error("merge-change terminal checkpoint attestation has an unsupported status");
  }
  if (!statement || typeof statement !== "object" || Array.isArray(statement)) throw new Error("merge-change terminal checkpoint statement is invalid");
  const entry = statement as Record<string, unknown>;
  const subjects = Array.isArray(entry.subject) ? entry.subject : [];
  const subject = subjects.find((value) => value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).name === "trust.checkpoint.json") as Record<string, unknown> | undefined;
  const digest = subject?.digest && typeof subject.digest === "object" && !Array.isArray(subject.digest) ? (subject.digest as Record<string, unknown>).sha256 : undefined;
  if (entry._type !== "https://in-toto.io/Statement/v1" || entry.predicateType !== "https://hachure.org/v1/bundle" || digest !== sha256(checkpoint) || !isDeepStrictEqual(entry.predicate, bundle)) {
    throw new Error(`merge-change ${expectedName} does not bind the canonical session checkpoint and trust bundle`);
  }
}

/**
 * Terminal delivery is valid only when its source session and committed branch
 * companions are byte-identical and the sole post-checkpoint changes are that
 * exact owned companion set. This intentionally has no tree-equivalence path.
 */
async function assertExactTerminalDelivery(context: SessionContext, terminalHead: string): Promise<void> {
  assertCleanWorktree(context.projectRoot);
  const checkedOut = git(context.projectRoot, ["rev-parse", "HEAD"]).toString("utf8").trim().toLowerCase();
  if (checkedOut !== terminalHead) throw new Error("merge-change requires the terminal source branch checked out at its exact head");
  const root = path.join(context.projectRoot, "delivery", context.slug);
  const sessionNames = fs.readdirSync(context.sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (DELIVERY_FILES as readonly string[]).includes(entry.name))
    .map((entry) => entry.name).sort();
  const sessionCompanion = sessionNames.filter((name) => name === "trust.checkpoint.sig.json" || name === "trust.checkpoint.intoto.json");
  const sessionExpected = ["trust.bundle", "trust.checkpoint.attestation.json", "trust.checkpoint.json", ...sessionCompanion].sort();
  if (sessionCompanion.length !== 1 || !isDeepStrictEqual(sessionNames, sessionExpected)) throw new Error("merge-change requires exactly the canonical session terminal bundle, checkpoint, attestation, and one companion");
  const sessionBundle = JSON.parse(readRegularFile(path.join(context.sessionDir, "trust.bundle"), "session trust.bundle").toString("utf8"));
  const validation = await validateTrustBundle(sessionBundle);
  if (!validation.available || !validation.valid) throw new Error("merge-change requires flow-agents workflow publish-delivery to produce a canonical valid session trust.bundle, then an exact-head provider check refresh before retry");
  assertCanonicalBundleRunBinding(sessionBundle, context.slug);
  const sessionCheckpoint = JSON.parse(readRegularFile(path.join(context.sessionDir, "trust.checkpoint.json"), "session trust.checkpoint.json").toString("utf8")) as Record<string, unknown>;
  const sessionAttestation = JSON.parse(readRegularFile(path.join(context.sessionDir, "trust.checkpoint.attestation.json"), "session trust.checkpoint.attestation.json").toString("utf8")) as Record<string, unknown>;
  if (sessionCheckpoint.slug !== context.slug || sessionCheckpoint.status !== "delivered" || sessionCheckpoint.phase !== "release" || typeof sessionCheckpoint.commit_sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(sessionCheckpoint.commit_sha)
    || !["signed", "unsigned"].includes(String(sessionAttestation.status)) || sessionAttestation.path !== sessionCompanion[0]) {
    throw new Error("merge-change requires flow-agents workflow publish-delivery to produce a canonical delivered release checkpoint for this session, then an exact-head provider check refresh before retry");
  }
  assertCheckpointCompanionIntegrity(sessionBundle, readRegularFile(path.join(context.sessionDir, "trust.checkpoint.json"), "session trust.checkpoint.json"), sessionAttestation, readRegularFile(path.join(context.sessionDir, sessionCompanion[0]!), `session ${sessionCompanion[0]}`), sessionCompanion[0]!);
  const names = deliveryNamesFromHead(context, terminalHead);
  const companion = names.filter((name) => name === "trust.checkpoint.sig.json" || name === "trust.checkpoint.intoto.json");
  const expected = ["trust.bundle", "trust.checkpoint.attestation.json", "trust.checkpoint.json", ...companion].sort();
  if (companion.length !== 1 || !isDeepStrictEqual(names, expected)) throw new Error("merge-change requires exactly the committed terminal delivery companions for this session");
  for (const name of expected) {
    if (!(DELIVERY_FILES as readonly string[]).includes(name)) throw new Error("merge-change found an unsupported delivery companion");
    const session = readRegularFile(path.join(context.sessionDir, name), `session ${name}`);
    const local = readRegularFile(path.join(root, name), `delivery/${context.slug}/${name}`);
    const committed = git(context.projectRoot, ["show", `${terminalHead}:delivery/${context.slug}/${name}`]);
    if (!session.equals(local) || !local.equals(committed) || sha256(session) !== sha256(local) || sha256(local) !== sha256(committed)) throw new Error("merge-change requires canonical session, working-tree, and committed terminal delivery companions to be byte-identical");
  }
  const checkpoint = JSON.parse(git(context.projectRoot, ["show", `${terminalHead}:delivery/${context.slug}/trust.checkpoint.json`]).toString("utf8")) as Record<string, unknown>;
  if (checkpoint.slug !== context.slug || checkpoint.status !== "delivered" || checkpoint.phase !== "release" || typeof checkpoint.commit_sha !== "string" || !/^[a-f0-9]{40,64}$/i.test(checkpoint.commit_sha)) {
    throw new Error("merge-change requires flow-agents workflow publish-delivery to commit a delivered release checkpoint for this session, then an exact-head provider check refresh before retry");
  }
  try {
    git(context.projectRoot, ["merge-base", "--is-ancestor", checkpoint.commit_sha, terminalHead]);
    const changed = git(context.projectRoot, ["diff", "--name-only", `${checkpoint.commit_sha}..${terminalHead}`, "--"]).toString("utf8").split("\n").filter(Boolean).sort();
    const expectedPaths = expected.map((name) => `delivery/${context.slug}/${name}`).sort();
    if (!isDeepStrictEqual(changed, expectedPaths)) throw new Error("unexpected terminal delta");
  } catch {
    throw new Error("merge-change requires an ancestor-bound delivery-only terminal commit; squash/post-merge follow-ups and source drift are refused. Run flow-agents workflow publish-delivery, then refresh the exact-head provider checks before retrying.");
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/**
 * Same authentication as builder-flow-runtime.ts's
 * entryAuthenticatesPublishChangeAction: primary path checks the claim-scoped
 * `authorityRef` embedded in the evidence's TrustBundle authorityTrace array
 * (Flow 5.0's replacement for the removed `authorityTrace` attachEvidence
 * option); legacy fallback recognizes the flat `authority_trace` string that
 * flow-agents wrote before this migration, for evidence attached to a
 * long-running run before an in-place upgrade. See the longer rationale on
 * publishChangeAuthorityRef's call site in builder-flow-runtime.ts.
 */
function evidenceAuthenticatesPublishChangeAction(evidence: Record<string, unknown>, actionId: string): boolean {
  const bundle = evidence.bundle;
  if (bundle && typeof bundle === "object" && !Array.isArray(bundle) && Array.isArray((bundle as Record<string, unknown>).authorityTrace)) {
    const expected = publishChangeAuthorityRef(actionId);
    const found = ((bundle as Record<string, unknown>).authorityTrace as unknown[]).some((trace) =>
      trace && typeof trace === "object" && !Array.isArray(trace) && (trace as Record<string, unknown>).authorityRef === expected);
    if (found) return true;
  }
  return evidence.authority_trace === actionId;
}

export function resultDigestClaimedByCanonicalRun(manifest: unknown, actionId: string, observation: ReturnType<typeof assertAuthenticatedPublishChangeObservation>, digest: string, binding: PublishChangeActionBinding, slug: string, startDefinition: { id: string; version: string }): boolean {
  const root = record(manifest, "canonical Flow evidence manifest");
  if (root.run_id !== slug || root.definition_id !== startDefinition.id || root.definition_version !== startDefinition.version || !Array.isArray(root.evidence)) return false;
  const summary = `Authenticated publish-change operation ${actionId} observed ${observation.change_ref.state} provider record ${observation.change_ref.provider_record_id}`;
  return root.evidence.some((entry) => {
    try {
      const evidence = record(entry, "canonical publish-change evidence");
      if (evidence.gate_id !== binding.gate_ids[0] || evidence.producer !== "publish-change-operation-authority" || !evidenceAuthenticatesPublishChangeAction(evidence, actionId) || !Array.isArray(evidence.expectation_ids) || evidence.expectation_ids.length !== 1 || evidence.expectation_ids[0] !== "pull-request-opened") return false;
      const bundle = record(evidence.bundle, "canonical publish-change evidence bundle");
      if (!Array.isArray(bundle.claims)) return false;
      return bundle.claims.some((claim) => {
        const entryClaim = record(claim, "canonical publish-change claim");
        const metadata = record(entryClaim.metadata, "canonical publish-change claim metadata");
        return entryClaim.fieldOrBehavior === summary && Array.isArray(metadata.artifact_refs) && metadata.artifact_refs.some((ref) => {
          const artifact = record(ref, "canonical publish-change artifact reference");
          return artifact.kind === "provider" && artifact.sha256 === digest;
        });
      });
    } catch { return false; }
  });
}

function assertCanonicalBundleRunBinding(bundle: unknown, slug: string): void {
  const root = record(bundle, "session trust.bundle");
  if (!Array.isArray(root.claims) || root.claims.length === 0 || !root.claims.every((claim) => {
    try { return typeof record(claim, "session trust bundle claim").subjectId === "string" && (record(claim, "session trust bundle claim").subjectId as string).startsWith(`${slug}/`); } catch { return false; }
  })) {
    throw new Error("merge-change requires canonical trust.bundle claims bound to this completed session slug");
  }
}

function readAuthenticatedPublishResult(context: SessionContext, inspected: Awaited<ReturnType<typeof inspectBuilderFlowSession>>, provider: ChangeProviderSettings, startDefinition: { id: string; version: string }): ReturnType<typeof assertAuthenticatedPublishChangeObservation> {
  const bytes = readRegularFile(path.join(context.sessionDir, "publish-change.result.json"), "publish-change.result.json");
  if (bytes.byteLength > 65_536) throw new Error("merge-change publish-change.result.json exceeds the canonical operation bound");
  let raw: Record<string, unknown>;
  try { raw = record(JSON.parse(bytes.toString("utf8")), "publish-change.result.json"); } catch { throw new Error("merge-change.result requires a valid authenticated publish-change.result.json"); }
  const actionId = typeof raw.operation_action_id === "string" && /^[a-f0-9]{64}$/u.test(raw.operation_action_id) ? raw.operation_action_id : null;
  if (!actionId) throw new Error("merge-change requires a publish-change.result.json operation action identity");
  const observation = { ...raw };
  delete observation.operation_action_id;
  const candidate = issuePublishChangeAction({
    binding: record(observation.binding, "publish-change binding") as PublishChangeActionBinding,
    provider,
    assignment_actor: String(observation.assignment_actor ?? ""),
    intent: { title: "canonical completed publish-change", body: "canonical completed publish-change", base_ref: String(record(observation.change_ref, "publish-change change reference").base_ref ?? ""), head_ref: String(record(observation.change_ref, "publish-change change reference").head_ref ?? ""), head_sha: String(record(observation.change_ref, "publish-change change reference").head_sha ?? "") },
  });
  const authenticated = assertAuthenticatedPublishChangeObservation(candidate, observation);
  if (authenticated.binding.run_id !== context.slug || authenticated.binding.definition_id !== inspected.run.definitionId || authenticated.binding.definition_version !== inspected.run.definitionVersion) {
    throw new Error("merge-change requires publish-change result binding to the canonical completed run");
  }
  if (!resultDigestClaimedByCanonicalRun(inspected.run.manifest, actionId, authenticated, sha256(bytes), authenticated.binding, context.slug, startDefinition)) {
    throw new Error("merge-change requires publish-change.result.json action and digest bound to canonical completed run evidence");
  }
  return authenticated;
}

function readExistingResult(context: SessionContext, action: IssuedMergeChangeAction): CompletedMerge | null {
  const file = path.join(context.sessionDir, "merge-change.result.json");
  if (!fs.existsSync(file)) return null;
  let value: unknown;
  try { value = JSON.parse(readRegularFile(file, "merge-change.result.json").toString("utf8")); } catch { throw new Error("merge-change.result.json is malformed; refusing replay"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("merge-change.result.json is malformed; refusing replay");
  const record = value as Record<string, unknown>;
  const existingAction = assertIssuedMergeChangeAction(record.action);
  if (!isDeepStrictEqual(existingAction, action)) throw new Error("merge-change.result.json already exists for a different strategy, head, assignment, or provider configuration");
  return { action: existingAction, observation: assertAuthenticatedMergeChangeObservation(existingAction, record.observation) };
}

async function currentAction(context: SessionContext, strategy: MergeChangeStrategy): Promise<IssuedMergeChangeAction> {
  const inspected = await inspectBuilderFlowSession({ sessionDir: context.sessionDir });
  if (inspected.run.definitionId !== "builder.build" || inspected.run.state.status !== "completed" || !["learn", "done"].includes(inspected.run.state.current_step)) {
    throw new Error("merge-change requires the completed canonical builder.build run after learning and terminal delivery; run flow-agents workflow publish-delivery, then refresh the exact-head provider checks before retrying");
  }
  const actor = assertCurrentAssignment(context);
  const effective = resolveEffectiveChangeProviderSettings(context.projectRoot, path.join(context.projectRoot, "context", "settings", "change-provider-settings.json"));
  if (effective.status !== "configured" || !effective.provider || typeof effective.provider !== "object") throw new Error("merge-change requires a configured ChangeProvider");
  const definitions = validateCanonicalRunDefinitions(inspected);
  const published = readAuthenticatedPublishResult(context, inspected, effective.provider as ChangeProviderSettings, definitions.startDefinition as { id: string; version: string });
  const change = published.change_ref;
  const terminalHead = resolveTrustedLocalGitCommit(context.projectRoot, change.head_ref);
  await assertExactTerminalDelivery(context, terminalHead);
  assertEvidenceRefreshControl(inspected, definitions);
  return issueMergeChangeAction({ binding: published.binding, provider: effective.provider as ChangeProviderSettings, assignment_actor: actor, expected_provider_actor: published.provider_actor, intent: { strategy, change_number: change.number, base_ref: change.base_ref, head_ref: change.head_ref, terminal_head_sha: terminalHead } });
}

function validateCanonicalRunDefinitions(inspected: Awaited<ReturnType<typeof inspectBuilderFlowSession>>): CanonicalRunDefinitions {
  const definitionFile = path.join(inspected.run.dir, "definition.json");
  let startDefinition: Record<string, unknown>;
  try { startDefinition = record(JSON.parse(readRegularFile(definitionFile, "canonical Flow start definition").toString("utf8")), "canonical Flow start definition"); }
  catch { throw new Error("merge-change requires a readable canonical Flow start definition"); }
  let validated: ReturnType<typeof validateRunStateConsistency>;
  try { validated = validateRunStateConsistency(startDefinition, inspected.run.state, { runId: inspected.run.runId }); }
  catch { throw new Error("merge-change requires a canonical Flow state consistent with its immutable start definition and authorized amendments"); }
  const effectiveDefinition = record(validated.definition, "canonical effective Flow definition");
  const validatedStartDefinition = record(validated.startDefinition, "canonical Flow start definition");
  if (!isDeepStrictEqual(validatedStartDefinition, inspected.run.startDefinition)
    || !isDeepStrictEqual(effectiveDefinition, inspected.run.definition)
    || effectiveDefinition.id !== inspected.run.definitionId
    || effectiveDefinition.version !== inspected.run.definitionVersion) {
    throw new Error("merge-change canonical Flow definition identity is inconsistent");
  }
  const manifest = record(inspected.run.manifest, "canonical Flow evidence manifest");
  if (manifest.run_id !== inspected.run.runId
    || manifest.definition_id !== validatedStartDefinition.id
    || manifest.definition_version !== validatedStartDefinition.version) {
    throw new Error("merge-change requires the canonical evidence manifest bound to the immutable start definition");
  }
  return { startDefinition: validatedStartDefinition, effectiveDefinition };
}

/**
 * #1300: this was a deep-equal against a two-key route-map literal, which refused the kit's own
 * shipped three-key map (implementation_defect -> execute) — a second component re-encoding a
 * contract the flow definition owns. The semantic requirement is that stale evidence is
 * refreshable: the refresh entries must be PRESENT with the bounded blocking policy; additional
 * repair routes never weaken that and are the flow definition's business. Exported so a test can
 * bind this predicate to the REAL resolved builder.build definition — zero coverage on the
 * literal is exactly how #1300 shipped.
 */
export function evidenceRefreshRoutesSatisfied(gate: Record<string, unknown>): boolean {
  const routes = gate.on_route_back;
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) return false;
  return (routes as Record<string, unknown>).missing_evidence === "verify"
    && (routes as Record<string, unknown>).default === "verify"
    && isDeepStrictEqual(gate.route_back_policy, { max_attempts: 3, on_exceeded: "block" });
}

function assertEvidenceRefreshControl(inspected: Awaited<ReturnType<typeof inspectBuilderFlowSession>>, definitions: CanonicalRunDefinitions): void {
  const manifestFile = path.join(inspected.run.dir, "evidence", "manifest.json");
  const definition = definitions.effectiveDefinition;
  const gates = record(definition.gates, "canonical Flow definition gates");
  const gate = record(gates["builder.publish-learn:merge-ready-ci-gate"], "canonical merge-ready-ci gate");
  if (!evidenceRefreshRoutesSatisfied(gate)) {
    throw new Error("merge-change requires the completed run to semantically adopt merge-ready-ci evidence refresh (missing_evidence/default -> verify with bounded block policy)");
  }
  assertEvidenceRefreshVerificationProvenance(inspected.run.state, inspected.run.definitionId, inspected.run.definitionVersion, inspected.run.definitionDigest);
  // Force the same protected regular-file constraints used for a signed request
  // before the helper binds its independently recomputed digest.
  readRegularFile(manifestFile, "canonical Flow evidence manifest");
}

function assertEvidenceRefreshVerificationProvenance(state: Record<string, unknown>, definitionId: string, definitionVersion: string, definitionDigest: string): void {
  const amendments = Array.isArray(state.definition_amendments) ? state.definition_amendments : [];
  const adopted = amendments.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    && (entry as Record<string, unknown>).type === "definition_amended"
    && (() => {
      const successor = (entry as Record<string, unknown>).successor_definition;
      return successor && typeof successor === "object" && !Array.isArray(successor)
        && (successor as Record<string, unknown>).id === definitionId
        && (successor as Record<string, unknown>).version === definitionVersion
        && (successor as Record<string, unknown>).digest === definitionDigest;
    })());
  if (amendments.length === 0) {
    if (state.definition_digest !== definitionDigest) throw new Error("merge-change requires start-definition proof for the canonical evidence-refresh definition");
    return;
  }
  if (adopted.length !== 1) throw new Error("merge-change requires one authenticated definition amendment adopting the canonical evidence-refresh definition");
  const amendedAt = Date.parse(String((adopted[0] as Record<string, unknown>).at));
  const history = Array.isArray(state.gate_outcome_history) ? state.gate_outcome_history : [];
  const refreshedPass = history.some((outcome) => {
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) return false;
    const entry = outcome as Record<string, unknown>;
    const transition = entry.transition_validation && typeof entry.transition_validation === "object"
      ? (entry.transition_validation as Record<string, unknown>).transition : undefined;
    const at = transition && typeof transition === "object" ? Date.parse(String((transition as Record<string, unknown>).at)) : Number.NaN;
    return entry.gate_id === "verify-gate" && entry.status === "pass" && Number.isFinite(amendedAt) && at > amendedAt;
  });
  if (!refreshedPass) throw new Error("merge-change requires an accepted verify-gate pass ordered after the definition amendment that adopted evidence refresh");
}

async function prepareAuthorizationRequest(context: SessionContext, strategy: MergeChangeStrategy, input: { nonce?: string; requestedAt?: string; expiresAt?: string }) {
  const action = await currentAction(context, strategy);
  const inspected = await inspectBuilderFlowSession({ sessionDir: context.sessionDir });
  assertEvidenceRefreshControl(inspected, validateCanonicalRunDefinitions(inspected));
  const flow = record(inspected.projection.flow_run, "canonical Flow projection");
  const manifestBytes = readRegularFile(path.join(inspected.run.dir, "evidence", "manifest.json"), "canonical Flow evidence manifest");
  const requested_at = input.requestedAt ?? new Date().toISOString();
  const expires_at = input.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString();
  return buildUnsignedMergeChangeAuthorization({
    project_root: context.projectRoot, run_id: context.slug, subject: String(inspected.run.state.subject ?? ""),
    flow_definition_id: inspected.run.definitionId, flow_definition_version: inspected.run.definitionVersion,
    flow_definition_digest: inspected.run.definitionDigest, flow_run_head: String(flow.run_head ?? ""), flow_manifest_sha256: sha256(manifestBytes),
    issued_action: action, nonce: input.nonce ?? randomBytes(24).toString("hex"), requested_at, expires_at,
  });
}

async function execute(argv: string[], dependencies: MergeChangeCliDependencies = {}): Promise<number> {
  const args = parseArgs(argv);
  if (args.positionals.length !== 0) throw new Error("merge-change execute accepts only named flags");
  for (const key of Object.keys(args.flags)) if (!FLAGS.has(key) || Array.isArray(args.flags[key])) throw new Error(`merge-change execute does not support repeated or unknown --${key}`);
  const sessionDir = flagString(args.flags, "session-dir");
  const strategy = flagString(args.flags, "strategy");
  const authorizationFile = flagString(args.flags, "authorization-file");
  if (!sessionDir || !strategy || !authorizationFile || !(MERGE_CHANGE_STRATEGIES as readonly string[]).includes(strategy)) throw new Error("merge-change execute requires --session-dir, --strategy squash|rebase|merge-commit|merge-queue, and signed --authorization-file <path>");
  const context = projectRootForSession(sessionDir);
  const result = await withSubjectLockAsync(context.artifactRoot, context.slug, async () => {
    const resolveAction = dependencies.currentAction ?? currentAction;
    const action = await resolveAction(context, strategy as MergeChangeStrategy);
    // A persisted result is an untrusted recovery hint, never merge authority.
    // In particular, a shape-valid `state: merged` record must be re-observed
    // through the authenticated provider path before it can be returned.
    readExistingResult(context, action);
    const effective = dependencies.provider
      ? { status: "configured", provider: dependencies.provider }
      : resolveEffectiveChangeProviderSettings(context.projectRoot, path.join(context.projectRoot, "context", "settings", "change-provider-settings.json"));
    if (effective.status !== "configured" || !effective.provider || typeof effective.provider !== "object") throw new Error("merge-change requires a configured ChangeProvider");
    const authorization = (dependencies.authorizeOperation ?? ((requestContext, issuedAction, file) => invokeExternalLifecycleAuthority({
      action: "merge-change", project_root: requestContext.projectRoot, session_dir: requestContext.sessionDir, authorization_file: file, issued_action_id: issuedAction.action_id,
    })))(context, action, authorizationFile);
    // The coordinator records its completion before the provider mutation. A
    // replay therefore proves only that authority was consumed, not that the
    // destructive provider call completed. Requiring a fresh applied
    // authorization prevents an expired replay from becoming indefinite merge
    // authority; recovery reissues authority and reobserves provider state.
    if (authorization.run_id !== context.slug || authorization.operation_status !== "applied" || authorization.authorized_action_id !== action.action_id) throw new Error("merge-change requires fresh applied lifecycle authority bound to the exact current issued action");
    const observation = await (dependencies.executeProvider ?? executeMergeChangeProvider)(effective.provider as ChangeProviderSettings, action);
    const current = await resolveAction(context, strategy as MergeChangeStrategy);
    if (!isDeepStrictEqual(current, action)) throw new Error("merge-change action changed while provider mutation was in flight");
    const authenticatedObservation = assertAuthenticatedMergeChangeObservation(current, observation);
    const payload = { action: current, observation: authenticatedObservation };
    atomicWriteFile(context.sessionDir, path.join(context.sessionDir, "merge-change.result.json"), `${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  });
  console.log(JSON.stringify({ operation: "merge-change", action_id: result.action.action_id, strategy, terminal_head_sha: result.action.intent.terminal_head_sha, state: result.observation.state }, null, 2));
  return 0;
}

/** Public, read-only signing-request surface for a protected merge authorization. */
async function requestAuthorization(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.positionals.length !== 0) throw new Error("merge-change request accepts only named flags");
  for (const key of Object.keys(args.flags)) if (!REQUEST_FLAGS.has(key) || Array.isArray(args.flags[key])) throw new Error(`merge-change request does not support repeated or unknown --${key}`);
  const sessionDir = flagString(args.flags, "session-dir");
  const strategy = flagString(args.flags, "strategy");
  const out = flagString(args.flags, "out");
  if (!sessionDir || !strategy || !out || !(MERGE_CHANGE_STRATEGIES as readonly string[]).includes(strategy)) throw new Error("merge-change request requires --session-dir, --strategy squash|rebase|merge-commit|merge-queue, and --out <unsigned authorization path>");
  const context = projectRootForSession(sessionDir);
  const prepared = await withSubjectLockAsync(context.artifactRoot, context.slug, async () => prepareAuthorizationRequest(context, strategy as MergeChangeStrategy, {
    nonce: flagString(args.flags, "nonce"), requestedAt: flagString(args.flags, "requested-at"), expiresAt: flagString(args.flags, "expires-at"),
  }));
  const target = path.resolve(out);
  const descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(prepared.unsigned, null, 2)}\n`); } finally { fs.closeSync(descriptor); }
  console.log(JSON.stringify({ operation: "merge-change", unsigned_authorization_file: target, signing_payload: prepared.signingPayload, next_steps: [
    "Sign signing_payload with a registered lifecycle-authority Ed25519 key.",
    `Add signature {\"algorithm\":\"ed25519\",\"key_id\":\"<registry key id>\",\"value\":\"<base64 signature>\"} to ${target}.`,
    `Run: flow-agents merge-change execute --session-dir ${context.sessionDir} --strategy ${strategy} --authorization-file ${target}`,
  ] }, null, 2));
  return 0;
}

/** Read-only diagnostic used by delivery operators and deterministic topology tests. */
async function validateTerminalDelivery(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.positionals.length !== 0) throw new Error("merge-change validate-terminal-delivery accepts only named flags");
  for (const key of Object.keys(args.flags)) if (!VALIDATE_FLAGS.has(key) || Array.isArray(args.flags[key])) throw new Error(`merge-change validate-terminal-delivery does not support repeated or unknown --${key}`);
  const sessionDir = flagString(args.flags, "session-dir");
  const headRef = flagString(args.flags, "head-ref");
  if (!sessionDir || !headRef) throw new Error("merge-change validate-terminal-delivery requires --session-dir and --head-ref");
  const context = projectRootForSession(sessionDir);
  const head = resolveTrustedLocalGitCommit(context.projectRoot, headRef);
  await assertExactTerminalDelivery(context, head);
  console.log(JSON.stringify({ operation: "merge-change", validation: "terminal-delivery", terminal_head_sha: head, status: "pass" }, null, 2));
  return 0;
}

export function main(argv = process.argv.slice(2), dependencies: MergeChangeCliDependencies = {}): number | Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (command === "execute") return execute(rest, dependencies).catch((error) => { console.error(`merge-change: ${(error as Error).message}`); return 1; });
    if (command === "request") return requestAuthorization(rest).catch((error) => { console.error(`merge-change: ${(error as Error).message}`); return 1; });
    if (command === "validate-terminal-delivery") return validateTerminalDelivery(rest).catch((error) => { console.error(`merge-change: ${(error as Error).message}`); return 1; });
    console.error("usage: merge-change <request|execute|validate-terminal-delivery> --session-dir .kontourai/flow-agents/<slug>");
    return 2;
  } catch (error) { console.error(`merge-change: ${(error as Error).message}`); return 1; }
}
