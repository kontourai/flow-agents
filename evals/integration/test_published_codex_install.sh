#!/usr/bin/env bash
# Proves the packed npm artifact is a self-contained, production-only Codex installer.
set -euo pipefail

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
TARBALL_LIST="$TMPDIR_EVAL/tarball.list"
tar -tzf "$TARBALL" > "$TARBALL_LIST"
grep -Fxq 'package/dist/codex/.codex/hooks.json' "$TARBALL_LIST"
grep -Fxq 'package/dist/codex/build/src/cli.js' "$TARBALL_LIST"
grep -Fxq 'package/dist/codex/build/runtime-node-modules/@kontourai/flow/package.json' "$TARBALL_LIST"

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
if find "$PACKAGE_ROOT" -type l -print -quit | grep -q .; then
  echo "packed package contains a symlink/workspace link" >&2
  exit 1
fi
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

# Closure provenance and exact coverage are fail-closed before installation.
for closure_case in wrong-version missing-file extra-file; do
  CLOSURE_CORRUPT_ROOT="$CONSUMER/node_modules/@kontourai/flow-agents-closure-corrupt-$closure_case"
  CLOSURE_CORRUPT_CODEX="$TMPDIR_EVAL/closure-corrupt-codex-$closure_case"
  CLOSURE_CORRUPT_SKILLS="$TMPDIR_EVAL/closure-corrupt-skills-$closure_case"
  cp -R "$PACKAGE_ROOT" "$CLOSURE_CORRUPT_ROOT"
  case "$closure_case" in
    wrong-version)
      node - "$CLOSURE_CORRUPT_ROOT/dist/codex/build/runtime-dependencies.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const closure = JSON.parse(fs.readFileSync(file, "utf8"));
closure.packages[0].version = "0.0.0-corrupt";
fs.writeFileSync(file, `${JSON.stringify(closure, null, 2)}\n`);
NODE
      ;;
    missing-file)
      rm "$CLOSURE_CORRUPT_ROOT/dist/codex/build/runtime-node-modules/@kontourai/flow/package.json"
      ;;
    extra-file)
      printf 'unowned\n' > "$CLOSURE_CORRUPT_ROOT/dist/codex/build/runtime-node-modules/unowned.txt"
      ;;
  esac
  if HOME="$HOME_DIR" CODEX_HOME="$CLOSURE_CORRUPT_CODEX" CODEX_REAL_HOME="$CLOSURE_CORRUPT_CODEX" \
    FLOW_AGENTS_SKILLS_DIR="$CLOSURE_CORRUPT_SKILLS" NPM_CONFIG_CACHE="$NPM_CACHE" \
    node "$CLOSURE_CORRUPT_ROOT/build/src/cli.js" init --runtime codex --global --activate-kits --yes \
    >"$TMPDIR_EVAL/closure-corrupt-$closure_case.out" 2>&1; then
    echo "corrupt runtime closure unexpectedly installed: $closure_case" >&2
    exit 1
  fi
  if ! grep -Eq 'runtime dependency|required prebuilt Codex bundle is missing or invalid' "$TMPDIR_EVAL/closure-corrupt-$closure_case.out"; then
    echo "corrupt runtime closure failed without an actionable diagnostic: $closure_case" >&2
    cat "$TMPDIR_EVAL/closure-corrupt-$closure_case.out" >&2
    exit 1
  fi
  [[ ! -e "$CLOSURE_CORRUPT_CODEX" && ! -e "$CLOSURE_CORRUPT_SKILLS" ]]
done

# The installed runtime must remain executable after its package source and npm
# cache are gone. This is the supported seam used by installed hooks, not merely
# a check that the npm-managed package binary can run before global installation.
rm -rf "$CONSUMER" "$NPM_CACHE"
[[ ! -e "$PACKAGE_ROOT" && ! -e "$NPM_CACHE" ]]
NPM_CONFIG_OFFLINE=true node "$CODEX_DIR/build/src/cli.js" --help >/dev/null
NPM_CONFIG_OFFLINE=true node "$CODEX_DIR/build/src/cli.js" workflow --help >/dev/null
OFFLINE_PROJECT="$TMPDIR_EVAL/offline-workflow-project"
mkdir -p "$OFFLINE_PROJECT"
(
  cd "$OFFLINE_PROJECT"
  NPM_CONFIG_OFFLINE=true node "$CODEX_DIR/build/src/cli.js" workflow start \
    --flow builder.shape \
    --task-slug installed-runtime-offline-smoke \
    --summary "Exercise a substantive workflow operation from the installed offline runtime." >/dev/null
  NPM_CONFIG_OFFLINE=true node "$CODEX_DIR/build/src/cli.js" workflow status \
    --session-dir .kontourai/flow-agents/installed-runtime-offline-smoke --json \
    | grep -Fq '"current_step":"shape"'
)

node - "$CODEX_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const codexHome = process.argv[2];
const dependency = "build/node_modules/@kontourai/flow/package.json";
const manifest = JSON.parse(fs.readFileSync(path.join(codexHome, ".flow-agents/codex-install-manifest.json"), "utf8"));
if (!manifest.files.some((item) => item.path === dependency)) {
  throw new Error(`${dependency} is not owned by the Codex install manifest`);
}
if (!fs.existsSync(path.join(codexHome, dependency))) {
  throw new Error(`${dependency} is missing from the installed runtime`);
}
NODE

printf '1..1\nok 1 - published Codex install integration\n'
