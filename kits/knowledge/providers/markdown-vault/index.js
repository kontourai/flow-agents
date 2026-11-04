/**
 * markdown-vault knowledge-store provider.
 *
 * Adapts the existing Knowledge Kit store (the markdown-vault behaviour:
 * markdown files + YAML frontmatter + [[wikilinks]] + a JSON graph index) to
 * the knowledge-store PROVIDER contract (typed nodes/edges/provenance). It is a
 * thin READ + PROPOSE wrapper over an existing store adapter instance — it does
 * NOT reimplement or modify the adapter, so existing Knowledge Kit skills are
 * unaffected. Wikilinks/frontmatter remain the native form; proposeWrite renders
 * a new note in exactly that form for a human to file.
 *
 * @module providers/markdown-vault
 */

import { node, edge, proposal, provenance } from "../lib/model.js";
import DefaultKnowledgeStore from "../../adapters/default-store/index.js";

const PROVIDER_ID = "markdown-vault";

/** Vault record type -> graph node type. Extensible: unknowns fall back to note. */
function nodeTypeFor(recordType) {
  return recordType === "person" ? "person" : "note";
}

/** Vault link kind -> closed graph edge type. */
function edgeTypeFor(linkKind) {
  switch (linkKind) {
    case "blocks":
      return "blocks";
    case "merged-into":
      return "merged-into";
    case "supersedes":
    case "refines":
      return "supersedes";
    case "source":
    case "example":
      return "evidence-of";
    case "appears-in":
    case "person":
      return "mentions";
    case "proposes":
    case "related":
    default:
      return "relates";
  }
}

const ALL_RECORD_TYPES = ["raw", "compiled", "concept", "snapshot", "person"];

export class MarkdownVaultProvider {
  constructor({ store, storeRoot, agent } = {}) {
    if (!store && !storeRoot) {
      throw new Error("MarkdownVaultProvider requires { store } or { storeRoot }");
    }
    this.store = store || new DefaultKnowledgeStore({ storeRoot });
    this.storeRoot = storeRoot || "(injected store)";
    this.agent = agent;
    this.id = PROVIDER_ID;
    // Memoized record list, keyed on the store's cache version. Populated by
    // _allRecords() below — covers readNodes/readEdges/readGraph/queryByType
    // (they all funnel through _allRecords()).
    this._recordsMemo = null; // { version, records } | null
    this._inFlightFetch = null; // { version, promise } or null
  }

  capabilities() {
    return {
      id: PROVIDER_ID,
      node_types: ["note", "person"],
      edge_types: ["supersedes", "merged-into", "blocks", "evidence-of", "mentions", "relates"],
      writable: false,
      write_mode: "proposals-only",
      proposal_targets: ["create-node"],
      source_of_truth: "human-curated markdown vault",
    };
  }

  async _allRecords() {
    const currentVersion = this.store.getCacheVersion?.();
    if (
      currentVersion !== undefined &&
      this._recordsMemo &&
      this._recordsMemo.version === currentVersion
    ) {
      return this._recordsMemo.records;
    }

    // Unversioned stores cannot prove an in-flight read predates no mutation.
    // In particular, a read after purge must not join a pre-purge fetch.
    if (currentVersion === undefined) return this._fetchAllRecords(undefined);

    // Only share a fetch from the same observed version. A late completion
    // must not clear a newer flight.
    if (this._inFlightFetch?.version === currentVersion) return this._inFlightFetch.promise;
    const flight = { version: currentVersion, promise: null };
    flight.promise = this._fetchAllRecords(currentVersion).finally(() => {
      if (this._inFlightFetch === flight) this._inFlightFetch = null;
    });
    this._inFlightFetch = flight;
    return flight.promise;
  }

  async _fetchAllRecords(currentVersion) {
    const out = [];
    for (const t of ALL_RECORD_TYPES) {
      const recs = await this.store.listByType(t, { includeRetired: true });
      for (const r of recs) out.push(r);
    }

    // A bounded Corpus vault tombstone can omit an oversized record type. It
    // will not appear in any of the typed listings, so include purged-category
    // history as well without duplicating ordinary tombstones.
    if (typeof this.store.listByCategory === "function") {
      const seen = new Set(out.map((record) => record.id));
      const stones = await this.store.listByCategory("purged", { includeRetired: true, includeHistory: true });
      for (const record of stones) {
        if (record.status === "purged" && !seen.has(record.id)) {
          out.push(record);
          seen.add(record.id);
        }
      }
    }

    // No version support on the injected store -> never cache (always
    // refetch), so a store with no `getCacheVersion()` stays correct without
    // opting in to memoization.
    this._recordsMemo = currentVersion !== undefined ? { version: currentVersion, records: out } : null;
    return out;
  }

  async readNodes(options = {}) {
    const records = await this._allRecords();
    return this._nodesFromRecords(records, options);
  }

  _nodesFromRecords(records, options = {}) {
    const nodes = records.map((r) => {
      const attributes = { record_type: r.type };
      if (r.provenance) attributes.record_provenance = r.provenance;
      if (r.category) attributes.category = r.category;
      if (r.status) attributes.status = r.status;
      if (Array.isArray(r.tags) && r.tags.length) attributes.tags = r.tags;
      // Freshness + history + timestamps, when the record carries them
      // (issue #341 fields; consumed by the surface-adapter for claim
      // expiresAt/ttlSeconds/metadata/createdAt/updatedAt).
      if (r.expires_at) attributes.expires_at = r.expires_at;
      if (r.ttl_seconds !== undefined && r.ttl_seconds !== null) attributes.ttl_seconds = r.ttl_seconds;
      if (Array.isArray(r.mutation_log) && r.mutation_log.length) attributes.mutation_log = r.mutation_log;
      if (r.created_at) attributes.created_at = r.created_at;
      if (r.updated_at) attributes.updated_at = r.updated_at;
      return node({
        id: r.id,
        type: nodeTypeFor(r.type),
        title: r.title,
        body: typeof r.body === "string" ? r.body : "",
        attributes,
        provenance: provenance({
          provider: PROVIDER_ID,
          source: `${this.storeRoot}#${r.id}`,
          locator: r.type,
          agent: this.agent,
        }),
      });
    });
    if (options.type) return nodes.filter((n) => n.type === options.type);
    return nodes;
  }

  async readEdges() {
    const records = await this._allRecords();
    return this._edgesFromRecords(records);
  }

  async _edgesFromRecords(records) {
    const edges = [];
    for (const r of records) {
      const links = await this.store.getLinks(r.id);
      for (const l of links.forward || []) {
        const attributes = { vault_link_kind: l.kind };
        if (l.label !== undefined) attributes.vault_link_label = l.label;
        edges.push(
          edge({
            id: `${r.id}--${l.kind}--${l.target_id}`,
            type: edgeTypeFor(l.kind),
            from: r.id,
            to: l.target_id,
            attributes,
            provenance: provenance({
              provider: PROVIDER_ID,
              source: `${this.storeRoot}#${r.id}`,
              locator: `links.${l.kind}`,
              agent: this.agent,
            }),
          }),
        );
      }
    }
    return edges;
  }

  async queryByType(type) {
    return this.readNodes({ type });
  }

  async readGraph() {
    // Share one record set within this call, without sharing an unversioned
    // in-flight fetch with a later caller across a mutation.
    const records = await this._allRecords();
    return { nodes: this._nodesFromRecords(records), edges: await this._edgesFromRecords(records) };
  }

  /**
   * Propose a new vault note. Renders the native markdown-vault form
   * (frontmatter + [[wikilinks]]) WITHOUT touching the store — proposals only.
   */
  async proposeWrite(intent = {}) {
    const { title, body = "", category = "inbox", tags = [], links = [] } = intent;
    if (!title) throw new Error("markdown-vault proposeWrite requires intent.title");
    const wikilinks = links.map((l) => `[[${l.target_id}${l.label ? `|${l.label}` : ""}]]`).join(" ");
    const fm = [
      "---",
      "type: compiled",
      `title: ${title}`,
      `category: ${category}`,
      tags.length ? `tags: [${tags.join(", ")}]` : "tags: []",
      "---",
      "",
      body,
      wikilinks ? `\n${wikilinks}` : "",
    ].join("\n");
    return proposal({
      provider: PROVIDER_ID,
      kind: "create-node",
      target: { store_root: this.storeRoot, category },
      payload: { type: "note", title, body, category, tags, links },
      rendered: fm,
      rationale: intent.rationale || "Proposed vault note (file it via the Knowledge Kit ingest/compile flow).",
      provenance: provenance({ provider: PROVIDER_ID, source: this.storeRoot, agent: this.agent }),
    });
  }
}

export default MarkdownVaultProvider;
