/**
 * Stable contract subpath: `@kontourai/flow-agents/assignment-local-file`.
 *
 * The local-file assignment provider: the same durable store (`<artifact-root>/assignment/
 * <subject>.json`, written under a per-subject lock) that Flow's CLI reads and writes, so a host
 * and the CLI see the same claims for a project. Does real `fs` I/O, which is why it is separate
 * from the pure `assignment-contract` entry. It imports no `child_process` and runs no `gh`.
 *
 * `createLocalFileAssignmentProvider` is the `AssignmentProvider` (plus the record-returning
 * `LocalAssignmentProviderExt`); the lower-level `performLocal*` functions and the lock are
 * exposed for hosts that need to compose a transaction under the same lock the CLI uses.
 *
 * @module
 */
export {
  assignmentFilePath,
  createLocalFileAssignmentProvider,
  listLocalAssignedSubjects,
  performLocalClaim,
  performLocalRelease,
  performLocalReleaseUnderLock,
  performLocalSupersede,
  readLocalAssignmentStatus,
  readLocalRecord,
  withSubjectLock,
  withSubjectLockAsync,
  writeLocalRecord,
} from "./lib/assignment-local-store.js";
export type { LocalAssignmentProviderExt } from "./lib/assignment-local-store.js";
