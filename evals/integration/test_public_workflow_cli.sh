#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS %s\n' "$*"; }

cd "$ROOT_DIR"
npm run build --silent
npm run build:bundles --silent
npm pack --silent --pack-destination "$TMP" >/dev/null
TARBALL="$(find "$TMP" -maxdepth 1 -name 'kontourai-flow-agents-*.tgz' -print -quit)"
[[ -n "$TARBALL" ]] || fail "npm pack did not produce a tarball"
VERSION="$(node -p "require('./package.json').version")"
CONSUMER="$TMP/consumer"
ARTIFACT_ROOT="$CONSUMER/.kontourai/flow-agents"
mkdir -p "$CONSUMER"

run_candidate() {
  (cd "$CONSUMER" && CODEX_SESSION_ID=public-workflow-eval npx --yes --package="file:$TARBALL" flow-agents workflow "$@")
}

PRIMARY_HELP="$(cd "$CONSUMER" && npx --yes --package="file:$TARBALL" flow-agents --help)"
WORKFLOW_HELP="$(run_candidate --help)"
[[ "$PRIMARY_HELP" == *"workflow"* && "$WORKFLOW_HELP" != *"workflow-sidecar"* && "$WORKFLOW_HELP" != *"npm run workflow:sidecar"* ]] || fail "public help exposes internal writer terminology or omits workflow"
pass "primary help exposes the public workflow command without internal writer terminology"

run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item acme/widgets#101 --summary "Release fixture" >/dev/null
RELEASE_SESSION="$ARTIFACT_ROOT/acme-widgets-101"
[[ -f "$RELEASE_SESSION/state.json" ]] || fail "packed start did not create a session"
[[ ! -e "$CONSUMER/package.json" ]] || fail "consumer unexpectedly gained package.json"
pass "packed start works in a non-Node consumer"
set +e
UNSAFE_START="$(run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item acme/widgets#103 --skip-ownership-guard 2>&1)"
UNSAFE_START_RC=$?
set -e
[[ "$UNSAFE_START_RC" -ne 0 && "$UNSAFE_START" == *"does not support --skip-ownership-guard"* && ! -e "$ARTIFACT_ROOT/acme-widgets-103" ]] || fail "public start accepted an internal ownership bypass"
pass "public start rejects internal authority flags before mutation"

LOCAL_RETRY_PROJECT="$TMP/local-retry-project"
LOCAL_RETRY_ROOT="$LOCAL_RETRY_PROJECT/.kontourai/flow-agents"
mkdir -p "$LOCAL_RETRY_PROJECT/.kontourai"
printf 'not a run-store directory\n' >"$LOCAL_RETRY_PROJECT/.kontourai/flow"
set +e
(cd "$LOCAL_RETRY_PROJECT" && CODEX_SESSION_ID=public-workflow-eval npx --yes --package="file:$TARBALL" flow-agents-workflow-sidecar ensure-session \
  --artifact-root "$LOCAL_RETRY_ROOT" --task-slug local-retry \
  --title "Local retry" --summary "Resume the bound local workflow." --flow-id builder.build >/dev/null 2>&1)
LOCAL_SEED_RC=$?
set -e
[[ "$LOCAL_SEED_RC" -ne 0 ]] || fail "local retry fixture unexpectedly started against an invalid Flow store"
LOCAL_RETRY_COMMAND="$(node -p "JSON.parse(require('fs').readFileSync('$LOCAL_RETRY_ROOT/local-retry/state.json')).next_action.command")"
[[ "$LOCAL_RETRY_COMMAND" == *"'--work-item' 'local:local-retry'"* && "$LOCAL_RETRY_COMMAND" == *"'--task-slug' 'local-retry'"* && "$LOCAL_RETRY_COMMAND" == *"'--artifact-root' '$LOCAL_RETRY_ROOT'"* ]] || fail "emitted local retry did not bind its Work Item, slug, and originating artifact root"
rm -f "$LOCAL_RETRY_PROJECT/.kontourai/flow"
FOREIGN_RETRY_CWD="$TMP/foreign-retry-cwd"
mkdir -p "$FOREIGN_RETRY_CWD"
EXECUTABLE_RETRY="$(node -e 'process.stdout.write(process.argv[1].replace(process.argv[2], process.argv[3]))' "$LOCAL_RETRY_COMMAND" "'@kontourai/flow-agents@$VERSION'" "'file:$TARBALL'")"
(cd "$FOREIGN_RETRY_CWD" && CODEX_SESSION_ID=public-workflow-eval eval "$EXECUTABLE_RETRY" >/dev/null)
[[ -f "$LOCAL_RETRY_PROJECT/.kontourai/flow/runs/local-retry/state.json" && ! -e "$FOREIGN_RETRY_CWD/.kontourai" ]] || fail "emitted local retry mutated the caller cwd instead of the originating store"
pass "emitted local retry executes from a foreign cwd against its exact originating store"

snapshot_tree() {
  local root="$1"
  find "$root" -type f -print0 | sort -z | xargs -0 shasum -a 256
}
BEFORE_STATUS="$(snapshot_tree "$CONSUMER/.kontourai")"
STATUS_JSON="$(run_candidate status --artifact-root "$ARTIFACT_ROOT" --json)"
AFTER_STATUS="$(snapshot_tree "$CONSUMER/.kontourai")"
[[ "$BEFORE_STATUS" == "$AFTER_STATUS" ]] || fail "workflow status mutated durable artifacts"
node -e 'const r=JSON.parse(process.argv[1]); if(r.definition_id!=="builder.build"||r.current_step!=="design-probe")process.exit(1)' "$STATUS_JSON" || fail "status did not report canonical run"
pass "status is canonical and byte-read-only"

FLOW_MANIFEST="$CONSUMER/.kontourai/flow/runs/acme-widgets-101/evidence/manifest.json"
BEFORE_EVIDENCE="$(node -p "JSON.parse(require('fs').readFileSync('$FLOW_MANIFEST')).evidence.length")"
run_candidate evidence --session-dir "$RELEASE_SESSION" --expectation pickup-probe-readiness --status not_verified --summary "Consumer fixture intentionally leaves this claim unverified." --json >/dev/null
AFTER_EVIDENCE="$(node -p "JSON.parse(require('fs').readFileSync('$FLOW_MANIFEST')).evidence.length")"
[[ "$AFTER_EVIDENCE" -eq $((BEFORE_EVIDENCE + 1)) ]] || fail "evidence invocation did not attach exactly once"
pass "evidence records and synchronizes exactly once"

OUTSIDE="$TMP/outside-session"
mkdir -p "$OUTSIDE"
printf '{"schema_version":"1.0","task_slug":"outside"}\n' >"$OUTSIDE/state.json"
ln -s "$OUTSIDE" "$ARTIFACT_ROOT/symlink-session"
OUTSIDE_BEFORE="$(snapshot_tree "$OUTSIDE")"
set +e
SYMLINK_EVIDENCE="$(run_candidate evidence --session-dir "$ARTIFACT_ROOT/symlink-session" --expectation pickup-probe-readiness --status not_verified --summary rejected 2>&1)"
SYMLINK_RC=$?
set -e
[[ "$SYMLINK_RC" -ne 0 && "$SYMLINK_EVIDENCE" == *"session directory must be a non-symlink directory"* && "$(snapshot_tree "$OUTSIDE")" == "$OUTSIDE_BEFORE" ]] || fail "evidence followed a symlinked session"
pass "evidence rejects symlinked session paths before mutation"

run_candidate pause --session-dir "$RELEASE_SESSION" --reason "consumer pause" >/dev/null
run_candidate resume --session-dir "$RELEASE_SESSION" --reason "consumer resume" >/dev/null
run_candidate release --session-dir "$RELEASE_SESSION" --reason "consumer release" >/dev/null
node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1]));if(r.status!=="released")process.exit(1)' "$ARTIFACT_ROOT/assignment/acme-widgets-101.json" || fail "release did not release assignment"
pass "pause, resume, and release use the public command"

run_candidate start --artifact-root "$ARTIFACT_ROOT" --flow builder.build --work-item acme/widgets#102 --summary "Cancel fixture" >/dev/null
CANCEL_SESSION="$ARTIFACT_ROOT/acme-widgets-102"
node --input-type=module - "$CONSUMER" "$CANCEL_SESSION" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
const [project, session] = process.argv.slice(2);
const slug = path.basename(session);
const assignment = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow-agents', 'assignment', `${slug}.json`), 'utf8'));
const state = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8'));
const keys = generateKeyPairSync('ed25519');
fs.mkdirSync(path.join(project, '.flow-agents'), { recursive: true });
fs.writeFileSync(path.join(project, '.flow-agents', 'lifecycle-authority-keys.json'), JSON.stringify({ schema_version: '1.0', keys: [{ id: 'consumer', algorithm: 'ed25519', public_key_pem: keys.publicKey.export({ type: 'spki', format: 'pem' }) }] }, null, 2));
for (const operation of ['cancel', 'archive']) {
  const requestedAt = new Date();
  const unsigned = {
    schema_version: '1.0', operation, run_id: slug, subject: state.work_item_refs[0],
    assignment_actor_key: assignment.actor_key,
    assignment_actor: { ...assignment.actor, human: assignment.actor.human ?? null },
    nonce: `consumer-${operation}`,
    expires_at: new Date(requestedAt.getTime() + 3600000).toISOString(),
    request: { reason: `consumer ${operation}`, authority: { kind: 'user_request', actor: 'consumer-user', request_ref: `fixture://consumer/${operation}`, requested_at: requestedAt.toISOString() } },
  };
  const authorization = { ...unsigned, signature: { algorithm: 'ed25519', key_id: 'consumer', value: sign(null, Buffer.from(JSON.stringify(unsigned)), keys.privateKey).toString('base64') } };
  fs.writeFileSync(path.join(project, `${operation}.authorization.json`), JSON.stringify(authorization, null, 2));
}
NODE
run_candidate cancel --session-dir "$CANCEL_SESSION" --authorization-file "$CONSUMER/cancel.authorization.json" >/dev/null
run_candidate archive --session-dir "$CANCEL_SESSION" --authorization-file "$CONSUMER/archive.authorization.json" >/dev/null
[[ -f "$ARTIFACT_ROOT/archive/acme-widgets-102/state.json" && ! -e "$CANCEL_SESSION" ]] || fail "cancel/archive did not retain archived session"
pass "signed cancel and archive execute through the public command"

DOCTOR="$TMP/doctor-consumer"
mkdir -p "$DOCTOR/node_modules/@kontourai/flow-agents" "$DOCTOR/node_modules/.bin" "$DOCTOR/.flow-agents" "$DOCTOR/kits/builder/flows" "$DOCTOR/.kontourai/flow-agents/doctor-session"
cat >"$DOCTOR/node_modules/@kontourai/flow-agents/package.json" <<'JSON'
{"name":"@kontourai/flow-agents","version":"3.4.3","bin":{"flow-agents":"bin.js"}}
JSON
cat >"$DOCTOR/node_modules/.bin/flow-agents" <<'SH'
#!/usr/bin/env bash
echo STALE_LOCAL_BINARY
SH
chmod +x "$DOCTOR/node_modules/.bin/flow-agents"
cat >"$DOCTOR/.flow-agents/install.json" <<'JSON'
{"version":"3.4.3","runtime":"codex","active_kit_ids":["builder"]}
JSON
cat >"$DOCTOR/kits/builder/kit.json" <<'JSON'
{"schema_version":"0.9","id":"builder"}
JSON
cat >"$DOCTOR/kits/builder/flows/build.flow.json" <<'JSON'
{"id":"builder.build","version":"0.9"}
JSON
cat >"$DOCTOR/.kontourai/flow-agents/current.json" <<'JSON'
{"active_slug":"doctor-session","artifact_dir":"doctor-session"}
JSON
cat >"$DOCTOR/.kontourai/flow-agents/doctor-session/state.json" <<'JSON'
{"schema_version":"0.9","task_slug":"doctor-session","flow_run":{"definition_id":"builder.build","definition_version":"0.9"}}
JSON
cat >"$DOCTOR/.kontourai/flow-agents/doctor-session/trust.bundle" <<'JSON'
{"schema_version":"0.9"}
JSON
set +e
DOCTOR_JSON="$(cd "$DOCTOR" && npx --yes --package="file:$TARBALL" flow-agents workflow doctor --project-root "$DOCTOR" --artifact-root "$DOCTOR/.kontourai/flow-agents" --json 2>/dev/null)"
DOCTOR_RC=$?
set -e
[[ "$DOCTOR_RC" -eq 2 ]] || fail "doctor should return 2 for incompatible consumer fixtures"
node - "$DOCTOR_JSON" "$VERSION" "$DOCTOR" <<'NODE'
const [reportText, version, root] = process.argv.slice(2);
const report = JSON.parse(reportText);
if (report.cli.version !== version || report.cli.workflow_contract_version !== '1.0') process.exit(1);
if (report.local_dependency.version !== '3.4.3' || report.local_dependency.selected !== false) process.exit(2);
if (!report.warnings.some((w) => w.includes('hook/writer version 3.4.3'))) process.exit(3);
if (!report.warnings.some((w) => w.includes('Builder Kit'))) process.exit(4);
if (!report.warnings.some((w) => w.includes('builder.build version 0.9'))) process.exit(5);
if (!report.warnings.some((w) => w.includes('Artifact schema 0.9'))) process.exit(6);
if (!report.warnings.some((w) => w.includes('Trust bundle schema 0.9'))) process.exit(7);
if (!report.warnings.some((w) => w.includes('hook/writer assets failed integrity'))) process.exit(10);
if (!report.remediation.startsWith('sh -c ') || !report.remediation.includes(`'@kontourai/flow-agents@${version}'`) || !report.remediation.includes("'--runtime' 'codex'") || !report.remediation.includes("'--activate-kit' 'builder'")) process.exit(8);
if (report.cli.package_root.startsWith(root)) process.exit(9);
NODE
pass "doctor detects same-major hook/writer, Kit, Flow, and schema skew with exact remediation"
[[ "$DOCTOR_JSON" != *"STALE_LOCAL_BINARY"* ]] || fail "explicit package invocation selected stale local binary"
pass "explicit packed package wins over an old local dependency"

node - "$DOCTOR/node_modules/@kontourai/flow-agents/package.json" "$VERSION" <<'NODE'
const fs = require('node:fs');
const [file, version] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
value.version = version;
fs.writeFileSync(file, JSON.stringify(value));
NODE
SAME_VERSION_HELP="$(cd "$DOCTOR" && npx --yes --package="file:$TARBALL" flow-agents --help)"
[[ "$SAME_VERSION_HELP" == *"workflow"* && "$SAME_VERSION_HELP" != *"STALE_LOCAL_BINARY"* ]] || fail "explicit tarball selected a hostile same-version local binary"
pass "explicit tarball wins over a hostile same-version local binary"

PINNED_COMMAND_MODULE="pinned-cli-command.js"
ISOLATED_COMMAND="$(node --input-type=module - "$ROOT_DIR/build/src/lib/$PINNED_COMMAND_MODULE" "file:$TARBALL" <<'NODE'
import { pathToFileURL } from 'node:url';
const [modulePath, packageSpec] = process.argv.slice(2);
const { isolatedPackageCommand } = await import(pathToFileURL(modulePath));
console.log(isolatedPackageCommand(packageSpec, 'flow-agents', ['--help']));
NODE
)"
ISOLATED_HELP="$(cd "$DOCTOR" && eval "$ISOLATED_COMMAND")"
[[ "$ISOLATED_HELP" == *"workflow"* && "$ISOLATED_HELP" != *"STALE_LOCAL_BINARY"* ]] || fail "isolated package command selected a hostile same-version local binary"
pass "generated isolated package command defeats a hostile same-version local binary"

rm -f "$DOCTOR/kits/builder/kit.json" "$DOCTOR/kits/builder/flows/build.flow.json"
printf '{"version":"%s","runtime":"codex","active_kit_ids":["builder"]}\n' "$VERSION" >"$DOCTOR/.flow-agents/install.json"
set +e
MISSING_JSON="$(cd "$DOCTOR" && npx --yes --package="file:$TARBALL" flow-agents workflow doctor --project-root "$DOCTOR" --artifact-root "$DOCTOR/.kontourai/flow-agents" --json 2>/dev/null)"
MISSING_RC=$?
set -e
[[ "$MISSING_RC" -eq 2 ]] || fail "doctor should fail when an activated Kit is missing"
node -e 'const r=JSON.parse(process.argv[1]);if(!r.warnings.some(w=>w.includes("Activated Builder Kit is missing"))||!r.warnings.some(w=>w.includes("Activated builder.build definition is missing")))process.exit(1)' "$MISSING_JSON" || fail "doctor did not report missing activated Kit components"
pass "doctor fails closed for missing activated Kit components"

HEALTHY="$TMP/healthy-install"
mkdir -p "$HEALTHY"
(cd "$HEALTHY" && npx --yes --package="file:$TARBALL" flow-agents init --runtime codex --dest "$HEALTHY" --activate-kit builder --yes >/dev/null)
HEALTHY_JSON="$(cd "$HEALTHY" && npx --yes --package="file:$TARBALL" flow-agents workflow doctor --project-root "$HEALTHY" --artifact-root "$HEALTHY/.kontourai/flow-agents" --json)"
node -e 'const r=JSON.parse(process.argv[1]);if(!r.ok||r.warnings.length||!r.hook.integrity.ok||r.installed.active_kit_ids[0]!=="builder")process.exit(1)' "$HEALTHY_JSON" || fail "doctor did not pass immediately after its own remediation install"
pass "real init converges to doctor PASS"

cp "$HEALTHY/build/src/cli/workflow.js" "$TMP/workflow.js.clean"
printf '\n// WORKFLOW_CONTRACT_VERSION = "1.0"\n' >>"$HEALTHY/build/src/cli/workflow.js"
set +e
TAMPERED_CLI_JSON="$(cd "$HEALTHY" && npx --yes --package="file:$TARBALL" flow-agents workflow doctor --project-root "$HEALTHY" --artifact-root "$HEALTHY/.kontourai/flow-agents" --json 2>/dev/null)"
TAMPERED_CLI_RC=$?
set -e
[[ "$TAMPERED_CLI_RC" -eq 2 && "$TAMPERED_CLI_JSON" == *"asset mismatch: build/src/cli/workflow.js"* ]] || fail "doctor accepted marker-preserving CLI tampering"
cp "$TMP/workflow.js.clean" "$HEALTHY/build/src/cli/workflow.js"
pass "doctor rejects marker-preserving CLI tampering"

cp "$HEALTHY/.codex/hooks.json" "$TMP/hooks.json.clean"
node - "$HEALTHY/.codex/hooks.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const group = value.hooks.SessionStart.find((entry) => JSON.stringify(entry).includes('workflow-steering'));
group.hooks[0].command += '; true';
fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
NODE
set +e
TAMPERED_HOOK_JSON="$(cd "$HEALTHY" && npx --yes --package="file:$TARBALL" flow-agents workflow doctor --project-root "$HEALTHY" --artifact-root "$HEALTHY/.kontourai/flow-agents" --json 2>/dev/null)"
TAMPERED_HOOK_RC=$?
set -e
[[ "$TAMPERED_HOOK_RC" -eq 2 && "$TAMPERED_HOOK_JSON" == *"does not contain the packaged managed hooks"* ]] || fail "doctor accepted name-preserving hook tampering"
cp "$TMP/hooks.json.clean" "$HEALTHY/.codex/hooks.json"
pass "doctor rejects name-preserving hook configuration tampering"

for RUNTIME in base claude-code opencode pi kiro; do
  RUNTIME_ROOT="$TMP/runtime-$RUNTIME"
  mkdir -p "$RUNTIME_ROOT"
  (cd "$RUNTIME_ROOT" && npx --yes --package="file:$TARBALL" flow-agents init --runtime "$RUNTIME" --dest "$RUNTIME_ROOT" --activate-kit builder --yes >/dev/null)
  RUNTIME_JSON="$(cd "$RUNTIME_ROOT" && npx --yes --package="file:$TARBALL" flow-agents workflow doctor --project-root "$RUNTIME_ROOT" --artifact-root "$RUNTIME_ROOT/.kontourai/flow-agents" --json)"
  node -e 'const r=JSON.parse(process.argv[1]);if(!r.ok||r.warnings.length||!r.hook.integrity.ok)process.exit(1)' "$RUNTIME_JSON" || fail "doctor did not validate $RUNTIME runtime wiring"
  pass "doctor validates $RUNTIME runtime wiring"
done

printf 'public workflow CLI integration passed\n'
