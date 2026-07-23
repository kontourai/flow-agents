import { randomUUID } from "node:crypto";

export const RUN_CORRELATION_SCHEMA_VERSION = "1.0" as const;
export const RUN_CORRELATION_IDENTITY_KEYS = [
  "runtime_session",
  "runtime_turn",
  "flow_run",
  "flow_step",
  "work_item",
  "agent",
  "delegation_trace",
  "delegation_span",
  "terminal_record",
] as const;
export const RUN_CORRELATION_IDENTITY_STATUSES = [
  "present",
  "unavailable",
  "unsupported",
  "not_applicable",
] as const;

export type RunCorrelationIdentityKey = (typeof RUN_CORRELATION_IDENTITY_KEYS)[number];
export type RunCorrelationIdentityStatus = (typeof RUN_CORRELATION_IDENTITY_STATUSES)[number];

export type PresentRunCorrelationIdentity = {
  status: "present";
  value: string;
};

export type AbsentRunCorrelationIdentity = {
  status: Exclude<RunCorrelationIdentityStatus, "present">;
  reason: string;
};

export type RunCorrelationIdentity =
  | PresentRunCorrelationIdentity
  | AbsentRunCorrelationIdentity;

export type RunCorrelationEnvelope = {
  schema_version: typeof RUN_CORRELATION_SCHEMA_VERSION;
  correlation_id: string;
  identities: Record<RunCorrelationIdentityKey, RunCorrelationIdentity>;
};

export type RunCorrelationInput = {
  correlation_id?: string;
  identities: Record<RunCorrelationIdentityKey, RunCorrelationIdentity>;
};

export type RunCorrelationPresence =
  | { status: "present"; envelope: RunCorrelationEnvelope }
  | { status: "incomplete"; reason: string };

export type RunCorrelationCarrier<T extends Record<string, unknown>> = T & {
  run_correlation: RunCorrelationEnvelope;
};

export type RuntimeCorrelationIdentitySupport =
  | { status: "supported" }
  | { status: "partial"; note: string }
  | { status: "unsupported"; reason: string }
  | { status: "not_applicable"; reason: string };

export type RuntimeCorrelationIdentityDeclaration = Readonly<
  Record<RunCorrelationIdentityKey, RuntimeCorrelationIdentitySupport>
>;

export class RunCorrelationValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid run correlation envelope: ${issues.join("; ")}`);
    this.name = "RunCorrelationValidationError";
    this.issues = [...issues];
  }
}

const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,254}$/;
const credentialPattern = /(?:bearer\s+|(?:api[_-]?key|token|secret|password)\s*[:=]|(?:sk|gh[oprsu])_[A-Za-z0-9_-]{8,})/i;
const allowedEnvelopeKeys = new Set(["schema_version", "correlation_id", "identities"]);
const allowedPresentKeys = new Set(["status", "value"]);
const allowedAbsentKeys = new Set(["status", "reason"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeIdentity(value: unknown): value is string {
  return typeof value === "string"
    && identityPattern.test(value)
    && !credentialPattern.test(value);
}

function isSafeReason(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !credentialPattern.test(value);
}

export function validateRunCorrelationEnvelope(value: unknown): RunCorrelationEnvelope {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new RunCorrelationValidationError(["envelope must be an object"]);
  }
  if (!hasOnlyKeys(value, allowedEnvelopeKeys)) issues.push("envelope has unknown properties");
  if (value.schema_version !== RUN_CORRELATION_SCHEMA_VERSION) issues.push("schema_version must be 1.0");
  if (!isSafeIdentity(value.correlation_id)) issues.push("correlation_id must be a bounded opaque identifier");

  if (!isRecord(value.identities)) {
    issues.push("identities must be an object");
  } else {
    const identities = value.identities;
    const identityKeys = Object.keys(identities);
    const unknown = identityKeys.filter((key) => !(RUN_CORRELATION_IDENTITY_KEYS as readonly string[]).includes(key));
    const missing = RUN_CORRELATION_IDENTITY_KEYS.filter((key) => !(key in identities));
    if (unknown.length > 0) issues.push(`identities has unknown properties: ${unknown.join(", ")}`);
    if (missing.length > 0) issues.push(`identities is missing: ${missing.join(", ")}`);

    for (const key of RUN_CORRELATION_IDENTITY_KEYS) {
      const identity = identities[key];
      if (!isRecord(identity)) {
        if (key in identities) issues.push(`identities.${key} must be an object`);
        continue;
      }
      if (!(RUN_CORRELATION_IDENTITY_STATUSES as readonly unknown[]).includes(identity.status)) {
        issues.push(`identities.${key}.status is invalid`);
        continue;
      }
      if (identity.status === "present") {
        if (!hasOnlyKeys(identity, allowedPresentKeys)) issues.push(`identities.${key} has invalid present properties`);
        if (!isSafeIdentity(identity.value)) issues.push(`identities.${key}.value must be a bounded opaque identifier`);
      } else {
        if (!hasOnlyKeys(identity, allowedAbsentKeys)) issues.push(`identities.${key} has invalid absent properties`);
        if (!isSafeReason(identity.reason)) issues.push(`identities.${key}.reason must be a bounded non-sensitive explanation`);
      }
    }
  }

  if (issues.length > 0) throw new RunCorrelationValidationError(issues);
  return structuredClone(value) as RunCorrelationEnvelope;
}

export function createRunCorrelationEnvelope(input: RunCorrelationInput): RunCorrelationEnvelope {
  return validateRunCorrelationEnvelope({
    schema_version: RUN_CORRELATION_SCHEMA_VERSION,
    correlation_id: input.correlation_id ?? `run-${randomUUID()}`,
    identities: input.identities,
  });
}

export function attachRunCorrelation<T extends Record<string, unknown>>(
  record: T,
  envelope: unknown,
): RunCorrelationCarrier<T> {
  return {
    ...structuredClone(record),
    run_correlation: validateRunCorrelationEnvelope(envelope),
  };
}

export function readRunCorrelation(record: unknown): RunCorrelationPresence {
  if (!isRecord(record) || !("run_correlation" in record)) {
    return {
      status: "incomplete",
      reason: "record predates run correlation or its producer did not provide an envelope",
    };
  }
  return {
    status: "present",
    envelope: validateRunCorrelationEnvelope(record.run_correlation),
  };
}

const runtimeIdentityDeclarations = {
  "claude-code": runtimeDeclaration({
    runtime_session: supportedIdentity(),
    runtime_turn: supportedIdentity(),
    agent: supportedIdentity(),
    delegation_trace: unsupportedSupport("the runtime does not expose delegation trace context"),
    delegation_span: unsupportedSupport("the runtime does not expose delegation span context"),
  }),
  codex: runtimeDeclaration({
    runtime_session: supportedIdentity(),
    runtime_turn: supportedIdentity(),
    agent: supportedIdentity(),
    delegation_trace: unsupportedSupport("the runtime does not expose delegation trace context"),
    delegation_span: unsupportedSupport("the runtime does not expose delegation span context"),
  }),
  kiro: runtimeDeclaration({
    runtime_session: supportedIdentity(),
    runtime_turn: supportedIdentity(),
    agent: supportedIdentity(),
    delegation_trace: unsupportedSupport("the runtime does not expose delegation trace context"),
    delegation_span: unsupportedSupport("the runtime does not expose delegation span context"),
  }),
  opencode: runtimeDeclaration({
    runtime_session: supportedIdentity(),
    runtime_turn: {
      status: "partial",
      note: "turn identity is unavailable in non-interactive run mode",
    },
    agent: supportedIdentity(),
    delegation_trace: unsupportedSupport("the runtime does not expose delegation trace context"),
    delegation_span: unsupportedSupport("the runtime does not expose delegation span context"),
  }),
  pi: runtimeDeclaration({
    runtime_session: supportedIdentity(),
    runtime_turn: supportedIdentity(),
    agent: supportedIdentity(),
    delegation_trace: unsupportedSupport("the runtime does not expose delegation trace context"),
    delegation_span: unsupportedSupport("the runtime does not expose delegation span context"),
  }),
  "codex-local": runtimeDeclaration({}),
  "strands-local": runtimeDeclaration({}),
} as const satisfies Record<string, RuntimeCorrelationIdentityDeclaration>;

export const RUNTIME_CORRELATION_IDENTITY_DECLARATIONS:
Readonly<Record<string, RuntimeCorrelationIdentityDeclaration>> = runtimeIdentityDeclarations;

export function runtimeCorrelationIdentityDeclaration(
  runtime: string,
): RuntimeCorrelationIdentityDeclaration {
  const canonical = runtime.trim().toLowerCase() === "kiro-cli"
    ? "kiro"
    : runtime.trim().toLowerCase();
  return structuredClone(runtimeIdentityDeclarations[canonical as keyof typeof runtimeIdentityDeclarations]
    ?? runtimeDeclaration({}));
}

function runtimeDeclaration(
  overrides: Partial<Record<RunCorrelationIdentityKey, RuntimeCorrelationIdentitySupport>>,
): RuntimeCorrelationIdentityDeclaration {
  return Object.fromEntries(RUN_CORRELATION_IDENTITY_KEYS.map((key) => [
    key,
    overrides[key] ?? {
      status: "not_applicable",
      reason: `${key} is owned outside this runtime adapter`,
    },
  ])) as RuntimeCorrelationIdentityDeclaration;
}

function supportedIdentity(): RuntimeCorrelationIdentitySupport {
  return { status: "supported" };
}

function unsupportedSupport(reason: string): RuntimeCorrelationIdentitySupport {
  return { status: "unsupported", reason };
}
