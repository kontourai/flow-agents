// `@kontourai/flow-agents/run-correlation`: run-correlation envelopes, without the package root's import graph.
// Re-exports exactly what the package root exports from this module; widen both together.
export {
  RUN_CORRELATION_IDENTITY_KEYS,
  RUN_CORRELATION_IDENTITY_STATUSES,
  RUN_CORRELATION_SCHEMA_VERSION,
  CREDENTIAL_PATTERN_SOURCES,
  RunCorrelationValidationError,
  RUNTIME_CORRELATION_IDENTITY_DECLARATIONS,
  attachRunCorrelation,
  containsSensitiveCredential,
  createRunCorrelationEnvelope,
  readRunCorrelation,
  runtimeCorrelationIdentityDeclaration,
  validateRunCorrelationEnvelope,
  validateRunCorrelationPresence,
} from "../run-correlation.js";
export type {
  AbsentRunCorrelationIdentity,
  PresentRunCorrelationIdentity,
  RunCorrelationEnvelope,
  RunCorrelationIdentity,
  RunCorrelationIdentityKey,
  RunCorrelationIdentityStatus,
  RunCorrelationInput,
  RunCorrelationCarrier,
  RunCorrelationPresence,
  RuntimeCorrelationIdentityDeclaration,
  RuntimeCorrelationIdentitySupport,
} from "../run-correlation.js";
