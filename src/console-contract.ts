/**
 * Stable contract subpath — `@kontourai/flow-agents/console-contract`.
 *
 * Flow Agents OWNS the workflow-state -> Console projection mapping (issue
 * #778's `ConsoleProcessStatus` table, #891's trust-projection shapes).
 * This module is the typed+value contract surface other planes import
 * instead of hand-mirroring it (mirroring the precedent set by Flow's own
 * `@kontourai/flow/console-contract`): the frozen
 * `WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS` table, the pure
 * `mapWorkflowStatusToConsoleProcessStatus` / `deriveConsoleProcessBlockedReason`
 * mappers, and the envelope/entry/ref types both projection families (process,
 * trust) produce.
 *
 * Issue #933: station's `workflow-process-projection-mirror.ts` hand-copied
 * this table and these two mappers because no subpath existed to import the
 * real thing from, so a future re-bucketed status could drift silently with
 * no trip-wire. Downstreams should import from here instead; see
 * docs/workflow-usage-guide.md's projection section for the CLI commands
 * that emit envelopes in this shape.
 *
 * This subpath deliberately re-exports only the pure contract (the status
 * vocabulary, the table, the two derivation functions, and the projection
 * envelope/entry/ref types) -- NOT the filesystem-reading `readWorkflow*`
 * functions or the `build*Projection` builders, which pull in Node's `fs`
 * and (for trust) `@kontourai/surface`. Those remain internal to this
 * package's own CLI commands (`console-process-projection`,
 * `console-trust-projection`); a downstream contract consumer only needs the
 * status vocabulary and the pure mapping/derivation logic to render or
 * validate an already-projected envelope.
 *
 * @module
 */
export {
  WORKFLOW_STATUS_TO_CONSOLE_PROCESS_STATUS,
  mapWorkflowStatusToConsoleProcessStatus,
  deriveConsoleProcessBlockedReason,
} from "./lib/workflow-process-projection.js";
export type {
  WorkflowTaskStatus,
  WorkflowNextActionStatus,
  ConsoleProcessStatus,
  ConsoleProjectionRef,
  ConsoleProjectionScope,
  ConsoleProcessProjection,
  ConsoleProcessProjectionEnvelope,
} from "./lib/workflow-process-projection.js";
export type {
  ConsoleTrustGateAssociation,
  ConsoleTrustSourceOfTruthRef,
  ConsoleTrustProjection,
  ConsoleTrustProjectionEnvelope,
} from "./lib/workflow-trust-projection.js";
/**
 * #1021 liveness fleet. Same discipline as the projection exports above: the PURE rule and the
 * shapes, never the stream-reading `readFleet`/`discoverRepoRoots`, which pull in `fs`, `git`,
 * and `createRequire`.
 *
 * `laneState` is the whole freshness predicate, exported so a plane rendering realtime lane
 * activity asks Flow Agents whether a lane still holds rather than recomputing it from an age
 * and a TTL — the drift shape #933 caught when station hand-mirrored a status table. Authority
 * stays put: Flow Agents owns liveness, Console aggregates and renders, exactly as
 * console-server's flow-bridge consumes `@kontourai/flow/console-contract` types without pulling
 * in Flow's runtime.
 */
export { laneState } from "./lib/liveness-fleet.js";
export type { LivenessLaneState, LaneObservation, FleetLane } from "./lib/liveness-fleet.js";
