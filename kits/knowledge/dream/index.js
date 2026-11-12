/**
 * `knowledge.dream` (#671): the callable flow behind the Unified Agentic Memory
 * distillation job. A host scheduler (Station's hosted scheduler, station#4484)
 * invokes `runDream(host, options)` or `dream/cli.js`; the opt-in hook trigger
 * starts the same CLI. Nothing here schedules itself.
 *
 * @module dream
 */

// `runDream` does not check its `dreamDir`; the CLI and the hook paths do. A library caller that passes its own
// dreamDir must call `assertOwnerControlledDir(dreamDir, "dreamDir")` and the same for `<dreamDir>/briefs` first.
export { DEFAULT_ROLE, assertOwnerControlledDir, loadDreamConfig, validateDreamConfig } from "./config.js";
export {
  DEFAULT_GLOBAL_BUDGET_BYTES,
  DEFAULT_PROJECT_BUDGET_BYTES,
  compileBrief,
  rankItems,
  writeBriefs,
} from "./brief.js";
export { PURGE_GATE_FILE, createPurgeFence, readPurgeGate, scrubBriefs } from "./purge-gate.js";
export { MEMORY_CATEGORY, decodeEnvelope, encodeEnvelope, indexProposals } from "./envelope.js";
export { TRIGGER_EVENTS, handleTrigger } from "./hook-trigger.js";
export { MODEL_SETUP_DOC, RUNTIME_KINDS, bindTraverseExtract, createCliRuntime, createRelayExtractionProvider, createRoleRuntime, extractForRuntime, modelSetupHelp } from "./model.js";
export { proposeSitting } from "./propose.js";
export { DEFAULT_MAX_SITTINGS_PER_RUN, DREAM_PROPOSER_ID, REPORT_SCHEMA_VERSION, defaultDreamDir, runDream } from "./run.js";
