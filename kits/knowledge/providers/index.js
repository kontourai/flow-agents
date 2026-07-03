/**
 * Knowledge Kit store providers — public entry point.
 *
 * Typed graph model (nodes / edges / provenance) with pluggable providers behind
 * one read + proposals-only write interface, plus provider-agnostic health verbs.
 * See context/contracts/knowledge-store-contract.md.
 *
 * @module providers
 */

export { MarkdownVaultProvider } from "./markdown-vault/index.js";
export { GitRepoProvider } from "./git-repo/index.js";
export { WorkItemProvider, parseWorkItemMetadata } from "./work-item/index.js";
export { detectDuplicates, checkDependencyLinkIntegrity, HEALTH_VERBS } from "./health/index.js";
export {
  EDGE_TYPES,
  CORE_NODE_TYPES,
  loadSchemas,
  node,
  edge,
  proposal,
  provenance,
} from "./lib/model.js";
export { validate, assertValid } from "./lib/schema-validate.js";
