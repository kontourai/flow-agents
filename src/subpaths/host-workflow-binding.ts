// `@kontourai/flow-agents/host-workflow-binding`: host workflow session binding, without the package root's import graph.
// Re-exports exactly what the package root exports from this module; widen both together.
export {
  bindHostWorkflowSession,
  buildUnsignedHostWorkflowAuthority,
  hostWorkflowAuthorityPayload,
  retireHostWorkflowSession,
  validateHostWorkflowAuthority,
} from "../lib/host-workflow-binding.js";
export type {
  HostWorkflowBinding,
  HostWorkflowAuthority,
  HostWorkflowBindingInput,
  RetireHostWorkflowBindingInput,
} from "../lib/host-workflow-binding.js";
