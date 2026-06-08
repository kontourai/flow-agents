import * as fs from "node:fs";
import * as path from "node:path";

export type WorkflowLearningStatus = "pending" | "learned" | "followup_required" | "blocked";
export type WorkflowLearningOutcome = "success" | "failure" | "mixed" | "unknown";
export type WorkflowLearningRouteTarget = "rule" | "skill" | "power" | "agent" | "eval" | "doc" | "backlog" | "knowledge" | "none";
export type WorkflowLearningRouteStatus = "open" | "completed" | "accepted" | "deferred" | "rejected";
export type WorkflowLearningCorrectionType =
  | "workflow"
  | "skill"
  | "agent"
  | "tooling"
  | "test"
  | "doc"
  | "process"
  | "product"
  | "provider"
  | "none";

export type WorkflowLearningRoute = {
  target: WorkflowLearningRouteTarget;
  status: WorkflowLearningRouteStatus;
  ref?: string;
};

export type WorkflowLearningCorrection = {
  needed: boolean;
  type?: WorkflowLearningCorrectionType;
  recurrence_key?: string;
  intended_behavior?: string;
  observed_behavior?: string;
  gap?: string;
  evidence?: string;
  no_change_rationale?: string;
  prevention?: WorkflowLearningRoute;
};

export type WorkflowLearningRecord = {
  id: string;
  recorded_at: string;
  source_refs: string[];
  outcome: WorkflowLearningOutcome;
  facts: string[];
  interpretation: string;
  routing: WorkflowLearningRoute[];
  correction?: WorkflowLearningCorrection;
};

export type WorkflowLearningSidecar = {
  schema_version: "1.0";
  task_slug: string;
  status: WorkflowLearningStatus;
  updated_at: string;
  records: WorkflowLearningRecord[];
};

export type WorkflowLearningSource = {
  path: string;
  relativePath: string;
  slug: string;
  learning: WorkflowLearningSidecar;
};

export type ConsoleProjectionRef = {
  product: string;
  kind: string;
  id: string;
  label?: string;
};

export type ConsoleProjectionScope = {
  kind: string;
  id: string;
};

export type ConsoleLearningProjection = {
  id: string;
  family: "workflow";
  nonAuthority: true;
  subjectRef: ConsoleProjectionRef;
  sourceRef: ConsoleProjectionRef;
  summary: string;
  extensions: {
    "flow-agents": {
      task_slug: string;
      record_id: string;
      source_refs: string[];
      routing: {
        count: number;
        open: number;
        completed: number;
        accepted: number;
        deferred: number;
        rejected: number;
        targets: WorkflowLearningRouteTarget[];
        statuses: WorkflowLearningRouteStatus[];
        refs: string[];
      };
      correction: {
        needed: boolean;
        type?: WorkflowLearningCorrectionType;
        recurrence_key?: string;
        prevention?: {
          target: WorkflowLearningRouteTarget;
          status: WorkflowLearningRouteStatus;
          ref?: string;
        };
      };
      outcome: WorkflowLearningOutcome;
      learning_status: WorkflowLearningStatus;
      recorded_at: string;
      updated_at: string;
      source_path: string;
    };
  };
};

export type ConsoleLearningProjectionEnvelope = {
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
  learnings: ConsoleLearningProjection[];
};

export type BuildWorkflowLearningProjectionOptions = {
  scope: string | ConsoleProjectionScope;
  generatedAt?: string;
  producer?: {
    id?: string;
    product?: "flow-agents";
  };
};

const KNOWN_LEARNING_STATUSES = new Set<WorkflowLearningStatus>(["pending", "learned", "followup_required", "blocked"]);
const KNOWN_LEARNING_OUTCOMES = new Set<WorkflowLearningOutcome>(["success", "failure", "mixed", "unknown"]);
const KNOWN_LEARNING_ROUTE_TARGETS = new Set<WorkflowLearningRouteTarget>([
  "rule",
  "skill",
  "power",
  "agent",
  "eval",
  "doc",
  "backlog",
  "knowledge",
  "none",
]);
const KNOWN_LEARNING_ROUTE_STATUSES = new Set<WorkflowLearningRouteStatus>(["open", "completed", "accepted", "deferred", "rejected"]);
const KNOWN_CORRECTION_TYPES = new Set<WorkflowLearningCorrectionType>([
  "workflow",
  "skill",
  "agent",
  "tooling",
  "test",
  "doc",
  "process",
  "product",
  "provider",
  "none",
]);
const SKIPPED_ROOT_ENTRIES = new Set(["archive", "changes", "delivery-history"]);
const MAX_SIDECAR_BYTES = 1024 * 1024;

export function readWorkflowLearningSources(artifactRoot: string): WorkflowLearningSource[] {
  const root = path.resolve(artifactRoot);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error(`artifact root is not a directory: ${root}`);

  const sources: WorkflowLearningSource[] = [];
  for (const slug of childWorkflowDirs(root)) {
    const file = path.join(root, slug, "learning.json");
    if (!fs.existsSync(file)) continue;
    const value = readSourceJson(file, `${slug}/learning.json`);
    const learning = validateWorkflowLearningProjectionSourceShape(value, `${slug}/learning.json`);
    sources.push({
      path: file,
      relativePath: toPosix(path.relative(root, file)),
      slug,
      learning,
    });
  }
  return sources;
}

export function buildWorkflowLearningProjection(
  sources: WorkflowLearningSource[],
  options: BuildWorkflowLearningProjectionOptions,
): ConsoleLearningProjectionEnvelope {
  const generatedAt = options.generatedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const producer = {
    id: options.producer?.id ?? "flow-agents-learning",
    product: options.producer?.product ?? "flow-agents",
  };
  const scope = normalizeScope(options.scope);
  const learnings = sources.flatMap((source) => source.learning.records.map((record) => mapLearningRecord(source, record)));
  learnings.sort((left, right) => left.id.localeCompare(right.id));
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
        id: `flow-agents-learning:${scope.kind}:${scope.id}`,
        emittedAt: generatedAt,
        producer,
        reason: "workflow-learning projection is derived from local learning sidecars; Console event history is unavailable",
        sourceRef: {
          product: "flow-agents",
          kind: "workflow-learning",
          id: ".agents/flow-agents/*/learning.json",
          label: "Local workflow learning sidecars",
        },
      },
    },
    learnings,
  };
}

export function validateWorkflowLearningProjectionSourceShape(value: unknown, label = "learning.json"): WorkflowLearningSidecar {
  const sidecar = objectValue(value, `${label} projection source must be an object`);
  const schemaVersion = requiredString(sidecar, "schema_version", label);
  if (schemaVersion !== "1.0") throw new Error(`${label}.schema_version must be 1.0`);
  const taskSlug = requiredString(sidecar, "task_slug", label);
  const status = enumString(sidecar, "status", KNOWN_LEARNING_STATUSES, label);
  const updatedAt = requiredString(sidecar, "updated_at", label);
  const recordsValue = sidecar.records;
  if (!Array.isArray(recordsValue) || recordsValue.length === 0) {
    throw new Error(`${label}.records must be a non-empty array for projection source validation`);
  }
  const records = recordsValue.map((record, index) => validateLearningRecord(record, `${label}.records[${index}]`));
  return {
    schema_version: "1.0",
    task_slug: taskSlug,
    status,
    updated_at: updatedAt,
    records,
  };
}

function mapLearningRecord(source: WorkflowLearningSource, record: WorkflowLearningRecord): ConsoleLearningProjection {
  const correction = record.correction;
  const routing = routeSummary(record.routing);
  const correctionSummary = correction?.needed
    ? ` Correction needed${correction.type ? ` for ${correction.type}` : ""}${correction.recurrence_key ? ` (${correction.recurrence_key})` : ""}.`
    : correction
      ? " Correction not needed."
      : "";
  const openRoutes = routing.open > 0 ? ` ${routing.open} open route${routing.open === 1 ? "" : "s"}.` : "";
  return {
    id: deterministicLearningId(source.relativePath, source.learning.task_slug, record.id),
    family: "workflow",
    nonAuthority: true,
    subjectRef: {
      product: "flow-agents",
      kind: "workflow",
      id: source.learning.task_slug,
      label: source.learning.task_slug,
    },
    sourceRef: {
      product: "flow-agents",
      kind: "workflow-learning",
      id: sourceRecordRefId(source.learning.task_slug, record.id),
      label: `${source.learning.task_slug}/${record.id}`,
    },
    summary: `${record.interpretation}${correctionSummary}${openRoutes}`,
    extensions: {
      "flow-agents": {
        task_slug: source.learning.task_slug,
        record_id: record.id,
        source_refs: [...record.source_refs],
        routing,
        correction: {
          needed: correction?.needed ?? false,
          ...(correction?.type ? { type: correction.type } : {}),
          ...(correction?.recurrence_key ? { recurrence_key: correction.recurrence_key } : {}),
          ...(correction?.prevention
            ? {
                prevention: {
                  target: correction.prevention.target,
                  status: correction.prevention.status,
                  ...(correction.prevention.ref ? { ref: correction.prevention.ref } : {}),
                },
              }
            : {}),
        },
        outcome: record.outcome,
        learning_status: source.learning.status,
        recorded_at: record.recorded_at,
        updated_at: source.learning.updated_at,
        source_path: source.relativePath,
      },
    },
  };
}

// Minimal projection source-shape validation for mapper safety. Full workflow
// artifact JSON Schema validation remains owned by workflow:validate-artifacts.
export const validateWorkflowLearningSidecar = validateWorkflowLearningProjectionSourceShape;

function validateLearningRecord(value: unknown, label: string): WorkflowLearningRecord {
  const record = objectValue(value, `${label} must be an object`);
  const id = requiredString(record, "id", label);
  const recordedAt = requiredString(record, "recorded_at", label);
  const sourceRefs = stringArray(record.source_refs, `${label}.source_refs`);
  const outcome = enumString(record, "outcome", KNOWN_LEARNING_OUTCOMES, label);
  const facts = stringArray(record.facts, `${label}.facts`);
  const interpretation = requiredString(record, "interpretation", label);
  if (!Array.isArray(record.routing) || record.routing.length === 0) throw new Error(`${label}.routing must be a non-empty array`);
  const routing = record.routing.map((route, index) => validateRoute(route, `${label}.routing[${index}]`));
  const correction = record.correction === undefined ? undefined : validateCorrection(record.correction, `${label}.correction`);
  return { id, recorded_at: recordedAt, source_refs: sourceRefs, outcome, facts, interpretation, routing, ...(correction ? { correction } : {}) };
}

function validateRoute(value: unknown, label: string): WorkflowLearningRoute {
  const route = objectValue(value, `${label} must be an object`);
  const target = enumString(route, "target", KNOWN_LEARNING_ROUTE_TARGETS, label);
  requiredString(route, "action", label);
  const status = enumString(route, "status", KNOWN_LEARNING_ROUTE_STATUSES, label);
  const ref = optionalString(route, "ref", label);
  return { target, status, ...(ref ? { ref } : {}) };
}

function validateCorrection(value: unknown, label: string): WorkflowLearningCorrection {
  const correction = objectValue(value, `${label} must be an object`);
  const needed = correction.needed;
  if (typeof needed !== "boolean") throw new Error(`${label}.needed must be a boolean`);
  const type = optionalEnumString(correction, "type", KNOWN_CORRECTION_TYPES, label);
  const recurrenceKey = optionalString(correction, "recurrence_key", label);
  const intendedBehavior = optionalString(correction, "intended_behavior", label);
  const observedBehavior = optionalString(correction, "observed_behavior", label);
  const gap = optionalString(correction, "gap", label);
  const evidence = optionalString(correction, "evidence", label);
  const noChangeRationale = optionalString(correction, "no_change_rationale", label);
  const prevention = correction.prevention === undefined ? undefined : validateRoute(correction.prevention, `${label}.prevention`);
  if (needed && (!type || !recurrenceKey || !intendedBehavior || !observedBehavior || !gap || (!prevention && !noChangeRationale))) {
    throw new Error(`${label} is correction-needed but lacks required correction details`);
  }
  if (!needed && !evidence) throw new Error(`${label}.evidence is required when correction is not needed`);
  return {
    needed,
    ...(type ? { type } : {}),
    ...(recurrenceKey ? { recurrence_key: recurrenceKey } : {}),
    ...(intendedBehavior ? { intended_behavior: intendedBehavior } : {}),
    ...(observedBehavior ? { observed_behavior: observedBehavior } : {}),
    ...(gap ? { gap } : {}),
    ...(evidence ? { evidence } : {}),
    ...(noChangeRationale ? { no_change_rationale: noChangeRationale } : {}),
    ...(prevention ? { prevention } : {}),
  };
}

function readSourceJson(file: string, label: string): unknown {
  let fd: number | null = null;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    if (stat.size > MAX_SIDECAR_BYTES) throw new Error(`${label} exceeds max size of ${MAX_SIDECAR_BYTES} bytes`);
    const buffer = Buffer.alloc(stat.size);
    const bytesRead = fs.readSync(fd, buffer, 0, stat.size, 0);
    if (bytesRead !== stat.size) throw new Error(`${label} changed while being read`);
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      throw new Error(`${label} must not be a symlink`);
    }
    throw error;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function childWorkflowDirs(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !SKIPPED_ROOT_ENTRIES.has(name))
    .sort();
}

function routeSummary(routes: WorkflowLearningRoute[]): ConsoleLearningProjection["extensions"]["flow-agents"]["routing"] {
  const statuses = routes.map((route) => route.status);
  return {
    count: routes.length,
    open: statuses.filter((status) => status === "open").length,
    completed: statuses.filter((status) => status === "completed").length,
    accepted: statuses.filter((status) => status === "accepted").length,
    deferred: statuses.filter((status) => status === "deferred").length,
    rejected: statuses.filter((status) => status === "rejected").length,
    targets: uniqueStrings(routes.map((route) => route.target)) as WorkflowLearningRouteTarget[],
    statuses: uniqueStrings(statuses) as WorkflowLearningRouteStatus[],
    refs: uniqueStrings(routes.map((route) => route.ref)),
  };
}

function normalizeScope(scope: string | ConsoleProjectionScope): ConsoleProjectionScope {
  return typeof scope === "string" ? { kind: "local", id: scope } : scope;
}

function deterministicLearningId(sourcePath: string, taskSlug: string, recordId: string): string {
  const raw = `${sourcePath}\n${taskSlug}\n${recordId}`;
  return `learning.workflow.${slugPart(taskSlug)}.${slugPart(recordId)}.${fnv1a32(raw)}`;
}

function sourceRecordRefId(taskSlug: string, recordId: string): string {
  return `${taskSlug}/${recordId}`;
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}.${key} must be a non-empty string`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
  return value.length > 0 ? value : undefined;
}

function enumString<T extends string>(record: Record<string, unknown>, key: string, allowed: Set<T>, label: string): T {
  const value = requiredString(record, key, label);
  if (!allowed.has(value as T)) throw new Error(`${label}.${key} has unknown value: ${value}`);
  return value as T;
}

function optionalEnumString<T extends string>(record: Record<string, unknown>, key: string, allowed: Set<T>, label: string): T | undefined {
  const value = optionalString(record, key, label);
  if (value === undefined) return undefined;
  if (!allowed.has(value as T)) throw new Error(`${label}.${key} has unknown value: ${value}`);
  return value as T;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty string array`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0) throw new Error(`${label}[${index}] must be a non-empty string`);
    return item;
  });
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

function slugPart(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 64) : "item";
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
