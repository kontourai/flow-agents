#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_EVAL="$(mktemp -d /tmp/flow-agents-waves-writer.XXXXXX)"
trap 'rm -rf "$TMPDIR_EVAL"' EXIT

PROJECT="$TMPDIR_EVAL/project"
mkdir -p "$PROJECT/.kontourai/flow-agents"

(cd "$ROOT_DIR" && npm pack --silent --pack-destination "$TMPDIR_EVAL" >/dev/null)
TARBALLS=("$TMPDIR_EVAL"/*.tgz)
if [[ "${#TARBALLS[@]}" -ne 1 || ! -f "${TARBALLS[0]}" ]]; then
  echo "expected exactly one packed .tgz in $TMPDIR_EVAL; found ${#TARBALLS[@]}" >&2
  exit 1
fi
TARBALL="${TARBALLS[0]}"
SESSION="$PROJECT/.kontourai/flow-agents/packed-wave"
FLOW_AGENTS_PACKAGE="file:$TARBALL"
export CODEX_SESSION_ID=packed-wave-writer
unset CODEX_THREAD_ID

flow_agents() (
  : "${FLOW_AGENTS_PACKAGE:?set FLOW_AGENTS_PACKAGE to the exact package spec emitted by workflow status or doctor}"
  root=$(mktemp -d) || exit 1
  trap 'rm -rf "$root"' EXIT HUP INT TERM
  npm exec --yes --prefix "$root" \
    --package="$FLOW_AGENTS_PACKAGE" -- flow-agents "$@"
)

flow_agents_validate_artifacts() (
  : "${FLOW_AGENTS_PACKAGE:?set FLOW_AGENTS_PACKAGE to the exact package spec emitted by workflow status or doctor}"
  root=$(mktemp -d) || exit 1
  trap 'rm -rf "$root"' EXIT HUP INT TERM
  npm exec --yes --prefix "$root" \
    --package="$FLOW_AGENTS_PACKAGE" -- flow-agents-validate-artifacts "$@"
)

if (unset FLOW_AGENTS_PACKAGE; flow_agents workflow --help) >/dev/null 2>&1; then
  echo 'documented wrapper did not fail closed without an exact package spec' >&2
  exit 1
fi

(cd "$PROJECT" && flow_agents workflow start --flow builder.shape --task-slug packed-wave \
  --artifact-root "$PROJECT/.kontourai/flow-agents" \
  --summary 'Packed canonical wave writer fixture.') >/dev/null
PACKED_STEP="$(node -e 'const fs=require("node:fs");const state=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(state.flow_run.current_step)' "$SESSION/state.json")"

PACKED_HELP="$(cd "$PROJECT" && flow_agents workflow --help)"
[[ "$PACKED_HELP" == *"wave-declare"* ]]
(cd "$PROJECT" && flow_agents workflow wave-declare --session-dir "$SESSION" --wave-id packed-execute --step "$PACKED_STEP" \
  --worker-json '{"worker_id":"packed-one","task":"Write the packed fixture.","role":"tool-worker"}' \
  --worker-json '{"worker_id":"packed-two","task":"Validate the packed fixture.","role":"tool-worker"}') >/dev/null
(cd "$PROJECT" && flow_agents workflow wave-result --session-dir "$SESSION" --wave-id packed-execute --worker-id packed-one --status completed --summary 'Packed worker completed.') >/dev/null
(cd "$PROJECT" && flow_agents workflow wave-reconcile --session-dir "$SESSION" --wave-id packed-execute) >/dev/null

(cd "$PROJECT" && flow_agents_validate_artifacts --skip-markdown-validation "$SESSION/waves.json") >/dev/null
node - "$SESSION/waves.json" <<'NODE'
const fs = require('node:fs');
const waves = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const wave = waves.waves[0];
if (wave.reconciliation.status !== 'incomplete' || wave.reconciliation.expected_count !== 2 || wave.reconciliation.reported_count !== 1) process.exit(1);
const missing = wave.worker_results.find((result) => result.worker_id === 'packed-two');
if (!missing || missing.status !== 'not_reported') process.exit(1);
NODE

if (cd "$PROJECT" && flow_agents workflow wave-result --session-dir "$SESSION" --wave-id packed-execute --worker-id packed-two --status success --summary 'Legacy synonym.') >/dev/null 2>&1; then
  echo 'packed writer accepted unsupported status synonym' >&2
  exit 1
fi

echo 'PASS packed canonical workflow waves writer'
