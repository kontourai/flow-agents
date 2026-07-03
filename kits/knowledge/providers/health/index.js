/**
 * Provider-agnostic knowledge-health verbs.
 *
 * Each verb takes a graph ({ nodes, edges }) produced by ANY provider that
 * implements the read side of the knowledge-store contract and returns a
 * schema-valid Knowledge Health Report (schemas/knowledge/health-report.schema.json).
 * The verbs never inspect provider internals — that is what lets the SAME health
 * command run identically over the vault, git-repo, and work-item providers
 * (AC1, AC2, R4).
 *
 * @module providers/health
 */

import { loadSchemas } from "../lib/model.js";
import { assertValid } from "../lib/schema-validate.js";

const { healthReport: HEALTH_SCHEMA } = loadSchemas();

/** Normalise a title into a comparable token set. */
function tokenize(title) {
  return new Set(
    String(title || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function finalize(report) {
  report.summary.finding_count = report.findings.length;
  assertValid(report, HEALTH_SCHEMA, `health report (${report.check})`);
  return report;
}

/**
 * Duplicate detection: flag node PAIRS whose titles are the same or highly
 * similar (token Jaccard >= threshold). Scoped to same-type pairs by default so
 * a decision and an issue with a shared word are not conflated.
 *
 * @param {{nodes: object[], edges: object[]}} graph
 * @param {object} [options]
 * @param {string} [options.provider="unknown"]
 * @param {number} [options.threshold=0.7]
 * @param {boolean} [options.crossType=false] compare across node types when true
 * @param {string} [options.generatedAt]
 */
export function detectDuplicates(graph, options = {}) {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const threshold = typeof options.threshold === "number" ? options.threshold : 0.7;
  const crossType = options.crossType === true;

  const report = {
    schema_version: "1.0",
    check: "duplicate-detection",
    provider: options.provider || "unknown",
    generated_at: options.generatedAt || new Date().toISOString(),
    summary: { nodes_examined: nodes.length, edges_examined: edges.length, finding_count: 0 },
    findings: [],
  };

  const tokenized = nodes.map((n) => ({ node: n, tokens: tokenize(n.title) }));
  for (let i = 0; i < tokenized.length; i++) {
    for (let j = i + 1; j < tokenized.length; j++) {
      const a = tokenized[i];
      const b = tokenized[j];
      if (!crossType && a.node.type !== b.node.type) continue;
      const score = jaccard(a.tokens, b.tokens);
      if (score >= threshold) {
        report.findings.push({
          kind: "duplicate-nodes",
          severity: "warning",
          node_ids: [a.node.id, b.node.id],
          message: `Possible duplicate ${a.node.type} nodes: "${a.node.title}" ~ "${b.node.title}" (similarity ${score.toFixed(2)})`,
          evidence: {
            similarity: Number(score.toFixed(4)),
            threshold,
            title_a: a.node.title,
            title_b: b.node.title,
            type: a.node.type,
          },
        });
      }
    }
  }
  return finalize(report);
}

/**
 * Dependency-link integrity: flag dependency edges whose endpoints do not
 * resolve to a node present in the graph. An edge marked resolved:false is a
 * deliberate external reference and is skipped.
 *
 * @param {{nodes: object[], edges: object[]}} graph
 * @param {object} [options]
 * @param {string} [options.provider="unknown"]
 * @param {string[]} [options.dependencyTypes=["blocks"]] edge types treated as dependency links
 * @param {string} [options.generatedAt]
 */
export function checkDependencyLinkIntegrity(graph, options = {}) {
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const depTypes = new Set(options.dependencyTypes || ["blocks"]);
  const ids = new Set(nodes.map((n) => n.id));

  const report = {
    schema_version: "1.0",
    check: "dependency-link-integrity",
    provider: options.provider || "unknown",
    generated_at: options.generatedAt || new Date().toISOString(),
    summary: { nodes_examined: nodes.length, edges_examined: edges.length, finding_count: 0 },
    findings: [],
  };

  for (const e of edges) {
    if (!depTypes.has(e.type)) continue;
    if (e.resolved === false) continue; // deliberate external ref
    const sourceMissing = !ids.has(e.from);
    const targetMissing = !ids.has(e.to);
    if (!sourceMissing && !targetMissing) continue;
    report.findings.push({
      kind: "broken-dependency-link",
      severity: "error",
      edge_ids: [e.id],
      node_ids: [e.from, e.to],
      message: `Broken ${e.type} link ${e.from} -> ${e.to}: ${
        targetMissing ? `target '${e.to}' not found` : ""
      }${targetMissing && sourceMissing ? "; " : ""}${sourceMissing ? `source '${e.from}' not found` : ""}`.trim(),
      evidence: {
        edge_type: e.type,
        from: e.from,
        to: e.to,
        source_missing: sourceMissing,
        target_missing: targetMissing,
      },
    });
  }
  return finalize(report);
}

export const HEALTH_VERBS = Object.freeze({
  "duplicate-detection": detectDuplicates,
  "dependency-link-integrity": checkDependencyLinkIntegrity,
});
