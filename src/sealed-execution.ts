/**
 * Minimal supported surface for sealed workload clients.
 *
 * Keeping this entrypoint closed over only the lifecycle-authority module lets
 * clients content-address the complete executable verification boundary.
 */
export {
  SEALED_EXECUTION_API_REVISION,
  buildUnsignedSealedExecutionRequest,
  buildUnsignedSealedWorkloadAuthorization,
  invokeExternalSealedLifecycleAuthority,
  lifecycleAuthorityResultDigest,
  validateSealedExecutionSafeResult,
  verifySealedExecutionCompletion,
} from "./external-lifecycle-authority.js";
export type {
  ExternalLifecycleAuthorityRequest,
  ExternalLifecycleMutationResult,
  SealedExecutionSafeResult,
} from "./external-lifecycle-authority.js";
