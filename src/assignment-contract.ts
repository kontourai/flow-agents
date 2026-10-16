/**
 * Stable contract subpath: `@kontourai/flow-agents/assignment-contract`.
 *
 * The assignment coordination PRIMITIVE (ADR 0021), engine-level and kit-neutral and pure: no
 * `fs`, `child_process`, or `gh`. A host product (Station is the first) imports this to see the
 * same claims as Flow's CLI instead of re-deriving the shapes. See `src/lib/assignment-model.ts`
 * for the full doc comment.
 *
 * In this entry: the `AssignmentProvider` contract, the actor identity, the versioned claim-record
 * type and codec, the `assignment ⋈ liveness` join, the takeover eligibility rules, and the
 * `AssignmentLivenessSource` a host implements from its own runtime.
 *
 * Not in this entry, by design:
 *   - Builder Kit POLICY: when to claim (`pull-work`), when to release (the Stop hook), and how a
 *     takeover resumes (`continue-work`, the verify-hold gate, `builder-lifecycle-authority`).
 *     Flow Agents is not the Builder Kit (`docs/architecture-engine-and-kits.md`); the engine
 *     gives no kit special privilege, so a host applies its own policy over this primitive.
 *   - GitHub's issue-shaped mapping (`owner/repo#number` `work_item_ref`, labels, claim comment):
 *     `@kontourai/flow-agents/assignment-github`.
 *   - The local-file store (does real I/O): `@kontourai/flow-agents/assignment-local-file`.
 *
 * Subject identity is any stable work identity string (a GitHub issue ref, a host Task id, a Flow
 * work item); nothing here parses it.
 *
 * @module
 */
export {
  ASSIGNMENT_CLAIM_RECORD_ROLE,
  ASSIGNMENT_CLAIM_RECORD_SCHEMA_VERSION,
  DEFAULT_TAKEOVER_GRACE_SECONDS,
  TAKEOVER_RULES,
  canonicalHolderActorKey,
  computeEffectiveState,
  decideTakeover,
  decodeAssignmentClaimRecord,
  findAssignmentClaimRecordProblems,
  humanHeldDisposition,
  isAutoSupersedable,
  isHumanActor,
  isTakeoverGraceElapsed,
  parseAssignmentClaimRecord,
  resolveEffectiveState,
  sanitizeSegment,
  serializeActor,
  serializeAssignmentClaimRecord,
} from "./lib/assignment-model.js";
export type {
  ActorStruct,
  AssignmentAuditEntry,
  AssignmentClaimMeta,
  AssignmentClaimRecord,
  AssignmentClaimRecordDecodeResult,
  AssignmentClaimRecordStatus,
  AssignmentLivenessSource,
  AssignmentProvider,
  AssignmentProviderKind,
  AssignmentReleaseMeta,
  AssignmentStatus,
  AssignmentSupersedeMeta,
  EffectiveState,
  EffectiveStateResult,
  FreshHolder,
  HumanAssigneePolicy,
  TakeoverAction,
} from "./lib/assignment-model.js";
