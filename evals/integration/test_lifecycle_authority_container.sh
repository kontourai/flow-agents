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
bad_modules="$(mktemp -d)"
mkdir -p "$bad_modules/@kontourai"
ln -s "$PWD/node_modules/@kontourai/flow" "$bad_modules/@kontourai/flow"
if scripts/lifecycle-authority-admin.sh install packaging/lifecycle-authority/coordinator.mjs "$bad_modules" kontourai-lifecycle-operator >/tmp/rejected-staged-reducer.log 2>&1; then
  echo "symlinked staged reducer unexpectedly installed" >&2; exit 1
fi
tampered_modules="$(mktemp -d)"
cp -a node_modules/. "$tampered_modules/"
printf '\n// tampered fixture\n' >> "$tampered_modules/@kontourai/flow/dist/index.js"
if scripts/lifecycle-authority-admin.sh install packaging/lifecycle-authority/coordinator.mjs "$tampered_modules" kontourai-lifecycle-operator >/tmp/rejected-tampered-reducer.log 2>&1; then
  echo "tampered staged reducer unexpectedly installed" >&2; exit 1
fi
scripts/lifecycle-authority-admin.sh install packaging/lifecycle-authority/coordinator.mjs node_modules kontourai-lifecycle-operator
usermod -a -G kontourai-lifecycle-operator node
test -f /etc/sudoers.d/kontourai-flow-agents-lifecycle-authority-v1
visudo -cf /etc/sudoers.d/kontourai-flow-agents-lifecycle-authority-v1 >/dev/null
SYSTEM_PREFIX=/usr/local
export LIFECYCLE_HELPER_PATH="$SYSTEM_PREFIX/libexec/kontourai/flow-agents-lifecycle-authority-v1"
stat -c "%U %a" "$LIFECYCLE_HELPER_PATH" | grep -qx "root 755"

CONFIG=/etc/kontourai/flow-agents-lifecycle-authority-v1
STATE_SEGMENT=lib
STATE="/var/$STATE_SEGMENT/kontourai/flow-agents-lifecycle-authority-v1"
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
import fs from 'node:fs'; import path from 'node:path';
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
for (const slug of ['resolve-e2e', 'archive-e2e', 'stale-e2e', 'unauthorized-e2e', 'concurrent-e2e', 'symlink-e2e', 'project-auth-e2e', 'symlink-auth-e2e']) await makeSession(slug);
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
mapfile -t CRITIQUE_IDS < <(node - "$RESOLVE_SESSION/trust.bundle" <<'NODE'
const fs = require('node:fs'); for (const claim of JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).claims.filter((claim) => claim.metadata?.origin === 'critique')) console.log(claim.metadata.critique_record_id);
NODE
)
test "${#CRITIQUE_IDS[@]}" -eq 2
node build/src/cli.js workflow resolve-critique-request --session-dir "$RESOLVE_SESSION" --prior-record-id "${CRITIQUE_IDS[0]}" --resolving-record-id "${CRITIQUE_IDS[1]}" > /tmp/resolve-request.json
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
node /work/make-lifecycle-authorization.mjs cancel project-auth-e2e /root/lifecycle-authorizations/project-auth.json "$FUTURE"
node /work/make-lifecycle-authorization.mjs cancel symlink-auth-e2e /root/lifecycle-authorizations/symlink-auth.json "$FUTURE"
node - /root/lifecycle-authorizations/unauthorized.json <<'NODE'
const fs = require('node:fs'), crypto = require('node:crypto'); const file = process.argv[2], value = JSON.parse(fs.readFileSync(file, 'utf8')); const { signature, ...unsigned } = value;
value.signature.value = crypto.sign(null, Buffer.from(JSON.stringify(unsigned)), crypto.generateKeyPairSync('ed25519').privateKey).toString('base64'); fs.writeFileSync(file, JSON.stringify(value));
NODE
cp /root/lifecycle-authorizations/project-auth.json "$PROJECT/project-authorization.json"
ln -s /root/lifecycle-authorizations /tmp/lifecycle-authorization-parent-link
chown -R node:node "$PROJECT"

cat > /work/operator-e2e.mjs <<'NODE'
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { invokeExternalLifecycleAuthority, verifyLifecycleAuthorityCompletion } from './build/src/external-lifecycle-authority.js';
import { syncBuilderFlowSession } from './build/src/builder-flow-runtime.js';
const project = '/tmp/lifecycle-authority-e2e'; const session = (slug) => path.join(project, '.kontourai', 'flow-agents', slug);
const invoke = (action, slug, authorization_file, extra = {}) => invokeExternalLifecycleAuthority({ action, project_root: project, session_dir: session(slug), authorization_file, ...extra });
const expectReject = (fn, pattern) => { try { fn(); } catch (error) { if (pattern.test(String(error))) return; throw error; } throw new Error(`expected rejection: ${pattern}`); };
const ids = JSON.parse(fs.readFileSync(path.join(session('resolve-e2e'), 'trust.bundle'), 'utf8')).claims.filter((claim) => claim.metadata?.origin === 'critique').map((claim) => claim.metadata.critique_record_id);
expectReject(() => invoke('cancel', 'project-auth-e2e', path.join(project, 'project-authorization.json')), /authorization_file must be outside the project and worktree/);
expectReject(() => invoke('cancel', 'symlink-auth-e2e', '/tmp/lifecycle-authorization-parent-link/symlink-auth.json'), /authorization_file must not contain symlinks/);
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
const boundSession = session('resolve-e2e'), boundBundleFile = path.join(boundSession, 'trust.bundle'), originalBundleBytes = fs.readFileSync(boundBundleFile); const unrelatedBundle = JSON.parse(originalBundleBytes); unrelatedBundle.claims.find((claim) => claim.claimType === 'workflow.acceptance.criterion').fieldOrBehavior += ' edited'; fs.writeFileSync(boundBundleFile, JSON.stringify(unrelatedBundle)); const unrelatedValidation = spawnSync(process.execPath, ['./build/src/cli/validate-workflow-artifacts.js', '--require-critique', boundSession], { cwd: '/work', encoding: 'utf8' }); await syncBuilderFlowSession({ sessionDir: boundSession }); fs.writeFileSync(boundBundleFile, originalBundleBytes); if (unrelatedValidation.status !== 0) throw new Error(`unrelated later evidence invalidated critique authority: ${unrelatedValidation.stdout}${unrelatedValidation.stderr}`);
const eventFile = path.join(boundSession, 'lifecycle-authority.resolution-events.json'), originalEventBytes = fs.readFileSync(eventFile); const driftEvents = JSON.parse(originalEventBytes); driftEvents.events[0].resolver = 'forged-reviewer'; fs.writeFileSync(eventFile, JSON.stringify(driftEvents)); const eventValidation = spawnSync(process.execPath, ['./build/src/cli/validate-workflow-artifacts.js', '--require-critique', boundSession], { cwd: '/work', encoding: 'utf8' }); fs.writeFileSync(eventFile, originalEventBytes); if (eventValidation.status === 0) throw new Error('same-run completion blessed an edited critique resolution event');
fs.writeFileSync(path.join(session('resolve-e2e'), 'post-resolution-non-root.txt'), 'still writable by project owner\n'); if (fs.statSync(path.join(session('resolve-e2e'), 'post-resolution-non-root.txt')).uid !== process.getuid()) throw new Error('post-resolution artifacts are not owned by the non-root workflow user');
const run = path.join(project, '.kontourai', 'flow', 'runs', 'resolve-e2e'); for (const file of ['evidence/manifest.json', 'state.json', 'report.json', 'report.md']) if (!fs.existsSync(path.join(run, file))) throw new Error(`missing canonical Flow write ${file}`); if (!JSON.parse(fs.readFileSync(path.join(run, 'evidence/manifest.json'), 'utf8')).evidence.some((entry) => entry.id.startsWith('lifecycle-authority:'))) throw new Error('canonical Flow manifest missing authority attachment');
const canceled = invoke('cancel', 'archive-e2e', '/root/lifecycle-authorizations/cancel.json'); if (canceled.operation_status !== 'applied') throw new Error('cancel was not applied'); if (JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow-agents', 'assignment', 'archive-e2e.json'), 'utf8')).status !== 'released') throw new Error('cancel did not release assignment'); if (JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'archive-e2e', 'state.json'), 'utf8')).status !== 'canceled') throw new Error('cancel did not update canonical Flow state');
const archived = invoke('archive', 'archive-e2e', '/root/lifecycle-authorizations/archive.json'); if (archived.operation_status !== 'applied' || fs.existsSync(session('archive-e2e')) || !fs.existsSync(path.join(project, '.kontourai', 'flow-agents', 'archive', 'archive-e2e', 'state.json'))) throw new Error('archive behavior is invalid');
expectReject(() => invoke('cancel', 'stale-e2e', '/root/lifecycle-authorizations/stale.json'), /authorization is expired/);
const staleAssignment = path.join(project, '.kontourai', 'flow-agents', 'assignment', 'stale-e2e.json'); const staleRecord = JSON.parse(fs.readFileSync(staleAssignment, 'utf8')); staleRecord.actor_key = 'stale-holder'; fs.writeFileSync(staleAssignment, JSON.stringify(staleRecord)); expectReject(() => invoke('cancel', 'stale-e2e', '/root/lifecycle-authorizations/stale-holder.json'), /live canonical assignment holder/); if (JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'stale-e2e', 'state.json'), 'utf8')).status !== 'active') throw new Error('stale assignment canceled Flow');
const concurrentCode = `import { invokeExternalLifecycleAuthority } from './build/src/external-lifecycle-authority.js'; import path from 'node:path'; const project = process.argv[1], auth = process.argv[2]; invokeExternalLifecycleAuthority({ action: 'cancel', project_root: project, session_dir: path.join(project, '.kontourai', 'flow-agents', 'concurrent-e2e'), authorization_file: auth });`;
const concurrent = (auth) => new Promise((resolve) => { const child = spawn(process.execPath, ['--input-type=module', '-e', concurrentCode, project, auth], { cwd: '/work', stdio: 'ignore' }); child.on('exit', (status) => resolve(status)); });
const concurrentResults = await Promise.all([concurrent('/root/lifecycle-authorizations/concurrent-a.json'), concurrent('/root/lifecycle-authorizations/concurrent-b.json')]); if (concurrentResults.filter((status) => status === 0).length !== 1 || concurrentResults.filter((status) => status !== 0).length !== 1) throw new Error(`same-run lock did not serialize distinct nonces: ${concurrentResults}`); if (JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow', 'runs', 'concurrent-e2e', 'state.json'), 'utf8')).status !== 'canceled' || JSON.parse(fs.readFileSync(path.join(project, '.kontourai', 'flow-agents', 'assignment', 'concurrent-e2e.json'), 'utf8')).status !== 'released') throw new Error('concurrent lifecycle mutation lost canonical state');
const swapped = session('symlink-e2e'), rootSentinel = '/tmp/lifecycle-root-target/sentinel'; fs.rmSync(swapped, { recursive: true, force: true }); fs.symlinkSync('/tmp/lifecycle-root-target', swapped); expectReject(() => invoke('cancel', 'symlink-e2e', '/root/lifecycle-authorizations/symlink.json'), /session_dir must identify/); if (fs.readFileSync(rootSentinel, 'utf8') !== 'root-owned sentinel\n') throw new Error('symlink swap escaped into a root-owned path');
expectReject(() => invoke('cancel', 'unauthorized-e2e', '/root/lifecycle-authorizations/unauthorized.json'), /authorization signature is invalid/);
expectReject(() => execFileSync('/usr/bin/sudo', ['-n', '--', process.env.LIFECYCLE_HELPER_PATH], { input: '{}\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }), /unsupported coordinator protocol|coordinator envelope/);
console.log('PASS: signed resolve/cancel/archive E2E, replay, protected completion verification, rejection paths, canonical Flow writes, assignment release, archive, and repaired critique validation');
NODE
su -s /bin/bash node -c 'node /work/operator-e2e.mjs'
CONTAINER
