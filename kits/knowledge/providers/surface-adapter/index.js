/**
 * Surface adapter for Knowledge Kit.
 *
 * Converts Knowledge Kit graph nodes/edges into a Surface TrustBundle
 * for trust exposition and verification. This is a READ-only adapter —
 * it never mutates the Knowledge store.
 *
 * @module providers/surface-adapter
 */

import { MarkdownVaultProvider } from "../markdown-vault/index.js";
import { TrustBundleBuilder } from "@kontourai/surface";

const PROVIDER_ID = "knowledge-surface";

/**
 * Map Knowledge record type → Surface claim type
 */
function claimTypeFor(recordType) {
  const map = {
    raw: "knowledge.raw",
    compiled: "knowledge.compiled",
    concept: "knowledge.concept",
    snapshot: "knowledge.snapshot",
    person: "knowledge.person",
  };
  return map[recordType] || "knowledge.record";
}

/**
 * Map Knowledge record status → Surface claim status (pre-fold)
 */
function statusFor(recordStatus, expiresAt, nowMs) {
  if (recordStatus === "retired") return "superseded";
  if (recordStatus === "implemented") return "verified";
  if (expiresAt) {
    const expiryMs = new Date(expiresAt).getTime();
    if (!isNaN(expiryMs) && nowMs > expiryMs) return "stale";
  }
  return "proposed";
}

/**
 * Build a TrustBundle from Knowledge Kit graph data.
 *
 * @param {Object} options
 * @param {string} [options.storeRoot] - Root of Knowledge store (for MarkdownVaultProvider)
 * @param {Object} [options.store] - Injected KnowledgeStoreAdapter instance
 * @param {string} [options.category] - Filter by category (dot-prefix match)
 * @param {string[]} [options.recordTypes] - Filter by record types
 * @param {boolean} [options.includeRetired=false] - Include retired records
 * @param {Object} [options.agent] - Agent identity for provenance
 * @returns {Promise<import("@kontourai/surface").TrustBundle>}
 */
export async function buildKnowledgeTrustBundle(options = {}) {
  const {
    storeRoot,
    store,
    category,
    recordTypes = ["raw", "compiled", "concept", "snapshot", "person"],
    includeRetired = false,
    agent,
  } = options;

  const provider = store
    ? { readNodes: async () => (await store.readGraph()).nodes, readEdges: async () => (await store.readGraph()).edges }
    : new MarkdownVaultProvider({ storeRoot, agent });

  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const { nodes, edges } = await provider.readGraph();

  // Filter nodes
  let filteredNodes = nodes;
  if (category) {
    const prefix = category.endsWith(".") ? category : `${category}.`;
    filteredNodes = nodes.filter((n) =>
      n.attributes.category === category || n.attributes.category?.startsWith(prefix)
    );
  }
  if (recordTypes.length) {
    const typeSet = new Set(recordTypes);
    filteredNodes = filteredNodes.filter((n) => typeSet.has(n.attributes.record_type));
  }
  if (!includeRetired) {
    filteredNodes = filteredNodes.filter((n) => n.attributes.status !== "retired");
  }

  const nodeIds = new Set(filteredNodes.map((n) => n.id));
  const filteredEdges = edges.filter(
    (e) => nodeIds.has(e.from) && nodeIds.has(e.to)
  );

  const builder = new TrustBundleBuilder({ source: "knowledge-kit" });

  // Nodes → Claims
  for (const node of filteredNodes) {
    const { record_type, category: cat, status, expires_at, ttl_seconds, tags, mutation_log } =
      node.attributes;

    const claimId = `knowledge:${record_type}.${cat || "uncategorized"}#${node.id}`;
    const claimStatus = statusFor(status, expires_at, nowMs);

    builder.addClaim({
      id: claimId,
      subjectType: "knowledge",
      subjectId: node.id,
      facet: `knowledge.${record_type}`,
      claimType: claimTypeFor(record_type),
      fieldOrBehavior: "content",
      value: node.body || node.title,
      createdAt: node.provenance?.retrievedAt || nowIso,
      updatedAt: node.provenance?.retrievedAt || nowIso,
      impactLevel: "medium",
      metadata: {
        knowledgeRecordType: record_type,
        knowledgeCategory: cat,
        knowledgeStatus: status,
        knowledgeExpiresAt: expires_at,
        knowledgeTtlSeconds: ttl_seconds,
      },
    });

    // Evidence: source links (raw → compiled, etc.)
    const sourceEdges = filteredEdges.filter((e) => e.to === node.id && e.type === "evidence-of");
    for (const edge of sourceEdges) {
      const sourceNode = nodes.find((n) => n.id === edge.from);
      if (!sourceNode) continue;

      const evidenceId = `${claimId}.evidence.${sourceNode.id}`;
      builder.addEvidence({
        id: evidenceId,
        evidenceType: "document",
        method: "extraction",
        sourceRef: sourceNode.provenance?.source || `knowledge:${sourceNode.id}`,
        sourceLocator: sourceNode.provenance?.locator || sourceNode.attributes.record_type,
        excerptOrSummary: sourceNode.body?.slice(0, 500) || sourceNode.title,
        observedAt: sourceNode.provenance?.retrievedAt || nowIso,
        collectedBy: "knowledge-kit",
      }).linkTo(claimId);
    }

    // Policy: supersedes edges
    const supersedesEdges = filteredEdges.filter((e) => e.from === node.id && e.type === "supersedes");
    for (const edge of supersedesEdges) {
      const targetNode = nodes.find((n) => n.id === edge.to);
      if (!targetNode) continue;

      const policyId = `policy:supersedes.${node.id}.${targetNode.id}`;
      builder.addPolicy({
        id: policyId,
        claimType: claimTypeFor(record_type),
        requiredEvidence: ["document"],
        requiredMethods: ["extraction"],
        requiresCorroboration: false,
        acceptanceCriteria: [`supersedes ${targetNode.id}`],
        reviewAuthority: "knowledge-kit",
        validityRule: { kind: "manual" },
        stalenessTriggers: ["record superseded"],
        conflictRules: [`${node.id} supersedes ${targetNode.id}`],
        impactLevel: "medium",
      });
    }

    // Events: mutation log
    if (Array.isArray(mutation_log)) {
      for (const log of mutation_log) {
        const eventId = `${claimId}.event.${log.at}`;
        builder.addEvent({
          id: eventId,
          claimId,
          type: "status-transition",
          status: log.to === "retired" ? "superseded" : "proposed",
          actor: log.authority || "knowledge-kit",
          method: "mutation",
          evidenceIds: [],
          createdAt: log.at,
          metadata: { from: log.from, to: log.to },
        });
      }
    }
  }

  // Edges → Identity links (for cross-record references)
  for (const edge of filteredEdges) {
    if (edge.type === "relates" || edge.type === "mentions") {
      builder.addIdentityLink({
        from: `knowledge:${nodes.find((n) => n.id === edge.from)?.attributes?.record_type || "record"}.${edge.from}`,
        to: `knowledge:${nodes.find((n) => n.id === edge.to)?.attributes?.record_type || "record"}.${edge.to}`,
        relation: edge.type,
        confidence: 0.8,
      });
    }
  }

  return builder.build();
}

/**
 * Surface adapter registration (call to register with Surface).
 * Usage:
 *   import { registerAdapter } from "@kontourai/surface";
 *   import { surfaceAdapter } from "@kontourai/flow-agents/kits/knowledge/providers/surface-adapter";
 *   registerAdapter(surfaceAdapter);
 */
export const surfaceAdapter = {
  name: "knowledge-kit",
  defaultExample: null,
  adapt: async (options) => buildKnowledgeTrustBundle(options),
};

export default surfaceAdapter;