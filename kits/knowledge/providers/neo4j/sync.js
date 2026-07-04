/**
 * Sync / materialize: import the file/work-item providers into Neo4j.
 *
 * The file stores remain the SOURCE OF TRUTH; the graph is a queryable
 * materialized view. Sync reuses the #317 providers as READERS (no forked
 * extractors) and MERGEs their combined graph into Neo4j with MERGE semantics,
 * so a re-sync of unchanged data reports zero writes (AC1). A snapshot digest +
 * timestamp is recorded on the graph so the second run can short-circuit and so
 * the graph is point-in-time attributable.
 *
 * Marker tolerance (spike finding 3: 3/19 metadata markers failed JSON.parse in
 * the wild): a provider that throws while reading MUST NOT kill the whole sync.
 * Each provider is read behind a guard that falls back to an empty contribution
 * and records the error; the work-item provider already falls back from a
 * malformed metadata marker to prose refs, and this guard covers the rest.
 *
 * Pure planning (planSync/computeDigest) is separated from IO (syncToNeo4j) so
 * idempotency is unit-testable with no driver and no Docker.
 *
 * @module providers/neo4j/sync
 */

import { createHash } from "node:crypto";
import {
  typeToLabel,
  edgeTypeToRel,
  nodeToProps,
  edgeToProps,
  SNAPSHOT_LABEL,
  SNAPSHOT_ID,
  READ_SNAPSHOT_CYPHER,
} from "./cypher.js";

/** Deterministic JSON (sorted keys) for hashing. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The graph is a materialized view keyed on CONTENT, not on when it was read.
 * Provenance carries volatile fields (retrieved_at, agent) that change every
 * read — including them would defeat idempotency (a re-sync of unchanged stores
 * would rewrite every element). Strip them for identity; the snapshot's
 * synced_at records the point-in-time separately.
 */
function contentIdentity(el) {
  const clone = JSON.parse(JSON.stringify(el));
  if (clone.provenance) {
    delete clone.provenance.retrieved_at;
    delete clone.provenance.agent;
  }
  return clone;
}

/** Content hash of a single node/edge (drives the idempotent hash-guarded SET). */
export function hashElement(el) {
  return createHash("sha256").update(canonical(contentIdentity(el))).digest("hex").slice(0, 16);
}

/** Digest of the whole materialized graph (drives the zero-write short-circuit). */
export function computeDigest(graph) {
  const nodes = [...(graph.nodes || [])].map(contentIdentity).sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...(graph.edges || [])].map(contentIdentity).sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(canonical({ nodes, edges })).digest("hex");
}

/** Read one provider's graph behind a guard; never let one provider kill sync. */
async function safeReadGraph(provider, errors) {
  try {
    const g = await provider.readGraph();
    return { nodes: g.nodes || [], edges: g.edges || [] };
  } catch (err) {
    errors.push({ provider: provider?.id || provider?.constructor?.name || "unknown", error: String(err && err.message || err) });
    return { nodes: [], edges: [] };
  }
}

/**
 * Materialize the combined graph from the provider readers. Dedupes nodes and
 * edges by id (last write wins on id collision across providers).
 * @param {object[]} providers  #317 provider instances (vault, git-repo, work-item, …)
 * @returns {Promise<{ nodes:object[], edges:object[], errors:object[] }>}
 */
export async function materializeGraph(providers) {
  const errors = [];
  const nodeById = new Map();
  const edgeById = new Map();
  for (const provider of providers) {
    const { nodes, edges } = await safeReadGraph(provider, errors);
    for (const n of nodes) nodeById.set(n.id, n);
    for (const e of edges) edgeById.set(e.id, e);
  }
  return { nodes: [...nodeById.values()], edges: [...edgeById.values()], errors };
}

/**
 * Pure sync plan. Given the materialized graph and the prior snapshot digest,
 * decide whether anything changed and produce the parameterized MERGE
 * statements. When the digest is unchanged, the plan is a no-op (AC1: second run
 * reports zero writes) unless `force` is set.
 *
 * @param {{nodes:object[],edges:object[]}} graph
 * @param {string|null} priorDigest
 * @param {object} [options]
 * @param {boolean} [options.force=false] emit statements even when unchanged
 * @returns {{ digest:string, unchanged:boolean, statements:{cypher:string,params:object}[] }}
 */
export function planSync(graph, priorDigest, options = {}) {
  const digest = computeDigest(graph);
  const unchanged = digest === priorDigest;
  if (unchanged && !options.force) {
    return { digest, unchanged, statements: [] };
  }

  const statements = [];

  // Nodes grouped by contract type -> one MERGE per Neo4j label. Hash-guarded
  // SET so an unchanged node produces zero propertiesSet on re-run.
  const nodesByLabel = new Map();
  for (const n of graph.nodes || []) {
    const label = typeToLabel(n.type);
    if (!nodesByLabel.has(label)) nodesByLabel.set(label, []);
    nodesByLabel.get(label).push(nodeToProps(n, hashElement(n)));
  }
  for (const [label, rows] of nodesByLabel) {
    statements.push({
      cypher: `UNWIND $rows AS r MERGE (n:${label} {id:r.id}) WITH n, r WHERE coalesce(n._kg_hash,'') <> r._kg_hash SET n += r`,
      params: { rows },
    });
  }

  // Edges grouped by rel type. Endpoints matched by id regardless of label
  // (spike: polyglot property bags "just work"); edges to a not-yet-synced node
  // are skipped by the MATCH (external/dangling refs stay out of the view).
  const edgesByRel = new Map();
  for (const e of graph.edges || []) {
    const rel = edgeTypeToRel(e.type);
    if (!edgesByRel.has(rel)) edgesByRel.set(rel, []);
    edgesByRel.get(rel).push(edgeToProps(e, hashElement(e)));
  }
  for (const [rel, rows] of edgesByRel) {
    statements.push({
      cypher: `UNWIND $rows AS r MATCH (a {id:r.from}) MATCH (b {id:r.to}) MERGE (a)-[x:${rel} {id:r.id}]->(b) WITH x, r WHERE coalesce(x._kg_hash,'') <> r._kg_hash SET x += r`,
      params: { rows },
    });
  }

  return { digest, unchanged, statements };
}

/** Read the prior snapshot digest from Neo4j (null if never synced). */
async function readPriorDigest(session) {
  const res = await session.run(READ_SNAPSHOT_CYPHER, { id: SNAPSHOT_ID });
  const rec = res.records && res.records[0];
  if (!rec) return null;
  const props = rec.get("props");
  return (props && props.digest) || null;
}

function sumWrites(counters) {
  const u = typeof counters.updates === "function" ? counters.updates() : counters;
  return (u.nodesCreated || 0) + (u.relationshipsCreated || 0) + (u.propertiesSet || 0);
}

/**
 * Materialize the providers and MERGE them into Neo4j idempotently.
 *
 * @param {object} options
 * @param {object} options.driver          neo4j driver (or the injected fake)
 * @param {string} [options.database]
 * @param {object[]} [options.providers]   #317 providers to read (or pass graph)
 * @param {{nodes,edges}} [options.graph]  a pre-materialized graph (skips readers)
 * @param {boolean} [options.force=false]  re-run MERGEs even if the digest matches
 * @returns {Promise<{ writes:number, unchanged:boolean, digest:string, nodes:number, edges:number, snapshot:object, errors:object[] }>}
 */
export async function syncToNeo4j(options = {}) {
  const { driver, database, force = false } = options;
  let errors = [];
  let graph = options.graph;
  if (!graph) {
    const mat = await materializeGraph(options.providers || []);
    graph = { nodes: mat.nodes, edges: mat.edges };
    errors = mat.errors;
  }

  const session = driver.session(database ? { database } : undefined);
  try {
    const priorDigest = await readPriorDigest(session);
    const plan = planSync(graph, priorDigest, { force });

    if (plan.unchanged && !force) {
      return {
        writes: 0,
        unchanged: true,
        digest: plan.digest,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        snapshot: { digest: plan.digest },
        errors,
      };
    }

    let writes = 0;
    for (const stmt of plan.statements) {
      const res = await session.run(stmt.cypher, stmt.params);
      writes += sumWrites(res.summary.counters);
    }

    const syncedAt = new Date().toISOString();
    const snapRes = await session.run(
      `MERGE (s:${SNAPSHOT_LABEL} {id:$id}) WITH s, $digest AS d WHERE coalesce(s.digest,'') <> d SET s.digest = d, s.synced_at = $syncedAt, s.node_count = $nc, s.edge_count = $ec`,
      { id: SNAPSHOT_ID, digest: plan.digest, syncedAt, nc: graph.nodes.length, ec: graph.edges.length },
    );
    writes += sumWrites(snapRes.summary.counters);

    return {
      writes,
      unchanged: plan.unchanged,
      digest: plan.digest,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      snapshot: { digest: plan.digest, synced_at: syncedAt },
      errors,
    };
  } finally {
    await session.close();
  }
}
