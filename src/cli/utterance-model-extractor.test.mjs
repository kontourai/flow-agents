import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRuntimeUtteranceExtractor,
  createUtteranceModelExtractor,
} from "../../build/src/cli/utterance-model-extractor.js";

const utterance = "Camp Alpha has 40 openings.";
const toolInput = {
  statements: [
    {
      subjectType: "camp",
      subjectId: "alpha",
      fieldOrBehavior: "openings",
      value: 40,
      excerpt: utterance,
      spanStart: 0,
      spanEnd: utterance.length,
      confidence: 0.94,
    },
  ],
};

test("generic extractor accepts any Relay ModelRuntime", async () => {
  const requests = [];
  const extractor = createRuntimeUtteranceExtractor({
    id: "fixture-runtime",
    capabilities: () => ({ structuredTools: true, streaming: false, abort: true, usage: true }),
    async invoke(request) {
      requests.push(request);
      return {
        provider: "fixture",
        model: "fixture-model",
        outputText: "",
        toolCalls: [{ id: "tool-1", name: "submit_extracted_statements", input: toolInput }],
        usage: { totalTokens: 7 },
        latencyMs: 1,
      };
    },
  });

  const statements = await extractor.extract(utterance);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].toolChoice.name, "submit_extracted_statements");
  assert.deepEqual(statements, [
    {
      target: { subjectType: "camp", subjectId: "alpha", fieldOrBehavior: "openings" },
      value: 40,
      excerpt: utterance,
      span: { start: 0, end: utterance.length },
      confidence: 0.94,
    },
  ]);
});

test("Dispatch falls back and persists only opaque runtime identifiers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flow-utterance-dispatch-"));
  const receiptPath = path.join(root, "receipts.ndjson");
  const fixtureCredential = ["fixture", "credential"].join(":");
  const client = {
    async create(params) {
      if (params.model === "primary-model") {
        const error = new Error("primary unavailable");
        error.status = 503;
        throw error;
      }
      return {
        model: params.model,
        content: [
          {
            type: "tool_use",
            id: "tool-2",
            name: "submit_extracted_statements",
            input: toolInput,
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 5, output_tokens: 3 },
      };
    },
  };

  try {
    const extractor = createUtteranceModelExtractor({
      model: "primary-model",
      fallbackModels: ["fallback-model"],
      apiKey: fixtureCredential,
      baseUrl: "https://private-runtime.invalid",
      receiptPath,
      client,
    });
    const statements = await extractor.extract(utterance);
    assert.equal(statements.length, 1);
    const receipt = await readFile(receiptPath, "utf8");
    assert.match(receipt, /"outcome":"succeeded"/);
    assert.match(receipt, /"candidateId":"candidate-1"/);
    assert.doesNotMatch(receipt, /primary-model|fallback-model/);
    assert.doesNotMatch(receipt, /private-runtime|fixture:credential/);
    assert.doesNotMatch(receipt, /Camp Alpha/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
