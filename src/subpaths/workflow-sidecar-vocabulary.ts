// `@kontourai/flow-agents/workflow-sidecar-vocabulary`: the workflow sidecar's status and phase
// vocabulary and its JSON writer, without the package root's import graph. These are the same
// bindings the package root and cli/workflow-sidecar export.
export { phases, statuses, writeJson } from "../lib/workflow-sidecar-vocabulary.js";
