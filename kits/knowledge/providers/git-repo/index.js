/**
 * git-repo knowledge-store provider.
 *
 * Reads durable git-tracked knowledge as a typed graph:
 *   - docs/decisions/<slug>.md  -> `decision` nodes; tombstones (superseded_by /
 *     merged_into / supersedes[]) -> supersedes / merged-into edges; evidence[]
 *     -> evidence-of edges (external, resolved:false).
 *   - CONTEXT.md glossary terms   -> `note` nodes (vocabulary).
 *   - docs/learnings/*.md         -> `note` nodes (learnings).
 *
 * Read side is authoritative here. The write side is proposals-only and renders
 * a decision-registry topic file shaped for the promote sub-flow (the same
 * frontmatter schemas/decision-record.schema.json validates) — the provider
 * never writes to disk.
 *
 * @module providers/git-repo
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { node, edge, proposal, provenance } from "../lib/model.js";
import { parseMarkdown } from "../../adapters/shared/codec.js";

const PROVIDER_ID = "git-repo";

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Derive a stable external node id for a decision evidence ref. */
function evidenceNodeId(kind, ref) {
  const tail = String(ref).replace(/^https?:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\//, "");
  return `${kind}:${slugify(tail).slice(0, 60) || "ref"}`;
}

export class GitRepoProvider {
  constructor({ repoRoot, agent } = {}) {
    if (!repoRoot) throw new Error("GitRepoProvider requires { repoRoot }");
    this.repoRoot = path.resolve(repoRoot);
    this.agent = agent;
    this.id = PROVIDER_ID;
  }

  capabilities() {
    return {
      id: PROVIDER_ID,
      node_types: ["decision", "note"],
      edge_types: ["supersedes", "merged-into", "evidence-of"],
      writable: false,
      write_mode: "proposals-only",
      proposal_targets: ["decision-topic"],
      source_of_truth: "git-tracked docs (decision registry, CONTEXT.md, learnings)",
    };
  }

  _decisionsDir() {
    return path.join(this.repoRoot, "docs", "decisions");
  }

  _readDecisions() {
    const dir = this._decisionsDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "index.md")
      .map((f) => {
        const slug = f.replace(/\.md$/, "");
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        const { meta, body } = parseMarkdown(raw);
        return { slug, meta: meta || {}, body, rel: `docs/decisions/${f}` };
      });
  }

  _readVocabulary() {
    const file = path.join(this.repoRoot, "CONTEXT.md");
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    const terms = [];
    let inGlossary = false;
    let current = null;
    for (const line of lines) {
      if (/^##\s+Glossary\s*$/.test(line)) { inGlossary = true; continue; }
      if (/^##\s+/.test(line) && !/^##\s+Glossary/.test(line)) { inGlossary = false; }
      if (!inGlossary) continue;
      const h = line.match(/^###\s+(.+?)\s*$/);
      if (h) {
        if (current) terms.push(current);
        current = { term: h[1].trim(), body: "" };
      } else if (current && line.trim() && !line.startsWith("_Avoid_")) {
        if (!current.body) current.body = line.trim();
      }
    }
    if (current) terms.push(current);
    return terms;
  }

  _readLearnings() {
    const dir = path.join(this.repoRoot, "docs", "learnings");
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        const { meta, body } = parseMarkdown(raw);
        const title = (meta && meta.title) || f.replace(/\.md$/, "");
        return { file: f, title, body, rel: `docs/learnings/${f}` };
      });
  }

  async readNodes(options = {}) {
    const nodes = [];
    const now = new Date().toISOString();

    for (const d of this._readDecisions()) {
      const attributes = { registry_status: d.meta.status || "current" };
      if (d.meta.decided) attributes.decided = d.meta.decided;
      nodes.push(
        node({
          id: `decision:${d.slug}`,
          type: "decision",
          title: d.meta.subject || d.slug,
          body: d.body || "",
          attributes,
          provenance: provenance({ provider: PROVIDER_ID, source: d.rel, retrievedAt: now, agent: this.agent }),
        }),
      );
    }

    for (const v of this._readVocabulary()) {
      nodes.push(
        node({
          id: `vocab:${slugify(v.term)}`,
          type: "note",
          title: v.term,
          body: v.body || "",
          attributes: { kind: "vocabulary" },
          provenance: provenance({ provider: PROVIDER_ID, source: "CONTEXT.md", locator: `glossary#${v.term}`, retrievedAt: now, agent: this.agent }),
        }),
      );
    }

    for (const l of this._readLearnings()) {
      nodes.push(
        node({
          id: `learning:${slugify(l.file.replace(/\.md$/, ""))}`,
          type: "note",
          title: l.title,
          body: l.body || "",
          attributes: { kind: "learning" },
          provenance: provenance({ provider: PROVIDER_ID, source: l.rel, retrievedAt: now, agent: this.agent }),
        }),
      );
    }

    if (options.type) return nodes.filter((n) => n.type === options.type);
    return nodes;
  }

  async readEdges() {
    const edges = [];
    const now = new Date().toISOString();
    for (const d of this._readDecisions()) {
      const self = `decision:${d.slug}`;
      const prov = (loc) => provenance({ provider: PROVIDER_ID, source: d.rel, locator: loc, retrievedAt: now, agent: this.agent });

      // superseded_by: this subject moved to another slug -> that slug supersedes this
      if (d.meta.superseded_by) {
        edges.push(edge({ id: `${d.meta.superseded_by}--supersedes--${d.slug}`, type: "supersedes", from: `decision:${d.meta.superseded_by}`, to: self, provenance: prov("superseded_by") }));
      }
      // merged_into: this folded into another slug
      if (d.meta.merged_into) {
        edges.push(edge({ id: `${d.slug}--merged-into--${d.meta.merged_into}`, type: "merged-into", from: self, to: `decision:${d.meta.merged_into}`, provenance: prov("merged_into") }));
      }
      // supersedes[]: this file absorbed those slugs
      for (const absorbed of Array.isArray(d.meta.supersedes) ? d.meta.supersedes : []) {
        edges.push(edge({ id: `${d.slug}--supersedes--${absorbed}`, type: "supersedes", from: self, to: `decision:${absorbed}`, provenance: prov("supersedes") }));
      }
      // evidence[]: external provenance -> evidence-of (resolved:false, external ref)
      for (const ev of Array.isArray(d.meta.evidence) ? d.meta.evidence : []) {
        if (!ev || !ev.kind || !ev.ref) continue;
        edges.push(edge({ id: `${d.slug}--evidence-of--${evidenceNodeId(ev.kind, ev.ref)}`, type: "evidence-of", from: self, to: evidenceNodeId(ev.kind, ev.ref), resolved: false, attributes: { evidence_kind: ev.kind, ref: ev.ref }, provenance: prov("evidence") }));
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
   * Propose a decision-registry topic file. Renders frontmatter compatible with
   * schemas/decision-record.schema.json + the promote sub-flow. Never writes.
   */
  async proposeWrite(intent = {}) {
    const { subject, body = "", decided, evidence = [] } = intent;
    if (!subject) throw new Error("git-repo proposeWrite requires intent.subject");
    const slug = intent.slug || slugify(subject);
    const evLines = (evidence.length ? evidence : [{ kind: "doc", ref: "TODO: link durable provenance" }])
      .flatMap((e) => [`  - kind: ${e.kind}`, `    ref: ${e.ref}`]);
    const rendered = [
      "---",
      "status: current",
      `subject: ${subject}`,
      `decided: ${decided || new Date().toISOString().slice(0, 10)}`,
      "evidence:",
      ...evLines,
      "---",
      "",
      `# ${subject}`,
      "",
      body,
    ].join("\n");
    return proposal({
      provider: PROVIDER_ID,
      kind: "decision-topic",
      target: { path: `docs/decisions/${slug}.md`, slug },
      payload: { subject, slug, decided, evidence, body },
      rendered,
      rationale: intent.rationale || "Proposed decision topic — enact via the promote sub-flow (write docs/decisions/<slug>.md, add the subject noun to CONTEXT.md, run check:decisions).",
      provenance: provenance({ provider: PROVIDER_ID, source: `docs/decisions/${slug}.md`, agent: this.agent }),
    });
  }
}

export default GitRepoProvider;
