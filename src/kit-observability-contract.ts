/**
 * Host-neutral, read-only Kit observability contribution contract (#911).
 *
 * A Kit declares projections and references; a host decides whether and how to
 * render, store, authenticate, or route them. Nothing in this module invokes a
 * provider, changes a Flow lifecycle, or derives Surface trust.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const KIT_OBSERVABILITY_API_VERSION = "flowagents.kontourai.io/v1alpha1" as const;
export const KIT_OBSERVABILITY_CONTRACT_VERSION = "1.0" as const;
export const KIT_OBSERVABILITY_DESCRIPTOR_KIND = "KitObservabilityContribution" as const;
export const KIT_OBSERVABILITY_RECORD_KIND = "KitObservabilityRecord" as const;
export const KIT_OBSERVABILITY_PROJECTION_KINDS = [
  "run_summary", "metric_series", "queue", "grounded_narrative", "learning",
] as const;
export const KIT_OBSERVABILITY_AUTHORITIES = ["flow", "surface", "runtime"] as const;

export type KitObservabilityProjectionKind = (typeof KIT_OBSERVABILITY_PROJECTION_KINDS)[number];
export type KitObservabilityAuthority = (typeof KIT_OBSERVABILITY_AUTHORITIES)[number];
export type KitObservabilityDiagnosticCode =
  | "contribution_absent"
  | "invalid_contribution"
  | "unsupported_contract_version";

export type KitObservabilityDiagnostic = {
  code: KitObservabilityDiagnosticCode;
  message: string;
};

export type KitObservabilityAuthorityRef = {
  authority: KitObservabilityAuthority;
  ref: string;
};

export type KitObservabilityContribution = {
  apiVersion: typeof KIT_OBSERVABILITY_API_VERSION;
  kind: typeof KIT_OBSERVABILITY_DESCRIPTOR_KIND;
  metadata: { name: string };
  spec: {
    contract_version: typeof KIT_OBSERVABILITY_CONTRACT_VERSION;
    kit: { id: string };
    projections: { kind: KitObservabilityProjectionKind; schema_ref: string }[];
    views: KitObservabilityProjectionKind[];
    authority_refs: KitObservabilityAuthorityRef[];
    capabilities: { local_export: "read"; sink: "unsupported" | "optional" };
    data_policy: { redaction: "declared"; retention: "kit_owned"; raw_source: "available" | "unavailable" };
    operator_actions: { id: string; kind: "provider_command" | "proposal_ref"; ref: string }[];
    compatibility: { unsupported_version: "diagnostic" };
  };
};

export type KitObservabilityRecord = {
  apiVersion: typeof KIT_OBSERVABILITY_API_VERSION;
  kind: typeof KIT_OBSERVABILITY_RECORD_KIND;
  metadata: { name: string };
  spec: {
    contribution: { kit_id: string; contract_version: typeof KIT_OBSERVABILITY_CONTRACT_VERSION };
    projection: { kind: KitObservabilityProjectionKind; schema_ref: string };
    authority_refs: KitObservabilityAuthorityRef[];
    data: Record<string, unknown>;
  };
};

export type KitObservabilityContributionLoadResult =
  | { status: "supported"; contribution: KitObservabilityContribution; diagnostics: [] }
  | { status: "absent" | "invalid" | "unsupported"; diagnostics: KitObservabilityDiagnostic[] };

const idPattern = /^[a-z][a-z0-9-]{0,62}$/;
const refPattern = /^[^\u0000-\u001f\u007f\s]{1,512}$/;

export function validateKitObservabilityContribution(value: unknown): KitObservabilityContribution {
  const root = object(value, "contribution");
  exactKeys(root, ["apiVersion", "kind", "metadata", "spec"], "contribution");
  if (root.apiVersion !== KIT_OBSERVABILITY_API_VERSION) throw new Error("contribution apiVersion is unsupported");
  if (root.kind !== KIT_OBSERVABILITY_DESCRIPTOR_KIND) throw new Error("contribution kind is invalid");
  const metadata = object(root.metadata, "contribution.metadata");
  exactKeys(metadata, ["name"], "contribution.metadata");
  identifier(metadata.name, "contribution.metadata.name");
  const spec = object(root.spec, "contribution.spec");
  exactKeys(spec, ["contract_version", "kit", "projections", "views", "authority_refs", "capabilities", "data_policy", "operator_actions", "compatibility"], "contribution.spec");
  if (spec.contract_version !== KIT_OBSERVABILITY_CONTRACT_VERSION) throw new Error("contribution contract_version is unsupported");
  const kit = object(spec.kit, "contribution.spec.kit");
  exactKeys(kit, ["id"], "contribution.spec.kit");
  identifier(kit.id, "contribution.spec.kit.id");
  if (metadata.name !== kit.id) throw new Error("contribution metadata.name must equal spec.kit.id");
  const projections = projectionList(spec.projections, "contribution.spec.projections");
  const views = projectionKinds(spec.views, "contribution.spec.views");
  for (const view of views) if (!projections.some((projection) => projection.kind === view)) throw new Error(`contribution view ${view} has no declared projection`);
  authorityRefs(spec.authority_refs, "contribution.spec.authority_refs");
  const capabilities = object(spec.capabilities, "contribution.spec.capabilities");
  exactKeys(capabilities, ["local_export", "sink"], "contribution.spec.capabilities");
  if (capabilities.local_export !== "read" || !["unsupported", "optional"].includes(String(capabilities.sink))) throw new Error("contribution capabilities are invalid");
  const dataPolicy = object(spec.data_policy, "contribution.spec.data_policy");
  exactKeys(dataPolicy, ["redaction", "retention", "raw_source"], "contribution.spec.data_policy");
  if (dataPolicy.redaction !== "declared" || dataPolicy.retention !== "kit_owned" || !["available", "unavailable"].includes(String(dataPolicy.raw_source))) throw new Error("contribution data_policy is invalid");
  operatorActions(spec.operator_actions, "contribution.spec.operator_actions");
  const compatibility = object(spec.compatibility, "contribution.spec.compatibility");
  exactKeys(compatibility, ["unsupported_version"], "contribution.spec.compatibility");
  if (compatibility.unsupported_version !== "diagnostic") throw new Error("contribution compatibility must diagnose unsupported versions");
  return structuredClone(value) as KitObservabilityContribution;
}

export function validateKitObservabilityRecord(value: unknown, contribution: KitObservabilityContribution): KitObservabilityRecord {
  const root = object(value, "record");
  exactKeys(root, ["apiVersion", "kind", "metadata", "spec"], "record");
  if (root.apiVersion !== KIT_OBSERVABILITY_API_VERSION || root.kind !== KIT_OBSERVABILITY_RECORD_KIND) throw new Error("record identity is invalid");
  const metadata = object(root.metadata, "record.metadata");
  exactKeys(metadata, ["name"], "record.metadata");
  identifier(metadata.name, "record.metadata.name");
  const spec = object(root.spec, "record.spec");
  exactKeys(spec, ["contribution", "projection", "authority_refs", "data"], "record.spec");
  const contributionRef = object(spec.contribution, "record.spec.contribution");
  exactKeys(contributionRef, ["kit_id", "contract_version"], "record.spec.contribution");
  if (contributionRef.kit_id !== contribution.spec.kit.id || contributionRef.contract_version !== contribution.spec.contract_version) throw new Error("record contribution reference does not match the descriptor");
  const projection = object(spec.projection, "record.spec.projection");
  exactKeys(projection, ["kind", "schema_ref"], "record.spec.projection");
  projectionKind(projection.kind, "record.spec.projection.kind");
  reference(projection.schema_ref, "record.spec.projection.schema_ref");
  if (!contribution.spec.projections.some((entry) => entry.kind === projection.kind && entry.schema_ref === projection.schema_ref)) throw new Error("record projection is not declared by the contribution");
  authorityRefs(spec.authority_refs, "record.spec.authority_refs");
  const data = object(spec.data, "record.spec.data");
  if (Object.prototype.hasOwnProperty.call(data, "gate") || Object.prototype.hasOwnProperty.call(data, "claim")) throw new Error("record data cannot contain Flow gate or Surface claim authority");
  return structuredClone(value) as KitObservabilityRecord;
}

/** Read-only discovery for a host or Kit validator. Absence is optional and never an error. */
export function loadKitObservabilityContribution(kitDir: string, manifest?: unknown): KitObservabilityContributionLoadResult {
  let manifestValue = manifest;
  const manifestPath = path.join(kitDir, "kit.json");
  try {
    if (manifestValue === undefined) manifestValue = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const root = object(manifestValue, "kit manifest");
    const declaration = root.observability_contribution;
    if (declaration === undefined) return { status: "absent", diagnostics: [{ code: "contribution_absent", message: "Kit does not declare an observability contribution." }] };
    const entry = object(declaration, "kit manifest observability_contribution");
    exactKeys(entry, ["path"], "kit manifest observability_contribution");
    if (typeof entry.path !== "string" || !entry.path || path.isAbsolute(entry.path) || entry.path.replace(/\\/g, "/").split("/").includes("..")) throw new Error("kit manifest observability_contribution.path must be a relative in-kit path");
    const descriptorPath = path.resolve(kitDir, entry.path);
    const rootPath = path.resolve(kitDir);
    if (descriptorPath !== rootPath && !descriptorPath.startsWith(`${rootPath}${path.sep}`)) throw new Error("kit manifest observability_contribution.path escapes the Kit");
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    try {
      return { status: "supported", contribution: validateKitObservabilityContribution(descriptor), diagnostics: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "contribution validation failed";
      const code: KitObservabilityDiagnosticCode = /apiVersion|contract_version/.test(message) ? "unsupported_contract_version" : "invalid_contribution";
      return { status: code === "unsupported_contract_version" ? "unsupported" : "invalid", diagnostics: [{ code, message }] };
    }
  } catch (error) {
    return { status: "invalid", diagnostics: [{ code: "invalid_contribution", message: error instanceof Error ? error.message : "contribution could not be loaded" }] };
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${label} has unknown properties: ${extras.join(", ")}`);
  const missing = allowed.filter((key) => !(key in value));
  if (missing.length) throw new Error(`${label} is missing: ${missing.join(", ")}`);
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !idPattern.test(value)) throw new Error(`${label} must be a stable Kit identifier`);
}

function reference(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !refPattern.test(value)) throw new Error(`${label} must be a non-empty non-sensitive reference`);
}

function projectionKind(value: unknown, label: string): asserts value is KitObservabilityProjectionKind {
  if (!(KIT_OBSERVABILITY_PROJECTION_KINDS as readonly unknown[]).includes(value)) throw new Error(`${label} is not a supported projection kind`);
}

function projectionKinds(value: unknown, label: string): KitObservabilityProjectionKind[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty list`);
  value.forEach((entry, index) => projectionKind(entry, `${label}[${index}]`));
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicate projection kinds`);
  return value as KitObservabilityProjectionKind[];
}

function projectionList(value: unknown, label: string): { kind: KitObservabilityProjectionKind; schema_ref: string }[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty list`);
  const result = value.map((entry, index) => {
    const projection = object(entry, `${label}[${index}]`);
    exactKeys(projection, ["kind", "schema_ref"], `${label}[${index}]`);
    projectionKind(projection.kind, `${label}[${index}].kind`);
    reference(projection.schema_ref, `${label}[${index}].schema_ref`);
    return { kind: projection.kind, schema_ref: projection.schema_ref } as { kind: KitObservabilityProjectionKind; schema_ref: string };
  });
  if (new Set(result.map((entry) => entry.kind)).size !== result.length) throw new Error(`${label} must not declare a projection kind twice`);
  return result;
}

function authorityRefs(value: unknown, label: string): KitObservabilityAuthorityRef[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty list`);
  const result = value.map((entry, index) => {
    const referenceEntry = object(entry, `${label}[${index}]`);
    exactKeys(referenceEntry, ["authority", "ref"], `${label}[${index}]`);
    if (!(KIT_OBSERVABILITY_AUTHORITIES as readonly unknown[]).includes(referenceEntry.authority)) throw new Error(`${label}[${index}].authority is invalid`);
    reference(referenceEntry.ref, `${label}[${index}].ref`);
    return { authority: referenceEntry.authority as KitObservabilityAuthority, ref: referenceEntry.ref };
  });
  if (new Set(result.map((entry) => entry.authority)).size !== result.length) throw new Error(`${label} must not duplicate an authority`);
  return result;
}

function operatorActions(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const action = object(entry, `${label}[${index}]`);
    exactKeys(action, ["id", "kind", "ref"], `${label}[${index}]`);
    identifier(action.id, `${label}[${index}].id`);
    if (ids.has(action.id)) throw new Error(`${label} has duplicate action id ${action.id}`);
    ids.add(action.id);
    if (action.kind !== "provider_command" && action.kind !== "proposal_ref") throw new Error(`${label}[${index}].kind must be provider_command or proposal_ref`);
    reference(action.ref, `${label}[${index}].ref`);
  });
}
