/**
 * Conflict judge: does a proposed rule contradict, or already appear in, the
 * target rule file (AGENTS.md, CLAUDE.md)? A model judges, because the spike
 * found that 2 of the top 5 learned rules contradicted written ones, and the
 * contradictions were semantic, not textual.
 *
 * The judge sees the rule and the file's numbered lines (scrubbed). Its answer
 * is checked: a cited line must exist and hold text, or the answer is refused.
 *
 * @module learn/judge
 */

import * as fs from "node:fs";

import { scrubResidueText } from "../promote/runtime-redaction.js";
import { UNTRUSTED, learnError } from "./model.js";

export const MAX_RULES_FILE_BYTES = 128 * 1024;
export const MAX_RULES_FILE_LINES = 600;
export const RELATIONS = Object.freeze(["conflicts", "covers", "none"]);

/** The rules file as numbered, scrubbed lines; `truncated` when it is longer than the judge is shown. */
export function readRulesFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let text;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw learnError("LEARN_CONFIG_INVALID", `rules file is not a regular file: ${file}`);
    if (stat.size > MAX_RULES_FILE_BYTES) throw learnError("LEARN_CONFIG_INVALID", `rules file is over ${MAX_RULES_FILE_BYTES} bytes: ${file}`);
    text = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  const all = text.split("\n").map((line) => scrubResidueText(line));
  return { file, lines: all.slice(0, MAX_RULES_FILE_LINES), truncated: all.length > MAX_RULES_FILE_LINES };
}

export const JUDGE_TOOL = Object.freeze({
  name: "judge_rule_against_file",
  description: "Say whether the proposed rule conflicts with, is already covered by, or is unrelated to the file's rules.",
  inputSchema: {
    type: "object",
    required: ["relation", "line", "explanation"],
    properties: {
      relation: { type: "string", enum: [...RELATIONS], description: "conflicts: a line tells the agent to do the opposite or something incompatible. covers: a line already says the same thing. none: neither." },
      line: { type: ["integer", "null"], description: "the 1-based line number of the conflicting or covering line; null when relation is none" },
      explanation: { type: "string", description: "one sentence" },
    },
  },
});

export function judgePrompt(rule, rules) {
  return [
    "A developer's coding agent keeps being corrected. The correction implies this proposed rule:",
    `PROPOSED RULE: ${rule}`,
    "Below are the numbered lines of the rule file the agent already reads.",
    "Decide whether one line conflicts with the proposed rule (following both is impossible or they pull opposite ways), already covers it (says the same thing), or neither. Cite the single most relevant line.",
    UNTRUSTED,
    "",
    ...rules.lines.map((line, index) => `${index + 1}: ${line}`),
  ].join("\n");
}

/** Validate a judge answer. Returns `{ relation, line, text, explanation }` with `line`/`text` null for `none`. */
export function parseJudgement(input, rules) {
  if (!RELATIONS.includes(input?.relation)) throw learnError("LEARN_MODEL_FAILED", `the judge returned an unknown relation ${JSON.stringify(input?.relation)}`);
  const explanation = typeof input.explanation === "string" ? input.explanation.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  if (input.relation === "none") return { relation: "none", line: null, text: null, explanation };
  const line = input.line;
  if (!Number.isInteger(line) || line < 1 || line > rules.lines.length || !rules.lines[line - 1].trim()) {
    throw learnError("LEARN_MODEL_FAILED", `the judge cited line ${JSON.stringify(line)}, which is not a line with text`);
  }
  return { relation: input.relation, line, text: rules.lines[line - 1].trim().slice(0, 300), explanation };
}

/** A model-backed judge: `(rule, rules) => Promise<judgement>`. */
export function modelJudge(invoke) {
  return async (rule, rules) => parseJudgement(await invoke({ prompt: judgePrompt(scrubResidueText(rule), rules), tool: JUDGE_TOOL }), rules);
}
