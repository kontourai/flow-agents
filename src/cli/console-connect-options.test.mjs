// Unit tests for src/lib/console-connect-options.ts (install-flow-console-connect
// PR2, AC-G1/AC-G3/AC-REGRESSION): the pure decision logic behind the guided
// "Connect to Kontour Console?" wizard.
//
// Loaded from the built JS (mirrors src/cli/console-telemetry-validate.test.mjs's
// import-from-build convention, testing a src/lib/ module from src/cli/).
// Run: `npm run test:unit`, or directly after `npm run build`:
//   node --test src/cli/console-connect-options.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeConsoleConnectChoice,
  mapConsoleConnectChoiceToSinks,
  needsConsoleUrlPrompt,
  needsConsoleCredentialPrompts,
  resolveSelfHostedUrlOrFallback,
  runConsoleConnectWizard,
  describeConsoleStatus,
  buildPostInstallSummaryLines,
} from "../../build/src/lib/console-connect-options.js";

// --- normalizeConsoleConnectChoice ---

test("normalizeConsoleConnectChoice: each accepted spelling for hosted", () => {
  for (const answer of ["hosted", "Hosted", "HOSTED", "h", "H"]) {
    assert.equal(normalizeConsoleConnectChoice(answer, "skip"), "hosted", `answer=${answer}`);
  }
});

test("normalizeConsoleConnectChoice: each accepted spelling for local", () => {
  for (const answer of ["local", "Local", "l", "L"]) {
    assert.equal(normalizeConsoleConnectChoice(answer, "skip"), "local", `answer=${answer}`);
  }
});

test("normalizeConsoleConnectChoice: each accepted spelling for self-hosted", () => {
  for (const answer of ["self-hosted", "Self-Hosted", "selfhosted", "self", "s", "S"]) {
    assert.equal(normalizeConsoleConnectChoice(answer, "skip"), "self-hosted", `answer=${answer}`);
  }
});

test("normalizeConsoleConnectChoice: each accepted spelling for skip", () => {
  for (const answer of ["skip", "Skip", "none", "n", "N"]) {
    assert.equal(normalizeConsoleConnectChoice(answer, "hosted"), "skip", `answer=${answer}`);
  }
});

test("normalizeConsoleConnectChoice: blank falls back to fallback", () => {
  assert.equal(normalizeConsoleConnectChoice("", "hosted"), "hosted");
  assert.equal(normalizeConsoleConnectChoice("   ", "local"), "local");
});

test("normalizeConsoleConnectChoice: garbage falls back to fallback", () => {
  assert.equal(normalizeConsoleConnectChoice("banana", "hosted"), "hosted");
  assert.equal(normalizeConsoleConnectChoice("yes please", "skip"), "skip");
});

// --- mapConsoleConnectChoiceToSinks ---

test("mapConsoleConnectChoiceToSinks: all four choices map to the specified sink arrays", () => {
  assert.deepEqual(mapConsoleConnectChoiceToSinks("hosted"), ["kontour-hosted-console"]);
  assert.deepEqual(mapConsoleConnectChoiceToSinks("local"), ["local-kontour-console"]);
  assert.deepEqual(mapConsoleConnectChoiceToSinks("self-hosted"), ["user-hosted-console"]);
  assert.deepEqual(mapConsoleConnectChoiceToSinks("skip"), ["local-files"]);
});

// --- needsConsoleUrlPrompt / needsConsoleCredentialPrompts ---

test("needsConsoleUrlPrompt: true only for self-hosted", () => {
  assert.equal(needsConsoleUrlPrompt("self-hosted"), true);
  assert.equal(needsConsoleUrlPrompt("hosted"), false);
  assert.equal(needsConsoleUrlPrompt("local"), false);
  assert.equal(needsConsoleUrlPrompt("skip"), false);
});

test("needsConsoleCredentialPrompts: true for hosted/local/self-hosted, false for skip", () => {
  assert.equal(needsConsoleCredentialPrompts("hosted"), true);
  assert.equal(needsConsoleCredentialPrompts("local"), true);
  assert.equal(needsConsoleCredentialPrompts("self-hosted"), true);
  assert.equal(needsConsoleCredentialPrompts("skip"), false);
});

// --- resolveSelfHostedUrlOrFallback ---

test("resolveSelfHostedUrlOrFallback: blank URL falls back to local-files with a non-empty warning", () => {
  const result = resolveSelfHostedUrlOrFallback("");
  assert.deepEqual(result.sinks, ["local-files"]);
  assert.equal(result.url, "");
  assert.ok(result.fallbackWarning && result.fallbackWarning.length > 0);
});

test("resolveSelfHostedUrlOrFallback: whitespace-only URL also falls back", () => {
  const result = resolveSelfHostedUrlOrFallback("   ");
  assert.deepEqual(result.sinks, ["local-files"]);
  assert.ok(result.fallbackWarning);
});

test("resolveSelfHostedUrlOrFallback: non-blank (even malformed) URL passes through unchanged, no fallback", () => {
  const result = resolveSelfHostedUrlOrFallback("not-a-url");
  assert.deepEqual(result.sinks, ["user-hosted-console"]);
  assert.equal(result.url, "not-a-url");
  assert.equal(result.fallbackWarning, undefined);
});

test("resolveSelfHostedUrlOrFallback: well-formed https URL passes through unchanged", () => {
  const result = resolveSelfHostedUrlOrFallback("https://console.example.test");
  assert.deepEqual(result.sinks, ["user-hosted-console"]);
  assert.equal(result.url, "https://console.example.test");
  assert.equal(result.fallbackWarning, undefined);
});

// --- runConsoleConnectWizard ---

function scriptedIo(answers) {
  const queue = [...answers];
  const prompts = [];
  const hiddenPrompts = [];
  return {
    io: {
      ask: async (prompt) => {
        prompts.push(prompt);
        if (queue.length === 0) throw new Error("scriptedIo: ask() called more times than answers were scripted");
        return queue.shift();
      },
      askHidden: async (prompt) => {
        hiddenPrompts.push(prompt);
        if (queue.length === 0) throw new Error("scriptedIo: askHidden() called more times than answers were scripted");
        return queue.shift();
      },
    },
    prompts,
    hiddenPrompts,
  };
}

const defaults = { hostedUrl: "https://console.kontourai.io", localUrl: "http://127.0.0.1:3737" };

test("runConsoleConnectWizard: hosted path prompts token+tenant, no URL prompt", async () => {
  const { io, prompts, hiddenPrompts } = scriptedIo(["hosted", "tok-abc123", "tenant-a"]);
  const result = await runConsoleConnectWizard(io, defaults);
  assert.deepEqual(result.telemetrySinks, ["kontour-hosted-console"]);
  assert.equal(result.consoleUrl, undefined);
  assert.equal(result.consoleTokenValue, "tok-abc123");
  assert.equal(result.consoleTenant, "tenant-a");
  assert.deepEqual(result.warnings, []);
  assert.equal(prompts.length, 2); // choice + tenant (no URL prompt for hosted)
  assert.equal(hiddenPrompts.length, 1);
  assert.ok(hiddenPrompts[0].includes("CONSOLE_AUTH_TOKENS_JSON"));
});

test("runConsoleConnectWizard: local path prompts token+tenant, no URL prompt", async () => {
  const { io } = scriptedIo(["local", "", ""]);
  const result = await runConsoleConnectWizard(io, defaults);
  assert.deepEqual(result.telemetrySinks, ["local-kontour-console"]);
  assert.equal(result.consoleUrl, undefined);
  assert.equal(result.consoleTokenValue, undefined);
  assert.equal(result.consoleTenant, undefined);
  assert.deepEqual(result.warnings, []);
});

test("runConsoleConnectWizard: self-hosted path with a valid URL prompts URL+token+tenant", async () => {
  const { io } = scriptedIo(["self-hosted", "https://console.example.test", "tok-xyz", "tenant-b"]);
  const result = await runConsoleConnectWizard(io, defaults);
  assert.deepEqual(result.telemetrySinks, ["user-hosted-console"]);
  assert.equal(result.consoleUrl, "https://console.example.test");
  assert.equal(result.consoleTokenValue, "tok-xyz");
  assert.equal(result.consoleTenant, "tenant-b");
  assert.deepEqual(result.warnings, []);
});

test("runConsoleConnectWizard: self-hosted path with a blank URL falls back to local-files and skips credential prompts", async () => {
  const { io, prompts, hiddenPrompts } = scriptedIo(["self-hosted", ""]);
  const result = await runConsoleConnectWizard(io, defaults);
  assert.deepEqual(result.telemetrySinks, ["local-files"]);
  assert.equal(result.consoleUrl, undefined);
  assert.equal(result.consoleTokenValue, undefined);
  assert.equal(result.consoleTenant, undefined);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes("requires a URL"));
  assert.equal(prompts.length, 2); // choice + URL only -- no credential prompts fired
  assert.equal(hiddenPrompts.length, 0);
});

test("runConsoleConnectWizard: skip path prompts nothing beyond the initial choice", async () => {
  const { io, prompts, hiddenPrompts } = scriptedIo(["skip"]);
  const result = await runConsoleConnectWizard(io, defaults);
  assert.deepEqual(result.telemetrySinks, ["local-files"]);
  assert.equal(result.consoleUrl, undefined);
  assert.equal(result.consoleTokenValue, undefined);
  assert.equal(result.consoleTenant, undefined);
  assert.deepEqual(result.warnings, []);
  assert.equal(prompts.length, 1);
  assert.equal(hiddenPrompts.length, 0);
});

test("runConsoleConnectWizard: blank choice answer defaults to hosted", async () => {
  const { io } = scriptedIo(["", "", ""]);
  const result = await runConsoleConnectWizard(io, defaults);
  assert.deepEqual(result.telemetrySinks, ["kontour-hosted-console"]);
});

test("runConsoleConnectWizard: invalid token format produces a warning but is NOT dropped from the returned value", async () => {
  const { io } = scriptedIo(["hosted", "has a space and \t tab", "tenant-a"]);
  const result = await runConsoleConnectWizard(io, defaults);
  assert.equal(result.consoleTokenValue, "has a space and \t tab");
  assert.ok(result.warnings.some((w) => w.includes("token format")));
});

test("runConsoleConnectWizard: invalid tenant format produces a warning but is NOT dropped from the returned value", async () => {
  const { io } = scriptedIo(["hosted", "tok-ok", "tenant with spaces"]);
  const result = await runConsoleConnectWizard(io, defaults);
  assert.equal(result.consoleTenant, "tenant with spaces");
  assert.ok(result.warnings.some((w) => w.includes("tenant format")));
});

test("runConsoleConnectWizard: invalid (malformed but non-blank) self-hosted URL produces a warning but does not fall back", async () => {
  const { io } = scriptedIo(["self-hosted", "not-a-url", "", ""]);
  const result = await runConsoleConnectWizard(io, defaults);
  assert.deepEqual(result.telemetrySinks, ["user-hosted-console"]);
  assert.equal(result.consoleUrl, "not-a-url");
  assert.ok(result.warnings.some((w) => w.includes("does not look valid")));
});

// --- describeConsoleStatus ---

test("describeConsoleStatus: checked+ok=true -> connected-verified", () => {
  const result = describeConsoleStatus({ console: { sink: "console", reachability: { checked: true, ok: true } } });
  assert.equal(result.status, "connected-verified");
});

test("describeConsoleStatus: attempted-and-failed (checked=true, ok=false) -> connected-unverified, detail still surfaces the error", () => {
  const result = describeConsoleStatus({
    console: { sink: "console", reachability: { checked: true, ok: false, error: "timeout after 2000ms" } },
  });
  assert.equal(result.status, "connected-unverified");
  assert.equal(result.detail, "timeout after 2000ms");
  assert.ok(!result.detail.includes("allow-network"), "attempted-and-failed detail must not be replaced by the not-checked hint");
});

test("describeConsoleStatus: attempted-and-failed (checked=true, ok=false, no error) -> connected-unverified, detail still surfaces the statusCode", () => {
  const result = describeConsoleStatus({
    console: { sink: "console", reachability: { checked: true, ok: false, statusCode: 503 } },
  });
  assert.equal(result.status, "connected-unverified");
  assert.ok(result.detail.includes("503"));
  assert.ok(!result.detail.includes("allow-network"), "attempted-and-failed detail must not be replaced by the not-checked hint");
});

test("describeConsoleStatus: sink=local-only -> local-only regardless of reachability shape", () => {
  const result1 = describeConsoleStatus({ console: { sink: "local-only", reachability: { checked: false, ok: null } } });
  assert.equal(result1.status, "local-only");
  const result2 = describeConsoleStatus({ console: { sink: "local-only", reachability: { checked: true, ok: true } } });
  assert.equal(result2.status, "local-only");
});

test("describeConsoleStatus: sink=console but not checked -> connected-unverified (honestly not verified) with an actionable self-hosted/BYO hint", () => {
  const result = describeConsoleStatus({ console: { sink: "console", reachability: { checked: false, ok: null } } });
  assert.equal(result.status, "connected-unverified");
  assert.ok(result.detail.startsWith("not checked"), "must not silently drop the honest 'not checked' verdict");
  assert.ok(result.detail.includes("flow-agents telemetry-doctor --allow-network"), "must point at the flag that unblocks self-hosted/BYO reachability checks");
});

test("describeConsoleStatus: not-checked-via-not-allowed-guard (checked=false with an error set by endpointAllowed()) still gets the same actionable hint, not the bare error", () => {
  const result = describeConsoleStatus({
    console: { sink: "console", reachability: { checked: false, ok: null, error: "endpoint is not allowed" } },
  });
  assert.equal(result.status, "connected-unverified");
  assert.ok(result.detail.includes("--allow-network"));
});

// --- buildPostInstallSummaryLines ---

test("buildPostInstallSummaryLines: never contains the literal token/secret value", () => {
  const lines = buildPostInstallSummaryLines({
    runtime: "base",
    runtimeAutoDetected: false,
    dest: "/tmp/some-dest",
    telemetrySinks: ["kontour-hosted-console"],
    consoleStatus: { status: "connected-verified" },
    tokenConfigured: true,
    tenantConfigured: true,
    nextSteps: ["step one"],
  });
  const joined = lines.join("\n");
  assert.ok(!joined.includes("secret-token-value"));
  assert.ok(joined.includes("configured"));
});

test("buildPostInstallSummaryLines: runtime annotated (auto-detected) only when the flag is set", () => {
  const detected = buildPostInstallSummaryLines({
    runtime: "codex",
    runtimeAutoDetected: true,
    dest: "/tmp/dest",
    telemetrySinks: ["local-files"],
    consoleStatus: { status: "local-only" },
    tokenConfigured: false,
    tenantConfigured: false,
    nextSteps: [],
  });
  assert.ok(detected.some((line) => line.includes("codex (auto-detected)")));

  const notDetected = buildPostInstallSummaryLines({
    runtime: "codex",
    runtimeAutoDetected: false,
    dest: "/tmp/dest",
    telemetrySinks: ["local-files"],
    consoleStatus: { status: "local-only" },
    tokenConfigured: false,
    tenantConfigured: false,
    nextSteps: [],
  });
  assert.ok(notDetected.some((line) => line.includes("Runtime: codex") && !line.includes("auto-detected")));
});

test("buildPostInstallSummaryLines: local-only status includes 'local-only' marker and omits token/tenant lines", () => {
  const lines = buildPostInstallSummaryLines({
    runtime: "base",
    runtimeAutoDetected: false,
    dest: "/tmp/dest",
    telemetrySinks: ["local-files"],
    consoleStatus: { status: "local-only" },
    tokenConfigured: false,
    tenantConfigured: false,
    nextSteps: [],
  });
  assert.ok(lines.some((line) => line.includes("Console:") && line.includes("local-only")));
  assert.ok(!lines.some((line) => line.includes("Console token")));
});
