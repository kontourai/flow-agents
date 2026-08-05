import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const api = await import(pathToFileURL(path.join(root, "build/src/index.js")));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha8 = (bytes) => sha256(bytes).slice(0, 8);
const CAPTURED_AT = "2026-07-14T15:00:00.000Z";
const COMPILED_AT = "2026-07-14T16:00:00.000Z";

function buildNarrativeDir(tmp) {
  const sessionDir = path.join(tmp, "session");
  fs.mkdirSync(sessionDir, { recursive: true });
  const commandLine = JSON.stringify({ command: "npm test", result: "fail", exitCode: 1 });
  fs.writeFileSync(path.join(sessionDir, "command-log.jsonl"), `${commandLine}\n`);
  const narrativeDir = path.join(tmp, "narrative");
  api.snapshotNarrative({
    narrativeDir,
    narrativeId: "prose-render-unit",
    redactionFields: [],
    compiler: { name: "prose-render-unit", version: "1", policy_hash: "fixture" },
    captureCompleteness: { channels: { full: "active" }, known_gaps: [] },
    requests: [{
      source: api.parseSourceId(`fa1:cmdlog:session:line-1/${sha8(Buffer.from(commandLine))}`),
      roots: { sessionDir },
    }],
  }, { now: () => CAPTURED_AT });
  return narrativeDir;
}

function neverResolvingGenerator() {
  return { identity: { model: "never", provider: "test", config_hash: "x" }, generate: () => new Promise(() => {}) };
}

function throwingGenerator(message = "generator boom") {
  return {
    identity: { model: "throws", provider: "test", config_hash: "x" },
    async generate() { throw new Error(message); },
  };
}

function unsupportedGenerator() {
  return {
    identity: { model: "unsupported", provider: "test", config_hash: "x" },
    async generate() {
      return {
        sentences: [{ text: "The run silently succeeded despite issues", statement_refs: ["fa1:flow-state:absent:state/00000000"] }],
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
}

function readEconomics(narrativeDir) {
  const file = path.join(narrativeDir, api.PROSE_ECONOMICS_FILE);
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("#614 success: stub generator publishes prose alongside the deterministic narrative", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-render-success-"));
  try {
    const narrativeDir = buildNarrativeDir(tmp);
    const outDir = path.join(tmp, "out");
    const result = await api.renderProse(narrativeDir, { compiledAt: COMPILED_AT, outDir, generator: api.stubGenerator });
    assert.equal(result.outcome, "prose_published");
    assert.ok(result.prose);
    assert.ok(fs.existsSync(result.written.envelopePath), "deterministic envelope must exist");
    assert.ok(fs.existsSync(result.written.renderPath), "deterministic markdown must exist");
    assert.ok(fs.existsSync(result.prose.path), "prose artifact must exist");

    const proseDoc = JSON.parse(fs.readFileSync(result.prose.path, "utf8"));
    assert.ok(proseDoc.statements.length > 0, "at least one summary statement was published");
    for (const statement of proseDoc.statements) assert.equal(statement.class, "summarizer_inferred");

    // LB2: original atomic statements in the (unaugmented) written envelope keep their class.
    const runtime = result.envelope.sections.find((section) => section.authority === "flow-agents");
    const atomicClasses = new Set(
      [...runtime.embedded.turns.flatMap((turn) => turn.statements), ...runtime.embedded.document_statements].map((statement) => statement.class),
    );
    assert.ok([...atomicClasses].every((cls) => cls === "observed" || cls === "deterministic_derived"));

    const economics = readEconomics(narrativeDir);
    assert.equal(economics.length, 1);
    assert.equal(economics[0].outcome, "accepted");
    assert.equal(typeof economics[0].source_hash, "string");
    assert.equal(typeof economics[0].output_hash, "string");
    assert.ok(economics[0].input_tokens > 0);
    assert.ok(economics[0].output_tokens > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("#614 fail-closed: generator timeout writes zero prose artifacts and records economics", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-render-timeout-"));
  try {
    const narrativeDir = buildNarrativeDir(tmp);
    const outDir = path.join(tmp, "out");
    const result = await api.renderProse(narrativeDir, {
      compiledAt: COMPILED_AT, outDir, generator: neverResolvingGenerator(), timeoutMs: 25,
    });
    assert.equal(result.outcome, "deterministic_only");
    assert.ok(fs.existsSync(result.written.envelopePath), "deterministic envelope must still exist");
    const proseFiles = fs.readdirSync(outDir).filter((name) => name.endsWith(".prose.json"));
    assert.deepEqual(proseFiles, [], "zero prose artifacts on timeout");

    const economics = readEconomics(narrativeDir);
    assert.equal(economics.length, 1);
    assert.equal(economics[0].outcome, "generator_timeout");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("#614 fail-closed: generator error writes zero prose artifacts and records economics", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-render-error-"));
  try {
    const narrativeDir = buildNarrativeDir(tmp);
    const outDir = path.join(tmp, "out");
    const result = await api.renderProse(narrativeDir, { compiledAt: COMPILED_AT, outDir, generator: throwingGenerator("boom-614") });
    assert.equal(result.outcome, "deterministic_only");
    assert.match(result.reason, /boom-614/);
    const proseFiles = fs.readdirSync(outDir).filter((name) => name.endsWith(".prose.json"));
    assert.deepEqual(proseFiles, [], "zero prose artifacts on generator error");

    const economics = readEconomics(narrativeDir);
    assert.equal(economics.length, 1);
    assert.equal(economics[0].outcome, "generator_error");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("#614 fail-closed: an unsupported/unresolved summary is rejected and writes zero prose artifacts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-render-reject-"));
  try {
    const narrativeDir = buildNarrativeDir(tmp);
    const outDir = path.join(tmp, "out");
    const result = await api.renderProse(narrativeDir, { compiledAt: COMPILED_AT, outDir, generator: unsupportedGenerator() });
    assert.equal(result.outcome, "deterministic_only");
    assert.match(result.reason, /unresolved_citation|unsupported_summary/);
    const proseFiles = fs.readdirSync(outDir).filter((name) => name.endsWith(".prose.json"));
    assert.deepEqual(proseFiles, [], "zero prose artifacts on validator reject");
    // The forbidden claim never reaches disk anywhere under outDir or the narrative dir sink.
    const combined = [
      ...fs.readdirSync(outDir).map((name) => fs.readFileSync(path.join(outDir, name), "utf8")),
      fs.readFileSync(path.join(narrativeDir, api.PROSE_ECONOMICS_FILE), "utf8"),
    ].join("\n");
    assert.doesNotMatch(combined, /silently succeeded/);

    const economics = readEconomics(narrativeDir);
    assert.equal(economics.length, 1);
    assert.equal(economics[0].outcome, "validator_reject");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("#614 economics-always: every attempted outcome kind appends exactly one provenance record", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "narrative-render-economics-"));
  try {
    const narrativeDir = buildNarrativeDir(tmp);
    await api.renderProse(narrativeDir, { compiledAt: COMPILED_AT, outDir: path.join(tmp, "out-1"), generator: api.stubGenerator });
    await api.renderProse(narrativeDir, { compiledAt: COMPILED_AT, outDir: path.join(tmp, "out-2"), generator: throwingGenerator() });
    const economics = readEconomics(narrativeDir);
    assert.equal(economics.length, 2);
    assert.deepEqual(economics.map((record) => record.outcome).sort(), ["accepted", "generator_error"]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Provider gate (D5/R6/AC8) ────────────────────────────────────────────────

test("#614 provider gate: a local endpoint is allowed with no opt-in", () => {
  assert.equal(api.providerAllowed({}, "http://127.0.0.1:11434/api/generate"), true);
  assert.equal(api.providerAllowed({}, "http://localhost:11434/api/generate"), true);
});

test("#614 provider gate: a non-local endpoint is refused without opt-in, and opt-in requires all three fields", () => {
  const endpoint = "https://model-provider.example/v1/generate";
  assert.equal(api.providerAllowed({}, endpoint), false);
  assert.equal(api.providerAllowed({ optIn: { tenant: "acme" } }, endpoint), false, "partial opt-in must still be refused");
  assert.equal(api.providerAllowed({ optIn: { tenant: "acme", data_residency: "us", payload_policy: "redacted-only" } }, endpoint), true);
});

test("#614 provider gate: hosted generator is inert without opt-in and never attempts a socket", async () => {
  // A non-routable TEST-NET-1 address (RFC 5737): any real connection attempt would hang
  // until a TCP-level timeout (seconds). A providerAllowed()-gated rejection instead
  // resolves in milliseconds, proving the check runs BEFORE any dial is attempted.
  const generator = api.hostedModelGenerator({ model: "hosted-test", provider: "hosted", endpoint: "https://192.0.2.1/generate", timeoutMs: 5000 });
  const startedAt = Date.now();
  await assert.rejects(
    generator.generate({ statements: [], sourceViews: [] }),
    (error) => error instanceof api.ProviderNotAllowedError,
  );
  assert.ok(Date.now() - startedAt < 2000, "hosted generator must reject before any network dial, not after a connection timeout");
});

test("#614 provider gate: hosted generator proceeds to dial only once fully opted in (still fails fast against an unroutable test address)", async () => {
  const generator = api.hostedModelGenerator({
    model: "hosted-test",
    provider: "hosted",
    endpoint: "http://127.0.0.1:1", // local, allowed unconditionally; nothing listens there.
    timeoutMs: 500,
  });
  await assert.rejects(generator.generate({ statements: [], sourceViews: [] }));
});

// ── Display-only isolation (D9/LB8) ──────────────────────────────────────────

test("#614 D9: narrative-render.ts imports no continuation-* module", () => {
  const source = fs.readFileSync(path.join(root, "src/cli/narrative-render.ts"), "utf8");
  assert.doesNotMatch(source, /(?:from|import|require)\s*\(?\s*["'`][^"'`]*continuation-[^"'`]*["'`]/);
});
