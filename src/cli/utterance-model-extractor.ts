import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createDispatchRuntime, type DispatchReceipt } from "@kontourai/dispatch";
import {
  createAnthropicRuntime,
  type AnthropicMessagesClient,
} from "@kontourai/relay/anthropic";
import type { ModelRuntime } from "@kontourai/relay";

export interface ExtractedUtteranceStatement {
  target: { subjectType: string; subjectId: string; fieldOrBehavior: string };
  value?: unknown;
  excerpt: string;
  span?: { start: number; end: number };
  confidence: number;
}

export interface UtteranceModelExtractorOptions {
  model: string;
  fallbackModels?: readonly string[];
  apiKey?: string;
  baseUrl?: string;
  maxAttempts?: number;
  receiptPath?: string;
  client?: AnthropicMessagesClient;
}

export interface UtteranceRuntimeCandidate {
  id: string;
  runtime: ModelRuntime;
}

export interface UtteranceRuntimeCompositionOptions {
  candidates: readonly UtteranceRuntimeCandidate[];
  maxAttempts?: number;
  receiptPath?: string;
  /** Prompt-enforced structured output is lower fidelity and requires explicit opt-in. */
  allowPromptedStructuredOutput?: boolean;
}

const TOOL_NAME = "submit_extracted_statements";
const TOOL = {
  name: TOOL_NAME,
  description:
    "Submit factual statements extracted from an agent utterance for review, with exact provenance and confidence.",
  inputSchema: {
    type: "object",
    properties: {
      statements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            subjectType: { type: "string" },
            subjectId: { type: "string" },
            fieldOrBehavior: { type: "string" },
            value: {},
            excerpt: { type: "string" },
            spanStart: { type: "number" },
            spanEnd: { type: "number" },
            confidence: { type: "number" },
          },
          required: ["subjectId", "fieldOrBehavior", "excerpt", "confidence"],
        },
      },
    },
    required: ["statements"],
  },
} as const;

/** Producer-owned model extractor; Survey only receives its normalized output. */
export function createRuntimeUtteranceExtractor(runtime: ModelRuntime) {
  return {
    name: `flow-agents-utterance-extractor:${runtime.id}`,
    async extract(utterance: string): Promise<ExtractedUtteranceStatement[]> {
      const result = await runtime.invoke({
        messages: [
          {
            role: "system",
            content: [
              "Extract factual claims from the agent utterance for review.",
              "Do not decide whether a claim is true.",
              "Extract only factual properties of named entities; skip opinions, predictions, and procedures.",
              "Include the exact excerpt, zero-based character offsets, and an honest confidence score.",
            ].join("\n"),
          },
          {
            role: "user",
            content: `Extract factual statements from this agent utterance:\n\n${utterance}`,
          },
        ],
        tools: [TOOL],
        toolChoice: { type: "tool", name: TOOL_NAME },
        maxOutputTokens: 2048,
      });
      const input = result.toolCalls.find((call) => call.name === TOOL_NAME)?.input;
      return parseStatements(input, utterance);
    },
  };
}

/** Anthropic-compatible composition option for the generic runtime extractor. */
export function createUtteranceModelExtractor(options: UtteranceModelExtractorOptions) {
  return createRuntimeUtteranceExtractor(createRuntime(options));
}

/** Compose the same producer definition over one runtime or an ordered Dispatch plan. */
export function createProfiledUtteranceExtractor(options: UtteranceRuntimeCompositionOptions) {
  if (options.candidates.length === 0) throw new Error("At least one runtime candidate is required");
  if (options.candidates.length === 1 && options.maxAttempts === undefined && !options.receiptPath) {
    return createRuntimeUtteranceExtractor(options.candidates[0]!.runtime);
  }
  const runtimes = new Map(options.candidates.map(({ id, runtime }) => [id, runtime]));
  const candidates = options.candidates.map(({ id, runtime }) => ({
    id,
    runtimeId: id,
    evidence: {
      level: "declared" as const,
      capabilities: ["structured-tools", "abort", "usage"],
      structuredToolsFidelity: runtime.capabilities().structuredToolsFidelity,
    },
  }));
  const runtime = createDispatchRuntime({
    id: "flow-agents-utterance-dispatch",
    capabilities: {
      structuredTools: true,
      streaming: false,
      abort: true,
      usage: true,
    },
    runtimes,
    plan: {
      schemaVersion: 1,
      role: "utterance-extraction",
      candidates,
      budget: { maxAttempts: options.maxAttempts ?? candidates.length },
      policy: {
        retryRuntimeFailures: true,
        minimumStructuredToolsFidelity: options.allowPromptedStructuredOutput ? "prompted" : "native",
      },
    },
    ...(options.receiptPath
      ? { onReceipt: (receipt: DispatchReceipt) => persistReceipt(options.receiptPath!, receipt) }
      : {}),
  });
  return createRuntimeUtteranceExtractor(runtime);
}

function createRuntime(options: UtteranceModelExtractorOptions): ModelRuntime {
  const models = [options.model, ...(options.fallbackModels ?? [])];
  const runtimes = new Map<string, ModelRuntime>();
  models.forEach((model, index) => {
    runtimes.set(
      `runtime-${index}`,
      createAnthropicRuntime({
        model,
        ...(options.client ? { client: options.client } : {}),
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      }),
    );
  });
  const useDispatch =
    models.length > 1 || options.maxAttempts !== undefined || options.receiptPath !== undefined;
  if (!useDispatch) return runtimes.get("runtime-0")!;

  const candidates = models.map((_, index) => ({
    id: `candidate-${index}`,
    runtimeId: `runtime-${index}`,
    evidence: {
      level: "declared" as const,
      capabilities: ["structured-tools", "abort", "usage"],
      structuredToolsFidelity: runtimes.get(`runtime-${index}`)!.capabilities().structuredToolsFidelity,
    },
  }));
  return createDispatchRuntime({
    id: "flow-agents-utterance-dispatch",
    capabilities: {
      structuredTools: true,
      streaming: false,
      abort: true,
      usage: true,
    },
    runtimes,
    plan: {
      schemaVersion: 1,
      role: "utterance-extraction",
      candidates,
      budget: { maxAttempts: options.maxAttempts ?? candidates.length },
      policy: { retryRuntimeFailures: true, minimumStructuredToolsFidelity: "native" },
    },
    ...(options.receiptPath
      ? { onReceipt: (receipt: DispatchReceipt) => persistReceipt(options.receiptPath!, receipt) }
      : {}),
  });
}

async function persistReceipt(receiptPath: string, receipt: DispatchReceipt): Promise<void> {
  const resolved = path.resolve(receiptPath);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await appendFile(resolved, `${JSON.stringify(receipt)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function parseStatements(input: unknown, utterance: string): ExtractedUtteranceStatement[] {
  if (!isRecord(input) || !Array.isArray(input.statements)) return [];
  return input.statements.flatMap((item) => {
    if (!isRecord(item)) return [];
    const subjectId = nonEmptyString(item.subjectId);
    const fieldOrBehavior = nonEmptyString(item.fieldOrBehavior);
    const excerpt = nonEmptyString(item.excerpt);
    const confidence = finiteConfidence(item.confidence);
    if (!subjectId || !fieldOrBehavior || !excerpt || confidence === undefined) return [];
    const span = validSpan(item.spanStart, item.spanEnd, utterance.length);
    return [
      {
        target: {
          subjectType: nonEmptyString(item.subjectType) ?? "unknown",
          subjectId,
          fieldOrBehavior,
        },
        ...(item.value === undefined ? {} : { value: item.value }),
        excerpt,
        ...(span ? { span } : {}),
        confidence,
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function finiteConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function validSpan(start: unknown, end: unknown, length: number) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return undefined;
  const from = start as number;
  const to = end as number;
  return from >= 0 && to > from && to <= length ? { start: from, end: to } : undefined;
}
