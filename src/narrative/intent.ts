/**
 * #622: bounded, capability-declared, at-action stated-intent capture.
 *
 * `captureIntent` is PURE (no I/O). It takes a caller-resolved capability status
 * (the CLI resolves it via queryCapability(runtime, "intent_annotation") — this
 * module deliberately does NOT import the capability table so it stays inside the
 * #619 narrative import boundary) and an OPTIONAL agent-supplied bounded purpose:
 *
 *   - supported + a purpose that survives the policy filter -> an `agent_stated`
 *     statement (typed self-report, never proof).
 *   - otherwise -> a deterministic `workflow_derived_purpose` statement derived
 *     ONLY from the active gate reference. The else-branch is STRUCTURALLY
 *     incapable of emitting `agent_stated` (R4: no fabricated rationale).
 *
 * `bindIntentAnnotation` freezes the captured annotation into a write-once
 * channel (link(2)/EEXIST, mirroring snapshot.ts:createOnlyWriteManifest). A
 * post-hoc / second write to an already-frozen channel fails EEXIST and is
 * structurally rejected (R1/AC3): there is no mutable, late-writable side
 * channel for reconstructed rationale.
 *
 * Imports are restricted to node builtins, ./-relative narrative files, and the
 * shared ../lib/fs.js helper (the #619 arch-isolation test enforces this).
 *
 * @module
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../lib/fs.js";
import { effectiveNarrativeRedactionFields, filterNarrativeRecord } from "./policy-filter.js";
import { agentStatedIntent, workflowDerivedPurpose, type Statement } from "./statements.js";

/**
 * Structural mirror of capability-declarations.ts:CapabilityStatus. Declared
 * locally so this module never imports the capability table (which is outside
 * the narrative import boundary); a real `CapabilityStatus` is assignable here.
 */
export type IntentCapabilityStatus =
  | { readonly status: "supported" }
  | { readonly status: "partial"; readonly note: string }
  | { readonly status: "unsupported"; readonly reason: string };

export type IntentCaptureMode = "agent_stated" | "workflow_derived_purpose";

export interface CaptureIntentInput {
  /** Caller-resolved capability status (queryCapability(runtime,"intent_annotation")). */
  capability: IntentCapabilityStatus;
  /** Attributed actor for the self-report (required for agent_stated). */
  actor: string;
  /** Runtime id, recorded for provenance. */
  runtimeId: string;
  /** fa1 source id of the material action being annotated (the citation). */
  actionRef: string;
  /** fa1 source id of the active gate/operation — the ONLY input to the fallback derivation. */
  activeGateRef: string;
  /** Optional agent-supplied bounded purpose (redactable narrative source). */
  purpose?: string;
  /** Optional fa1 source id of the objective, cited by the fallback. */
  objectiveRef?: string;
  /** Effective redaction fields; defaults to effectiveNarrativeRedactionFields(). */
  redactionFields?: readonly string[];
  turnRef?: number;
}

export interface CapturedIntent {
  mode: IntentCaptureMode;
  statement: Statement;
  runtime: string;
  action_ref: string;
  /** Redaction field names that nulled the supplied purpose (empty when none applied). */
  redactions: string[];
}

/**
 * Route the agent-supplied purpose through the policy-filtered view (D5/R7). A
 * redacted `purpose` field is nulled BEFORE emission — a nulled purpose never
 * reaches an agent_stated statement (capture falls back to workflow_derived).
 * A policy that is unresolvable/invalid fails closed (treated as redacted).
 */
function filterPurpose(purpose: string, redactionFields: readonly string[]): { purpose?: string; redactions: string[] } {
  const filtered = filterNarrativeRecord({ purpose }, redactionFields);
  if (filtered.kind !== "filtered") return { redactions: filtered.fields };
  const value = filtered.record.purpose;
  const redactions = filtered.redactions.filter((field) => field === "purpose" || field.endsWith(".purpose"));
  return typeof value === "string" && value.length > 0 ? { purpose: value, redactions } : { redactions };
}

export function captureIntent(input: CaptureIntentInput): CapturedIntent {
  const redactionFields = input.redactionFields ?? effectiveNarrativeRedactionFields();
  const { purpose, redactions } = typeof input.purpose === "string" && input.purpose.length > 0
    ? filterPurpose(input.purpose, redactionFields)
    : { purpose: undefined, redactions: [] as string[] };

  if (input.capability.status === "supported" && purpose !== undefined) {
    return {
      mode: "agent_stated",
      statement: agentStatedIntent({
        sourceId: input.actionRef,
        purpose,
        actor: input.actor,
        ...(input.turnRef !== undefined ? { turnRef: input.turnRef } : {}),
      }),
      runtime: input.runtimeId,
      action_ref: input.actionRef,
      redactions,
    };
  }

  // Structural guarantee (R4): the fallback branch can NEVER emit agent_stated —
  // it only ever constructs a deterministic_derived workflow_derived_purpose.
  return {
    mode: "workflow_derived_purpose",
    statement: workflowDerivedPurpose({
      activeGateRef: input.activeGateRef,
      ...(input.objectiveRef ? { objectiveRef: input.objectiveRef } : {}),
    }),
    runtime: input.runtimeId,
    action_ref: input.actionRef,
    redactions,
  };
}

export const INTENT_ANNOTATION_FILE = "intent-annotation.json";
export const INTENT_ANNOTATION_SCHEMA_VERSION = "1.0" as const;

export interface IntentAnnotation {
  schema_version: typeof INTENT_ANNOTATION_SCHEMA_VERSION;
  mode: IntentCaptureMode;
  /** Frozen at bind time and co-bound to this single capture (R1). */
  captured_at: string;
  runtime: string;
  action_ref: string;
  statement: Statement;
  redactions: string[];
}

export interface BindIntentAnnotationDependencies {
  now?: () => string;
}

/**
 * Freeze a captured annotation into a write-once channel (R1/AC3). Uses the same
 * create-only link(2)/EEXIST discipline as snapshot.ts:createOnlyWriteManifest:
 * a second/late write to an already-frozen channel throws (EEXIST), so a
 * post-hoc-reconstructed rationale can never overwrite or masquerade as the
 * at-action annotation. `captured_at` is stamped once, co-binding the annotation
 * to this capture.
 */
export function bindIntentAnnotation(
  channelDir: string,
  captured: CapturedIntent,
  deps: BindIntentAnnotationDependencies = {},
): { path: string; annotation: IntentAnnotation } {
  const now = deps.now ?? (() => new Date().toISOString());
  const annotation: IntentAnnotation = {
    schema_version: INTENT_ANNOTATION_SCHEMA_VERSION,
    mode: captured.mode,
    captured_at: now(),
    runtime: captured.runtime,
    action_ref: captured.action_ref,
    statement: captured.statement,
    redactions: captured.redactions,
  };
  const file = path.join(channelDir, INTENT_ANNOTATION_FILE);
  const temp = path.join(channelDir, `.intent-annotation.${process.pid}.${Date.now().toString(36)}.tmp`);
  atomicWriteFile(channelDir, temp, Buffer.from(`${JSON.stringify(annotation, null, 2)}\n`));
  try {
    fs.linkSync(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("intent annotation channel already frozen");
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { path: file, annotation };
}
