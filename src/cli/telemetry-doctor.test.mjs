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
