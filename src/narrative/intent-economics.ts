/**
 * #622 (R6/AC5): annotation-on/off A/B token measurement with uncertainty.
 *
 * `appendIntentEconomics` is an append-only local sink mirroring
 * narrative-render.ts:appendEconomics (O_APPEND|O_CREAT|O_WRONLY, no-follow,
 * 0600). `reduceIntentEconomics` is a NET-NEW pure paired-delta reducer: it
 * pairs annotation_on/off samples in order and reports the MEAN delta together
 * with an uncertainty spread (sample standard deviation + observed range) for
 * each metric. No external stats dependency.
 *
 * This is the measurement MECHANISM + dry-run harness; scaled behavioral deltas
 * across many real runs feed #612.
 *
 * @module
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const INTENT_ECONOMICS_FILE = "intent-economics.jsonl";

export type IntentAnnotationMode = "annotation_on" | "annotation_off";

export interface IntentEconomicsRecord {
  mode: IntentAnnotationMode;
  input_tokens: number;
  output_tokens: number;
  wall_clock_ms: number;
  attempted_at: string;
}

export function appendIntentEconomics(dir: string, record: IntentEconomicsRecord): void {
  const file = path.join(dir, INTENT_ECONOMICS_FILE);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe intent economics target at ${file}`);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(file, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow, 0o600);
  try { fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, "utf8"); }
  finally { fs.closeSync(descriptor); }
}

/** A mean delta reported WITH its uncertainty spread (never a bare point estimate). */
export interface IntentEconomicsDelta {
  /** Number of paired (on,off) deltas contributing to this metric. */
  n: number;
  mean: number;
  /** Sample standard deviation (Bessel-corrected); 0 for a single pair. */
  sample_std: number;
  min: number;
  max: number;
}

export interface IntentEconomicsSummary {
  pairs: number;
  on_samples: number;
  off_samples: number;
  delta_input_tokens: IntentEconomicsDelta;
  delta_output_tokens: IntentEconomicsDelta;
  delta_wall_clock_ms: IntentEconomicsDelta;
}

function summarizeDeltas(values: readonly number[]): IntentEconomicsDelta {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, sample_std: 0, min: 0, max: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  // Bessel-corrected sample variance; a single pair has undefined spread -> 0.
  const variance = n > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, sample_std: Math.sqrt(variance), min: Math.min(...values), max: Math.max(...values) };
}

export function reduceIntentEconomics(records: readonly IntentEconomicsRecord[]): IntentEconomicsSummary {
  const on = records.filter((record) => record.mode === "annotation_on");
  const off = records.filter((record) => record.mode === "annotation_off");
  const pairs = Math.min(on.length, off.length);
  const inputDeltas: number[] = [];
  const outputDeltas: number[] = [];
  const wallDeltas: number[] = [];
  for (let index = 0; index < pairs; index += 1) {
    inputDeltas.push(on[index].input_tokens - off[index].input_tokens);
    outputDeltas.push(on[index].output_tokens - off[index].output_tokens);
    wallDeltas.push(on[index].wall_clock_ms - off[index].wall_clock_ms);
  }
  return {
    pairs,
    on_samples: on.length,
    off_samples: off.length,
    delta_input_tokens: summarizeDeltas(inputDeltas),
    delta_output_tokens: summarizeDeltas(outputDeltas),
    delta_wall_clock_ms: summarizeDeltas(wallDeltas),
  };
}

/** Read + parse an intent-economics.jsonl sink into typed records (skips blank lines). */
export function readIntentEconomics(dir: string): IntentEconomicsRecord[] {
  const file = path.join(dir, INTENT_ECONOMICS_FILE);
  if (!fs.existsSync(file)) return [];
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe intent economics target at ${file}`);
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as IntentEconomicsRecord);
}
