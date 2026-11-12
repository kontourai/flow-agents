/**
 * Classify human turns as correction / nudge / frustration / none, with a pain
 * score (0-3), a generalized rule of at most 15 words, and whether that rule is a
 * general working preference or a one-off about the task at hand.
 *
 * Two noise classes the spike measured are handled explicitly:
 *   - continuation pings ("continue", "still moving?") are dropped before any
 *     model call by `isContinuationPing`, a closed, documented list;
 *   - factual pushback ("that file is in src/, not lib/") is `none` by the
 *     classifier's instructions, unless it also states how the agent should work.
 *
 * Keyword and capital-letter heuristics are deliberately absent: the spike measured
 * 13% precision for keywords and 0% for capitals.
 *
 * Output is validated strictly. A batch whose answer does not cover every turn
 * exactly once, or names an unknown kind, is malformed: it is asked once more, and a
 * second malformed answer fails the run, which then writes nothing. A single item whose rule breaks the word bound is refused, not
 * truncated, and counted in `invalid`.
 *
 * @module learn/classify
 */

import { UNTRUSTED, learnError, retryMalformedOnce } from "./model.js";

export const CLASSIFIER_VERSION = "1";
export const KINDS = Object.freeze(["correction", "nudge", "frustration", "none"]);
export const MAX_RULE_WORDS = 15;
export const DEFAULT_BATCH_SIZE = 20;

/** Whole-message continuation pings, compared after lower-casing and removing punctuation. */
export const CONTINUATION_PINGS = Object.freeze([
  "continue", "go on", "keep going", "carry on", "proceed", "go ahead", "resume", "next", "go",
  "still moving", "still going", "still working", "still there", "are you still working", "are you there",
  "status", "any update", "any updates", "update", "how is it going", "hows it going", "progress",
  "ok", "okay", "k", "yes", "y", "yep", "yeah", "sure", "please", "please continue", "continue please",
  "thanks", "thank you", "ty", "done", "try again", "retry", "again",
]);
const PING_SET = new Set(CONTINUATION_PINGS);

export function isContinuationPing(text) {
  const normalized = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return normalized === "" || PING_SET.has(normalized);
}

export const wordCount = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;

export const CLASSIFY_TOOL = Object.freeze({
  name: "record_turn_classifications",
  description: "Record one classification for every numbered developer message.",
  inputSchema: {
    type: "object",
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["i", "kind", "pain", "rule", "general"],
          properties: {
            i: { type: "integer", description: "the message number" },
            kind: { type: "string", enum: [...KINDS] },
            pain: { type: "integer", minimum: 0, maximum: 3, description: "0 none, 1 mild, 2 clear irritation or repeated, 3 strong frustration or a serious miss" },
            rule: { type: "string", description: `the agent behaviour rule the message implies, imperative, at most ${MAX_RULE_WORDS} words; empty when kind is none` },
            general: { type: "boolean", description: "true when the rule is a standing working preference that applies beyond this task; false for a one-off about this task" },
          },
        },
      },
    },
  },
});

/**
 * The messages travel as JSON (one object per line), never inside text delimiters: a message containing
 * `</message>` or a forged item is just characters inside its own JSON string.
 */
export function classificationPrompt(batch) {
  const lines = [
    "You classify messages a software developer typed to their coding agent.",
    "For each numbered message decide:",
    "- kind: correction (the developer says the agent did something wrong or should do it differently), nudge (the developer steers the agent toward a way of working it should have chosen itself), frustration (the developer expresses annoyance at the agent's behaviour), or none (a new request, an answer, a question, approval, or a factual disagreement about the code or the world).",
    "- A factual disagreement (\"that function is in a different file\", \"the test does not exist\") is none, unless the message also says how the agent should work.",
    "- A request to continue, a status ping, or approval is none.",
    `- rule: the standing rule for the agent this message implies, imperative, at most ${MAX_RULE_WORDS} words, with no names, paths, or identifiers from the message. Empty when kind is none.`,
    "- general: true when that rule would apply to future tasks too; false when it only concerns this task.",
    "- pain: 0 to 3, how costly the agent's behaviour was for the developer.",
    "Each message is a JSON object with its number `i`, its `text`, and sometimes `context`: the end of the agent's previous message, given only to understand the developer's reply.",
    UNTRUSTED,
    "",
    "MESSAGES_JSON:",
    `[\n${batch.map((turn, i) => JSON.stringify(turn.context ? { i, context: turn.context, text: turn.text } : { i, text: turn.text })).join(",\n")}\n]`,
  ];
  return lines.join("\n");
}

/**
 * Validate one batch answer. Returns `{ results: [{kind, pain, rule, general} | null] }` indexed like `batch`, where
 * null marks an item refused by validation.
 */
export function parseClassification(input, batch) {
  const items = input?.items;
  if (!Array.isArray(items)) throw learnError("LEARN_MODEL_FAILED", "the classification has no items array");
  const results = new Array(batch.length).fill(undefined);
  for (const item of items) {
    const i = item?.i;
    if (!Number.isInteger(i) || i < 0 || i >= batch.length) throw learnError("LEARN_MODEL_FAILED", `the classification names an unknown message ${JSON.stringify(i)}`);
    if (results[i] !== undefined) throw learnError("LEARN_MODEL_FAILED", `the classification names message ${i} twice`);
    if (!KINDS.includes(item.kind)) throw learnError("LEARN_MODEL_FAILED", `the classification has an unknown kind ${JSON.stringify(item.kind)}`);
    const rule = typeof item.rule === "string" ? item.rule.replace(/\s+/g, " ").trim() : null;
    const valid = Number.isInteger(item.pain) && item.pain >= 0 && item.pain <= 3
      && typeof item.general === "boolean"
      && rule !== null
      && (item.kind === "none" || (rule.length > 0 && wordCount(rule) <= MAX_RULE_WORDS));
    results[i] = valid ? { kind: item.kind, pain: item.pain, rule: item.kind === "none" ? "" : rule, general: item.general } : null;
  }
  const missing = results.findIndex((result) => result === undefined);
  if (missing !== -1) throw learnError("LEARN_MODEL_FAILED", `the classification left message ${missing} unclassified`);
  return { results };
}

/**
 * Classify `turns` in batches, one model call per batch, in the turns' order.
 * @returns {Promise<{ classified: Array<{turn: object, kind: string, pain: number, rule: string, general: boolean}>, invalid: number, batches: number }>}
 */
export async function classifyTurns({ turns, invoke, batchSize = DEFAULT_BATCH_SIZE, onRetry }) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw learnError("LEARN_CONFIG_INVALID", "batchSize must be a positive integer");
  const classified = [];
  let invalid = 0;
  let batches = 0;
  for (let start = 0; start < turns.length; start += batchSize) {
    const batch = turns.slice(start, start + batchSize);
    const { results } = await retryMalformedOnce(async () => parseClassification(await invoke({ prompt: classificationPrompt(batch), tool: CLASSIFY_TOOL }), batch), onRetry);
    batches += 1;
    results.forEach((result, i) => {
      if (result === null) invalid += 1;
      else classified.push({ turn: batch[i], ...result });
    });
  }
  return { classified, invalid, batches };
}

export const batchCount = (n, batchSize = DEFAULT_BATCH_SIZE) => Math.ceil(n / batchSize);
