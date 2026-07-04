/**
 * In-memory injected driver mock for the neo4j provider.
 *
 * Implements exactly the fixed statements the provider and sync command issue
 * (node/edge/snapshot reads; hash-guarded MERGE writes) over an in-process
 * property-bag graph, returning honest neo4j-driver-shaped results and update
 * counters. This is the "injected driver mock" the CI proof relies on (issue
 * #327): the read side conforms and the sync idempotency counters (writes>0 then
 * writes=0) are provable with no Docker present.
 *
 * It deliberately does NOT interpret the analytic canonical queries — it reports
 * supportsCypherAnalytics=false, so the provider uses the portable JS backend
 * for those. The live driver interprets them; integration.test.js asserts parity.
 *
 * @module providers/neo4j/fake-driver
 */

import {
  READ_NODES_CYPHER,
  READ_EDGES_CYPHER,
  READ_SNAPSHOT_CYPHER,
} from "./cypher.js";

function record(map) {
  return { get: (key) => map[key] };
}

function counters(updates) {
  return { summary: { counters: { updates: () => updates } } };
}

export function makeFakeDriver() {
  const nodes = new Map(); // id -> props (incl. _kg_label, _kg_hash)
  const rels = new Map(); // id -> props (incl. _kg_rel, _kg_hash)
  let snapshot = null;

  function run(cypher, params = {}) {
    // --- reads ---
    if (cypher === READ_NODES_CYPHER) {
      return Promise.resolve({ records: [...nodes.values()].map((p) => record({ props: strip(p) })) });
    }
    if (cypher === READ_EDGES_CYPHER) {
      return Promise.resolve({ records: [...rels.values()].map((p) => record({ props: strip(p) })) });
    }
    if (cypher === READ_SNAPSHOT_CYPHER) {
      return Promise.resolve({ records: snapshot ? [record({ props: snapshot })] : [] });
    }

    // --- node MERGE ---
    let m = cypher.match(/MERGE \(n:([A-Za-z0-9_]+) \{id:r\.id\}\)/);
    if (m) {
      let nodesCreated = 0;
      let propertiesSet = 0;
      for (const r of params.rows || []) {
        const existing = nodes.get(r.id);
        if (!existing) {
          nodes.set(r.id, { ...r, _kg_label: m[1] });
          nodesCreated++;
          propertiesSet += Object.keys(r).length;
        } else if (existing._kg_hash !== r._kg_hash) {
          nodes.set(r.id, { ...existing, ...r, _kg_label: m[1] });
          propertiesSet += Object.keys(r).length;
        }
      }
      return Promise.resolve(counters({ nodesCreated, relationshipsCreated: 0, propertiesSet }));
    }

    // --- edge MERGE ---
    m = cypher.match(/MERGE \(a\)-\[x:([A-Za-z0-9_]+) \{id:r\.id\}\]->\(b\)/);
    if (m) {
      let relationshipsCreated = 0;
      let propertiesSet = 0;
      for (const r of params.rows || []) {
        if (!nodes.has(r.from) || !nodes.has(r.to)) continue; // MATCH endpoints failed
        const existing = rels.get(r.id);
        if (!existing) {
          rels.set(r.id, { ...r, _kg_rel: m[1] });
          relationshipsCreated++;
          propertiesSet += Object.keys(r).length;
        } else if (existing._kg_hash !== r._kg_hash) {
          rels.set(r.id, { ...existing, ...r, _kg_rel: m[1] });
          propertiesSet += Object.keys(r).length;
        }
      }
      return Promise.resolve(counters({ nodesCreated: 0, relationshipsCreated, propertiesSet }));
    }

    // --- snapshot MERGE ---
    if (/MERGE \(s:_KGSnapshot \{id:\$id\}\)/.test(cypher)) {
      let nodesCreated = 0;
      let propertiesSet = 0;
      if (!snapshot) {
        snapshot = { id: params.id, digest: params.digest, synced_at: params.syncedAt, node_count: params.nc, edge_count: params.ec };
        nodesCreated = 1;
        propertiesSet = 4;
      } else if (snapshot.digest !== params.digest) {
        snapshot = { ...snapshot, digest: params.digest, synced_at: params.syncedAt, node_count: params.nc, edge_count: params.ec };
        propertiesSet = 4;
      }
      return Promise.resolve(counters({ nodesCreated, relationshipsCreated: 0, propertiesSet }));
    }

    throw new Error(`fake-driver: unhandled statement:\n${cypher}`);
  }

  function strip(p) {
    // Return only the stored Neo4j properties (drop the fake's bookkeeping keys).
    const { _kg_label, _kg_rel, ...rest } = p;
    return rest;
  }

  const session = () => ({ run, close: () => Promise.resolve() });
  return {
    supportsCypherAnalytics: false,
    __fake: true,
    session,
    verifyConnectivity: () => Promise.resolve(true),
    close: () => Promise.resolve(),
    _state: { nodes, rels, get snapshot() { return snapshot; } },
  };
}

export default makeFakeDriver;
