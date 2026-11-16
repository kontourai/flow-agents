// `@kontourai/flow-agents/survey-flow-gate-adapter`: the Survey review adapter for paused Flow gates, without the package root's import graph.
// Re-exports exactly what the package root exports from this module; widen both together.
export {
  createSurveyFlowGateAdapter,
  continuePausedFlowGateFromSurvey,
  SurveyFlowGateInputError,
} from "../survey-flow-gate-adapter.js";
export type {
  ContinuePausedFlowGateFromSurveyInput,
  ContinuePausedFlowGateFromSurveyResult,
  ResolvedSurveyFlowGateReviewSession,
  SurveyFlowGateAdapterDependencies,
  SurveyFlowGateReviewSessionResolver,
} from "../survey-flow-gate-adapter.js";
