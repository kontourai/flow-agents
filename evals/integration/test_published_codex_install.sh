#!/usr/bin/env bash
# Proves the packed npm artifact is a self-contained, production-only Codex installer.
set -euo pipefail

# Resolve before isolating HOME: mise's shim consults HOME and is not the runtime.
# Match test_init_uninstall.sh; this also pins /usr/bin/env node package-bin calls.
NODE_BIN="$(node -p 'process.execPath')"
export PATH="$(dirname "$NODE_BIN"):$PATH"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_EVAL="$(mktemp -d /tmp/published-codex-install.XXXXXX)"
cleanup() { rm -rf "$TMPDIR_EVAL"; }
trap cleanup EXIT

PACK_DIR="$TMPDIR_EVAL/pack"
CONSUMER="$TMPDIR_EVAL/consumer"
HOME_DIR="$TMPDIR_EVAL/home"
CODEX_DIR="$HOME_DIR/.codex"
SKILLS_DIR="$HOME_DIR/.agents/skills"
NPM_CACHE="$TMPDIR_EVAL/npm-cache"
mkdir -p "$PACK_DIR" "$CONSUMER" "$HOME_DIR" "$NPM_CACHE"
REAL_USER_SKILLS="$(node - "$HOME/.agents/skills" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
let current = path.resolve(process.argv[2]);
const missing = [];
while (!fs.existsSync(current)) {
  missing.unshift(path.basename(current));
  const parent = path.dirname(current);
  if (parent === current) break;
  current = parent;
}
process.stdout.write(path.resolve(fs.realpathSync(current), ...missing));
NODE
)"

echo "=== Published Codex Install Integration ==="

(cd "$ROOT_DIR" && npm pack --json --pack-destination "$PACK_DIR" >/dev/null)
TARBALL="$(find "$PACK_DIR" -maxdepth 1 -type f -name '*.tgz' -print -quit)"
[[ -n "$TARBALL" ]] || { echo "npm pack did not produce a tarball" >&2; exit 1; }
# Run the regression while its delivering tarball still exists, before this
# eval enables the installed-module boundary and evicts delivery artifacts.
node "$ROOT_DIR/evals/integration/codex-offline-uninstall.mjs" "$TARBALL" published
TARBALL_LIST="$TMPDIR_EVAL/tarball.list"
tar -tzf "$TARBALL" > "$TARBALL_LIST"
grep -Fxq 'package/dist/codex/.codex/hooks.json' "$TARBALL_LIST"
grep -Fxq 'package/dist/codex/build/src/cli.js' "$TARBALL_LIST"
# Publisher-owned files must all be link-free before npm adds its own production
# dependencies. Keep this guard separate from npm-generated nested .bin links.
SHIPPED_ROOT="$TMPDIR_EVAL/shipped"
mkdir -p "$SHIPPED_ROOT"
tar -xzf "$TARBALL" -C "$SHIPPED_ROOT"
node --input-type=module - "$ROOT_DIR" "$SHIPPED_ROOT/package" <<'NODE'
import { pathToFileURL } from 'node:url';
const { assertShippedPackageLinks } = await import(pathToFileURL(`${process.argv[2]}/evals/integration/packed-package-links.mjs`));
assertShippedPackageLinks(process.argv[3]);
NODE

printf '{"name":"flow-agents-packed-consumer","private":true,"version":"1.0.0"}\n' > "$CONSUMER/package.json"
(cd "$CONSUMER" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --cache "$NPM_CACHE" "$TARBALL" >/dev/null)
[[ ! -e "$CONSUMER/node_modules/typescript" ]]
[[ ! -e "$CONSUMER/node_modules/@types/node" ]]

PACKAGE_ROOT="$CONSUMER/node_modules/@kontourai/flow-agents"
[[ -d "$PACKAGE_ROOT" && ! -L "$PACKAGE_ROOT" ]]
PACKAGE_REAL="$(cd "$PACKAGE_ROOT" && pwd -P)"
CONSUMER_REAL="$(cd "$CONSUMER" && pwd -P)"
case "$PACKAGE_REAL/" in
  "$CONSUMER_REAL/"*) ;;
  *) echo "packed package resolved outside isolated consumer: $PACKAGE_REAL" >&2; exit 1 ;;
esac
node "$ROOT_DIR/evals/integration/packed-package-links.mjs" "$SHIPPED_ROOT/package" "$PACKAGE_ROOT" "$CONSUMER"
[[ -f "$PACKAGE_ROOT/dist/codex/.codex/hooks.json" ]]
[[ -f "$PACKAGE_ROOT/dist/codex/.agents/skills/deliver/SKILL.md" ]]
FLOW_AGENTS_BIN="$CONSUMER/node_modules/.bin/flow-agents"
[[ -e "$FLOW_AGENTS_BIN" ]]
BIN_REAL="$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$FLOW_AGENTS_BIN")"
case "$BIN_REAL" in
  "$PACKAGE_REAL/"*) ;;
  *) echo "installed flow-agents bin resolves outside the packed package: $BIN_REAL" >&2; exit 1 ;;
esac

# Every init invocation in this eval must carry all three isolated install
# roots. In particular, --dest isolates CODEX_HOME but does not isolate the
# universal skills catalog by itself.
(
  cd "$CONSUMER"
  HOME="$HOME_DIR" \
  CODEX_HOME="$CODEX_DIR" \
  CODEX_REAL_HOME="$CODEX_DIR" \
  FLOW_AGENTS_SKILLS_DIR="$SKILLS_DIR" \
  NPM_CONFIG_CACHE="$NPM_CACHE" \
  NPM_CONFIG_OFFLINE=true \
  ./node_modules/.bin/flow-agents init --runtime codex --global --activate-kits --yes
)

SKILLS_REAL="$(cd "$SKILLS_DIR" && pwd -P)"
case "$SKILLS_REAL/" in
  "$REAL_USER_SKILLS/"*) echo "hermetic skills destination resolves into the real user catalog: $SKILLS_REAL" >&2; exit 1 ;;
esac
case "$SKILLS_REAL/" in
  "$(cd "$TMPDIR_EVAL" && pwd -P)/"*) ;;
  *) echo "hermetic skills destination resolves outside the eval root: $SKILLS_REAL" >&2; exit 1 ;;
esac

node - "$PACKAGE_ROOT" "$CODEX_DIR" "$SKILLS_DIR" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [packageRoot, codexHome, skillsRoot] = process.argv.slice(2);

function validateOwnedManifest(root, relative) {
  const manifestPath = path.join(root, relative);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error(`${relative} has no owned files`);
  for (const item of manifest.files) {
    const file = path.join(root, item.path);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (digest !== item.sha256) throw new Error(`${relative} hash mismatch: ${item.path}`);
  }
}

validateOwnedManifest(codexHome, ".flow-agents/codex-install-manifest.json");
validateOwnedManifest(skillsRoot, ".flow-agents/codex-universal-skills-install-manifest.json");
const install = JSON.parse(fs.readFileSync(path.join(codexHome, ".flow-agents/install.json"), "utf8"));
if (install.runtime !== "codex" || install.global !== true) throw new Error("global Codex install record is invalid");
if (!Array.isArray(install.active_kit_ids) || install.active_kit_ids.length === 0) throw new Error("kit activation was not recorded");
if (!fs.existsSync(path.join(codexHome, ".kontourai/flow-agents/projections/codex/activation.json"))) throw new Error("Codex kit activation manifest missing");
if (!fs.existsSync(path.join(codexHome, "hooks.json"))) throw new Error("installed Codex hooks missing");
if (!fs.existsSync(path.join(skillsRoot, "deliver/SKILL.md"))) throw new Error("installed portable skill missing");

const checkout = fs.realpathSync(packageRoot).replace(/\\/g, "/");
if (!checkout.startsWith(fs.realpathSync(path.dirname(path.dirname(path.dirname(packageRoot)))).replace(/\\/g, "/"))) {
  throw new Error("package is not rooted in the isolated consumer");
}
NODE

# A corrupt installed-package copy must fail before writing and preserve an
# actionable diagnostic. It must not attempt an install-time TypeScript build.
CORRUPT_ROOT="$CONSUMER/node_modules/@kontourai/flow-agents-corrupt"
cp -R "$PACKAGE_ROOT" "$CORRUPT_ROOT"
EXTERNAL_HOOKS="$TMPDIR_EVAL/external-hooks.json"
printf '{"hooks":{"Stop":[{"sentinel":"must-not-install"}]}}\n' > "$EXTERNAL_HOOKS"
rm "$CORRUPT_ROOT/dist/codex/.codex/hooks.json"
ln -s "$EXTERNAL_HOOKS" "$CORRUPT_ROOT/dist/codex/.codex/hooks.json"
CORRUPT_CODEX="$TMPDIR_EVAL/corrupt-codex"
CORRUPT_SKILLS="$TMPDIR_EVAL/corrupt-skills"
CORRUPT_SKILLS_REAL="$(cd "$(dirname "$CORRUPT_SKILLS")" && pwd -P)/$(basename "$CORRUPT_SKILLS")"
case "$CORRUPT_SKILLS_REAL/" in
  "$REAL_USER_SKILLS/"*) echo "corrupt-case skills destination resolves into the real user catalog: $CORRUPT_SKILLS_REAL" >&2; exit 1 ;;
esac
# This negative case intentionally invokes the copied package entry point
# directly: its purpose is to target that corrupt copy, not package-bin lookup.
if HOME="$HOME_DIR" CODEX_HOME="$CORRUPT_CODEX" CODEX_REAL_HOME="$CORRUPT_CODEX" \
  FLOW_AGENTS_SKILLS_DIR="$CORRUPT_SKILLS" NPM_CONFIG_CACHE="$NPM_CACHE" \
  node "$CORRUPT_ROOT/build/src/cli.js" init --runtime codex --global --activate-kits --yes \
  >"$TMPDIR_EVAL/corrupt.out" 2>&1; then
  echo "corrupt shipped bundle unexpectedly installed" >&2
  exit 1
fi
grep -Fq 'required prebuilt Codex bundle is missing or invalid' "$TMPDIR_EVAL/corrupt.out"
grep -Fq 'shipped bundle contains symlink: dist/codex/.codex/hooks.json' "$TMPDIR_EVAL/corrupt.out"
grep -Fq 'reinstall it and retry' "$TMPDIR_EVAL/corrupt.out"
grep -Fq 'npm run build:bundles' "$TMPDIR_EVAL/corrupt.out"
[[ ! -e "$CORRUPT_CODEX" && ! -e "$CORRUPT_SKILLS" ]]
if [[ -e "$CORRUPT_CODEX" ]] && grep -R -Fq 'must-not-install' "$CORRUPT_CODEX"; then
  echo "external hooks sentinel was installed" >&2
  exit 1
fi
if grep -Fq 'npm run build:bundles --silent' "$CORRUPT_ROOT/scripts/install-codex-home.sh"; then
  echo "installed Codex installer still compiles bundles" >&2
  exit 1
fi


# Runtime inventory corruption must fail before either destination is created.
for runtime_case in missing changed extra panel; do
  case "$runtime_case" in
    missing) mv "$PACKAGE_ROOT/dist/codex/build/src/vendor/flow/index.mjs" "$TMPDIR_EVAL/flow-index.mjs" ;;
    changed) cp "$PACKAGE_ROOT/dist/codex/build/src/vendor/flow/schemas/flow-run.schema.json" "$TMPDIR_EVAL/flow-schema.json"; printf '\n' >> "$PACKAGE_ROOT/dist/codex/build/src/vendor/flow/schemas/flow-run.schema.json" ;;
    panel) mv "$PACKAGE_ROOT/dist/codex/build/src/vendor/surface/trust-panel.js" "$TMPDIR_EVAL/trust-panel.js" ;;
    extra) printf 'unowned\n' > "$PACKAGE_ROOT/dist/codex/build/src/vendor/unowned.js" ;;
  esac
  RUNTIME_DEST="$TMPDIR_EVAL/runtime-corrupt-$runtime_case"
  if HOME="$HOME_DIR" CODEX_HOME="$RUNTIME_DEST" CODEX_REAL_HOME="$RUNTIME_DEST" \
    FLOW_AGENTS_SKILLS_DIR="$TMPDIR_EVAL/runtime-skills-$runtime_case" NPM_CONFIG_CACHE="$NPM_CACHE" \
    node "$PACKAGE_ROOT/build/src/cli.js" init --runtime codex --global --yes > "$TMPDIR_EVAL/runtime-$runtime_case.out" 2>&1; then
    echo "corrupt runtime unexpectedly installed: $runtime_case" >&2; exit 1
  fi
  grep -Fq 'standalone runtime import inventory is missing, changed, or corrupt' "$TMPDIR_EVAL/runtime-$runtime_case.out"
  [[ ! -e "$RUNTIME_DEST" && ! -e "$TMPDIR_EVAL/runtime-skills-$runtime_case" ]]
  case "$runtime_case" in
    missing) mv "$TMPDIR_EVAL/flow-index.mjs" "$PACKAGE_ROOT/dist/codex/build/src/vendor/flow/index.mjs" ;;
    changed) cp "$TMPDIR_EVAL/flow-schema.json" "$PACKAGE_ROOT/dist/codex/build/src/vendor/flow/schemas/flow-run.schema.json" ;;
    panel) mv "$TMPDIR_EVAL/trust-panel.js" "$PACKAGE_ROOT/dist/codex/build/src/vendor/surface/trust-panel.js" ;;
    extra) rm "$PACKAGE_ROOT/dist/codex/build/src/vendor/unowned.js" ;;
  esac
done

# The public installer must leave an executable runtime after all package and
# cache state is removed, from a project with no node_modules of its own.
cp -R "$ROOT_DIR/evals/fixtures/flow-kit-repository/valid-local-kit" "$TMPDIR_EVAL/local-kit"
node - "$TMPDIR_EVAL/local-kit" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const file = path.join(root, 'kit.json');
const kit = JSON.parse(fs.readFileSync(file, 'utf8'));
kit.execution = {module: 'entry.mjs', export: 'execute', contract: 'kontour.kit.execution_request@1.0'};
fs.writeFileSync(file, JSON.stringify(kit));
fs.writeFileSync(path.join(root, 'entry.mjs'), 'export async function execute(){return {status:"completed",standalone:true};}');
NODE
rm -rf "$CONSUMER" "$NPM_CACHE" "$SHIPPED_ROOT" "$PACK_DIR"
[[ ! -e "$PACKAGE_ROOT" && ! -e "$NPM_CACHE" ]]
export HOME="$HOME_DIR" CODEX_HOME="$CODEX_DIR" CODEX_REAL_HOME="$CODEX_DIR"
export FLOW_AGENTS_SKILLS_DIR="$SKILLS_DIR" NPM_CONFIG_CACHE="$NPM_CACHE" NPM_CONFIG_OFFLINE=true
unset NODE_PATH NODE_OPTIONS
# Refuse any module resolution outside this isolated install/project, even while
# the publisher's checkout still exists elsewhere on the machine.
cat > "$TMPDIR_EVAL/module-boundary.mjs" <<'NODE'
import {registerHooks} from 'node:module';
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const allowed = realpathSync(path.dirname(fileURLToPath(import.meta.url))) + path.sep;
registerHooks({resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith('file:') && !realpathSync(fileURLToPath(result.url)).startsWith(allowed)) {
    throw new Error(`Standalone module escaped isolated installation: ${result.url}`);
  }
  return result;
}});
NODE
export NODE_OPTIONS="--import=$TMPDIR_EVAL/module-boundary.mjs"
mkdir -p "$TMPDIR_EVAL/offline-project"
cd "$TMPDIR_EVAL/offline-project"
node "$CODEX_DIR/build/src/cli.js" --help >/dev/null
node "$CODEX_DIR/build/src/cli.js" workflow --help >/dev/null
node "$CODEX_DIR/build/src/cli.js" workflow start --flow builder.shape \
  --task-slug installed-offline-smoke --summary "Standalone installed runtime smoke" > "$TMPDIR_EVAL/start.out"
node "$CODEX_DIR/build/src/cli.js" workflow status \
  --session-dir .kontourai/flow-agents/installed-offline-smoke --json > "$TMPDIR_EVAL/status.json"
node - "$TMPDIR_EVAL/status.json" <<'NODE'
const fs = require('node:fs');
const status = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (status.current_step !== 'shape') throw new Error(`Unexpected installed workflow step: ${JSON.stringify(status)}`);
NODE
node "$CODEX_DIR/build/src/cli.js" kit validate "$TMPDIR_EVAL/local-kit"
node "$CODEX_DIR/build/src/cli.js" kit install "$TMPDIR_EVAL/local-kit" --dest "$TMPDIR_EVAL/offline-project"
node "$CODEX_DIR/build/src/cli.js" kit list --dest "$TMPDIR_EVAL/offline-project" > "$TMPDIR_EVAL/kits.out"
grep -Fq 'example-kit' "$TMPDIR_EVAL/kits.out"
printf '{"schema":"kontour.kit.execution_request","version":"1.0","kit_id":"example-kit"}\n' > "$TMPDIR_EVAL/request.json"
node "$CODEX_DIR/build/src/cli.js" kit run example-kit --dest "$TMPDIR_EVAL/offline-project" \
  --request "$TMPDIR_EVAL/request.json" --controller-root "$TMPDIR_EVAL/private" > "$TMPDIR_EVAL/result.json"
node - "$TMPDIR_EVAL/result.json" <<'NODE'
const fs = require('node:fs');
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (result.status !== 'completed' || result.standalone !== true) throw new Error('Installed kit did not execute');
NODE
# Exercise the synchronous Surface reader and browser asset seam called out in review.
cat > "$TMPDIR_EVAL/surface-probe.mjs" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
const [home, session] = process.argv.slice(2);
fs.mkdirSync(session, {recursive: true});
const raw = JSON.stringify({schemaVersion:'5',source:'standalone-smoke',claims:[{id:'standalone-claim',type:'tests_pass',statement:'Standalone command evidence'}],evidence:[],policies:[],events:[]});
fs.writeFileSync(path.join(session, 'trust.bundle'), raw);
const {readSurfaceExplanationCandidate} = await import(pathToFileURL(path.join(home, 'build/src/narrative/readers.js')));
const result = readSurfaceExplanationCandidate({sessionDir:session,bundleSha8:crypto.createHash('sha256').update(raw).digest('hex').slice(0,8),claimId:'standalone-claim'});
const metadata = JSON.parse(fs.readFileSync(path.join(home, 'build/package.json'), 'utf8'));
if (result.originPackage?.version !== metadata.dependencies['@kontourai/surface'] || result.record.found !== true) throw new Error(`Standalone Surface explanation unavailable: ${JSON.stringify(result)}`);
NODE
node "$TMPDIR_EVAL/surface-probe.mjs" "$CODEX_DIR" "$TMPDIR_EVAL/surface-session"
cat > "$TMPDIR_EVAL/provider-probe.mjs" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const vendor = path.join(process.argv[2], 'build/src/vendor');
const survey = await import(pathToFileURL(path.join(vendor, 'survey/index.mjs')));
const metadata = JSON.parse(fs.readFileSync(path.join(vendor, 'survey/resolved-survey-surface/package.json'), 'utf8'));
const record = {metadata:{name:'standalone'},spec:{envelope:{result:{proposals:[{}]}}}};
const [major, minor] = metadata.version.split(".").map(Number);
if (major > 4 || major === 4 && minor >= 1) assert.equal(survey.toSurfaceReviewedExtractionImport(record), record);
else assert.throws(() => survey.toSurfaceReviewedExtractionImport(record), error => error.message.includes(`@kontourai/surface ${metadata.version} requires`));
const {createAnthropicRuntime} = await import(pathToFileURL(path.join(vendor, 'relay-anthropic/index.mjs')));
const {createModelRuntimeProfile} = await import(pathToFileURL(path.join(vendor, 'relay-runtime-profile/index.mjs')));
let requests = 0;
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  assert.equal(JSON.parse(raw).model, 'standalone-mock'); requests++;
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({id:'mock',type:'message',role:'assistant',model:'standalone-mock',content:[{type:'text',text:'standalone-sdk'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const options = {model:'standalone-mock',apiKey:'isolated-fixture',baseUrl:`http://127.0.0.1:${server.address().port}`};
  for (const runtime of [createAnthropicRuntime(options), createModelRuntimeProfile({...options,profile:'anthropic'})]) {
    const before = requests;
    const result = await runtime.invoke({messages:[{role:'user',content:'fixture'}],maxOutputTokens:8});
    assert.equal(result.outputText, 'standalone-sdk'); assert.equal(requests,before+1);
  }
} finally { await new Promise(resolve => server.close(resolve)); }
NODE
node "$TMPDIR_EVAL/provider-probe.mjs" "$CODEX_DIR"

node "$CODEX_DIR/build/src/cli/workflow-sidecar.js" render-trust-panel "$TMPDIR_EVAL/surface-session" > "$TMPDIR_EVAL/panel.out"
grep -Fq 'surface-trust-panel' "$TMPDIR_EVAL/surface-session/trust-panel.html"
node - "$CODEX_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(root, '.flow-agents/codex-install-manifest.json'), 'utf8'));
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'build/runtime-imports.json'), 'utf8'));
for (const file of inventory.files) {
  if (!manifest.files.some(owned => owned.path === file.path && owned.sha256 === file.sha256)) {
    throw new Error(`Standalone runtime file is not manifest owned: ${file.path}`);
  }
}
NODE
printf '1..1\nok 1 - packed Codex runtime and uninstall survive package and cache removal\n'
