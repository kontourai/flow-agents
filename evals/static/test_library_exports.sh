#!/usr/bin/env bash
# test_library_exports.sh — the package exposes the canonical workflow-sidecar
# writer/validator as an importable library (issue #99). Guards three things:
#   1. package.json declares the library entry points (exports/main/types).
#   2. importing the entry point does NOT execute the CLI (entry guard holds).
#   3. the CLI still runs when invoked directly (entry guard regression).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT/evals/lib/node.sh"
cd "$ROOT"

errors=0
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

echo "=== Library Export Surface (#99) ==="

# Ensure the build exists (cheap no-op if already built).
flow_agents_node node_modules/typescript/bin/tsc -p tsconfig.json >/dev/null 2>&1 || npm run build --silent >/dev/null 2>&1 || true

# 1. package.json entry points
if node -e '
const p = require("./package.json");
const fail = (m) => { console.error(m); process.exit(1); };
if (p.main !== "build/src/index.js") fail("main must be build/src/index.js");
if (p.types !== "build/src/index.d.ts") fail("types must be build/src/index.d.ts");
if (!p.exports || !p.exports["."]) fail("exports must define the root entry");
const root = p.exports["."];
if (root.import !== "./build/src/index.js") fail("exports[.].import must be ./build/src/index.js");
if (root.types !== "./build/src/index.d.ts") fail("exports[.].types must be ./build/src/index.d.ts");
' 2>/tmp/lib-exports-pkg.err; then
  pass "package.json declares library entry points (main/types/exports)"
else
  fail "package.json library entry points missing or wrong: $(cat /tmp/lib-exports-pkg.err)"
fi

# 2. built artifacts present
if [[ -f "build/src/index.js" && -f "build/src/index.d.ts" ]]; then
  pass "build emits index.js and index.d.ts"
else
  fail "build is missing index.js or index.d.ts (run npm run build)"
fi
if grep -q 'GateActionArtifactBinding' build/src/index.d.ts; then
  pass "package root exports the public gate-action artifact binding type"
else
  fail "build/src/index.d.ts is missing GateActionArtifactBinding"
fi

# 3. importing the library does not run the CLI, and the public API is present.
# If importing executed the CLI it would call process.exit before our marker prints.
if node --input-type=module -e '
import * as lib from "./build/src/index.js";
const required = [
  "validateTrustBundle", "normalizeCheck", "normalizeFinding", "normalizeLearning",
  "normalizeEvidenceRefs", "validateEvidenceRef", "validateLearningCorrection",
  "loadJson", "readSidecar", "writeJson", "appendJsonl", "sidecarBase", "writeState", "writeSidecar",
  "startBuilderBuildRun", "evaluateBuilderBuildRun", "startBuilderFlowSession",
  "pauseBuilderFlowSession", "resumeBuilderFlowSession", "cancelBuilderFlowSession",
  "archiveBuilderFlowSession", "recoverBuilderFlowSession", "releaseBuilderFlowAssignment",
  "builderLifecycleAuthorizationPayload", "loadBuilderLifecycleAuthorization",
  "statuses", "phases", "checkKinds", "checkStatuses", "verdicts",
];
const missing = required.filter((name) => lib[name] === undefined);
if (missing.length) { console.error("missing exports: " + missing.join(", ")); process.exit(1); }
// Exercise a validator to prove it is the real implementation, not a stub.
let threw = false;
try { lib.normalizeCheck({ id: "x" }); } catch { threw = true; }
if (!threw) { console.error("normalizeCheck should reject an invalid check"); process.exit(1); }
const ok = lib.normalizeCheck({ id: "b", kind: "test", status: "pass", summary: "ok" });
if (ok.id !== "b") { console.error("normalizeCheck should return the normalized check"); process.exit(1); }
console.log("LIBRARY_IMPORT_OK");
' 2>/dev/null | grep -q "LIBRARY_IMPORT_OK"; then
  pass "importing the library exposes the public API without running the CLI"
else
  fail "library import failed, ran the CLI, or is missing public exports"
fi

# 4. the CLI still runs when invoked directly (entry guard regression guard).
# A missing required flag must produce the CLI's own validation error, proving main() ran.
cli_out="$(node build/src/cli/workflow-sidecar.js ensure-session --artifact-root /tmp/nonexistent-lib-test 2>&1 || true)"
if echo "$cli_out" | grep -q "task-slug is required"; then
  pass "CLI entry still executes when run directly"
else
  fail "CLI entry did not run as a script (entry guard regression): $cli_out"
fi

echo ""
if [[ "$errors" -gt 0 ]]; then
  echo "Library export checks failed: $errors issue(s)."
  exit 1
fi
echo "Library export checks passed."
