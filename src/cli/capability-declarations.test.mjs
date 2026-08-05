import test from "node:test";
import assert from "node:assert/strict";

import {
  CAPABILITIES,
  RUNTIME_ADAPTER_IDS,
  RUNTIME_CAPABILITY_DECLARATIONS,
  getDeclaration,
  normalizeRuntimeId,
  queryCapability,
} from "../../build/src/lib/capability-declarations.js";

const VALID_STATUSES = new Set(["supported", "partial", "unsupported"]);

// AC1 conformance: every shipped adapter declares ALL six capabilities explicitly, each with a
// valid discriminated-union status (no defaulting, no undefined) — the 7×6 grid is total.
test("AC1 conformance: all 7 adapters declare all 6 capabilities with valid typed statuses", () => {
  assert.equal(RUNTIME_ADAPTER_IDS.length, 7, "expected exactly 7 shipped adapters");
  assert.equal(CAPABILITIES.length, 6, "expected exactly 6 declared capabilities");
  for (const runtime of RUNTIME_ADAPTER_IDS) {
    const declaration = RUNTIME_CAPABILITY_DECLARATIONS[runtime];
    assert.ok(declaration, `runtime '${runtime}' has a declaration`);
    assert.equal(declaration.runtime, runtime, `declaration.runtime matches key for '${runtime}'`);
    for (const capability of CAPABILITIES) {
      const status = declaration.capabilities[capability];
      assert.ok(status, `${runtime}.${capability} is declared (not undefined)`);
      assert.ok(VALID_STATUSES.has(status.status), `${runtime}.${capability} has a valid status: ${status.status}`);
      if (status.status === "partial") assert.equal(typeof status.note, "string", `${runtime}.${capability} partial carries a note`);
      if (status.status === "unsupported") assert.equal(typeof status.reason, "string", `${runtime}.${capability} unsupported carries a reason`);
    }
  }
});

// AC1 via the query API: querying every (adapter × capability) returns a DECLARED status object.
test("AC1: queryCapability returns a declared status for every (adapter × capability)", () => {
  for (const runtime of RUNTIME_ADAPTER_IDS) {
    for (const capability of CAPABILITIES) {
      const answer = queryCapability(runtime, capability);
      assert.ok(VALID_STATUSES.has(answer.status), `${runtime}/${capability} → ${answer.status}`);
      assert.deepEqual(answer, RUNTIME_CAPABILITY_DECLARATIONS[runtime].capabilities[capability]);
    }
  }
});

// AC4: an undeclared RUNTIME returns typed unsupported — never undefined/false.
test("AC4: undeclared runtime → typed unsupported (never undefined/false)", () => {
  for (const unknown of ["totally-unknown", "base", "gpt-9000", ""]) {
    const answer = queryCapability(unknown, "per_delegation_tokens");
    assert.equal(answer.status, "unsupported", `unknown runtime '${unknown}' → unsupported`);
    assert.equal(typeof answer.reason, "string");
    assert.notEqual(answer, undefined);
    assert.notEqual(answer, false);
  }
});

// AC4: an undeclared CAPABILITY (on a real runtime) returns typed unsupported.
test("AC4: undeclared capability → typed unsupported", () => {
  const answer = queryCapability("claude-code", "not_a_real_capability");
  assert.equal(answer.status, "unsupported");
  assert.equal(typeof answer.reason, "string");
});

// R4 totality against prototype-member keys: `__proto__`, `constructor`, `toString`, etc. must
// resolve to a typed `unsupported` — a bare bracket lookup would leak the inherited Object.prototype
// member (a function / the prototype object) that is not a CapabilityStatus and breaks the contract.
test("R4: prototype-member keys never leak Object.prototype members (typed unsupported, string return)", () => {
  const protoNames = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "__defineGetter__"];
  for (const key of protoNames) {
    // capability axis: must be a typed unsupported CapabilityStatus, never a function/prototype object.
    const answer = queryCapability("kiro", key);
    assert.equal(answer.status, "unsupported", `capability '${key}' → unsupported`);
    assert.equal(typeof answer.reason, "string", `capability '${key}' carries a string reason`);
    // runtime axis: normalizeRuntimeId must return a string (its declared type), never an object.
    assert.equal(typeof normalizeRuntimeId(key), "string", `normalizeRuntimeId('${key}') stays a string`);
    // and querying a prototype-name RUNTIME degrades to typed unsupported too.
    const byRuntime = queryCapability(key, "per_delegation_tokens");
    assert.equal(byRuntime.status, "unsupported", `runtime '${key}' → unsupported`);
    // getDeclaration must be undefined, not an inherited member.
    assert.equal(getDeclaration(key), undefined, `getDeclaration('${key}') → undefined`);
  }
});

// D1 alias normalization: the load-bearing kiro-cli→kiro fold, plus raw-model/base spellings,
// case, and whitespace. This is the #1 correctness risk (silent kiro/kiro-cli lookup miss).
test("D1: normalizeRuntimeId folds aliases (kiro-cli→kiro is load-bearing)", () => {
  assert.equal(normalizeRuntimeId("kiro-cli"), "kiro");
  assert.equal(normalizeRuntimeId("KIRO-CLI"), "kiro");
  assert.equal(normalizeRuntimeId("  Kiro-Cli  "), "kiro");
  assert.equal(normalizeRuntimeId("raw-model"), "base");
  assert.equal(normalizeRuntimeId("raw model runner"), "base");
  assert.equal(normalizeRuntimeId("claude-code"), "claude-code");
  assert.equal(normalizeRuntimeId("codex"), "codex");
  assert.equal(normalizeRuntimeId(""), "");
  assert.equal(normalizeRuntimeId(null), "");
  assert.equal(normalizeRuntimeId(undefined), "");
});

// D1 end-to-end: a kiro-cli lookup resolves the SAME declaration as the canonical kiro id.
test("D1: kiro-cli resolves the same declaration as canonical kiro (no silent miss)", () => {
  const viaAlias = getDeclaration("kiro-cli");
  const viaCanonical = getDeclaration("kiro");
  assert.ok(viaAlias, "kiro-cli resolves a declaration");
  assert.equal(viaAlias, viaCanonical, "kiro-cli and kiro resolve to the identical declaration object");
  for (const capability of CAPABILITIES) {
    assert.deepEqual(queryCapability("kiro-cli", capability), queryCapability("kiro", capability));
  }
});

// getDeclaration totality: real runtimes resolve, undeclared runtimes return undefined (the query
// API is what returns the typed unsupported — getDeclaration honestly returns undefined).
test("getDeclaration: real runtimes resolve, undeclared → undefined", () => {
  for (const runtime of RUNTIME_ADAPTER_IDS) {
    assert.ok(getDeclaration(runtime), `${runtime} resolves`);
  }
  assert.equal(getDeclaration("totally-unknown"), undefined);
  assert.equal(getDeclaration("base"), undefined);
});
