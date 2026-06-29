import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { TelemetrySink } from "../src/telemetry.js";
import { extractModelUsage } from "../src/hooks.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpSink = () => new TelemetrySink({ workspace: fs.mkdtempSync(path.join(os.tmpdir(), "ts-usage-")) });

test("emitUsage writes tokens + cost + pricing_version + by_model", () => {
  const ev = tmpSink().emitUsage({
    model: "claude-opus-4-8",
    inputTokens: 1000,
    outputTokens: 2000,
    cacheReadInputTokens: 500000,
    byModel: [{ model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 500000 }]
  } as any);
  const u = ev.usage as any;
  assert.equal(u.input_tokens, 1000);
  assert.equal(u.output_tokens, 2000);
  assert.equal(u.cache_read_input_tokens, 500000);
  assert.equal(u.pricing_version, "2026-06-28");
  assert.equal(u.estimated_cost_usd, 0.305); // (1000*5 + 2000*25 + 500000*5*0.1)/1e6
  assert.equal(u.by_model[0].model, "claude-opus-4-8");
});

test("emitUsage multi-model sums + prices each", () => {
  const ev = tmpSink().emitUsage({
    outputTokens: 2000,
    byModel: [
      { model: "claude-opus-4-8", outputTokens: 1000 },
      { model: "claude-haiku-4-5", outputTokens: 1000 }
    ]
  } as any);
  const u = ev.usage as any;
  const costs: Record<string, number> = Object.fromEntries(u.by_model.map((m: any) => [m.model, m.estimated_cost_usd]));
  assert.equal(costs["claude-opus-4-8"], 0.025);
  assert.equal(costs["claude-haiku-4-5"], 0.005);
  assert.equal(u.estimated_cost_usd, 0.03);
});

test("extractModelUsage reads usage from varied event shapes", () => {
  assert.deepEqual(
    extractModelUsage({ model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 } } as any),
    { model: "claude-opus-4-8", input: 10, output: 20, cacheCreation: 0, cacheRead: 30 }
  );
  // camelCase + modelId
  const camel = extractModelUsage({ modelId: "claude-haiku-4-5", usage: { inputTokens: 5, outputTokens: 6 } } as any);
  assert.equal(camel?.model, "claude-haiku-4-5");
  assert.equal(camel?.input, 5);
  // nested response carrier
  const nested = extractModelUsage({ response: { model: "claude-fable-5", usage: { output_tokens: 100 } } } as any);
  assert.equal(nested?.model, "claude-fable-5");
  assert.equal(nested?.output, 100);
  // no usage / all-zero → null
  assert.equal(extractModelUsage({ model: "x" } as any), null);
  assert.equal(extractModelUsage({ model: "x", usage: { input_tokens: 0, output_tokens: 0 } } as any), null);
});

test("cross-runtime golden vectors (TS sink prices identically)", () => {
  const candidates = [
    path.join(here, "../../../../scripts/telemetry/pricing.golden.json"),
    path.join(here, "../../../scripts/telemetry/pricing.golden.json"),
    path.join(process.cwd(), "../../scripts/telemetry/pricing.golden.json")
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  assert.ok(file, "pricing.golden.json not found");
  const golden = JSON.parse(fs.readFileSync(file!, "utf8"));
  const sink = tmpSink();
  for (const c of golden.cases) {
    const ev = sink.emitUsage({
      byModel: [{
        model: c.model,
        inputTokens: c.tokens.input,
        outputTokens: c.tokens.output,
        cacheCreationInputTokens: c.tokens.cache_creation,
        cacheReadInputTokens: c.tokens.cache_read
      }]
    } as any);
    assert.equal((ev.usage as any).estimated_cost_usd, c.expected_cost_usd, `golden ${c.name} (${c.model})`);
  }
});
