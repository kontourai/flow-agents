// Unit tests for src/lib/console-telemetry-validate.ts (install-flow-foundations
// Thread D / AC4): pure predicates mirroring the bash Console telemetry
// validators (scripts/telemetry/install-console-config.sh, scripts/telemetry/lib/transport.sh).
//
// Loaded from the built JS (mirrors src/cli/sidecar-pure-helpers.test.mjs's
// import-from-build convention, and src/cli/codex-exit-code.test.mjs's precedent
// for a *.test.mjs under src/cli/ testing a module that lives elsewhere).
// Run: `npm run test:unit`, or directly after `npm run build`:
//   node --test src/cli/console-telemetry-validate.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

import {
  hasControlChars,
  isValidConsoleUrl,
  isValidConsoleEndpointStrict,
  isValidConsoleToken,
  isValidConsoleTenant,
  isSafeConsoleTenantForRuntime,
} from "../../build/src/lib/console-telemetry-validate.js";

// --- hasControlChars ---

test("hasControlChars: rejects newline, carriage return, tab", () => {
  assert.equal(hasControlChars("a\nb"), true);
  assert.equal(hasControlChars("a\rb"), true);
  assert.equal(hasControlChars("a\tb"), true);
});

test("hasControlChars: plain value has none", () => {
  assert.equal(hasControlChars("plain-value"), false);
});

// --- isValidConsoleUrl (mirrors install-console-config.sh's validate_url) ---

test("isValidConsoleUrl: blank is valid (optional field)", () => {
  assert.equal(isValidConsoleUrl(""), true);
});

test("isValidConsoleUrl: https accepted", () => {
  assert.equal(isValidConsoleUrl("https://console.example.com"), true);
});

test("isValidConsoleUrl: generic non-local http rejected", () => {
  assert.equal(isValidConsoleUrl("http://example.com"), false);
});

test("isValidConsoleUrl: localhost http accepted (bare, with port, with path)", () => {
  assert.equal(isValidConsoleUrl("http://localhost"), true);
  assert.equal(isValidConsoleUrl("http://localhost:3000"), true);
  assert.equal(isValidConsoleUrl("http://localhost/path"), true);
});

test("isValidConsoleUrl: 127.0.0.1 http accepted (bare, with port, with path)", () => {
  assert.equal(isValidConsoleUrl("http://127.0.0.1"), true);
  assert.equal(isValidConsoleUrl("http://127.0.0.1:9"), true);
  assert.equal(isValidConsoleUrl("http://127.0.0.1/path"), true);
});

test("isValidConsoleUrl: control characters rejected", () => {
  assert.equal(isValidConsoleUrl("https://example.com\n"), false);
  assert.equal(isValidConsoleUrl("https://example.com\t"), false);
});

test("isValidConsoleUrl: a literal double-quote is NOT rejected (unlike the strict endpoint validator)", () => {
  assert.equal(isValidConsoleUrl('https://example.com/"'), true);
});

// --- isValidConsoleEndpointStrict (mirrors transport.sh's console_telemetry_endpoint_allowed) ---

test("isValidConsoleEndpointStrict: blank is INVALID (non-empty required, unlike isValidConsoleUrl)", () => {
  assert.equal(isValidConsoleEndpointStrict(""), false);
});

test("isValidConsoleEndpointStrict: https accepted", () => {
  assert.equal(isValidConsoleEndpointStrict("https://console.example.com/api/telemetry/records"), true);
});

test("isValidConsoleEndpointStrict: localhost/127.0.0.1 http accepted", () => {
  assert.equal(isValidConsoleEndpointStrict("http://localhost:3000"), true);
  assert.equal(isValidConsoleEndpointStrict("http://127.0.0.1:9"), true);
});

test("isValidConsoleEndpointStrict: generic non-local http rejected", () => {
  assert.equal(isValidConsoleEndpointStrict("http://example.com"), false);
});

test("isValidConsoleEndpointStrict: newline and carriage return rejected", () => {
  assert.equal(isValidConsoleEndpointStrict("https://example.com\n"), false);
  assert.equal(isValidConsoleEndpointStrict("https://example.com\r"), false);
});

test("isValidConsoleEndpointStrict: tab is ACCEPTED (bash console_telemetry_endpoint_allowed does not reject tab, unlike isValidConsoleUrl/validate_url)", () => {
  assert.equal(isValidConsoleEndpointStrict("https://example.com\t/path"), true);
});

test("isValidConsoleEndpointStrict: a literal double-quote is rejected (unlike isValidConsoleUrl)", () => {
  assert.equal(isValidConsoleEndpointStrict('https://example.com/"'), false);
});

// --- isValidConsoleToken (mirrors install-console-config.sh's validate_token) ---

test("isValidConsoleToken: blank is valid (optional field)", () => {
  assert.equal(isValidConsoleToken(""), true);
});

test("isValidConsoleToken: length 4096 accepted, 4097 rejected", () => {
  assert.equal(isValidConsoleToken("a".repeat(4096)), true);
  assert.equal(isValidConsoleToken("a".repeat(4097)), false);
});

test("isValidConsoleToken: a value containing a space is rejected (charset)", () => {
  assert.equal(isValidConsoleToken("has a space"), false);
});

test("isValidConsoleToken: control characters rejected", () => {
  assert.equal(isValidConsoleToken("abc\ndef"), false);
});

test("isValidConsoleToken: charset accepts letters, digits, and . _ ~ + / = -", () => {
  assert.equal(isValidConsoleToken("Az09._~+/=-"), true);
});

// --- isValidConsoleTenant (mirrors install-console-config.sh's validate_tenant) ---

test("isValidConsoleTenant: blank is valid (optional field, no length bound)", () => {
  assert.equal(isValidConsoleTenant(""), true);
});

test("isValidConsoleTenant: charset accepts letters, digits, and . _ : -", () => {
  assert.equal(isValidConsoleTenant("tenant-1.demo:prod_A"), true);
});

test("isValidConsoleTenant: a value with an unsupported character is rejected", () => {
  assert.equal(isValidConsoleTenant("tenant/1"), false);
  assert.equal(isValidConsoleTenant("tenant 1"), false);
});

test("isValidConsoleTenant: no length bound (129 chars of valid charset still accepted)", () => {
  assert.equal(isValidConsoleTenant("a".repeat(129)), true);
});

// --- isSafeConsoleTenantForRuntime (mirrors transport.sh's console_telemetry_safe_tenant) ---

test("isSafeConsoleTenantForRuntime: blank is INVALID (non-empty required, unlike isValidConsoleTenant)", () => {
  assert.equal(isSafeConsoleTenantForRuntime(""), false);
});

test("isSafeConsoleTenantForRuntime: length 128 accepted, 129 rejected", () => {
  assert.equal(isSafeConsoleTenantForRuntime("a".repeat(128)), true);
  assert.equal(isSafeConsoleTenantForRuntime("a".repeat(129)), false);
});

test("isSafeConsoleTenantForRuntime: same charset as isValidConsoleTenant", () => {
  assert.equal(isSafeConsoleTenantForRuntime("tenant-1.demo:prod_A"), true);
  assert.equal(isSafeConsoleTenantForRuntime("tenant/1"), false);
});
