import * as fs from "node:fs";
import * as path from "node:path";
import {
  readWorkflowProcessSources,
  type ConsoleProjectionRef,
  type ConsoleProjectionScope,
  type WorkflowProcessSource,
} from "./workflow-process-projection.js";

export type SurfaceTrustRuntime = {
  validateTrustBundle: (input: unknown) => Record<string, unknown>;
  buildTrustReport: (
    bundle: Record<string, unknown>,
    options?: { now?: Date },
  ) => Record<string, unknown>;
};

export type ConsoleTrustGateAssociation = {
  gateId: string;
  claimIds: string[];
  evidenceIds: string[];
  eventIds: string[];
};

export type ConsoleTrustSourceOfTruthRef = ConsoleProjectionRef & {
  url?: string;
  sourcePath?: string;
};

export type WorkflowTrustSource = {
  path: string;
  relativePath: string;
  slug: string;
  processSource: WorkflowProcessSource;
  report: Record<string, unknown>;
  gateAssociations: ConsoleTrustGateAssociation[];
  sourceOfTruthRefs: ConsoleTrustSourceOfTruthRef[];
};

export type ConsoleTrustProjection = {
  id: string;
  family: "workflow";
  nonAuthority: true;
  subjectRef: ConsoleProjectionRef;
  sourceRef: ConsoleProjectionRef;
  payload: Record<string, unknown>;
  gateAssociations: ConsoleTrustGateAssociation[];
  sourceOfTruthRefs: ConsoleTrustSourceOfTruthRef[];
  extensions: {
    "flow-agents": {
      task_slug: string;
      source_path: string;
    };
  };
};

export type ConsoleTrustProjectionEnvelope = {
  schema: "kontour.console.projection";
  version: "0.1";
  generatedAt: string;
  scope: ConsoleProjectionScope;
  producer: {
    id: string;
    product: "flow-agents";
  };
  derivedFrom: {
    mode: "direct_snapshot";
    eventHistory: "unavailable";
    directSnapshot: {
      id: string;
      emittedAt: string;
      producer: {
        id: string;
        product: "flow-agents";
      };
      reason: string;
      sourceRef: ConsoleProjectionRef;
    };
  };
  trusts: ConsoleTrustProjection[];
};

export type BuildWorkflowTrustProjectionOptions = {
  scope: string | ConsoleProjectionScope;
  generatedAt: string;
  producer?: {
    id?: string;
    product?: "flow-agents";
  };
};

export type ReadWorkflowTrustSourcesOptions = {
  generatedAt: string;
  surface?: SurfaceTrustRuntime;
};

export type ReadWorkflowTrustSourcesResult = {
  sources: WorkflowTrustSource[];
  warnings: string[];
  scannedWorkflowCount: number;
};

type AssignmentRecord = {
  actor?: unknown;
  actor_key?: unknown;
  work_item_ref?: unknown;
  branch?: unknown;
  artifact_dir?: unknown;
  subject_id?: unknown;
  status?: unknown;
};

const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_ASSIGNMENT_BYTES = 1024 * 1024;

export function projectionTimestamp(value?: string): string {
  const timestamp = value ?? new Date().toISOString();
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`generatedAt must be a valid ISO timestamp: ${timestamp}`);
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function loadSurfaceTrustRuntime(): Promise<SurfaceTrustRuntime> {
  if (process.env.FLOW_AGENTS_SURFACE_UNAVAILABLE === "1") {
    throw new Error("@kontourai/surface is unavailable; run npm ci and ensure the package can be imported before projecting trust.bundle");
  }
  let imported: unknown;
  try {
    imported = await import("@kontourai/surface");
  } catch (error) {
    throw new Error(`@kontourai/surface is unavailable; run npm ci and ensure the package can be imported before projecting trust.bundle (${errorMessage(error)})`);
  }
  const surface = imported as Partial<SurfaceTrustRuntime>;
  if (typeof surface.validateTrustBundle !== "function" || typeof surface.buildTrustReport !== "function") {
    throw new Error("@kontourai/surface does not expose validateTrustBundle and buildTrustReport; install a compatible Surface version before projecting trust.bundle");
  }
  return surface as SurfaceTrustRuntime;
}

export async function readWorkflowTrustSources(
  artifactRoot: string,
  options: ReadWorkflowTrustSourcesOptions,
): Promise<ReadWorkflowTrustSourcesResult> {
  const root = path.resolve(artifactRoot);
  const surface = options.surface ?? await loadSurfaceTrustRuntime();
  // #891 review finding 2 (HIGH): one workflow's malformed state.json or
  // handoff.json must not abort the sibling workflows' trust projection --
  // scan in warn mode so a broken sidecar is recorded and skipped per-slug.
  const processRead = readWorkflowProcessSources(root, { onWorkflowError: "warn" });
  const sources: WorkflowTrustSource[] = [];
  const warnings = [...processRead.warnings];
  const now = new Date(options.generatedAt);
  if (!Number.isFinite(now.getTime())) throw new Error(`generatedAt must be a valid ISO timestamp: ${options.generatedAt}`);

  for (const processSource of processRead.sources) {
    const bundleFile = path.join(root, processSource.slug, "trust.bundle");
    if (!fs.existsSync(bundleFile)) continue;
    let parsed: unknown;
    try {
      parsed = readJsonNoFollow(bundleFile, `${processSource.slug}/trust.bundle`, MAX_BUNDLE_BYTES);
    } catch (error) {
      warnings.push(`${processSource.slug}: trust.bundle is invalid (${errorMessage(error)}) -- skipping trust projection`);
      continue;
    }

    let bundle: Record<string, unknown>;
    let report: Record<string, unknown>;
    try {
      bundle = surface.validateTrustBundle(parsed);
      report = surface.buildTrustReport(bundle, { now });
    } catch (error) {
      warnings.push(`${processSource.slug}: trust.bundle failed canonical Surface validation/derivation (${errorMessage(error)}) -- skipping trust projection`);
      continue;
    }

    const assignment = readAssignmentRecords(root, processSource, warnings);
    sources.push({
      path: bundleFile,
      relativePath: toPosix(path.relative(root, bundleFile)),
      slug: processSource.slug,
      processSource,
      report,
      gateAssociations: deriveGateAssociations(bundle, { warnings, label: processSource.slug }),
      sourceOfTruthRefs: deriveSourceOfTruthRefs(processSource, assignment),
    });
  }

  return {
    sources,
    warnings,
    scannedWorkflowCount: processRead.sources.length,
  };
}

export function buildWorkflowTrustProjection(
  sources: WorkflowTrustSource[],
  options: BuildWorkflowTrustProjectionOptions,
): ConsoleTrustProjectionEnvelope {
  const generatedAt = projectionTimestamp(options.generatedAt);
  const producer = {
    id: options.producer?.id ?? "flow-agents-trust",
    product: options.producer?.product ?? "flow-agents",
  };
  const scope = typeof options.scope === "string" ? { kind: "local", id: options.scope } : options.scope;
  const trusts = sources.map(mapTrustSource).sort((left, right) => left.id.localeCompare(right.id));
  return {
    schema: "kontour.console.projection",
    version: "0.1",
    generatedAt,
    scope,
    producer,
    derivedFrom: {
      mode: "direct_snapshot",
      eventHistory: "unavailable",
      directSnapshot: {
        id: `flow-agents-trust:${scope.kind}:${scope.id}`,
        emittedAt: generatedAt,
        producer,
        reason: "workflow-trust projection is derived read-only from validated local trust.bundle files and workflow/assignment sidecars; Console event history is unavailable",
        sourceRef: {
          product: "flow-agents",
          kind: "workflow-trust",
          id: ".kontourai/flow-agents/*/trust.bundle",
          label: "Local workflow trust bundles",
        },
      },
    },
    trusts,
  };
}

export function deriveGateAssociations(
  bundle: Record<string, unknown>,
  diagnostics?: { warnings: string[]; label: string },
): ConsoleTrustGateAssociation[] {
  const claims = arrayOfRecords(bundle.claims);
  const evidence = arrayOfRecords(bundle.evidence);
  const events = arrayOfRecords(bundle.events);

  // #891 review finding 1 (HIGH): Surface 2.13 accepts duplicate claim ids, and
  // the claim-id string is this projector's ONLY join key from evidence/events
  // to gates. Two claim records sharing an id but stamped for different gates
  // would attach the SAME evidence/events to BOTH gates — fabricated
  // provenance. This projector must not reinterpret trust semantics to pick a
  // winner, so a duplicated claim id is excluded from every gate association
  // and reported through `diagnostics` instead.
  const claimIdCounts = new Map<string, number>();
  for (const claim of claims) {
    const claimId = nonEmptyString(claim.id);
    if (claimId) claimIdCounts.set(claimId, (claimIdCounts.get(claimId) ?? 0) + 1);
  }
  const ambiguousClaimIds = new Set(
    [...claimIdCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id),
  );

  const claimsByGate = new Map<string, Set<string>>();
  const ambiguousGatesByClaim = new Map<string, Set<string>>();
  for (const claim of claims) {
    const claimId = nonEmptyString(claim.id);
    const metadata = recordOrUndefined(claim.metadata);
    const gateClaim = recordOrUndefined(metadata?.gate_claim);
    const gateId = nonEmptyString(gateClaim?.expectation_id);
    if (!claimId || !gateId) continue;
    if (ambiguousClaimIds.has(claimId)) {
      const gates = ambiguousGatesByClaim.get(claimId) ?? new Set<string>();
      gates.add(gateId);
      ambiguousGatesByClaim.set(claimId, gates);
      continue;
    }
    const ids = claimsByGate.get(gateId) ?? new Set<string>();
    ids.add(claimId);
    claimsByGate.set(gateId, ids);
  }
  if (diagnostics) {
    for (const [claimId, gates] of [...ambiguousGatesByClaim.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
      diagnostics.warnings.push(
        `${diagnostics.label}: claim id '${claimId}' appears on multiple claim records (gates: ${[...gates].sort().join(", ")}) -- ambiguous claim-to-gate association; its claims/evidence/events are not attached to any gate`,
      );
    }
  }

  return [...claimsByGate.entries()]
    .map(([gateId, claimIdSet]) => {
      const claimIds = [...claimIdSet].sort();
      return {
        gateId,
        claimIds,
        evidenceIds: relatedRecordIds(evidence, claimIdSet),
        eventIds: relatedRecordIds(events, claimIdSet),
      };
    })
    .sort((left, right) => left.gateId.localeCompare(right.gateId));
}

export function githubIssueUrl(workItemRef: string): string | undefined {
  const match = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/.exec(workItemRef);
  if (!match) {
    const urlMatch = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)$/.exec(workItemRef);
    return urlMatch ? `https://github.com/${urlMatch[1]}/${urlMatch[2]}/issues/${urlMatch[3]}` : undefined;
  }
  return `https://github.com/${match[1]}/${match[2]}/issues/${match[3]}`;
}

function mapTrustSource(source: WorkflowTrustSource): ConsoleTrustProjection {
  const taskSlug = source.processSource.state.task_slug;
  return {
    id: deterministicTrustId(source.relativePath, taskSlug),
    family: "workflow",
    nonAuthority: true,
    subjectRef: {
      product: "flow-agents",
      kind: "workflow",
      id: taskSlug,
      label: taskSlug,
    },
    sourceRef: {
      product: "flow-agents",
      kind: "trust-bundle",
      id: taskSlug,
      label: `${taskSlug}/trust.bundle`,
    },
    payload: source.report,
    gateAssociations: source.gateAssociations,
    sourceOfTruthRefs: source.sourceOfTruthRefs,
    extensions: {
      "flow-agents": {
        task_slug: taskSlug,
        source_path: source.relativePath,
      },
    },
  };
}

function deriveSourceOfTruthRefs(
  source: WorkflowProcessSource,
  assignmentRecords: AssignmentRecord[],
): ConsoleTrustSourceOfTruthRef[] {
  const refs: ConsoleTrustSourceOfTruthRef[] = [];
  for (const workItemRef of source.state.work_item_refs ?? []) {
    const url = githubIssueUrl(workItemRef);
    refs.push({
      product: url ? "github" : "flow-agents",
      kind: "work-item",
      id: workItemRef,
      label: workItemRef,
      ...(url ? { url } : {}),
      sourcePath: source.relativePath,
    });
  }
  if (source.state.branch) {
    refs.push({
      product: "flow-agents",
      kind: "assignment-branch",
      id: source.state.branch,
      label: "Workflow routing branch",
      sourcePath: source.relativePath,
    });
  }
  if (source.state.owner) {
    refs.push({
      product: "flow-agents",
      kind: "assignment-actor",
      id: source.state.owner,
      label: "Workflow owner",
      sourcePath: source.relativePath,
    });
  }

  for (const record of assignmentRecords) {
    const branch = nonEmptyString(record.branch);
    const actor = assignmentActor(record);
    const artifactDir = nonEmptyString(record.artifact_dir);
    if (branch) refs.push({ product: "flow-agents", kind: "assignment-branch", id: branch, label: "Assignment claim branch" });
    if (actor) refs.push({ product: "flow-agents", kind: "assignment-actor", id: actor, label: "Assignment claim actor" });
    if (artifactDir) refs.push({ product: "flow-agents", kind: "assignment-artifact-dir", id: artifactDir, label: "Assignment claim artifact directory" });
  }

  const byKey = new Map<string, ConsoleTrustSourceOfTruthRef>();
  for (const ref of refs) {
    const key = `${ref.product}\n${ref.kind}\n${ref.id}\n${ref.url ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, ref);
  }
  return [...byKey.values()].sort((left, right) => {
    const kind = left.kind.localeCompare(right.kind);
    return kind !== 0 ? kind : left.id.localeCompare(right.id);
  });
}

function readAssignmentRecords(
  root: string,
  source: WorkflowProcessSource,
  warnings: string[],
): AssignmentRecord[] {
  const records: AssignmentRecord[] = [];
  const sessionDir = path.join(root, source.slug);
  const providerFile = path.join(sessionDir, "assignment-provider-state.json");
  if (fs.existsSync(providerFile)) {
    try {
      const providerState = readJsonNoFollow(providerFile, `${source.slug}/assignment-provider-state.json`, MAX_ASSIGNMENT_BYTES);
      const providerRecord = extractProviderAssignmentRecord(providerState);
      if (providerRecord && assignmentMatchesSource(providerRecord, root, source)) records.push(providerRecord);
      else if (providerRecord) warnings.push(`${source.slug}: assignment-provider-state.json record does not positively bind to this workflow -- skipping assignment refs`);
      // #891 review finding 3: a present-but-shapeless file must be reported, not silently ignored.
      else warnings.push(`${source.slug}: assignment-provider-state.json does not contain a well-formed assignment record -- skipping assignment refs`);
    } catch (error) {
      warnings.push(`${source.slug}: assignment-provider-state.json could not be read (${errorMessage(error)}) -- skipping assignment refs`);
    }
  }

  const localFile = path.join(root, "assignment", `${source.slug}.json`);
  if (fs.existsSync(localFile)) {
    try {
      const localRecord = recordOrUndefined(readJsonNoFollow(localFile, `assignment/${source.slug}.json`, MAX_ASSIGNMENT_BYTES));
      if (localRecord && assignmentMatchesSource(localRecord, root, source)) records.push(localRecord);
      else if (localRecord) warnings.push(`${source.slug}: local assignment record does not positively bind to this workflow -- skipping assignment refs`);
      // #891 review finding 3: a present-but-shapeless file must be reported, not silently ignored.
      else warnings.push(`${source.slug}: local assignment record is not a well-formed assignment record -- skipping assignment refs`);
    } catch (error) {
      warnings.push(`${source.slug}: local assignment record could not be read (${errorMessage(error)}) -- skipping assignment refs`);
    }
  }
  return records;
}

function extractProviderAssignmentRecord(value: unknown): AssignmentRecord | undefined {
  const root = recordOrUndefined(value);
  const assignment = recordOrUndefined(root?.assignment);
  return recordOrUndefined(assignment?.record) ?? recordOrUndefined(root?.record);
}

function assignmentMatchesSource(
  record: AssignmentRecord,
  root: string,
  source: WorkflowProcessSource,
): boolean {
  if (record.status !== undefined && record.status !== "claimed") return false;
  const workItemRef = nonEmptyString(record.work_item_ref);
  if (workItemRef && !(source.state.work_item_refs ?? []).includes(workItemRef)) return false;
  const artifactDir = nonEmptyString(record.artifact_dir);
  if (artifactDir) {
    const resolved = path.isAbsolute(artifactDir) ? path.resolve(artifactDir) : path.resolve(root, artifactDir);
    if (resolved !== path.resolve(root, source.slug)) return false;
  }
  const subjectId = nonEmptyString(record.subject_id);
  if (subjectId && subjectId !== source.state.task_slug && subjectId !== source.slug) return false;
  // #891 review finding 3 (MEDIUM): absence of contradiction is NOT a match.
  // A record whose binding fields are all absent could belong to any workflow;
  // attributing its actor/branch as this workflow's source-of-truth provenance
  // would be false attribution. Require at least one POSITIVE binding — a
  // binding field that is present here has already been verified to match
  // above (a mismatch returned false).
  return Boolean(workItemRef || artifactDir || subjectId);
}

function assignmentActor(record: AssignmentRecord): string | undefined {
  const actorKey = nonEmptyString(record.actor_key);
  if (actorKey) return actorKey;
  const actor = recordOrUndefined(record.actor);
  const runtime = nonEmptyString(actor?.runtime);
  const sessionId = nonEmptyString(actor?.session_id);
  const host = nonEmptyString(actor?.host);
  return runtime && sessionId && host ? `${runtime}:${sessionId}:${host}` : undefined;
}

function relatedRecordIds(records: Record<string, unknown>[], claimIds: Set<string>): string[] {
  return records
    .filter((record) => {
      const claimId = nonEmptyString(record.claimId);
      return Boolean(claimId && claimIds.has(claimId));
    })
    .map((record) => nonEmptyString(record.id))
    .filter((id): id is string => Boolean(id))
    .sort();
}

function readJsonNoFollow(file: string, label: string, maxBytes: number): unknown {
  let descriptor: number | null = null;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    if (stat.size > maxBytes) throw new Error(`${label} exceeds max size of ${maxBytes} bytes`);
    const buffer = Buffer.alloc(stat.size);
    const bytesRead = fs.readSync(descriptor, buffer, 0, stat.size, 0);
    if (bytesRead !== stat.size) throw new Error(`${label} changed while being read`);
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      throw new Error(`${label} must not be a symlink`);
    }
    throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(recordOrUndefined).filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function deterministicTrustId(sourcePath: string, taskSlug: string): string {
  const raw = `${sourcePath}\n${taskSlug}`;
  return `trust.workflow.${slugPart(taskSlug)}.${fnv1a32(raw)}`;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function slugPart(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 64) : "item";
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
