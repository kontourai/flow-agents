#!/usr/bin/env bash
# test_verify_cli.sh — Integration eval for `flow-agents verify` CLI subcommand.
#
# Proves that `node build/src/cli.js verify` correctly:
#   1. EXIT-0-MATCH:      --commands passes fresh AND bundle claims same command passed
#      → exit 0, no divergence.
#   2. EXIT-1-DIVERGE:    bundle claims a command passed, but fresh re-run FAILS
#      → exit 1 with "trust divergence" message.
#   3. EXIT-1-NO-VERIFY:  no --commands, no TRUST_RECONCILE_COMMANDS, no package.json
#      trust-reconcile-verify → exit 1, compile-only refused.
#   4. HELP-FLAG:         --help → exit 0, usage printed.
#
# All tests use fixture bundles (written via node inline scripts).
# No literal "trust.bundle" filename appears in shell commands to avoid
# config-protection hook interference (the fixture filenames are bundle-*.json).
#
# Requires: npm run build (or existing build/src/cli.js).
# Deterministic, no model spend, self-cleaning.
# Usage: bash evals/integration/test_verify_cli.sh

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$ROOT/build/src/cli.js"

if [[ ! -f "$CLI" ]]; then
  echo "SKIP: build/src/cli.js not found — run 'npm run build' first." >&2
  exit 0
fi

TMP="$(mktemp -d)"
errors=0

_pass() { echo "  PASS: $1"; }
_fail() { echo "  FAIL: $1"; errors=$((errors + 1)); }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

# ─── Bundle writer ───────────────────────────────────────────────────────────
# Writes a minimal trust bundle fixture to a given path.
# Usage: write_bundle <path> <command_label> <passing:true|false>
write_bundle() {
  local out_path="$1"
  local label="$2"
  local passing="$3"

  node - "$out_path" "$label" "$passing" << 'NODE'
const fs = require('fs');
const [,, outPath, label, passingStr] = process.argv;
const passing = passingStr === 'true';
const bundle = {
  schemaVersion: 5,
  source: "test-fixture",
  claims: [
    {
      id: "c1",
      claimType: "workflow.check.build",
      value: passing ? "pass" : "fail",
      status: passing ? "verified" : "disputed",
      subjectId: "test/build",
      facet: "flow-agents.workflow",
      subjectType: "workflow-check",
      fieldOrBehavior: "build",
      createdAt: "2026-06-27T00:00:00Z",
      updatedAt: "2026-06-27T00:00:00Z",
      impactLevel: "high",
      verificationPolicyId: "policy:workflow.check.build"
    }
  ],
  evidence: [
    {
      id: "ev1",
      claimId: "c1",
      evidenceType: "test_output",
      method: "validation",
      sourceRef: "test/command-log.jsonl",
      excerptOrSummary: "build",
      observedAt: "2026-06-27T00:00:00Z",
      collectedBy: "flow-agents/evidence-capture",
      passing: passing,
      execution: {
        runner: "bash",
        label: label,
        isError: !passing,
        exitCode: passing ? 0 : 1
      }
    }
  ],
  policies: [],
  events: []
};
fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2));
NODE
}

# ─── TEST 1: EXIT-0-MATCH ─────────────────────────────────────────────────────
# Bundle claims 'node -e process.exit(0)' passed; fresh re-run also passes → exit 0.
echo ""
echo "=== TEST 1: EXIT-0-MATCH — bundle match + fresh pass → exit 0 ==="

BUNDLE1="$TMP/bundle-match.json"
write_bundle "$BUNDLE1" "node -e 'process.exit(0)'" "true"

out1=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(0)'" \
  node "$CLI" verify \
    --bundle "$BUNDLE1" \
    --repo-root "$TMP" 2>&1)
exit1=$?

if [[ $exit1 -eq 0 ]]; then
  _pass "EXIT-0-MATCH: exits 0"
else
  _fail "EXIT-0-MATCH: expected exit 0, got $exit1 — output: $out1"
fi

if echo "$out1" | grep -q "RECONCILED\|fresh verify passed"; then
  _pass "EXIT-0-MATCH: output confirms reconcile/pass"
else
  _fail "EXIT-0-MATCH: expected RECONCILED or fresh verify passed, got: $out1"
fi

# ─── TEST 2: EXIT-1-DIVERGE ───────────────────────────────────────────────────
# Bundle claims a command passed; fresh re-run FAILS → exit 1 + divergence message.
echo ""
echo "=== TEST 2: EXIT-1-DIVERGE — bundle claims pass, fresh re-run fails → exit 1 ==="

BUNDLE2="$TMP/bundle-diverge.json"
write_bundle "$BUNDLE2" "node -e 'process.exit(1)'" "true"

out2=$(TRUST_RECONCILE_COMMANDS="node -e 'process.exit(1)'" \
  node "$CLI" verify \
    --bundle "$BUNDLE2" \
    --repo-root "$TMP" 2>&1)
exit2=$?

if [[ $exit2 -ne 0 ]]; then
  _pass "EXIT-1-DIVERGE: exits 1 (got $exit2)"
else
  _fail "EXIT-1-DIVERGE: expected exit 1, got 0 — output: $out2"
fi

if echo "$out2" | grep -q "trust divergence"; then
  _pass "EXIT-1-DIVERGE: 'trust divergence' in output"
else
  _fail "EXIT-1-DIVERGE: expected 'trust divergence', got: $out2"
fi

if echo "$out2" | grep -q "process.exit(1)"; then
  _pass "EXIT-1-DIVERGE: output names the divergent command"
else
  _fail "EXIT-1-DIVERGE: expected divergent command name in output, got: $out2"
fi

# ─── TEST 3: EXIT-1-NO-VERIFY ─────────────────────────────────────────────────
# No --commands, no env, no package.json trust-reconcile-verify → compile-only refused.
echo ""
echo "=== TEST 3: EXIT-1-NO-VERIFY — no verify configured → exit 1, compile-only refused ==="

# Use a temp dir with no package.json so no trust-reconcile-verify is auto-discovered.
EMPTY_ROOT="$TMP/empty-root"
mkdir -p "$EMPTY_ROOT"

out3=$(unset TRUST_RECONCILE_COMMANDS; node "$CLI" verify \
    --repo-root "$EMPTY_ROOT" 2>&1)
exit3=$?

if [[ $exit3 -ne 0 ]]; then
  _pass "EXIT-1-NO-VERIFY: exits 1 (got $exit3)"
else
  _fail "EXIT-1-NO-VERIFY: expected exit 1 (compile-only refused), got 0 — output: $out3"
fi

if echo "$out3" | grep -qi "compile-only\|no comprehensive\|trust-reconcile-verify"; then
  _pass "EXIT-1-NO-VERIFY: output explains compile-only refusal"
else
  _fail "EXIT-1-NO-VERIFY: expected compile-only refusal message, got: $out3"
fi

# ─── TEST 4: HELP-FLAG ────────────────────────────────────────────────────────
echo ""
echo "=== TEST 4: HELP-FLAG — --help → exit 0, usage printed ==="

out4=$(node "$CLI" verify --help 2>&1)
exit4=$?

if [[ $exit4 -eq 0 ]]; then
  _pass "HELP-FLAG: exits 0"
else
  _fail "HELP-FLAG: expected exit 0, got $exit4 — output: $out4"
fi

if echo "$out4" | grep -q "usage"; then
  _pass "HELP-FLAG: usage text in output"
else
  _fail "HELP-FLAG: expected usage text, got: $out4"
fi

# ─── TEST 5: composite action path resolution ──────────────────────────────────
# Regression for the cross-repo path bug: the action at .github/actions/trust-verify/
# resolves node scripts relative to github.action_path. A wrong `../` depth makes the
# action fail with "Cannot find module" in a CONSUMER repo (it passes a local CLI test
# but breaks the actual adoption path). Assert every action_path-relative script ref
# resolves to a real file.
echo "=== TEST 5: trust-verify action node refs resolve to real scripts ==="
if node -e '
  const fs=require("fs"), path=require("path");
  const root=process.argv[1];
  const actionDir=path.join(root,".github/actions/trust-verify");
  const y=fs.readFileSync(path.join(actionDir,"action.yml"),"utf8");
  const refs=[...y.matchAll(/action_path \}\}\/([^"]+\.js)/g)].map(m=>m[1]);
  if(refs.length===0){console.error("no action_path script refs found");process.exit(1);}
  let ok=true;
  for(const r of refs){ if(!fs.existsSync(path.resolve(actionDir,r))){console.error("UNRESOLVED: "+r);ok=false;} }
  process.exit(ok?0:1);
' "$ROOT"; then
  _pass "ACTION-PATH: all trust-verify action.yml script refs resolve"
else
  _fail "ACTION-PATH: a trust-verify action.yml script ref does not resolve (wrong ../ depth?)"
fi

if node -e '
  const fs=require("fs"), path=require("path");
  const action=fs.readFileSync(path.join(process.argv[1],".github/actions/trust-verify/action.yml"),"utf8");
  const hasInput=/missing-bundle-policy:\s*[\s\S]*?default: "required"/.test(action);
  const passesPolicy=/--missing-bundle-policy "\$MISSING_BUNDLE_POLICY"/.test(action);
  const cannotSuppressFailure=!/FAIL_ON_DIVERGENCE/.test(action)
    && !/divergence detected \(fail-on-divergence=false/.test(action)
    && /Deprecated compatibility input/.test(action);
  process.exit(hasInput && passesPolicy && cannotSuppressFailure ? 0 : 1);
' "$ROOT"; then
  _pass "ACTION-POLICY: missing-bundle policy is explicit and no compatibility input can suppress a red anchor"
else
  _fail "ACTION-POLICY: trust-verify action can suppress failure or lacks the missing-bundle contract"
fi

# The action checkout does not arrive with node_modules. Its ESM status-derivation helper
# resolves @kontourai/surface from the action repository, so the composite action must install
# the action's own locked runtime dependencies rather than relying on the consumer repo.
if node -e '
  const fs=require("fs"), path=require("path");
  const root=process.argv[1];
  const action=fs.readFileSync(path.join(root,".github/actions/trust-verify/action.yml"),"utf8");
  const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
  const lock=JSON.parse(fs.readFileSync(path.join(root,"package-lock.json"),"utf8"));
  const installsAtActionRoot=/ACTION_REPO_ROOT="\$\{\{ github\.action_path \}\}\/\.\.\/\.\.\/\.\."/.test(action)
    && /npm ci --omit=dev --include=optional --ignore-scripts --no-audit --no-fund --prefix "\$ACTION_REPO_ROOT"/.test(action);
  const surfaceDeclared=Boolean(pkg.optionalDependencies && pkg.optionalDependencies["@kontourai/surface"]);
  const surfaceLocked=Boolean(lock.packages && lock.packages["node_modules/@kontourai/surface"]);
  if(!installsAtActionRoot) console.error("trust-verify action does not install locked runtime dependencies at the action root");
  if(!surfaceDeclared) console.error("@kontourai/surface is not a declared runtime dependency");
  if(!surfaceLocked) console.error("@kontourai/surface is absent from package-lock.json");
  process.exit(installsAtActionRoot && surfaceDeclared && surfaceLocked ? 0 : 1);
' "$ROOT"; then
  _pass "ACTION-DEPS: action installs its locked Surface dependency at the action root"
else
  _fail "ACTION-DEPS: trust-verify action cannot guarantee Surface is importable"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────────"
if [[ $errors -eq 0 ]]; then
  echo "test_verify_cli: all checks passed."
  exit 0
else
  echo "test_verify_cli: $errors check(s) failed."
  exit 1
fi
