/**
 * Provider-neutral work-item MUTATION vocabulary (#776 — two-way sync contract extension).
 *
 * Canonical source: `context/contracts/work-item-contract.md` ("Mutations" section). Read that
 * first — it explains the three operations, the mutation `base`/conflict-policy fields, and the
 * render-don't-execute split between adapters. This module is the executable mirror of that
 * prose: the shared request/result shapes plus the one conflict-detection function every adapter
 * (GitHub render-only in `src/cli/work-item-mutation-provider.ts`, and the same file's local-file
 * adapter, which actually applies the mutation) calls instead of reimplementing the comparison.
 *
 * Precedent: `context/contracts/assignment-provider-contract.md`'s GitHub write path (render,
 * don't execute) and its local-file real-I/O counterpart. Mutation operations follow the same
 * split so the SAME operation + conflict-policy vocabulary proves provider-neutral (issue #776
 * acceptance: "a second implementation proves provider-neutrality").
 *
 * @module
 */
import type { WorkItemStatus } from "./work-item-vocabulary.js";

export const WORK_ITEM_MUTATION_SCHEMA_VERSION = "1.0" as const;

/** The three provider-neutral mutation operations from the contract's "Operations" table. */
export const workItemMutationOperations = ["status_transition", "field_update", "comment"] as const;
export type WorkItemMutationOperation = (typeof workItemMutationOperations)[number];

/** The result vocabulary from the contract's "A mutation result reports..." table. */
export const workItemMutationResultStatuses = ["rendered", "applied", "conflict", "rejected", "not_verified"] as const;
export type WorkItemMutationResultStatus = (typeof workItemMutationResultStatuses)[number];

/** A field value a mutation/observation can carry: string, number, boolean, or null. */
export type WorkItemMutationFieldValue = string | number | boolean | null;

/**
 * The minimal provider-state snapshot used both as a mutation request's declared `base` (what it
 * was computed against) and as the freshly observed state an adapter diffs it against. Reuses
 * `WorkItem.status` naming from the read-side vocabulary module rather than inventing a parallel
 * field name.
 */
export interface WorkItemMutationBase {
  status?: WorkItemStatus;
  field_values?: Record<string, WorkItemMutationFieldValue>;
}

/** The target work item's stable id plus provider coordinates, per the contract's `work_item_ref`. */
export interface WorkItemMutationRef {
  id: string;
  owner?: string;
  repo?: string;
  number?: number;
}

export interface WorkItemStatusTransitionPayload {
  to_status: WorkItemStatus;
  to_status_raw?: string;
}

export interface WorkItemFieldUpdatePayload {
  field: string;
  value: WorkItemMutationFieldValue;
}

export interface WorkItemCommentPayload {
  body: string;
}

interface WorkItemMutationRequestCommon {
  schema_version: typeof WORK_ITEM_MUTATION_SCHEMA_VERSION;
  work_item_ref: WorkItemMutationRef;
}

export type WorkItemMutationRequest =
  | (WorkItemMutationRequestCommon & { operation: "status_transition"; base: Required<Pick<WorkItemMutationBase, "status">>; payload: WorkItemStatusTransitionPayload })
  | (WorkItemMutationRequestCommon & { operation: "field_update"; base: { field_values: Record<string, WorkItemMutationFieldValue> }; payload: WorkItemFieldUpdatePayload })
  | (WorkItemMutationRequestCommon & { operation: "comment"; base: WorkItemMutationBase; payload: WorkItemCommentPayload });

/** Describes exactly which field diverged between a mutation's declared `base` and the current
 * observed provider state, per the contract's Conflict Policy ("provider wins"). */
export interface WorkItemMutationConflict {
  field: string;
  base_value: WorkItemMutationFieldValue;
  observed_value: WorkItemMutationFieldValue;
}

export interface WorkItemMutationResult {
  schema_version: typeof WORK_ITEM_MUTATION_SCHEMA_VERSION;
  operation: WorkItemMutationOperation;
  status: WorkItemMutationResultStatus;
  work_item_ref: WorkItemMutationRef;
  conflict?: WorkItemMutationConflict;
  reason?: string;
}

/** Public errors deliberately contain only stable classifications, matching the
 * `ChangeProviderError`/`WorkItemMutationError` shape convention used elsewhere in this repo. */
export class WorkItemMutationError extends Error {
  readonly code: "invalid_request" = "invalid_request";
  constructor(message: string) {
    super(message);
    this.name = "WorkItemMutationError";
  }
}

function invalid(message: string): never {
  throw new WorkItemMutationError(message);
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${field} must be a plain object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} must be a nonempty string`);
  return value as string;
}

function fieldValue(value: unknown, field: string): WorkItemMutationFieldValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value as WorkItemMutationFieldValue;
  invalid(`${field} must be a string, number, boolean, or null`);
}

/**
 * Validate and normalize a mutation request per the contract's "A mutation request is a single
 * provider-neutral shape" section, including the required-`base` staleness-detection rule: a
 * `status_transition` without `base.status`, or a `field_update` without
 * `base.field_values[payload.field]`, is rejected as invalid input rather than silently allowed
 * to skip conflict detection. Throws `WorkItemMutationError` on any shape violation.
 */
export function parseWorkItemMutationRequest(value: unknown): WorkItemMutationRequest {
  const root = plainObject(value, "request");
  if (root.schema_version !== WORK_ITEM_MUTATION_SCHEMA_VERSION) invalid(`request.schema_version must be ${WORK_ITEM_MUTATION_SCHEMA_VERSION}`);
  if (!workItemMutationOperations.includes(root.operation as WorkItemMutationOperation)) {
    invalid(`request.operation must be one of ${workItemMutationOperations.join(", ")}`);
  }

  const refRecord = plainObject(root.work_item_ref, "request.work_item_ref");
  const work_item_ref: WorkItemMutationRef = {
    id: nonEmptyString(refRecord.id, "request.work_item_ref.id"),
    ...(typeof refRecord.owner === "string" ? { owner: refRecord.owner } : {}),
    ...(typeof refRecord.repo === "string" ? { repo: refRecord.repo } : {}),
    ...(typeof refRecord.number === "number" ? { number: refRecord.number } : {}),
  };

  const baseRecord = plainObject(root.base ?? {}, "request.base");
  const payloadRecord = plainObject(root.payload, "request.payload");

  if (root.operation === "status_transition") {
    const status = nonEmptyString(baseRecord.status, "request.base.status (required to detect status_transition staleness)");
    const to_status = nonEmptyString(payloadRecord.to_status, "request.payload.to_status");
    const to_status_raw = payloadRecord.to_status_raw;
    return {
      schema_version: WORK_ITEM_MUTATION_SCHEMA_VERSION,
      operation: "status_transition",
      work_item_ref,
      base: { status },
      payload: { to_status, ...(typeof to_status_raw === "string" ? { to_status_raw } : {}) },
    };
  }

  if (root.operation === "field_update") {
    const field = nonEmptyString(payloadRecord.field, "request.payload.field");
    const baseFieldValues = plainObject(baseRecord.field_values ?? {}, "request.base.field_values");
    if (!Object.prototype.hasOwnProperty.call(baseFieldValues, field)) {
      invalid(`request.base.field_values.${field} is required (the base value field_update was computed from, needed to detect staleness)`);
    }
    const value = fieldValue(payloadRecord.value, "request.payload.value");
    return {
      schema_version: WORK_ITEM_MUTATION_SCHEMA_VERSION,
      operation: "field_update",
      work_item_ref,
      base: { field_values: { [field]: fieldValue(baseFieldValues[field], `request.base.field_values.${field}`) } },
      payload: { field, value },
    };
  }

  // comment: base is optional (append-only, non-clobbering — see the contract's Conflict Policy).
  const body = nonEmptyString(payloadRecord.body, "request.payload.body");
  const base: WorkItemMutationBase = {
    ...(typeof baseRecord.status === "string" ? { status: baseRecord.status } : {}),
    ...(baseRecord.field_values !== undefined ? { field_values: plainObject(baseRecord.field_values, "request.base.field_values") as Record<string, WorkItemMutationFieldValue> } : {}),
  };
  return { schema_version: WORK_ITEM_MUTATION_SCHEMA_VERSION, operation: "comment", work_item_ref, base, payload: { body } };
}

/** Parse a freshly observed provider-state snapshot to compare a mutation's `base` against. Looser
 * than `parseWorkItemMutationRequest`'s `base`: every field is optional, since an adapter may not
 * always have every field observed (see `detectMutationConflict`'s "no observation" handling). */
export function parseObservedWorkItemState(value: unknown): WorkItemMutationBase {
  const root = plainObject(value ?? {}, "observed");
  return {
    ...(typeof root.status === "string" ? { status: root.status } : {}),
    ...(root.field_values !== undefined ? { field_values: plainObject(root.field_values, "observed.field_values") as Record<string, WorkItemMutationFieldValue> } : {}),
  };
}

/**
 * Shared conflict-detection: compares a validated request's `base` to a freshly `observed` state,
 * per the contract's "provider wins, with staleness detection" policy. Returns `null` when there
 * is no material divergence (safe to render/apply), or a `WorkItemMutationConflict` describing the
 * drift otherwise.
 *
 * `comment` never conflicts (append-only, non-clobbering — the contract's Conflict Policy).
 * `status_transition`/`field_update` compare by strict equality, treating an absent
 * observed value as a genuine "not currently set" state comparable to `base` (a real divergence,
 * not a silent pass) — `observed_value` normalizes to `null` when the field is absent, matching
 * `WorkItemMutationFieldValue`'s null case.
 *
 * This function assumes the caller COULD observe current state at all. A caller that could not
 * obtain any fresh observation (the GitHub render adapter without a supplied `observed` argument)
 * must route to `not_verified` itself, one level up, rather than calling this function with a
 * fabricated observation — see `renderGithubMutation` in `src/cli/work-item-mutation-provider.ts`.
 */
export function detectMutationConflict(request: WorkItemMutationRequest, observed: WorkItemMutationBase): WorkItemMutationConflict | null {
  if (request.operation === "comment") return null;
  if (request.operation === "status_transition") {
    const observedStatus: WorkItemMutationFieldValue = observed.status ?? null;
    return observedStatus === request.base.status ? null : { field: "status", base_value: request.base.status, observed_value: observedStatus };
  }
  const field = request.payload.field;
  const baseValue = request.base.field_values[field];
  const observedValue: WorkItemMutationFieldValue = observed.field_values?.[field] ?? null;
  return observedValue === baseValue ? null : { field, base_value: baseValue, observed_value: observedValue };
}
