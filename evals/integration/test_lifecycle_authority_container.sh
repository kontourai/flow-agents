#!/usr/bin/env bash
# Root/container conformance for the externally provisioned lifecycle authority.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v docker >/dev/null || { echo "SKIP: docker unavailable"; exit 77; }

docker run --rm -i -v "$ROOT_DIR:/src:ro" node:22-bookworm bash -s <<'CONTAINER'
set -euo pipefail
apt-get update -qq && apt-get install -y -qq sudo git >/dev/null
cp -a /src /work && cd /work
npm ci --ignore-scripts --silent
npm run build --silent
# AC-5 capacity boundary: the direct privileged installer source must name and
# use the isolated canonical-manifest cap.  The focused Node test exercises the
# generated protected JSON fixtures; this container assertion proves the source
# handed to the root installer retains that exact boundary.
node - /work/packaging/lifecycle-authority/coordinator.mjs <<'NODE'
const fs = require('node:fs');
const source = fs.readFileSync(process.argv[2], 'utf8');
if (!/(?:export\s+)?const\s+MAX_CANONICAL_FLOW_MANIFEST_BYTES\s*=\s*16\s*\*\s*1024\s*\*\s*1024\s*;/.test(source)) {
  throw new Error('coordinator must declare the named 16 MiB canonical-manifest cap');
}
if (!/protectedRegularFile\(\s*files\.manifest,\s*"canonical Flow evidence manifest",\s*MAX_CANONICAL_FLOW_MANIFEST_BYTES\s*\)/s.test(source)) {
  throw new Error('coordinator must apply the named cap only to the canonical evidence manifest');
}
if (!/(?:lifecycle-authority\.resolution-events\.json[\s\S]{0,800}protectedJson|protectedJson[\s\S]{0,800}lifecycle-authority\.resolution-events\.json)/.test(source)) {
  throw new Error('coordinator must protected-load the external lifecycle resolution-event ledger');
}
if (!/validat\w*Resolution\w*(?:Event|Ledger)/i.test(source)) {
  throw new Error('coordinator must validate the external resolution-event ledger before mutation');
}
NODE
# The privileged coordinator intentionally remains pinned to the audited Flow 3.5.0
# reducer closure even when the application runtime consumes a newer Flow release.
pinned_reducer_root="$(mktemp -d)"
npm install --prefix "$pinned_reducer_root" --ignore-scripts --no-save --silent \
  @kontourai/flow@3.5.0 \
  @kontourai/surface@2.13.0 \
  hachure@0.15.0 \
  ajv@8.20.0 \
  ajv-formats@3.0.1 \
  fast-deep-equal@3.1.3 \
  fast-uri@3.1.2 \
  json-schema-traverse@1.0.0 \
  require-from-string@2.0.2
pinned_reducer_modules="$pinned_reducer_root/node_modules"
bad_modules="$(mktemp -d)"
mkdir -p "$bad_modules/@kontourai"
ln -s "$pinned_reducer_modules/@kontourai/flow" "$bad_modules/@kontourai/flow"
if scripts/lifecycle-authority-admin.sh install packaging/lifecycle-authority/coordinator.mjs "$bad_modules" kontourai-lifecycle-operator >/tmp/rejected-staged-reducer.log 2>&1; then
  echo "symlinked staged reducer unexpectedly installed" >&2; exit 1
fi
tampered_modules="$(mktemp -d)"
cp -a "$pinned_reducer_modules/." "$tampered_modules/"
printf '\n// tampered fixture\n' >> "$tampered_modules/@kontourai/flow/dist/index.js"
if scripts/lifecycle-authority-admin.sh install packaging/lifecycle-authority/coordinator.mjs "$tampered_modules" kontourai-lifecycle-operator >/tmp/rejected-tampered-reducer.log 2>&1; then
  echo "tampered staged reducer unexpectedly installed" >&2; exit 1
fi
scripts/lifecycle-authority-admin.sh install packaging/lifecycle-authority/coordinator.mjs "$pinned_reducer_modules" kontourai-lifecycle-operator
usermod -a -G kontourai-lifecycle-operator node
test -f /etc/sudoers.d/kontourai-flow-agents-lifecycle-authority-v1
visudo -cf /etc/sudoers.d/kontourai-flow-agents-lifecycle-authority-v1 >/dev/null
SYSTEM_PREFIX=/usr/local
export LIFECYCLE_HELPER_PATH="$SYSTEM_PREFIX/libexec/kontourai/flow-agents-lifecycle-authority-v1"
stat -c "%U %a" "$LIFECYCLE_HELPER_PATH" | grep -qx "root 755"

CONFIG=/etc/kontourai/flow-agents-lifecycle-authority-v1
STATE_SEGMENT=lib
STATE="/var/$STATE_SEGMENT/kontourai/flow-agents-lifecycle-authority-v1"
export LIFECYCLE_STATE_ROOT="$STATE"
mkdir -p "$CONFIG" "$STATE" /root/lifecycle-authorizations
node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const config = '/etc/kontourai/flow-agents-lifecycle-authority-v1';
const authority = crypto.generateKeyPairSync('ed25519');
const completion = crypto.generateKeyPairSync('ed25519');
const pem = (key) => key.export({ type: key.type === 'private' ? 'pkcs8' : 'spki', format: 'pem' });
fs.writeFileSync('/root/lifecycle-authorizations/authority-private.pem', pem(authority.privateKey), { mode: 0o600 });
fs.writeFileSync(`${config}/keys.json`, `${JSON.stringify({ schema_version: '1.0', keys: [{ id: 'fixture-authority', algorithm: 'ed25519', public_key_pem: pem(authority.publicKey) }] })}\n`, { mode: 0o644 });
fs.writeFileSync(`${config}/completion-signing-key.pem`, pem(completion.privateKey), { mode: 0o600 });
fs.writeFileSync(`${config}/completion-verification-key.pem`, pem(completion.publicKey), { mode: 0o644 });
NODE
chown -R root:root "$CONFIG" "$STATE" /root/lifecycle-authorizations
chmod 755 /etc/kontourai "$CONFIG"
chmod 700 "$STATE" /root/lifecycle-authorizations
chmod 600 "$CONFIG/completion-signing-key.pem" /root/lifecycle-authorizations/authority-private.pem
chmod 644 "$CONFIG/keys.json" "$CONFIG/completion-verification-key.pem"
mkdir -p /tmp/lifecycle-root-target
printf 'root-owned sentinel\n' > /tmp/lifecycle-root-target/sentinel
chown -R root:root /tmp/lifecycle-root-target
chmod 755 /tmp/lifecycle-root-target
chmod 644 /tmp/lifecycle-root-target/sentinel

set +e
helper_output=$(su -s /bin/bash node -c "sudo -n -- '$LIFECYCLE_HELPER_PATH' </dev/null" 2>&1)
helper_status=$?
set -e
test "$helper_status" -ne 0
printf "%s" "$helper_output" | grep -q "exactly one JSON request line"
if su -s /bin/bash node -c "sudo -n -- '$LIFECYCLE_HELPER_PATH' unexpected </dev/null"; then exit 1; fi
if su -s /bin/bash nobody -c "sudo -n -- '$LIFECYCLE_HELPER_PATH' </dev/null"; then exit 1; fi

cat > /work/setup-fixture.mjs <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { startBuilderFlowSession } from './build/src/builder-flow-runtime.js';
import { performLocalClaim } from './build/src/cli/assignment-provider.js';
const project = '/tmp/lifecycle-authority-e2e';
const subject = 'local:work-item/lifecycle-authority-e2e';
const actor = { runtime: 'fixture', session_id: 'lifecycle-e2e', host: 'container', human: null };
const actorKey = 'fixture:lifecycle-e2e:container';
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
async function makeSession(slug) {
  const session = path.join(project, '.kontourai', 'flow-agents', slug);
  write(path.join(session, 'state.json'), { schema_version: '1.0', task_slug: slug, status: 'planned', phase: 'planning', updated_at: new Date().toISOString(), work_item_refs: [subject], next_action: { status: 'continue', summary: 'Fixture lifecycle operation.' } });
  write(path.join(session, 'acceptance.json'), { schema_version: '1.0', task_slug: slug, criteria: [{ id: 'AC-1', description: 'The signed lifecycle transition is accepted by Builder.', status: 'pending', evidence_refs: [] }], goal_fit: { status: 'pending', summary: 'Fixture acceptance is pending.' } });
  await startBuilderFlowSession({ sessionDir: session });
  performLocalClaim(path.join(project, '.kontourai', 'flow-agents'), slug, actor, { ttlSeconds: 1800, actorKey, branch: `fixture/${slug}`, artifactDir: slug, workItemRef: subject, reason: 'container lifecycle fixture' });
  return session;
}
fs.rmSync(project, { recursive: true, force: true }); fs.mkdirSync(path.join(project, 'review-target'), { recursive: true });
fs.writeFileSync(path.join(project, 'package.json'), '{"name":"lifecycle-authority-e2e","private":true}\n');
fs.writeFileSync(path.join(project, 'review-target', 'delivery.md'), 'fixture delivery\n');
fs.writeFileSync(path.join(project, 'review-target', 'fixture.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('lifecycle fixture', () => assert.equal(1, 1));\n");
fs.writeFileSync(path.join(project, '.gitignore'), '.kontourai/\n');
for (const args of [
  ['init', '-q'],
  ['config', 'user.name', 'Lifecycle Fixture'],
  ['config', 'user.email', 'lifecycle-fixture@invalid.example'],
  ['add', '.gitignore', 'package.json', 'review-target'],
  ['commit', '-qm', 'fixture baseline'],
]) {
  const result = spawnSync('git', args, { cwd: project, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stdout}${result.stderr}`);
}
for (const slug of ['resolve-e2e', 'reseal-e2e', 'repair-e2e', 'bridge-e2e', 'archive-e2e', 'stale-e2e', 'unauthorized-e2e', 'concurrent-e2e', 'symlink-e2e', 'legacy-e2e', 'legacy-mismatch-e2e', 'legacy-same-nonce-e2e', 'legacy-recovery-e2e']) await makeSession(slug);
for (const slug of ['legacy-e2e', 'legacy-mismatch-e2e', 'legacy-same-nonce-e2e', 'legacy-recovery-e2e']) {
  const assignment = path.join(project, '.kontourai', 'flow-agents', 'assignment', `${slug}.json`);
  const record = JSON.parse(fs.readFileSync(assignment, 'utf8'));
  delete record.actor.human;
  write(assignment, record);
}
write(path.join(project, 'fixture.json'), { project, subject, actor, actorKey });
NODE
node /work/setup-fixture.mjs

PROJECT=/tmp/lifecycle-authority-e2e
RESOLVE_SESSION="$PROJECT/.kontourai/flow-agents/resolve-e2e"
DELIVERY="$PROJECT/review-target/delivery.md"
node - "$PROJECT" "$RESOLVE_SESSION" <<'NODE'
const fs = require('node:fs'), path = require('node:path'); const [project, session] = process.argv.slice(2);
const flowFile = path.join(project, '.kontourai', 'flow', 'runs', 'resolve-e2e', 'state.json');
const flow = JSON.parse(fs.readFileSync(flowFile, 'utf8')); flow.current_step = 'verify'; fs.writeFileSync(flowFile, `${JSON.stringify(flow, null, 2)}\n`);
const sidecarFile = path.join(session, 'state.json'); const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
if (sidecar.flow_run) sidecar.flow_run.current_step = 'verify'; fs.writeFileSync(sidecarFile, `${JSON.stringify(sidecar, null, 2)}\n`);
NODE
node build/src/cli/workflow-sidecar.js record-evidence "$RESOLVE_SESSION" --verdict pass --check-json '{"id":"fixture-check","kind":"test","status":"pass","summary":"Fixture check passed."}' --command 'node --test review-target/fixture.test.mjs' --evidence-ref-json '{"kind":"command","excerpt":"node --test review-target/fixture.test.mjs","summary":"Runs the lifecycle fixture test."}' --criterion-json '{"id":"AC-1","status":"pass","evidence_refs":[{"kind":"command","excerpt":"node --test review-target/fixture.test.mjs","summary":"Runs the lifecycle fixture test."}]}' --timestamp "2026-07-20T00:00:00Z" >/dev/null
node - "$RESOLVE_SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
const acceptance = bundle.claims.find((claim) => claim.claimType === 'workflow.acceptance.criterion'); if (!acceptance) throw new Error('fixture acceptance claim is missing');
acceptance.value = 'pass'; acceptance.status = 'verified'; fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
node build/src/cli/workflow-sidecar.js record-critique "$RESOLVE_SESSION" --id failed-review --reviewer reviewer-one --verdict fail --summary "Fixture defect." --artifact-ref "$DELIVERY" --lane-json '{"id":"code","status":"fail","summary":"Fixture defect remains.","evidence_refs":[{"kind":"artifact","file":"review-target/delivery.md","summary":"Fixture delivery review."}]}' --finding-json '{"id":"fixture-defect","severity":"high","status":"open","description":"Repair required."}' --timestamp "2026-07-20T00:01:00Z" >/dev/null
printf 'fixture delivery repaired\n' > "$DELIVERY"
node build/src/cli/workflow-sidecar.js record-critique "$RESOLVE_SESSION" --id repaired-review --reviewer reviewer-two --verdict pass --summary "Fixture repair verified." --artifact-ref "$DELIVERY" --lane-json '{"id":"code","status":"pass","summary":"Fixture repair verified.","evidence_refs":[{"kind":"artifact","file":"review-target/delivery.md","summary":"Fixture delivery review."}]}' --finding-json '{"id":"fixture-defect","severity":"high","status":"fixed","description":"Repair verified."}' --timestamp "2026-07-20T00:02:00Z" >/dev/null
node - "$RESOLVE_SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
const acceptance = bundle.claims.find((claim) => claim.claimType === 'workflow.acceptance.criterion'); if (!acceptance) throw new Error('fixture acceptance claim is missing after critique rebuild');
acceptance.value = 'pass'; acceptance.status = 'verified'; fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE

# Prepare a separate verify-gate claim and critique pair. Its signed resolution
# creates the exact-current completion that the two-stage reseal must replace.
RESEAL_SESSION="$PROJECT/.kontourai/flow-agents/reseal-e2e"
node - "$PROJECT" "$RESEAL_SESSION" <<'NODE'
const fs = require('node:fs'), path = require('node:path'); const [project, session] = process.argv.slice(2);
const flowFile = path.join(project, '.kontourai', 'flow', 'runs', 'reseal-e2e', 'state.json');
const flow = JSON.parse(fs.readFileSync(flowFile, 'utf8')); flow.current_step = 'verify'; fs.writeFileSync(flowFile, `${JSON.stringify(flow, null, 2)}\n`);
const sidecarFile = path.join(session, 'state.json'); const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
if (sidecar.flow_run) sidecar.flow_run.current_step = 'verify'; fs.writeFileSync(sidecarFile, `${JSON.stringify(sidecar, null, 2)}\n`);
const acceptanceFile = path.join(session, 'acceptance.json'), acceptance = JSON.parse(fs.readFileSync(acceptanceFile, 'utf8'));
acceptance.criteria = []; fs.writeFileSync(acceptanceFile, `${JSON.stringify(acceptance, null, 2)}\n`);
NODE
node build/src/cli/workflow-sidecar.js record-gate-claim "$RESEAL_SESSION" --expectation policy-compliance --status not_verified --summary "Pre-resolution policy evidence was incomplete." --timestamp "2026-07-20T00:10:00Z" >/dev/null
printf 'reseal delivery failed\n' > "$DELIVERY"
node build/src/cli/workflow-sidecar.js record-critique "$RESEAL_SESSION" --id reseal-failed-review --reviewer reseal-reviewer-one --verdict fail --summary "Reseal fixture defect." --artifact-ref "$DELIVERY" --lane-json '{"id":"reseal-code","status":"fail","summary":"Reseal defect remains.","evidence_refs":[{"kind":"artifact","file":"review-target/delivery.md","summary":"Reseal delivery review."}]}' --finding-json '{"id":"reseal-defect","severity":"high","status":"open","description":"Reseal repair required."}' --timestamp "2026-07-20T00:11:00Z" >/dev/null
printf 'reseal delivery repaired\n' > "$DELIVERY"
node build/src/cli/workflow-sidecar.js record-critique "$RESEAL_SESSION" --id reseal-repaired-review --reviewer reseal-reviewer-two --verdict pass --summary "Reseal fixture repair verified." --artifact-ref "$DELIVERY" --lane-json '{"id":"reseal-code","status":"pass","summary":"Reseal repair verified.","evidence_refs":[{"kind":"artifact","file":"review-target/delivery.md","summary":"Reseal delivery review."}]}' --finding-json '{"id":"reseal-defect","severity":"high","status":"fixed","description":"Reseal repair verified."}' --timestamp "2026-07-20T00:12:00Z" >/dev/null

# Build a separate five-edge history fixture.  The first three resolutions model
# the legacy coordinator overwrite; its surviving third event is re-rooted as
# ledger sequence 1, then two distinct repair attestations fill the disclosed
# gaps before two ordinary resolutions continue the chain.
REPAIR_SESSION="$PROJECT/.kontourai/flow-agents/repair-e2e"
node - "$PROJECT" "$REPAIR_SESSION" <<'NODE'
const fs = require('node:fs'), path = require('node:path'); const [project, session] = process.argv.slice(2);
const flowFile = path.join(project, '.kontourai', 'flow', 'runs', 'repair-e2e', 'state.json'); const flow = JSON.parse(fs.readFileSync(flowFile, 'utf8')); flow.current_step = 'verify'; fs.writeFileSync(flowFile, `${JSON.stringify(flow, null, 2)}\n`);
const sidecarFile = path.join(session, 'state.json'); const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8')); if (sidecar.flow_run) sidecar.flow_run.current_step = 'verify'; fs.writeFileSync(sidecarFile, `${JSON.stringify(sidecar, null, 2)}\n`);
NODE
node build/src/cli/workflow-sidecar.js record-evidence "$REPAIR_SESSION" --verdict pass --check-json '{"id":"repair-fixture-check","kind":"test","status":"pass","summary":"History-repair fixture check passed."}' --command 'node --test review-target/fixture.test.mjs' --evidence-ref-json '{"kind":"command","excerpt":"node --test review-target/fixture.test.mjs","summary":"Runs the lifecycle history-repair fixture test."}' --criterion-json '{"id":"AC-1","status":"pass","evidence_refs":[{"kind":"command","excerpt":"node --test review-target/fixture.test.mjs","summary":"Runs the lifecycle history-repair fixture test."}]}' --timestamp "2026-07-20T00:00:00Z" >/dev/null
for pair in 1 2 3 4 5; do
  failed_minute=$(printf '%02d' "$((pair * 2 - 1))")
  repaired_minute=$(printf '%02d' "$((pair * 2))")
  node build/src/cli/workflow-sidecar.js record-critique "$REPAIR_SESSION" --id "legacy-failed-$pair" --reviewer "legacy-reviewer-$pair" --verdict fail --summary "Legacy fixture defect $pair." --artifact-ref "$DELIVERY" --lane-json "{\"id\":\"code-$pair\",\"status\":\"fail\",\"summary\":\"Fixture defect $pair remains.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"review-target/delivery.md\",\"summary\":\"Fixture delivery review.\"}]}" --finding-json "{\"id\":\"fixture-defect-$pair\",\"severity\":\"high\",\"status\":\"open\",\"description\":\"Repair $pair required.\"}" --timestamp "2026-07-20T00:${failed_minute}:00Z" >/dev/null
  printf 'fixture delivery repaired %s\n' "$pair" > "$DELIVERY"
  node build/src/cli/workflow-sidecar.js record-critique "$REPAIR_SESSION" --id "legacy-repaired-$pair" --reviewer "repair-reviewer-$pair" --verdict pass --summary "Legacy fixture repair $pair verified." --artifact-ref "$DELIVERY" --lane-json "{\"id\":\"code-$pair\",\"status\":\"pass\",\"summary\":\"Fixture repair $pair verified.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"review-target/delivery.md\",\"summary\":\"Fixture delivery review.\"}]}" --finding-json "{\"id\":\"fixture-defect-$pair\",\"severity\":\"high\",\"status\":\"fixed\",\"description\":\"Repair $pair verified.\"}" --timestamp "2026-07-20T00:${repaired_minute}:00Z" >/dev/null
done
node - "$REPAIR_SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
const acceptance = bundle.claims.find((claim) => claim.claimType === 'workflow.acceptance.criterion'); if (!acceptance) throw new Error('history-repair fixture acceptance claim is missing');
acceptance.value = 'pass'; acceptance.status = 'verified'; fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE

# This is the minimal durable bridge fixture: the first ordinary resolution
# creates the only historical root state.  Its later critiques are intentionally
# appended without issuing another completion, so a repair must use all three
# request-keyed anchors rather than treating the old receipt as current.
BRIDGE_SESSION="$PROJECT/.kontourai/flow-agents/bridge-e2e"
node - "$PROJECT" "$BRIDGE_SESSION" <<'NODE'
const fs = require('node:fs'), path = require('node:path'); const [project, session] = process.argv.slice(2);
const flowFile = path.join(project, '.kontourai', 'flow', 'runs', 'bridge-e2e', 'state.json'); const flow = JSON.parse(fs.readFileSync(flowFile, 'utf8')); flow.current_step = 'verify'; fs.writeFileSync(flowFile, `${JSON.stringify(flow, null, 2)}\n`);
const sidecarFile = path.join(session, 'state.json'); const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8')); if (sidecar.flow_run) sidecar.flow_run.current_step = 'verify'; fs.writeFileSync(sidecarFile, `${JSON.stringify(sidecar, null, 2)}\n`);
NODE
node build/src/cli/workflow-sidecar.js record-evidence "$BRIDGE_SESSION" --verdict pass --check-json '{"id":"bridge-fixture-check","kind":"test","status":"pass","summary":"Bridge fixture check passed."}' --command 'node --test review-target/fixture.test.mjs' --evidence-ref-json '{"kind":"command","excerpt":"node --test review-target/fixture.test.mjs","summary":"Runs the lifecycle bridge fixture test."}' --criterion-json '{"id":"AC-1","status":"pass","evidence_refs":[{"kind":"command","excerpt":"node --test review-target/fixture.test.mjs","summary":"Runs the lifecycle bridge fixture test."}]}' --timestamp "2026-07-20T01:00:00Z" >/dev/null
node - "$BRIDGE_SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs'); const file = process.argv[2]; const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
const acceptance = bundle.claims.find((claim) => claim.claimType === 'workflow.acceptance.criterion'); if (!acceptance) throw new Error('bridge fixture acceptance claim is missing');
acceptance.value = 'pass'; acceptance.status = 'verified'; fs.writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
NODE
printf 'bridge delivery A failed\n' > "$DELIVERY"
node build/src/cli/workflow-sidecar.js record-critique "$BRIDGE_SESSION" --id bridge-a-failed --reviewer bridge-reviewer-a --verdict fail --summary "Bridge A failed." --artifact-ref "$DELIVERY" --lane-json '{"id":"bridge-a","status":"fail","summary":"Bridge A remains.","evidence_refs":[{"kind":"artifact","file":"review-target/delivery.md","summary":"Bridge delivery review."}]}' --finding-json '{"id":"bridge-a-defect","severity":"high","status":"open","description":"Bridge A repair required."}' --timestamp "2026-07-20T01:01:00Z" >/dev/null
printf 'bridge delivery A repaired\n' > "$DELIVERY"
node build/src/cli/workflow-sidecar.js record-critique "$BRIDGE_SESSION" --id bridge-a-repaired --reviewer bridge-reviewer-b --verdict pass --summary "Bridge A repaired." --artifact-ref "$DELIVERY" --lane-json '{"id":"bridge-a","status":"pass","summary":"Bridge A repaired.","evidence_refs":[{"kind":"artifact","file":"review-target/delivery.md","summary":"Bridge delivery review."}]}' --finding-json '{"id":"bridge-a-defect","severity":"high","status":"fixed","description":"Bridge A repair verified."}' --timestamp "2026-07-20T01:02:00Z" >/dev/null
mapfile -t CRITIQUE_IDS < <(node - "$RESOLVE_SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs'); for (const claim of JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).claims.filter((claim) => claim.metadata?.origin === 'critique')) console.log(claim.metadata.critique_record_id);
NODE
)
test "${#CRITIQUE_IDS[@]}" -eq 2
node build/src/cli.js workflow resolve-critique-request --session-dir "$RESOLVE_SESSION" --prior-record-id "${CRITIQUE_IDS[0]}" --resolving-record-id "${CRITIQUE_IDS[1]}" > /tmp/resolve-request.json
node build/src/cli/workflow-sidecar.js record-critique "$RESEAL_SESSION" --id reseal-current-clean-review --reviewer reseal-reviewer-three --verdict pass --summary "Current reseal workspace verified." --artifact-ref "$DELIVERY" --lane-json '{"id":"reseal-current","status":"pass","summary":"Current reseal workspace verified.","evidence_refs":[{"kind":"artifact","file":"review-target/delivery.md","summary":"Current reseal delivery review."}]}' --timestamp "2026-07-20T00:13:00Z" >/dev/null
mapfile -t RESEAL_CRITIQUE_IDS < <(node - "$RESEAL_SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs'); for (const claim of JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).claims.filter((claim) => claim.metadata?.origin === 'critique')) console.log(claim.metadata.critique_record_id);
NODE
)
test "${#RESEAL_CRITIQUE_IDS[@]}" -eq 3
node build/src/cli.js workflow resolve-critique-request --session-dir "$RESEAL_SESSION" --prior-record-id "${RESEAL_CRITIQUE_IDS[0]}" --resolving-record-id "${RESEAL_CRITIQUE_IDS[1]}" > /tmp/reseal-resolve-request.json
COPIED_PROJECT=/tmp/lifecycle-authority-copied-project
rm -rf "$COPIED_PROJECT"
cp -a "$PROJECT" "$COPIED_PROJECT"
chown -R node:node "$COPIED_PROJECT"
node build/src/cli.js workflow resolve-critique-request --session-dir "$COPIED_PROJECT/.kontourai/flow-agents/resolve-e2e" --prior-record-id "${CRITIQUE_IDS[0]}" --resolving-record-id "${CRITIQUE_IDS[1]}" > /tmp/copied-project-request.json
WRONG_STEP_PROJECT=/tmp/lifecycle-authority-wrong-step
rm -rf "$WRONG_STEP_PROJECT"
cp -a "$PROJECT" "$WRONG_STEP_PROJECT"
chown -R node:node "$WRONG_STEP_PROJECT"
node build/src/cli.js workflow resolve-critique-request --session-dir "$WRONG_STEP_PROJECT/.kontourai/flow-agents/resolve-e2e" --prior-record-id "${CRITIQUE_IDS[0]}" --resolving-record-id "${CRITIQUE_IDS[1]}" > /tmp/wrong-step-request.json
WRONG_FLOW_PROJECT=/tmp/lifecycle-authority-wrong-flow
rm -rf "$WRONG_FLOW_PROJECT"
cp -a "$PROJECT" "$WRONG_FLOW_PROJECT"
chown -R node:node "$WRONG_FLOW_PROJECT"
node build/src/cli.js workflow resolve-critique-request --session-dir "$WRONG_FLOW_PROJECT/.kontourai/flow-agents/resolve-e2e" --prior-record-id "${CRITIQUE_IDS[0]}" --resolving-record-id "${CRITIQUE_IDS[1]}" > /tmp/wrong-flow-request.json

cat > /work/sign-authorization.mjs <<'NODE'
import fs from 'node:fs'; import crypto from 'node:crypto';
const [input, output] = process.argv.slice(2); const parsed = JSON.parse(fs.readFileSync(input, 'utf8')); const unsigned = parsed.authorization ?? parsed;
const key = crypto.createPrivateKey(fs.readFileSync('/root/lifecycle-authorizations/authority-private.pem'));
const signed = { ...unsigned, signature: { algorithm: 'ed25519', key_id: 'fixture-authority', value: crypto.sign(null, Buffer.from(JSON.stringify(unsigned)), key).toString('base64') } };
fs.writeFileSync(output, `${JSON.stringify(signed)}\n`, { mode: 0o600 });
NODE
node /work/sign-authorization.mjs /tmp/resolve-request.json /root/lifecycle-authorizations/resolve.json
node /work/sign-authorization.mjs /tmp/reseal-resolve-request.json /root/lifecycle-authorizations/reseal-resolve.json
cp /root/lifecycle-authorizations/resolve.json /root/lifecycle-authorizations/resolve-copied-path.json
node /work/sign-authorization.mjs /tmp/copied-project-request.json /root/lifecycle-authorizations/copied-project.json
node /work/sign-authorization.mjs /tmp/wrong-step-request.json /root/lifecycle-authorizations/wrong-step.json
node /work/sign-authorization.mjs /tmp/wrong-flow-request.json /root/lifecycle-authorizations/wrong-flow.json

cat > /work/make-lifecycle-authorization.mjs <<'NODE'
import fs from 'node:fs'; import crypto from 'node:crypto';
const [operation, slug, output, expiresAt] = process.argv.slice(2); const fixture = JSON.parse(fs.readFileSync('/tmp/lifecycle-authority-e2e/fixture.json', 'utf8'));
const now = new Date().toISOString(); const unsigned = { schema_version: '1.0', operation, project_root: fixture.project, run_id: slug, subject: fixture.subject, assignment_actor_key: fixture.actorKey, assignment_actor: fixture.actor, nonce: `${operation}-${slug}-${crypto.randomBytes(8).toString('hex')}`, expires_at: expiresAt, request: { reason: `fixture ${operation}`, authority: { kind: 'operator_request', actor: 'fixture-operator', request_ref: `fixture://${operation}/${slug}`, requested_at: now } } };
const key = crypto.createPrivateKey(fs.readFileSync('/root/lifecycle-authorizations/authority-private.pem'));
fs.writeFileSync(output, `${JSON.stringify({ ...unsigned, signature: { algorithm: 'ed25519', key_id: 'fixture-authority', value: crypto.sign(null, Buffer.from(JSON.stringify(unsigned)), key).toString('base64') } })}\n`, { mode: 0o600 });
NODE
FUTURE="$(node -e 'console.log(new Date(Date.now()+3600000).toISOString())')"
PAST="$(node -e 'console.log(new Date(Date.now()-3600000).toISOString())')"
node /work/make-lifecycle-authorization.mjs cancel archive-e2e /root/lifecycle-authorizations/cancel.json "$FUTURE"
node /work/make-lifecycle-authorization.mjs archive archive-e2e /root/lifecycle-authorizations/archive.json "$FUTURE"
node /work/make-lifecycle-authorization.mjs cancel stale-e2e /root/lifecycle-authorizations/stale.json "$PAST"
node /work/make-lifecycle-authorization.mjs cancel unauthorized-e2e /root/lifecycle-authorizations/unauthorized.json "$FUTURE"
node /work/make-lifecycle-authorization.mjs cancel stale-e2e /root/lifecycle-authorizations/stale-holder.json "$FUTURE"
node /work/make-lifecycle-authorization.mjs cancel concurrent-e2e /root/lifecycle-authorizations/concurrent-a.json "$FUTURE"
node /work/make-lifecycle-authorization.mjs cancel concurrent-e2e /root/lifecycle-authorizations/concurrent-b.json "$FUTURE"
node /work/make-lifecycle-authorization.mjs cancel symlink-e2e /root/lifecycle-authorizations/symlink.json "$FUTURE"
node /work/make-lifecycle-authorization.mjs cancel legacy-e2e /root/lifecycle-authorizations/legacy.json "$FUTURE"
node /work/make-lifecycle-authorization.mjs cancel legacy-mismatch-e2e /root/lifecycle-authorizations/legacy-mismatch.json "$FUTURE"
node /work/make-lifecycle-authorization.mjs cancel legacy-same-nonce-e2e /root/lifecycle-authorizations/legacy-same-nonce-valid.json "$FUTURE"
node /work/make-lifecycle-authorization.mjs cancel legacy-recovery-e2e /root/lifecycle-authorizations/legacy-recovery.json "$FUTURE"
node - /root/lifecycle-authorizations/legacy-mismatch.json <<'NODE'
const fs = require('node:fs'), crypto = require('node:crypto'); const file = process.argv[2], value = JSON.parse(fs.readFileSync(file, 'utf8')); const { signature, ...base } = value;
const key = crypto.createPrivateKey(fs.readFileSync('/root/lifecycle-authorizations/authority-private.pem'));
for (const [name, field, replacement] of [['runtime', 'runtime', 'different-runtime'], ['session', 'session_id', 'different-session'], ['host', 'host', 'different-host'], ['human', 'human', 'fixture-human']]) {
  const unsigned = structuredClone(base); unsigned.assignment_actor[field] = replacement; unsigned.nonce = `${unsigned.nonce}-${name}`;
  fs.writeFileSync(`/root/lifecycle-authorizations/legacy-mismatch-${name}.json`, JSON.stringify({ ...unsigned, signature: { ...signature, value: crypto.sign(null, Buffer.from(JSON.stringify(unsigned)), key).toString('base64') } }));
}
NODE
node - /root/lifecycle-authorizations/legacy-same-nonce-valid.json /root/lifecycle-authorizations/legacy-same-nonce-mismatch.json <<'NODE'
const fs = require('node:fs'), crypto = require('node:crypto'); const [input, output] = process.argv.slice(2), value = JSON.parse(fs.readFileSync(input, 'utf8')); const { signature, ...unsigned } = value;
unsigned.assignment_actor.host = 'different-host'; const key = crypto.createPrivateKey(fs.readFileSync('/root/lifecycle-authorizations/authority-private.pem'));
fs.writeFileSync(output, JSON.stringify({ ...unsigned, signature: { ...signature, value: crypto.sign(null, Buffer.from(JSON.stringify(unsigned)), key).toString('base64') } }));
NODE
node - /root/lifecycle-authorizations/unauthorized.json <<'NODE'
const fs = require('node:fs'), crypto = require('node:crypto'); const file = process.argv[2], value = JSON.parse(fs.readFileSync(file, 'utf8')); const { signature, ...unsigned } = value;
value.signature.value = crypto.sign(null, Buffer.from(JSON.stringify(unsigned)), crypto.generateKeyPairSync('ed25519').privateKey).toString('base64'); fs.writeFileSync(file, JSON.stringify(value));
NODE
chown -R node:node "$PROJECT"

cat > /work/history-repair-invoke.mjs <<'NODE'
import { invokeExternalLifecycleAuthority } from './build/src/external-lifecycle-authority.js';
const [action, project_root, session_dir, authorization_file, prior_record_id, resolving_record_id] = process.argv.slice(2);
console.log(JSON.stringify(invokeExternalLifecycleAuthority({ action, project_root, session_dir, authorization_file, prior_record_id, resolving_record_id })));
NODE

# Resolve the reseal fixture first, then stage and sign the exact final
# tests-evidence replacement while the canonical run is still at verify.
su -s /bin/bash node -c "cd /work && node /work/history-repair-invoke.mjs resolve-critique '$PROJECT' '$RESEAL_SESSION' /root/lifecycle-authorizations/reseal-resolve.json '${RESEAL_CRITIQUE_IDS[0]}' '${RESEAL_CRITIQUE_IDS[1]}'" >/tmp/reseal-resolve-result.json
node -e "const r=require('/tmp/reseal-resolve-result.json'); if(r.operation_status!=='applied') throw new Error('reseal fixture critique resolution was not applied')"
node --input-type=module - "$PROJECT" "$RESEAL_SESSION" /root/lifecycle-authorizations/reseal-resolve.json "${RESEAL_CRITIQUE_IDS[0]}" "${RESEAL_CRITIQUE_IDS[1]}" <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import { canonicalJson, sha256 } from './packaging/lifecycle-authority/coordinator.mjs';
const [project, session, authorizationFile, priorRecordId, resolvingRecordId] = process.argv.slice(2);
const fixtureProject = '/tmp/lifecycle-authority-e2e';
const fixtureSession = path.join(fixtureProject, '.kontourai', 'flow-agents', 'reseal-e2e');
const journalBasename = '.lifecycle-authority.transaction.json';
const assertAnchoredSession = (trustedProject, expectedSession) => {
  if (path.resolve(trustedProject) !== trustedProject || fs.realpathSync(trustedProject) !== trustedProject) {
    throw new Error('reseal fixture project root is not its fixed real path');
  }
  const relative = path.relative(trustedProject, expectedSession);
  if (relative !== path.join('.kontourai', 'flow-agents', 'reseal-e2e')) {
    throw new Error('reseal fixture session is not the exact expected fixture path');
  }
  let current = trustedProject;
  for (const segment of ['', ...relative.split(path.sep)]) {
    if (segment) current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current) {
      throw new Error(`reseal fixture session ancestor is not a real directory: ${current}`);
    }
  }
  return current;
};
const removeOwnedLegacyJournal = (trustedProject, expectedSession, expectedBinding) => {
  const anchoredSession = assertAnchoredSession(trustedProject, expectedSession);
  const journalFile = path.join(anchoredSession, journalBasename);
  if (path.basename(journalFile) !== journalBasename || path.dirname(journalFile) !== anchoredSession) {
    throw new Error('reseal fixture legacy journal cleanup target is not the fixed session leaf');
  }
  const stat = fs.lstatSync(journalFile);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('reseal fixture legacy journal cleanup target is not a regular file');
  }
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  if (journal.status !== 'committed' || canonicalJson(journal.binding) !== canonicalJson(expectedBinding)) {
    throw new Error('reseal fixture refused to remove a legacy journal it did not create');
  }
  assertAnchoredSession(trustedProject, expectedSession);
  const current = fs.lstatSync(journalFile);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
    throw new Error('reseal fixture legacy journal changed before cleanup');
  }
  fs.unlinkSync(journalFile);
};
if (project !== fixtureProject || session !== fixtureSession) {
  throw new Error('reseal fixture cleanup arguments do not match the fixed fixture');
}
const authorization = JSON.parse(fs.readFileSync(authorizationFile, 'utf8'));
const request = {
  action: 'resolve-critique',
  project_root: project,
  session_dir: session,
  authorization_file: authorizationFile,
  prior_record_id: priorRecordId,
  resolving_record_id: resolvingRecordId,
};
const expectedBinding = {
  request_sha256: sha256(request),
  authorization_sha256: sha256(canonicalJson(authorization)),
};
const regressionRoot = '/tmp/reseal-journal-cleanup-symlink-regression';
const regressionProject = path.join(regressionRoot, 'project');
const foreignSession = path.join(regressionRoot, 'foreign', 'reseal-e2e');
const regressionSession = path.join(regressionProject, '.kontourai', 'flow-agents', 'reseal-e2e');
fs.rmSync(regressionRoot, { recursive: true, force: true });
try {
  fs.mkdirSync(path.join(regressionProject, '.kontourai'), { recursive: true });
  fs.mkdirSync(foreignSession, { recursive: true });
  fs.writeFileSync(path.join(foreignSession, journalBasename), `${JSON.stringify({ status: 'committed', binding: expectedBinding })}\n`);
  fs.symlinkSync(path.dirname(foreignSession), path.join(regressionProject, '.kontourai', 'flow-agents'), 'dir');
  let rejected = false;
  try {
    removeOwnedLegacyJournal(regressionProject, regressionSession, expectedBinding);
  } catch (error) {
    if (!/ancestor is not a real directory/.test(String(error))) throw error;
    rejected = true;
  }
  if (!rejected || !fs.existsSync(path.join(foreignSession, journalBasename))) {
    throw new Error('symlinked session ancestor cleanup removed a foreign journal');
  }
} finally {
  fs.rmSync(regressionRoot, { recursive: true, force: true });
}
removeOwnedLegacyJournal(fixtureProject, fixtureSession, expectedBinding);
NODE
FLOW_AGENTS_ACTOR=reseal-container node --input-type=module - "$PROJECT" <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import { resolveCurrentAssignmentActor } from './build/src/cli/assignment-provider.js';
const project = process.argv[2], file = path.join(project, '.kontourai', 'flow-agents', 'assignment', 'reseal-e2e.json');
const caller = resolveCurrentAssignmentActor(), assignment = JSON.parse(fs.readFileSync(file, 'utf8'));
assignment.actor_key = caller.actorKey; assignment.actor = caller.actor; fs.writeFileSync(file, `${JSON.stringify(assignment, null, 2)}\n`);
NODE
export PINNED_FLOW_ROOT="$(dirname "$LIFECYCLE_HELPER_PATH")/flow-reducer/node_modules/@kontourai/flow"
cat > /work/stage-reseal-request.mjs <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { pathToFileURL } from 'node:url';
import { stageWorkflowEvidenceCandidate } from './build/src/cli/workflow.js';
import { resolveCurrentAssignmentActor } from './build/src/cli/assignment-provider.js';
import { buildUnsignedVerificationEvidenceResealAuthorization } from './build/src/builder-lifecycle-authority.js';
import { critiqueHistoryProjectionSummary } from './build/src/cli/critique-resolution.js';
const [project, session, pinnedFlowRoot] = process.argv.slice(2), runId = path.basename(session), expectation = 'policy-compliance';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const flow = await import(pathToFileURL(path.join(pinnedFlowRoot, 'dist', 'index.js')).href);
const flowRoot = path.join(project, '.kontourai', 'flow', 'runs', runId);
const state = JSON.parse(fs.readFileSync(path.join(flowRoot, 'state.json'), 'utf8'));
const definition = JSON.parse(fs.readFileSync(path.join(flowRoot, 'definition.json'), 'utf8'));
const caller = resolveCurrentAssignmentActor(), currentBytes = fs.readFileSync(path.join(session, 'trust.bundle'));
const current = JSON.parse(currentBytes), targetIndex = current.claims.findIndex((claim) => claim.metadata?.gate_claim?.expectation_id === expectation);
if (targetIndex < 0 || current.claims.filter((claim) => claim.metadata?.gate_claim?.expectation_id === expectation).length !== 1) throw new Error('reseal fixture requires one current policy claim');
const staged = await stageWorkflowEvidenceCandidate(session, [
  'record-gate-claim', session,
  '--expectation', expectation,
  '--status', 'pass',
  '--summary', 'Final installed-closure policy verification passed.',
  '--evidence-ref-json', JSON.stringify({ kind: 'artifact', file: 'review-target/delivery.md', summary: 'Reviewed delivery covered by the installed-closure policy verification.' }),
  '--actor', caller.actorKey,
]);
let candidate = JSON.parse(staged.bytes);
if (candidate.claims.length !== current.claims.length
    || candidate.claims.filter((claim) => claim.metadata?.gate_claim?.expectation_id === expectation).length !== 1
    || candidate.claims.findIndex((claim) => claim.metadata?.gate_claim?.expectation_id === expectation) !== targetIndex) {
  throw new Error('staged candidate did not retain one ordered in-place target replacement');
}
current.claims.forEach((claim, index) => {
  if (index === targetIndex || JSON.stringify(claim) === JSON.stringify(candidate.claims[index])) return;
  const replacementClaim = candidate.claims[index];
  const keys = [...new Set([...Object.keys(claim), ...Object.keys(replacementClaim || {})])]
    .filter((key) => JSON.stringify(claim[key]) !== JSON.stringify(replacementClaim?.[key]));
  const metadataKeys = keys.includes('metadata')
    ? [...new Set([...Object.keys(claim.metadata || {}), ...Object.keys(replacementClaim?.metadata || {})])]
      .filter((key) => JSON.stringify(claim.metadata?.[key]) !== JSON.stringify(replacementClaim?.metadata?.[key]))
    : [];
  throw new Error(`public reseal candidate changed non-target claim ${index} fields ${keys.join(',')} metadata ${metadataKeys.join(',')}`);
});
const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
const candidateFile = path.join(session, `.workflow-evidence-transaction-${staged.transaction_id}`, 'trust.bundle.candidate');
fs.writeFileSync(candidateFile, candidateBytes, { mode: 0o600 });
const ledgerFile = path.join(session, 'lifecycle-authority.resolution-events.json'), ledgerBytes = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile) : Buffer.alloc(0);
const events = ledgerBytes.length ? JSON.parse(ledgerBytes).events : [];
const completionBytes = fs.readFileSync(path.join(session, 'lifecycle-authority.completion.json')), completion = JSON.parse(completionBytes);
const manifestBytes = fs.readFileSync(path.join(flowRoot, 'evidence', 'manifest.json'));
const workState = JSON.parse(fs.readFileSync(path.join(session, 'state.json'), 'utf8')), subject = workState.work_item_refs[0];
const predecessor = current.claims[targetIndex], replacement = candidate.claims[targetIndex], now = new Date();
const { unsigned, signingPayload } = buildUnsignedVerificationEvidenceResealAuthorization({
  project_root: project, run_id: runId, subject,
  preimage_bundle_sha256: sha(currentBytes), candidate_bundle_sha256: sha(candidateBytes), candidate_transaction_id: staged.transaction_id,
  preimage_ledger_sha256: sha(ledgerBytes), preimage_ledger_length: events.length, preimage_ledger_tail_hash: events.at(-1)?.event_hash ?? '0'.repeat(64),
  current_completion_sha256: sha(completionBytes), current_completion_request_sha256: completion.request_sha256, current_completion_result_core_sha256: completion.result_core_sha256,
  flow_definition_id: 'builder.build', flow_step_id: 'verify', flow_gate_id: 'verify-gate', flow_run_head: flow.flowRunHead(state), flow_manifest_sha256: sha(manifestBytes),
  critique_projection_sha256: critiqueHistoryProjectionSummary(current.claims).digest, target_expectation_id: expectation,
  predecessor_claim_id: predecessor.id, predecessor_claim_status: predecessor.status, predecessor_claim_sha256: sha(Buffer.from(JSON.stringify(predecessor))), predecessor_claim_index: targetIndex,
  current_claim_id: replacement.id, current_claim_status: replacement.status, current_claim_sha256: sha(Buffer.from(JSON.stringify(replacement))), current_claim_index: targetIndex,
  claim_delta: 'replace', nonce: `container-reseal-${crypto.randomBytes(12).toString('hex')}`,
  requested_at: now.toISOString(), expires_at: new Date(now.getTime() + 3_600_000).toISOString(),
});
if (definition.id !== 'builder.build' || state.current_step !== 'verify') throw new Error('reseal fixture left the protected verify gate');
process.stdout.write(`${JSON.stringify({ authorization: unsigned, signing_payload: signingPayload })}\n`);
NODE
su -s /bin/bash node -c "cd /work && FLOW_AGENTS_ACTOR=reseal-container node /work/stage-reseal-request.mjs '$PROJECT' '$RESEAL_SESSION' '$PINNED_FLOW_ROOT' > /tmp/reseal-request.json"
node /work/sign-authorization.mjs /tmp/reseal-request.json /root/lifecycle-authorizations/reseal.json

cat > /work/pinned-flow-lock-holder.mjs <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
const [flowRoot, project, runId, readyFile, releaseFile] = process.argv.slice(2);
const store = await import(pathToFileURL(path.join(flowRoot, 'dist', 'runtime', 'flow-run-store.js')).href);
await store.withRunMutationLock(runId, project, async () => {
  fs.writeFileSync(readyFile, 'ready\n');
  while (!fs.existsSync(releaseFile)) await new Promise((resolve) => setTimeout(resolve, 10));
});
NODE
cat > /work/pinned-flow-pause.mjs <<'NODE'
import path from 'node:path'; import { pathToFileURL } from 'node:url';
const [flowRoot, project, runId] = process.argv.slice(2);
const flow = await import(pathToFileURL(path.join(flowRoot, 'dist', 'index.js')).href);
await flow.pauseRun(runId, {
  cwd: project,
  reason: 'installed Flow 3.5.0 mutation after reseal',
  authority: {
    kind: 'operator_request',
    actor: 'installed-flow-3.5-container',
    request_ref: 'container:reseal-native-lock',
    requested_at: '2026-07-20T00:20:00Z'
  },
  at: '2026-07-20T00:20:01Z'
});
NODE
cat > /work/reseal-invoke.mjs <<'NODE'
import { invokeExternalLifecycleAuthority } from './build/src/external-lifecycle-authority.js';
const [project, session, authorizationFile] = process.argv.slice(2);
console.log(JSON.stringify(invokeExternalLifecycleAuthority({
  action: 'reseal-verification-evidence',
  project_root: project,
  session_dir: session,
  authorization_file: authorizationFile
})));
NODE
cat > /work/verify-reseal-completion.mjs <<'NODE'
import fs from 'node:fs';
import { verifyLifecycleAuthorityCompletion } from './build/src/external-lifecycle-authority.js';
const completionFile = process.argv[2];
console.log(JSON.stringify(verifyLifecycleAuthorityCompletion(JSON.parse(fs.readFileSync(completionFile, 'utf8')))));
NODE
cat > /work/sync-builder-session.mjs <<'NODE'
import { syncBuilderFlowSession } from './build/src/builder-flow-runtime.js';
const synced = await syncBuilderFlowSession({ sessionDir: process.argv[2] });
console.log(JSON.stringify({ hasLifecycleAttachment: synced.run.manifest.evidence.some((entry) => entry.id.startsWith('lifecycle-authority:')) }));
NODE
cat > /work/reseal-native-lock-e2e.mjs <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { spawn } from 'node:child_process'; import { pathToFileURL } from 'node:url';
const project = '/tmp/lifecycle-authority-e2e', runId = 'reseal-e2e';
const session = path.join(project, '.kontourai', 'flow-agents', runId);
const runRoot = path.join(project, '.kontourai', 'flow', 'runs', runId);
const pinnedFlowRoot = process.env.PINNED_FLOW_ROOT;
if (!pinnedFlowRoot || !fs.realpathSync(pinnedFlowRoot).startsWith(path.dirname(process.env.LIFECYCLE_HELPER_PATH))) throw new Error('pinned Flow root is not the helper-installed closure');
const packageJson = JSON.parse(fs.readFileSync(path.join(pinnedFlowRoot, 'package.json'), 'utf8'));
if (packageJson.name !== '@kontourai/flow' || packageJson.version !== '3.5.0') throw new Error('reseal interoperability must use installed exact @kontourai/flow@3.5.0');
if (fs.realpathSync(pinnedFlowRoot).startsWith('/work/node_modules')) throw new Error('local Flow dependency substituted for the installed closure');
const lockRoot = path.join(runRoot, '.mutation.lock'), readyFile = '/tmp/reseal-lock-ready', releaseFile = '/tmp/reseal-lock-release';
for (const file of [readyFile, releaseFile]) if (fs.existsSync(file)) fs.unlinkSync(file);
const spawnAsNode = (script, args) => {
  const command = ['node', script, ...args].map((value) => `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`).join(' ');
  const child = spawn('su', ['-s', '/bin/bash', 'node', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
  const result = new Promise((resolve) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
  return { child, result };
};
const installedStore = await import(pathToFileURL(path.join(pinnedFlowRoot, 'dist', 'runtime', 'flow-run-store.js')).href);
if (['withRunRecoveryLock', 'writeRunRecoveryFence', 'finalizeRunRecoveryFence'].some((name) => typeof installedStore[name] !== 'function')) {
  const treeDigest = (root) => {
    if (!fs.existsSync(root)) return 'absent';
    const entries = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, entry.name), relative = path.relative(root, file);
        if (entry.isDirectory()) walk(file);
        else entries.push(`${relative}\0${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`);
      }
    };
    walk(root);
    return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
  };
  const durableBefore = treeDigest(process.env.LIFECYCLE_STATE_ROOT);
  const sessionBefore = treeDigest(session);
  const runBefore = treeDigest(runRoot);
  const result = await spawnAsNode('/work/reseal-invoke.mjs', [project, session, '/root/lifecycle-authorizations/reseal.json']).result;
  if (result.status === 0 || !`${result.stdout}${result.stderr}`.includes('verification reseal capability')) {
    throw new Error(`missing installed Flow recovery API did not fail at capability preflight: ${result.stdout}${result.stderr}`);
  }
  if (treeDigest(process.env.LIFECYCLE_STATE_ROOT) !== durableBefore) throw new Error('missing installed Flow recovery API created durable nonce/completion residue');
  if (treeDigest(session) !== sessionBefore || treeDigest(runRoot) !== runBefore) {
    throw new Error('missing installed Flow recovery API changed session or canonical Flow bytes');
  }
  const residue = [session, runRoot].flatMap((root) => {
    const found = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name === '.verification-reseal.transaction.json' || entry.name.includes('.verification-reseal-')) found.push(file);
      }
    };
    walk(root);
    return found;
  });
  if (residue.length) throw new Error(`missing installed Flow recovery API created transaction residue: ${residue.join(',')}`);
  console.log('PASS: installed @kontourai/flow@3.5.0 lacks the recovery API and fresh reseal fails before nonce, plan, or stage residue');
  process.exit(0);
}
const waitFor = async (label, predicate) => {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};
const ticketCount = () => fs.existsSync(lockRoot)
  ? fs.readdirSync(lockRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('ticket-')).length
  : 0;
const ledgerBefore = fs.readFileSync(path.join(session, 'lifecycle-authority.resolution-events.json'));
const holder = spawnAsNode('/work/pinned-flow-lock-holder.mjs', [pinnedFlowRoot, project, runId, readyFile, releaseFile]);
await Promise.race([
  waitFor('installed 3.5 holder ticket', () => fs.existsSync(readyFile) && ticketCount() === 1),
  holder.result.then((result) => { throw new Error(`installed 3.5 holder exited before readiness: ${result.stdout}${result.stderr}`); }),
]);
const reseal = spawnAsNode('/work/reseal-invoke.mjs', [project, session, '/root/lifecycle-authorizations/reseal.json']);
await Promise.race([
  waitFor('root reseal ticket behind installed 3.5 holder', () => ticketCount() === 2),
  reseal.result.then((result) => { throw new Error(`root reseal exited before queuing behind installed 3.5: ${result.stdout}${result.stderr}`); }),
]);
const pause = spawnAsNode('/work/pinned-flow-pause.mjs', [pinnedFlowRoot, project, runId]);
await Promise.race([
  waitFor('installed 3.5 public pause behind reseal', () => ticketCount() === 3),
  pause.result.then((result) => { throw new Error(`installed 3.5 pause exited before queuing: ${result.stdout}${result.stderr}`); }),
]);
fs.writeFileSync(releaseFile, 'release\n');
const [holderResult, resealResult, pauseResult] = await Promise.all([holder.result, reseal.result, pause.result]);
if (holderResult.status !== 0) throw new Error(`installed 3.5 holder failed: ${holderResult.stderr}`);
if (resealResult.status !== 0) throw new Error(`root reseal failed behind installed 3.5 lock: ${resealResult.stdout}${resealResult.stderr}`);
if (pauseResult.status !== 0) throw new Error(`installed 3.5 pause failed behind reseal: ${pauseResult.stderr}`);
const resealReceipt = JSON.parse(resealResult.stdout);
if (resealReceipt.operation_status !== 'applied') throw new Error('installed-closure reseal was not applied');
const bundle = JSON.parse(fs.readFileSync(path.join(session, 'trust.bundle'), 'utf8'));
const target = bundle.claims.filter((claim) => claim.metadata?.gate_claim?.expectation_id === 'policy-compliance');
if (target.length !== 1 || target[0].status !== 'verified' || target[0].metadata.gate_claim.step_id !== 'verify') throw new Error('reseal did not publish the exact current verify claim');
if (!fs.readFileSync(path.join(session, 'lifecycle-authority.resolution-events.json')).equals(ledgerBefore)) throw new Error('reseal changed the resolution ledger');
const completionResult = await spawnAsNode('/work/verify-reseal-completion.mjs', [path.join(session, 'lifecycle-authority.completion.json')]).result;
if (completionResult.status !== 0) throw new Error(`unprivileged completion verification failed: ${completionResult.stdout}${completionResult.stderr}`);
const completion = JSON.parse(completionResult.stdout);
if (completion.action !== 'reseal-verification-evidence') throw new Error('reseal did not install its exact completion');
const state = JSON.parse(fs.readFileSync(path.join(runRoot, 'state.json'), 'utf8'));
if (state.status !== 'paused' || state.lifecycle.at(-1)?.authority?.request_ref !== 'container:reseal-native-lock') throw new Error('waiting installed 3.5 public mutation was not preserved');
const manifest = JSON.parse(fs.readFileSync(path.join(runRoot, 'evidence', 'manifest.json'), 'utf8'));
if (manifest.evidence.filter((entry) => entry.id === `lifecycle-authority:${completion.request_sha256}`).length !== 1) throw new Error('reseal attachment is absent or duplicated');
if (ticketCount() !== 0) throw new Error('native Flow tickets were not released');
console.log('PASS: installed exact @kontourai/flow@3.5.0 holder, root reseal, and installed public pause share one FIFO mutation lock; reseal and foreign mutation are preserved');
NODE
node /work/reseal-native-lock-e2e.mjs

cat > /work/history-repair-e2e.mjs <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { spawnSync } from 'node:child_process';
import { canonicalJson, sha256 } from './packaging/lifecycle-authority/coordinator.mjs';
import { coordinatorRuntimeSha256, validateResolutionEventLedger } from './packaging/lifecycle-authority/runtime-v1.mjs';
const project = '/tmp/lifecycle-authority-e2e', slug = 'repair-e2e', session = path.join(project, '.kontourai', 'flow-agents', slug);
const critiques = JSON.parse(fs.readFileSync(path.join(session, 'trust.bundle'), 'utf8')).claims
  .filter((claim) => claim.metadata?.origin === 'critique')
  .map((claim) => claim.metadata)
  .sort((left, right) => left.critique_sequence - right.critique_sequence);
if (critiques.length !== 11 || new Set(critiques.map((record) => record.critique_record_id)).size !== 11 || critiques.some((record, index) => !Number.isInteger(record.critique_sequence) || record.critique_sequence !== index + 1 || typeof record.critique_record_id !== 'string' || !record.critique_record_id)) throw new Error('history fixture must derive eleven immutable, ordered critique record IDs from the Trust Bundle');
const pairs = Array.from({ length: 5 }, (_, index) => [critiques[index * 2].critique_record_id, critiques[index * 2 + 1].critique_record_id]);
const key = crypto.createPrivateKey(fs.readFileSync('/root/lifecycle-authorizations/authority-private.pem'));
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;
const signRequest = (verb, pair, name) => {
  const command = ['node', './build/src/cli.js', 'workflow', verb, '--session-dir', session, '--prior-record-id', pair[0], '--resolving-record-id', pair[1]].map(shellQuote).join(' ');
  const result = spawnSync('su', ['-s', '/bin/bash', 'node', '-c', `cd /work && ${command}`], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${verb} request failed: ${result.stdout}${result.stderr}`);
  const request = JSON.parse(result.stdout), unsigned = request.authorization;
  const signed = { ...unsigned, signature: { algorithm: 'ed25519', key_id: 'fixture-authority', value: crypto.sign(null, Buffer.from(request.signing_payload), key).toString('base64') } };
  const file = `/root/lifecycle-authorizations/${name}.json`; fs.writeFileSync(file, `${JSON.stringify(signed)}\n`, { mode: 0o600 }); return file;
};
const invoke = (action, pair, authorization_file) => {
  const command = ['node', '/work/history-repair-invoke.mjs', action, project, session, authorization_file, pair[0], pair[1]].map(shellQuote).join(' ');
  const result = spawnSync('su', ['-s', '/bin/bash', 'node', '-c', command], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`unprivileged ${action} invocation failed: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
};
const verifyCompletion = (file) => {
  const command = ['node', '/work/verify-reseal-completion.mjs', file].map(shellQuote).join(' ');
  const result = spawnSync('su', ['-s', '/bin/bash', 'node', '-c', command], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`unprivileged completion verification failed: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
};
const expectReject = (fn, pattern) => { try { fn(); } catch (error) { if (pattern.test(String(error))) return; throw error; } throw new Error(`expected rejection: ${pattern}`); };

// Three old ordinary transitions, followed by the historical overwrite which
// retained only the third edge as a fresh external-ledger genesis entry.
for (const [index, pair] of pairs.slice(0, 3).entries()) {
  const authorization = signRequest('resolve-critique-request', pair, `legacy-original-${index + 1}`);
  const result = invoke('resolve-critique', pair, authorization); if (result.operation_status !== 'applied') throw new Error(`legacy ordinary resolution ${index + 1} was not applied`);
}
const ledgerFile = path.join(session, 'lifecycle-authority.resolution-events.json');
const legacyLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); if (legacyLedger.events.length !== 3) throw new Error('legacy fixture did not create three original resolution events');
const survivor = structuredClone(legacyLedger.events[2]); survivor.sequence = 1; survivor.predecessor_hash = '0'.repeat(64); delete survivor.event_hash; survivor.event_hash = crypto.createHash('sha256').update(JSON.stringify(survivor)).digest('hex');
const overwrittenLedger = { schema_version: '1.0', events: [survivor] }; fs.writeFileSync(ledgerFile, `${JSON.stringify(overwrittenLedger, null, 2)}\n`, { mode: 0o644 });
const bundle = JSON.parse(fs.readFileSync(path.join(session, 'trust.bundle'), 'utf8'));
const priorCompletion = verifyCompletion(path.join(session, 'lifecycle-authority.completion.json'));
const unsignedCompletion = { schema_version: '1.0', kind: 'kontourai.lifecycle-authority.completion', action: 'resolve-critique', request_sha256: priorCompletion.request_sha256, run_id: slug, operation_status: 'applied', result_core_sha256: sha256({ ...bundle, critique_resolution_events: overwrittenLedger.events }), coordinator_runtime_sha256: coordinatorRuntimeSha256(), completed_at: new Date().toISOString() };
const completion = { ...unsignedCompletion, signature: { algorithm: 'ed25519', value: crypto.sign(null, Buffer.from(canonicalJson(unsignedCompletion)), crypto.createPrivateKey(fs.readFileSync('/etc/kontourai/flow-agents-lifecycle-authority-v1/completion-signing-key.pem'))).toString('base64') } };
fs.writeFileSync(path.join(session, 'lifecycle-authority.completion.json'), `${JSON.stringify(completion, null, 2)}\n`, { mode: 0o644 });
const historicalAuthorization = survivor.signed_authorization, historicalAuthorizationSha256 = sha256(canonicalJson(historicalAuthorization));
const operationId = sha256({ project, run_id: slug, action: completion.action, key_id: historicalAuthorization.signature.key_id, nonce: historicalAuthorization.nonce });
const durableRoot = process.env.LIFECYCLE_STATE_ROOT; if (!durableRoot) throw new Error('history fixture requires the configured lifecycle durable state root');
const durableCompletion = { authorization_sha256: historicalAuthorizationSha256, request_sha256: completion.request_sha256, result_core_sha256: completion.result_core_sha256, completion };
const durableNonce = { schema_version: '1.0', operation_id: operationId, authorization_sha256: historicalAuthorizationSha256, key_id: historicalAuthorization.signature.key_id, nonce: historicalAuthorization.nonce, request_sha256: completion.request_sha256, status: 'applied', result_core_sha256: completion.result_core_sha256 };
fs.writeFileSync(path.join(durableRoot, 'completions', `${operationId}.json`), `${JSON.stringify(durableCompletion)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(durableRoot, 'nonces', `${sha256(`${historicalAuthorization.signature.key_id}\u0000${historicalAuthorization.nonce}`)}.json`), `${JSON.stringify(durableNonce)}\n`, { mode: 0o600 });
const flowRoot = path.join(project, '.kontourai', 'flow', 'runs', slug), attachmentId = `lifecycle-authority:${completion.request_sha256}`;
const manifestFile = path.join(flowRoot, 'evidence', 'manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const entries = manifest.evidence.filter((entry) => entry.id === attachmentId); if (entries.length !== 1) throw new Error('legacy overwrite fixture lacks one request-keyed Flow attachment');
const storedFile = path.join(flowRoot, entries[0].stored_path), storedBytes = fs.readFileSync(path.join(session, 'trust.bundle'));
fs.writeFileSync(storedFile, storedBytes); entries[0].sha256 = crypto.createHash('sha256').update(storedBytes).digest('hex'); delete entries[0].superseded_by;
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
const nodeUid = Number(spawnSync('id', ['-u', 'node'], { encoding: 'utf8' }).stdout.trim()), nodeGid = Number(spawnSync('id', ['-g', 'node'], { encoding: 'utf8' }).stdout.trim());
if (!Number.isInteger(nodeUid) || !Number.isInteger(nodeGid)) throw new Error('container fixture cannot determine the unprivileged node identity');
for (const file of [ledgerFile, path.join(session, 'lifecycle-authority.completion.json')]) fs.chownSync(file, nodeUid, nodeGid);
const bundleBeforeRepairs = fs.readFileSync(path.join(session, 'trust.bundle'));

// A survivor is ordinary authority, not repairable; both historical gaps are
// repaired once, and the first repair demonstrates replay without a rewrite.
expectReject(() => signRequest('repair-critique-resolution-history-request', pairs[2], 'repair-survivor'), /original signed event is already present/);
const firstRepair = signRequest('repair-critique-resolution-history-request', pairs[0], 'repair-history-1');
if (invoke('repair-critique-resolution-history', pairs[0], firstRepair).operation_status !== 'applied') throw new Error('first history repair was not applied');
if (!fs.readFileSync(path.join(session, 'trust.bundle')).equals(bundleBeforeRepairs)) throw new Error('first history repair changed Trust Bundle bytes');
if (invoke('repair-critique-resolution-history', pairs[0], firstRepair).operation_status !== 'replayed') throw new Error('history repair did not replay');
const secondRepair = signRequest('repair-critique-resolution-history-request', pairs[1], 'repair-history-2');
if (invoke('repair-critique-resolution-history', pairs[1], secondRepair).operation_status !== 'applied') throw new Error('second history repair was not applied');
if (!fs.readFileSync(path.join(session, 'trust.bundle')).equals(bundleBeforeRepairs)) throw new Error('history repairs changed Trust Bundle bytes');
expectReject(() => signRequest('repair-critique-resolution-history-request', pairs[0], 'repair-duplicate'), /repair already exists/);

// Normal transitions continue only after the repaired append chain is current.
for (const [index, pair] of pairs.slice(3).entries()) {
  const authorization = signRequest('resolve-critique-request', pair, `legacy-continuation-${index + 4}`);
  if (invoke('resolve-critique', pair, authorization).operation_status !== 'applied') throw new Error(`post-repair ordinary resolution ${index + 4} was not applied`);
}
const finalBundle = JSON.parse(fs.readFileSync(path.join(session, 'trust.bundle'), 'utf8'));
const finalLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); validateResolutionEventLedger(finalLedger.events, { run_id: slug, subject: 'local:work-item/lifecycle-authority-e2e', project_root: project, bundle: finalBundle, strict_coverage: true });
if (finalLedger.events.length !== 5 || finalLedger.events.map((event) => event.sequence).join(',') !== '1,2,3,4,5') throw new Error('final history ledger is not a five-entry append chain');
if (finalLedger.events.map((event) => event.operation).join(',') !== 'resolve-critique,repair-critique-resolution-history,repair-critique-resolution-history,resolve-critique,resolve-critique') throw new Error('final history ledger does not preserve surviving, repair, repair, ordinary, ordinary order');
const completionAfter = verifyCompletion(path.join(session, 'lifecycle-authority.completion.json'));
if (completionAfter.result_core_sha256 !== sha256({ ...finalBundle, critique_resolution_events: finalLedger.events })) throw new Error('final completion does not bind repaired ledger and Trust Bundle');
const validationCommand = ['node', './build/src/cli/validate-workflow-artifacts.js', '--require-critique', session].map(shellQuote).join(' ');
const validation = spawnSync('su', ['-s', '/bin/bash', 'node', '-c', `cd /work && ${validationCommand}`], { encoding: 'utf8' }); if (validation.status !== 0) throw new Error(`final repaired critique graph did not validate: ${validation.stdout}${validation.stderr}`);
const syncCommand = ['node', '/work/sync-builder-session.mjs', session].map(shellQuote).join(' ');
const syncResult = spawnSync('su', ['-s', '/bin/bash', 'node', '-c', syncCommand], { encoding: 'utf8' }); if (syncResult.status !== 0 || !JSON.parse(syncResult.stdout).hasLifecycleAttachment) throw new Error(`Builder did not bind final repaired completion: ${syncResult.stdout}${syncResult.stderr}`);
const finalManifest = JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', slug, 'evidence', 'manifest.json'), 'utf8')); if (!finalManifest.evidence.some((entry) => entry.id.startsWith('lifecycle-authority:'))) throw new Error('canonical Flow manifest lacks the final history authority attachment');
console.log('PASS: legacy ledger overwrite, two signed history repairs, repair replay/rejections, two later ordinary resolutions, byte-identical repaired Trust Bundle, strict graph, completion, and Flow attachment');
NODE
su -s /bin/bash node -c "cd /work && node build/src/cli/workflow-sidecar.js record-critique '$REPAIR_SESSION' --id legacy-current-clean --reviewer repair-reviewer-current --verdict pass --summary 'Current history-repair workspace verified.' --artifact-ref '$DELIVERY' --lane-json '{\"id\":\"code-current\",\"status\":\"pass\",\"summary\":\"Current history-repair workspace verified.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"review-target/delivery.md\",\"summary\":\"Current history-repair delivery review.\"}]}' --timestamp '2026-07-20T00:11:00Z' >/dev/null"
node /work/history-repair-e2e.mjs

cat > /work/history-repair-bridge-anchors-e2e.mjs <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { spawn, spawnSync } from 'node:child_process';
import { canonicalJson, sha256 } from './packaging/lifecycle-authority/coordinator.mjs';
const project = '/tmp/lifecycle-authority-e2e', slug = 'bridge-e2e', session = path.join(project, '.kontourai', 'flow-agents', slug), flowRoot = path.join(project, '.kontourai', 'flow', 'runs', slug), ledgerFile = path.join(session, 'lifecycle-authority.resolution-events.json'), completionFile = path.join(session, 'lifecycle-authority.completion.json');
const key = crypto.createPrivateKey(fs.readFileSync('/root/lifecycle-authorizations/authority-private.pem'));
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;
const request = (verb, pair, name) => {
  const command = ['node', './build/src/cli.js', 'workflow', verb, '--session-dir', session, '--prior-record-id', pair[0], '--resolving-record-id', pair[1]].map(shellQuote).join(' ');
  const result = spawnSync('su', ['-s', '/bin/bash', 'node', '-c', `cd /work && ${command}`], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${verb} request failed: ${result.stdout}${result.stderr}`);
  const unsigned = JSON.parse(result.stdout), authorization = { ...unsigned.authorization, signature: { algorithm: 'ed25519', key_id: 'fixture-authority', value: crypto.sign(null, Buffer.from(unsigned.signing_payload), key).toString('base64') } };
  const file = `/root/lifecycle-authorizations/${name}.json`; fs.writeFileSync(file, `${JSON.stringify(authorization)}\n`, { mode: 0o600 }); return { authorization, file };
};
const invoke = (action, pair, authorizationFile) => {
  const command = ['node', '/work/history-repair-invoke.mjs', action, project, session, authorizationFile, pair[0], pair[1]].map(shellQuote).join(' ');
  const result = spawnSync('su', ['-s', '/bin/bash', 'node', '-c', command], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`unprivileged ${action} invocation failed: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
};
const verifyCompletion = (file) => {
  const command = ['node', '/work/verify-reseal-completion.mjs', file].map(shellQuote).join(' ');
  const result = spawnSync('su', ['-s', '/bin/bash', 'node', '-c', command], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`unprivileged completion verification failed: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
};
const reject = (label, fn, pattern = /./) => { try { fn(); } catch (error) { if (pattern.test(String(error))) return; throw new Error(`${label} rejected for the wrong reason: ${error}`); } throw new Error(`${label} unexpectedly succeeded`); };
const critiques = () => JSON.parse(fs.readFileSync(path.join(session, 'trust.bundle'), 'utf8')).claims.filter((claim) => claim.metadata?.origin === 'critique').map((claim) => claim.metadata).sort((a, b) => a.critique_sequence - b.critique_sequence);
const sidecar = (id, reviewer, verdict, lane, finding, timestamp) => {
  const bundleFile = path.join(session, 'trust.bundle');
  const before = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
  const command = ['node', './build/src/cli/workflow-sidecar.js', 'record-critique', session, '--id', id, '--reviewer', reviewer, '--verdict', verdict, '--summary', `Bridge ${id}.`, '--artifact-ref', path.join(project, 'review-target', 'delivery.md'), '--lane-json', JSON.stringify({ id: lane, status: verdict, summary: `Bridge ${id}.`, evidence_refs: [{ kind: 'artifact', file: 'review-target/delivery.md', summary: 'Bridge delivery review.' }] }), '--finding-json', JSON.stringify({ id: finding, severity: 'high', status: verdict === 'pass' ? 'fixed' : 'open', description: `Bridge ${id}.` }), '--timestamp', timestamp].map(shellQuote).join(' ');
  const result = spawnSync('su', ['-s', '/bin/bash', 'node', '-c', `cd /work && ${command}`], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`later critique ${id} failed: ${result.stdout}${result.stderr}`);
  const after = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
  if (!Array.isArray(before.claims) || !Array.isArray(after.claims) || after.claims.length !== before.claims.length + 1) throw new Error(`later critique ${id} did not append exactly one claim`);
  after.claims.splice(0, before.claims.length, ...structuredClone(before.claims));
  for (let index = 0; index < before.claims.length; index += 1) {
    if (JSON.stringify(after.claims[index]) !== JSON.stringify(before.claims[index])) throw new Error(`later critique ${id} changed historical claim ${index}`);
  }
  fs.writeFileSync(bundleFile, `${JSON.stringify(after, null, 2)}\n`);
};
const initial = critiques(); if (initial.length !== 2) throw new Error('bridge fixture requires one initial critique pair');
const pairA = [initial[0].critique_record_id, initial[1].critique_record_id];

// Ordinary A is the sole historical authority root. Capture its request-keyed
// Flow snapshot and the actual root durable completion/nonce before any later
// critique exists.
const ordinaryA = request('resolve-critique-request', pairA, 'bridge-ordinary-a');
if (invoke('resolve-critique', pairA, ordinaryA.file).operation_status !== 'applied') throw new Error('ordinary bridge anchor was not applied');
const historicalCompletionBytes = fs.readFileSync(completionFile), historicalCompletion = verifyCompletion(completionFile);
const historicalLedgerBytes = fs.readFileSync(ledgerFile), historicalLedger = JSON.parse(historicalLedgerBytes);
if (historicalLedger.events.length !== 1 || historicalLedger.events[0].operation !== 'resolve-critique') throw new Error('ordinary bridge anchor did not append exactly one event');
const historicalFlow = '/tmp/bridge-historical-flow'; fs.rmSync(historicalFlow, { recursive: true, force: true }); fs.cpSync(flowRoot, historicalFlow, { recursive: true });
const historicalAttachmentId = `lifecycle-authority:${historicalCompletion.request_sha256}`;
const historicalManifest = JSON.parse(fs.readFileSync(path.join(flowRoot, 'evidence', 'manifest.json'), 'utf8'));
const historicalEntry = historicalManifest.evidence.filter((entry) => entry.id === historicalAttachmentId);
if (historicalEntry.length !== 1 || historicalEntry[0].stored_path !== `evidence/${historicalAttachmentId}.json`) throw new Error('ordinary bridge anchor did not create the request-keyed Flow attachment');
const historicalSnapshot = fs.readFileSync(path.join(flowRoot, historicalEntry[0].stored_path));
const operationId = sha256({ project, run_id: slug, action: 'resolve-critique', key_id: ordinaryA.authorization.signature.key_id, nonce: ordinaryA.authorization.nonce });
const durableRoot = process.env.LIFECYCLE_STATE_ROOT; if (!durableRoot) throw new Error('container fixture requires the configured lifecycle durable state root');
const durableCompletionFile = path.join(durableRoot, 'completions', `${operationId}.json`);
const durableNonceFile = path.join(durableRoot, 'nonces', `${sha256(`${ordinaryA.authorization.signature.key_id}\u0000${ordinaryA.authorization.nonce}`)}.json`);
const durableCompletionBytes = fs.readFileSync(durableCompletionFile), durableNonceBytes = fs.readFileSync(durableNonceFile);
if (!durableCompletionBytes.includes(Buffer.from(historicalCompletion.request_sha256)) || !durableNonceBytes.includes(Buffer.from('"status":"applied"'))) throw new Error('ordinary bridge anchor lacks durable completion or applied nonce state');

// B was ordinarily resolved, then its external event/receipt/Flow projection
// was lost. The retained B edge is the only repair target. Restore A's
// request-keyed snapshot and append C without minting a replacement receipt.
fs.writeFileSync(path.join(project, 'review-target', 'delivery.md'), 'bridge delivery B failed\n'); sidecar('bridge-b-failed', 'bridge-reviewer-c', 'fail', 'bridge-b', 'bridge-b-defect', '2026-07-20T01:03:00Z');
fs.writeFileSync(path.join(project, 'review-target', 'delivery.md'), 'bridge delivery B repaired\n'); sidecar('bridge-b-repaired', 'bridge-reviewer-d', 'pass', 'bridge-b', 'bridge-b-defect', '2026-07-20T01:04:00Z');
const afterB = critiques(); const pairB = [afterB[2].critique_record_id, afterB[3].critique_record_id]; if (afterB.length !== 4) throw new Error('bridge B append did not preserve ordered A history');
const ordinaryB = request('resolve-critique-request', pairB, 'bridge-ordinary-b');
if (invoke('resolve-critique', pairB, ordinaryB.file).operation_status !== 'applied') throw new Error('ordinary bridge gap fixture was not applied');
fs.writeFileSync(ledgerFile, historicalLedgerBytes); fs.writeFileSync(completionFile, historicalCompletionBytes);
fs.rmSync(flowRoot, { recursive: true, force: true }); fs.cpSync(historicalFlow, flowRoot, { recursive: true });
const restoredFlowOwnership = spawnSync('chown', ['-R', 'node:node', flowRoot], { encoding: 'utf8' });
if (restoredFlowOwnership.status !== 0) throw new Error(`could not restore unprivileged Flow ownership: ${restoredFlowOwnership.stdout}${restoredFlowOwnership.stderr}`);
fs.writeFileSync(path.join(project, 'review-target', 'delivery.md'), 'bridge delivery C failed\n'); sidecar('bridge-c-failed', 'bridge-reviewer-e', 'fail', 'bridge-c', 'bridge-c-defect', '2026-07-20T01:05:00Z');
fs.writeFileSync(path.join(project, 'review-target', 'delivery.md'), 'bridge delivery C repaired\n'); sidecar('bridge-c-repaired', 'bridge-reviewer-f', 'pass', 'bridge-c', 'bridge-c-defect', '2026-07-20T01:06:00Z');
if (!fs.readFileSync(completionFile).equals(historicalCompletionBytes)) throw new Error('later critique minted or changed a stale completion');
const afterLater = critiques(); const pairC = [afterLater[4].critique_record_id, afterLater[5].critique_record_id]; if (afterLater.length !== 6) throw new Error('later critique append did not preserve ordered history');

const repair = request('repair-critique-resolution-history-request', pairB, 'bridge-repair');
const bundleFile = path.join(session, 'trust.bundle'), bundleBeforeRepair = fs.readFileSync(bundleFile), ledgerBeforeRepair = fs.readFileSync(ledgerFile), flowBeforeRepair = '/tmp/bridge-before-repair-flow'; fs.rmSync(flowBeforeRepair, { recursive: true, force: true }); fs.cpSync(flowRoot, flowBeforeRepair, { recursive: true });
const restore = (file, bytes) => fs.writeFileSync(file, bytes);
const mutateAndReject = (label, file, mutate, pattern) => { const bytes = fs.readFileSync(file); try { mutate(); reject(label, () => invoke('repair-critique-resolution-history', pairB, repair.file), pattern); } finally { restore(file, bytes); } };
mutateAndReject('missing durable completion', durableCompletionFile, () => fs.rmSync(durableCompletionFile), /durable completion|ENOENT.*\/completions\//);
mutateAndReject('tampered durable nonce', durableNonceFile, () => fs.writeFileSync(durableNonceFile, '{}\n'), /durable nonce/);
mutateAndReject('historical attachment drift', path.join(flowRoot, 'evidence', 'manifest.json'), () => { const manifest = JSON.parse(fs.readFileSync(path.join(flowRoot, 'evidence', 'manifest.json'), 'utf8')); manifest.evidence.find((entry) => entry.id === historicalAttachmentId).sha256 = '0'.repeat(64); fs.writeFileSync(path.join(flowRoot, 'evidence', 'manifest.json'), JSON.stringify(manifest)); }, /historical Flow attachment/);
mutateAndReject('historical stored snapshot drift', path.join(flowRoot, historicalEntry[0].stored_path), () => fs.writeFileSync(path.join(flowRoot, historicalEntry[0].stored_path), `${historicalSnapshot}\n`), /historical Flow stored trust bundle/);
mutateAndReject('ambiguous ledger prefix', ledgerFile, () => { const ledger = JSON.parse(historicalLedgerBytes); ledger.events.push(structuredClone(ledger.events[0])); fs.writeFileSync(ledgerFile, JSON.stringify(ledger)); }, /ledger|event|prefix/);
mutateAndReject('critique edge mutation', bundleFile, () => { const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8')); bundle.claims.find((claim) => claim.metadata?.critique_record_id === pairB[0]).metadata.critique_resolution.resolver = 'forged-reviewer'; fs.writeFileSync(bundleFile, JSON.stringify(bundle)); }, /exact current preimages|preimage/);
mutateAndReject('current raw bundle CAS drift', bundleFile, () => fs.writeFileSync(bundleFile, Buffer.concat([bundleBeforeRepair, Buffer.from(' ')])), /exact current preimages|preimage/);
mutateAndReject('current raw ledger CAS drift', ledgerFile, () => fs.writeFileSync(ledgerFile, Buffer.concat([ledgerBeforeRepair, Buffer.from(' ')])), /exact current preimages|preimage/);

// Race the worker after its root check but before final publication. The
// journal must restore both session and Flow snapshots, then the same prepared
// authorization must recover only after the two root checks run again.
const invokeAsync = () => new Promise((resolve) => { const command = ['node', '/work/history-repair-invoke.mjs', 'repair-critique-resolution-history', project, session, repair.file, pairB[0], pairB[1]].map(shellQuote).join(' '); const child = spawn('su', ['-s', '/bin/bash', 'node', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', (value) => { stdout += value; }); child.stderr.on('data', (value) => { stderr += value; }); child.on('close', (status) => resolve({ status, stdout, stderr })); });
const journalFile = path.join(session, '.lifecycle-authority.transaction.json'); fs.rmSync(journalFile, { force: true }); const pending = invokeAsync();
for (let attempt = 0; attempt < 500 && !fs.existsSync(journalFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
if (!fs.existsSync(journalFile)) throw new Error('transaction rollback fault did not reach the prepared journal');
fs.writeFileSync(bundleFile, Buffer.concat([bundleBeforeRepair, Buffer.from(' ')]));
const rollback = await pending; if (rollback.status === 0) throw new Error('transaction rollback fault unexpectedly committed');
if (!fs.readFileSync(bundleFile).equals(bundleBeforeRepair)) throw new Error('transaction rollback did not restore Trust Bundle bytes');
if (!fs.readFileSync(ledgerFile).equals(ledgerBeforeRepair)) throw new Error('transaction rollback did not restore resolution ledger bytes');
if (!fs.readFileSync(completionFile).equals(historicalCompletionBytes) || !fs.readFileSync(path.join(flowRoot, 'evidence', 'manifest.json')).equals(fs.readFileSync(path.join(flowBeforeRepair, 'evidence', 'manifest.json')))) throw new Error('transaction rollback did not restore the stale receipt and canonical Flow snapshot');
const rollbackJournal = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
if (rollbackJournal.status !== 'rolled_back') throw new Error(`transaction rollback journal status was ${String(rollbackJournal.status)}: ${rollback.stdout}${rollback.stderr}`);

if (invoke('repair-critique-resolution-history', pairB, repair.file).operation_status !== 'applied') throw new Error('prepared history repair did not recover');
if (!fs.readFileSync(bundleFile).equals(bundleBeforeRepair)) throw new Error('history repair changed Trust Bundle bytes');
const repairedCompletionBytes = fs.readFileSync(completionFile), repairedCompletion = verifyCompletion(completionFile);
if (repairedCompletion.action !== 'repair-critique-resolution-history' || repairedCompletion.request_sha256 === historicalCompletion.request_sha256) throw new Error('repair did not emit an exact new completion');
const repairAttachment = `lifecycle-authority:${repairedCompletion.request_sha256}`, repairedManifest = JSON.parse(fs.readFileSync(path.join(flowRoot, 'evidence', 'manifest.json'), 'utf8'));
if (repairedManifest.evidence.filter((entry) => entry.id === repairAttachment).length !== 1 || !fs.readFileSync(path.join(flowRoot, 'evidence', `${repairAttachment}.json`)).equals(bundleBeforeRepair)) throw new Error('repair did not emit the exact request-keyed Flow attachment');
const repairedLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); if (repairedLedger.events.length !== 2 || repairedLedger.events.map((event) => event.operation).join(',') !== 'resolve-critique,repair-critique-resolution-history') throw new Error('repair did not append exactly one authority event');

const ordinaryC = request('resolve-critique-request', pairC, 'bridge-ordinary-c'); if (invoke('resolve-critique', pairC, ordinaryC.file).operation_status !== 'applied') throw new Error('post-repair ordinary resolution was not applied');
const newerReceipt = fs.readFileSync(completionFile); if (invoke('repair-critique-resolution-history', pairB, repair.file).operation_status !== 'replayed') throw new Error('exact repair replay was not reported');
if (!fs.readFileSync(completionFile).equals(newerReceipt)) throw new Error('repair replay overwrote a newer exact receipt');
const finalLedger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); if (finalLedger.events.length !== 3 || finalLedger.events.map((event) => event.sequence).join(',') !== '1,2,3') throw new Error('post-repair ledger is not append-only');
console.log('PASS: request-keyed durable bridge anchors, stale receipt rejection, root-only two-pass checks, rollback/recovery, replay preservation, and exact repaired Flow attachment');
NODE
node /work/history-repair-bridge-anchors-e2e.mjs

cat > /work/check-lifecycle-invocation.mjs <<'NODE'
import fs from 'node:fs'; import path from 'node:path';
import { invokeExternalLifecycleAuthority } from './build/src/external-lifecycle-authority.js';
const [slug, authorizationFile, expected] = process.argv.slice(2), project = '/tmp/lifecycle-authority-e2e', session = path.join(project, '.kontourai', 'flow-agents', slug);
const assignment = path.join(project, '.kontourai', 'flow-agents', 'assignment', `${slug}.json`), flow = path.join(project, '.kontourai', 'flow', 'runs', slug, 'state.json');
const beforeAssignment = fs.readFileSync(assignment, 'utf8'), beforeFlow = fs.readFileSync(flow, 'utf8');
try {
  const result = invokeExternalLifecycleAuthority({ action: 'cancel', project_root: project, session_dir: session, authorization_file: authorizationFile });
  if (result.operation_status !== expected) throw new Error(`expected ${expected}, got ${result.operation_status}`);
} catch (error) {
  if (expected !== 'reject' || !/live canonical assignment holder/.test(String(error))) throw error;
  if (fs.readFileSync(assignment, 'utf8') !== beforeAssignment || fs.readFileSync(flow, 'utf8') !== beforeFlow) throw new Error('mismatched signed actor mutated project state');
  process.exit(0);
}
if (expected === 'reject') throw new Error('mismatched signed actor unexpectedly succeeded');
if ((expected === 'applied' || expected === 'replayed') && Object.hasOwn(JSON.parse(fs.readFileSync(assignment, 'utf8')).actor, 'human')) throw new Error('legacy assignment actor was rewritten');
NODE

mkdir -p "$STATE/nonces"
nonce_before="$(mktemp)"; nonce_after="$(mktemp)"
find "$STATE/nonces" -maxdepth 1 -type f -printf '%f\n' | sort > "$nonce_before"
su -s /bin/bash node -c 'node /work/check-lifecycle-invocation.mjs legacy-same-nonce-e2e /root/lifecycle-authorizations/legacy-same-nonce-mismatch.json reject'
find "$STATE/nonces" -maxdepth 1 -type f -printf '%f\n' | sort > "$nonce_after"
cmp -s "$nonce_before" "$nonce_after" || { echo "mismatched signed actor persisted a nonce" >&2; exit 1; }
su -s /bin/bash node -c 'node /work/check-lifecycle-invocation.mjs legacy-same-nonce-e2e /root/lifecycle-authorizations/legacy-same-nonce-valid.json applied'
su -s /bin/bash node -c 'node /work/check-lifecycle-invocation.mjs legacy-recovery-e2e /root/lifecycle-authorizations/legacy-recovery.json applied'
node --input-type=module - "$STATE" "$PROJECT" /root/lifecycle-authorizations/legacy-recovery.json <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import { canonicalJson, sha256 } from './packaging/lifecycle-authority/coordinator.mjs';
const [state, project, authorizationFile] = process.argv.slice(2), authorization = JSON.parse(fs.readFileSync(authorizationFile, 'utf8'));
const runId = authorization.run_id, keyId = authorization.signature.key_id, request = { action: 'cancel', project_root: project, session_dir: path.join(project, '.kontourai', 'flow-agents', runId), authorization_file: authorizationFile };
const operationId = sha256({ project, run_id: runId, action: 'cancel', key_id: keyId, nonce: authorization.nonce });
const nonceFile = path.join(state, 'nonces', `${sha256(`${keyId}\u0000${authorization.nonce}`)}.json`), completionFile = path.join(state, 'completions', `${operationId}.json`);
fs.writeFileSync(nonceFile, JSON.stringify({ schema_version: '1.0', operation_id: operationId, authorization_sha256: sha256(canonicalJson(authorization)), key_id: keyId, nonce: authorization.nonce, request_sha256: sha256(request), status: 'prepared' }));
fs.rmSync(completionFile, { force: true });
NODE
su -s /bin/bash node -c 'node /work/check-lifecycle-invocation.mjs legacy-recovery-e2e /root/lifecycle-authorizations/legacy-recovery.json applied'
su -s /bin/bash node -c 'node /work/check-lifecycle-invocation.mjs legacy-recovery-e2e /root/lifecycle-authorizations/legacy-recovery.json replayed'

cat > /work/operator-e2e.mjs <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { invokeExternalLifecycleAuthority, verifyLifecycleAuthorityCompletion } from './build/src/external-lifecycle-authority.js';
import { syncBuilderFlowSession } from './build/src/builder-flow-runtime.js';
const project = '/tmp/lifecycle-authority-e2e'; const session = (slug) => path.join(project, '.kontourai', 'flow-agents', slug);
const invoke = (action, slug, authorization_file, extra = {}) => invokeExternalLifecycleAuthority({ action, project_root: project, session_dir: session(slug), authorization_file, ...extra });
const expectReject = (fn, pattern) => { try { fn(); } catch (error) { if (pattern.test(String(error))) return; throw error; } throw new Error(`expected rejection: ${pattern}`); };
const ids = JSON.parse(fs.readFileSync(path.join(session('resolve-e2e'), 'trust.bundle'), 'utf8')).claims.filter((claim) => claim.metadata?.origin === 'critique').map((claim) => claim.metadata.critique_record_id);
const resolve = invoke('resolve-critique', 'resolve-e2e', '/root/lifecycle-authorizations/resolve.json', { prior_record_id: ids[0], resolving_record_id: ids[1] });
if (resolve.operation_status !== 'applied') throw new Error('resolve was not applied');
const replay = invoke('resolve-critique', 'resolve-e2e', '/root/lifecycle-authorizations/resolve.json', { prior_record_id: ids[0], resolving_record_id: ids[1] });
if (replay.operation_status !== 'replayed') throw new Error('resolve did not replay');
expectReject(() => invoke('resolve-critique', 'resolve-e2e', '/root/lifecycle-authorizations/resolve-copied-path.json', { prior_record_id: ids[0], resolving_record_id: ids[1] }), /consumed lifecycle authorization record does not match the exact request/);
expectReject(() => invoke('resolve-critique', 'resolve-e2e', '/root/lifecycle-authorizations/copied-project.json', { prior_record_id: ids[0], resolving_record_id: ids[1] }), /canonical project root/);
const wrongStepProject = '/tmp/lifecycle-authority-wrong-step', wrongStepSession = path.join(wrongStepProject, '.kontourai', 'flow-agents', 'resolve-e2e'), wrongStepState = path.join(wrongStepProject, '.kontourai', 'flow', 'runs', 'resolve-e2e', 'state.json'); const wrongState = JSON.parse(fs.readFileSync(wrongStepState, 'utf8')); wrongState.current_step = 'execute'; fs.writeFileSync(wrongStepState, JSON.stringify(wrongState)); expectReject(() => invokeExternalLifecycleAuthority({ action: 'resolve-critique', project_root: wrongStepProject, session_dir: wrongStepSession, authorization_file: '/root/lifecycle-authorizations/wrong-step.json', prior_record_id: ids[0], resolving_record_id: ids[1] }), /builder.build verify step/);
const wrongFlowProject = '/tmp/lifecycle-authority-wrong-flow', wrongFlowSession = path.join(wrongFlowProject, '.kontourai', 'flow-agents', 'resolve-e2e'), wrongDefinition = path.join(wrongFlowProject, '.kontourai', 'flow', 'runs', 'resolve-e2e', 'definition.json'); const foreign = JSON.parse(fs.readFileSync(wrongDefinition, 'utf8')); foreign.id = 'builder.shape'; fs.writeFileSync(wrongDefinition, JSON.stringify(foreign)); expectReject(() => invokeExternalLifecycleAuthority({ action: 'resolve-critique', project_root: wrongFlowProject, session_dir: wrongFlowSession, authorization_file: '/root/lifecycle-authorizations/wrong-flow.json', prior_record_id: ids[0], resolving_record_id: ids[1] }), /builder.build verify step/);
const bundle = JSON.parse(fs.readFileSync(path.join(session('resolve-e2e'), 'trust.bundle'), 'utf8'));
const resolutionEvents = JSON.parse(fs.readFileSync(path.join(session('resolve-e2e'), 'lifecycle-authority.resolution-events.json'), 'utf8')).events;
if (resolutionEvents.length !== 1 || !bundle.claims.some((claim) => claim.status === 'superseded' && claim.value === 'fail')) throw new Error('historical critique was not preserved exactly once');
const completion = JSON.parse(fs.readFileSync(path.join(session('resolve-e2e'), 'lifecycle-authority.completion.json'), 'utf8'));
const forged = structuredClone(completion); forged.signature.value = Buffer.alloc(64).toString('base64'); expectReject(() => verifyLifecycleAuthorityCompletion(forged), /completion signature is invalid/);
const validation = spawnSync(process.execPath, ['./build/src/cli/validate-workflow-artifacts.js', '--require-critique', session('resolve-e2e')], { cwd: '/work', encoding: 'utf8' }); if (validation.status !== 0) throw new Error(`repaired critique history did not validate: ${validation.stdout}${validation.stderr}`);
const gated = await syncBuilderFlowSession({ sessionDir: session('resolve-e2e') }); if (!gated.run.manifest.evidence.some((entry) => entry.id.startsWith('lifecycle-authority:'))) throw new Error('Builder runtime did not consume the signed lifecycle attestation');
const copiedRuntimeProject = '/tmp/lifecycle-runtime-copied-project'; fs.rmSync(copiedRuntimeProject, { recursive: true, force: true }); fs.cpSync(project, copiedRuntimeProject, { recursive: true }); try { await syncBuilderFlowSession({ sessionDir: path.join(copiedRuntimeProject, '.kontourai', 'flow-agents', 'resolve-e2e') }); throw new Error('copied lifecycle attestation was accepted for another project'); } catch (error) { if (!/trusted project and run/.test(String(error))) throw error; }
const copied = '/tmp/lifecycle-authority-copied-completion'; fs.rmSync(copied, { recursive: true, force: true }); fs.cpSync(session('resolve-e2e'), copied, { recursive: true }); const copiedBundle = JSON.parse(fs.readFileSync(path.join(copied, 'trust.bundle'), 'utf8')); copiedBundle.claims.find((claim) => claim.status === 'superseded').metadata.superseded_by = 'forged-record'; fs.writeFileSync(path.join(copied, 'trust.bundle'), JSON.stringify(copiedBundle)); const copiedValidation = spawnSync(process.execPath, ['./build/src/cli/validate-workflow-artifacts.js', '--require-critique', copied], { cwd: '/work', encoding: 'utf8' }); if (copiedValidation.status === 0) throw new Error('copied completion blessed an edited critique graph');
const digestDrift = '/tmp/lifecycle-authority-digest-drift'; fs.rmSync(digestDrift, { recursive: true, force: true }); fs.cpSync(session('resolve-e2e'), digestDrift, { recursive: true }); const driftBundle = JSON.parse(fs.readFileSync(path.join(digestDrift, 'trust.bundle'), 'utf8')); driftBundle.claims.find((claim) => claim.claimType === 'workflow.acceptance.criterion').fieldOrBehavior += ' edited'; fs.writeFileSync(path.join(digestDrift, 'trust.bundle'), JSON.stringify(driftBundle)); const driftValidation = spawnSync(process.execPath, ['./build/src/cli/validate-workflow-artifacts.js', '--require-critique', digestDrift], { cwd: '/work', encoding: 'utf8' }); if (driftValidation.status === 0) throw new Error('same-run completion blessed a different internally valid bundle');
fs.writeFileSync(path.join(session('resolve-e2e'), 'post-resolution-non-root.txt'), 'still writable by project owner\n'); if (fs.statSync(path.join(session('resolve-e2e'), 'post-resolution-non-root.txt')).uid !== process.getuid()) throw new Error('post-resolution artifacts are not owned by the non-root workflow user');
const run = path.join(project, '.kontourai', 'flow', 'runs', 'resolve-e2e'); for (const file of ['evidence/manifest.json', 'state.json', 'report.json', 'report.md']) if (!fs.existsSync(path.join(run, file))) throw new Error(`missing canonical Flow write ${file}`); if (!JSON.parse(fs.readFileSync(path.join(run, 'evidence/manifest.json'), 'utf8')).evidence.some((entry) => entry.id.startsWith('lifecycle-authority:'))) throw new Error('canonical Flow manifest missing authority attachment');
const canceled = invoke('cancel', 'archive-e2e', '/root/lifecycle-authorizations/cancel.json'); if (canceled.operation_status !== 'applied') throw new Error('cancel was not applied'); if (JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow-agents', 'assignment', 'archive-e2e.json'), 'utf8')).status !== 'released') throw new Error('cancel did not release assignment'); if (JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'archive-e2e', 'state.json'), 'utf8')).status !== 'canceled') throw new Error('cancel did not update canonical Flow state');
const archived = invoke('archive', 'archive-e2e', '/root/lifecycle-authorizations/archive.json'); if (archived.operation_status !== 'applied' || fs.existsSync(session('archive-e2e')) || !fs.existsSync(path.join(project, '.kontourai', 'flow-agents', 'archive', 'archive-e2e', 'state.json'))) throw new Error('archive behavior is invalid');
const legacyAssignment = path.join(project, '.kontourai', 'flow-agents', 'assignment', 'legacy-e2e.json'); if (Object.hasOwn(JSON.parse(fs.readFileSync(legacyAssignment, 'utf8')).actor, 'human')) throw new Error('legacy fixture was rewritten before redemption');
const legacyCanceled = invoke('cancel', 'legacy-e2e', '/root/lifecycle-authorizations/legacy.json'); if (legacyCanceled.operation_status !== 'applied') throw new Error('legacy assignment was not redeemed'); const releasedLegacy = JSON.parse(fs.readFileSync(legacyAssignment, 'utf8')); if (releasedLegacy.status !== 'released' || Object.hasOwn(releasedLegacy.actor, 'human')) throw new Error('legacy assignment compatibility rewrote the persisted actor');
const legacyMismatchAssignment = path.join(project, '.kontourai', 'flow-agents', 'assignment', 'legacy-mismatch-e2e.json'), legacyMismatchRun = path.join(project, '.kontourai', 'flow', 'runs', 'legacy-mismatch-e2e', 'state.json'); const beforeLegacyMismatchAssignment = fs.readFileSync(legacyMismatchAssignment, 'utf8'), beforeLegacyMismatchRun = fs.readFileSync(legacyMismatchRun, 'utf8'); for (const field of ['runtime', 'session', 'host', 'human']) { expectReject(() => invoke('cancel', 'legacy-mismatch-e2e', `/root/lifecycle-authorizations/legacy-mismatch-${field}.json`), /live canonical assignment holder/); if (fs.readFileSync(legacyMismatchAssignment, 'utf8') !== beforeLegacyMismatchAssignment || fs.readFileSync(legacyMismatchRun, 'utf8') !== beforeLegacyMismatchRun) throw new Error(`mismatched legacy ${field} actor mutated canonical state`); }
expectReject(() => invoke('cancel', 'stale-e2e', '/root/lifecycle-authorizations/stale.json'), /authorization is expired/);
const staleAssignment = path.join(project, '.kontourai', 'flow-agents', 'assignment', 'stale-e2e.json'); const staleRecord = JSON.parse(fs.readFileSync(staleAssignment, 'utf8')); staleRecord.actor_key = 'stale-holder'; fs.writeFileSync(staleAssignment, JSON.stringify(staleRecord)); expectReject(() => invoke('cancel', 'stale-e2e', '/root/lifecycle-authorizations/stale-holder.json'), /live canonical assignment holder/); if (JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'stale-e2e', 'state.json'), 'utf8')).status !== 'active') throw new Error('stale assignment canceled Flow');
const concurrentCode = `import { invokeExternalLifecycleAuthority } from './build/src/external-lifecycle-authority.js'; import path from 'node:path'; const project = process.argv[1], auth = process.argv[2]; invokeExternalLifecycleAuthority({ action: 'cancel', project_root: project, session_dir: path.join(project, '.kontourai', 'flow-agents', 'concurrent-e2e'), authorization_file: auth });`;
const concurrent = (auth) => new Promise((resolve) => { const child = spawn(process.execPath, ['--input-type=module', '-e', concurrentCode, project, auth], { cwd: '/work', stdio: 'ignore' }); child.on('exit', (status) => resolve(status)); });
const concurrentResults = await Promise.all([concurrent('/root/lifecycle-authorizations/concurrent-a.json'), concurrent('/root/lifecycle-authorizations/concurrent-b.json')]); if (concurrentResults.filter((status) => status === 0).length !== 1 || concurrentResults.filter((status) => status !== 0).length !== 1) throw new Error(`same-run lock did not serialize distinct nonces: ${concurrentResults}`); if (JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'concurrent-e2e', 'state.json'), 'utf8')).status !== 'canceled' || JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow-agents', 'assignment', 'concurrent-e2e.json'), 'utf8')).status !== 'released') throw new Error('concurrent lifecycle mutation lost canonical state');
const swapped = session('symlink-e2e'), rootSentinel = '/tmp/lifecycle-root-target/sentinel'; fs.rmSync(swapped, { recursive: true, force: true }); fs.symlinkSync('/tmp/lifecycle-root-target', swapped); expectReject(() => invoke('cancel', 'symlink-e2e', '/root/lifecycle-authorizations/symlink.json'), /session_dir must identify/); if (fs.readFileSync(rootSentinel, 'utf8') !== 'root-owned sentinel\n') throw new Error('symlink swap escaped into a root-owned path');
expectReject(() => invoke('cancel', 'unauthorized-e2e', '/root/lifecycle-authorizations/unauthorized.json'), /authorization signature is invalid/);
expectReject(() => execFileSync('/usr/bin/sudo', ['-n', '--', process.env.LIFECYCLE_HELPER_PATH], { input: '{}\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), /unsupported coordinator protocol|coordinator envelope/);
console.log('PASS: signed resolve/cancel/archive E2E, legacy actor compatibility, replay, protected completion verification, rejection paths, canonical Flow writes, assignment release, archive, and repaired critique validation');
NODE
su -s /bin/bash node -c "cd /work && node build/src/cli/workflow-sidecar.js record-critique '$RESOLVE_SESSION' --id resolve-current-clean-review --reviewer resolve-reviewer-current --verdict pass --summary 'Current resolve workspace verified.' --artifact-ref '$DELIVERY' --lane-json '{\"id\":\"resolve-current\",\"status\":\"pass\",\"summary\":\"Current resolve workspace verified.\",\"evidence_refs\":[{\"kind\":\"artifact\",\"file\":\"review-target/delivery.md\",\"summary\":\"Current resolve delivery review.\"}]}' --timestamp '2026-07-20T02:00:00Z' >/dev/null"
mapfile -t CURRENT_RESOLVE_CRITIQUE_IDS < <(node - "$RESOLVE_SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs'); for (const claim of JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).claims.filter((claim) => claim.metadata?.origin === 'critique')) console.log(claim.metadata.critique_record_id);
NODE
)
test "${#CURRENT_RESOLVE_CRITIQUE_IDS[@]}" -eq 3
su -s /bin/bash node -c "cd /work && node build/src/cli.js workflow resolve-critique-request --session-dir '$RESOLVE_SESSION' --prior-record-id '${CURRENT_RESOLVE_CRITIQUE_IDS[0]}' --resolving-record-id '${CURRENT_RESOLVE_CRITIQUE_IDS[1]}' > /tmp/resolve-current-request.json"
node /work/sign-authorization.mjs /tmp/resolve-current-request.json /root/lifecycle-authorizations/resolve.json
cp /root/lifecycle-authorizations/resolve.json /root/lifecycle-authorizations/resolve-copied-path.json
su -s /bin/bash node -c 'node /work/operator-e2e.mjs'
CONTAINER
