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

import { assertOwnerControlledFile } from "../dream/config.js";
import { scrubResidueText } from "../promote/runtime-redaction.js";
import { UNTRUSTED, learnError, retryMalformedOnce } from "./model.js";

export const MAX_RULES_FILE_BYTES = 128 * 1024;
export const MAX_RULES_FILE_LINES = 600;
export const RELATIONS = Object.freeze(["conflicts", "covers", "none"]);

/**
 * The rules file as numbered, scrubbed lines; `truncated` when it is longer than the judge is shown.
 *
 * A symlinked rules file (a dotfiles checkout, say) is followed to its target, which must then pass the kit's
 * ownership rule (`assertOwnerControlledFile`: a regular file owned by this user, not group or world writable, in
 * directories no other user can write). Any failure to resolve or open it (a loop, a dangling link, a directory) is a
 * configuration error, `LEARN_CONFIG_INVALID`, never a crash.
 *
 * The whole file is scrubbed BEFORE it is split into lines, so a secret that spans lines (a PEM private key block)
 * is still recognised. A byte-order mark and CRLF line ends are removed.
 */
export function readRulesFile(file) {
  let text;
  try {
    const target = assertOwnerControlledFile(fs.realpathSync(file), "rules file");
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw learnError("LEARN_CONFIG_INVALID", `rules file is not a regular file: ${file}`);
      if (stat.size > MAX_RULES_FILE_BYTES) throw learnError("LEARN_CONFIG_INVALID", `rules file is over ${MAX_RULES_FILE_BYTES} bytes: ${file}`);
      text = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error?.code === "LEARN_CONFIG_INVALID") throw error;
    const reason = error?.code === "DREAM_CONFIG_INVALID" ? error.message : `${error?.code ?? "error"}`;
    throw learnError("LEARN_CONFIG_INVALID", `rules file ${file} cannot be used (${reason})`);
  }
  const all = scrubResidueText(text.replace(/^\uFEFF/, "")).split(/\r?\n/);
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
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
    "A developer's coding agent keeps being corrected. The correction implies a proposed rule, given below as a JSON string.",
    "The rule file the agent already reads is given as a JSON array of numbered lines.",
    "Decide whether one line conflicts with the proposed rule (following both is impossible or they pull opposite ways), already covers it (says the same thing), or neither. Cite the single most relevant line by its number.",
    UNTRUSTED,
    "",
    `PROPOSED_RULE_JSON: ${JSON.stringify(rule)}`,
    "RULE_FILE_LINES_JSON:",
    `[\n${rules.lines.map((text, index) => JSON.stringify({ line: index + 1, text })).join(",\n")}\n]`,
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

/** A model-backed judge: `(rule, rules) => Promise<judgement>`. A malformed answer is asked once more. */
export function modelJudge(invoke, { onRetry } = {}) {
  return (rule, rules) => retryMalformedOnce(async () => parseJudgement(await invoke({ prompt: judgePrompt(scrubResidueText(rule), rules), tool: JUDGE_TOOL }), rules), onRetry);
}
