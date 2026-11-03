// The dream run's model path (#671): a Datum role, routed through Dispatch, over a Relay runtime.
// No provider SDK is reached: the runtime is Relay's FakeModelRuntime.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { FakeModelRuntime } from "@kontourai/relay";
import { distillMemoryClaims } from "../../kits/knowledge/adapters/memory-claims/index.mjs";
import { createRelayExtractionProvider, createRoleRuntime, extractForRuntime } from "../../kits/knowledge/dream/model.js";
import { runDream } from "../../kits/knowledge/dream/run.js";
import { CANARIES, FakeCorpusStore, fakeRelayClaims, hostFor, noApplyStore, runOptions, workspace } from "./dream-support.mjs";

const CLAIM = { quote: "I switched to banker's rounding on the total.", subject: "ledger service", subjectType: "service", property: "rounding mode", value: "banker's rounding", posture: "stated" };
const datum = (extra = {}) => ({
  config: { providers: { fake: { kind: "anthropic-compatible", auth: { env: "DREAM_TEST_KEY" }, models: ["m1"] } }, roles: { "extraction-default": "m1@fake", ...extra } },
  env: { DREAM_TEST_KEY: "not-a-real-key" },
});
const SITTING = {
  sittingId: "codex:s:0",
  turns: [
    { role: "user", text: "Ledger totals drift by a cent.", at: "2026-10-31T14:00:01.100Z" },
    { role: "assistant", text: "Rounding happens per line item; I switched to banker's rounding on the total.", at: "2026-10-31T14:00:06.000Z" },
  ],
};

test("a Datum role routes through Dispatch to a Relay runtime and comes back as grounded claims", async () => {
  const fake = fakeRelayClaims([CLAIM]);
  const receipts = [];
  let built;
  const runtime = await createRoleRuntime({
    role: "extraction-default", resolveOptions: datum(), onReceipt: (receipt) => receipts.push(receipt),
    createRuntime: (target, credentials) => { built = { target, credentials }; return fake; },
  });
  assert.equal(built.target.provider, "fake");
  assert.equal(built.target.model, "m1");
  assert.equal(built.target.auth.ref, "DREAM_TEST_KEY");
  assert.equal(JSON.stringify(built.target).includes("not-a-real-key"), false, "the resolved target carries no credential");

  const result = await distillMemoryClaims({ sitting: SITTING, extract: await extractForRuntime(runtime), passes: 2 });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].value, "banker's rounding");
  assert.deepEqual(result.agreement[result.claims[0].id], { passes: 2, agreeing: 2 });
  assert.equal(fake.physicalInvocationCount, 2, "one provider call per extraction pass");
  assert.equal(receipts.length, 2, "Dispatch saw, and receipted, every call");
  assert.ok(receipts.every((receipt) => receipt.outcome === "succeeded" && receipt.role === "extraction-default"));

  const [request] = fake.requests;
  assert.equal(request.toolChoice.type, "tool");
  assert.equal(request.tools[0].name, "submit_extraction_proposals");
  const prompt = request.messages[0].content;
  assert.match(prompt, /untrusted text/);
  assert.match(prompt, /banker's rounding/);
});

test("a role whose credential is unavailable fails before any runtime is built", async () => {
  let built = false;
  await assert.rejects(
    () => createRoleRuntime({ role: "extraction-default", resolveOptions: { ...datum(), env: {} }, createRuntime: () => { built = true; return new FakeModelRuntime([]); } }),
    (error) => error.code === "DREAM_MODEL_UNAVAILABLE",
  );
  assert.equal(built, false);
});

test("an unconfigured role is refused by Datum, and a provider kind with no Relay runtime is refused by name", async () => {
  await assert.rejects(() => createRoleRuntime({ role: "no-such-role", resolveOptions: datum() }));
  const openai = { config: { providers: { oai: { kind: "openai-compatible", auth: { env: "DREAM_TEST_KEY" }, models: ["m1"] } }, roles: { "extraction-default": "m1@oai" } }, env: { DREAM_TEST_KEY: "x" } };
  await assert.rejects(() => createRoleRuntime({ role: "extraction-default", resolveOptions: openai }), (error) => error.code === "DREAM_MODEL_UNSUPPORTED");
});

test("Dispatch enforces the token budget: a call that overruns it is terminal and yields no claims", async () => {
  const fake = fakeRelayClaims([CLAIM]);
  const receipts = [];
  const runtime = await createRoleRuntime({ role: "extraction-default", resolveOptions: datum(), maxTotalTokens: 10, onReceipt: (r) => receipts.push(r), createRuntime: () => fake });
  const result = await distillMemoryClaims({ sitting: SITTING, extract: await extractForRuntime(runtime), passes: 1 });
  assert.equal(result.claims.length, 0);
  assert.match(result.warnings.join("\n"), /pass 1 (failed|reported)/);
  assert.equal(receipts[0].outcome, "budget-exceeded");
});

test("the Relay shim reports what the runtime did: no tool call and a truncated response are warnings, not silence", async () => {
  const none = new FakeModelRuntime([{ provider: "fake", model: "m", outputText: "", toolCalls: [], usage: {}, latencyMs: 1, stopReason: "end_turn" }]);
  const provider = await createRelayExtractionProvider({ runtime: none });
  const out = await provider.extract({ content: "x", contentType: "text", targetSchema: [{ path: "a", type: "string" }] });
  assert.deepEqual(out.proposals, []);
  assert.match(out.warnings.join("\n"), /no extraction tool call/);
  const cut = new FakeModelRuntime([{ provider: "fake", model: "m", outputText: "", toolCalls: [{ id: "1", name: "submit_extraction_proposals", input: { proposals: [] } }], usage: {}, latencyMs: 1, stopReason: "max_tokens" }]);
  const truncated = await (await createRelayExtractionProvider({ runtime: cut })).extract({ content: "x", contentType: "text", targetSchema: [{ path: "a", type: "string" }] });
  assert.match(truncated.warnings.join("\n"), /truncated/);
});

test("layer 2 of the redaction defence: no secret-shaped canary reaches the model, and the report counts the scrub markers", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl", "claude-project.jsonl"] });
  t.after(ws.cleanup);
  const fake = fakeRelayClaims([CLAIM]);
  const runtime = await createRoleRuntime({ role: "extraction-default", resolveOptions: datum(), createRuntime: () => fake });
  const store = new FakeCorpusStore(ws.memoryRoot);
  const host = hostFor(ws, noApplyStore(store), await extractForRuntime(runtime));
  const report = await runDream(host, runOptions(ws));

  assert.ok(fake.requests.length >= 4, "the model was reached for each sitting");
  const sent = JSON.stringify(fake.requests);
  for (const [name, value] of Object.entries(CANARIES)) assert.equal(sent.includes(value), false, `${name} reached the model`);
  assert.match(sent, /<SECRET>/);
  assert.ok(report.redaction_hits >= 2);
  // The transcript tells the distiller to keep a token verbatim. That is text, not an instruction: it changes nothing.
  const proposals = await store.listProposals();
  assert.ok(proposals.every((proposal) => proposal.state === "pending"));
  assert.equal(proposals.some((proposal) => /<SECRET>|__CANARY/.test(proposal.candidate.body) && Object.values(CANARIES).some((value) => proposal.candidate.body.includes(value))), false);
  assert.equal(fs.readFileSync(ws.telemetryFile, "utf8").includes("canary"), false);
});

test("a model outage through the role runtime fails the run and holds the cursor", async (t) => {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const down = new FakeModelRuntime(Array.from({ length: 8 }, () => ({ code: "PROVIDER_UNAVAILABLE", message: "down", retryable: true })));
  const runtime = await createRoleRuntime({ role: "extraction-default", resolveOptions: datum(), createRuntime: () => down });
  const host = hostFor(ws, noApplyStore(new FakeCorpusStore(ws.memoryRoot)), await extractForRuntime(runtime));
  await assert.rejects(() => runDream(host, runOptions(ws)), (error) => error.code === "DREAM_DISTILL_FAILED");
  assert.equal(fs.existsSync(ws.cursorFile), false);
});
