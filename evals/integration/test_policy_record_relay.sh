#!/usr/bin/env bash
# test_policy_record_relay.sh — #1025: policy-hook decisions become durable records, emitted from
# the runtime-neutral runner, mirrored to Console only when explicitly configured.
#
# Three properties, in priority order:
#   1. LOCAL-FIRST. The durable record is written regardless of relay state, and a relay failure or
#      absence can never affect it — or the gate's verdict. A telemetry concern must never be able
#      to turn an allow into a deny.
#   2. NO SILENT EXFIL. With no console configured, nothing is posted anywhere. Default-on applies
#      only once an operator has configured a console url.
#   3. RUNTIME-NEUTRAL. The record is emitted by run-hook.js — the one path every runtime's adapter
#      funnels through — so coverage does not depend on which adapter invoked it.
#
# Deterministic, no network, no model spend, self-cleaning.
# Usage: bash evals/integration/test_policy_record_relay.sh

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

errors=0
_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

# Hermetic HOME so the running machine's real console conf can never enable a relay in this eval.
export HOME="$TMP/clean-home"
mkdir -p "$HOME"

echo ""
echo "=== exit-code vocabulary maps to the canonical decision ==="
node -e '
  const { buildPolicyRecord } = require(process.argv[1] + "/scripts/hooks/lib/policy-record.js");
  const at = "2026-01-01T00:00:00Z";
  const cases = [[0, "allow"], [2, "deny"], [1, "error"]];
  for (const [code, expected] of cases) {
    const r = buildPolicyRecord({ hookId: "config-protection", event: "PreToolUse", runtime: "codex", exitCode: code, at });
    if (r.decision !== expected) { console.error(`exit ${code} -> ${r.decision}, expected ${expected}`); process.exit(1); }
    if (r.schema !== "kontour.console.policy") { console.error("wrong schema " + r.schema); process.exit(1); }
  }
' "$ROOT" 2>"$TMP/vocab.err" && _pass "exit 0/2/other map to allow/deny/error under the kontour.console.policy schema" \
  || _fail "decision vocabulary is wrong: $(cat "$TMP/vocab.err")"

echo ""
echo "=== buildPolicyRecord is pure (same inputs, byte-identical record) ==="
node -e '
  const { buildPolicyRecord } = require(process.argv[1] + "/scripts/hooks/lib/policy-record.js");
  const input = { hookId: "quality-gate", event: "PostToolUse", runtime: "pi", exitCode: 0, at: "2026-01-01T00:00:00Z", toolName: "Edit" };
  const a = JSON.stringify(buildPolicyRecord(input));
  const b = JSON.stringify(buildPolicyRecord(input));
  process.exit(a === b ? 0 : 1);
' "$ROOT" && _pass "buildPolicyRecord is deterministic — no hidden clock or env read" \
  || _fail "buildPolicyRecord is not pure"

echo ""
echo "=== local-first: the durable record is written with NO console configured ==="
ARTIFACT_ROOT="$TMP/artifacts"
node -e '
  const { buildPolicyRecord, writePolicyRecord, policyRecordFile } = require(process.argv[1] + "/scripts/hooks/lib/policy-record.js");
  const root = process.argv[2];
  writePolicyRecord(root, buildPolicyRecord({ hookId: "config-protection", event: "PreToolUse", runtime: "codex", exitCode: 2, at: "2026-01-01T00:00:00Z" }));
  process.stdout.write(policyRecordFile(root));
' "$ROOT" "$ARTIFACT_ROOT" > "$TMP/recfile" 2>/dev/null
RECFILE="$(cat "$TMP/recfile" 2>/dev/null)"
if [[ -n "$RECFILE" && -f "$RECFILE" ]] && grep -q '"decision":"deny"' "$RECFILE"; then
  _pass "durable policy record written locally even with no console configured"
else
  _fail "no durable policy record was written (local-first violated)"
fi

echo ""
echo "=== no silent exfil: relay is off when nothing is configured ==="
if node -e '
  const { resolveRelayEnabled } = require(process.argv[1] + "/scripts/hooks/lib/record-relay.js");
  // An empty conf file: no console url key, no explicit relay key -> must resolve OFF.
  const fs = require("fs"), path = require("path");
  const conf = path.join(process.argv[2], "empty.conf");
  fs.writeFileSync(conf, "# nothing configured\n");
  process.exit(resolveRelayEnabled("policy", { TELEMETRY_CONFIG_FILE: conf }) ? 1 : 0);
' "$ROOT" "$TMP"; then
  _pass "policy relay resolves OFF when no console url is configured"
else
  _fail "policy relay resolved ON with no console configured — silent exfil risk"
fi

echo ""
echo "=== opt-out is honored even when a console IS configured ==="
if node -e '
  const { resolveRelayEnabled } = require(process.argv[1] + "/scripts/hooks/lib/record-relay.js");
  const fs = require("fs"), path = require("path");
  const conf = path.join(process.argv[2], "optout.conf");
  fs.writeFileSync(conf, "console_telemetry_url=https://example.invalid\nconsole_policy_relay=0\n");
  process.exit(resolveRelayEnabled("policy", { TELEMETRY_CONFIG_FILE: conf }) ? 1 : 0);
' "$ROOT" "$TMP"; then
  _pass "an explicit console_policy_relay=0 beats default-on"
else
  _fail "explicit opt-out was ignored"
fi

echo ""
echo "=== default-on once a console url resolves (opt-out, not silent-off) ==="
if node -e '
  const { resolveRelayEnabled } = require(process.argv[1] + "/scripts/hooks/lib/record-relay.js");
  const fs = require("fs"), path = require("path");
  const conf = path.join(process.argv[2], "configured.conf");
  fs.writeFileSync(conf, "console_telemetry_url=https://example.invalid\n");
  process.exit(resolveRelayEnabled("policy", { TELEMETRY_CONFIG_FILE: conf }) ? 0 : 1);
' "$ROOT" "$TMP"; then
  _pass "a configured console enables the relay without a second switch"
else
  _fail "a configured console did not enable the relay — silent-off"
fi

echo ""
echo "=== the relay script no-ops quietly when unconfigured ==="
if bash "$ROOT/scripts/policy/relay.sh" '{"schema":"kontour.console.policy","at":"2026-01-01T00:00:00Z"}' >"$TMP/relay.out" 2>"$TMP/relay.err"; then
  if [[ ! -s "$TMP/relay.out" ]]; then
    _pass "policy relay.sh exits 0 and emits nothing when no console is configured"
  else
    _fail "policy relay.sh produced output when it should have no-opped: $(cat "$TMP/relay.out")"
  fi
else
  _fail "policy relay.sh exited non-zero when unconfigured — it must always exit 0"
fi

echo ""
echo "=== runtime-neutral: run-hook.js emits the record itself ==="
if grep -q "recordPolicyDecision" "$ROOT/scripts/hooks/run-hook.js"; then
  _pass "emission lives in run-hook.js, the shared runner every runtime adapter funnels through"
else
  _fail "run-hook.js does not emit policy records — per-adapter emission would drift per runtime"
fi
if grep -rlq "policy-record" "$ROOT/scripts/hooks/claude-hook-adapter.js" "$ROOT/scripts/hooks/codex-hook-adapter.js" 2>/dev/null; then
  _fail "a per-runtime adapter emits policy records directly — that is the drift this design avoids"
else
  _pass "no per-runtime adapter emits policy records directly"
fi

echo ""
echo "----------------------------------------------"
if [[ $errors -eq 0 ]]; then
  echo "test_policy_record_relay: all checks passed."
  exit 0
else
  echo "test_policy_record_relay: $errors check(s) failed."
  exit 1
fi
