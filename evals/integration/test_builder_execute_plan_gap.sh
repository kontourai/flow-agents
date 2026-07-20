#!/usr/bin/env bash
# Proves the declared Builder execute -> plan correction through public workflow commands.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
PROJECT="$TMP/project"
ARTIFACT_ROOT="$PROJECT/.kontourai/flow-agents"
SLUG="acme-execute-gap-734"
SESSION="$ARTIFACT_ROOT/$SLUG"
FLOW_RUN="$PROJECT/.kontourai/flow/runs/$SLUG"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS %s\n' "$*"; }

workflow() {
  (cd "$PROJECT" && env -u CODEX_THREAD_ID CODEX_SESSION_ID=execute-plan-gap node "$ROOT/build/src/cli.js" workflow "$@")
}

snapshot() {
  find "$PROJECT/.kontourai" -type f -print0 | sort -z | xargs -0 shasum -a 256
}

mkdir -p "$SESSION"
printf 'Selected Work Item: acme/execute-gap#734\n' >"$SESSION/$SLUG--pull-work.md"
printf '# Plan\n\nThe fixture returns to planning only through the declared gate.\n' >"$SESSION/$SLUG--plan-work.md"
printf '# Execute\n\nThe fixture scope is intentionally incomplete.\n' >"$SESSION/$SLUG--deliver.md"

workflow start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item acme/execute-gap#734 \
  --assignment-provider local-file --summary 'Execute plan-gap fixture.' >/dev/null
PULL_REF="{\"kind\":\"artifact\",\"file\":\"$SESSION/$SLUG--pull-work.md\",\"summary\":\"Selected work and probe fixture.\"}"
PLAN_REF="{\"kind\":\"artifact\",\"file\":\"$SESSION/$SLUG--plan-work.md\",\"summary\":\"Plan fixture.\"}"
DELIVER_REF="{\"kind\":\"artifact\",\"file\":\"$SESSION/$SLUG--deliver.md\",\"summary\":\"Execute fixture.\"}"
workflow evidence --session-dir "$SESSION" --expectation pickup-probe-readiness --status pass \
  --summary 'Fixture pickup readiness.' --evidence-ref-json "$PULL_REF" >/dev/null
workflow evidence --session-dir "$SESSION" --expectation probe-decisions-or-accepted-gaps --status pass \
  --summary 'Fixture pickup decisions.' --evidence-ref-json "$PULL_REF" >/dev/null
workflow evidence --session-dir "$SESSION" --expectation implementation-plan --status pass \
  --summary 'Fixture plan.' --evidence-ref-json "$PLAN_REF" >/dev/null

node - "$FLOW_RUN/state.json" "$SESSION/state.json" <<'NODE'
const fs = require('node:fs');
const [flowFile, sessionFile] = process.argv.slice(2);
const flow = JSON.parse(fs.readFileSync(flowFile, 'utf8'));
const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
if (flow.current_step !== 'execute' || session.flow_run?.current_step !== 'execute') process.exit(1);
NODE
pass 'public fixture reaches execute in one canonical run'

BEFORE_REJECT="$(snapshot)"
set +e
UNSUPPORTED="$(workflow evidence --session-dir "$SESSION" --expectation implementation-scope --status fail --route-reason implementation_defect --summary 'Unsupported execute reason.' --evidence-ref-json "$DELIVER_REF" 2>&1)"
UNSUPPORTED_RC=$?
set -e
AFTER_REJECT="$(snapshot)"
[[ "$UNSUPPORTED_RC" -ne 0 && "$BEFORE_REJECT" == "$AFTER_REJECT" ]] || fail "unsupported execute reason did not reject before every durable write: $UNSUPPORTED"

set +e
MISSING="$(workflow evidence --session-dir "$SESSION" --expectation implementation-scope --status fail --summary 'Failed execute evidence without a route reason.' --evidence-ref-json "$DELIVER_REF" --json)"
MISSING_RC=$?
set -e
AFTER_MISSING="$(snapshot)"
[[ "$MISSING_RC" -eq 0 && "$BEFORE_REJECT" != "$AFTER_MISSING" ]] || fail "failed evidence without a route reason did not record as ordinary non-routing evidence: $MISSING"
node - "$FLOW_RUN/state.json" "$SESSION/state.json" "$MISSING" <<'NODE'
const fs = require('node:fs');
const [flowFile, sessionFile, output] = process.argv.slice(2);
const flow = JSON.parse(fs.readFileSync(flowFile, 'utf8'));
const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
const result = JSON.parse(output);
if (flow.current_step !== 'execute' || session.flow_run?.current_step !== 'execute' || result.current_step !== 'execute') process.exit(1);
if ((flow.transitions || []).some((entry) => entry.type === 'route_back')) process.exit(1);
if (session.flow_run?.route_back_attempt != null || session.flow_run?.route_back_max_attempts != null) process.exit(1);
NODE
pass 'unsupported reasons reject mutation-free and absent reasons cannot backtrack implicitly'

BEFORE_STATUS="$(snapshot)"
STATUS="$(workflow status --session-dir "$SESSION" --json)"
AFTER_STATUS="$(snapshot)"
[[ "$BEFORE_STATUS" == "$AFTER_STATUS" ]] || fail 'status mutated the execute fixture'
node -e 'const status=JSON.parse(process.argv[1]);if(status.current_step!=="execute")process.exit(1)' "$STATUS" || fail 'status did not retain execute before an explicit route'
pass 'status does not infer a route-back'

ASSIGNMENT_BEFORE="$(shasum -a 256 "$ARTIFACT_ROOT/assignment/$SLUG.json")"
ROUTED="$(workflow evidence --session-dir "$SESSION" --expectation implementation-scope --status fail --route-reason plan_gap --summary 'The executable scope has a genuine planning gap.' --evidence-ref-json "$DELIVER_REF" --json)"
ASSIGNMENT_AFTER="$(shasum -a 256 "$ARTIFACT_ROOT/assignment/$SLUG.json")"
[[ "$ASSIGNMENT_BEFORE" == "$ASSIGNMENT_AFTER" ]] || fail 'plan_gap replaced the assignment'
node - "$FLOW_RUN/state.json" "$SESSION/state.json" "$ROUTED" <<'NODE'
const fs = require('node:fs');
const [flowFile, sessionFile, output] = process.argv.slice(2);
const flow = JSON.parse(fs.readFileSync(flowFile, 'utf8'));
const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
const result = JSON.parse(output);
const transition = flow.transitions.at(-1);
const outcome = flow.gate_outcomes.at(-1);
if (flow.current_step !== 'plan' || session.flow_run?.current_step !== 'plan' || result.current_step !== 'plan') process.exit(1);
if (flow.subject !== 'acme/execute-gap#734' || flow.status !== 'active') process.exit(1);
if (transition?.type !== 'route_back' || transition.from_step !== 'execute' || transition.to_step !== 'plan' || transition.route_reason !== 'plan_gap' || transition.gate_id !== 'execute-gate') process.exit(1);
if (outcome?.attempt !== 1 || outcome.max_attempts !== 3) process.exit(1);
if (session.flow_run?.route_back_attempt !== 1 || session.flow_run?.route_back_max_attempts !== 3) process.exit(1);
if ((flow.transitions || []).some((entry) => /cancel|restart|replace|skip/i.test(entry.type || ''))) process.exit(1);
NODE
[[ "$(find "$PROJECT/.kontourai/flow/runs" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" == "1" ]] || fail 'plan_gap created a replacement run'
pass 'plan_gap returns the same assigned run to plan with Flow-owned accounting'

workflow evidence --session-dir "$SESSION" --expectation implementation-plan --status pass \
  --summary 'The fixture records a revised plan after the explicit correction.' --evidence-ref-json "$PLAN_REF" >/dev/null
REENTERED="$(workflow status --session-dir "$SESSION" --json)"
node - "$FLOW_RUN/state.json" "$SESSION/state.json" "$REENTERED" <<'NODE'
const fs = require('node:fs');
const [flowFile, sessionFile, output] = process.argv.slice(2);
const flow = JSON.parse(fs.readFileSync(flowFile, 'utf8'));
const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
const status = JSON.parse(output);
if (flow.current_step !== 'execute' || session.flow_run?.current_step !== 'execute' || status.current_step !== 'execute') process.exit(1);
if ((flow.transitions || []).filter((entry) => entry.type === 'route_back').length !== 1) process.exit(1);
if (session.flow_run?.route_back_attempt !== 1 || session.flow_run?.route_back_max_attempts !== 3) process.exit(1);
if (!String(status.next_action?.summary || '').includes('implementation-scope')) process.exit(1);
NODE
pass 'the later execute visit requires fresh scope evidence and preserves the first route attempt'
