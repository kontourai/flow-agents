/**
 * neo4j knowledge-store provider (opt-in personal default; file providers remain
 * the portfolio default — issue #327).
 *
 * Implements the #317 read + proposals-only interface over Neo4j Community. The
 * graph is a MATERIALIZED VIEW synced from the file/work-item providers (see
 * sync.js) — the file stores stay the source of truth, and the write side is
 * proposals-only so the graph never becomes an authority that bypasses the
 * human-curated stores.
 *
 * Query/health verbs run Cypher-backed when a live Neo4j is present (the five
 * canonical spike queries) and fall back to the portable JS spelling
 * (graph-queries.js) otherwise — same answers, two backends (AC3/AC4).
 *
 * The driver is INJECTABLE: unit tests pass a fake driver (fake-driver.js) so
 * the read side is conformance-tested with no Docker; live integration passes a
 * real neo4j-driver. Absence of either degrades to file providers (AC4).
 *
 * @module providers/neo4j
 */

import { node as buildNode, edge as buildEdge, proposal, provenance } from "../lib/model.js";
import { detectDuplicates, checkDependencyLinkIntegrity } from "../health/index.js";
import {
  READ_NODES_CYPHER,
  READ_EDGES_CYPHER,
  CANONICAL_CYPHER,
  renderBounds,
  propsToNode,
  propsToEdge,
} from "./cypher.js";
import * as jsq from "./graph-queries.js";

const PROVIDER_ID = "neo4j";

/** Coerce a neo4j-driver Integer (or number) to a JS number. */
function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v.toNumber === "function") return v.toNumber();
  return Number(v);
}

export class Neo4jProvider {
  /**
   * @param {object} options
   * @param {object} [options.driver]       neo4j driver or injected fake
   * @param {string} [options.database]
   * @param {{nodes,edges}} [options.sourceGraph] read directly from memory (degraded/test)
   * @param {string} [options.agent]
   */
  constructor({ driver, database, sourceGraph, agent } = {}) {
    if (!driver && !sourceGraph) {
      throw new Error("Neo4jProvider requires { driver } or { sourceGraph }");
    }
    this.driver = driver;
    this.database = database;
    this.sourceGraph = sourceGraph;
    this.agent = agent;
    this.id = PROVIDER_ID;
    // Live Cypher analytics only when a real driver advertises support; the fake
    // driver and the in-memory path use the portable JS backend.
    this._cypherAnalytics = Boolean(driver && driver.supportsCypherAnalytics);
  }

  capabilities() {
    return {
      id: PROVIDER_ID,
      node_types: ["issue", "decision", "note", "session", "person"],
      edge_types: ["blocks", "evidence-of", "supersedes", "merged-into", "mentions", "relates"],
      writable: false,
      write_mode: "proposals-only",
      proposal_targets: ["create-node", "add-edge"],
      source_of_truth: "file providers (vault, git-repo, work-item); the graph is a synced materialized view",
    };
  }

  _session() {
    return this.driver.session(this.database ? { database: this.database } : undefined);
  }

  async _run(cypher, params) {
    const session = this._session();
    try {
      return await session.run(cypher, params);
    } finally {
      await session.close();
    }
  }


  // The graph is a materialized VIEW: neo4j produced this read, but the element
  // originated in a curated store. Stamp provider=neo4j (what the contract's
  // provenance.provider means — "the provider that produced the element") while
  // preserving the origin store in source + locator, so every fact stays
  // traceable back to where it came from.
  _viewProvenance(orig = {}) {
    const originProvider = orig.provider && orig.provider !== PROVIDER_ID ? orig.provider : null;
    const locatorBits = [];
    if (originProvider) locatorBits.push(`origin:${originProvider}`);
    if (orig.locator) locatorBits.push(orig.locator);
    const prov = {
      provider: PROVIDER_ID,
      source: orig.source || "neo4j://materialized-view",
      retrieved_at: orig.retrieved_at || new Date().toISOString(),
    };
    if (locatorBits.length) prov.locator = locatorBits.join("#");
    if (this.agent) prov.agent = this.agent;
    return prov;
  }

  async readNodes(options = {}) {
    let nodes;
    if (this.sourceGraph && !this.driver) {
      nodes = (this.sourceGraph.nodes || []).map((n) => this._normalizeNode(n));
    } else {
      const res = await this._run(READ_NODES_CYPHER);
      nodes = res.records.map((r) => { const n = propsToNode(r.get("props")); n.provenance = this._viewProvenance(n.provenance); return n; });
    }
    if (options.type) return nodes.filter((n) => n.type === options.type);
    return nodes;
  }

  async readEdges() {
    if (this.sourceGraph && !this.driver) {
      return (this.sourceGraph.edges || []).map((e) => this._normalizeEdge(e));
    }
    const res = await this._run(READ_EDGES_CYPHER);
    return res.records.map((r) => { const e = propsToEdge(r.get("props")); e.provenance = this._viewProvenance(e.provenance); return e; });
  }

  // Normalise an in-memory node/edge through the model constructors so the
  // sourceGraph path emits the same schema-clean shape as the Cypher path.
  _normalizeNode(n) {
    return buildNode({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      attributes: n.attributes,
      provenance: this._viewProvenance(n.provenance || {}),
    });
  }

  _normalizeEdge(e) {
    return buildEdge({
      id: e.id,
      type: e.type,
      from: e.from,
      to: e.to,
      resolved: e.resolved,
      attributes: e.attributes,
      provenance: this._viewProvenance(e.provenance || {}),
    });
  }

  async queryByType(type) {
    return this.readNodes({ type });
  }

  async readGraph() {
    const [nodes, edges] = await Promise.all([this.readNodes(), this.readEdges()]);
    return { nodes, edges };
  }

  /**
   * Proposals-only write. The graph is a view: an intended change is rendered as
   * the Cypher an enactor WOULD run, but proposeWrite never mutates the store,
   * and the rationale is explicit that the real change must land in the source
   * store and reach the graph via `sync` — the graph is never an authority that
   * bypasses the curated stores.
   */
  async proposeWrite(intent = {}) {
    const kind = intent.kind === "add-edge" ? "add-edge" : "create-node";
    let rendered;
    let payload;
    if (kind === "add-edge") {
      const { type = "relates", from, to } = intent;
      if (!from || !to) throw new Error("neo4j proposeWrite add-edge requires intent.from and intent.to");
      const rel = String(type).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
      payload = { type, from, to };
      rendered = `MATCH (a {id:$from}),(b {id:$to}) MERGE (a)-[:${rel}]->(b)  // proposal — enact upstream, then \`sync\``;
    } else {
      const { type = "note", title } = intent;
      if (!title) throw new Error("neo4j proposeWrite create-node requires intent.title");
      const label = String(type).charAt(0).toUpperCase() + String(type).slice(1);
      payload = { type, title, body: intent.body || "" };
      rendered = `MERGE (n:${label} {id:$id}) SET n.title=$title  // proposal — enact upstream, then \`sync\``;
    }
    return proposal({
      provider: PROVIDER_ID,
      kind,
      target: { store: "neo4j (materialized view)" },
      payload,
      rendered,
      rationale:
        "Proposed graph change. The graph is a materialized VIEW: enact the change in the source store (vault / git-repo / work-item) and re-run `sync` — never write the graph directly as an authority.",
      provenance: provenance({ provider: PROVIDER_ID, source: "neo4j://materialized-view", agent: this.agent }),
    });
  }

  // --- canonical query / health verbs -------------------------------------

  async transitiveBlockers(rootId, opts = {}) {
    const maxDepth = opts.maxDepth || 10;
    if (this._cypherAnalytics) {
      const res = await this._run(renderBounds(CANONICAL_CYPHER.transitiveBlockers, maxDepth), { rootId });
      return res.records.map((r) => ({ id: r.get("id"), state: r.get("state") ?? null }));
    }
    return jsq.transitiveBlockers(await this.readGraph(), { rootId, maxDepth });
  }

  async contradictionCandidates(opts = {}) {
    if (this._cypherAnalytics) {
      const res = await this._run(CANONICAL_CYPHER.contradictionCandidates, {});
      return res.records.map((r) => ({
        a_id: r.get("a_id"),
        b_id: r.get("b_id"),
        a_status: r.get("a_status"),
        b_status: r.get("b_status"),
        title: r.get("title"),
      }));
    }
    return jsq.contradictionCandidates(await this.readGraph(), opts);
  }

  async orphans(opts = {}) {
    if (this._cypherAnalytics) {
      const res = await this._run(CANONICAL_CYPHER.orphans, {});
      return res.records.map((r) => ({ id: r.get("id"), label: r.get("label") }));
    }
    return jsq.orphans(await this.readGraph(), opts);
  }

  async duplicateCandidates(opts = {}) {
    const threshold = typeof opts.threshold === "number" ? opts.threshold : 0.7;
    if (this._cypherAnalytics) {
      const res = await this._run(CANONICAL_CYPHER.duplicateStemmed, { threshold });
      return res.records.map((r) => ({
        a_id: r.get("a_id"),
        b_id: r.get("b_id"),
        a_title: r.get("a_title"),
        b_title: r.get("b_title"),
      }));
    }
    return jsq.duplicateCandidates(await this.readGraph(), { ...opts, threshold });
  }

  async shortestPath(fromId, toId, opts = {}) {
    const maxDepth = opts.maxDepth || 8;
    if (this._cypherAnalytics) {
      const res = await this._run(renderBounds(CANONICAL_CYPHER.shortestPath, maxDepth), { fromId, toId });
      const rec = res.records[0];
      if (!rec) return null;
      return { path: rec.get("path"), length: num(rec.get("length")) };
    }
    return jsq.shortestPath(await this.readGraph(), { fromId, toId, maxDepth });
  }

  /** Provider-agnostic duplicate-detection health report (schema-valid). */
  async detectDuplicates(opts = {}) {
    return detectDuplicates(await this.readGraph(), { provider: PROVIDER_ID, ...opts });
  }

  /** Provider-agnostic dependency-link-integrity health report (schema-valid). */
  async checkDependencyLinkIntegrity(opts = {}) {
    return checkDependencyLinkIntegrity(await this.readGraph(), { provider: PROVIDER_ID, ...opts });
  }
}

export default Neo4jProvider;
export { syncToNeo4j, materializeGraph, planSync, computeDigest } from "./sync.js";
export {
  resolveNeo4jConfig,
  createDriver,
  isReachable,
  selectKnowledgeProvider,
} from "./connection.js";
export { CANONICAL_QUERIES } from "./graph-queries.js";
export { CANONICAL_CYPHER, DIALECT_NOTES } from "./cypher.js";
