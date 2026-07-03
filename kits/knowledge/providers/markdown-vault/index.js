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
  }

  capabilities() {
    return {
      id: PROVIDER_ID,
      node_types: ["note", "person"],
      edge_types: ["supersedes", "evidence-of", "mentions", "relates"],
      writable: false,
      write_mode: "proposals-only",
      proposal_targets: ["create-node"],
      source_of_truth: "human-curated markdown vault",
    };
  }

  async _allRecords() {
    const out = [];
    for (const t of ALL_RECORD_TYPES) {
      const recs = await this.store.listByType(t, { includeRetired: true });
      for (const r of recs) out.push(r);
    }
    return out;
  }

  async readNodes(options = {}) {
    const records = await this._allRecords();
    const nodes = records.map((r) => {
      const attributes = { record_type: r.type };
      if (r.category) attributes.category = r.category;
      if (r.status) attributes.status = r.status;
      if (Array.isArray(r.tags) && r.tags.length) attributes.tags = r.tags;
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
    const edges = [];
    for (const r of records) {
      const links = await this.store.getLinks(r.id);
      for (const l of links.forward || []) {
        edges.push(
          edge({
            id: `${r.id}--${l.kind}--${l.target_id}`,
            type: edgeTypeFor(l.kind),
            from: r.id,
            to: l.target_id,
            attributes: { vault_link_kind: l.kind },
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
    const [nodes, edges] = await Promise.all([this.readNodes(), this.readEdges()]);
    return { nodes, edges };
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
