/**
 * Opt-in inferred-human mode (`flow-agents learn --infer-human`): decide, with a model, whether an `unknown`-origin
 * user turn reads as a person typing to their agent, or as an agent brief or automation.
 *
 * Why it exists: prompts submitted through an SDK or IDE host (Claude Code SDK `promptSource: sdk`, Codex
 * `session_meta.source=vscode`) are `unknown` to the importer, because delegated agent briefs arrive through the
 * same channel. A developer who works through such a host would otherwise give the loop almost nothing.
 *
 * Why it is off by default, and conservative: agent briefs are exactly the false positive that made the
 * human-only rule necessary. The classifier is told to answer `human` only when the text clearly reads as a person
 * reacting in real time, and `not-human` whenever it is unsure. Turns it keeps are marked `inferred`, never `human`,
 * and every proposal that cites one says so (`authority: "inferred"`).
 *
 * Only turns that `isInferenceCandidate` admits (sessions.js) are ever sent here, already scrubbed.
 *
 * @module learn/author
 */

import { UNTRUSTED, learnError, retryMalformedOnce } from "./model.js";

export const AUTHORS = Object.freeze(["human", "not-human"]);
export const DEFAULT_AUTHOR_BATCH_SIZE = 20;

export const AUTHOR_TOOL = Object.freeze({
  name: "record_message_authors",
  description: "Say for every numbered message whether a person typed it.",
  inputSchema: {
    type: "object",
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["i", "author"],
          properties: {
            i: { type: "integer" },
            author: { type: "string", enum: [...AUTHORS], description: "human only when clearly a person typing; not-human when unsure" },
          },
        },
      },
    },
  },
});

export function authorPrompt(batch) {
  return [
    "Each message below was sent to a coding agent in the user role, but the transcript does not record who wrote it: a person, or another agent or automation (an orchestrator's brief to a delegate, a scheduled task, a script).",
    "Answer human ONLY when the message clearly reads as a person typing to the agent in real time: conversational, reacting to what the agent just did, terse or informal.",
    "Answer not-human for task briefs, specifications, structured or templated instructions, numbered requirement lists, text addressed to a delegate or worker, generated reports, and anything you are not sure about. When in doubt, answer not-human.",
    UNTRUSTED,
    "",
    "MESSAGES_JSON:",
    `[\n${batch.map((turn, i) => JSON.stringify(turn.context ? { i, context: turn.context, text: turn.text } : { i, text: turn.text })).join(",\n")}\n]`,
  ].join("\n");
}

export function parseAuthors(input, batch) {
  const items = input?.items;
  if (!Array.isArray(items)) throw learnError("LEARN_MODEL_FAILED", "the author answer has no items array");
  const authors = new Array(batch.length).fill(undefined);
  for (const item of items) {
    const i = item?.i;
    if (!Number.isInteger(i) || i < 0 || i >= batch.length || authors[i] !== undefined) throw learnError("LEARN_MODEL_FAILED", `the author answer names message ${JSON.stringify(i)} unusably`);
    if (!AUTHORS.includes(item.author)) throw learnError("LEARN_MODEL_FAILED", `the author answer has an unknown author ${JSON.stringify(item.author)}`);
    authors[i] = item.author;
  }
  if (authors.includes(undefined)) throw learnError("LEARN_MODEL_FAILED", "the author answer left a message unjudged");
  return authors;
}

/** The candidates the model judged `human`, re-labelled `authority: "inferred"`. */
export async function inferHumanTurns({ turns, invoke, batchSize = DEFAULT_AUTHOR_BATCH_SIZE, onRetry }) {
  const kept = [];
  for (let start = 0; start < turns.length; start += batchSize) {
    const batch = turns.slice(start, start + batchSize);
    const authors = await retryMalformedOnce(async () => parseAuthors(await invoke({ prompt: authorPrompt(batch), tool: AUTHOR_TOOL }), batch), onRetry);
    authors.forEach((author, i) => {
      if (author === "human") kept.push({ ...batch[i], authority: "inferred" });
    });
  }
  return kept;
}
