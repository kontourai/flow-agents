/**
 * `knowledge.dream` (#671): the callable flow behind the Unified Agentic Memory
 * distillation job. A host scheduler (Station's hosted scheduler, station#4484)
 * invokes `runDream(host, options)` or `dream/cli.js`; the opt-in hook trigger
 * starts the same CLI. Nothing here schedules itself.
 *
 * @module dream
 */

export { DEFAULT_ROLE, loadDreamConfig, validateDreamConfig } from "./config.js";
export {
  DEFAULT_GLOBAL_BUDGET_BYTES,
  DEFAULT_PROJECT_BUDGET_BYTES,
  compileBrief,
  rankItems,
  writeBriefs,
} from "./brief.js";
export { MEMORY_CATEGORY, decodeEnvelope, encodeEnvelope, indexProposals } from "./envelope.js";
export { TRIGGER_EVENTS, handleTrigger } from "./hook-trigger.js";
export { bindTraverseExtract, createRelayExtractionProvider, createRoleRuntime, extractForRuntime } from "./model.js";
export { proposeSitting } from "./propose.js";
export { DEFAULT_MAX_SITTINGS_PER_RUN, DREAM_PROPOSER_ID, REPORT_SCHEMA_VERSION, defaultDreamDir, runDream } from "./run.js";
