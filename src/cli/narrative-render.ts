import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { ensureSafeDirectory } from "../lib/fs.js";
import { flagString, parseArgs } from "../lib/args.js";
import {
  composeGroundedNarrative,
  validateGroundedNarrative,
  writeEnvelope,
  type GroundedExecutionNarrative,
  type WrittenGroundedNarrative,
} from "../narrative/envelope.js";
import {
  NarrativeGroundingError,
  validateNarrativeGrounding,
  type EntailmentIdentity,
  type EntailmentProvenance,
  type GroundingViolation,
} from "../narrative/grounding-validator.js";
import { stableStringify } from "../narrative/projection.js";
import { resolveSource } from "../narrative/resolver.js";
import { parseSourceId } from "../narrative/source-ids.js";
import { summarizerInferredConnective, type Statement } from "../narrative/statements.js";

export const PROSE_PROMPT_VERSION = "narrative-prose-renderer/v1" as const;
export const PROSE_ECONOMICS_FILE = "prose-economics.jsonl";

// ── Generator adapter contract (R1/R2) ───────────────────────────────────────
//
// The generator NEVER sees a live store, a raw transcript, or anything beyond
// the frozen #613 envelope's runtime-projection statements plus the
// policy-filtered frozen snapshot views for the fa1 refs those statements
// cite (built exclusively via resolveSource, below). This is structurally
// true because buildSourceViews only ever reads through resolveSource, which
// itself only ever reads content-addressed blobs beneath the frozen
// narrativeDir (see resolver.ts's safeNarrativeDir/assertPathContained).

export interface ProseGeneratorSentence {
  text: string;
  statement_refs: string[];
}

export interface ProseGeneratorUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface GeneratedProse {
  sentences: ProseGeneratorSentence[];
  usage: ProseGeneratorUsage;
}

export interface ProseSourceView {
  source_ref: string;
  stream: string;
  content: string;
}

export interface ProseGeneratorInput {
  /** Frozen runtime-projection statements only (turns[].statements + document_statements). */
  statements: Statement[];
  /** Policy-filtered frozen snapshot views for every source_ref cited by `statements`. */
  sourceViews: ProseSourceView[];
}

export interface ProseGenerator {
  identity: EntailmentIdentity;
  generate(input: ProseGeneratorInput): Promise<GeneratedProse>;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── Deterministic hermetic stub generator (CI default, D5) ──────────────────
//
// Emits one connective sentence per atomic (observed/deterministic_derived)
// statement, quoting its proposition verbatim and citing exactly that
// statement's own source_refs. This is deliberately unable to omit a failure
// or relabel an outcome: it never invents text beyond the frozen statement
// set, so R2 (inherited-never-upgraded), R3 (counterevidence preservation),
// and D3 (citation provenance-subset) all hold trivially for its output.

const STUB_IDENTITY: EntailmentIdentity = { model: "deterministic-stub", provider: "local-stub", config_hash: "stub-v1" };

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export const stubGenerator: ProseGenerator = {
  identity: STUB_IDENTITY,
  async generate(input: ProseGeneratorInput): Promise<GeneratedProse> {
    const atomic = input.statements.filter((statement) => statement.class === "observed" || statement.class === "deterministic_derived");
    // Deliberately does NOT restate the atomic proposition's outcome verbs (observed/
    // passed/failed/succeeded/timed out/created, etc.) -- grounding-validator.ts's dormant
    // epistemic backstop (isAssertionProhibited) bans summarizer_inferred statements from
    // asserting observed_outcome-shaped language even when quoted, by design (#623). A
    // purely referential connective sentence still satisfies D3's citation-subset contract
    // (it carries the atomic statement's own real fa1 refs) without laundering the claim.
    const sentences: ProseGeneratorSentence[] = atomic.map((statement) => ({
      text: `The frozen record includes statement \`${statement.id}\`, grounded in ${statement.source_refs.length} cited source(s).`,
      statement_refs: [...statement.source_refs],
    }));
    const inputChars = input.statements.reduce((total, statement) => total + statement.proposition.length, 0)
      + input.sourceViews.reduce((total, view) => total + view.content.length, 0);
    const outputChars = sentences.reduce((total, sentence) => total + sentence.text.length, 0);
    return {
      sentences,
      usage: { input_tokens: estimateTokens("x".repeat(inputChars)), output_tokens: estimateTokens("x".repeat(Math.max(outputChars, 1))) },
    };
  },
};

// ── Provider gate (D5/R6/AC8) ────────────────────────────────────────────────
//
// Mirrors telemetry-doctor.ts's endpointAllowed(): deny any non-local
// endpoint unless an explicit opt-in config carries declared tenant /
// data_residency / payload_policy fields. Every generator below checks this
// BEFORE constructing any http(s) request -- a disallowed endpoint is never
// dialed (assert no-attempt, not graceful failure).

export interface ProviderOptIn {
  tenant: string;
  data_residency: string;
  payload_policy: string;
}

export interface ProviderConfig {
  endpoint?: string;
  optIn?: ProviderOptIn;
}

function parseUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function providerAllowed(config: ProviderConfig, endpoint: string): boolean {
  if (!endpoint || endpoint.includes("\n") || endpoint.includes("\r") || endpoint.includes('"')) return false;
  const url = parseUrl(endpoint);
  if (!url) return false;
  if (url.username || url.password) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (isLocalHostname(url.hostname)) return true;
  const optIn = config.optIn;
  return Boolean(optIn && nonEmpty(optIn.tenant) && nonEmpty(optIn.data_residency) && nonEmpty(optIn.payload_policy));
}

export class ProviderNotAllowedError extends Error {
  readonly name = "ProviderNotAllowedError";
  constructor(readonly endpoint: string) {
    super(`generator endpoint is not allowed without opt-in (declared tenant/data_residency/payload_policy): ${endpoint}`);
  }
}

interface RawGeneratorResponse {
  sentences?: Array<{ text?: unknown; statement_refs?: unknown }>;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

function coerceGeneratedProse(raw: RawGeneratorResponse): GeneratedProse {
  const sentences: ProseGeneratorSentence[] = Array.isArray(raw.sentences)
    ? raw.sentences
      .map((sentence) => ({
        text: typeof sentence?.text === "string" ? sentence.text : "",
        statement_refs: Array.isArray(sentence?.statement_refs)
          ? sentence.statement_refs.filter((ref): ref is string => typeof ref === "string")
          : [],
      }))
      .filter((sentence) => sentence.text.length > 0)
    : [];
  const inputTokens = Number.isSafeInteger(raw.usage?.input_tokens) ? (raw.usage!.input_tokens as number) : 0;
  const outputTokens = Number.isSafeInteger(raw.usage?.output_tokens) ? (raw.usage!.output_tokens as number) : 0;
  return { sentences, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}

/** The ONLY place a socket may be opened; callers must run providerAllowed() first. */
function callGeneratorEndpoint(endpoint: string, payload: unknown, timeoutMs: number): Promise<RawGeneratorResponse> {
  return new Promise((resolve, reject) => {
    const url = parseUrl(endpoint);
    if (!url) { reject(new Error("generator endpoint URL is malformed")); return; }
    const client = url.protocol === "https:" ? https : http;
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    let settled = false;
    const req = client.request(url, {
      method: "POST",
      timeout: timeoutMs,
      headers: { "content-type": "application/json", "content-length": String(body.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        if (settled) return;
        settled = true;
        try {
          if (!res.statusCode || res.statusCode >= 300) throw new Error(`generator endpoint responded with status ${res.statusCode}`);
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as RawGeneratorResponse);
        } catch (error) {
          reject(error instanceof Error ? error : new Error("malformed generator response"));
        }
      });
    });
    req.on("timeout", () => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`generator endpoint timed out after ${timeoutMs}ms`));
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.end(body);
  });
}

export interface ModelGeneratorConfig extends ProviderConfig {
  model: string;
  provider: string;
  timeoutMs?: number;
}

function generatorConfigHash(config: ModelGeneratorConfig): string {
  return sha256(stableStringify(config as unknown as Record<string, unknown>));
}

/** Local-first default real path (D5): an operator-configured local model server. */
export function localModelGenerator(config: ModelGeneratorConfig): ProseGenerator {
  const endpoint = config.endpoint ?? "http://127.0.0.1:11434/api/generate";
  return {
    identity: { model: config.model, provider: config.provider || "local", config_hash: generatorConfigHash(config) },
    async generate(input: ProseGeneratorInput): Promise<GeneratedProse> {
      if (!providerAllowed(config, endpoint)) throw new ProviderNotAllowedError(endpoint);
      const raw = await callGeneratorEndpoint(endpoint, input, config.timeoutMs ?? 10_000);
      return coerceGeneratedProse(raw);
    },
  };
}

/** Hosted path (D5/R6/AC8): inert without EXPLICIT opt-in; never dials without it. */
export function hostedModelGenerator(config: ModelGeneratorConfig): ProseGenerator {
  return {
    identity: { model: config.model, provider: config.provider, config_hash: generatorConfigHash(config) },
    async generate(input: ProseGeneratorInput): Promise<GeneratedProse> {
      const endpoint = config.endpoint;
      if (!endpoint || !providerAllowed(config, endpoint)) throw new ProviderNotAllowedError(endpoint ?? "(missing endpoint)");
      const raw = await callGeneratorEndpoint(endpoint, input, config.timeoutMs ?? 10_000);
      return coerceGeneratedProse(raw);
    },
  };
}

// ── Fail-closed orchestrator (D4) ────────────────────────────────────────────

export class GeneratorTimeoutError extends Error {
  readonly name = "GeneratorTimeoutError";
}

function withTimeout<T>(factory: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new GeneratorTimeoutError(`generator exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    Promise.resolve().then(factory).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function runtimeStatements(envelope: GroundedExecutionNarrative): Statement[] {
  const runtime = envelope.sections.find((section) => section.authority === "flow-agents" && section.kind === "runtime-projection");
  if (!runtime || runtime.authority !== "flow-agents") throw new Error("narrative prose renderer requires one runtime projection section");
  return [...runtime.embedded.turns.flatMap((turn) => turn.statements), ...runtime.embedded.document_statements];
}

function augmentWithSummaryStatements(envelope: GroundedExecutionNarrative, extra: Statement[]): GroundedExecutionNarrative {
  const clone = structuredClone(envelope);
  const runtime = clone.sections.find((section) => section.authority === "flow-agents" && section.kind === "runtime-projection");
  if (!runtime || runtime.authority !== "flow-agents") throw new Error("narrative prose renderer requires one runtime projection section");
  runtime.embedded.document_statements = [...runtime.embedded.document_statements, ...extra];
  return clone;
}

function buildSourceViews(narrativeDir: string, statements: readonly Statement[]): ProseSourceView[] {
  const refs = [...new Set(statements.flatMap((statement) => statement.source_refs))].sort();
  const views: ProseSourceView[] = [];
  for (const sourceRef of refs) {
    const resolved = resolveSource(narrativeDir, sourceRef);
    if (resolved.status !== "resolved") continue;
    let stream = "unknown";
    try { stream = parseSourceId(sourceRef).stream; } catch { /* best-effort label only */ }
    views.push({ source_ref: sourceRef, stream, content: Buffer.from(resolved.content).toString("utf8") });
  }
  return views;
}

function summarizeViolation(violation: GroundingViolation): string {
  const parts: string[] = [violation.code];
  if ("statement_id" in violation) parts.push(violation.statement_id);
  if ("source_ref" in violation) parts.push(violation.source_ref);
  if ("event_kind" in violation) parts.push(violation.event_kind);
  return parts.join(" ");
}

const ESTIMATED_COST_PER_1K_INPUT_TOKENS_USD = 0.0005;
const ESTIMATED_COST_PER_1K_OUTPUT_TOKENS_USD = 0.0015;

function estimateCost(usage: ProseGeneratorUsage): number {
  const cost = (usage.input_tokens / 1000) * ESTIMATED_COST_PER_1K_INPUT_TOKENS_USD
    + (usage.output_tokens / 1000) * ESTIMATED_COST_PER_1K_OUTPUT_TOKENS_USD;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export type ProseRenderOutcome = "accepted" | "generator_error" | "generator_timeout" | "validator_error" | "validator_reject";

export type ProseEconomicsRecord = EntailmentProvenance & {
  attempted_at: string;
  outcome: ProseRenderOutcome;
  detail?: string;
};

// Append-only local sink, mirroring writeEnvelope's envelope-lineage.jsonl discipline
// (O_APPEND|O_CREAT|O_WRONLY, mode 0600, no-follow). Recorded UNCONDITIONALLY on every
// generation attempt -- success or fallback (D6/AC6) -- and NEVER leaves narrativeDir.
function appendEconomics(narrativeDir: string, record: ProseEconomicsRecord): void {
  const file = path.join(narrativeDir, PROSE_ECONOMICS_FILE);
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe economics target at ${file}`);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(file, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | noFollow, 0o600);
  try { fs.writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, "utf8"); }
  finally { fs.closeSync(descriptor); }
}

export interface RenderProseOptions {
  compiledAt: string;
  outDir: string;
  generator: ProseGenerator;
  timeoutMs?: number;
}

export interface RenderProseResult {
  envelope: GroundedExecutionNarrative;
  written: WrittenGroundedNarrative;
  outcome: "prose_published" | "deterministic_only";
  reason?: string;
  prose?: { path: string; sha256: string };
  provenance: ProseEconomicsRecord;
}

/**
 * Fail-closed orchestrator (D4/LB1). The #613/#623 compose -> schema-validate ->
 * grounding-validate prefix is unchanged and still throws before ANY write on a
 * malformed/ungrounded envelope (nothing to attempt generation over). Once that
 * substrate is valid, the deterministic #613 output is ALWAYS written first (R4's
 * guarantee), then generation is attempted under a bounded timeout. ANY
 * generator error/timeout/validator error/reject leaves ZERO prose artifacts and
 * records economics for the attempt; only an accepted, re-validated, prose-augmented
 * statement set is published alongside the deterministic narrative.
 */
export async function renderProse(narrativeDir: string, opts: RenderProseOptions): Promise<RenderProseResult> {
  const envelope = composeGroundedNarrative(narrativeDir, { compiledAt: opts.compiledAt });
  const schemaIssues = validateGroundedNarrative(envelope);
  if (schemaIssues.length > 0) {
    throw new Error(`grounded execution narrative validation failed: ${schemaIssues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);
  }
  const baseGrounding = validateNarrativeGrounding(envelope, narrativeDir);
  if (!baseGrounding.ok) throw new NarrativeGroundingError(baseGrounding.violations);

  const written = writeEnvelope(narrativeDir, envelope, { outDir: opts.outDir, render: true });

  const statements = runtimeStatements(envelope);
  const sourceViews = buildSourceViews(narrativeDir, statements);
  const generatorInput: ProseGeneratorInput = { statements, sourceViews };
  const sourceHash = sha256(stableStringify(generatorInput as unknown as Record<string, unknown>));
  const attemptedAt = new Date().toISOString();
  const startedAt = process.hrtime.bigint();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const elapsedMs = (): number => Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

  const recordAndFallback = (outcome: ProseRenderOutcome, detail: string, usage: ProseGeneratorUsage, outputBytes: string): RenderProseResult => {
    const provenance: ProseEconomicsRecord = {
      ...opts.generator.identity,
      prompt_version: PROSE_PROMPT_VERSION,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      estimated_cost_usd: estimateCost(usage),
      wall_clock_ms: elapsedMs(),
      verdicts: [],
      source_hash: sourceHash,
      output_hash: sha256(outputBytes),
      attempted_at: attemptedAt,
      outcome,
      detail,
    };
    appendEconomics(narrativeDir, provenance);
    return { envelope, written, outcome: "deterministic_only", reason: detail, provenance };
  };

  let generated: GeneratedProse;
  try {
    generated = await withTimeout(() => opts.generator.generate(generatorInput), timeoutMs);
  } catch (error) {
    const isTimeout = error instanceof GeneratorTimeoutError;
    return recordAndFallback(
      isTimeout ? "generator_timeout" : "generator_error",
      error instanceof Error ? error.message : "generator failed",
      { input_tokens: 0, output_tokens: 0 },
      "",
    );
  }

  const outputBytes = stableStringify(generated as unknown as Record<string, unknown>);

  let summaryStatements: Statement[];
  let augmented: GroundedExecutionNarrative;
  try {
    summaryStatements = generated.sentences.map((sentence, index) => summarizerInferredConnective({
      id: `${written.envelopeSha256.slice(0, 12)}-prose-${index}`,
      proposition: sentence.text,
      source_refs: [...new Set(sentence.statement_refs)],
    }));
    augmented = augmentWithSummaryStatements(envelope, summaryStatements);
  } catch (error) {
    return recordAndFallback(
      "validator_error",
      error instanceof Error ? error.message : "summary statement construction failed",
      generated.usage,
      outputBytes,
    );
  }

  let proseGrounding: ReturnType<typeof validateNarrativeGrounding>;
  try {
    proseGrounding = validateNarrativeGrounding(augmented, narrativeDir);
  } catch (error) {
    return recordAndFallback(
      "validator_error",
      error instanceof Error ? error.message : "grounding validator raised",
      generated.usage,
      outputBytes,
    );
  }

  if (!proseGrounding.ok) {
    return recordAndFallback(
      "validator_reject",
      proseGrounding.violations.map(summarizeViolation).join("; "),
      generated.usage,
      outputBytes,
    );
  }

  // Accept: publish the prose artifact ALONGSIDE (never instead of) the deterministic
  // narrative. Content-addressed, wx create-only -- same discipline as writeEnvelope.
  const prosePayload = { statements: summaryStatements, sentences: generated.sentences };
  const proseBytes = Buffer.from(`${stableStringify(prosePayload as unknown as Record<string, unknown>)}\n`);
  const proseSha256 = sha256(proseBytes);
  const proseDir = path.resolve(opts.outDir);
  ensureSafeDirectory(proseDir, proseDir);
  const prosePath = path.join(proseDir, `${written.envelopeSha256}.prose.json`);
  try {
    fs.writeFileSync(prosePath, proseBytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = fs.lstatSync(prosePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing unsafe prose target at ${prosePath}`);
    const existing = fs.readFileSync(prosePath);
    if (!existing.equals(proseBytes)) throw new Error(`content-addressed prose artifact collision at ${prosePath}`);
  }

  const provenance: ProseEconomicsRecord = {
    ...opts.generator.identity,
    prompt_version: PROSE_PROMPT_VERSION,
    input_tokens: generated.usage.input_tokens,
    output_tokens: generated.usage.output_tokens,
    estimated_cost_usd: estimateCost(generated.usage),
    wall_clock_ms: elapsedMs(),
    verdicts: [],
    source_hash: sourceHash,
    output_hash: proseSha256,
    attempted_at: attemptedAt,
    outcome: "accepted",
  };
  appendEconomics(narrativeDir, provenance);
  return { envelope, written, outcome: "prose_published", prose: { path: prosePath, sha256: proseSha256 }, provenance };
}

// ── CLI verb ──────────────────────────────────────────────────────────────

function usage(): void {
  console.error(`usage: flow-agents narrative-render <render> [options]

render:
  --narrative-dir PATH --compiled-at DATE-TIME --out-dir DIR
  [--generator stub|local|hosted]   (default: stub)
  [--timeout-ms N]                  (default: 15000)
  [--model NAME] [--provider NAME] [--endpoint URL]
  [--opt-in-tenant ID --opt-in-data-residency REGION --opt-in-payload-policy POLICY]
    (required together to allow a non-local --endpoint; local endpoints never need opt-in)`);
}

function required(flags: ReturnType<typeof parseArgs>["flags"], name: string): string {
  const value = flagString(flags, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function buildGenerator(flags: ReturnType<typeof parseArgs>["flags"]): ProseGenerator {
  const kind = flagString(flags, "generator", "stub");
  if (kind === "stub" || !kind) return stubGenerator;
  if (kind !== "local" && kind !== "hosted") throw new Error(`unknown --generator: ${kind}`);
  const model = flagString(flags, "model") ?? "unconfigured-model";
  const provider = flagString(flags, "provider") ?? kind;
  const endpoint = flagString(flags, "endpoint");
  const timeoutRaw = flagString(flags, "timeout-ms");
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : undefined;
  const tenant = flagString(flags, "opt-in-tenant");
  const dataResidency = flagString(flags, "opt-in-data-residency");
  const payloadPolicy = flagString(flags, "opt-in-payload-policy");
  const optIn = tenant && dataResidency && payloadPolicy ? { tenant, data_residency: dataResidency, payload_policy: payloadPolicy } : undefined;
  const config: ModelGeneratorConfig = {
    model, provider,
    ...(endpoint ? { endpoint } : {}),
    ...(optIn ? { optIn } : {}),
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  };
  return kind === "local" ? localModelGenerator(config) : hostedModelGenerator(config);
}

async function render(flags: ReturnType<typeof parseArgs>["flags"]): Promise<number> {
  const narrativeDir = required(flags, "narrative-dir");
  const compiledAt = required(flags, "compiled-at");
  const outDir = required(flags, "out-dir");
  const generator = buildGenerator(flags);
  const timeoutRaw = flagString(flags, "timeout-ms");
  const timeoutMs = timeoutRaw ? Number.parseInt(timeoutRaw, 10) : undefined;
  const result = await renderProse(narrativeDir, {
    compiledAt, outDir, generator,
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
  });
  process.stdout.write(`${stableStringify({
    outcome: result.outcome,
    reason: result.reason,
    envelope_sha256: result.written.envelopeSha256,
    prose: result.prose,
    provenance: result.provenance,
  } as unknown as Record<string, unknown>)}\n`);
  return result.outcome === "prose_published" ? 0 : (result.outcome === "deterministic_only" ? 0 : 1);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const verb = args.positionals[0];
  try {
    if (verb === "render") return await render(args.flags);
    usage();
    return 64;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "narrative render command failed");
    return 64;
  }
}
