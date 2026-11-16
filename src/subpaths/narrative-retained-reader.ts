// `@kontourai/flow-agents/narrative-retained-reader`: the retained grounded-narrative reader, without the package root's import graph.
// Re-exports exactly what the package root exports from this module; widen both together.
export {
  readGroundedNarrative,
} from "../narrative/retained-reader.js";
export type {
  ReadGroundedNarrativeInput,
  ReadGroundedNarrativeResult,
  RetainedNarrativeReadFailure,
  RetainedNarrativeReadLimits,
  RetainedNarrativeScope,
} from "../narrative/retained-reader.js";
