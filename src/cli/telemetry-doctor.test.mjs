// Unit tests for the hosted-Console reachability carve-out in
// src/cli/telemetry-doctor.ts (AC3, install-flow-foundations Thread C):
// endpointAllowed's known-hosted-console hostname carve-out.
//
// Loaded from the built JS (mirrors src/cli/init.test.mjs's import-from-build
// convention). Run: `npm run test:unit`, or directly after `npm run build`:
//   node --test src/cli/telemetry-doctor.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import { endpointAllowed } from "../../build/src/cli/telemetry-doctor.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

test("endpointAllowed: known hosted Console (console.kontourai.io) is allowed without --allow-network", () => {
  assert.equal(endpointAllowed("https://console.kontourai.io/api/telemetry/records", false), true);
});

test("endpointAllowed: known hosted Console still allowed with --allow-network (unchanged)", () => {
  assert.equal(endpointAllowed("https://console.kontourai.io/api/telemetry/records", true), true);
});

test("endpointAllowed: generic non-local https endpoint still requires --allow-network", () => {
  assert.equal(endpointAllowed("https://console.example.test/api/telemetry/records", false), false);
  assert.equal(endpointAllowed("https://console.example.test/api/telemetry/records", true), true);
});

test("endpointAllowed: FLOW_AGENTS_KONTOUR_CLOUD_CONSOLE_URL override is honored for the carve-out, scoped to that one hostname only", async () => {
  const previous = process.env.FLOW_AGENTS_KONTOUR_CLOUD_CONSOLE_URL;
  process.env.FLOW_AGENTS_KONTOUR_CLOUD_CONSOLE_URL = "https://synthetic-hosted.example.test";
  try {
    // Re-import isn't needed: isKnownHostedConsoleHostname reads process.env
    // at call time, not at module-load time.
    assert.equal(endpointAllowed("https://synthetic-hosted.example.test/x", false), true);
    // A DIFFERENT non-local hostname under the same override must remain
    // blocked without --allow-network -- proves the carve-out is
    // hostname-scoped, not "any https".
    assert.equal(endpointAllowed("https://a-different-host.example.test/x", false), false);
  } finally {
    if (previous === undefined) delete process.env.FLOW_AGENTS_KONTOUR_CLOUD_CONSOLE_URL;
    else process.env.FLOW_AGENTS_KONTOUR_CLOUD_CONSOLE_URL = previous;
  }
});

test("endpointAllowed: local endpoints remain allowed by default (unchanged)", () => {
  assert.equal(endpointAllowed("http://127.0.0.1:3737/api/telemetry/records", false), true);
  assert.equal(endpointAllowed("http://localhost:3737/api/telemetry/records", false), true);
});

test("endpointAllowed: malformed/credentialed/control-char endpoints remain rejected (unchanged)", () => {
  assert.equal(endpointAllowed("https://bad host", false), false);
  assert.equal(endpointAllowed("https://user:pass@console.kontourai.io/x", false), false);
  assert.equal(endpointAllowed("https://console.kontourai.io/x\n", false), false);
  assert.equal(endpointAllowed("", false), false);
});

// Config-resolution parity (#1073). The doctor used to report the shipped
// scripts/telemetry/telemetry.conf unconditionally, so a machine-wide install
// carrying the Console URL, token and tenant in
// ~/.flow-agents/telemetry-console.conf read as "Console endpoint: not
// configured" while the bash hooks were resolving it fine and mirroring.
// A diagnostic that answers "is my telemetry configured?" wrongly is worse
// than no diagnostic: it sends you to rewrite config that was never broken.
test("resolveTelemetryConfigFile: mirrors config.sh's precedence", async () => {
  const { resolveTelemetryConfigFile } = await import(
    "../../build/src/cli/telemetry-doctor.js"
  );
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const dest = makeFixtureDir("fa-doctor-");
  const telemetryDir = path.join(dest, "scripts", "telemetry");
  const shipped = path.join(telemetryDir, "telemetry.conf");

  // Isolate HOME: the developer running this very likely has a real trusted
  // ~/.flow-agents/telemetry-console.conf, which would otherwise win and make
  // the assertions describe the machine rather than the precedence.
  const previousHome = process.env.HOME;
  const fakeHome = makeFixtureDir("fa-home-");
  process.env.HOME = fakeHome;
  // Isolate TELEMETRY_CONFIG_FILE the same way: CI's eval harness defaults it
  // to a console-free fixture (evals/ci/run-baseline.sh), which would otherwise
  // win over every file-precedence branch this test asserts.
  const previousTelemetryConfigFile = process.env.TELEMETRY_CONFIG_FILE;
  delete process.env.TELEMETRY_CONFIG_FILE;
  try {

  // Nothing trusted anywhere -> the shipped default, as before.
  assert.equal(resolveTelemetryConfigFile(dest, telemetryDir), shipped);

  // A trusted per-workspace conf wins over the shipped default.
  const localConf = path.join(dest, ".kontourai", "telemetry-console.conf");
  fs.mkdirSync(path.dirname(localConf), { recursive: true });
  fs.writeFileSync(localConf, "console_telemetry_url=https://example.test\n", {
    mode: 0o600,
  });
  fs.chmodSync(localConf, 0o600);
  assert.equal(resolveTelemetryConfigFile(dest, telemetryDir), localConf);

  // An untrusted one (wrong mode) is ignored exactly as the bash gate ignores
  // it, rather than being read anyway.
  fs.chmodSync(localConf, 0o644);
  assert.equal(resolveTelemetryConfigFile(dest, telemetryDir), shipped);

  // An explicit TELEMETRY_CONFIG_FILE always wins.
  const previous = process.env.TELEMETRY_CONFIG_FILE;
  process.env.TELEMETRY_CONFIG_FILE = "/tmp/explicit-telemetry.conf";
  try {
    assert.equal(
      resolveTelemetryConfigFile(dest, telemetryDir),
      path.resolve("/tmp/explicit-telemetry.conf"),
    );
  } finally {
    if (previous === undefined) delete process.env.TELEMETRY_CONFIG_FILE;
    else process.env.TELEMETRY_CONFIG_FILE = previous;
  }

  // A trusted user-global conf is picked up when no workspace conf is.
  const globalConf = path.join(fakeHome, ".flow-agents", "telemetry-console.conf");
  fs.mkdirSync(path.dirname(globalConf), { recursive: true });
  fs.writeFileSync(globalConf, "console_telemetry_url=https://example.test\n");
  fs.chmodSync(globalConf, 0o600);
  assert.equal(resolveTelemetryConfigFile(dest, telemetryDir), globalConf);

  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousTelemetryConfigFile === undefined) delete process.env.TELEMETRY_CONFIG_FILE;
    else process.env.TELEMETRY_CONFIG_FILE = previousTelemetryConfigFile;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
  fs.rmSync(dest, { recursive: true, force: true });
});
