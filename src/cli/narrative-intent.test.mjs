import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bindIntentAnnotation,
  captureIntent,
  effectiveNarrativeRedactionFields,
  isAssertionProhibited,
  appendIntentEconomics,
  readIntentEconomics,
  reduceIntentEconomics,
} from "../../build/src/index.js";

const action = `fa1:file:action.json:${"a".repeat(64)}`;
const gate = `fa1:file:gate.json:${"b".repeat(64)}`;
const supported = { status: "supported" };
const unsupported = { status: "unsupported", reason: "not implemented on this runtime" };

// R1 (review HIGH): captureIntent co-binds the action ref to the frozen manifest.
// The unit tests inject a resolver that resolves the action to its frozen manifest
// ENTRY with its OWN captured_at (the annotation's captured_at derives from this, NOT
// wall-clock). An ABSENT / fabricated ref resolves to `undefined` and is rejected.
const ACTION_CAPTURED_AT = "2026-07-14T12:00:00.000Z";
const resolvesAction = { resolveAction: () => ({ capturedAt: ACTION_CAPTURED_AT }) };
const rejectsAction = { resolveAction: () => undefined };

test("#622: supported + purpose captures a bounded agent_stated annotation", () => {
  const captured = captureIntent({
    capability: supported, actor: "codex", runtimeId: "claude-code",
    actionRef: action, activeGateRef: gate, purpose: "prepare the release notes",
  }, resolvesAction);
  assert.equal(captured.mode, "agent_stated");
  assert.equal(captured.statement.class, "agent_stated");
  assert.equal(captured.statement.self_report, true);
  assert.deepEqual(captured.redactions, []);
  // captured_at derives from the resolved action entry, not a fresh clock.
  assert.equal(captured.action_captured_at, ACTION_CAPTURED_AT);
});

test("#622 (R1): a nonexistent / unresolvable action_ref is REJECTED (no annotation)", () => {
  // A fabricated action ref that does not resolve against the frozen manifest must
  // throw — you cannot annotate an action that is not in the frozen manifest.
  assert.throws(
    () => captureIntent({
      capability: supported, actor: "codex", runtimeId: "claude-code",
      actionRef: `fa1:file:nonexistent.json:${"0".repeat(64)}`, activeGateRef: gate,
      purpose: "prepare the release notes",
    }, rejectsAction),
    /resolvable frozen action source/,
  );
  // The fallback path is co-bound too: an unresolvable action is rejected even when
  // no purpose is supplied (there is no annotation of a nonexistent action at all).
  assert.throws(
    () => captureIntent({
      capability: unsupported, actor: "codex", runtimeId: "claude-code",
      actionRef: action, activeGateRef: gate,
    }, rejectsAction),
    /resolvable frozen action source/,
  );
});

test("#622 (R1): captured_at is bound to the action entry, not bind-time wall-clock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intent-cobind-"));
  try {
    const captured = captureIntent({
      capability: supported, actor: "codex", runtimeId: "claude-code",
      actionRef: action, activeGateRef: gate, purpose: "prepare the release notes",
    }, resolvesAction);
    const { annotation } = bindIntentAnnotation(dir, captured);
    assert.equal(annotation.captured_at, ACTION_CAPTURED_AT, "annotation captured_at must equal the action entry's captured_at");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#622: unsupported capability falls back to workflow_derived_purpose, never agent_stated", () => {
  const captured = captureIntent({
    capability: unsupported, actor: "codex", runtimeId: "claude-code",
    actionRef: action, activeGateRef: gate, purpose: "prepare the release notes",
  }, resolvesAction);
  assert.equal(captured.mode, "workflow_derived_purpose");
  assert.equal(captured.statement.class, "deterministic_derived");
  assert.equal(captured.statement.rule.id, "workflow-derived-purpose");
  assert.notEqual(captured.statement.class, "agent_stated");
});

test("#622: supported WITHOUT a purpose still falls back (no fabricated rationale)", () => {
  const captured = captureIntent({
    capability: supported, actor: "codex", runtimeId: "claude-code",
    actionRef: action, activeGateRef: gate,
  }, resolvesAction);
  assert.equal(captured.mode, "workflow_derived_purpose");
});

test("#622: a redacted purpose field is nulled before emission (falls back)", () => {
  const captured = captureIntent({
    capability: supported, actor: "codex", runtimeId: "claude-code",
    actionRef: action, activeGateRef: gate, purpose: "prepare the release notes",
    redactionFields: effectiveNarrativeRedactionFields(["purpose"]),
  }, resolvesAction);
  assert.equal(captured.mode, "workflow_derived_purpose");
  assert.ok(captured.redactions.includes("purpose"), "purpose must be recorded as redacted");
  // The redacted purpose text never reaches an emitted agent_stated proposition.
  assert.doesNotMatch(captured.statement.proposition, /release notes/);
});

test("#622: bindIntentAnnotation freezes write-once; a post-hoc write is EEXIST-rejected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intent-bind-"));
  try {
    const captured = captureIntent({
      capability: supported, actor: "codex", runtimeId: "claude-code",
      actionRef: action, activeGateRef: gate, purpose: "prepare the release notes",
    }, resolvesAction);
    const first = bindIntentAnnotation(dir, captured);
    assert.equal(first.annotation.captured_at, ACTION_CAPTURED_AT);
    assert.ok(fs.existsSync(first.path));
    const frozenBytes = fs.readFileSync(first.path);
    // A second/late write to the frozen channel MUST be structurally rejected.
    assert.throws(
      () => bindIntentAnnotation(dir, captured),
      /already frozen/,
    );
    // The frozen channel bytes are unchanged by the rejected post-hoc write.
    assert.deepEqual(fs.readFileSync(first.path), frozenBytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#622: agent_stated can never assert a prohibited (gate-evidence) category", () => {
  for (const kind of ["gate_status", "observed_outcome", "authority", "hidden_alternative"]) {
    assert.equal(isAssertionProhibited("agent_stated", kind), true, `agent_stated must not assert ${kind}`);
  }
});

test("#622: A/B reducer reports a mean delta WITH an uncertainty spread", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intent-econ-"));
  try {
    appendIntentEconomics(dir, { mode: "annotation_off", input_tokens: 100, output_tokens: 40, wall_clock_ms: 1000, attempted_at: "2026-07-15T00:00:00.000Z" });
    appendIntentEconomics(dir, { mode: "annotation_on", input_tokens: 130, output_tokens: 44, wall_clock_ms: 1100, attempted_at: "2026-07-15T00:00:01.000Z" });
    appendIntentEconomics(dir, { mode: "annotation_off", input_tokens: 100, output_tokens: 40, wall_clock_ms: 1000, attempted_at: "2026-07-15T00:00:02.000Z" });
    appendIntentEconomics(dir, { mode: "annotation_on", input_tokens: 150, output_tokens: 48, wall_clock_ms: 1200, attempted_at: "2026-07-15T00:00:03.000Z" });

    const summary = reduceIntentEconomics(readIntentEconomics(dir));
    assert.equal(summary.pairs, 2);
    assert.equal(summary.delta_input_tokens.has_data, true);
    assert.equal(summary.delta_input_tokens.mean, 40); // (30 + 50) / 2
    assert.ok(summary.delta_input_tokens.sample_std > 0, "uncertainty spread must be reported");
    assert.equal(summary.delta_input_tokens.min, 30);
    assert.equal(summary.delta_input_tokens.max, 50);
    assert.equal(summary.delta_output_tokens.mean, 6); // (4 + 8) / 2
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("#622 (MEDIUM): an empty / one-sided A/B window reports has_data:false, not a false-precise zero", () => {
  // Empty window: no samples at all.
  const empty = reduceIntentEconomics([]);
  assert.equal(empty.pairs, 0);
  for (const metric of ["delta_input_tokens", "delta_output_tokens", "delta_wall_clock_ms"]) {
    assert.equal(empty[metric].has_data, false, `${metric} must not claim a measured zero`);
    assert.equal("mean" in empty[metric], false, `${metric} must omit a false-precise mean`);
  }
  // One-sided window: on-only (no off samples to pair against) — still no confirmed delta.
  const onlyOn = reduceIntentEconomics([
    { mode: "annotation_on", input_tokens: 130, output_tokens: 44, wall_clock_ms: 1100, attempted_at: "2026-07-15T00:00:00.000Z" },
    { mode: "annotation_on", input_tokens: 150, output_tokens: 48, wall_clock_ms: 1200, attempted_at: "2026-07-15T00:00:01.000Z" },
  ]);
  assert.equal(onlyOn.pairs, 0);
  assert.equal(onlyOn.on_samples, 2);
  assert.equal(onlyOn.off_samples, 0);
  assert.equal(onlyOn.delta_input_tokens.has_data, false);
});
