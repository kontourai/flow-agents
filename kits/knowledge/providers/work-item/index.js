/**
 * work-item knowledge-store provider (source/sink adapter, not storage).
 *
 * Maps a GitHub issue backlog into the typed graph so backlog hygiene becomes a
 * knowledge-health pass:
 *   - issues                         -> `issue` nodes (state / labels / title).
 *   - flow-agents:work-item-metadata `blockers` -> `blocks` edges.
 *   - prose "blocked by #N"          -> `blocks` edges; other #N refs -> `relates`.
 *
 * Reads via an INJECTABLE runner so tests drive it from recorded fixtures and
 * never touch the real board. Write side is proposals-only: proposeWrite renders
 * a draft issue comment / label change for an operator to file — it never calls
 * a mutating gh command.
 *
 * @module providers/work-item
 */

import { execFile } from "node:child_process";
import { node, edge, proposal, provenance } from "../lib/model.js";

const PROVIDER_ID = "work-item";

/** Default runner: shells out to `gh` (read-only list). */
function defaultRunner(args) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`gh ${args.join(" ")} failed: ${stderr || err.message}`));
      resolve(stdout);
    });
  });
}

/** Parse the flow-agents:work-item-metadata JSON block from an issue body. */
export function parseWorkItemMetadata(body) {
  if (!body) return null;
  const start = body.indexOf("flow-agents:work-item-metadata");
  if (start === -1) return null;
  const jsonStart = body.indexOf("{", start);
  const end = body.indexOf("-->", jsonStart);
  if (jsonStart === -1 || end === -1) return null;
  try {
    return JSON.parse(body.slice(jsonStart, end).trim());
  } catch {
    return null;
  }
}

/** Extract a blocker issue number from a metadata blocker entry. */
function blockerNumber(entry) {
  if (typeof entry === "number") return entry;
  if (typeof entry === "string") {
    const m = entry.match(/#?(\d+)/);
    return m ? Number(m[1]) : null;
  }
  if (entry && typeof entry === "object") {
    if (typeof entry.number === "number") return entry.number;
    if (typeof entry.issue === "number") return entry.issue;
    if (typeof entry.ref === "string") {
      const m = entry.ref.match(/#?(\d+)/);
      return m ? Number(m[1]) : null;
    }
  }
  return null;
}

export class WorkItemProvider {
  constructor({ repo, runner, agent } = {}) {
    this.repo = repo || "";
    this.runner = runner || defaultRunner;
    this.agent = agent;
    this.id = PROVIDER_ID;
    this._cache = null;
  }

  capabilities() {
    return {
      id: PROVIDER_ID,
      node_types: ["issue"],
      edge_types: ["blocks", "relates"],
      writable: false,
      write_mode: "proposals-only",
      proposal_targets: ["comment", "label"],
      source_of_truth: "GitHub issues (read via gh; write = draft comments/labels)",
    };
  }

  async _issues() {
    if (this._cache) return this._cache;
    const args = ["issue", "list"];
    if (this.repo) args.push("--repo", this.repo);
    args.push("--state", "all", "--json", "number,title,state,labels,body", "--limit", "200");
    const out = await this.runner(args);
    const parsed = JSON.parse(out);
    this._cache = Array.isArray(parsed) ? parsed : [];
    return this._cache;
  }

  async readNodes(options = {}) {
    const issues = await this._issues();
    const now = new Date().toISOString();
    const nodes = issues.map((iss) =>
      node({
        id: `issue:${iss.number}`,
        type: "issue",
        title: iss.title || `issue #${iss.number}`,
        body: iss.body || "",
        attributes: {
          number: iss.number,
          state: iss.state || "OPEN",
          labels: (iss.labels || []).map((l) => (typeof l === "string" ? l : l.name)),
        },
        provenance: provenance({
          provider: PROVIDER_ID,
          source: this.repo ? `${this.repo}#${iss.number}` : `#${iss.number}`,
          retrievedAt: now,
          agent: this.agent,
        }),
      }),
    );
    if (options.type) return nodes.filter((n) => n.type === options.type);
    return nodes;
  }

  async readEdges() {
    const issues = await this._issues();
    const now = new Date().toISOString();
    const edges = [];
    const seen = new Set();
    const push = (e) => {
      if (seen.has(e.id)) return;
      seen.add(e.id);
      edges.push(e);
    };

    for (const iss of issues) {
      const self = `issue:${iss.number}`;
      const prov = (loc) => provenance({ provider: PROVIDER_ID, source: this.repo ? `${this.repo}#${iss.number}` : `#${iss.number}`, locator: loc, retrievedAt: now, agent: this.agent });

      // metadata blockers -> blocks (blocker blocks this)
      const md = parseWorkItemMetadata(iss.body);
      for (const b of (md && Array.isArray(md.blockers) ? md.blockers : [])) {
        const n = blockerNumber(b);
        if (n == null) continue;
        push(edge({ id: `issue:${n}--blocks--${iss.number}`, type: "blocks", from: `issue:${n}`, to: self, attributes: { origin: "metadata" }, provenance: prov("metadata.blockers") }));
      }

      const body = iss.body || "";
      // prose "blocked by #N" / "depends on #N" -> blocks
      for (const m of body.matchAll(/\b(?:blocked by|depends on|blocker:)\s*#(\d+)/gi)) {
        const n = Number(m[1]);
        push(edge({ id: `issue:${n}--blocks--${iss.number}`, type: "blocks", from: `issue:${n}`, to: self, attributes: { origin: "prose" }, provenance: prov("body.prose") }));
      }
      // other bare #N prose refs -> relates
      for (const m of body.matchAll(/(?<![\w/])#(\d+)\b/g)) {
        const n = Number(m[1]);
        if (n === iss.number) continue;
        const bid = `issue:${iss.number}--relates--${n}`;
        if (seen.has(`issue:${n}--blocks--${iss.number}`)) continue; // already a stronger blocks edge
        push(edge({ id: bid, type: "relates", from: self, to: `issue:${n}`, attributes: { origin: "prose" }, provenance: prov("body.prose") }));
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
   * Propose an issue comment or label change. Renders the draft an operator
   * would file with gh — the provider never runs a mutating gh command.
   */
  async proposeWrite(intent = {}) {
    const { issue, kind = "comment", commentBody, labels = [] } = intent;
    if (issue == null) throw new Error("work-item proposeWrite requires intent.issue (number)");
    if (kind === "label") {
      return proposal({
        provider: PROVIDER_ID,
        kind: "label",
        target: { repo: this.repo, issue },
        payload: { labels },
        rendered: `gh issue edit ${issue}${this.repo ? ` --repo ${this.repo}` : ""} ${labels.map((l) => `--add-label ${JSON.stringify(l)}`).join(" ")}`,
        rationale: intent.rationale || "Proposed label change (draft — operator files it).",
        provenance: provenance({ provider: PROVIDER_ID, source: this.repo ? `${this.repo}#${issue}` : `#${issue}`, agent: this.agent }),
      });
    }
    return proposal({
      provider: PROVIDER_ID,
      kind: "comment",
      target: { repo: this.repo, issue },
      payload: { body: commentBody || "" },
      rendered: `gh issue comment ${issue}${this.repo ? ` --repo ${this.repo}` : ""} --body ${JSON.stringify(commentBody || "")}`,
      rationale: intent.rationale || "Proposed issue comment (draft — operator files it).",
      provenance: provenance({ provider: PROVIDER_ID, source: this.repo ? `${this.repo}#${issue}` : `#${issue}`, agent: this.agent }),
    });
  }
}

export default WorkItemProvider;
