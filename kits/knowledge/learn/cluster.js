/**
 * Group generalized rules into themes, model-assisted, with deterministic ordering.
 *
 * Theme identity has to survive across runs: proposal ids, escalation and the
 * after-ratification effect measurement all key on it. So the model is shown the
 * themes the ledger already holds (`existingThemes`, by id) and asked to put each
 * rule under one of them or under a new theme. A new theme's id is the slug of its
 * label, made unique against every id already known. Only rules are sent, never the
 * developer's message text.
 *
 * Ordering: rules are sorted by text then key before batching, existing themes by id,
 * and new themes are created in label order, so the same model answers give the same
 * themes and ids.
 *
 * Lineage: a new theme that narrows an existing one names it as `parent`. Effect
 * measurement and theme history follow parents to the root, so a theme the model splits
 * in a later run still counts against the proposal that was ratified for its root.
 *
 * @module learn/cluster
 */

import { createHash } from "node:crypto";

import { MAX_RULE_WORDS, wordCount } from "./classify.js";
import { UNTRUSTED, learnError, retryMalformedOnce } from "./model.js";

export const DEFAULT_CLUSTER_BATCH_SIZE = 80;

export const CLUSTER_TOOL = Object.freeze({
  name: "assign_rule_themes",
  description: "Put every numbered rule under exactly one theme.",
  inputSchema: {
    type: "object",
    required: ["new_themes", "assignments"],
    properties: {
      new_themes: {
        type: "array",
        description: "themes to create; reuse an existing theme whenever a rule means the same thing",
        items: {
          type: "object",
          required: ["key", "label"],
          properties: {
            key: { type: "string", description: "a short key, used only within this answer" },
            label: { type: "string", description: `the theme as one imperative rule, at most ${MAX_RULE_WORDS} words` },
            parent: { type: ["string", "null"], description: "the id of the existing theme this one is a narrower part of, if any" },
          },
        },
      },
      assignments: {
        type: "array",
        items: {
          type: "object",
          required: ["i", "theme"],
          properties: {
            i: { type: "integer" },
            theme: { type: "string", description: "an existing theme id or a new theme key" },
          },
        },
      },
    },
  },
});

/** A Latin-letter slug of the label; a label with none (any non-Latin script) gets a stable hash of itself instead. */
export function slugify(text) {
  const slug = String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  return slug || `theme-${createHash("sha256").update(String(text)).digest("hex").slice(0, 12)}`;
}

export function clusterPrompt(rules, themes) {
  const lines = [
    "You group rules a developer wants their coding agent to follow.",
    "Put every numbered rule under exactly one theme. Two rules share a theme only when following one means following the other.",
    "Prefer an existing theme. Create a new theme only when no existing one means the same thing; when it is a narrower part of an existing theme, give that theme's id as its parent.",
    UNTRUSTED,
    "",
    "EXISTING_THEMES_JSON:",
    JSON.stringify(themes.map((theme) => ({ id: theme.id, label: theme.label }))),
    "",
    "RULES_JSON:",
    `[\n${rules.map((rule, i) => JSON.stringify({ i, rule: rule.rule })).join(",\n")}\n]`,
  ];
  return lines.join("\n");
}

/** Validate one clustering answer against its batch and the themes known before it. */
export function parseClusters(input, rules, known) {
  const newThemes = input?.new_themes;
  const assignments = input?.assignments;
  if (!Array.isArray(newThemes) || !Array.isArray(assignments)) throw learnError("LEARN_MODEL_FAILED", "the clustering answer lacks new_themes or assignments");
  const created = new Map();
  for (const theme of newThemes) {
    const label = typeof theme?.label === "string" ? theme.label.replace(/\s+/g, " ").trim() : "";
    if (typeof theme?.key !== "string" || !theme.key || created.has(theme.key) || known.has(theme.key)) {
      throw learnError("LEARN_MODEL_FAILED", `the clustering answer has an unusable new theme key ${JSON.stringify(theme?.key)}`);
    }
    if (!label || wordCount(label) > MAX_RULE_WORDS) throw learnError("LEARN_MODEL_FAILED", `new theme ${JSON.stringify(theme.key)} has no label or a label over ${MAX_RULE_WORDS} words`);
    const parent = theme.parent ?? null;
    if (parent !== null && !known.has(parent)) throw learnError("LEARN_MODEL_FAILED", `new theme ${JSON.stringify(theme.key)} names an unknown parent ${JSON.stringify(parent)}`);
    created.set(theme.key, { label, parent });
  }
  const themeOf = new Array(rules.length).fill(undefined);
  for (const assignment of assignments) {
    const i = assignment?.i;
    if (!Number.isInteger(i) || i < 0 || i >= rules.length || themeOf[i] !== undefined) {
      throw learnError("LEARN_MODEL_FAILED", `the clustering answer assigns rule ${JSON.stringify(i)} unusably`);
    }
    if (!known.has(assignment.theme) && !created.has(assignment.theme)) {
      throw learnError("LEARN_MODEL_FAILED", `the clustering answer names an unknown theme ${JSON.stringify(assignment.theme)}`);
    }
    themeOf[i] = assignment.theme;
  }
  const missing = themeOf.findIndex((theme) => theme === undefined);
  if (missing !== -1) throw learnError("LEARN_MODEL_FAILED", `the clustering answer leaves rule ${missing} unassigned`);
  return { created, themeOf };
}

/**
 * @param {{ rules: Array<{key: string, rule: string}>, existingThemes: Array<{id: string, label: string, parent?: string|null}>, invoke: Function, batchSize?: number, onRetry?: Function }} options
 * @returns {Promise<{ themeOf: Map<string, string>, themes: Map<string, string>, parents: Map<string, string>, created: string[], batches: number }>}
 *   `themeOf` maps a rule key to a theme id; `themes` maps every known theme id to its label; `parents` maps a theme
 *   id to its parent theme id.
 */
export async function clusterRules({ rules, existingThemes = [], invoke, batchSize = DEFAULT_CLUSTER_BATCH_SIZE, onRetry }) {
  const sortedExisting = [...existingThemes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const themes = new Map(sortedExisting.map((theme) => [theme.id, theme.label]));
  const parents = new Map(sortedExisting.filter((theme) => theme.parent).map((theme) => [theme.id, theme.parent]));
  const themeOf = new Map();
  const created = [];
  let batches = 0;
  const ordered = [...rules].sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let start = 0; start < ordered.length; start += batchSize) {
    const batch = ordered.slice(start, start + batchSize);
    const known = [...themes].map(([id, label]) => ({ id, label }));
    const parsed = await retryMalformedOnce(async () => parseClusters(await invoke({ prompt: clusterPrompt(batch, known), tool: CLUSTER_TOOL }), batch, themes), onRetry);
    batches += 1;
    const idForKey = new Map();
    for (const [key, { label, parent }] of [...parsed.created].sort(([, a], [, b]) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))) {
      const base = slugify(label);
      let id = base;
      for (let n = 2; themes.has(id); n += 1) id = `${base}-${n}`;
      themes.set(id, label);
      if (parent) parents.set(id, parent);
      idForKey.set(key, id);
      created.push(id);
    }
    batch.forEach((rule, i) => themeOf.set(rule.key, idForKey.get(parsed.themeOf[i]) ?? parsed.themeOf[i]));
  }
  return { themeOf, themes, parents, created, batches };
}
