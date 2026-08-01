/**
 * Host-neutral, read-only Kit observability contribution contract (#911).
 *
 * Kits declare inspectability semantics. Hosts own installation, enablement,
 * rendering, storage, tenancy, authentication, and every provider operation.
 * Portable v1 carries no executable command or direct lifecycle mutation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export const KIT_OBSERVABILITY_API_VERSION = "flowagents.kontourai.io/v1alpha1" as const;
export const KIT_OBSERVABILITY_CONTRACT_VERSION = "1.0" as const;
export const KIT_OBSERVABILITY_DESCRIPTOR_KIND = "KitObservabilityContribution" as const;
export const KIT_OBSERVABILITY_RECORD_KIND = "KitObservabilityRecord" as const;
export const KIT_OBSERVABILITY_PROJECTION_KINDS = [
  "run_summary", "metric_series", "queue", "grounded_narrative", "learning",
] as const;
export const KIT_OBSERVABILITY_AUTHORITIES = ["flow", "surface", "runtime"] as const;
export const KIT_OBSERVABILITY_HOST_CAPABILITIES = [
  "standard_views", "mcp_apps_resource_bridge", "resource.open", "export.local", "proposal.review",
] as const;
export const KIT_OBSERVABILITY_OPERATOR_INTENTS = ["open_resource", "export_local", "review_proposal"] as const;

export type KitObservabilityProjectionKind = (typeof KIT_OBSERVABILITY_PROJECTION_KINDS)[number];
export type KitObservabilityAuthority = (typeof KIT_OBSERVABILITY_AUTHORITIES)[number];
export type KitObservabilityHostCapability = (typeof KIT_OBSERVABILITY_HOST_CAPABILITIES)[number];
export type KitObservabilityOperatorIntent = (typeof KIT_OBSERVABILITY_OPERATOR_INTENTS)[number];
export type KitObservabilityDiagnosticCode =
  | "contribution_absent"
  | "contribution_not_installed"
  | "contribution_disabled"
  | "invalid_contribution"
  | "unsupported_contract_version"
  | "host_contract_version_unsupported"
  | "required_host_capability_missing"
  | "optional_host_capability_unavailable"
  | "operator_intent_capability_unavailable";

export type KitObservabilityDiagnostic = { code: KitObservabilityDiagnosticCode; message: string };
export type KitObservabilityAuthorityRefs = Partial<Record<KitObservabilityAuthority, string>>;
export type KitObservabilityProjection = { schema_ref: string };
export type KitObservabilityMcpAppsResource = { uri: string; mime_type: "text/html;profile=mcp-app" };
export type KitObservabilityMcpAppsBridgeDeclaration = {
  tool_name: string;
  visibility: ["model", "app"];
};
export type KitObservabilityMcpAppsBridgeResult = KitObservabilityMcpAppsBridgeDeclaration & {
  tool_meta: { ui: { resourceUri: string; visibility: ["model", "app"] } };
};
export type KitObservabilityPresentation = {
  preferred: { kind: "mcp_apps_resource_bridge"; resource: KitObservabilityMcpAppsResource; bridge: KitObservabilityMcpAppsBridgeDeclaration };
  fallback: { kind: "standard_views"; source: "declared_projections" };
};
export type KitObservabilityOperatorAction =
  | { intent: "open_resource"; label: string; required_capability: "resource.open"; target: { authority: KitObservabilityAuthority; kind: "workflow_run" | "work_item" | "narrative" | "queue_item" } }
  | { intent: "export_local"; label: string; required_capability: "export.local" }
  | { intent: "review_proposal"; label: string; required_capability: "proposal.review"; target: { authority: "surface"; kind: "proposal" } };

export type KitObservabilityContribution = {
  apiVersion: typeof KIT_OBSERVABILITY_API_VERSION;
  kind: typeof KIT_OBSERVABILITY_DESCRIPTOR_KIND;
  metadata: { name: string };
  spec: {
    contract_version: typeof KIT_OBSERVABILITY_CONTRACT_VERSION;
    package_ref: string;
    projections: Partial<Record<KitObservabilityProjectionKind, KitObservabilityProjection>>;
    authority_refs: KitObservabilityAuthorityRefs;
    host: {
      required_capabilities: ["standard_views"];
      optional_capabilities: ["mcp_apps_resource_bridge"];
      presentation: KitObservabilityPresentation;
    };
    data_policy: { redaction: "declared"; retention: "kit_owned"; raw_source: "available" | "unavailable" };
    operator_intents: KitObservabilityOperatorAction[];
    compatibility: { unsupported_version: "diagnostic" };
  };
};

export type KitObservabilityRecord = {
  apiVersion: typeof KIT_OBSERVABILITY_API_VERSION;
  kind: typeof KIT_OBSERVABILITY_RECORD_KIND;
  metadata: { name: string };
  spec: {
    binding: { contribution_ref: string; descriptor_digest: string; package_ref: string };
    projection: { kind: KitObservabilityProjectionKind };
    authority_refs: KitObservabilityAuthorityRefs;
    data: Record<string, unknown>;
  };
};

export type KitObservabilityContributionLoadResult =
  | { status: "supported"; contribution: KitObservabilityContribution; diagnostics: [] }
  | { status: "absent" | "invalid" | "unsupported"; diagnostics: KitObservabilityDiagnostic[] };

export type KitObservabilityHostState = {
  installed: boolean;
  enabled: boolean;
  supported_contract_versions: readonly string[];
  capabilities: readonly KitObservabilityHostCapability[];
};

export type KitObservabilityNegotiation = {
  status: "enabled" | "disabled" | "incompatible";
  presentation?:
    | { kind: "mcp_apps_resource_bridge"; resource: KitObservabilityMcpAppsResource; bridge: KitObservabilityMcpAppsBridgeResult }
    | { kind: "standard_views"; source: "declared_projections" };
  provenance?: { contribution_ref: string; descriptor_digest: string; package_ref: string; authority_refs: KitObservabilityAuthorityRefs };
  navigation: { available_operator_intents: KitObservabilityOperatorAction[] };
  available_operator_intents: KitObservabilityOperatorAction[];
  diagnostics: KitObservabilityDiagnostic[];
};

const idPattern = /^[a-z][a-z0-9-]{0,62}$/;
const refPattern = /^[^\u0000-\u001f\u007f\s]{1,512}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const uiResourcePattern = /^ui:\/\/[^\s]+$/;
const authorityIdentityPatterns: Record<KitObservabilityAuthority, RegExp> = {
  flow: /^flow:\/\/[^\s]+$/,
  surface: /^surface:\/\/[^\s]+$/,
  runtime: /^runtime:\/\/[^\s]+$/,
};

export function validateKitObservabilityContribution(value: unknown): KitObservabilityContribution {
  const root = object(value, "contribution");
  exactKeys(root, ["apiVersion", "kind", "metadata", "spec"], "contribution");
  if (root.apiVersion !== KIT_OBSERVABILITY_API_VERSION) throw new Error("contribution apiVersion is unsupported");
  if (root.kind !== KIT_OBSERVABILITY_DESCRIPTOR_KIND) throw new Error("contribution kind is invalid");
  const metadata = object(root.metadata, "contribution.metadata");
  exactKeys(metadata, ["name"], "contribution.metadata");
  identifier(metadata.name, "contribution.metadata.name");
  const spec = object(root.spec, "contribution.spec");
  exactKeys(spec, ["contract_version", "package_ref", "projections", "authority_refs", "host", "data_policy", "operator_intents", "compatibility"], "contribution.spec");
  if (spec.contract_version !== KIT_OBSERVABILITY_CONTRACT_VERSION) throw new Error("contribution contract_version is unsupported");
  reference(spec.package_ref, "contribution.spec.package_ref");
  projections(spec.projections, "contribution.spec.projections");
  authorityRefs(spec.authority_refs, "contribution.spec.authority_refs");
  hostContract(spec.host, "contribution.spec.host");
  dataPolicy(spec.data_policy, "contribution.spec.data_policy");
  operatorIntents(spec.operator_intents, "contribution.spec.operator_intents");
  const compatibility = object(spec.compatibility, "contribution.spec.compatibility");
  exactKeys(compatibility, ["unsupported_version"], "contribution.spec.compatibility");
  if (compatibility.unsupported_version !== "diagnostic") throw new Error("contribution compatibility must diagnose unsupported versions");
  return structuredClone(value) as KitObservabilityContribution;
}

/** Stable SHA-256 binding over canonical, key-sorted descriptor JSON. */
export function kitObservabilityDescriptorDigest(value: KitObservabilityContribution): string {
  const contribution = validateKitObservabilityContribution(value);
  return `sha256:${createHash("sha256").update(canonicalJson(contribution)).digest("hex")}`;
}

export function kitObservabilityProvenance(value: KitObservabilityContribution): NonNullable<KitObservabilityNegotiation["provenance"]> {
  const contribution = validateKitObservabilityContribution(value);
  return {
    contribution_ref: contribution.metadata.name,
    descriptor_digest: kitObservabilityDescriptorDigest(contribution),
    package_ref: contribution.spec.package_ref,
    authority_refs: structuredClone(contribution.spec.authority_refs),
  };
}

/** Descriptor-to-record linkage is semantic validation; each individual shape has a shipped JSON Schema. */
export function validateKitObservabilityRecord(value: unknown, contribution: KitObservabilityContribution): KitObservabilityRecord {
  const root = object(value, "record");
  exactKeys(root, ["apiVersion", "kind", "metadata", "spec"], "record");
  if (root.apiVersion !== KIT_OBSERVABILITY_API_VERSION || root.kind !== KIT_OBSERVABILITY_RECORD_KIND) throw new Error("record identity is invalid");
  const metadata = object(root.metadata, "record.metadata");
  exactKeys(metadata, ["name"], "record.metadata");
  identifier(metadata.name, "record.metadata.name");
  const spec = object(root.spec, "record.spec");
  exactKeys(spec, ["binding", "projection", "authority_refs", "data"], "record.spec");
  const binding = object(spec.binding, "record.spec.binding");
  exactKeys(binding, ["contribution_ref", "descriptor_digest", "package_ref"], "record.spec.binding");
  if (binding.contribution_ref !== contribution.metadata.name) throw new Error("record contribution_ref does not match the descriptor");
  if (binding.package_ref !== contribution.spec.package_ref) throw new Error("record package_ref does not match the descriptor");
  if (typeof binding.descriptor_digest !== "string" || !digestPattern.test(binding.descriptor_digest)) throw new Error("record descriptor_digest must be a sha256 digest");
  if (binding.descriptor_digest !== kitObservabilityDescriptorDigest(contribution)) throw new Error("record descriptor_digest does not match the descriptor");
  const projection = object(spec.projection, "record.spec.projection");
  exactKeys(projection, ["kind"], "record.spec.projection");
  projectionKind(projection.kind, "record.spec.projection.kind");
  if (!(projection.kind in contribution.spec.projections)) throw new Error("record projection is not declared by the contribution");
  recordAuthorityRefs(spec.authority_refs, contribution, "record.spec.authority_refs");
  const data = object(spec.data, "record.spec.data");
  if (Object.prototype.hasOwnProperty.call(data, "gate") || Object.prototype.hasOwnProperty.call(data, "claim")) throw new Error("record data cannot contain Flow gate or Surface claim authority");
  return structuredClone(value) as KitObservabilityRecord;
}

/** Host-owned lifecycle and capability negotiation. No result blocks the underlying Kit. */
export function negotiateKitObservabilityContribution(
  contributionResult: KitObservabilityContributionLoadResult,
  host: KitObservabilityHostState,
): KitObservabilityNegotiation {
  if (contributionResult.status !== "supported") {
    return unavailable(contributionResult.status === "unsupported" ? "incompatible" : "disabled", contributionResult.diagnostics);
  }
  if (!host.installed) return disabled("contribution_not_installed", "The host has not installed this Kit contribution.");
  if (!host.enabled) return disabled("contribution_disabled", "The host has disabled this optional Kit contribution.");
  const contribution = contributionResult.contribution;
  if (!host.supported_contract_versions.includes(contribution.spec.contract_version)) {
    return unavailable("incompatible", [{ code: "host_contract_version_unsupported", message: `Host does not support contribution contract version ${contribution.spec.contract_version}.` }]);
  }
  if (!host.capabilities.includes("standard_views")) {
    return unavailable("incompatible", [{ code: "required_host_capability_missing", message: "Host lacks required standard_views capability." }]);
  }
  const diagnostics: KitObservabilityDiagnostic[] = [];
  const hasMcpApps = host.capabilities.includes("mcp_apps_resource_bridge");
  if (!hasMcpApps) diagnostics.push({ code: "optional_host_capability_unavailable", message: "MCP Apps resource bridge is unavailable; using declarative standard views." });
  const availableOperatorIntents = contribution.spec.operator_intents.filter((action) => {
    if (host.capabilities.includes(action.required_capability)) return true;
    diagnostics.push({ code: "operator_intent_capability_unavailable", message: `Host lacks ${action.required_capability}; ${action.intent} is unavailable.` });
    return false;
  });
  const presentation = hasMcpApps
    ? {
      kind: "mcp_apps_resource_bridge" as const,
      resource: structuredClone(contribution.spec.host.presentation.preferred.resource),
      bridge: {
        ...structuredClone(contribution.spec.host.presentation.preferred.bridge),
        tool_meta: { ui: { resourceUri: contribution.spec.host.presentation.preferred.resource.uri, visibility: ["model", "app"] as ["model", "app"] } },
      },
    }
    : { kind: "standard_views" as const, source: "declared_projections" as const };
  return {
    status: "enabled",
    presentation,
    provenance: kitObservabilityProvenance(contribution),
    navigation: { available_operator_intents: structuredClone(availableOperatorIntents) },
    available_operator_intents: structuredClone(availableOperatorIntents),
    diagnostics,
  };
}

/** Read-only discovery. A symlinked descriptor must resolve inside the Kit root. */
export function loadKitObservabilityContribution(kitDir: string, manifest?: unknown): KitObservabilityContributionLoadResult {
  let manifestValue = manifest;
  const manifestPath = path.join(kitDir, "kit.json");
  try {
    const kitRoot = fs.realpathSync(path.resolve(kitDir));
    if (manifestValue === undefined) manifestValue = JSON.parse(fs.readFileSync(path.join(kitRoot, "kit.json"), "utf8"));
    const root = object(manifestValue, "kit manifest");
    const declaration = root.observability_contribution;
    if (declaration === undefined) return { status: "absent", diagnostics: [{ code: "contribution_absent", message: "Kit does not declare an observability contribution." }] };
    const entry = object(declaration, "kit manifest observability_contribution");
    exactKeys(entry, ["path"], "kit manifest observability_contribution");
    if (typeof entry.path !== "string" || !entry.path || path.isAbsolute(entry.path) || entry.path.replace(/\\/g, "/").split("/").includes("..")) throw new Error("kit manifest observability_contribution.path must be a relative in-kit path");
    const candidate = path.resolve(kitRoot, entry.path);
    if (!isContainedOrEqual(kitRoot, candidate)) throw new Error("kit manifest observability_contribution.path escapes the Kit");
    const descriptorPath = fs.realpathSync(candidate);
    if (!isContainedOrEqual(kitRoot, descriptorPath)) throw new Error("kit manifest observability_contribution.path escapes the Kit through a symlink");
    if (!fs.statSync(descriptorPath).isFile()) throw new Error("kit manifest observability_contribution.path must resolve to a regular file");
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    try {
      return { status: "supported", contribution: validateKitObservabilityContribution(descriptor), diagnostics: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : "contribution validation failed";
      const code: KitObservabilityDiagnosticCode = /apiVersion|contract_version/.test(message) ? "unsupported_contract_version" : "invalid_contribution";
      return { status: code === "unsupported_contract_version" ? "unsupported" : "invalid", diagnostics: [{ code, message }] };
    }
  } catch (error) {
    return { status: "invalid", diagnostics: [{ code: "invalid_contribution", message: error instanceof Error ? error.message : `contribution could not be loaded from ${manifestPath}` }] };
  }
}

function disabled(code: "contribution_not_installed" | "contribution_disabled", message: string): KitObservabilityNegotiation {
  return unavailable("disabled", [{ code, message }]);
}

function unavailable(status: "disabled" | "incompatible", diagnostics: KitObservabilityDiagnostic[]): KitObservabilityNegotiation {
  return { status, navigation: { available_operator_intents: [] }, available_operator_intents: [], diagnostics };
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

function projections(value: unknown, label: string): void {
  const entries = object(value, label);
  exactKnownKeys(entries, KIT_OBSERVABILITY_PROJECTION_KINDS, label);
  if (Object.keys(entries).length === 0) throw new Error(`${label} must declare at least one projection`);
  for (const [kind, entry] of Object.entries(entries)) {
    projectionKind(kind, `${label}.${kind}`);
    const projection = object(entry, `${label}.${kind}`);
    exactKeys(projection, ["schema_ref"], `${label}.${kind}`);
    reference(projection.schema_ref, `${label}.${kind}.schema_ref`);
  }
}

function authorityRefs(value: unknown, label: string): void {
  const entries = object(value, label);
  exactKnownKeys(entries, KIT_OBSERVABILITY_AUTHORITIES, label);
  if (Object.keys(entries).length === 0) throw new Error(`${label} must declare at least one authority reference`);
  for (const [authority, ref] of Object.entries(entries)) {
    if (!(KIT_OBSERVABILITY_AUTHORITIES as readonly string[]).includes(authority)) throw new Error(`${label}.${authority} is invalid`);
    reference(ref, `${label}.${authority}`);
  }
}

function recordAuthorityRefs(value: unknown, contribution: KitObservabilityContribution, label: string): void {
  const refs = object(value, label);
  authorityRefs(refs, label);
  const declared = Object.keys(contribution.spec.authority_refs).sort();
  const actual = Object.keys(refs).sort();
  if (JSON.stringify(actual) !== JSON.stringify(declared)) throw new Error(`${label} must carry exactly the descriptor-declared authority identities`);
  for (const authority of actual as KitObservabilityAuthority[]) {
    const identity = refs[authority];
    if (identity === contribution.spec.authority_refs[authority]) throw new Error(`${label}.${authority} must be a record identity, not the descriptor authority type`);
    if (typeof identity !== "string" || !authorityIdentityPatterns[authority].test(identity)) throw new Error(`${label}.${authority} must be a ${authority}:// record identity`);
  }
}

function hostContract(value: unknown, label: string): void {
  const host = object(value, label);
  exactKeys(host, ["required_capabilities", "optional_capabilities", "presentation"], label);
  if (JSON.stringify(host.required_capabilities) !== JSON.stringify(["standard_views"])) throw new Error(`${label}.required_capabilities must be [standard_views]`);
  if (JSON.stringify(host.optional_capabilities) !== JSON.stringify(["mcp_apps_resource_bridge"])) throw new Error(`${label}.optional_capabilities must be [mcp_apps_resource_bridge]`);
  const presentation = object(host.presentation, `${label}.presentation`);
  exactKeys(presentation, ["preferred", "fallback"], `${label}.presentation`);
  const preferred = object(presentation.preferred, `${label}.presentation.preferred`);
  exactKeys(preferred, ["kind", "resource", "bridge"], `${label}.presentation.preferred`);
  if (preferred.kind !== "mcp_apps_resource_bridge") throw new Error(`${label}.presentation.preferred must be an MCP Apps resource bridge`);
  const resource = object(preferred.resource, `${label}.presentation.preferred.resource`);
  exactKeys(resource, ["uri", "mime_type"], `${label}.presentation.preferred.resource`);
  if (typeof resource.uri !== "string" || !uiResourcePattern.test(resource.uri) || resource.mime_type !== "text/html;profile=mcp-app") throw new Error(`${label}.presentation.preferred.resource must declare a ui:// MCP Apps resource`);
  const bridge = object(preferred.bridge, `${label}.presentation.preferred.bridge`);
  exactKeys(bridge, ["tool_name", "visibility"], `${label}.presentation.preferred.bridge`);
  identifier(bridge.tool_name, `${label}.presentation.preferred.bridge.tool_name`);
  if (JSON.stringify(bridge.visibility) !== JSON.stringify(["model", "app"])) throw new Error(`${label}.presentation.preferred.bridge must use canonical MCP Apps visibility`);
  const fallback = object(presentation.fallback, `${label}.presentation.fallback`);
  exactKeys(fallback, ["kind", "source"], `${label}.presentation.fallback`);
  if (fallback.kind !== "standard_views" || fallback.source !== "declared_projections") throw new Error(`${label}.presentation.fallback must use declared standard views`);
}

function dataPolicy(value: unknown, label: string): void {
  const policy = object(value, label);
  exactKeys(policy, ["redaction", "retention", "raw_source"], label);
  if (policy.redaction !== "declared" || policy.retention !== "kit_owned" || !["available", "unavailable"].includes(String(policy.raw_source))) throw new Error(`${label} is invalid`);
}

function operatorIntents(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  value.forEach((entry, index) => {
    const action = object(entry, `${label}[${index}]`);
    if (action.intent === "open_resource") {
      exactKeys(action, ["intent", "label", "required_capability", "target"], `${label}[${index}]`);
      if (action.required_capability !== "resource.open") throw new Error(`${label}[${index}] open_resource requires resource.open`);
      actionTarget(action.target, `${label}[${index}].target`, ["workflow_run", "work_item", "narrative", "queue_item"]);
    } else if (action.intent === "export_local") {
      exactKeys(action, ["intent", "label", "required_capability"], `${label}[${index}]`);
      if (action.required_capability !== "export.local") throw new Error(`${label}[${index}] export_local requires export.local`);
    } else if (action.intent === "review_proposal") {
      exactKeys(action, ["intent", "label", "required_capability", "target"], `${label}[${index}]`);
      if (action.required_capability !== "proposal.review") throw new Error(`${label}[${index}] review_proposal requires proposal.review`);
      actionTarget(action.target, `${label}[${index}].target`, ["proposal"], "surface");
    } else throw new Error(`${label}[${index}].intent is invalid`);
    if (typeof action.label !== "string" || action.label.trim().length === 0 || action.label.length > 120) throw new Error(`${label}[${index}].label must be a bounded non-empty label`);
  });
}

function actionTarget(value: unknown, label: string, kinds: readonly string[], requiredAuthority?: KitObservabilityAuthority): void {
  const target = object(value, label);
  exactKeys(target, ["authority", "kind"], label);
  if (!(KIT_OBSERVABILITY_AUTHORITIES as readonly unknown[]).includes(target.authority) || (requiredAuthority && target.authority !== requiredAuthority)) throw new Error(`${label}.authority is invalid`);
  if (!kinds.includes(String(target.kind))) throw new Error(`${label}.kind is invalid`);
}

function exactKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) throw new Error(`${label} has unknown properties: ${extras.join(", ")}`);
}

function isContainedOrEqual(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
