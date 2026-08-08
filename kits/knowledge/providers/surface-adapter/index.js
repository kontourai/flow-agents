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
 * Map Knowledge record status → Surface claim status.
 *
 * Deliberately narrow: `retired` records are `superseded`; everything else
 * is `proposed` (producer-asserted, not verified). Knowledge Kit records
 * are never independently verified by this adapter, so no record status
 * ever earns the `verified` label here — that would fabricate trust. Staleness
 * (expiry) is NOT computed locally either: `expiresAt`/`ttlSeconds` are passed
 * through on the claim so Surface derives freshness itself.
 */
function statusFor(recordStatus) {
  if (recordStatus === "retired") return "superseded";
  return "proposed";
}

/**
 * Build a compact, schema-agnostic summary of a record's mutation_log for
 * carrying as claim metadata. Only the fields common to every mutation-log
 * entry shape (see DefaultKnowledgeStore) are surfaced — op/at/agent — so
 * this never depends on op-specific evidence shapes.
 */
function compactMutationLog(mutationLog) {
  return mutationLog.map((entry) => ({
    op: entry.op,
    at: entry.at,
    agent: entry.agent,
    ...(entry.note ? { note: entry.note } : {}),
  }));
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
    ? { readGraph: () => store.readGraph() }
    : new MarkdownVaultProvider({ storeRoot, agent });

  const now = new Date();
  const nowIso = now.toISOString();

  const { nodes, edges } = await provider.readGraph();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

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

  // nodeId -> claimId, populated as claims are emitted below. Used both to
  // replace O(n^2) node lookups and to skip identity links whose endpoints
  // never received a claim.
  const claimIdByNodeId = new Map();

  // Nodes → Claims
  for (const node of filteredNodes) {
    const {
      record_type,
      category: cat,
      status,
      expires_at,
      ttl_seconds,
      mutation_log,
      created_at,
      updated_at,
    } = node.attributes;

    const claimId = `knowledge:${record_type}.${cat || "uncategorized"}#${node.id}`;
    const claimStatus = statusFor(status);
    claimIdByNodeId.set(node.id, claimId);

    const createdAt = created_at || node.provenance?.retrieved_at || nowIso;
    const updatedAt = updated_at || node.provenance?.retrieved_at || nowIso;

    const metadata = {
      knowledgeRecordType: record_type,
      knowledgeCategory: cat,
      knowledgeStatus: status,
    };
    if (Array.isArray(mutation_log) && mutation_log.length) {
      metadata.knowledgeMutationLog = compactMutationLog(mutation_log);
    }

    builder.addClaim({
      id: claimId,
      subjectType: "knowledge",
      subjectId: node.id,
      facet: `knowledge.${record_type}`,
      claimType: claimTypeFor(record_type),
      fieldOrBehavior: "content",
      value: node.body || node.title,
      status: claimStatus,
      createdAt,
      updatedAt,
      ...(expires_at ? { expiresAt: expires_at } : {}),
      ...(ttl_seconds !== undefined && ttl_seconds !== null ? { ttlSeconds: ttl_seconds } : {}),
      impactLevel: "medium",
      metadata,
    });

    // Evidence: source links (raw → compiled, etc.)
    const sourceEdges = filteredEdges.filter((e) => e.to === node.id && e.type === "evidence-of");
    for (const edge of sourceEdges) {
      const sourceNode = nodeById.get(edge.from);
      if (!sourceNode) continue;

      const evidenceId = `${claimId}.evidence.${sourceNode.id}`;
      builder.addEvidence({
        id: evidenceId,
        evidenceType: "document_citation",
        method: "extraction",
        sourceRef: sourceNode.provenance?.source || `knowledge:${sourceNode.id}`,
        sourceLocator: sourceNode.provenance?.locator || sourceNode.attributes.record_type,
        excerptOrSummary: sourceNode.body?.slice(0, 500) || sourceNode.title,
        observedAt: sourceNode.provenance?.retrieved_at || nowIso,
        collectedBy: "knowledge-kit",
      }).linkTo(claimId);
    }

    // Policy: supersedes edges
    const supersedesEdges = filteredEdges.filter((e) => e.from === node.id && e.type === "supersedes");
    for (const edge of supersedesEdges) {
      const targetNode = nodeById.get(edge.to);
      if (!targetNode) continue;

      const policyId = `policy:supersedes.${node.id}.${targetNode.id}`;
      builder.addPolicy({
        id: policyId,
        claimType: claimTypeFor(record_type),
        requiredEvidence: ["document_citation"],
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
  }

  // Edges → Identity links (for cross-record references).
  //
  // Surface's identityLink schema carries `subjects: [{subjectType,
  // subjectId}, ...]` (co-reference between claim subjects) — it has no
  // `from`/`to`/`confidence` fields. Every claim's subjectType is
  // "knowledge" and subjectId is the node id, so subjects mirror that
  // exactly. Links are only emitted between endpoints that both received a
  // claim (via claimIdByNodeId); `reason` records the originating edge type
  // without overclaiming a specific Surface `relation` (none of the closed
  // relation enum — equivalent/subsumes/converts — accurately describes a
  // knowledge-graph "relates"/"mentions" edge, so `relation` is left unset
  // rather than misrepresented).
  for (const edge of filteredEdges) {
    if (edge.type === "relates" || edge.type === "mentions") {
      const fromClaimId = claimIdByNodeId.get(edge.from);
      const toClaimId = claimIdByNodeId.get(edge.to);
      if (!fromClaimId || !toClaimId) continue;

      builder.addIdentityLink({
        id: `identity:${edge.type}.${edge.from}.${edge.to}`,
        subjects: [
          { subjectType: "knowledge", subjectId: edge.from },
          { subjectType: "knowledge", subjectId: edge.to },
        ],
        reason: `knowledge graph "${edge.type}" edge (${fromClaimId} <-> ${toClaimId})`,
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
