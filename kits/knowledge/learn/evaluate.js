#!/usr/bin/env node
/**
 * Evaluation harness for the correction-recurrence classifier. Not run in CI: it reads your own transcripts and a
 * labelled set you keep private, and measures how well the loop finds the corrections you labelled.
 *
 *   node kits/knowledge/learn/evaluate.js --labels labels.jsonl [--transcripts DIR]... [--role NAME]
 *        [--predictions FILE | --write-predictions FILE] [--json]
 *
 * labels.jsonl, one object per line, keyed by the Thread locator `flow-agents learn` cites:
 *   {"thread_id":"claude-code:<session-uuid>","message_id":"<message-id>","label":"correction|nudge|frustration|none","general":true}
 *
 * A turn "counts" when it is a correction, nudge or frustration AND general (a standing preference, not a one-off),
 * which is exactly what the loop clusters. The harness reads the labelled turns through the same reader as the loop
 * (human origin only, scrubbed), classifies them with the same model route (or scores saved `--predictions` with no
 * model call), and reports precision, recall, F1, the per-kind confusion, and every labelled turn it could not find
 * (a labelled turn the origin filter drops shows up here, which is how to measure the filter itself).
 *
 * @module learn/evaluate
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import { DEFAULT_ROLE } from "../dream/config.js";
import { createRoleRuntime } from "../dream/model.js";
import { KINDS, classifyTurns } from "./classify.js";
import { learnError, toolInvoker } from "./model.js";
import { defaultTranscriptRoots, readHumanTurns } from "./sessions.js";

const counts = (kind, general) => kind !== "none" && general === true;
const ratio = (a, b) => (b === 0 ? null : Math.round((a / b) * 10000) / 10000);

/**
 * @param {Array<{key: string, label: string, general?: boolean}>} labels
 * @param {Array<{key: string, kind: string, general: boolean}>} predictions
 */
export function scorePredictions(labels, predictions) {
  const predicted = new Map(predictions.map((prediction) => [prediction.key, prediction]));
  const confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const byKind = Object.fromEntries(KINDS.map((kind) => [kind, Object.fromEntries(KINDS.map((other) => [other, 0]))]));
  const missing = [];
  for (const label of labels) {
    if (!KINDS.includes(label.label)) throw learnError("LEARN_USAGE", `label for ${label.key} must be one of ${KINDS.join(", ")}`);
    const prediction = predicted.get(label.key);
    if (!prediction) {
      missing.push(label.key);
      continue;
    }
    byKind[label.label][prediction.kind] += 1;
    const truth = counts(label.label, label.general === true);
    const guess = counts(prediction.kind, prediction.general);
    confusion[truth ? (guess ? "tp" : "fn") : guess ? "fp" : "tn"] += 1;
  }
  const precision = ratio(confusion.tp, confusion.tp + confusion.fp);
  const recall = ratio(confusion.tp, confusion.tp + confusion.fn);
  const f1 = precision === null || recall === null || precision + recall === 0 ? null : Math.round(((2 * precision * recall) / (precision + recall)) * 10000) / 10000;
  return { labelled: labels.length, scored: labels.length - missing.length, confusion, precision, recall, f1, by_kind: byKind, missing };
}

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw learnError("LEARN_USAGE", `${file} line ${index + 1} is not JSON`);
    }
  });
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  try {
    const args = { transcripts: [], json: false };
    for (let i = 0; i < argv.length; i += 1) {
      const flag = argv[i];
      if (flag === "--json") args.json = true;
      else if (["--labels", "--transcripts", "--role", "--predictions", "--write-predictions"].includes(flag)) {
        const value = argv[(i += 1)];
        if (!value) throw learnError("LEARN_USAGE", `missing value for ${flag}`);
        if (flag === "--transcripts") args.transcripts.push(path.resolve(value));
        else args[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      } else throw learnError("LEARN_USAGE", `unknown option: ${flag}`);
    }
    if (!args.labels) throw learnError("LEARN_USAGE", "--labels is required");
    const labels = readJsonl(args.labels).map((row) => ({ key: `${row.thread_id}#${row.message_id}`, label: row.label, general: row.general }));
    let predictions;
    if (args.predictions) {
      predictions = readJsonl(args.predictions);
    } else {
      const wanted = new Set(labels.map((label) => label.key));
      const roots = args.transcripts.length ? args.transcripts : defaultTranscriptRoots(env);
      const { turns } = readHumanTurns({ roots });
      const labelled = turns.filter((turn) => wanted.has(turn.key));
      const runtime = await createRoleRuntime({ role: args.role ?? DEFAULT_ROLE });
      const { classified } = await classifyTurns({ turns: labelled, invoke: toolInvoker(runtime) });
      predictions = classified.map((item) => ({ key: item.turn.key, kind: item.kind, general: item.general, pain: item.pain, rule: item.rule }));
      if (args.writePredictions) fs.writeFileSync(args.writePredictions, predictions.map((p) => JSON.stringify(p)).join("\n") + "\n", { mode: 0o600 });
    }
    const score = scorePredictions(labels, predictions);
    if (args.json) stdout.write(`${JSON.stringify(score)}\n`);
    else {
      stdout.write(`labelled ${score.labelled}, scored ${score.scored}, not found ${score.missing.length}\n`);
      stdout.write(`precision ${score.precision ?? "n/a"}  recall ${score.recall ?? "n/a"}  F1 ${score.f1 ?? "n/a"}  (${JSON.stringify(score.confusion)})\n`);
      for (const [label, row] of Object.entries(score.by_kind)) stdout.write(`  labelled ${label.padEnd(11)} -> ${Object.entries(row).map(([kind, n]) => `${kind}:${n}`).join(" ")}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`${error.code ?? "LEARN_EVAL_FAILED"}: ${String(error.message ?? error).slice(0, 400)}\n`);
    if (typeof error.help === "string") stderr.write(`${error.help}\n`);
    return error.code === "LEARN_USAGE" ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
